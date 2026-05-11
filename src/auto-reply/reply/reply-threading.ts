import { getChannelDock } from "../../channels/dock.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyToMode } from "../../config/types.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { isFeishuFamilyChannel, resolveReplyRouteChannel } from "./reply-routing-helpers.js";

export function resolveReplyToMode(
  cfg: OpenClawConfig,
  channel?: OriginatingChannelType,
  accountId?: string | null,
  chatType?: string | null,
): ReplyToMode {
  const provider = resolveReplyRouteChannel(channel);
  if (!provider) {
    return "all";
  }
  const resolved = getChannelDock(provider)?.threading?.resolveReplyToMode?.({
    cfg,
    accountId,
    chatType,
  });
  return resolved ?? "all";
}

export function createReplyToModeFilter(
  mode: ReplyToMode,
  opts: { allowExplicitReplyTagsWhenOff?: boolean } = {},
) {
  let hasThreaded = false;
  return (payload: ReplyPayload): ReplyPayload => {
    if (!payload.replyToId) {
      return payload;
    }
    if (mode === "off") {
      const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
      if (opts.allowExplicitReplyTagsWhenOff && isExplicit) {
        return payload;
      }
      return { ...payload, replyToId: undefined };
    }
    if (mode === "all") {
      return payload;
    }
    if (hasThreaded) {
      return { ...payload, replyToId: undefined };
    }
    hasThreaded = true;
    return payload;
  };
}

export function createReplyToModeFilterForChannel(
  mode: ReplyToMode,
  channel?: OriginatingChannelType,
) {
  const provider =
    resolveReplyRouteChannel(channel) ?? (isFeishuFamilyChannel(channel) ? "feishu" : undefined);
  const normalized = normalizeMessageChannel(channel);
  const isWebchat = normalized === INTERNAL_MESSAGE_CHANNEL;
  // Default: allow explicit reply tags/directives even when replyToMode is "off".
  // Unknown channels fail closed; internal webchat and feishu-family channels stay allowed.
  const dock = provider ? getChannelDock(provider) : undefined;
  const allowExplicitReplyTagsWhenOff =
    (provider
      ? (dock?.threading?.allowExplicitReplyTagsWhenOff ?? dock?.threading?.allowTagsWhenOff)
      : undefined) ??
    (provider ? true : undefined) ??
    (isFeishuFamilyChannel(channel) || isWebchat);
  return createReplyToModeFilter(mode, {
    allowExplicitReplyTagsWhenOff,
  });
}
