import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager } from "./index.js";
import "./test-runtime-mocks.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "auto",
    provider: null,
    unavailableReason: "No embedding provider available",
  }),
}));

describe("memory index FTS-only mode", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let indexPath = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    indexPath = path.join(fixtureRoot, "main.sqlite");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Root memory\nAlpha thesis line.\n");
    await fs.writeFile(path.join(memoryDir, "2026-04-18.md"), "# Daily\nBeta keyword note.\n");
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("indexes memory files and serves FTS search without embeddings", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "auto",
            store: { path: indexPath, vector: { enabled: false } },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0, hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 } },
            sources: ["memory"],
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as const;

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    const manager = result.manager!;

    try {
      await manager.sync({ reason: "test" });
      const status = manager.status();
      expect(status.provider).toBe("none");
      expect(status.files).toBe(2);
      expect(status.chunks).toBeGreaterThan(0);

      const results = await manager.search("beta");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((entry) => entry.path.includes("memory/2026-04-18.md"))).toBe(true);
    } finally {
      await manager.close?.();
    }
  });
});
