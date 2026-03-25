import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });
});

describe("FeishuStreamingSession.start", () => {
  const releaseMock = vi.fn();
  const messageCreateMock = vi.fn();
  const messageReplyMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            code: 0,
            tenant_access_token: "tenant-token",
            expire: 7200,
          }),
        },
        release: releaseMock,
      })
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            code: 0,
            data: { card_id: "card_1" },
          }),
        },
        release: releaseMock,
      });

    messageCreateMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_new" },
    });
    messageReplyMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_reply" },
    });
  });

  it("drops blank root and reply targets before send routing", async () => {
    const session = new FeishuStreamingSession(
      {
        im: {
          message: {
            create: messageCreateMock,
            reply: messageReplyMock,
          },
        },
      } as never,
      { appId: "app", appSecret: "secret", domain: "feishu" },
    );

    await session.start("ou_target", "open_id", {
      rootId: "   ",
      replyToMessageId: "   ",
      replyInThread: true,
    });

    expect(messageReplyMock).not.toHaveBeenCalled();
    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: "open_id" },
        data: expect.objectContaining({
          receive_id: "ou_target",
          msg_type: "interactive",
        }),
      }),
    );
  });
});
