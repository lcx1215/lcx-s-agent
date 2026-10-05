import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as safeRead from "../../infra/fs-safe.js";
import { createFinanceResearchRunsReadTool } from "./finance-research-runs-read-tool.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-runs-read-"));
  roots.push(root);
  return root;
}

async function seedRun(root: string): Promise<void> {
  const runDir = path.join(root, "state", "finance-research-runs", "2026-09-20", "morning");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "runtime.json"),
    JSON.stringify({ manifest: { revision: "test_v1", models: ["fast-a"] } }),
  );
  await fs.writeFile(
    path.join(runDir, "response-01.json"),
    JSON.stringify({
      stage: "review",
      model: "fast-a",
      status: 200,
      choices: [{ index: 0, message: { role: "assistant", content: "窗口最大回撤 -28.689%" } }],
    }),
  );
}

type Payload = {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  totalRuns?: number;
  runs?: Array<{ id: string; files: number; revision?: string }>;
  files?: string[];
  hits?: Array<{ file: string; stage?: string; snippet: string }>;
};

const call = async (params: Record<string, unknown>): Promise<Payload> => {
  const tool = createFinanceResearchRunsReadTool();
  const result = await tool.execute("call", params);
  const block = result.content?.[0];
  const text = block && "text" in block ? block.text : "{}";
  return JSON.parse(text) as Payload;
};

it("reports an absent runs directory as empty history rather than an error", async () => {
  const root = await workspace();
  const payload = await call({ workspaceDir: root, action: "list" });
  expect(payload.available).toBe(false);
  expect(payload.reason).toBe("no research runs directory");
  expect(payload.runs).toEqual([]);
});

it("lists stored runs with their manifest revision", async () => {
  const root = await workspace();
  await seedRun(root);
  const payload = await call({ workspaceDir: root, action: "list" });
  expect(payload.available).toBe(true);
  expect(payload.totalRuns).toBe(1);
  expect(payload.runs?.[0]?.id).toBe("2026-09-20/morning");
  expect(payload.runs?.[0]?.revision).toBe("test_v1");
  expect(payload.runs?.[0]?.files).toBe(2);
});

