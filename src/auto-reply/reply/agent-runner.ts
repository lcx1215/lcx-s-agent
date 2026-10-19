import { createHash } from "node:crypto";
import fs from "node:fs";
import { createCommercialAnswerReplyGate } from "../../agents/commercial-answer-reply-gate.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { createFinanceReplyEvidenceTracker } from "../../agents/finance-reply-evidence.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { verifyProviderCouncilEvidence } from "../../agents/provider-council-evidence.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import { applyVisibleAnswerAdoptionGate } from "../../agents/visible-answer-adoption-gate.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { emitAgentEvent, onAgentEvent } from "../../infra/agent-events.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  resolveFallbackTransition,
} from "../fallback-state.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { resolveResponseUsageMode, type VerboseLevel } from "../thinking.js";
import type { BlockReplyContext, GetReplyOptions, ReplyPayload } from "../types.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  finalizeWithFollowup,
  isAudioPayload,
  signalTypingIfNeeded,
} from "./agent-runner-helpers.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-utils.js";
import {
  createAudioAsVoiceBuffer,
  createBlockReplyPipeline,
  createBlockReplyPayloadKey,
} from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import { createFollowupRunner } from "./followup-runner.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { enqueueFollowupRun, type FollowupRun, type QueueSettings } from "./queue.js";
import { applyReplyThreading } from "./reply-payloads.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;

