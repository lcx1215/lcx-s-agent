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
import {
  resolveStorePath,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
} from "../../src/config/sessions.js";
import { resolveAgentRoute } from "../../src/routing/resolve-route.js";

export type ExternalProbeFault = "missing_runtime" | "resolver_error";
type OwnerRuntimeSubset = {
  [K in "routing" | "session" | "commands" | "text" | "pairing" | "reply"]: Partial<
    NonNullable<ExternalWebhookTarget["channelRuntime"]>[K]
  >;
};

/** Original channel/dispatch owners; only model reply and HTTP receiver are substitutes. */
export async function probeOriginalExternalTransport(
  directory: string,
  fault?: ExternalProbeFault,
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
    timeoutMs: 30,
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
          replyResolver: async (ctx) => {
            inputs.push(structuredClone(ctx));
            if (fault === "resolver_error") {
              throw new Error("offline model reply unavailable");
            }
            return { text: "100 的 10% 是 10。" };
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
    channelRuntime:
      fault === "missing_runtime"
        ? undefined
        : (runtime as unknown as ExternalWebhookTarget["channelRuntime"]),
    statusSink: (patch) => statusPatches.push(patch),
  };
  const replayGuard = createExternalReplayGuard({ stateDir: directory });
  const claimMessage = replayGuard.claimMessage.bind(replayGuard);
  replayGuard.claimMessage = async (key) => {
    const claim = await claimMessage(key);
    if (!claim) {
      return undefined;
    }
    let settled: () => void = () => {};
    pending.push(
      new Promise<void>((resolve) => {
        settled = resolve;
      }),
    );
    return {
      settle: async (outcome) => {
        try {
          await claim.settle(outcome);
        } finally {
          // Observe the post-ack chain's error logging after its awaited settlement,
          // before assertions or removal of the private replay-state directory.
          setImmediate(settled);
        }
      },
    };
  };
  const handler = createExternalWebhookRequestHandler({
    targetsByPath: new Map([[account.webhookPath, [target]]]),
    replayGuard,
    processMessage: (message, selected) => {
      const execution = processExternalMessage(message, selected);
      pending.push(execution.catch(() => {}));
      return execution;
    },
  });
  const message = {
    id: `external-${path.basename(directory)}`,
    text: "100 的 10% 是多少？",
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
  };
}
