import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { ArtifactStore } from "../../memory/artifact-store.js";
import {
  boundPerception,
  compactReceipts,
  runCentralHarnessCycle,
} from "../central-harness/harness-loop.js";
import type { CentralToolSpec } from "../central-harness/types.js";
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
it("names a missing required action without opening the store or silently choosing a read", async () => {
  await seed();
  const before = await fs.readFile(dbPath);
  const open = vi.spyOn(ArtifactStore, "open");
  const tool = createArtifactMemoryRecallTool({ config: cfg, agentId: "main", workspaceDir: root });
  const result = await tool.execute("natural-missing-action", {
    id: "real-result",
    field: "/value",
  });
  expect(result.details).toMatchObject({
    available: false,
    gap: "artifact_action_required",
    requiredArgs: ["action"],
    allowedActions: ["read", "search"],
  });
  expect(open).not.toHaveBeenCalled();
  expect(await fs.readFile(dbPath)).toEqual(before);
  expect(tool.description).toContain("action is required");
  expect(
    (await tool.execute("explicit-read", { action: "read", id: "real-result", field: "/value" }))
      .details,
  ).toMatchObject({ available: true, selectedValue: 42 });
  expect(open).toHaveBeenCalledOnce();
  expect(await fs.readFile(dbPath)).toEqual(before);
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

it.each([
  ["json", "application/json", Buffer.from('{"price":138.05,"volume":')],
  ["png", "image/png", Buffer.from([137, 80, 78, 71, 0, 255])],
])(
  "retains the verified %s fragment when a requested field is unavailable",
  async (ext, mime, bytes) => {
    await fs.mkdir(path.join(root, "state/runs"), { recursive: true });
    const relativePath = `state/runs/partial.${ext}`;
    await fs.writeFile(path.join(root, relativePath), bytes);
    const store = ArtifactStore.open({ dbPath, workspaceDir: root });
    let sourceSha256: string;
    try {
      const recorded = await store.register({
        id: "partial-source",
        owner: "fragment-intake",
        runId: "partial-run",
        observedAt: "2026-10-07T14:00:00Z",
        relativePath,
        mimeType: mime,
        summary: "partial source retained, exact price field not verified",
      });
      sourceSha256 = recorded.artifact.sha256;
    } finally {
      store.close();
    }
    const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
    const read = (
      await tool.execute("partial-field", {
        action: "read",
        id: "partial-source",
        field: "/price",
      })
    ).details as Record<string, unknown>;
    expect(read).toMatchObject({
      available: false,
      sourceAvailable: true,
      selectionComplete: false,
      artifactId: "partial-source",
      sourceSha256,
      gap: ext === "json" ? "artifact_field_json_unavailable" : "artifact_field_text_unavailable",
    });
    expect(read).not.toHaveProperty("selectedValue");
    if (ext === "json") {
      expect(read.textPreview).toBe(bytes.toString("utf8"));
    } else {
      expect(read.format).toBe("binary");
      expect(read).not.toHaveProperty("textPreview");
    }
    const page = (
      await tool.execute("partial-text-page", {
        action: "read",
        id: "partial-source",
        textOffset: 0,
      })
    ).details;
    expect(page).toMatchObject(
      ext === "json"
        ? { available: true, textPage: bytes.toString("utf8"), sourceSha256 }
        : {
            available: false,
            sourceAvailable: true,
            format: "binary",
            gap: "artifact_text_unavailable",
            sourceSha256,
          },
    );
    if (ext === "png") {
      expect(page).not.toHaveProperty("textPage");
    }
    expect(await fs.readFile(path.join(root, relativePath))).toEqual(bytes);
    await fs.writeFile(path.join(root, relativePath), "changed fragment");
    const changed = (
      await tool.execute("changed-partial", {
        action: "read",
        id: "partial-source",
        field: "/price",
      })
    ).details as Record<string, unknown>;
    expect(changed).toMatchObject({ available: false, gap: "artifact_original_hash_mismatch" });
    expect(changed).not.toHaveProperty("sourceAvailable");
    expect(changed).not.toHaveProperty("textPreview");
  },
);

it.each(["/missing", "/data"])(
  "keeps verified recovery evidence for an unavailable selected field %s",
  async (field) => {
    await seed();
    const relativePath = "state/runs/large-field.json";
    const selected = { reason: "usable partial evidence", detail: "证据".repeat(12000) };
    await fs.writeFile(
      path.join(root, relativePath),
      JSON.stringify({ data: selected, beta: 0.38 }),
    );
    const store = ArtifactStore.open({ dbPath, workspaceDir: root });
    let sha256: string;
    try {
      const result = await store.register({
        id: "large-field",
        owner: "math",
        runId: "partial-read",
        observedAt: "2026-10-04T10:00:00Z",
        relativePath,
        mimeType: "application/json",
        summary: "bounded partial recovery",
      });
      sha256 = result.artifact.sha256;
    } finally {
      store.close();
    }
    const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
    const receipt = await digestRecallTool(tool, { action: "read", id: "large-field", field });
    const step = receipt.steps[0];
    expect(step).toMatchObject({
      status: "ran_ok",
      observedOk: false,
      outcome: {
        available: false,
        sourceAvailable: true,
        selectionComplete: false,
        artifactId: "large-field",
        sourceSha256: sha256,
        field,
        gap: field === "/data" ? "artifact_field_budget_exceeded" : "artifact_field_missing",
      },
    });
    expect(step.outcome).not.toHaveProperty("selectedValue");
    expect(step.outcome).not.toHaveProperty("text");
    expect(Buffer.byteLength(JSON.stringify(step.outcome))).toBeLessThanOrEqual(4096);
    if (field === "/data") {
      expect(step.outcome).toMatchObject({ selectedPreviewTruncated: true });
      expect(step.outcome?.selectedPreview).toContain("usable partial evidence");
      expect(Buffer.byteLength(String(step.outcome?.selectedPreview))).toBeLessThanOrEqual(160);
    } else {
      expect(step.outcome?.textPreview).toContain("usable partial evidence");
    }
    expect(
      (await tool.execute("narrow", { action: "read", id: "large-field", field: "/data/reason" }))
        .details,
    ).toMatchObject({ available: true, sourceSha256: sha256, selectedValue: selected.reason });
    const invalid = (
      await tool.execute("invalid", { action: "read", id: "large-field", field: "data.reason" })
    ).details;
    expect(invalid).toMatchObject({ available: false, gap: "artifact_field_invalid" });
    expect(invalid).not.toHaveProperty("sourceAvailable");
  },
);

it.each(["text/plain", "text/csv", "application/json"])(
  "recovers a useful %s tail beyond the original preview through the same reader",
  async (mimeType) => {
    await seed();
    const prefix = "unrelated heading\n".repeat(5000);
    const tail = "费用,数量\nBTC,0.000001\n缺少订单关联，但保留有用片段";
    const text = prefix + tail;
    const relativePath = "state/runs/fragment.txt";
    await fs.writeFile(path.join(root, relativePath), text);
    const store = ArtifactStore.open({ dbPath, workspaceDir: root });
    let sha256: string;
    try {
      const result = await store.register({
        id: "text-fragment",
        owner: "fragment-intake",
        runId: "partial-text",
        observedAt: "2026-10-04T10:00:00Z",
        relativePath,
        mimeType,
        summary: "tail evidence remains incomplete",
      });
      sha256 = result.artifact.sha256;
    } finally {
      store.close();
    }
    const args = {
      action: "read",
      id: "text-fragment",
      textOffset: Buffer.byteLength(prefix),
      textLimit: 512,
    };
    const receipt = await digestRecallTool(
      createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root }),
      args,
    );
    const step = receipt.steps[0];
    expect(step).toMatchObject({
      status: "ran_ok",
      observedOk: true,
      outcome: {
        available: true,
        sourceSha256: sha256,
        artifactId: "text-fragment",
        textOffset: args.textOffset,
        textPage: tail,
        nextTextOffset: null,
        sourceTextTruncated: false,
      },
    });
    expect(step.outcome).not.toHaveProperty("text");
    expect(step.outcome).not.toHaveProperty("artifact");
    expect(Buffer.byteLength(JSON.stringify(step.outcome))).toBeLessThanOrEqual(4096);
    const backlog = compactReceipts([receipt], 10, new Set(["artifact_memory_recall"]));
    expect(
      boundPerception({
        observedAt: receipt.observedAt,
        ownerTotals: {},
        controlRoom: {},
        backlog,
        boundaries: [],
      }).report.overBudget,
    ).toBe(false);
    expect(backlog[0].outcomes[0].outcome?.textPage).toBe(tail);
    const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
    expect(
      (await tool.execute("future-text", { ...args, asOf: "2026-10-04T09:59:59Z" })).details,
    ).toMatchObject({ available: false, gap: "artifact_after_cutoff" });
    await fs.writeFile(path.join(root, relativePath), text + "changed");
    const changed = (await tool.execute("changed-text", args)).details;
    expect(changed).toMatchObject({ available: false, gap: "artifact_original_hash_mismatch" });
    expect(changed).not.toHaveProperty("textPage");
  },
);

