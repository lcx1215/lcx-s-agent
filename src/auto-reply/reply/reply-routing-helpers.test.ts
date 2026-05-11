import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  isFeishuFamilyChannel,
  normalizeReplyRouteProviderAlias,
  resolveReplyRouteChannel,
} from "./reply-routing-helpers.js";

const registryWithFeishu = createTestRegistry([
  {
    pluginId: "feishu",
    source: "test",
    plugin: createOutboundTestPlugin({
      id: "feishu",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "feishu", messageId: "ok" }),
        sendMedia: async () => ({ channel: "feishu", messageId: "ok" }),
      },
      label: "Feishu",
    }),
  },
]);

const emptyRegistry = createTestRegistry([]);

beforeEach(() => {
  setActivePluginRegistry(registryWithFeishu);
});

afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

describe("reply routing helpers", () => {
  it("does not require plugin registration for feishu-family routing classification", () => {
    expect(normalizeReplyRouteProviderAlias("lark")).toBe("feishu");
    setActivePluginRegistry(emptyRegistry);

    expect(resolveReplyRouteChannel("lark")).toBe("feishu");
    expect(resolveReplyRouteChannel("lark:dm:ou_xyz")).toBe("feishu");
    expect(isFeishuFamilyChannel("lark")).toBe(true);
    expect(isFeishuFamilyChannel("lark:group:oc_123")).toBe(true);
    expect(resolveReplyRouteChannel("feishu")).toBe("feishu");
    expect(resolveReplyRouteChannel("feishu:dm:ou_123")).toBe("feishu");
  });

  it("maps lark family aliases to feishu", () => {
    expect(normalizeReplyRouteProviderAlias("lark")).toBe("feishu");
    expect(normalizeReplyRouteProviderAlias("LARK")).toBe("feishu");
    expect(normalizeReplyRouteProviderAlias("lark:dm:ou_123")).toBe("feishu");
    expect(normalizeReplyRouteProviderAlias("lark:user:ou_123")).toBe("feishu");
    expect(normalizeReplyRouteProviderAlias("lark:group:oc_123")).toBe("feishu");
  });

  it("normalizes feishu directly", () => {
    expect(normalizeReplyRouteProviderAlias("feishu")).toBe("feishu");
    expect(normalizeReplyRouteProviderAlias("feishu:dm:ou_123")).toBe("feishu");
  });

  it("falls back unknown alias to normalized segment", () => {
    expect(normalizeReplyRouteProviderAlias("telegram:dm:123")).toBe("telegram");
    expect(resolveReplyRouteChannel("telegram:dm:123")).toBe("telegram");
  });

  it("resolves lark chain labels to feishu routing", () => {
    expect(resolveReplyRouteChannel("lark:dm:ou_xyz")).toBe("feishu");
    expect(resolveReplyRouteChannel("lark:user:ou_xyz")).toBe("feishu");
  });

  it("treats feishu family channels as true", () => {
    expect(isFeishuFamilyChannel("lark")).toBe(true);
    expect(isFeishuFamilyChannel("Lark")).toBe(true);
    expect(isFeishuFamilyChannel("lark:dm:ou_xyz")).toBe(true);
    expect(isFeishuFamilyChannel("lark:user:ou_xyz")).toBe(true);
    expect(isFeishuFamilyChannel("feishu")).toBe(true);
    expect(isFeishuFamilyChannel("feishu:dm:ou_xyz")).toBe(true);
    expect(isFeishuFamilyChannel("webchat")).toBe(false);
    expect(isFeishuFamilyChannel("telegram")).toBe(false);
    expect(isFeishuFamilyChannel("telegram:dm:123")).toBe(false);
  });

  it("returns undefined for internal channel marker", () => {
    expect(normalizeReplyRouteProviderAlias("webchat")).toBeUndefined();
    expect(resolveReplyRouteChannel("webchat")).toBeUndefined();
    expect(isFeishuFamilyChannel("webchat")).toBe(false);
  });
});
