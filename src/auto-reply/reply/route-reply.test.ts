import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordOutbound } from "../../channels/plugins/outbound/discord.js";
import { imessageOutbound } from "../../channels/plugins/outbound/imessage.js";
import { signalOutbound } from "../../channels/plugins/outbound/signal.js";
import { slackOutbound } from "../../channels/plugins/outbound/slack.js";
import { telegramOutbound } from "../../channels/plugins/outbound/telegram.js";
import { whatsappOutbound } from "../../channels/plugins/outbound/whatsapp.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createIMessageTestPlugin } from "../../test-utils/imessage-test-plugin.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

const mocks = vi.hoisted(() => ({
  sendMessageExternal: vi.fn(async (_params: unknown) => ({ messageId: "f1" })),
  sendMessageDiscord: vi.fn(async () => ({ messageId: "m1", channelId: "c1" })),
  sendMessageIMessage: vi.fn(async () => ({ messageId: "ok" })),
  sendMessageMSTeams: vi.fn(async (_params: unknown) => ({
    messageId: "m1",
    conversationId: "c1",
  })),
  sendMessageSignal: vi.fn(async () => ({ messageId: "t1" })),
  sendMessageSlack: vi.fn(async () => ({ messageId: "m1", channelId: "c1" })),
  sendMessageTelegram: vi.fn(async () => ({ messageId: "m1", chatId: "c1" })),
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "m1", toJid: "jid" })),
  deliverOutboundPayloads: vi.fn(),
}));

vi.mock("../../discord/send.js", () => ({
  sendMessageDiscord: mocks.sendMessageDiscord,
}));
vi.mock("../../imessage/send.js", () => ({
  sendMessageIMessage: mocks.sendMessageIMessage,
}));
vi.mock("../../signal/send.js", () => ({
  sendMessageSignal: mocks.sendMessageSignal,
}));
vi.mock("../../slack/send.js", () => ({
  sendMessageSlack: mocks.sendMessageSlack,
}));
vi.mock("../../telegram/send.js", () => ({
  sendMessageTelegram: mocks.sendMessageTelegram,
}));
vi.mock("../../web/outbound.js", () => ({
  sendMessageWhatsApp: mocks.sendMessageWhatsApp,
  sendPollWhatsApp: mocks.sendMessageWhatsApp,
}));
vi.mock("../../infra/outbound/deliver.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/outbound/deliver.js")>(
    "../../infra/outbound/deliver.js",
  );
  return {
    ...actual,
    deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  };
});
const actualDeliver = await vi.importActual<typeof import("../../infra/outbound/deliver.js")>(
  "../../infra/outbound/deliver.js",
);

const { isRoutableChannel, routeReply } = await import("./route-reply.js");

const createRegistry = (channels: PluginRegistry["channels"]): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  commands: [],
  channels,
  providers: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  diagnostics: [],
});

const createMSTeamsOutbound = (): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text }) => {
    const result = await mocks.sendMessageMSTeams({ cfg, to, text });
    return { channel: "msteams", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl }) => {
    const result = await mocks.sendMessageMSTeams({ cfg, to, text, mediaUrl });
    return { channel: "msteams", ...result };
  },
});

const createExternalOutbound = (): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text }) => {
    const result = await mocks.sendMessageExternal({ cfg, to, text });
    return { channel: "external", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl }) => {
    const result = await mocks.sendMessageExternal({ cfg, to, text, mediaUrl });
    return { channel: "external", ...result };
  },
});

