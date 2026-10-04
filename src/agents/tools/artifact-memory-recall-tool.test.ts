import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { ArtifactStore } from "../../memory/artifact-store.js";
import { createArtifactMemoryRecallTool } from "./artifact-memory-recall-tool.js";

let root: string;
let dbPath: string;
let cfg: OpenClawConfig;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-artifact-recall-"));
  dbPath = path.join(root, "memory.sqlite");
  cfg = { agents: { defaults: { workspace: root, memorySearch: { store: { path: dbPath } } } } };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function seed() {
  await fs.mkdir(path.join(root, "state/runs"), { recursive: true });
  await fs.writeFile(path.join(root, "state/runs/result.json"), '{"value":42}');
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  try {
    await store.register({
      id: "real-result",
      owner: "central-harness",
      runId: "real-run",
      observedAt: "2026-10-04T10:00:00Z",
      relativePath: "state/runs/result.json",
      mimeType: "application/json",
      summary: "questionable spread evidence",
    });
  } finally {
    store.close();
  }
}
it("reads host-configured registered originals without accepting DB or arbitrary paths", async () => {
  await seed();
  const before = await fs.readFile(dbPath);
  const tool = createArtifactMemoryRecallTool({ config: cfg, agentId: "main", workspaceDir: root });
  expect(
    (
      await tool.execute("search", {
        action: "search",
        query: "spread",
        dbPath: "/tmp/forged.sqlite",
        workspaceDir: "/tmp",
      })
    ).details,
  ).toMatchObject({ available: true, authority: "local_read", artifacts: [{ id: "real-result" }] });
  expect(
    (await tool.execute("read", { action: "read", id: "real-result", path: "/tmp/private" }))
      .details,
  ).toMatchObject({ available: true, text: '{"value":42}', artifact: { runId: "real-run" } });
  expect(await fs.readFile(dbPath)).toEqual(before);
  expect(
    (await tool.execute("unknown", { action: "register", id: "forged" })).details,
  ).toMatchObject({ available: false, gap: "artifact_action_invalid" });
});
it("names missing config, disabled recall and absent database without creating anything", async () => {
  expect(
    (
      await createArtifactMemoryRecallTool({}).execute("no-config", {
        action: "search",
        query: "x",
      })
    ).details,
  ).toMatchObject({ gap: "artifact_memory_config_missing" });
  const disabled: OpenClawConfig = { agents: { defaults: { memorySearch: { enabled: false } } } };
  expect(
    (
      await createArtifactMemoryRecallTool({ config: disabled }).execute("disabled", {
        action: "search",
        query: "x",
      })
    ).details,
  ).toMatchObject({ gap: "artifact_memory_disabled" });
  expect(
    (
      await createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root }).execute("missing", {
        action: "search",
        query: "x",
      })
    ).details,
  ).toMatchObject({ gap: "artifact_database_missing" });
  await expect(fs.stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("reports missing and changed registered originals", async () => {
  await seed();
  const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
  await fs.writeFile(path.join(root, "state/runs/result.json"), '{"value":43}');
  expect(
    (await tool.execute("changed", { action: "read", id: "real-result" })).details,
  ).toMatchObject({ gap: "artifact_original_hash_mismatch" });
  await fs.rm(path.join(root, "state/runs/result.json"));
  expect(
    (await tool.execute("missing", { action: "read", id: "real-result" })).details,
  ).toMatchObject({ gap: "artifact_original_missing" });
});

it("puts a compact pointer and UTF8 text preview before large details", async () => {
  await seed();
  const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
  const search = (await tool.execute("search", { action: "search", query: "spread" }))
    .details as Record<string, unknown>;
  expect(search.latestArtifactId).toBe("real-result");
  expect(search.count).toBe(1);
  expect(JSON.stringify(search).indexOf("latestArtifactId")).toBeLessThan(
    JSON.stringify(search).indexOf("artifacts"),
  );
  const read = (await tool.execute("read", { action: "read", id: "real-result" }))
    .details as Record<string, unknown>;
  expect(read.textPreview).toBe('{"value":42}');
  expect(read.previewTruncated).toBe(false);
  expect(JSON.stringify(read).indexOf("textPreview")).toBeLessThan(
    JSON.stringify(read).indexOf("artifact"),
  );
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  await fs.writeFile(path.join(root, "state/runs/long.md"), "证".repeat(100));
  try {
    await store.register({
      id: "long",
      owner: "test",
      runId: "r",
      observedAt: "2026-10-04T10:00:00Z",
      relativePath: "state/runs/long.md",
      mimeType: "text/markdown",
      summary: "long content",
    });
  } finally {
    store.close();
  }
  const long = (await tool.execute("read", { action: "read", id: "long" })).details as Record<
    string,
    unknown
  >;
  expect(long.textPreview).toBe("证".repeat(53));
  expect(long.previewTruncated).toBe(true);
  expect(long.text).toBe("证".repeat(100));
});
it("selects a precise quant result through RFC6901 after source hash verification", async () => {
  await seed();
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  await fs.writeFile(
    path.join(root, "state/runs/quant.json"),
    JSON.stringify({
      schemaVersion: "lcx_agent_artifact_v1",
      value: { details: { beta: 0.38, "a/b": { "~key": 42 } } },
    }),
  );
  try {
    await store.register({
      id: "quant",
      owner: "financial-math",
      runId: "r",
      observedAt: "2026-10-04T10:00:00Z",
      relativePath: "state/runs/quant.json",
      mimeType: "application/json",
      summary: "actual beta result",
    });
  } finally {
    store.close();
  }
  const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
  expect(
    (await tool.execute("beta", { action: "read", id: "quant", field: "/value/details/beta" }))
      .details,
  ).toMatchObject({
    selectedValue: 0.38,
    selectedPreview: "0.38",
    selectedPreviewTruncated: false,
  });
  expect(
    (
      await tool.execute("escape", {
        action: "read",
        id: "quant",
        field: "/value/details/a~1b/~0key",
      })
    ).details,
  ).toMatchObject({ selectedValue: 42 });
  expect(
    (
      await tool.execute("prototype", {
        action: "read",
        id: "quant",
        field: "/constructor/prototype",
      })
    ).details,
  ).toMatchObject({ available: false, gap: "artifact_field_missing" });
  expect(
    (await tool.execute("invalid", { action: "read", id: "quant", field: "/value/~2" })).details,
  ).toMatchObject({ available: false, gap: "artifact_field_invalid" });
  await fs.writeFile(path.join(root, "state/runs/quant.json"), "changed");
  expect(
    (await tool.execute("changed", { action: "read", id: "quant", field: "/value/details/beta" }))
      .details,
  ).toMatchObject({ gap: "artifact_original_hash_mismatch" });
});
it("names truncated JSON field reads and preserves full original references", async () => {
  await seed();
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  await fs.writeFile(
    path.join(root, "state/runs/long.json"),
    JSON.stringify({ data: "x".repeat(70000), beta: 0.38 }),
  );
  try {
    await store.register({
      id: "longjson",
      owner: "math",
      runId: "r",
      observedAt: "2026-10-04T10:00:00Z",
      relativePath: "state/runs/long.json",
      mimeType: "application/json",
      summary: "large actual result",
    });
  } finally {
    store.close();
  }
  const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
  expect(
    (await tool.execute("field", { action: "read", id: "longjson", field: "/beta" })).details,
  ).toMatchObject({ available: false, gap: "artifact_field_text_unavailable" });
});

it("applies asOf to direct registered-id reads and named invalid timestamps", async () => {
  await seed();
  const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
  expect(
    (
      await tool.execute("search", {
        action: "search",
        query: "spread",
        asOf: "2026-10-04T09:59:59Z",
      })
    ).details,
  ).toMatchObject({ count: 0 });
  const future = (
    await tool.execute("future", {
      action: "read",
      id: "real-result",
      field: "/value",
      asOf: "2026-10-04T09:59:59Z",
    })
  ).details as Record<string, unknown>;
  expect(future).toMatchObject({ available: false, gap: "artifact_after_cutoff" });
  expect(future).not.toHaveProperty("text");
  expect(future).not.toHaveProperty("selectedValue");
  expect(
    (await tool.execute("invalid", { action: "read", id: "real-result", asOf: "not-a-date" }))
      .details,
  ).toMatchObject({ gap: "artifact_timestamp_invalid" });
  expect(
    (
      await tool.execute("exact", {
        action: "read",
        id: "real-result",
        asOf: "2026-10-04T10:00:00Z",
      })
    ).details,
  ).toMatchObject({ available: true });
});

it("honors cancellation before opening and after awaiting an original read", async () => {
  await seed();
  const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
  const stopped = new AbortController();
  stopped.abort();
  const open = vi.spyOn(ArtifactStore, "open");
  expect(
    (await tool.execute("stopped", { action: "read", id: "real-result" }, stopped.signal)).details,
  ).toMatchObject({ gap: "artifact_recall_cancelled" });
  expect(open).not.toHaveBeenCalled();
  const late = new AbortController();
  const read = vi.spyOn(ArtifactStore.prototype, "read");
  read.mockImplementationOnce(async function (this: ArtifactStore, id) {
    read.mockRestore();
    const result = await this.read(id);
    late.abort();
    return result;
  });
  const cancelled = (await tool.execute("late", { action: "read", id: "real-result" }, late.signal))
    .details as Record<string, unknown>;
  expect(cancelled).toMatchObject({ gap: "artifact_recall_cancelled" });
  expect(cancelled).not.toHaveProperty("text");
});
it("does not replace a named gap with a cleanup error", async () => {
  await seed();
  const close = vi.spyOn(ArtifactStore.prototype, "close");
  close.mockImplementationOnce(function (this: ArtifactStore) {
    close.mockRestore();
    this.close();
    throw new Error("close failure");
  });
  expect(
    (
      await createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root }).execute("unknown", {
        action: "read",
        id: "unknown",
      })
    ).details,
  ).toMatchObject({ gap: "artifact_not_registered" });
});
