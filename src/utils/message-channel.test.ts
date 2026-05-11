import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createMSTeamsTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  normalizeMessageChannel,
  normalizeMessageChannelFamilyAlias,
  resolveGatewayMessageChannel,
} from "./message-channel.js";

const emptyRegistry = createTestRegistry([]);
const msteamsPlugin: ChannelPlugin = {
  ...createMSTeamsTestPluginBase(),
};

describe("message-channel", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("normalizes gateway message channels and rejects unknown values", () => {
    expect(resolveGatewayMessageChannel("discord")).toBe("discord");
    expect(resolveGatewayMessageChannel(" imsg ")).toBe("imessage");
    expect(resolveGatewayMessageChannel("web")).toBeUndefined();
    expect(resolveGatewayMessageChannel("nope")).toBeUndefined();
  });

  it("normalizes plugin aliases when registered", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "msteams", plugin: msteamsPlugin, source: "test" }]),
    );
    expect(resolveGatewayMessageChannel("teams")).toBe("msteams");
  });

  it("normalizes lark chain labels to feishu family", () => {
    expect(normalizeMessageChannelFamilyAlias("lark")).toBe("feishu");
    expect(normalizeMessageChannelFamilyAlias("LARK:dm:ou_123")).toBe("feishu");
    expect(normalizeMessageChannelFamilyAlias("lark:group:oc_456")).toBe("feishu");
    expect(normalizeMessageChannelFamilyAlias("feishu:dm:ou_123")).toBe("feishu");
  });

  it("normalizes lark and feishu chain labels without plugin registry", () => {
    expect(normalizeMessageChannel("LARK:dm:ou_123")).toBe("feishu");
    expect(normalizeMessageChannel("feishu:dm:ou_123")).toBe("feishu");
  });
});
