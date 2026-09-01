import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  normalizeReplyRouteProviderAlias,
  resolveReplyRouteChannel,
} from "./reply-routing-helpers.js";

const registryWithExternal = createTestRegistry([
  {
    pluginId: "external",
    source: "test",
    plugin: createOutboundTestPlugin({
      id: "external",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "external", messageId: "ok" }),
        sendMedia: async () => ({ channel: "external", messageId: "ok" }),
      },
      label: "External",
    }),
  },
]);

const emptyRegistry = createTestRegistry([]);

beforeEach(() => {
  setActivePluginRegistry(registryWithExternal);
});

afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

describe("reply routing helpers", () => {
  it("normalizes an external channel label without requiring registration", () => {
    expect(normalizeReplyRouteProviderAlias("external")).toBe("external");
    setActivePluginRegistry(emptyRegistry);

    expect(resolveReplyRouteChannel("external")).toBeUndefined();
    expect(resolveReplyRouteChannel("external:dm:recipient")).toBeUndefined();
  });

  it("resolves a registered external channel for direct and structured targets", () => {
    expect(resolveReplyRouteChannel("external")).toBe("external");
    expect(resolveReplyRouteChannel("external:dm:recipient")).toBe("external");
    expect(resolveReplyRouteChannel("external:group:room")).toBe("external");
  });

  it("normalizes a registered alias through the plugin registry", () => {
    const plugin = registryWithExternal.channels[0]?.plugin as { meta?: { aliases?: string[] } };
    plugin.meta = { ...plugin.meta, aliases: ["http-json"] };
    expect(normalizeReplyRouteProviderAlias("http-json:dm:recipient")).toBe("external");
    expect(resolveReplyRouteChannel("http-json:dm:recipient")).toBe("external");
  });

  it("falls back unknown alias to normalized segment", () => {
    expect(normalizeReplyRouteProviderAlias("telegram:dm:123")).toBe("telegram");
    expect(resolveReplyRouteChannel("telegram:dm:123")).toBe("telegram");
  });

  it("returns undefined for internal channel marker", () => {
    expect(normalizeReplyRouteProviderAlias("webchat")).toBeUndefined();
    expect(resolveReplyRouteChannel("webchat")).toBeUndefined();
  });
});
