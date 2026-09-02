import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { externalChannelPlugin } from "./src/channel.js";

const plugin = {
  id: "external",
  name: "External",
  description: "Vendor-neutral HTTP JSON message channel",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: externalChannelPlugin });
  },
};

export default plugin;
