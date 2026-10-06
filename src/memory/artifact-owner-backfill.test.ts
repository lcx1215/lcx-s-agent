import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recordAgentArtifact } from "../agents/artifact-result-recording.js";
import type { OpenClawConfig } from "../config/config.js";
import { backfillOwnerArtifacts } from "./artifact-owner-backfill.js";
import { ArtifactStore } from "./artifact-store.js";
let root: string;
let dbPath: string;
let config: OpenClawConfig;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-owner-backfill-"));
  dbPath = path.join(root, "memory.sqlite");
  config = { agents: { defaults: { workspace: root, memorySearch: { store: { path: dbPath } } } } };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function write(relativePath: string, value: unknown) {
  await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  const bytes = JSON.stringify(value);
  await fs.writeFile(path.join(root, relativePath), bytes);
  return bytes;
}
it("indexes declared original history, exact SHA and repeats idempotently without rewriting files", async () => {
  const central = await write("state/lcx-central-agent-runs/run-1.json", {
    runId: "run-1",
    observedAt: "2026-10-04T10:00:00Z",
    note: "specificresult314",
  });
  await write("state/learning-workflow/runs/run-2.json", {
    updatedAt: "2026-10-04T11:00:00Z",
    summary: { keep: 1 },
  });
  await write("memory/module-learning-pipeline-plan-receipts/2026-10-04/plan.json", {
    generatedAt: "2026-10-04T12:00:00Z",
    targetModule: "agent_workflow_memory",
  });
  await write("memory/module-learning-pipeline-reviews/2026-10-04/review.json", {
    generatedAt: "2026-10-04T12:00:00Z",
    status: "receipt_only",
  });
  const first = await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root });
  expect(first).toMatchObject({
    status: "complete",
    scanned: 4,
    registered: 4,
    unchanged: 0,
    truncated: false,
    gapCount: 0,
  });
  const reader = ArtifactStore.open({ dbPath, workspaceDir: root, readOnly: true });
  try {
    const [result] = reader.search({ query: "specificresult314" }).artifacts;
    expect(result.sha256).toBe(createHash("sha256").update(central).digest("hex"));
    expect((await reader.read(result.id)).text).toBe(central);
  } finally {
    reader.close();
  }
  const second = await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root });
  expect(second).toMatchObject({ registered: 0, unchanged: 4, gapCount: 0 });
  expect(
    await fs.readFile(path.join(root, "state/lcx-central-agent-runs/run-1.json"), "utf8"),
  ).toBe(central);
  expect(second.excluded).toContainEqual({
    relativePath: "logs/lcx-central-agent-log-latest.jsonl",
    reason: "mutable_jsonl_excluded_immutable_run_snapshots_indexed",
  });
});
it("aligns immutable result envelopes with the original recorder identity and summary", async () => {
  const value = { content: [{ type: "text", text: "quantbetareadback" }], details: { beta: 0.38 } };
  const native = await recordAgentArtifact({
    config,
    agentId: "main",
    workspaceDir: root,
    owner: "financial-math",
    runId: "r",
    value,
    sourceReceiptRefs: ["receipt:math"],
  });
  expect(native.status).toBe("registered");
  const receipt = await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root });
  expect(receipt).toMatchObject({ unchanged: 1, registered: 0, gapCount: 0 });
  const reader = ArtifactStore.open({ dbPath, workspaceDir: root, readOnly: true });
  try {
    expect(reader.search({ query: "quantbetareadback" }).artifacts[0].id).toBe(native.id);
  } finally {
    reader.close();
  }
});
it("names partial failures, pending omissions and global truncation", async () => {
  await write("state/lcx-central-agent-runs/1.json", { runId: "one" });
  await write("state/lcx-central-agent-runs/2.json", { runId: "two" });
  const limited = await backfillOwnerArtifacts({
    config,
    agentId: "main",
    workspaceDir: root,
    limit: 1,
  });
  expect(limited).toMatchObject({ status: "partial", scanned: 1, registered: 1, truncated: true });
  await fs.writeFile(path.join(root, "state/lcx-central-agent-runs/bad.json"), "broken{");
  await write("state/artifacts/.pending-native.json", {
    schemaVersion: "lcx_agent_artifact_v1",
    owner: "bad",
    runId: "pending",
  });
  const all = await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root });
  expect(all.status).toBe("partial");
  expect(all.gaps).toContainEqual({
    relativePath: "state/lcx-central-agent-runs/bad.json",
    reason: "artifact_backfill_json_invalid",
  });
  expect(all.coverage.find((c) => c.root === "state/artifacts")?.excluded).toBe(1);
});
it("does not read broad state or protected memory and rejects symlink owner roots", async () => {
  await write("state/unrelated/private.json", { secret: "shouldnotbeindexed" });
  await write("memory/current-research-line.md", { secret: "protectedshouldnotbeindexed" });
  await fs.mkdir(path.join(root, "state"), { recursive: true });
  await fs.symlink(
    path.join(root, "state/unrelated"),
    path.join(root, "state/lcx-central-agent-runs"),
  );
  const result = await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root });
  expect(result).toMatchObject({ status: "partial", registered: 0, scanned: 0 });
  expect(result.gaps).toContainEqual({
    relativePath: "state/lcx-central-agent-runs",
    reason: "artifact_backfill_alias_blocked",
  });
});
it("reports bounded depth and disabled recall", async () => {
  await write("state/learning-workflow/runs/a/b/c/d/e.json", { note: "deeprecord" });
  expect(
    await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root }),
  ).toMatchObject({ status: "partial", scanned: 0, truncated: true });
  const disabled: OpenClawConfig = { agents: { defaults: { memorySearch: { enabled: false } } } };
  expect(
    await backfillOwnerArtifacts({ config: disabled, agentId: "main", workspaceDir: root }),
  ).toMatchObject({
    status: "unavailable",
    registered: 0,
    gaps: [{ reason: "artifact_backfill_memory_disabled" }],
  });
});
it("identifies mtime fallback rather than fabricating a receipt observation timestamp", async () => {
  await write("state/learning-workflow/runs/mtime.json", { summary: { pending: 0 } });
  const stamp = "2026-09-30T10:00:00Z";
  await fs.utimes(
    path.join(root, "state/learning-workflow/runs/mtime.json"),
    new Date(stamp),
    new Date(stamp),
  );
  await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root });
  const reader = ArtifactStore.open({ dbPath, workspaceDir: root, readOnly: true });
  try {
    expect(reader.search({ query: "file_mtime" }).artifacts[0]).toMatchObject({
      observedAt: "2026-09-30T10:00:00.000Z",
    });
  } finally {
    reader.close();
  }
});

