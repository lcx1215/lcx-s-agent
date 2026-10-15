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
import { finalizeInboundContext } from "../../src/auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../src/auto-reply/reply/provider-dispatcher.js";
import type { MsgContext } from "../../src/auto-reply/templating.js";
import type { GetReplyOptions } from "../../src/auto-reply/types.js";
import {
  resolveStorePath,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
} from "../../src/config/sessions.js";
import { resolveAgentRoute } from "../../src/routing/resolve-route.js";

type OwnerRuntimeSubset = {
  [K in "routing" | "session" | "commands" | "text" | "pairing" | "reply"]: Partial<
    NonNullable<ExternalWebhookTarget["channelRuntime"]>[K]
  >;
};

/** Default resolver is untouched; all routing/session/prepared-reply owners execute on private IO. */
export async function probeOriginalDefaultLanguageReply(
  directory: string,
  options: {
    ask?: string;
    replyOptions?: GetReplyOptions;
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
  const sessionWrites: unknown[] = [];
  const dispatchResults: unknown[] = [];
  const statusPatches: unknown[] = [];
  const errors: string[] = [];
  const pending: Promise<void>[] = [];
  const config = {
    session: { store: path.join(directory, "sessions.json") },
    agents: {
      defaults: {
        workspace: directory,
        skipBootstrap: true,
        model: { primary: "anthropic/claude-sonnet-4-5" },
        typingMode: "never" as const,
      },
      list: [
        {
          id: "main",
          default: true,
          workspace: directory,
          agentDir: path.join(directory, "agent"),
        },
      ],
    },
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
        if ("replyResolver" in params) {
          throw new Error("default-entry proof forbids replyResolver override");
        }
        inputs.push(structuredClone(params.ctx));
        const result = await dispatchReplyWithBufferedBlockDispatcher({
          ...params,
          replyOptions: { ...params.replyOptions, ...options.replyOptions },
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
    sessionWrites,
    dispatchResults,
    statusPatches,
    errors,
    readSessionStore: async () =>
      JSON.parse(await fs.readFile(config.session.store, "utf8")) as Record<string, unknown>,
  };
}
