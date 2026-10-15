import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createExternalWebhookRequestHandler,
  processExternalMessage,
  type ExternalWebhookTarget,
} from "../../extensions/external/src/monitor.js";
import { createExternalReplayGuard } from "../../extensions/external/src/replay-guard.js";
import type { ResolvedExternalAccount } from "../../extensions/external/src/types.js";
import { hasControlCommand } from "../../src/auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../src/auto-reply/commands-registry.js";
import {
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../src/auto-reply/envelope.js";
import { runReplyAgent } from "../../src/auto-reply/reply/agent-runner.js";
import { createFollowupRunner } from "../../src/auto-reply/reply/followup-runner.js";
import { finalizeInboundContext } from "../../src/auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../src/auto-reply/reply/provider-dispatcher.js";
import type { FollowupRun } from "../../src/auto-reply/reply/queue.js";
import { createMockTypingController } from "../../src/auto-reply/reply/test-helpers.js";
import type { MsgContext } from "../../src/auto-reply/templating.js";
import type { TemplateContext } from "../../src/auto-reply/templating.js";
import type { GetReplyOptions } from "../../src/auto-reply/types.js";
import {
  resolveStorePath,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
} from "../../src/config/sessions.js";
import { resolveAgentRoute } from "../../src/routing/resolve-route.js";

export type ExternalProbeFault = "resolver_error";
type OwnerRuntimeSubset = {
  [K in "routing" | "session" | "commands" | "text" | "pairing" | "reply"]: Partial<
    NonNullable<ExternalWebhookTarget["channelRuntime"]>[K]
  >;
};

/** Actual private ingress/session/reply worker/dispatcher/send; model and receiver are substitutes. */
export async function probeOriginalLanguageReply(
  directory: string,
  fault?: ExternalProbeFault,
  options: {
    ask?: string;
    queued?: boolean;
    abortSignal?: AbortSignal;
    onPartialReply?: GetReplyOptions["onPartialReply"];
  } = {},
) {
  const account: ResolvedExternalAccount = {
    accountId: "offline-external",
    enabled: true,
    webhookPath: "/external/messages",
    inboundAuth: "token",
    inboundToken: "offline-inbound",
    inboundTokenHeader: "authorization",
    outboundUrl: "https://93.184.216.34/messages",
    outboundAuth: "none",
    outboundToken: "",
    outboundTokenHeader: "x-external-channel-token",
    timeoutMs: 1000,
    textChunkLimit: 4000,
    dmPolicy: "allowlist",
    allowFrom: ["offline-user"],
    groupPolicy: "allowlist",
    groupAllowFrom: [],
    groups: {},
    configured: true,
  };
  const inputs: MsgContext[] = [];
  const replyResults: unknown[] = [];
  const sessionWrites: unknown[] = [];
  const dispatchResults: unknown[] = [];
  const statusPatches: unknown[] = [];
  const errors: string[] = [];
  const pending: Promise<void>[] = [];
  const config = {
    session: { store: path.join(directory, "sessions.json") },
    agents: { defaults: { workspace: directory } },
    messages: { tts: { auto: "off" as const } },
  };
  const runtime = {
    routing: { resolveAgentRoute },
    session: {
      resolveStorePath,
      readSessionUpdatedAt,
      recordSessionMetaFromInbound: async (
        params: Parameters<typeof recordSessionMetaFromInbound>[0],
      ) => {
        const result = await recordSessionMetaFromInbound(params);
        sessionWrites.push(JSON.parse(await fs.readFile(params.storePath, "utf8")));
        return result;
      },
    },
    commands: { shouldHandleTextCommands },
    text: { hasControlCommand },
    pairing: { readAllowFromStore: async () => [] },
    reply: {
      finalizeInboundContext,
      resolveEnvelopeFormatOptions,
      formatAgentEnvelope,
      dispatchReplyWithBufferedBlockDispatcher: async (
        params: Parameters<typeof dispatchReplyWithBufferedBlockDispatcher>[0],
      ) => {
        const result = await dispatchReplyWithBufferedBlockDispatcher({
          ...params,
          replyResolver: async (ctx, replyOptions) => {
            inputs.push(structuredClone(ctx));
            if (fault === "resolver_error") {
              throw new Error("offline model reply unavailable");
            }
            const ask = String(ctx.BodyForAgent ?? "");
            const sessionKey = String(ctx.SessionKey);
            const followupRun = {
              prompt: ask,
              messageId: String(ctx.MessageSid),
              summaryLine: ask,
              enqueuedAt: Date.now(),
              run: {
                agentId: "main",
                agentDir: directory,
                sessionId: sessionKey,
                sessionKey,
                messageProvider: "external",
                sessionFile: path.join(directory, "reply-session.jsonl"),
                workspaceDir: directory,
                config,
                provider: "anthropic",
                model: "claude",
                thinkLevel: "low",
                verboseLevel: "off",
                elevatedLevel: "off",
                bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
                timeoutMs: 1000,
                blockReplyBreak: "message_end",
              },
            } satisfies FollowupRun;
            const opts = {
              ...replyOptions,
              onPartialReply: options.onPartialReply,
              abortSignal: options.abortSignal,
            };
            if (options.queued) {
              const runner = createFollowupRunner({
                opts,
                typing: createMockTypingController(),
                typingMode: "instant",
                sessionKey,
                defaultModel: "anthropic/claude",
              });
              await runner(followupRun);
              return undefined;
            }
            const result = await runReplyAgent({
              commandBody: ask,
              opts,
              followupRun,
              queueKey: sessionKey,
              resolvedQueue: { mode: "interrupt" },
              shouldSteer: false,
              shouldFollowup: false,
              isActive: false,
              isStreaming: false,
              typing: createMockTypingController(),
              sessionCtx: ctx as TemplateContext,
              defaultModel: "anthropic/claude",
              resolvedVerboseLevel: "off",
              isNewSession: false,
              blockStreamingEnabled: true,
              resolvedBlockStreamingBreak: "message_end",
              shouldInjectGroupIntro: false,
              typingMode: "instant",
            });
            replyResults.push(structuredClone(result));
            return result;
          },
        });
        dispatchResults.push(result);
        return result;
      },
    },
  } satisfies OwnerRuntimeSubset;
  const target: ExternalWebhookTarget = {
    account,
    config,
    runtime: {
      log: () => {},
      error: (message) => errors.push(String(message)),
      exit: () => {
        throw new Error("offline runtime must not exit");
      },
    },
    path: account.webhookPath,
    channelRuntime: runtime as unknown as ExternalWebhookTarget["channelRuntime"],
    statusSink: (patch) => statusPatches.push(patch),
  };
  const handler = createExternalWebhookRequestHandler({
    targetsByPath: new Map([[account.webhookPath, [target]]]),
    replayGuard: createExternalReplayGuard({ stateDir: directory }),
    processMessage: (message, selected) => {
      const execution = processExternalMessage(message, selected);
      pending.push(execution.catch(() => {}));
      return execution;
    },
  });
  const message = {
    id: `external-${path.basename(directory)}`,
    text: options.ask ?? "100 的 10% 是多少？直接回答，不要暴露内部标签。",
    senderId: "offline-user",
    conversationId: "offline-conversation",
    threadId: "offline-thread",
    replyToId: "previous-message",
    timestamp: Date.now(),
  };
  const submit = async (body: unknown, authorization = "Bearer offline-inbound") => {
    const request = Object.assign(Readable.from([JSON.stringify(body)]), {
      method: "POST",
      url: account.webhookPath,
      headers: { "content-type": "application/json", authorization },
      socket: { remoteAddress: "127.0.0.1" },
    }) as IncomingMessage;
    const response = {
      statusCode: 200,
      headersSent: false,
      body: "",
      setHeader: () => {},
      end(value?: string) {
        this.body = value ?? "";
        this.headersSent = true;
      },
    };
    await handler(request, response as unknown as ServerResponse);
    await Promise.all(pending);
    let responseBody: unknown = response.body;
    try {
      responseBody = JSON.parse(response.body);
    } catch {
      // Authentication rejections use the original SDK's plain response.
    }
    return { statusCode: response.statusCode, body: responseBody };
  };
  return {
    account,
    message,
    submit,
    inputs,
    replyResults,
    sessionWrites,
    dispatchResults,
    statusPatches,
    errors,
  };
}
