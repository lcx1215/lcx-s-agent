/**
 * Provider-agnostic reply router.
 *
 * Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
 * instead of using the session's lastChannel. This ensures replies go back to the
 * provider where the message originated, even when the main session is shared
 * across multiple providers.
 */

import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig } from "../../agents/identity.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { shouldSuppressReasoningPayload } from "./reply-payloads.js";
import { isFeishuFamilyChannel, resolveReplyRouteChannel } from "./reply-routing-helpers.js";

let deliverRuntimePromise: Promise<
  typeof import("../../infra/outbound/deliver-runtime.js")
> | null = null;

function loadDeliverRuntime() {
  deliverRuntimePromise ??= import("../../infra/outbound/deliver-runtime.js");
  return deliverRuntimePromise;
}

function readRouteReplyResponsePrefix(
  cfg: OpenClawConfig,
  channel?: string | null,
  accountId?: string,
): string | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const channelCfg =
    channel && typeof channels?.[channel] === "object" && channels[channel] !== null
      ? (channels[channel] as Record<string, unknown>)
      : undefined;
  if (channelCfg && accountId) {
    const accounts = channelCfg.accounts as Record<string, Record<string, unknown>> | undefined;
    const accountPrefix = accounts?.[accountId]?.responsePrefix;
    if (typeof accountPrefix === "string") {
      return accountPrefix === "auto" ? undefined : accountPrefix;
    }
  }
  const channelPrefix = channelCfg?.responsePrefix;
  if (typeof channelPrefix === "string") {
    return channelPrefix === "auto" ? undefined : channelPrefix;
  }
  const globalPrefix = cfg.messages?.responsePrefix;
  return globalPrefix === "auto" ? undefined : globalPrefix;
}

export type RouteReplyParams = {
  /** The reply payload to send. */
  payload: ReplyPayload;
  /** The originating channel type (telegram, slack, etc). */
  channel: OriginatingChannelType;
  /** The destination chat/channel/user ID. */
  to: string;
  /** Session key for deriving agent identity defaults (multi-agent). */
  sessionKey?: string;
  /** Provider account id (multi-account). */
  accountId?: string;
  /** Thread id for replies (Telegram topic id or Matrix thread event id). */
  threadId?: string | number;
  /** Config for provider-specific settings. */
  cfg: OpenClawConfig;
  /** Optional abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;
  /** Mirror reply into session transcript (default: true when sessionKey is set). */
  mirror?: boolean;
  /** Whether this message is being sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier for correlation with received events */
  groupId?: string;
};

export type RouteReplyResult = {
  /** Whether the reply was sent successfully. */
  ok: boolean;
  /** Optional message ID from the provider. */
  messageId?: string;
  /** Error message if the send failed. */
  error?: string;
};

/**
 * Routes a reply payload to the specified channel.
 *
 * This function provides a unified interface for sending messages to any
 * supported provider. It's used by the followup queue to route replies
 * back to the originating channel when OriginatingChannel/OriginatingTo
 * are set.
 */
export async function routeReply(params: RouteReplyParams): Promise<RouteReplyResult> {
  const { payload, channel, to, accountId, threadId, cfg, abortSignal } = params;
  if (shouldSuppressReasoningPayload(payload)) {
    return { ok: true };
  }
  const resolvedRouteChannel = resolveReplyRouteChannel(channel);
  const normalizedChannel = resolvedRouteChannel ?? normalizeMessageChannel(channel);
  const resolvedAgentId = params.sessionKey
    ? resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: cfg,
      })
    : undefined;

  // Debug: `pnpm test src/auto-reply/reply/route-reply.test.ts`
  const responsePrefix = params.sessionKey
    ? resolveEffectiveMessagesConfig(
        cfg,
        resolvedAgentId ?? resolveSessionAgentId({ config: cfg }),
        { channel: resolvedRouteChannel ?? normalizedChannel, accountId },
      ).responsePrefix
    : readRouteReplyResponsePrefix(cfg, resolvedRouteChannel ?? normalizedChannel, accountId);
  const normalized = normalizeReplyPayload(payload, {
    responsePrefix: responsePrefix?.trimEnd(),
  });
  if (!normalized) {
    return { ok: true };
  }

  let text = normalized.text ?? "";
  let mediaUrls = (normalized.mediaUrls?.filter(Boolean) ?? []).length
    ? (normalized.mediaUrls?.filter(Boolean) as string[])
    : normalized.mediaUrl
      ? [normalized.mediaUrl]
      : [];
  const replyToId = normalized.replyToId;

  // Skip empty replies.
  if (!text.trim() && mediaUrls.length === 0) {
    return { ok: true };
  }

  if (normalizedChannel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      error: "Webchat routing not supported for queued replies",
    };
  }

  const channelId = resolvedRouteChannel ?? null;
  if (!channelId) {
    return { ok: false, error: `Unknown channel: ${String(channel)}` };
  }
  if (abortSignal?.aborted) {
    return { ok: false, error: "Reply routing aborted" };
  }

  const resolvedReplyToId =
    replyToId ??
    (channelId === "slack" && threadId != null && threadId !== "" ? String(threadId) : undefined);
  const resolvedThreadId = channelId === "slack" ? null : (threadId ?? null);

  try {
    // Provider docking: this is an execution boundary (we're about to send).
    // Keep the module cheap to import by loading outbound plumbing lazily.
    const { deliverOutboundPayloads } = await loadDeliverRuntime();
    const outboundSession = buildOutboundSessionContext({
      cfg,
      agentId: resolvedAgentId,
      sessionKey: params.sessionKey,
    });
    const results = await deliverOutboundPayloads({
      cfg,
      channel: channelId,
      to,
      accountId: accountId ?? undefined,
      payloads: [normalized],
      replyToId: resolvedReplyToId ?? null,
      threadId: resolvedThreadId,
      session: outboundSession,
      abortSignal,
      mirror:
        params.mirror !== false && params.sessionKey
          ? {
              sessionKey: params.sessionKey,
              agentId: resolvedAgentId,
              text,
              mediaUrls,
              ...(params.isGroup != null ? { isGroup: params.isGroup } : {}),
              ...(params.groupId ? { groupId: params.groupId } : {}),
            }
          : undefined,
    });

    const last = results.at(-1);
    return { ok: true, messageId: last?.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to route reply to ${channel}: ${message}`,
    };
  }
}

/**
 * Checks if a channel type is routable via routeReply.
 *
 * Some channels (webchat) require special handling and cannot be routed through
 * this generic interface.
 */
export function isRoutableChannel(
  channel: OriginatingChannelType | undefined,
): channel is Exclude<OriginatingChannelType, typeof INTERNAL_MESSAGE_CHANNEL> {
  if (!channel) {
    return false;
  }
  const normalized = normalizeMessageChannel(channel);
  if (!normalized || normalized === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  if (isFeishuFamilyChannel(channel)) {
    return true;
  }
  return Boolean(resolveReplyRouteChannel(channel));
}
