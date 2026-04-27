import type { PluginRuntime } from "openclaw/plugin-sdk";
import { getFeishuRuntime, setFeishuRuntime } from "../../../extensions/feishu/src/runtime.js";
import { listMessagesFeishu, sendMessageFeishu } from "../../../extensions/feishu/src/send.js";

export { listMessagesFeishu, sendMessageFeishu };

export function ensureFeishuProbeRuntime(): void {
  try {
    getFeishuRuntime();
    return;
  } catch {}

  setFeishuRuntime({
    channel: {
      text: {
        resolveMarkdownTableMode: () => "raw",
        convertMarkdownTables: (text: string) => text,
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime);
}
