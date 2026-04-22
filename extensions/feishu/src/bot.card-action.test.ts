import { describe, it, expect, vi } from "vitest";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";

// Mock resolveFeishuAccount
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));

// Mock bot.js to verify handleFeishuMessage call
vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));

vi.mock("./send.js", () => ({
  getMessageFeishu: vi.fn(),
}));

import { handleFeishuMessage } from "./bot.js";
import { getMessageFeishu } from "./send.js";

describe("Feishu Card Action Handler", () => {
  const cfg = {} as any; // Minimal mock
  const runtime = { log: vi.fn(), error: vi.fn() } as any;

  it("handles card action with text payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok1",
      action: { value: { text: "/ping" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/ping"}',
            message_id: "card-action-tok1",
            chat_id: "chat1",
          }),
        }),
      }),
    );
  });

  it("handles card action with JSON object payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok2",
      action: { value: { key: "val" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"{\\"key\\":\\"val\\"}"}',
            message_id: "card-action-tok2",
            chat_id: "u123", // Fallback to open_id
          }),
        }),
      }),
    );
  });

  it("uses the official open_message_id and resolves chat_id from the source message", async () => {
    vi.mocked(getMessageFeishu).mockResolvedValueOnce({
      messageId: "om_open_msg_1",
      chatId: "chat_from_message",
      messageType: "interactive",
      content: "source card",
      createTime: undefined,
      senderId: undefined,
      senderType: undefined,
    });

    const event: FeishuCardActionEvent = {
      open_id: "ou_card_actor",
      user_id: "uid-card",
      union_id: "un-card",
      open_message_id: "om_open_msg_1",
      token: "tok3",
      action: { value: { text: "/help" }, tag: "button" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(getMessageFeishu).toHaveBeenCalledWith({
      cfg,
      messageId: "om_open_msg_1",
      accountId: undefined,
    });
    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            message_id: "om_open_msg_1",
            content: '{"text":"/help"}',
            chat_id: "chat_from_message",
            chat_type: "group",
          }),
        }),
      }),
    );
  });

  it("uses nested context target fields for real card callbacks", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "ou_real_actor", user_id: "uid-real", union_id: "un-real" },
      token: "tok4",
      action: { value: { text: "/help", marker: "cb-oldfmt" }, tag: "button" },
      context: {
        open_message_id: "om_nested_ctx_1",
        open_chat_id: "oc_group_from_context",
      },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            message_id: "om_nested_ctx_1",
            content: '{"text":"/help"}',
            chat_id: "oc_group_from_context",
            chat_type: "group",
          }),
        }),
      }),
    );
    expect(getMessageFeishu).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "om_nested_ctx_1" }),
    );
  });
});