it("pages UTF8 text without omissions, replacement characters or unbounded escape expansion", async () => {
  await seed();
  const text = '证据😀\n"\u0001'.repeat(200);
  await fs.writeFile(path.join(root, "state/runs/unicode.txt"), text);
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  try {
    await store.register({
      id: "unicode-text",
      owner: "partial",
      runId: "utf8",
      observedAt: "2026-10-04T10:00:00Z",
      relativePath: "state/runs/unicode.txt",
      mimeType: "text/plain",
      summary: "source text only",
    });
  } finally {
    store.close();
  }
  const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
  let offset: number | null = 0;
  let recovered = "";
  while (offset !== null) {
    const result = (
      await tool.execute("page", { action: "read", id: "unicode-text", textOffset: offset })
    ).details as { available: boolean; textPage: string; nextTextOffset: number | null };
    expect(result.available).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.textPage))).toBeLessThanOrEqual(2048);
    expect(result.textPage).not.toContain("�");
    if (result.nextTextOffset !== null) {
      expect(result.nextTextOffset).toBeGreaterThan(offset);
    }
    recovered += result.textPage;
    offset = result.nextTextOffset;
  }
  expect(recovered).toBe(text);
  expect(
    (
      await tool.execute("small", {
        action: "read",
        id: "unicode-text",
        textOffset: 0,
        textLimit: 1,
      })
    ).details,
  ).toMatchObject({ available: false, gap: "artifact_text_page_too_small" });
  expect(
    (await tool.execute("middle", { action: "read", id: "unicode-text", textOffset: 1 })).details,
  ).toMatchObject({ available: false, gap: "artifact_text_offset_invalid" });
});

