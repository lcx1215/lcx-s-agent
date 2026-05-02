import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const listMessagesFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  listMessagesFeishu: listMessagesFeishuMock,
}));

import { feishuPlugin } from "./channel.js";

describe("feishuPlugin.status.probeAccount", () => {
  it("uses current account credentials for multi-account config", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = feishuPlugin.config.resolveAccount(cfg, "main");
    probeFeishuMock.mockResolvedValueOnce({ ok: true, appId: "cli_main" });

    const result = await feishuPlugin.status?.probeAccount?.({
      account,
      timeoutMs: 1_000,
      cfg,
    });

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(probeFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        appId: "cli_main",
        appSecret: "secret_main",
      }),
    );
    expect(result).toMatchObject({ ok: true, appId: "cli_main" });
  });
});

describe("feishuPlugin.actions", () => {
  it("advertises read when a configured account exists", () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: "cli_default",
          appSecret: "secret_default",
        },
      },
    } as OpenClawConfig;

    expect(feishuPlugin.actions?.listActions?.({ cfg })).toContain("read");
  });

  it("reads recent messages for chat targets only", async () => {
    listMessagesFeishuMock.mockResolvedValueOnce([
      {
        messageId: "om_reply",
        chatId: "oc_live",
        authorTag: "user:ou_operator",
        timestamp: "2026-04-12T08:00:00.000Z",
        content: "latest acceptance reply",
      },
    ]);

    const result = await feishuPlugin.actions?.handleAction?.({
      channel: "feishu",
      action: "read",
      cfg: {
        channels: {
          feishu: {
            enabled: true,
            appId: "cli_default",
            appSecret: "secret_default",
          },
        },
      } as OpenClawConfig,
      params: {
        to: "chat:oc_live",
        limit: 3,
      },
      accountId: "default",
    });

    expect(listMessagesFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "oc_live",
        accountId: "default",
        limit: 3,
      }),
    );
    const payload = {
      messages: [
        {
          id: "om_reply",
          messageId: "om_reply",
          chatId: "oc_live",
          rootId: undefined,
          parentId: undefined,
          threadId: undefined,
          authorTag: "user:ou_operator",
          timestamp: "2026-04-12T08:00:00.000Z",
          content: "latest acceptance reply",
          text: "latest acceptance reply",
        },
      ],
    };
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    });
  });

  it("rejects non-chat Feishu targets for message read", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        channel: "feishu",
        action: "read",
        cfg: {
          channels: {
            feishu: {
              enabled: true,
              appId: "cli_default",
              appSecret: "secret_default",
            },
          },
        } as OpenClawConfig,
        params: {
          to: "user:ou_operator",
        },
        accountId: "default",
      }),
    ).rejects.toThrow(/requires a chat target/);
  });
});
