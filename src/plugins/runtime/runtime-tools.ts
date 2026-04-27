import { createAiderTool } from "../../agents/tools/aider-tool.js";
import { createMemoryGetTool, createMemorySearchTool } from "../../agents/tools/memory-tool.js";
import { createMcpContextTool } from "../../agents/tools/mcp-context-tool.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeTools(): PluginRuntime["tools"] {
  return {
    createAiderTool,
    createMemoryGetTool,
    createMcpContextTool,
    createMemorySearchTool,
    registerMemoryCli,
  };
}
