import type { OpenClawPluginApi } from "lcx-agent/plugin-sdk/core";
import { emptyPluginConfigSchema } from "lcx-agent/plugin-sdk/core";

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    // Read-only recall over the archived session transcript store. Registered
    // independently of memory search: the archive is a separate store, so it
    // stays available even when the memory index is disabled.
    api.registerTool(
      (ctx) => [
        api.runtime.tools.createSessionHistoryTool({
          agentId: ctx.agentId,
        }),
      ],
      { names: ["session_history"] },
    );

    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
};

export default memoryCorePlugin;
