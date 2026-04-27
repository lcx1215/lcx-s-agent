import fs from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryManagerUnavailable,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  type MemoryReadParams,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import type { OpenClawConfig } from "../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../test-helpers/workspace.js";
import { createMemoryGetTool, createMemorySearchTool } from "./memory-tool.js";

function asOpenClawConfig(config: Partial<OpenClawConfig>): OpenClawConfig {
  return config as OpenClawConfig;
}

function createToolConfig() {
  return asOpenClawConfig({ agents: { list: [{ id: "main", default: true }] } });
}

async function createWorkspaceWithProtectedSummaries(paths?: {
  currentResearchLine?: boolean;
  unifiedRiskView?: boolean;
  rootMemory?: boolean;
}): Promise<string> {
  const workspaceDir = await makeTempWorkspace("openclaw-memory-tool-");
  await fs.mkdir(`${workspaceDir}/memory`, { recursive: true });
  if (paths?.currentResearchLine ?? true) {
    await writeWorkspaceFile({
      dir: `${workspaceDir}/memory`,
      name: "current-research-line.md",
      content: "# Current Research Line",
    });
  }
  if (paths?.unifiedRiskView ?? true) {
    await writeWorkspaceFile({
      dir: `${workspaceDir}/memory`,
      name: "unified-risk-view.md",
      content: "# Unified Risk View",
    });
  }
  if (paths?.rootMemory ?? true) {
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: "MEMORY.md",
      content: "# Root Memory",
    });
  }
  return workspaceDir;
}