it("returns a readable root run ID and lets a caller consume its file index", async () => {
  const root = await workspace();
  try {
    await seedRun(root);
    const saved = { status: "captured", source: "root-receipt" };
    await fs.writeFile(
      path.join(root, "state", "finance-research-runs", "saved-result.json"),
      JSON.stringify(saved),
    );
    const listing = await call({ workspaceDir: root, action: "list" });
    expect(listing.runs?.map((run) => run.id)).toEqual([".", "2026-09-20/morning"]);
    const run = listing.runs?.[0]?.id;
    const index = await call({ workspaceDir: root, action: "read", run });
    expect(index).toMatchObject({ ok: true, available: true, files: ["saved-result.json"] });
    expect(
      await call({ workspaceDir: root, action: "read", run, file: index.files?.[0] }),
    ).toMatchObject({ ok: true, available: true, run: ".", json: saved });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("searches stored run text and reports the containing run and file", async () => {
  const root = await workspace();
  await seedRun(root);
  const payload = await call({ workspaceDir: root, action: "search", query: "最大回撤" });
  expect(payload.hits).toHaveLength(1);
  expect(payload.hits?.[0]?.file).toBe("response-01.json");
  expect(payload.hits?.[0]?.stage).toBe("review");
  expect(payload.hits?.[0]?.snippet).toContain("最大回撤");
});

it("refuses a run path that escapes the runs directory", async () => {
  const root = await workspace();
  await seedRun(root);
  const payload = await call({ workspaceDir: root, action: "read", run: "../outside" });
  expect(payload.ok).toBe(false);
});

async function saveValue(value: unknown) {
  const root = await workspace();
  const dir = path.join(root, "state", "finance-research-runs", "day");
  await fs.mkdir(dir, { recursive: true });
  const text = JSON.stringify(value);
  const target = path.join(dir, "result.json");
  await fs.writeFile(target, text);
  return { root, target, text };
}
async function readValue(root: string, field?: string, signal?: AbortSignal) {
  return createFinanceResearchRunsReadTool().execute(
    "read",
    {
      workspaceDir: root,
      action: "read",
      run: "day",
      file: "result.json",
      ...(field === undefined ? {} : { field }),
    },
    signal,
  );
}
function details(result: Awaited<ReturnType<typeof readValue>>) {
  return result.details as Record<string, unknown>;
}
function payloadBytes(result: Awaited<ReturnType<typeof readValue>>) {
  const block = result.content[0];
  return Buffer.byteLength(block && "text" in block ? block.text : "");
}

it("bounds a real 4MiB failed research without returning its full parsed tree; reads small nested conclusions exactly", async () => {
  const value = {
    status: "needs_review",
    quality: { status: "failed", quality: { passed: false } },
    gates: [{ passed: true }, { reason: "保留原失败原因" }],
    moduleExecution: { nodes: [{}, {}, { toolCalls: [{ outputSummary: "实际计算: beta=0.7" }] }] },
    giant: "x".repeat(4 * 1024 * 1024),
  };
  const saved = await saveValue(value);
  const read = await readValue(saved.root);
  const result = details(read);
  expect(result).toMatchObject({
    ok: true,
    truncated: true,
    sourceBytes: Buffer.byteLength(saved.text),
    sourceSha256: createHash("sha256").update(saved.text).digest("hex"),
  });
  expect(result.json).toBeUndefined();
  expect(result.keys).toContain("status");
  expect(payloadBytes(read)).toBeLessThanOrEqual(8000);
  for (const [field, selectedValue] of [
    ["/status", "needs_review"],
    ["/quality/status", "failed"],
    ["/quality/quality/passed", false],
    ["/gates/1/reason", "保留原失败原因"],
    ["/moduleExecution/nodes/2/toolCalls/0/outputSummary", "实际计算: beta=0.7"],
  ]) {
    const fieldRead = await readValue(saved.root, String(field));
    expect(details(fieldRead)).toMatchObject({
      selectedValue,
      selectionComplete: true,
      truncated: false,
    });
    const block = fieldRead.content[0];
    const text = block && "text" in block ? block.text : "";
    expect(text.indexOf("selectedValue")).toBeLessThan(text.indexOf("sourceSha256"));
    expect(payloadBytes(fieldRead)).toBeLessThanOrEqual(8000);
  }
  const missing = details(await readValue(saved.root, "/quality/finalArtifact"));
  expect(missing).toMatchObject({
    ok: false,
    gap: "finance_research_field_missing",
    sourceSha256: result.sourceSha256,
  });
});

it("uses final pretty UTF8 budget for a large selection and omits giant keys without inventing pointers", async () => {
  const saved = await saveValue({
    selected: {
      normal: "研究".repeat(5000),
      ["k".repeat(9000)]: 1,
      ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key-${i}`, i])),
    },
  });
  const result = await readValue(saved.root, "/selected");
  const selected = details(result);
  expect(selected).toMatchObject({ truncated: true, selectionComplete: false });
  expect(selected.selectedValue).toBeUndefined();
  expect((selected.keys as string[]).length).toBeLessThanOrEqual(40);
  expect((selected.keys as string[]).every((key) => key.length < 9000)).toBe(true);
  expect(Number(selected.keysOmitted)).toBeGreaterThan(0);
  expect(payloadBytes(result)).toBeLessThanOrEqual(8000);
  expect(String(selected.text)).not.toContain("�");
});

it.each([null, false, 7, "scalar", [null, 2]])(
  "preserves scalar/null/array complete JSON and root pointer: %j",
  async (value) => {
    const saved = await saveValue(value);
    expect(details(await readValue(saved.root)).json).toEqual(value);
    expect(details(await readValue(saved.root, ""))).toMatchObject({
      selectedValue: value,
      selectionComplete: true,
      truncated: false,
    });
  },
);

it("uses RFC6901 escapes, exact whitespace keys, own properties and canonical array indices", async () => {
  const saved = await saveValue({
    "a/b": { "~": 3 },
    " ": "space",
    "": "empty",
    array: [null, 8],
    constructor: "own",
  });
  for (const [field, selectedValue] of [
    ["/a~1b/~0", 3],
    ["/ ", "space"],
    ["/", "empty"],
    ["/array/0", null],
    ["/array/1", 8],
    ["/constructor", "own"],
  ]) {
    expect(details(await readValue(saved.root, String(field)))).toMatchObject({ selectedValue });
  }
  for (const field of ["/array/01", "/array/-", "/array/length", "/__proto__", "/toString"]) {
    expect(details(await readValue(saved.root, field))).toMatchObject({
      gap: "finance_research_field_missing",
    });
  }
  for (const field of ["bad", "/bad~", "/bad~2", "/" + "a".repeat(1024), "/a".repeat(17)]) {
    expect(details(await readValue(saved.root, field))).toMatchObject({
      gap: "finance_research_field_invalid",
    });
  }
});

it("reads and parses an original only once per read or search, retaining original SHA/mtime", async () => {
  const saved = await saveValue({ status: "failed", message: "needle" });
  const readSpy = vi.spyOn(safeRead, "readFileWithinRoot");
  const result = details(await readValue(saved.root));
  expect(readSpy).toHaveBeenCalledTimes(1);
  expect(result.sourceModifiedAt).toBe((await fs.stat(saved.target)).mtime.toISOString());
  readSpy.mockClear();
  const search = await createFinanceResearchRunsReadTool().execute("search", {
    workspaceDir: saved.root,
    action: "search",
    query: "needle",
  });
  expect(readSpy).toHaveBeenCalledTimes(1);
  expect((search.details as { hits: unknown[] }).hits).toHaveLength(1);
  expect(payloadBytes(search)).toBeLessThanOrEqual(8000);
});

it("rejects an oversize original rather than accepting a truncated parse", async () => {
  const saved = await saveValue({ status: "failed" });
  await fs.truncate(saved.target, 16 * 1024 * 1024 + 1);
  expect(details(await readValue(saved.root))).toMatchObject({
    ok: false,
    gap: "finance_research_read_too_large",
  });
});

it("rejects file symlinks, hardlinks, escaping directories and file traversal", async () => {
  const saved = await saveValue({ status: "failed" });
  const outside = await saveValue({ secret: "must-not-return" });
  await fs.rm(saved.target);
  await fs.symlink(outside.target, saved.target);
  expect(details(await readValue(saved.root))).toMatchObject({
    ok: false,
    gap: "finance_research_symlink_blocked",
  });
  await fs.rm(saved.target);
  await fs.link(outside.target, saved.target);
  expect(details(await readValue(saved.root))).toMatchObject({
    ok: false,
    gap: "finance_research_read_invalid_path",
  });
  for (const file of ["../result.json", "a/../../result.json", "a\\result.json"]) {
    expect(
      (
        await createFinanceResearchRunsReadTool().execute("bad", {
          workspaceDir: saved.root,
          action: "read",
          run: "day",
          file,
        })
      ).details,
    ).toMatchObject({ ok: false, gap: "finance_research_path_blocked" });
  }
  await fs.rm(path.join(saved.root, "state", "finance-research-runs"), { recursive: true });
  await fs.symlink(
    path.join(outside.root, "state", "finance-research-runs"),
    path.join(saved.root, "state", "finance-research-runs"),
  );
  for (const action of ["list", "search", "read"]) {
    expect(
      (
        await createFinanceResearchRunsReadTool().execute("outside", {
          workspaceDir: saved.root,
          action,
          run: "day",
          file: "result.json",
          query: "secret",
        })
      ).details,
    ).toMatchObject({ ok: false, gap: "finance_research_symlink_blocked" });
  }
});

it("does not follow a symlinked runtime manifest while listing", async () => {
  const saved = await saveValue({ status: "failed" });
  const outside = await saveValue({ manifest: { revision: "SECRET" } });
  await fs.symlink(outside.target, path.join(path.dirname(saved.target), "runtime.json"));
  const result = await call({ workspaceDir: saved.root, action: "list" });
  expect(result.runs?.[0]?.revision).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

it("rejects a replacement or in-place change after safe read before returning source evidence", async () => {
  const saved = await saveValue({ status: "failed" });
  const original = safeRead.readFileWithinRoot;
  vi.spyOn(safeRead, "readFileWithinRoot").mockImplementationOnce(async (params) => {
    const result = await original(params);
    await fs.writeFile(saved.target, '{"status":"different"}');
    return result;
  });
  expect(details(await readValue(saved.root))).toMatchObject({
    ok: false,
    gap: "finance_research_read_changed",
  });
});

it("checks cancellation before and after reading and rejects invalid UTF8", async () => {
  const saved = await saveValue({ status: "failed" });
  const abort = new AbortController();
  abort.abort();
  expect(details(await readValue(saved.root, undefined, abort.signal))).toMatchObject({
    gap: "finance_research_read_cancelled",
  });
  const later = new AbortController();
  const original = safeRead.readFileWithinRoot;
  vi.spyOn(safeRead, "readFileWithinRoot").mockImplementationOnce(async (params) => {
    const result = await original(params);
    later.abort();
    return result;
  });
  expect(details(await readValue(saved.root, undefined, later.signal))).toMatchObject({
    gap: "finance_research_read_cancelled",
  });
  vi.restoreAllMocks();
  await fs.writeFile(saved.target, Buffer.from([0xff, 0xfe]));
  expect(details(await readValue(saved.root))).toMatchObject({
    gap: "finance_research_read_invalid_utf8",
  });
});

it("rejects non-string fields instead of returning a root result", async () => {
  const saved = await saveValue({ status: "failed" });
  expect(
    (
      await createFinanceResearchRunsReadTool().execute("field", {
        workspaceDir: saved.root,
        action: "read",
        run: "day",
        file: "result.json",
        field: 1,
      })
    ).details,
  ).toMatchObject({ ok: false, gap: "finance_research_field_invalid" });
});
