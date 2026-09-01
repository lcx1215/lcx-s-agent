import { CHANNEL_IDS, normalizeAnyChannelId } from "../../channels/registry.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  normalizeMessageChannelFamilyAlias,
} from "../../utils/message-channel.js";

/**
 * Resolve a channel label into a channel id that routeReply can deliver through.
 *
 * Unknown plugin channels are only treated as routable after plugin registry
 * resolution to avoid false positives when only alias text is present.
 */
export function resolveReplyRouteChannel(rawChannel?: string | null): string | undefined {
  const normalizedChannel = normalizeReplyRouteProviderAlias(rawChannel);
  if (!normalizedChannel || normalizedChannel === INTERNAL_MESSAGE_CHANNEL) {
    return undefined;
  }
  const resolved = (CHANNEL_IDS as readonly string[]).includes(normalizedChannel)
    ? normalizedChannel
    : safeResolveAnyReplyRouteChannel(normalizedChannel);
  return resolved;
}

export function safeResolveAnyReplyRouteChannel(routeChannel?: string | null): string | undefined {
  if (!routeChannel) {
    return undefined;
  }
  try {
    return normalizeAnyChannelId(routeChannel) ?? undefined;
  } catch {
    return undefined;
  }
}

export function normalizeReplyRouteProviderAlias(rawChannel?: string | null): string | undefined {
  const normalized = normalizeMessageChannelFamilyAlias(rawChannel);
  return normalized === INTERNAL_MESSAGE_CHANNEL ? undefined : (normalized ?? undefined);
}