export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
}): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  } = params;
  const financeEvidence = createFinanceReplyEvidenceTracker({
    workspaceDir: followupRun.run.workspaceDir,
    sessionKey: sessionKey ?? followupRun.run.sessionKey,
    signal: opts?.abortSignal,
  });
  let financeStreamSuppressed = false;
  const guardFinanceReply = async (
    payload: ReplyPayload,
    surface: "partial" | "block" | "final",
    callbackSignal?: AbortSignal,
  ): Promise<ReplyPayload> => {
    const failedCurrentAudit = !opts?.commercialAnswerAudit && commercialGate.hasFailed();
    if (!payload.text && !failedCurrentAudit) {
      return payload;
    }
    const candidateText = payload.text ?? "";
    if (callbackSignal?.aborted || councilRunStopped) {
      financeEvidence.stop();
    }
    // References can arrive after a claim. Hold this tool's answer until its original
    // final candidate is available; partial callbacks remain snapshots, never concatenate them.
    if (surface !== "final" && financeEvidence.hasReceipt()) {
      financeStreamSuppressed = true;
      return { ...payload, text: "", mediaUrl: undefined, mediaUrls: undefined };
    }
    const checkedRunId = commercialCallerRunId;
    const decision = await financeEvidence.check(candidateText, commandBody);
    if (commercialCallerRunId !== checkedRunId) {
      // A fallback started while the old candidate awaited source readback.
      // Discard that candidate without poisoning or selecting evidence for the new run.
      return { ...payload, text: "", mediaUrl: undefined, mediaUrls: undefined, isError: true };
    }
    if (councilGateRunId && financeEvidence.hasReceipt()) {
      emitAgentEvent({
        runId: councilGateRunId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "finance_reply_evidence_gate",
          surface,
          ...decision,
          text: undefined,
          auditInput: undefined,
          candidateSha256: createHash("sha256").update(candidateText).digest("hex"),
          streamingHeldForFinal: financeStreamSuppressed,
        },
      });
    }
    const checkedPayload = { ...payload, text: decision.text };
    if (opts?.commercialAnswerAudit || !commercialCallerRunId) {
      return checkedPayload;
    }
    const messageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
    commercialGate.selectFinanceEvidence(decision, commercialCallerRunId);
    if (!commercialGate.hasRequest()) {
      return checkedPayload;
    }
    // Grounding already consumed the original figures. Audit the actual cleaned reply body.
    const audited = commercialGate.check(
      checkedPayload,
      surface,
      councilRunStopped || callbackSignal?.aborted === true,
      {
        runId: commercialCallerRunId,
        messageId,
        sessionKey,
        replyChannelAccountId: sessionCtx.AccountId,
      },
    );
    if (audited.trace) {
      emitAgentEvent({
        runId: commercialCallerRunId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "commercial_answer_terminal_gate",
          surface,
          selection: commercialGate.financeSelection()
            ? "verified_finance_reference"
            : "failed_finance_reference",
          financeReceiptSha256: commercialGate.financeSelection()?.receiptSha256,
          financeSnapshotPointer: commercialGate.financeSelection()?.snapshotPointer,
          auditInputGaps: commercialGate.financeSelection()?.auditInputGaps,
          ...audited.trace,
        },
      });
    }
    return audited.payload;
  };
  let councilGateRunId = opts?.runId;
  let commercialCallerRunId: string | undefined;
  let councilRunStopped = false;
  const councilStreamText = { partial: "", block: "" };
  let presentationBlockPending = "";
  let presentationBlockFailed = false;
  const guardCouncilReply = (
    payload: ReplyPayload,
    surface: "partial" | "block" | "final",
    callbackSignal?: AbortSignal,
  ): ReplyPayload => {
    if (opts?.abortSignal?.aborted || callbackSignal?.aborted || councilRunStopped) {
      if (councilGateRunId) {
        emitAgentEvent({
          runId: councilGateRunId,
          sessionKey,
          stream: "lifecycle",
          data: {
            phase: "reply_run_stopped_gate",
            surface,
            status: "blocked",
            reason:
              opts?.abortSignal?.aborted || callbackSignal?.aborted
                ? "reply_run_cancelled"
                : "reply_model_stopped",
            candidateSha256: createHash("sha256")
              .update(payload.text ?? "")
              .digest("hex"),
          },
        });
      }
      // A stopped ordinary reply is not exempt just because it makes no council claim.
      if (
        surface !== "final" ||
        !payload.text ||
        !verifyProviderCouncilEvidence(commandBody, payload.text).required
      ) {
        return {
          ...payload,
          text:
            surface === "final"
              ? /\p{Script=Han}/u.test(commandBody)
                ? "回复未完成：本次运行已取消或超时。"
                : "The response did not finish: this run was cancelled or timed out."
              : "",
          mediaUrl: undefined,
          mediaUrls: undefined,
          isError: surface === "final" ? true : payload.isError,
        };
      }
      // Keep the existing council-specific refusal and its evidence reason below.
      payload = { ...payload, mediaUrl: undefined, mediaUrls: undefined, isError: true };
    }
    if (!payload.text) {
      return payload;
    }
    let text = payload.text;
    if (surface !== "final") {
      const previous = councilStreamText[surface];
      text = text.startsWith(previous) ? text : previous + text;
      // Retain sentence context across delivery chunks without accumulating an unbounded stream.
      councilStreamText[surface] = text.slice(-12 * 1024);
    }
    const inboundId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
    const source = opts?.providerCouncilEvidence;
    const evidence =
      opts?.abortSignal?.aborted || callbackSignal?.aborted || councilRunStopped
        ? {
            messageId: inboundId ?? followupRun.messageId ?? "",
            unavailableReason: "provider_council_run_cancelled",
          }
        : source
          ? { ...source, messageId: inboundId ?? followupRun.messageId ?? "" }
          : undefined;
    const proof = verifyProviderCouncilEvidence(commandBody, text, evidence);
    const present = () => {
      const decision = applyVisibleAnswerAdoptionGate({
        userMessage: commandBody,
        answerText: surface === "block" ? presentationBlockPending + payload.text : text,
        presentationOnly: true,
        streaming: surface !== "final",
      });
      if (surface === "block") {
        presentationBlockPending = decision.pendingText ?? "";
        if (presentationBlockFailed) {
          return { ...payload, text: "" };
        }
        presentationBlockFailed = decision.status === "replaced";
      }
      return { ...payload, text: decision.text };
    };
    if (!proof.required) {
      return present();
    }
    if (councilGateRunId) {
      emitAgentEvent({
        runId: councilGateRunId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "provider_council_completion_gate",
          surface,
          status: proof.status === "verified" ? "ok" : "blocked",
          candidateSha256: createHash("sha256").update(text).digest("hex"),
          providerCouncil: proof,
        },
      });
    }
    if (proof.status === "verified") {
      return present();
    }
    const decision = applyVisibleAnswerAdoptionGate({
      userMessage: commandBody,
      answerText: text,
      providerEvidence: evidence,
    });
    return { ...payload, text: decision.text };
  };
  const trackedToolStarts = new Set<string>();
  const commercialGate = createCommercialAnswerReplyGate({
    request: opts?.commercialAnswerAudit,
    messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    ask: sessionCtx.CommandBody ?? sessionCtx.RawBody ?? commandBody,
    signal: opts?.abortSignal,
    historicalSystemPrompt: followupRun.run.extraSystemPrompt,
  });
  const guardReply = async (
    payload: ReplyPayload,
    surface: "partial" | "block" | "final",
    signal?: AbortSignal,
  ) => {
    const commercial = opts?.commercialAnswerAudit
      ? commercialGate.check(payload, surface, councilRunStopped || signal?.aborted === true, {
          runId: commercialCallerRunId,
          messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
          sessionKey,
          replyChannelAccountId: sessionCtx.AccountId,
        })
      : { payload, trace: undefined };
    if (commercial.trace && councilGateRunId) {
      emitAgentEvent({
        runId: councilGateRunId,
        sessionKey,
        stream: "lifecycle",
        data: { phase: "commercial_answer_terminal_gate", surface, ...commercial.trace },
      });
    }
    if (opts?.commercialAnswerAudit && surface !== "final") {
      return commercial.payload;
    }
    return guardCouncilReply(
      await guardFinanceReply(commercial.payload, surface, signal),
      surface,
      signal,
    );
  };
  const sealFinalReplies = (payloads: ReplyPayload[]) => {
    if (!commercialGate.hasRequest() || !opts?.abortSignal?.aborted) {
      return payloads;
    }
    // Awaited typing and bookkeeping can cancel a previously audited candidate.
    const cancelled = commercialGate.check(payloads[0] ?? { text: "" }, "final", true);
    if (cancelled.trace && councilGateRunId) {
      emitAgentEvent({
        runId: councilGateRunId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "commercial_answer_terminal_gate",
          surface: "final_seal",
          ...(!opts?.commercialAnswerAudit
            ? {
                selection: commercialGate.financeSelection()
                  ? "verified_finance_reference"
                  : "failed_finance_reference",
              }
            : {}),
          ...cancelled.trace,
        },
      });
    }
    return [cancelled.payload];
  };
  const actuallyDeliveredBlockKeys = new Set<string>();
  const trackedOpts = {
    ...opts,
    onAgentRunStart: (runId: string) => {
      commercialGate.startFinanceRun(runId);
      councilGateRunId = runId;
      commercialCallerRunId = runId;
      financeEvidence.start(runId);
      opts?.onAgentRunStart?.(runId);
    },
    onAssistantMessageStart: async () => {
      councilStreamText.partial = "";
      councilStreamText.block = "";
      presentationBlockPending = "";
      presentationBlockFailed = false;
      await opts?.onAssistantMessageStart?.();
    },
    onPartialReply: opts?.onPartialReply
      ? async (payload: ReplyPayload) => opts.onPartialReply?.(await guardReply(payload, "partial"))
      : undefined,
    onBlockReply: opts?.onBlockReply
      ? async (payload: ReplyPayload, context?: BlockReplyContext) => {
          const guarded = await guardReply(payload, "block", context?.abortSignal);
          await opts.onBlockReply?.(guarded, context);
          if (guarded.text || guarded.mediaUrl || guarded.mediaUrls?.length) {
            actuallyDeliveredBlockKeys.add(createBlockReplyPayloadKey(guarded));
          }
        }
      : undefined,
    onToolStart: async (payload: { name?: string; phase?: string }) => {
      const normalizedName = payload.name?.trim().toLowerCase();
      if (payload.phase === "start" && normalizedName) {
        trackedToolStarts.add(normalizedName);
      }
      await opts?.onToolStart?.(payload);
    },
  };

  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;

  const isHeartbeat = opts?.isHeartbeat === true;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });

  const shouldEmitToolResult = createShouldEmitToolResult({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });
  const shouldEmitToolOutput = createShouldEmitToolOutput({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;

  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Surface ?? sessionCtx.Provider,
  }) as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
    sessionCtx.ChatType,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const blockReplyCoalescing =
    blockStreamingEnabled && opts?.onBlockReply
      ? resolveEffectiveBlockStreamingConfig({
          cfg,
          provider: sessionCtx.Provider,
          accountId: sessionCtx.AccountId,
          chunking: blockReplyChunking,
        }).coalescing
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && opts?.onBlockReply
      ? createBlockReplyPipeline({
          onBlockReply: trackedOpts.onBlockReply!,
          timeoutMs: blockReplyTimeoutMs,
          coalescing: blockReplyCoalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;
  const touchActiveSessionEntry = async () => {
    if (!activeSessionEntry || !activeSessionStore || !sessionKey) {
      return;
    }
    const updatedAt = Date.now();
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async () => ({ updatedAt }),
      });
    }
  };

  if (shouldSteer && isStreaming) {
    const steered = queueEmbeddedPiMessage(followupRun.run.sessionId, followupRun.prompt);
    if (steered && !shouldFollowup) {
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
  }

  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat,
    shouldFollowup,
    queueMode: resolvedQueue.mode,
  });

  if (activeRunQueueAction === "drop") {
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    await touchActiveSessionEntry();
    typing.cleanup();
    return undefined;
  }

  await typingSignals.signalRunStart();

  activeSessionEntry = await runMemoryFlushIfNeeded({
    cfg,
    followupRun,
    promptForEstimate: followupRun.prompt,
    sessionCtx,
    opts,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    isHeartbeat,
  });

  const runFollowupTurn = createFollowupRunner({
    opts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  });

  let responseUsageLine: string | undefined;
  type SessionResetOptions = {
    failureLabel: string;
    buildLogMessage: (nextSessionId: string) => string;
    cleanupTranscripts?: boolean;
  };
  const resetSession = async ({
    failureLabel,
    buildLogMessage,
    cleanupTranscripts,
  }: SessionResetOptions): Promise<boolean> => {
    if (!sessionKey || !activeSessionStore || !storePath) {
      return false;
    }
    const prevEntry = activeSessionStore[sessionKey] ?? activeSessionEntry;
    if (!prevEntry) {
      return false;
    }
    const prevSessionId = cleanupTranscripts ? prevEntry.sessionId : undefined;
    const nextSessionId = generateSecureUuid();
    const nextEntry: SessionEntry = {
      ...prevEntry,
      sessionId: nextSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
      fallbackNoticeSelectedModel: undefined,
      fallbackNoticeActiveModel: undefined,
      fallbackNoticeReason: undefined,
    };
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const nextSessionFile = resolveSessionTranscriptPath(
      nextSessionId,
      agentId,
      sessionCtx.MessageThreadId,
    );
    nextEntry.sessionFile = nextSessionFile;
    activeSessionStore[sessionKey] = nextEntry;
    try {
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = nextEntry;
      });
    } catch (err) {
      defaultRuntime.error(
        `Failed to persist session reset after ${failureLabel} (${sessionKey}): ${String(err)}`,
      );
    }
    followupRun.run.sessionId = nextSessionId;
    followupRun.run.sessionFile = nextSessionFile;
    activeSessionEntry = nextEntry;
    activeIsNewSession = true;
    defaultRuntime.error(buildLogMessage(nextSessionId));
    if (cleanupTranscripts && prevSessionId) {
      const transcriptCandidates = new Set<string>();
      const resolved = resolveSessionFilePath(
        prevSessionId,
        prevEntry,
        resolveSessionFilePathOptions({ agentId, storePath }),
      );
      if (resolved) {
        transcriptCandidates.add(resolved);
      }
      transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
      for (const candidate of transcriptCandidates) {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    return true;
  };
  const resetSessionAfterCompactionFailure = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "compaction failure",
      buildLogMessage: (nextSessionId) =>
        `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`,
    });
  const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "role ordering conflict",
      buildLogMessage: (nextSessionId) =>
        `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    });
  const unsubscribeFinanceEvidence = onAgentEvent((event) => financeEvidence.observe(event));
  try {
    const runStartedAt = Date.now();
    const runOutcome = await runAgentTurnWithFallback({
      commandBody,
      followupRun,
      sessionCtx,
      opts: trackedOpts,
      typingSignals,
      blockReplyPipeline,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      applyReplyToMode,
      shouldEmitToolResult,
      shouldEmitToolOutput,
      pendingToolTasks,
      resetSessionAfterCompactionFailure,
      resetSessionAfterRoleOrderingConflict,
      isHeartbeat,
      sessionKey,
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore,
      storePath,
      resolvedVerboseLevel,
    });

    if (runOutcome.kind === "final") {
      const [payload] = applyReplyThreading({
        payloads: sealFinalReplies([
          opts?.commercialAnswerAudit
            ? await guardReply(runOutcome.payload, "final")
            : runOutcome.payload,
        ]),
        replyToMode,
        replyToChannel,
        currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      });
      return finalizeWithFollowup(payload, queueKey, runFollowupTurn);
    }

    const {
      runId,
      runResult,
      fallbackProvider,
      fallbackModel,
      fallbackAttempts,
      directlySentBlockKeys,
    } = runOutcome;
    let { didLogHeartbeatStrip, autoCompactionCompleted } = runOutcome;

    if (
      shouldInjectGroupIntro &&
      activeSessionEntry &&
      activeSessionStore &&
      sessionKey &&
      activeSessionEntry.groupActivationNeedsSystemIntro
    ) {
      const updatedAt = Date.now();
      activeSessionEntry.groupActivationNeedsSystemIntro = false;
      activeSessionEntry.updatedAt = updatedAt;
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            groupActivationNeedsSystemIntro: false,
            updatedAt,
          }),
        });
      }
    }

    const completedBeforeCompactionTimeout =
      runResult.meta?.timedOut === true &&
      runResult.meta.timedOutDuringCompaction === true &&
      runResult.meta.promptCompleted === true;
    councilRunStopped = Boolean(
      (runResult.meta?.aborted || runResult.meta?.timedOut) && !completedBeforeCompactionTimeout,
    );
    const payloadArray = runResult.payloads ?? [];

    if (blockReplyPipeline) {
      await blockReplyPipeline.flush({ force: true });
      blockReplyPipeline.stop();
    }
    if (pendingToolTasks.size > 0) {
      await Promise.allSettled(pendingToolTasks);
    }

    const usage = runResult.meta?.agentMeta?.usage;
    const promptTokens = runResult.meta?.agentMeta?.promptTokens;
    const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
    const providerUsed =
      runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;
    const verboseEnabled = resolvedVerboseLevel !== "off";
    const selectedProvider = followupRun.run.provider;
    const selectedModel = followupRun.run.model;
    const fallbackStateEntry =
      activeSessionEntry ?? (sessionKey ? activeSessionStore?.[sessionKey] : undefined);
    const fallbackTransition = resolveFallbackTransition({
      selectedProvider,
      selectedModel,
      activeProvider: providerUsed,
      activeModel: modelUsed,
      attempts: fallbackAttempts,
      state: fallbackStateEntry,
    });
    if (fallbackTransition.stateChanged) {
      if (fallbackStateEntry) {
        fallbackStateEntry.fallbackNoticeSelectedModel = fallbackTransition.nextState.selectedModel;
        fallbackStateEntry.fallbackNoticeActiveModel = fallbackTransition.nextState.activeModel;
        fallbackStateEntry.fallbackNoticeReason = fallbackTransition.nextState.reason;
        fallbackStateEntry.updatedAt = Date.now();
        activeSessionEntry = fallbackStateEntry;
      }
      if (sessionKey && fallbackStateEntry && activeSessionStore) {
        activeSessionStore[sessionKey] = fallbackStateEntry;
      }
      if (sessionKey && storePath) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            fallbackNoticeSelectedModel: fallbackTransition.nextState.selectedModel,
            fallbackNoticeActiveModel: fallbackTransition.nextState.activeModel,
            fallbackNoticeReason: fallbackTransition.nextState.reason,
          }),
        });
      }
    }
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? runResult.meta?.agentMeta?.sessionId?.trim()
      : undefined;
    const contextTokensUsed =
      agentCfgContextTokens ??
      lookupContextTokens(modelUsed) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    await persistRunSessionUsage({
      storePath,
      sessionKey,
      usage,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      modelUsed,
      providerUsed,
      contextTokensUsed,
      systemPromptReport: runResult.meta?.systemPromptReport,
      cliSessionId,
    });
    if (!isHeartbeat) {
      const configuredSearchProvider =
        typeof cfg.tools?.web?.search?.provider === "string" && cfg.tools.web.search.provider.trim()
          ? cfg.tools.web.search.provider.trim()
          : "default";
      const webSearchInvoked = trackedToolStarts.has("web_search");
      defaultRuntime.log(
        [
          "[reply-trace]",
          `run=${runId}`,
          `session=${sessionKey ?? "-"}`,
          `selected=${selectedProvider}/${selectedModel}`,
          `active=${providerUsed}/${modelUsed}`,
          `web_search=${webSearchInvoked ? configuredSearchProvider : "none"}`,
          `fallback=${fallbackTransition.fallbackTransitioned ? "yes" : "no"}`,
        ].join(" "),
      );
    }

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const payloadResult = buildReplyPayloads({
      payloads: payloadArray,
      isHeartbeat,
      didLogHeartbeatStrip,
      blockStreamingEnabled: blockStreamingEnabled && !financeStreamSuppressed,
      blockReplyPipeline: financeStreamSuppressed ? null : blockReplyPipeline,
      directlySentBlockKeys: financeStreamSuppressed
        ? actuallyDeliveredBlockKeys
        : directlySentBlockKeys,
      replyToMode,
      replyToChannel,
      currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentTexts: runResult.messagingToolSentTexts,
      messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      originatingChannel: sessionCtx.OriginatingChannel,
      originatingTo: resolveOriginMessageTo({
        originatingTo: sessionCtx.OriginatingTo,
        to: sessionCtx.To,
      }),
      accountId: sessionCtx.AccountId,
    });
    councilGateRunId = runId;
    commercialCallerRunId = runId;
    const replyPayloads: ReplyPayload[] = [];
    for (const payload of payloadResult.replyPayloads) {
      replyPayloads.push(await guardReply(payload, "final"));
    }
    didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;

    if (replyPayloads.length === 0) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const successfulCronAdds = runResult.successfulCronAdds ?? 0;
    const hasReminderCommitment = replyPayloads.some(
      (payload) =>
        !payload.isError &&
        typeof payload.text === "string" &&
        hasUnbackedReminderCommitment(payload.text),
    );
    // Suppress the guard note when an existing cron job (created in a prior
    // turn) already covers the commitment — avoids false positives (#32228).
    const coveredByExistingCron =
      hasReminderCommitment && successfulCronAdds === 0
        ? await hasSessionRelatedCronJobs({
            cronStorePath: cfg.cron?.store,
            sessionKey,
          })
        : false;
    const guardedReplyPayloads =
      hasReminderCommitment && successfulCronAdds === 0 && !coveredByExistingCron
        ? appendUnscheduledReminderNote(replyPayloads)
        : replyPayloads;

    await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);

    if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const promptTokens = input + cacheRead + cacheWrite;
      const totalTokens = usage.total ?? promptTokens + output;
      const costConfig = resolveModelCostConfig({
        provider: providerUsed,
        model: modelUsed,
        config: cfg,
      });
      const costUsd = estimateUsageCost({ usage, cost: costConfig });
      emitDiagnosticEvent({
        type: "model.usage",
        sessionKey,
        sessionId: followupRun.run.sessionId,
        channel: replyToChannel,
        provider: providerUsed,
        model: modelUsed,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          promptTokens,
          total: totalTokens,
        },
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        context: {
          limit: contextTokensUsed,
          used: totalTokens,
        },
        costUsd,
        durationMs: Date.now() - runStartedAt,
      });
    }

    const responseUsageRaw =
      activeSessionEntry?.responseUsage ??
      (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
    const responseUsageMode = resolveResponseUsageMode(responseUsageRaw);
    if (responseUsageMode !== "off" && hasNonzeroUsage(usage)) {
      const authMode = resolveModelAuthMode(providerUsed, cfg);
      const showCost = authMode === "api-key";
      const costConfig = showCost
        ? resolveModelCostConfig({
            provider: providerUsed,
            model: modelUsed,
            config: cfg,
          })
        : undefined;
      let formatted = formatResponseUsageLine({
        usage,
        showCost,
        costConfig,
      });
      if (formatted && responseUsageMode === "full" && sessionKey) {
        formatted = `${formatted} · session \`${sessionKey}\``;
      }
      if (formatted) {
        responseUsageLine = formatted;
      }
    }

    // If verbose is enabled, prepend operational run notices.
    let finalPayloads = guardedReplyPayloads;
    const verboseNotices: ReplyPayload[] = [];

    if (verboseEnabled && activeIsNewSession) {
      verboseNotices.push({ text: `🧭 New session: ${followupRun.run.sessionId}` });
    }

    if (fallbackTransition.fallbackTransitioned) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "fallback",
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          reasonSummary: fallbackTransition.reasonSummary,
          attemptSummaries: fallbackTransition.attemptSummaries,
          attempts: fallbackAttempts,
        },
      });
      if (verboseEnabled) {
        const fallbackNotice = buildFallbackNotice({
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          attempts: fallbackAttempts,
        });
        if (fallbackNotice) {
          verboseNotices.push({ text: fallbackNotice });
        }
      }
    }
    if (fallbackTransition.fallbackCleared) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "fallback_cleared",
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          previousActiveModel: fallbackTransition.previousState.activeModel,
        },
      });
      if (verboseEnabled) {
        verboseNotices.push({
          text: buildFallbackClearedNotice({
            selectedProvider,
            selectedModel,
            previousActiveModel: fallbackTransition.previousState.activeModel,
          }),
        });
      }
    }

    if (autoCompactionCompleted) {
      const count = await incrementRunCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        contextTokensUsed,
      });

      // Inject post-compaction workspace context for the next agent turn
      if (sessionKey) {
        const workspaceDir = followupRun.run.workspaceDir;
        readPostCompactionContext(workspaceDir, cfg)
          .then((contextContent) => {
            if (contextContent) {
              enqueueSystemEvent(contextContent, { sessionKey });
            } else {
              defaultRuntime.log(
                "[warn] Post-compaction workspace context unavailable: no readable startup sections",
              );
            }
          })
          .catch(() => {
            defaultRuntime.log("[warn] Post-compaction workspace context refresh failed");
          });
      }

      if (verboseEnabled) {
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        verboseNotices.push({ text: `🧹 Auto-compaction complete${suffix}.` });
      }
    }
    if (verboseNotices.length > 0) {
      finalPayloads = [...verboseNotices, ...finalPayloads];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }
    finalPayloads = sealFinalReplies(finalPayloads);

    return finalizeWithFollowup(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
      queueKey,
      runFollowupTurn,
    );
  } catch (error) {
    // Keep the followup queue moving even when an unexpected exception escapes
    // the run path; the caller still receives the original error.
    finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    throw error;
  } finally {
    financeEvidence.stop();
    unsubscribeFinanceEvidence();
    blockReplyPipeline?.stop();
    typing.markRunComplete();
    // Safety net: the dispatcher's onIdle callback normally fires
    // markDispatchIdle(), but if the dispatcher exits early, errors,
    // or the reply path doesn't go through it cleanly, the second
    // signal never fires and the typing keepalive loop runs forever.
    // Calling this twice is harmless — cleanup() is guarded by the
    // `active` flag.  Same pattern as the followup runner fix (#26881).
    typing.markDispatchIdle();
  }
}
