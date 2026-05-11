import type { ChannelId } from "../channels/plugins/types.js";
import {
  CHANNEL_IDS,
  listChatChannelAliases,
  normalizeChatChannelId,
} from "../channels/registry.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
  normalizeGatewayClientMode,
  normalizeGatewayClientName,
} from "../gateway/protocol/client-info.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";

export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;
export type InternalMessageChannel = typeof INTERNAL_MESSAGE_CHANNEL;

const MARKDOWN_CAPABLE_CHANNELS = new Set<string>([
  "slack",
  "telegram",
  "signal",
  "discord",
  "googlechat",
  "tui",
  INTERNAL_MESSAGE_CHANNEL,
]);

export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export type { GatewayClientName, GatewayClientMode };
export { normalizeGatewayClientName, normalizeGatewayClientMode };

type GatewayClientInfoLike = {
  mode?: string | null;
  id?: string | null;
};

export function isGatewayCliClient(client?: GatewayClientInfoLike | null): boolean {
  return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}

export function isInternalMessageChannel(raw?: string | null): raw is InternalMessageChannel {
  return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}

export function isWebchatClient(client?: GatewayClientInfoLike | null): boolean {
  const mode = normalizeGatewayClientMode(client?.mode);
  if (mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
    return true;
  }
  return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI;
}

export function normalizeMessageChannel(raw?: string | null): string | undefined {
  const normalized = normalizeMessageChannelFamilyAlias(raw);
  if (!normalized) {
    return undefined;
  }
  if (normalized === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  const builtIn = normalizeChatChannelId(normalized);
  if (builtIn) {
    return builtIn;
  }
  const registry = getActivePluginRegistry();
  const pluginMatch = registry?.channels.find((entry) => {
    if (entry.plugin.id.toLowerCase() === normalized) {
      return true;
    }
    return (entry.plugin.meta.aliases ?? []).some(
      (alias) => alias.trim().toLowerCase() === normalized,
    );
  });
  return pluginMatch?.plugin.id ?? normalized;
}

const listPluginChannelIds = (): string[] => {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return [];
  }
  return registry.channels.map((entry) => entry.plugin.id);
};

const listPluginChannelAliases = (): string[] => {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return [];
  }
  return registry.channels.flatMap((entry) => entry.plugin.meta.aliases ?? []);
};

export const listDeliverableMessageChannels = (): ChannelId[] =>
  Array.from(new Set([...CHANNEL_IDS, ...listPluginChannelIds()]));

export type DeliverableMessageChannel = ChannelId;

export type GatewayMessageChannel = DeliverableMessageChannel | InternalMessageChannel;

export const listGatewayMessageChannels = (): GatewayMessageChannel[] => [
  ...listDeliverableMessageChannels(),
  INTERNAL_MESSAGE_CHANNEL,
];

export const listGatewayAgentChannelAliases = (): string[] =>
  Array.from(new Set([...listChatChannelAliases(), ...listPluginChannelAliases()]));

export type GatewayAgentChannelHint = GatewayMessageChannel | "last";

export const listGatewayAgentChannelValues = (): string[] =>
  Array.from(
    new Set([...listGatewayMessageChannels(), "last", ...listGatewayAgentChannelAliases()]),
  );

export function isGatewayMessageChannel(value: string): value is GatewayMessageChannel {
  return listGatewayMessageChannels().includes(value as GatewayMessageChannel);
}

export function isDeliverableMessageChannel(value: string): value is DeliverableMessageChannel {
  return listDeliverableMessageChannels().includes(value as DeliverableMessageChannel);
}

export function resolveGatewayMessageChannel(
  raw?: string | null,
): GatewayMessageChannel | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized) {
    return undefined;
  }
  return isGatewayMessageChannel(normalized) ? normalized : undefined;
}

/**
 * Normalize a raw channel label to the underlying routing family.
 *
 * Keeps split-chain identifiers such as "lark:dm:xxx" aligned with their
 * parent family and preserves Feishu/Lark equivalence through explicit
 * family mapping.
 */
export function normalizeMessageChannelFamilyAlias(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const baseAlias = normalized.split(":")[0];
  if (!baseAlias) {
    return undefined;
  }
  if (baseAlias === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  if (baseAlias === "lark" || baseAlias === "feishu") {
    return "feishu";
  }
  const baseNormalized =
    normalizeChatChannelId(baseAlias) ?? normalizeFamilyAliasPluginId(baseAlias) ?? baseAlias;
  return baseNormalized;
}

function normalizeFamilyAliasPluginId(alias: string): string | undefined {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return undefined;
  }
  const match = registry.channels.find((entry) => {
    if (entry.plugin.id.toLowerCase() === alias) {
      return true;
    }
    return (entry.plugin.meta.aliases ?? []).some((item) => item.trim().toLowerCase() === alias);
  });
  return match?.plugin.id;
}

export function resolveMessageChannel(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback);
}

export function isMarkdownCapableMessageChannel(raw?: string | null): boolean {
  const channel = normalizeMessageChannel(raw);
  if (!channel) {
    return false;
  }
  return MARKDOWN_CAPABLE_CHANNELS.has(channel);
}