it.each([
  { textOffset: -1 },
  { textOffset: 1.5 },
  { textOffset: "0" },
  { textOffset: 16 * 1024 * 1024 + 1 },
  { textLimit: 0 },
  { textLimit: 2049 },
  { textOffset: 0, field: "/value" },
  { action: "search", textOffset: 0 },
])("rejects invalid or conflicting text page arguments %j", async (extra) => {
  await seed();
  const result = (
    await createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root }).execute(
      "invalid-page",
      { action: "read", id: "real-result", ...extra },
    )
  ).details;
  expect(result).toMatchObject({ available: false, gap: "artifact_text_page_invalid" });
  expect(result).not.toHaveProperty("textPage");
});

it("keeps mixed-media redaction and reports the offset projection explicitly", async () => {
  await seed();
  const text = JSON.stringify({
    schemaVersion: "lcx_agent_artifact_v1",
    metadata: "useful image label",
    content: [{ type: "image", mimeType: "image/png", data: "private-base64-content" }],
  });
  await fs.writeFile(path.join(root, "state/runs/media.json"), text);
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  let sha256: string;
  try {
    const result = await store.register({
      id: "mixed-media",
      owner: "partial",
      runId: "media",
      observedAt: "2026-10-04T10:00:00Z",
      relativePath: "state/runs/media.json",
      mimeType: "application/json",
      summary: "original media retained",
    });
    sha256 = result.artifact.sha256;
  } finally {
    store.close();
  }
  const result = (
    await createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root }).execute("page", {
      action: "read",
      id: "mixed-media",
      textOffset: 0,
    })
  ).details as Record<string, unknown>;
  expect(result).toMatchObject({
    available: true,
    sourceSha256: sha256,
    textProjection: "metadata_and_text",
  });
  expect(result.textPage).toContain("useful image label");
  expect(result.textPage).not.toContain("private-base64-content");
  expect(await fs.readFile(path.join(root, "state/runs/media.json"), "utf8")).toBe(text);
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
  const beta = (
    await tool.execute("beta", { action: "read", id: "quant", field: "/value/details/beta" })
  ).details;
  expect(beta).toMatchObject({
    selectedValue: 0.38,
    selectedPreview: "0.38",
    selectedPreviewTruncated: false,
    sourceTextOmittedForField: true,
  });
  expect(beta).not.toHaveProperty("text");
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
it("reads a narrow field beyond the original preview without exposing the large source", async () => {
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
  ).toMatchObject({
    available: true,
    selectedValue: 0.38,
    sourceTextOmittedForField: true,
  });
  expect(
    (await tool.execute("field-no-large-text", { action: "read", id: "longjson", field: "/beta" }))
      .details,
  ).not.toHaveProperty("text");
  expect(
    (await tool.execute("large-field", { action: "read", id: "longjson", field: "/data" })).details,
  ).toMatchObject({ available: false, gap: "artifact_field_budget_exceeded" });
  expect(
    (await tool.execute("ordinary-preview", { action: "read", id: "longjson" })).details,
  ).toMatchObject({ available: true, truncated: true });
  await fs.writeFile(
    path.join(root, "state/runs/long.json"),
    JSON.stringify({ data: "x".repeat(70000), beta: 0.39 }),
  );
  expect(
    (await tool.execute("changed-tail", { action: "read", id: "longjson", field: "/beta" }))
      .details,
  ).toMatchObject({ available: false, gap: "artifact_original_hash_mismatch" });
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

it("allows bounded first-user browsing and exposes page continuation before large records", async () => {
  await seed();
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  try {
    for (let n = 0; n < 3; n++) {
      await store.register({
        id: `extra_${n}`,
        owner: "browse-owner",
        runId: `run${n}`,
        observedAt: "2026-10-04T10:00:00Z",
        relativePath: "state/runs/result.json",
        mimeType: "application/json",
        summary: "browse marker",
      });
    }
  } finally {
    store.close();
  }
  const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
  const first = (
    await tool.execute("browse", { action: "search", owner: "browse-owner", limit: 1 })
  ).details as { hasMore: boolean; nextCursor: string; count: number; artifacts: { id: string }[] };
  expect(first).toMatchObject({ hasMore: true, count: 1 });
  expect(JSON.stringify(first).indexOf("nextCursor")).toBeLessThan(
    JSON.stringify(first).indexOf('"artifacts"'),
  );
  const second = (
    await tool.execute("next", {
      action: "search",
      owner: "browse-owner",
      limit: 1,
      cursor: first.nextCursor,
    })
  ).details as { artifacts: { id: string }[] };
  expect(second.artifacts[0].id).not.toBe(first.artifacts[0].id);
  expect(
    (await tool.execute("empty", { action: "search", query: "", owner: "browse-owner" })).details,
  ).toMatchObject({
    available: true,
    count: 3,
    backend: "browse",
    hasMore: false,
    nextCursor: null,
  });
  expect(
    (await tool.execute("bad", { action: "search", query: "x".repeat(1001) })).details,
  ).toMatchObject({ gap: "artifact_query_invalid" });
  expect(
    (await tool.execute("badcursor", { action: "search", cursor: "forged" })).details,
  ).toMatchObject({ gap: "artifact_cursor_invalid" });
  expect((await tool.execute("querytype", { action: "search", query: 42 })).details).toMatchObject({
    gap: "artifact_query_invalid",
  });
});

async function digestRecallTool(
  tool: ReturnType<typeof createArtifactMemoryRecallTool>,
  args: Record<string, unknown>,
) {
  const ownerId = "artifact_memory_recall";
  const spec: CentralToolSpec = {
    ownerId,
    name: ownerId,
    label: ownerId,
    description: "original readonly recall",
    allowedSideEffects: ["local_read"],
    boundary: [],
    approve: () => ({ ok: true }),
    execute: async (args, signal) =>
      (await tool.execute("digest", args, signal)).details as Record<string, unknown>,
  };
  return runCentralHarnessCycle({
    perception: {
      observedAt: "2026-10-04T10:00:00Z",
      ownerTotals: {},
      controlRoom: {},
      backlog: [],
      boundaries: [],
    },
    registry: new Map([[ownerId, spec]]),
    brain: {
      propose: async () => ({
        kind: "proposed" as const,
        provider: "fixture",
        modelId: "fixture",
        plan: { actions: [{ ownerId, args }], note: "scripted proof" },
      }),
    },
  });
}
it("keeps a scoped compact cursor in the original 512 byte decision digest even with a long query", async () => {
  await seed();
  const query = "q".repeat(1000);
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  try {
    for (const hash of ["a", "b"]) {
      await store.register({
        id: `artifact-${hash.repeat(64)}`,
        owner: "digest",
        runId: "r",
        observedAt: "2026-10-04T10:00:00Z",
        relativePath: "state/runs/result.json",
        mimeType: "application/json",
        summary: query,
      });
    }
  } finally {
    store.close();
  }
  const receipt = await digestRecallTool(
    createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root }),
    { action: "search", query, owner: "digest", limit: 1 },
  );
  const step = receipt.steps[0];
  expect(step.status).toBe("ran_ok");
  expect(step.outcome?.hasMore).toBe(true);
  expect(step.outcome?.nextCursor).toBeTypeOf("string");
  expect(Buffer.byteLength(JSON.stringify(step.outcome))).toBeLessThanOrEqual(512);
  expect(step.outcomeDroppedKeys).not.toContain("nextCursor");
});
it("names a cursor omitted by the original decision budget rather than truncating its identity", async () => {
  await seed();
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  try {
    for (const part of ["超", "长"]) {
      await store.register({
        id: part.repeat(240),
        owner: "large-id",
        runId: "r",
        observedAt: "2026-10-04T10:00:00Z",
        relativePath: "state/runs/result.json",
        mimeType: "application/json",
        summary: "largeids",
      });
    }
  } finally {
    store.close();
  }
  const receipt = await digestRecallTool(
    createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root }),
    { action: "search", query: "largeids", owner: "large-id", limit: 1 },
  );
  expect(receipt.steps[0].outcome?.hasMore).toBe(true);
  expect(receipt.steps[0].outcome).not.toHaveProperty("nextCursor");
  expect(receipt.steps[0].outcomeDroppedKeys).toContain("nextCursor");
});

