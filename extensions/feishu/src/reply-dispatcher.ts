import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { normalizeFeishuDisplayText } from "./display-text.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { recordFeishuReplyFlowEvent, type FeishuReplyFlowRecord } from "./reply-flow-audit.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

export { normalizeFeishuDisplayText } from "./display-text.js";

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;

function normalizeReplyTargetId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  replyFlowCorrelationId?: string;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId: rawReplyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    threadReply,
    rootId: rawRootId,
    mentionTargets,
    accountId,
  } = params;
  const replyToMessageId = normalizeReplyTargetId(rawReplyToMessageId);
  const rootId = normalizeReplyTargetId(rawRootId);
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // Check if typing indicator is enabled (default: true)
      if (!(account.config.typingIndicator ?? true)) {
        return;
      }
      if (!replyToMessageId) {
        return;
      }
      // Skip typing indicator for old messages — likely replays after context
      // compaction that would flood users with stale notifications (#30418).
      const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
      if (
        messageCreateTimeMs !== undefined &&
        Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
      ) {
        return;
      }
      // Feishu reactions persist until explicitly removed, so skip keepalive
      // re-adds when a reaction already exists. Re-adding the same emoji
      // triggers a new push notification for every call (#28660).
      if (typingState?.reactionId) {
        return;
      }
      typingState = await addTypingIndicator({
        cfg,
        messageId: replyToMessageId,
        accountId,
        runtime: params.runtime,
      });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId, runtime: params.runtime });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  // Card streaming may miss thread affinity in topic contexts; use direct replies there.
  const streamingEnabled =
    !threadReplyMode && account.config?.streaming !== false && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let streamingAuditAttemptRecorded = false;
  let streamingAuditResultRecorded = false;

  const recordReplyFlow = (record: Omit<FeishuReplyFlowRecord, "correlationId">) => {
    const correlationId = params.replyFlowCorrelationId?.trim();
    if (!correlationId) {
      return;
    }
    void recordFeishuReplyFlowEvent({
      ...record,
      correlationId,
      accountId: account.accountId,
      chatId,
      agentId,
      messageId: replyToMessageId,
    });
  };

  const recordOutboundAttempt = (params: {
    replyKind: string;
    sendMode: string;
    textPreview?: string;
    outboundMessageType?: string;
  }) => {
    recordReplyFlow({
      stage: "outbound_attempt",
      replyKind: params.replyKind,
      sendMode: params.sendMode,
      textPreview: params.textPreview,
      outboundMessageType: params.outboundMessageType,
      receiveIdType: resolveReceiveIdType(chatId),
      usedReplyTarget: Boolean(sendReplyToMessageId),
      usedFallbackCreate: false,
    });
  };

  const recordOutboundSuccess = (params: {
    replyKind: string;
    sendMode: string;
    textPreview?: string;
    deliveryMessageId?: string;
    outboundMessageType?: string;
  }) => {
    recordReplyFlow({
      stage: "outbound_result",
      replyKind: params.replyKind,
      sendMode: params.sendMode,
      textPreview: params.textPreview,
      deliveryStatus: "success",
      feishuCode: 0,
      feishuMsg: "success",
      outboundMessageType: params.outboundMessageType,
      receiveIdType: resolveReceiveIdType(chatId),
      usedReplyTarget: Boolean(sendReplyToMessageId),
      usedFallbackCreate: false,
      deliveryMessageId: params.deliveryMessageId,
    });
  };

  const recordOutboundFailure = (params: {
    replyKind: string;
    sendMode: string;
    textPreview?: string;
    error: unknown;
    outboundMessageType?: string;
  }) => {
    recordReplyFlow({
      stage: "outbound_result",
      replyKind: params.replyKind,
      sendMode: params.sendMode,
      textPreview: params.textPreview,
      deliveryStatus: "failed",
      outboundMessageType: params.outboundMessageType,
      receiveIdType: resolveReceiveIdType(chatId),
      usedReplyTarget: Boolean(sendReplyToMessageId),
      usedFallbackCreate: false,
      error: String(params.error),
    });
  };

  const mergeStreamingText = (nextText: string) => {
    if (!streamText) {
      streamText = nextText;
      return;
    }
    if (nextText.startsWith(streamText)) {
      // Handle cumulative partial payloads where nextText already includes prior text.
      streamText = nextText;
      return;
    }
    if (streamText.endsWith(nextText)) {
      return;
    }
    streamText += nextText;
  };

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
    },
  ) => {
    if (!nextText) {
      return;
    }
    if (options?.dedupeWithLastPartial && nextText === lastPartial) {
      return;
    }
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    mergeStreamingText(nextText);
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(streamText);
      }
    });
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        if (!streamingAuditAttemptRecorded) {
          streamingAuditAttemptRecorded = true;
          recordOutboundAttempt({
            replyKind: "final",
            sendMode: "streaming_card",
            textPreview: streamText,
            outboundMessageType: "interactive",
          });
        }
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
        });
      } catch (error) {
        recordOutboundFailure({
          replyKind: "final",
          sendMode: "streaming_card",
          textPreview: streamText,
          outboundMessageType: "interactive",
          error,
        });
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = streamText;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      const deliveryMessageId = (
        streaming as FeishuStreamingSession & {
          getDeliveryMessageId?: () => string | undefined;
        }
      ).getDeliveryMessageId?.();
      try {
        await streaming.close(text);
        if (!streamingAuditResultRecorded) {
          streamingAuditResultRecorded = true;
          recordOutboundSuccess({
            replyKind: "final",
            sendMode: "streaming_card",
            textPreview: text,
            deliveryMessageId,
            outboundMessageType: "interactive",
          });
        }
      } catch (error) {
        recordOutboundFailure({
          replyKind: "final",
          sendMode: "streaming_card",
          textPreview: text,
          outboundMessageType: "interactive",
          error,
        });
        throw error;
      }
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        if (info?.kind === "tool") {
          return;
        }

        const rawText = payload.text ?? "";
        const text = normalizeFeishuDisplayText(rawText);
        const mediaList =
          payload.mediaUrls && payload.mediaUrls.length > 0
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
        const hasText = Boolean(text.trim());
        const hasMedia = mediaList.length > 0;

        if (!hasText && !hasMedia) {
          return;
        }

        if (hasText) {
          const useCard =
            renderMode === "card" || (renderMode === "auto" && shouldUseCard(rawText));

          if (info?.kind === "block") {
            // Drop internal block chunks unless we can safely consume them as
            // streaming-card fallback content.
            if (!(streamingEnabled && useCard)) {
              return;
            }
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (info?.kind === "final" && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              queueStreamingUpdate(text);
            }
            if (info?.kind === "final") {
              streamText = text;
              await closeStreaming();
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              for (const mediaUrl of mediaList) {
                await sendMediaFeishu({
                  cfg,
                  to: chatId,
                  mediaUrl,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  accountId,
                });
              }
            }
            return;
          }

          let first = true;
          if (useCard) {
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode,
            )) {
              recordOutboundAttempt({
                replyKind: info?.kind ?? "final",
                sendMode: "message",
                textPreview: chunk,
                outboundMessageType: "post",
              });
              let result: Awaited<ReturnType<typeof sendMarkdownCardFeishu>>;
              try {
                result = await sendMarkdownCardFeishu({
                  cfg,
                  to: chatId,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  mentions: first ? mentionTargets : undefined,
                  accountId,
                });
              } catch (error) {
                recordOutboundFailure({
                  replyKind: info?.kind ?? "final",
                  sendMode: "message",
                  textPreview: chunk,
                  outboundMessageType: "post",
                  error,
                });
                throw error;
              }
              recordOutboundSuccess({
                replyKind: info?.kind ?? "final",
                sendMode: "message",
                textPreview: chunk,
                deliveryMessageId: result?.messageId,
                outboundMessageType: "post",
              });
              first = false;
            }
          } else {
            const converted = core.channel.text.convertMarkdownTables(text, tableMode);
            for (const chunk of core.channel.text.chunkTextWithMode(
              converted,
              textChunkLimit,
              chunkMode,
            )) {
              recordOutboundAttempt({
                replyKind: info?.kind ?? "final",
                sendMode: "message",
                textPreview: chunk,
                outboundMessageType: "post",
              });
              let result: Awaited<ReturnType<typeof sendMessageFeishu>>;
              try {
                result = await sendMessageFeishu({
                  cfg,
                  to: chatId,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  mentions: first ? mentionTargets : undefined,
                  accountId,
                });
              } catch (error) {
                recordOutboundFailure({
                  replyKind: info?.kind ?? "final",
                  sendMode: "message",
                  textPreview: chunk,
                  outboundMessageType: "post",
                  error,
                });
                throw error;
              }
              recordOutboundSuccess({
                replyKind: info?.kind ?? "final",
                sendMode: "message",
                textPreview: chunk,
                deliveryMessageId: result?.messageId,
                outboundMessageType: "post",
              });
              first = false;
            }
          }
        }

        if (hasMedia) {
          for (const mediaUrl of mediaList) {
            await sendMediaFeishu({
              cfg,
              to: chatId,
              mediaUrl,
              replyToMessageId: sendReplyToMessageId,
              replyInThread: effectiveReplyInThread,
              accountId,
            });
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            queueStreamingUpdate(payload.text, { dedupeWithLastPartial: true });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
