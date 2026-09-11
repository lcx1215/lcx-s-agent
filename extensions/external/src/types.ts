import type { SecretInput } from "lcx-agent/plugin-sdk";

export type ExternalChatType = "direct" | "group" | "channel";
export type ExternalDmPolicy = "allowlist" | "open" | "disabled";
export type ExternalGroupPolicy = "allowlist" | "open" | "disabled";
export type ExternalInboundAuth = "token" | "none";
export type ExternalOutboundAuth = "bearer" | "header" | "none";

export type ExternalGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
};

export type ExternalAccountConfig = {
  name?: string;
  enabled?: boolean;
  defaultTo?: string;
  webhookPath?: string;
  inboundAuth?: ExternalInboundAuth;
  inboundToken?: SecretInput;
  inboundTokenHeader?: string;
  outboundUrl?: string;
  outboundAuth?: ExternalOutboundAuth;
  outboundToken?: SecretInput;
  outboundTokenHeader?: string;
  timeoutMs?: number;
  textChunkLimit?: number;
  dmPolicy?: ExternalDmPolicy;
  allowFrom?: Array<string | number>;
  groupPolicy?: ExternalGroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, ExternalGroupConfig>;
};

export type ExternalChannelConfig = ExternalAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, ExternalAccountConfig | undefined>;
};

export type ResolvedExternalAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  webhookPath: string;
  inboundAuth: ExternalInboundAuth;
  inboundToken: string;
  inboundTokenHeader: string;
  outboundUrl: string;
  outboundAuth: ExternalOutboundAuth;
  outboundToken: string;
  outboundTokenHeader: string;
  timeoutMs: number;
  textChunkLimit: number;
  dmPolicy: ExternalDmPolicy;
  allowFrom: Array<string | number>;
  groupPolicy: ExternalGroupPolicy;
  groupAllowFrom: Array<string | number>;
  groups: Record<string, ExternalGroupConfig>;
  defaultTo?: string;
  configured: boolean;
};

export type ExternalInboundMessage = {
  messageId: string;
  text: string;
  senderId: string;
  senderName?: string;
  senderUsername?: string;
  conversationId: string;
  conversationLabel?: string;
  chatType: ExternalChatType;
  timestamp: number;
  replyToId?: string;
  threadId?: string;
  wasMentioned?: boolean;
  metadata?: Record<string, unknown>;
};
