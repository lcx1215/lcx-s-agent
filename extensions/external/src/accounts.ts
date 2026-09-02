import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { normalizeWebhookPath } from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type {
  ExternalAccountConfig,
  ExternalChannelConfig,
  ResolvedExternalAccount,
} from "./types.js";

const CHANNEL_KEY = "external";
const DEFAULT_WEBHOOK_PATH = "/external/messages";
const DEFAULT_INBOUND_TOKEN_HEADER = "authorization";
const DEFAULT_OUTBOUND_TOKEN_HEADER = "x-external-channel-token";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TEXT_CHUNK_LIMIT = 4_000;

function getChannelConfig(cfg: OpenClawConfig): ExternalChannelConfig | undefined {
  return cfg.channels?.[CHANNEL_KEY] as ExternalChannelConfig | undefined;
}

function resolveAccountOverride(
  cfg: OpenClawConfig,
  accountId: string,
): ExternalAccountConfig | undefined {
  const accounts = getChannelConfig(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchingKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchingKey ? accounts[matchingKey] : undefined;
}

function mergeAccountConfig(cfg: OpenClawConfig, accountId: string): ExternalAccountConfig {
  const channel = getChannelConfig(cfg) ?? {};
  const { accounts: _accounts, defaultAccount: _defaultAccount, ...base } = channel;
  return { ...base, ...(resolveAccountOverride(cfg, accountId) ?? {}) };
}

function resolveSecret(value: unknown, path: string): { value: string; source: "config" | "none" } {
  const resolved = normalizeResolvedSecretInputString({ value, path });
  return resolved ? { value: resolved, source: "config" } : { value: "", source: "none" };
}

export function listExternalAccountIds(cfg: OpenClawConfig): string[] {
  const channel = getChannelConfig(cfg);
  if (!channel) {
    return [];
  }
  const accountIds = Object.keys(channel.accounts ?? {}).filter(Boolean);
  if (accountIds.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return accountIds.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultExternalAccountId(cfg: OpenClawConfig): string {
  const preferred = normalizeOptionalAccountId(getChannelConfig(cfg)?.defaultAccount);
  const accountIds = listExternalAccountIds(cfg);
  if (preferred && accountIds.some((id) => normalizeAccountId(id) === preferred)) {
    return preferred;
  }
  return accountIds.includes(DEFAULT_ACCOUNT_ID)
    ? DEFAULT_ACCOUNT_ID
    : (accountIds[0] ?? DEFAULT_ACCOUNT_ID);
}

export function resolveExternalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedExternalAccount {
  const accountId = normalizeAccountId(params.accountId);
  const channel = getChannelConfig(params.cfg) ?? {};
  const merged = mergeAccountConfig(params.cfg, accountId);
  const inbound = resolveSecret(
    merged.inboundToken,
    `channels.${CHANNEL_KEY}.accounts.${accountId}.inboundToken`,
  );
  const outbound = resolveSecret(
    merged.outboundToken,
    `channels.${CHANNEL_KEY}.accounts.${accountId}.outboundToken`,
  );
  const inboundAuth = merged.inboundAuth ?? "token";
  const outboundAuth = merged.outboundAuth ?? "none";
  const outboundUrl = merged.outboundUrl?.trim() ?? "";
  const configured =
    (inboundAuth === "none" || Boolean(inbound.value)) &&
    Boolean(outboundUrl) &&
    (outboundAuth === "none" || Boolean(outbound.value));

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    defaultTo: merged.defaultTo?.trim() || undefined,
    enabled: channel.enabled !== false && merged.enabled !== false,
    webhookPath: normalizeWebhookPath(merged.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH),
    inboundAuth,
    inboundToken: inbound.value,
    inboundTokenHeader:
      merged.inboundTokenHeader?.trim().toLowerCase() || DEFAULT_INBOUND_TOKEN_HEADER,
    outboundUrl,
    outboundAuth,
    outboundToken: outbound.value,
    outboundTokenHeader: merged.outboundTokenHeader?.trim() || DEFAULT_OUTBOUND_TOKEN_HEADER,
    timeoutMs: merged.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    textChunkLimit: merged.textChunkLimit ?? DEFAULT_TEXT_CHUNK_LIMIT,
    dmPolicy: merged.dmPolicy ?? "allowlist",
    allowFrom: merged.allowFrom ?? [],
    groupPolicy: merged.groupPolicy ?? "allowlist",
    groupAllowFrom: merged.groupAllowFrom ?? [],
    groups: merged.groups ?? {},
    configured,
  };
}