it("preserves explicitly source-timed existing envelopes instead of replacing them with file mtime", async () => {
  const recorded = await recordAgentArtifact({
    config,
    agentId: "main",
    workspaceDir: root,
    owner: "central-harness",
    runId: "explicit",
    observedAt: "2026-01-01T00:00:00Z",
    value: { note: "explicit source cutoff" },
  });
  expect(recorded.status).toBe("registered");
  expect(
    await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root }),
  ).toMatchObject({ unchanged: 1, gapCount: 0 });
});
it("blocks aliases in root ancestors before reading any original file", async () => {
  const other = path.join(root, "otherwise-private");
  await fs.mkdir(path.join(other, "learning-workflow/runs"), { recursive: true });
  await fs.writeFile(
    path.join(other, "learning-workflow/runs/source.json"),
    '{"note":"unreadable-by-scope"}',
  );
  await fs.symlink(other, path.join(root, "state"));
  const receipt = await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root });
  expect(receipt.scanned).toBe(0);
  expect(receipt.registered).toBe(0);
  expect(receipt.gaps.some((g) => g.reason === "artifact_backfill_alias_blocked")).toBe(true);
});

it("defers expired recovery without opening the store or changing original history", async () => {
  const original = await write("state/lcx-central-agent-runs/one.json", { runId: "one" });
  const receipt = await backfillOwnerArtifacts({
    config,
    agentId: "main",
    workspaceDir: root,
    deadlineMs: Date.now() - 1,
  });
  expect(receipt).toMatchObject({
    status: "partial",
    registered: 0,
    scanned: 0,
    truncated: true,
    gaps: [{ relativePath: "", reason: "artifact_backfill_deadline_reached" }],
  });
  await expect(fs.stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(root, "state/lcx-central-agent-runs/one.json"), "utf8")).toBe(
    original,
  );
});

it("stops between registrations and a later default pass recovers idempotently", async () => {
  await write("state/lcx-central-agent-runs/1.json", { runId: "one" });
  await write("state/lcx-central-agent-runs/2.json", { runId: "two" });
  const deadline = Date.now() + 60000;
  let expired = false;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => (expired ? deadline : realNow()));
  const register = Reflect.get(ArtifactStore.prototype, "register");
  vi.spyOn(ArtifactStore.prototype, "register").mockImplementation(
    async function (this: ArtifactStore, input) {
      const result = await register.call(this, input);
      expired = true;
      return result;
    },
  );
  const first = await backfillOwnerArtifacts({
    config,
    agentId: "main",
    workspaceDir: root,
    deadlineMs: deadline,
  });
  expect(first).toMatchObject({ status: "partial", registered: 1, scanned: 1, truncated: true });
  expect(first.gaps).toEqual([{ relativePath: "", reason: "artifact_backfill_deadline_reached" }]);
  expect(first.coverage[0].status).toBe("partial");
  vi.restoreAllMocks();
  const second = await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root });
  expect(second).toMatchObject({
    status: "complete",
    registered: 1,
    unchanged: 1,
    truncated: false,
  });
});

it("recovers an explicitly observed source age after the file landed but DB indexing failed", async () => {
  const blockedDb = path.join(root, "blocked-db");
  await fs.mkdir(blockedDb);
  const failedConfig = {
    agents: { defaults: { workspace: root, memorySearch: { store: { path: blockedDb } } } },
  };
  const { recordAgentArtifact } = await import("../agents/artifact-result-recording.js");
  const oldTime = "2026-09-01T08:00:00.000Z";
  const value = { checkedAt: oldTime, summary: { costUnknown: true } };
  const failed = await recordAgentArtifact({
    config: failedConfig,
    agentId: "main",
    workspaceDir: root,
    owner: "problemRadar",
    runId: "index-failed-original",
    observedAt: oldTime,
    value,
  });
  expect(failed.status).toBe("unavailable");
  expect(failed.relativePath).toEqual(expect.any(String));
  const source = path.join(root, failed.relativePath!);
  const now = new Date();
  await fs.utimes(source, now, now);
  const recovery = await backfillOwnerArtifacts({ config, agentId: "main", workspaceDir: root });
  expect(recovery.status).toBe("complete");
  const store = ArtifactStore.open({ dbPath, workspaceDir: root });
  try {
    const read = await store.read(failed.id!);
    expect(read.artifact.observedAt).toBe(oldTime);
    expect(read.artifact.sha256).toBe(failed.sha256);
    expect(JSON.parse(read.text!).value).toEqual(value);
  } finally {
    store.close();
  }
});
