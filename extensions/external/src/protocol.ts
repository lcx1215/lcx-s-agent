import { createHash } from "node:crypto";
import type { ExternalChatType, ExternalInboundMessage } from "./types.js";

export type ExternalProtocolParseResult =
  | { ok: true; value: ExternalInboundMessage }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const record = asRecord(value);
    if (record) {
      return record;
    }
  }
  return undefined;
}

function normalizeChatType(value: unknown): ExternalChatType {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "group") {
    return "group";
  }
  if (normalized === "channel") {
    return "channel";
  }
  return "direct";
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function fallbackMessageId(params: {
  senderId: string;
  conversationId: string;
  timestamp: number;
  text: string;
}): string {
  return `external-${createHash("sha256")
    .update(`${params.senderId}\n${params.conversationId}\n${params.timestamp}\n${params.text}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function unwrapPayload(raw: unknown): Record<string, unknown> | null {
  const root = asRecord(raw);
  if (!root) {
    return null;
  }
  const nested = firstRecord(root.payload, root.event, root.data);
  return nested && !firstString(root.text, root.message, root.content) ? nested : root;
}

export function normalizeExternalInboundMessage(raw: unknown): ExternalProtocolParseResult {
  const record = unwrapPayload(raw);
  if (!record) {
    return { ok: false, error: "payload must be a JSON object" };
  }

  const sender = firstRecord(record.sender, record.user, record.author);
  const conversation = firstRecord(record.conversation, record.chat, record.room);
  const text = firstString(record.text, record.message, record.content);
  const senderId = firstString(
    sender?.id,
    sender?.userId,
    sender?.identifier,
    record.senderId,
    record.userId,
    record.from,
    record.user,
  );
  const conversationId = firstString(
    conversation?.id,
    conversation?.conversationId,
    conversation?.chatId,
    conversation?.channelId,
    record.conversationId,
    record.chatId,
    record.channelId,
    record.to,
  );

  if (!text) {
    return { ok: false, error: "payload.text is required" };
  }
  if (!senderId) {
    return { ok: false, error: "payload.senderId or payload.sender.id is required" };
  }
  if (!conversationId) {
    return {
      ok: false,
      error: "payload.conversationId or payload.conversation.id is required",
    };
  }

  const timestamp = normalizeTimestamp(
    record.timestamp ?? record.createdAt ?? record.created_at ?? record.eventTime,
  );
  const messageId =
    firstString(record.messageId, record.id, record.eventId, record.event_id) ??
    fallbackMessageId({ senderId, conversationId, timestamp, text });
  const metadata = asRecord(record.metadata);
  const replyToId = firstString(record.replyToId, record.reply_to_id, record.replyTo);
  const threadId = firstString(record.threadId, record.thread_id, conversation?.threadId);
  const conversationLabel = firstString(
    conversation?.label,
    conversation?.name,
    record.conversationLabel,
    record.chatName,
  );
  const senderName = firstString(sender?.name, sender?.displayName, record.senderName);
  const senderUsername = firstString(sender?.username, sender?.handle, record.senderUsername);

  return {
    ok: true,
    value: {
      messageId,
      text,
      senderId,
      senderName,
      senderUsername,
      conversationId,
      conversationLabel,
      chatType: normalizeChatType(conversation?.type ?? record.chatType ?? record.type),
      timestamp,
      replyToId,
      threadId,
      wasMentioned: typeof record.wasMentioned === "boolean" ? record.wasMentioned : undefined,
      metadata: metadata ?? undefined,
    },
  };
}

export function normalizeExternalTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^external:/i, "").trim() || undefined;
}