it("keeps the existing source bound for selected-field reads", async () => {
  await seed();
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  await fs.writeFile(
    path.join(root, "state/runs/oversize.json"),
    JSON.stringify({ data: "x".repeat(16 * 1024 * 1024), beta: 0.38 }),
  );
  try {
    await store.register({
      id: "oversize",
      owner: "math",
      runId: "r",
      observedAt: "2026-10-04T10:00:00Z",
      relativePath: "state/runs/oversize.json",
      mimeType: "application/json",
      summary: "existing full source limit",
    });
  } finally {
    store.close();
  }
  const tool = createArtifactMemoryRecallTool({ config: cfg, workspaceDir: root });
  expect(
    (await tool.execute("bounded", { action: "read", id: "oversize", field: "/beta" })).details,
  ).toMatchObject({ available: false, gap: "artifact_field_text_unavailable" });
  expect(
    (
      await tool.execute("text-head", {
        action: "read",
        id: "oversize",
        textOffset: 0,
        textLimit: 32,
      })
    ).details,
  ).toMatchObject({ available: true, sourceTextTruncated: true });
  const limit = (
    await tool.execute("text-limit", {
      action: "read",
      id: "oversize",
      textOffset: 16 * 1024 * 1024,
    })
  ).details;
  expect(limit).toMatchObject({
    available: false,
    sourceAvailable: true,
    artifactId: "oversize",
    gap: "artifact_text_source_limit_reached",
  });
  expect(limit).not.toHaveProperty("textPage");
});
