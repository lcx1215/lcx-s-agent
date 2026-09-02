import { describe, expect, it } from "vitest";
import { normalizeExternalInboundMessage, normalizeExternalTarget } from "./protocol.js";

describe("external message protocol", () => {
  it("normalizes the canonical nested payload", () => {
    const result = normalizeExternalInboundMessage({
      id: "msg-1",
      text: "hello",
      sender: { id: "user-1", name: "Ada", username: "ada" },
      conversation: { id: "conversation-1", type: "group", label: "Support" },
      timestamp: 1_700_000_000,
      threadId: "thread-1",
      wasMentioned: true,
      metadata: { source: "test" },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        messageId: "msg-1",
        text: "hello",
        senderId: "user-1",
        senderName: "Ada",
        senderUsername: "ada",
        conversationId: "conversation-1",
        conversationLabel: "Support",
        chatType: "group",
        timestamp: 1_700_000_000_000,
        threadId: "thread-1",
        wasMentioned: true,
        metadata: { source: "test" },
      },
    });
  });

  it("accepts common flat aliases and makes missing IDs stable", () => {
    const input = {
      message: "hello",
      senderId: "user-1",
      chatId: "conversation-1",
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const first = normalizeExternalInboundMessage(input);
    const second = normalizeExternalInboundMessage(input);

    expect(first).toEqual(second);
    expect(first.ok && first.value.chatType).toBe("direct");
    expect(first.ok && first.value.messageId).toMatch(/^external-[0-9a-f]{32}$/);
  });

  it("rejects messages without a stable sender, conversation, or text", () => {
    expect(normalizeExternalInboundMessage({ text: "hello" })).toEqual({
      ok: false,
      error: "payload.senderId or payload.sender.id is required",
    });
    expect(normalizeExternalInboundMessage({ text: "hello", senderId: "user-1" })).toEqual({
      ok: false,
      error: "payload.conversationId or payload.conversation.id is required",
    });
    expect(
      normalizeExternalInboundMessage({ senderId: "user-1", conversationId: "conversation-1" }),
    ).toEqual({ ok: false, error: "payload.text is required" });
  });

  it("normalizes explicit external targets", () => {
    expect(normalizeExternalTarget(" external:conversation-1 ")).toBe("conversation-1");
    expect(normalizeExternalTarget(" ")).toBeUndefined();
  });
});