const createMSTeamsPlugin = (params: { outbound: ChannelOutboundAdapter }): ChannelPlugin => ({
  id: "msteams",
  meta: {
    id: "msteams",
    label: "Microsoft Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
    docsPath: "/channels/msteams",
    aliases: ["teams"],
    blurb: "Bot Framework; enterprise support.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  outbound: params.outbound,
});

describe("routeReply", () => {
  beforeEach(() => {
    setActivePluginRegistry(defaultRegistry);
    mocks.deliverOutboundPayloads.mockImplementation(actualDeliver.deliverOutboundPayloads);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("skips sends when abort signal is already aborted", async () => {
    mocks.sendMessageSlack.mockClear();
    const controller = new AbortController();
    controller.abort();
    const res = await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
      abortSignal: controller.signal,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("aborted");
    expect(mocks.sendMessageSlack).not.toHaveBeenCalled();
  });

  it("no-ops on empty payload", async () => {
    mocks.sendMessageSlack.mockClear();
    const res = await routeReply({
      payload: {},
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(res.ok).toBe(true);
    expect(mocks.sendMessageSlack).not.toHaveBeenCalled();
  });

  it("suppresses reasoning payloads", async () => {
    mocks.sendMessageSlack.mockClear();
    const res = await routeReply({
      payload: { text: "Reasoning:\n_step_", isReasoning: true },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(res.ok).toBe(true);
    expect(mocks.sendMessageSlack).not.toHaveBeenCalled();
  });

  it("drops silent token payloads", async () => {
    mocks.sendMessageSlack.mockClear();
    const res = await routeReply({
      payload: { text: SILENT_REPLY_TOKEN },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(res.ok).toBe(true);
    expect(mocks.sendMessageSlack).not.toHaveBeenCalled();
  });

  it("does not drop payloads that merely start with the silent token", async () => {
    mocks.sendMessageSlack.mockClear();
    const res = await routeReply({
      payload: { text: `${SILENT_REPLY_TOKEN} -- (why am I here?)` },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(res.ok).toBe(true);
    expect(mocks.sendMessageSlack).toHaveBeenCalledWith(
      "channel:C123",
      `${SILENT_REPLY_TOKEN} -- (why am I here?)`,
      expect.any(Object),
    );
  });

  it("applies responsePrefix when routing", async () => {
    mocks.sendMessageSlack.mockClear();
    const cfg = {
      messages: { responsePrefix: "[openclaw]" },
    } as unknown as OpenClawConfig;
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      cfg,
    });
    expect(mocks.sendMessageSlack).toHaveBeenCalledWith(
      "channel:C123",
      "[openclaw] hi",
      expect.any(Object),
    );
  });

  it("does not derive responsePrefix from agent identity when routing", async () => {
    mocks.sendMessageSlack.mockClear();
    const cfg = {
      agents: {
        list: [
          {
            id: "rich",
            identity: { name: "Richbot", theme: "lion bot", emoji: "🦁" },
          },
        ],
      },
      messages: {},
    } as unknown as OpenClawConfig;
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      sessionKey: "agent:rich:main",
      cfg,
    });
    expect(mocks.sendMessageSlack).toHaveBeenCalledWith("channel:C123", "hi", expect.any(Object));
  });

  it("uses threadId for Slack when replyToId is missing", async () => {
    mocks.sendMessageSlack.mockClear();
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      threadId: "456.789",
      cfg: {} as never,
    });
    expect(mocks.sendMessageSlack).toHaveBeenCalledWith(
      "channel:C123",
      "hi",
      expect.objectContaining({ threadTs: "456.789" }),
    );
  });

  it("passes thread id to Telegram sends", async () => {
    mocks.sendMessageTelegram.mockClear();
    await routeReply({
      payload: { text: "hi" },
      channel: "telegram",
      to: "telegram:123",
      threadId: 42,
      cfg: {} as never,
    });
    expect(mocks.sendMessageTelegram).toHaveBeenCalledWith(
      "telegram:123",
      "hi",
      expect.objectContaining({ messageThreadId: 42 }),
    );
  });

  it("passes replyToId to Telegram sends", async () => {
    mocks.sendMessageTelegram.mockClear();
    await routeReply({
      payload: { text: "hi", replyToId: "123" },
      channel: "telegram",
      to: "telegram:123",
      cfg: {} as never,
    });
    expect(mocks.sendMessageTelegram).toHaveBeenCalledWith(
      "telegram:123",
      "hi",
      expect.objectContaining({ replyToMessageId: 123 }),
    );
  });

  it("uses replyToId as threadTs for Slack", async () => {
    mocks.sendMessageSlack.mockClear();
    await routeReply({
      payload: { text: "hi", replyToId: "1710000000.0001" },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(mocks.sendMessageSlack).toHaveBeenCalledWith(
      "channel:C123",
      "hi",
      expect.objectContaining({ threadTs: "1710000000.0001" }),
    );
  });

  it("uses threadId as threadTs for Slack when replyToId is missing", async () => {
    mocks.sendMessageSlack.mockClear();
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      threadId: "1710000000.9999",
      cfg: {} as never,
    });
    expect(mocks.sendMessageSlack).toHaveBeenCalledWith(
      "channel:C123",
      "hi",
      expect.objectContaining({ threadTs: "1710000000.9999" }),
    );
  });

  it("sends multiple mediaUrls (caption only on first)", async () => {
    mocks.sendMessageSlack.mockClear();
    await routeReply({
      payload: { text: "caption", mediaUrls: ["a", "b"] },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(mocks.sendMessageSlack).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessageSlack).toHaveBeenNthCalledWith(
      1,
      "channel:C123",
      "caption",
      expect.objectContaining({ mediaUrl: "a" }),
    );
    expect(mocks.sendMessageSlack).toHaveBeenNthCalledWith(
      2,
      "channel:C123",
      "",
      expect.objectContaining({ mediaUrl: "b" }),
    );
  });

  it("routes WhatsApp via outbound sender (accountId honored)", async () => {
    mocks.sendMessageWhatsApp.mockClear();
    await routeReply({
      payload: { text: "hi" },
      channel: "whatsapp",
      to: "+15551234567",
      accountId: "acc-1",
      cfg: {} as never,
    });
    expect(mocks.sendMessageWhatsApp).toHaveBeenCalledWith(
      "+15551234567",
      "hi",
      expect.objectContaining({ accountId: "acc-1", verbose: false }),
    );
  });

  it("routes MS Teams via proactive sender", async () => {
    mocks.sendMessageMSTeams.mockClear();
    setActivePluginRegistry(
      createRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: createMSTeamsPlugin({
            outbound: createMSTeamsOutbound(),
          }),
        },
      ]),
    );
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
        },
      },
    } as unknown as OpenClawConfig;
    await routeReply({
      payload: { text: "hi" },
      channel: "msteams",
      to: "conversation:19:abc@thread.tacv2",
      cfg,
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        to: "conversation:19:abc@thread.tacv2",
        text: "hi",
      }),
    );
  });

  it("routes Teams legacy alias to msteams plugin", async () => {
    mocks.sendMessageMSTeams.mockClear();
    const cfg = {
      channels: {
        msteams: { enabled: true },
      },
    } as unknown as OpenClawConfig;
    await routeReply({
      payload: { text: "hi" },
      channel: "teams",
      to: "conversation:19:abc@thread.tacv2",
      cfg,
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        to: "conversation:19:abc@thread.tacv2",
        text: "hi",
      }),
    );
    expect(isRoutableChannel("teams")).toBe(true);
  });

  it("maps external channel label to external routing target", async () => {
    setActivePluginRegistry(
      createRegistry([
        {
          pluginId: "external",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "external",
            outbound: createExternalOutbound(),
            label: "External",
          }),
        },
      ]),
    );
    const cfg = {
      channels: {
        external: { enabled: true },
      },
    } as unknown as OpenClawConfig;

    mocks.sendMessageExternal.mockClear();
    const result = await routeReply({
      payload: { text: "hi" },
      channel: "external" as never,
      to: "ou_xyz",
      cfg,
    });

    expect(result.ok).toBe(true);
    expect(isRoutableChannel("external")).toBe(true);
    expect(mocks.sendMessageExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        to: "ou_xyz",
        text: "hi",
      }),
    );
  });

  it("maps external chain label channel to external routing target", async () => {
    setActivePluginRegistry(
      createRegistry([
        {
          pluginId: "external",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "external",
            outbound: createExternalOutbound(),
            label: "External",
          }),
        },
      ]),
    );
    const cfg = {
      channels: {
        external: { enabled: true },
      },
    } as unknown as OpenClawConfig;

    mocks.sendMessageExternal.mockClear();
    const result = await routeReply({
      payload: { text: "hi" },
      channel: "external:dm:ou_xyz" as never,
      to: "ou_xyz",
      cfg,
    });

    expect(result.ok).toBe(true);
    expect(isRoutableChannel("external:dm:ou_xyz" as never)).toBe(true);
    expect(mocks.sendMessageExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        to: "ou_xyz",
        text: "hi",
      }),
    );
  });

  it("applies external family responsePrefix for external chain channel", async () => {
    setActivePluginRegistry(
      createRegistry([
        {
          pluginId: "external",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "external",
            outbound: createExternalOutbound(),
            label: "External",
          }),
        },
      ]),
    );
    const cfg = {
      messages: {
        responsePrefix: "[global] ",
      },
      channels: {
        external: {
          responsePrefix: "[external] ",
        },
      },
    } as unknown as OpenClawConfig;

    mocks.sendMessageExternal.mockClear();
    const result = await routeReply({
      payload: { text: "hi" },
      channel: "external:dm:ou_xyz" as never,
      to: "ou_xyz",
      cfg,
    });

    expect(result.ok).toBe(true);
    expect(mocks.sendMessageExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        to: "ou_xyz",
        text: "[external] hi",
      }),
    );
  });

  it("fails cleanly for external family routing when external outbound is missing", async () => {
    mocks.sendMessageExternal.mockClear();
    const cfg = {
      channels: {},
    } as unknown as OpenClawConfig;

    const result = await routeReply({
      payload: { text: "hi" },
      channel: "external" as never,
      to: "ou_xyz",
      cfg,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Failed to route reply to external: Outbound not configured for channel: external",
    );
    expect(isRoutableChannel("external")).toBe(true);
    expect(mocks.sendMessageExternal).not.toHaveBeenCalled();
  });

  it("does not mark unknown channels as routable", async () => {
    expect(isRoutableChannel("random-unknown" as never)).toBe(false);
  });

  it("passes mirror data when sessionKey is set", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      sessionKey: "agent:main:main",
      isGroup: true,
      groupId: "channel:C123",
      cfg: {} as never,
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
          text: "hi",
          isGroup: true,
          groupId: "channel:C123",
        }),
      }),
    );
  });

  it("skips mirror data when mirror is false", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      sessionKey: "agent:main:main",
      mirror: false,
      cfg: {} as never,
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: undefined,
      }),
    );
  });
});

const emptyRegistry = createRegistry([]);
const defaultRegistry = createTestRegistry([
  {
    pluginId: "discord",
    plugin: createOutboundTestPlugin({
      id: "discord",
      outbound: discordOutbound,
      label: "Discord",
    }),
    source: "test",
  },
  {
    pluginId: "slack",
    plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound, label: "Slack" }),
    source: "test",
  },
  {
    pluginId: "telegram",
    plugin: createOutboundTestPlugin({
      id: "telegram",
      outbound: telegramOutbound,
      label: "Telegram",
    }),
    source: "test",
  },
  {
    pluginId: "whatsapp",
    plugin: createOutboundTestPlugin({
      id: "whatsapp",
      outbound: whatsappOutbound,
      label: "WhatsApp",
    }),
    source: "test",
  },
  {
    pluginId: "signal",
    plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutbound, label: "Signal" }),
    source: "test",
  },
  {
    pluginId: "imessage",
    plugin: createIMessageTestPlugin({ outbound: imessageOutbound }),
    source: "test",
  },
  {
    pluginId: "msteams",
    plugin: createMSTeamsPlugin({
      outbound: createMSTeamsOutbound(),
    }),
    source: "test",
  },
]);
