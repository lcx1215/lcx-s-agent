import fs from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetMemoryToolMockState,
  setMemorySearchImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../test-helpers/workspace.js";
import { createMemorySearchTool } from "./memory-tool.js";

async function createWorkspaceWithProtectedSummaries(): Promise<string> {
  const workspaceDir = await makeTempWorkspace("openclaw-memory-search-");
  await fs.mkdir(`${workspaceDir}/memory`, { recursive: true });
  await writeWorkspaceFile({
    dir: `${workspaceDir}/memory`,
    name: "current-research-line.md",
    content: "# Current Research Line",
  });
  await writeWorkspaceFile({
    dir: `${workspaceDir}/memory`,
    name: "unified-risk-view.md",
    content: "# Unified Risk View",
  });
  await writeWorkspaceFile({
    dir: workspaceDir,
    name: "MEMORY.md",
    content: "# Root Memory",
  });
  return workspaceDir;
}

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const workspaceDir = await createWorkspaceWithProtectedSummaries();
    const tool = createMemorySearchTool({
      config: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("quota", { query: "hello" });
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

  it("returns explicit unavailable metadata for non-quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

    const workspaceDir = await createWorkspaceWithProtectedSummaries();
    const tool = createMemorySearchTool({
      config: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("generic", { query: "hello" });
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
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action:
        "Check embedding provider configuration and retry memory_search. Until then, fall back to direct memory_get reads on any protected summaries that are present.",
      fallbackStrategy:
        "Read any protected summaries present in this workspace directly with memory_get before declaring recall degraded.",
      fallbackPaths: [
        "memory/current-research-line.md",
        "memory/unified-risk-view.md",
        "MEMORY.md",
      ],
    });
  });
});
