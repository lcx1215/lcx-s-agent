import type { IncomingMessage, ServerResponse } from "node:http";
import {
  beginWebhookRequestPipelineOrReject,
  createReplyPrefixOptions,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  resolveWebhookTargetWithAuthOrRejectSync,
  resolveWebhookTargets,
  type ChannelAccountSnapshot,
  type ChannelGatewayContext,
  type ChannelLogSink,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { normalizeExternalInboundMessage } from "./protocol.js";
import { isExternalInboundMessageAllowed, isExternalWebhookAuthorized } from "./security.js";
import { sendExternalMessage } from "./send.js";
import type { ExternalInboundMessage, ResolvedExternalAccount } from "./types.js";

type ExternalChannelRuntime = NonNullable<ChannelGatewayContext["channelRuntime"]>;
type ExternalRuntimeEnv = ChannelGatewayContext["runtime"];
type ExternalStatusPatch = Pick<ChannelAccountSnapshot, "lastInboundAt" | "lastOutboundAt">;

export type ExternalWebhookTarget = {
  account: ResolvedExternalAccount;
  config: OpenClawConfig;
  runtime: ExternalRuntimeEnv;
  channelRuntime?: ExternalChannelRuntime;
  path: string;
  log?: ChannelLogSink;
  statusSink?: (patch: ExternalStatusPatch) => void;
};

type ProcessExternalMessage = (
  message: ExternalInboundMessage,
  target: ExternalWebhookTarget,
) => Promise<void>;

const webhookTargets = new Map<string, ExternalWebhookTarget[]>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  if (res.headersSent) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function registerExternalWebhookTarget(target: ExternalWebhookTarget): () => void {
  const registered = registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "external",
      source: "external-webhook",
      accountId: target.account.accountId,
      log: target.log?.info,
      handler: async (req, res) => {
        const handled = await handleExternalWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          sendJson(res, 404, { ok: false, error: "not_found" });
        }
      },
    },
  });
  return registered.unregister;
}

export function createExternalWebhookRequestHandler(params: {
  targetsByPath: Map<string, ExternalWebhookTarget[]>;
  webhookInFlightLimiter?: ReturnType<typeof createWebhookInFlightLimiter>;
  processMessage?: ProcessExternalMessage;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const limiter = params.webhookInFlightLimiter ?? createWebhookInFlightLimiter();
  const processMessage = params.processMessage ?? processExternalMessage;

  return async (req, res) => {
    const resolved = resolveWebhookTargets(req, params.targetsByPath);
    if (!resolved) {
      return false;
    }
    const { path, targets } = resolved;
    const lifecycle = beginWebhookRequestPipelineOrReject({
      req,
      res,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      inFlightLimiter: limiter,
      inFlightKey: `${path}:${req.socket?.remoteAddress ?? "unknown"}`,
    });
    if (!lifecycle.ok) {
      return true;
    }

    try {
      const target = resolveWebhookTargetWithAuthOrRejectSync({
        targets,
        res,
        isMatch: (candidate) => isExternalWebhookAuthorized(req, candidate.account),
        unauthorizedMessage: "unauthorized",
        ambiguousMessage: "ambiguous external webhook target",
      });
      if (!target) {
        return true;
      }

      const body = await readJsonWebhookBodyOrReject({
        req,
        res,
        profile: "post-auth",
        emptyObjectOnEmpty: false,
        invalidJsonMessage: "invalid JSON payload",
      });
      if (!body.ok) {
        return true;
      }

      const parsed = normalizeExternalInboundMessage(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      if (!isExternalInboundMessageAllowed(target.account, parsed.value)) {
        sendJson(res, 403, { ok: false, error: "sender_not_allowed" });
        return true;
      }

      const message = parsed.value;
      target.statusSink?.({ lastInboundAt: Date.now() });
      void processMessage(message, target).catch((error: unknown) => {
        target.runtime.error(
          `[${target.account.accountId}] external webhook processing failed: ${String(error)}`,
        );
      });
      sendJson(res, 202, { ok: true, messageId: message.messageId });
      return true;
    } finally {
      lifecycle.release();
    }
  };
}

const externalWebhookRequestHandler = createExternalWebhookRequestHandler({
  targetsByPath: webhookTargets,
  webhookInFlightLimiter,
});

export async function handleExternalWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  return await externalWebhookRequestHandler(req, res);
}

function conversationLabelFor(message: ExternalInboundMessage): string {
  return (
    message.conversationLabel?.trim() ||
    (message.chatType === "direct" ? message.senderName?.trim() : undefined) ||
    `${message.chatType}:${message.conversationId}`
  );
}

export async function processExternalMessage(
  message: ExternalInboundMessage,
  target: ExternalWebhookTarget,
): Promise<void> {
  const core = target.channelRuntime;
  if (!core) {
    throw new Error("external channel runtime is unavailable");
  }

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: target.config,
    channel: "external",
    accountId: target.account.accountId,
    peer: {
      kind: message.chatType,
      id: message.conversationId,
    },
    runtime: core,
    sessionStore: target.config.session?.store,
  });
  const conversationLabel = conversationLabelFor(message);
  const { storePath, body } = buildEnvelope({
    channel: "External",
    from: conversationLabel,
    timestamp: message.timestamp,
    body: message.text,
  });
  const context = core.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: message.text,
    RawBody: message.text,
    CommandBody: message.text,
    From: `external:${message.senderId}`,
    To: `external:${message.conversationId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.chatType,
    ConversationLabel: conversationLabel,
    SenderName: message.senderName,
    SenderId: message.senderId,
    SenderUsername: message.senderUsername,
    WasMentioned: message.wasMentioned,
    CommandAuthorized: false,
    Provider: "external",
    Surface: "external",
    MessageSid: message.messageId,
    MessageSidFull: message.messageId,
    ReplyToId: message.replyToId,
    ReplyToIdFull: message.replyToId,
    MessageThreadId: message.threadId,
    Timestamp: message.timestamp,
    GroupChannel: message.chatType === "channel" ? conversationLabel : undefined,
    GroupSubject: message.chatType === "group" ? conversationLabel : undefined,
    OriginatingChannel: "external",
    OriginatingTo: `external:${message.conversationId}`,
  });

  await core.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: context.SessionKey ?? route.sessionKey,
    ctx: context,
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: target.config,
    agentId: route.agentId,
    channel: "external",
    accountId: target.account.accountId,
  });
  await core.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: context,
    cfg: target.config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        const text = payload.text ?? "";
        if (!text.trim() && mediaUrls.length === 0) {
          return;
        }
        await sendExternalMessage({
          account: target.account,
          target: message.conversationId,
          text,
          mediaUrls,
          replyToId: payload.replyToId ?? message.replyToId,
          threadId: message.threadId,
        });
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (error, info) => {
        target.runtime.error(
          `[${target.account.accountId}] external ${info.kind} reply failed: ${String(error)}`,
        );
      },
    },
    replyOptions: { onModelSelected },
  });
}
