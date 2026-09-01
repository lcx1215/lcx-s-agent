import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createMSTeamsTestPluginBase,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import {
  normalizeMessageChannel,
  normalizeMessageChannelFamilyAlias,
  resolveGatewayMessageChannel,
} from "./message-channel.js";

const emptyRegistry = createTestRegistry([]);
const msteamsPlugin: ChannelPlugin = {
  ...createMSTeamsTestPluginBase(),
};
const externalBase = createChannelTestPluginBase({ id: "external", label: "External" });
const externalPlugin: ChannelPlugin = {
  ...externalBase,
  meta: {
    ...externalBase.meta,
    aliases: ["http-json"],
  },
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

  it("normalizes external channel labels to the plugin id", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "external", plugin: externalPlugin, source: "test" }]),
    );
    expect(normalizeMessageChannelFamilyAlias("external")).toBe("external");
    expect(normalizeMessageChannelFamilyAlias("EXTERNAL:dm:recipient")).toBe("external");
    expect(normalizeMessageChannelFamilyAlias("http-json:group:room")).toBe("external");
  });

  it("keeps external labels normalized even before plugin registration", () => {
    expect(normalizeMessageChannel("EXTERNAL:dm:recipient")).toBe("external");
  });
});