function createMemoryGetToolOrThrow(config: OpenClawConfig = createToolConfig()) {
  const tool = createMemoryGetTool({ config });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

beforeEach(() => {
  resetMemoryToolMockState({
    backend: "builtin",
    searchImpl: async () => [
      {
        path: "MEMORY.md",
        startLine: 5,
        endLine: 7,
        score: 0.9,
        snippet: "@@ -5,3 @@\nAssistant: noted",
        source: "memory" as const,
      },
    ],
    readFileImpl: async (params: MemoryReadParams) => ({ text: "", path: params.relPath }),
  });
});

describe("memory search citations", () => {
  it("appends source information when citations are enabled", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      memory: { citations: "on" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("call_citations_on", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet).toMatch(/Source: MEMORY.md#L5-L7/);
    expect(details.results[0]?.citation).toBe("MEMORY.md#L5-L7");
  });

  it("leaves snippet untouched when citations are off", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      memory: { citations: "off" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("call_citations_off", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
    expect(details.results[0]?.citation).toBeUndefined();
  });

  it("clamps decorated snippets to qmd injected budget", async () => {
    setMemoryBackend("qmd");
    const cfg = asOpenClawConfig({
      memory: { citations: "on", backend: "qmd", qmd: { limits: { maxInjectedChars: 20 } } },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("call_citations_qmd", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet.length).toBeLessThanOrEqual(20);
  });

  it("honors auto mode for direct chats", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({
      config: cfg,
      agentSessionKey: "agent:main:discord:dm:u123",
    });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("auto_mode_direct", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    expect(details.results[0]?.snippet).toMatch(/Source:/);
  });

  it("suppresses citations for auto mode in group chats", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({
      config: cfg,
      agentSessionKey: "agent:main:discord:group:c123",
    });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("auto_mode_group", { query: "notes" });
    const details = result.details as {
      results: Array<{ snippet: string }>;
      retrievalKind: string;
      retrievalContract: string;
    };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
    expect(details.retrievalKind).toBe("semantic");
    expect(details.retrievalContract).toBe("supplemental_recall");
  });
});

describe("memory tools", () => {
  it("keeps protected summaries as the first anchor in tool descriptions", () => {
    const searchTool = createMemorySearchTool({ config: createToolConfig() });
    const getTool = createMemoryGetToolOrThrow();

    expect(searchTool?.description).toContain("anchor first on protected summaries when present");
    expect(searchTool?.description).toContain("protected summaries remain the primary anchors");
    expect(getTool.description).toContain(
      "read protected summaries directly first when current-state truth matters",
    );
  });

  it("does not throw when memory_search fails (e.g. embeddings 429)", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const workspaceDir = await createWorkspaceWithProtectedSummaries();
    const cfg = { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } };
    const tool = createMemorySearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_1", { query: "hello" });
    expect(result.details).toEqual({
      results: [],
      disabled: true,
      unavailable: true,
      retrievalContract: "supplemental_recall",
      primaryAnchors: [
        "memory/current-research-line.md",
        "memory/unified-risk-view.md",
        "MEMORY.md",
      ],
      primaryAnchorRule:
        "Protected summaries present in this workspace are the canonical first anchors for current state; retrieved snippets are supporting recall until re-verified.",
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action:
        "Top up or switch embedding provider, then retry memory_search. Until then, fall back to direct memory_get reads on any protected summaries that are present.",
      fallbackStrategy:
        "Read any protected summaries present in this workspace directly with memory_get before declaring recall degraded.",
      fallbackPaths: [
        "memory/current-research-line.md",
        "memory/unified-risk-view.md",
        "MEMORY.md",
      ],
    });
  });

  it("only returns protected anchors that actually exist in the workspace", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

    const workspaceDir = await createWorkspaceWithProtectedSummaries({
      currentResearchLine: true,
      unifiedRiskView: false,
      rootMemory: false,
    });
    const tool = createMemorySearchTool({
      config: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("partial_anchors", { query: "hello" });
    expect(result.details).toEqual({
      results: [],
      disabled: true,
      unavailable: true,
      retrievalContract: "supplemental_recall",
      primaryAnchors: ["memory/current-research-line.md"],
      primaryAnchorRule:
        "Protected summaries present in this workspace are the canonical first anchors for current state; retrieved snippets are supporting recall until re-verified.",
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action:
        "Check embedding provider configuration and retry memory_search. Until then, fall back to direct memory_get reads on any protected summaries that are present.",
      fallbackStrategy:
        "Read any protected summaries present in this workspace directly with memory_get before declaring recall degraded.",
      fallbackPaths: ["memory/current-research-line.md"],
    });
  });

  it("does not throw when memory_get fails", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      throw new Error("path required");
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_2", { path: "memory/NOPE.md" });
    expect(result.details).toEqual({
      path: "memory/NOPE.md",
      text: "",
      disabled: true,
      error: "path required",
    });
  });

  it("returns empty text without error when file does not exist (ENOENT)", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      return { text: "", path: "memory/2026-02-19.md" };
    });

    const workspaceDir = await createWorkspaceWithProtectedSummaries({
      currentResearchLine: true,
      unifiedRiskView: false,
      rootMemory: false,
    });
    const tool = createMemoryGetToolOrThrow(
      asOpenClawConfig({
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      }),
    );

    const result = await tool.execute("call_enoent", { path: "memory/2026-02-19.md" });
    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
      missing: true,
    });
  });

  it("still reads protected summaries directly when the memory manager is unavailable", async () => {
    setMemoryManagerUnavailable("openai embeddings failed: 429 insufficient_quota");

    const workspaceDir = await createWorkspaceWithProtectedSummaries({
      currentResearchLine: true,
      unifiedRiskView: false,
      rootMemory: false,
    });
    await writeWorkspaceFile({
      dir: `${workspaceDir}/memory`,
      name: "current-research-line.md",
      content: ["alpha", "beta", "gamma"].join("\n"),
    });

    const tool = createMemoryGetToolOrThrow(
      asOpenClawConfig({
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      }),
    );

    const result = await tool.execute("call_direct_fallback", {
      path: "memory/current-research-line.md",
      from: 2,
      lines: 1,
    });
    expect(result.details).toEqual({
      text: "beta",
      path: "memory/current-research-line.md",
    });
  });
});
