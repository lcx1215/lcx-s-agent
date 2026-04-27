import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tools-mcp-aider-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("createOpenClawTools MCP/aider registration", () => {
  it("includes mcp_context and aider tools", async () => {
    await withTempAgentDir(async (agentDir) => {
      const tools = createOpenClawTools({ agentDir });
      expect(tools.some((tool) => tool.name === "mcp_context")).toBe(true);
      expect(tools.some((tool) => tool.name === "aider")).toBe(true);
    });
  });
});
