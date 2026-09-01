import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ExternalInboundMessage, ResolvedExternalAccount } from "./types.js";

function normalizeToken(value: string): string {
  const trimmed = value.trim();
  return /^bearer\s+/i.test(trimmed) ? trimmed.replace(/^bearer\s+/i, "").trim() : trimmed;
}

export function safeEqualToken(leftRaw: string, rightRaw: string): boolean {
  const left = Buffer.from(normalizeToken(leftRaw), "utf8");
  const right = Buffer.from(normalizeToken(rightRaw), "utf8");
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export function readExternalHeader(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0]?.trim() ?? "";
  }
  return raw?.trim() ?? "";
}

export function isExternalWebhookAuthorized(
  req: IncomingMessage,
  account: ResolvedExternalAccount,
): boolean {
  if (account.inboundAuth === "none") {
    return true;
  }
  if (!account.inboundToken) {
    return false;
  }
  return safeEqualToken(readExternalHeader(req, account.inboundTokenHeader), account.inboundToken);
}

function normalizedAllowlist(values: Array<string | number>): Set<string> {
  return new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean));
}

function matchesAllowlist(value: string, allowFrom: Array<string | number>): boolean {
  const allowlist = normalizedAllowlist(allowFrom);
  return allowlist.has("*") || allowlist.has(value.trim().toLowerCase());
}

function resolveGroupConfig(account: ResolvedExternalAccount, conversationId: string) {
  return account.groups[conversationId] ?? account.groups["*"];
}

export function isExternalInboundMessageAllowed(
  account: ResolvedExternalAccount,
  message: ExternalInboundMessage,
): boolean {
  if (message.chatType === "direct") {
    if (account.dmPolicy === "disabled") {
      return false;
    }
    if (account.dmPolicy === "open") {
      return true;
    }
    return matchesAllowlist(message.senderId, account.allowFrom);
  }

  if (account.groupPolicy === "disabled") {
    return false;
  }
  const groupConfig = resolveGroupConfig(account, message.conversationId);
  if (groupConfig?.enabled === false) {
    return false;
  }
  if (account.groupPolicy === "allowlist" && !groupConfig) {
    return false;
  }
  if (groupConfig?.requireMention && message.wasMentioned !== true) {
    return false;
  }
  if (groupConfig?.allowFrom) {
    return matchesAllowlist(message.senderId, groupConfig.allowFrom);
  }
  if (account.groupAllowFrom.length > 0) {
    return matchesAllowlist(message.senderId, account.groupAllowFrom);
  }
  return true;
}
