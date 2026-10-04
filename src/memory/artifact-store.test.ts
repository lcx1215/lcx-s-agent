import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore, type ArtifactRegistration } from "./artifact-store.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

let root: string;
let dbPath: string;
let store: ArtifactStore;
const base: ArtifactRegistration = {
  id: "run-result",
  owner: "central-harness",
  runId: "run-1",
  observedAt: "2026-10-04T10:00:00Z",
  cutoff: "2026-10-04T09:59:00Z",
  relativePath: "state/runs/result.json",
  mimeType: "application/json",
  summary: "Evidence determines judgment",
  conclusion: "hold for missing source",
  sourceReceiptRefs: ["receipt:run-1"],
};

async function write(relativePath: string, bytes: string | Buffer) {
  await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await fs.writeFile(path.join(root, relativePath), bytes);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-artifacts-"));
  dbPath = path.join(root, "memory.sqlite");
  store = ArtifactStore.open({ dbPath, workspaceDir: root });
});
afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("owner artifacts in the existing memory database", () => {
  it("does not feed mixed-media base64 to search or model readback", async () => {
    const encoded = JSON.stringify({
      schemaVersion: "lcx_agent_artifact_v1",
      owner: "tool",
      runId: "r",
      value: {
        content: [
          { type: "text", text: "actualtooltext" },
          { type: "image", mimeType: "image/png", data: "opaqueimagepayload" },
          { type: "audio", mimeType: "audio/wav", data: "opaqueaudiopayload" },
        ],
        details: { verdict: "actualconclusion" },
      },
    });
    await write(base.relativePath, encoded);
    await store.register(base);
    expect(store.search({ query: "actualtooltext" }).artifacts).toHaveLength(1);
    expect(store.search({ query: "actualconclusion" }).artifacts).toHaveLength(1);
    expect(store.search({ query: "opaqueimagepayload" }).artifacts).toHaveLength(0);
    const result = await store.read(base.id);
    expect(result.textProjection).toBe("metadata_and_text");
    expect(result.text).toContain("actualtooltext");
    expect(result.text).not.toContain("opaqueimagepayload");
    expect(result.artifact.sha256).toBe(createHash("sha256").update(encoded).digest("hex"));
  });

  it("retains ordinary financial data strings while removing only declared binary payloads", async () => {
    const value = {
      schemaVersion: "lcx_agent_artifact_v1",
      value: {
        content: [
          { type: "text", text: "answer", data: "CSVprofit42" },
          { type: "image", data: "secretimage" },
          { type: "audio_url", url: "data:audio;base64,opaqueaudio" },
        ],
        details: { data: "mathprice123", base64: "plainvaluenotbinary", b64: "ordinaryb64value" },
      },
    };
    await write(base.relativePath, JSON.stringify(value));
    await store.register(base);
    expect(store.search({ query: "CSVprofit42" }).artifacts).toHaveLength(1);
    expect(store.search({ query: "mathprice123" }).artifacts).toHaveLength(1);
    const read = await store.read(base.id);
    expect(read.text).toContain("plainvaluenotbinary");
    expect(read.text).toContain("ordinaryb64value");
    expect(read.text).not.toContain("secretimage");
    expect(read.text).not.toContain("opaqueaudio");
  });
  it("registers, searches, verifies full SHA and refuses identity changes", async () => {
    const text = '{"value":42,"marker":"unusualspread"}';
    await write(base.relativePath, text);
    const first = await store.register(base);
    expect(first.status).toBe("registered");
    expect(first.artifact.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect((await store.register(base)).status).toBe("unchanged");
    expect(store.search({ query: "unusualspread" }).artifacts).toEqual([first.artifact]);
    expect((await store.read(base.id)).text).toBe(text);
    await expect(store.register({ ...base, conclusion: "buy" })).rejects.toMatchObject({
      code: "artifact_identity_conflict",
    });
    await write(base.relativePath, '{"value":43}');
    await expect(store.read(base.id)).rejects.toMatchObject({
      code: "artifact_original_hash_mismatch",
    });
    await expect(store.register(base)).rejects.toMatchObject({
      code: "artifact_identity_conflict",
    });
  });

  it.each([
    ["json", "application/json", Buffer.from('{"profit":1}')],
    ["jsonl", "application/x-ndjson", Buffer.from('{"profit":1}\n{"profit":2}\n')],
    ["md", "text/markdown", Buffer.from("# result\n取证结论")],
    ["csv", "text/csv", Buffer.from("symbol,value\nABC,42\n")],
    ["png", "image/png", Buffer.from([137, 80, 78, 71, 0, 255])],
    ["pdf", "application/pdf", Buffer.from("%PDF-1.7\nopaque")],
    ["wav", "audio/wav", Buffer.from([82, 73, 70, 70, 0, 255])],
    ["unknown", "application/octet-stream", Buffer.from([255, 254, 253])],
  ])("retains exact %s bytes and reports opaque formats honestly", async (ext, mime, bytes) => {
    const item = { ...base, id: ext, relativePath: `state/runs/result.${ext}`, mimeType: mime };
    await write(item.relativePath, bytes);
    const { artifact } = await store.register(item);
    const read = await store.read(item.id);
    expect(read.artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(read.artifact.bytes).toBe(bytes.length);
    expect(read.truncated).toBe(false);
    if (mime.startsWith("text/") || mime.includes("json")) {
      expect(read.text).toBe(bytes.toString("utf8"));
      expect(artifact.format).toBe("text");
    } else {
      expect(read.text).toBeUndefined();
      expect(artifact.extractionStatus).toBe("opaque");
    }
  });

  it("indexes bounded valid UTF8 while preserving the full original hash", async () => {
    const text = "a".repeat(65535) + "证据".repeat(1000);
    await write(base.relativePath, text);
    const { artifact } = await store.register(base);
    const read = await store.read(base.id);
    expect(read.text).toBe("a".repeat(65535));
    expect(read.truncated).toBe(true);
    expect(artifact.bytes).toBe(Buffer.byteLength(text));
    expect(artifact.sha256).toBe(createHash("sha256").update(text).digest("hex"));
  });

  it("reports invalid UTF8 as opaque instead of inventing text", async () => {
    await write(base.relativePath, Buffer.from([255, 254, 253]));
    const { artifact } = await store.register(base);
    expect(artifact.extractionStatus).toBe("invalid_utf8");
    expect((await store.read(base.id)).text).toBeUndefined();
  });

  it("filters by actual source times and owner, keeping future cutoffs out", async () => {
    await write(base.relativePath, "marker");
    await store.register(base);
    expect(store.search({ query: "judgment", asOf: "2026-10-04T09:59:59Z" }).artifacts).toEqual([]);
    expect(store.search({ query: "judgment", owner: "unrelated" }).artifacts).toEqual([]);
    expect(
      store.search({ query: "judgment", asOf: "2026-10-04T10:00:00Z" }).artifacts,
    ).toHaveLength(1);
    await store.register({ ...base, id: "future", cutoff: "2026-10-05T00:00:00Z" });
    expect(
      store.search({ query: "judgment", asOf: "2026-10-04T11:00:00Z" }).artifacts,
    ).toHaveLength(1);
  });

  it.each([
    "../outside.json",
    "state/../MEMORY.md",
    "memory/current-research-line.md",
    "state/auth/profiles.json",
    "state/config.json",
    "state/provider-config.json",
    "/tmp/outside.json",
  ])("blocks unapproved path %s", async (relativePath) => {
    await expect(store.register({ ...base, relativePath })).rejects.toMatchObject({
      code: "artifact_path_blocked",
    });
  });

  it("registers module learning receipts but rejects symlink and hardlink aliases", async () => {
    await write("memory/module-learning-pipeline-plan-receipts/run.json", "registered source");
    await store.register({
      ...base,
      relativePath: "memory/module-learning-pipeline-plan-receipts/run.json",
    });
    await write("state/real.json", "source");
    await fs.symlink(path.join(root, "state/real.json"), path.join(root, "state/link.json"));
    await expect(
      store.register({ ...base, id: "link", relativePath: "state/link.json" }),
    ).rejects.toMatchObject({ code: "artifact_original_blocked" });
    await fs.link(path.join(root, "state/real.json"), path.join(root, "state/hard.json"));
    await expect(
      store.register({ ...base, id: "hard", relativePath: "state/hard.json" }),
    ).rejects.toMatchObject({ code: "artifact_original_blocked" });
  });

  it("rejects parent symlink aliases and checks registered originals again", async () => {
    await write(base.relativePath, "source");
    await store.register(base);
    await fs.rename(path.join(root, "state/runs"), path.join(root, "state/real-runs"));
    await fs.symlink(path.join(root, "state/real-runs"), path.join(root, "state/runs"));
    await expect(store.read(base.id)).rejects.toMatchObject({ code: "artifact_original_blocked" });
  });

  it("unifies trusted workspace aliases and rejects same id from another workspace", async () => {
    await write(base.relativePath, "canonical namespace");
    await store.register(base);
    await fs.symlink(root, path.join(root, "workspace-alias"));
    const alias = ArtifactStore.open({
      dbPath,
      workspaceDir: path.join(root, "workspace-alias"),
      readOnly: true,
    });
    try {
      expect((await alias.read(base.id)).text).toBe("canonical namespace");
    } finally {
      alias.close();
    }
    const other = path.join(root, "other-workspace");
    await fs.mkdir(path.join(other, "state/runs"), { recursive: true });
    await fs.writeFile(path.join(other, base.relativePath), "canonical namespace");
    const writer = ArtifactStore.open({ dbPath, workspaceDir: other });
    try {
      await expect(writer.register(base)).rejects.toMatchObject({
        code: "artifact_identity_conflict",
      });
    } finally {
      writer.close();
    }
  });

  it("does not index a truncated envelope's opaque media prefix", async () => {
    const encoded = JSON.stringify({
      schemaVersion: "lcx_agent_artifact_v1",
      value: { content: [{ type: "image", data: "opaquepayload".repeat(10000) }] },
    });
    await write(base.relativePath, encoded);
    await store.register(base);
    expect(store.search({ query: "opaquepayload" }).artifacts).toHaveLength(0);
    const read = await store.read(base.id);
    expect(read.text).toBeUndefined();
    expect(read.textProjection).toBe("metadata_and_text");
    expect(read.truncated).toBe(true);
  });

  it("names missing originals and unregistered IDs", async () => {
    await expect(store.register(base)).rejects.toMatchObject({ code: "artifact_original_missing" });
    await write(base.relativePath, "source");
    await store.register(base);
    await fs.rm(path.join(root, base.relativePath));
    await expect(store.read(base.id)).rejects.toMatchObject({ code: "artifact_original_missing" });
    await expect(store.read("unknown")).rejects.toMatchObject({ code: "artifact_not_registered" });
  });

  it("survives core reindex and reads through a strictly read-only handle", async () => {
    await write(base.relativePath, "persistent result");
    await store.register(base);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    const before = db.prepare("SELECT checksum FROM memory_index_migrations WHERE version=1").get();
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });
    db.exec("DELETE FROM chunks; DELETE FROM files");
    expect(
      db.prepare("SELECT checksum FROM memory_index_migrations WHERE version=1").get(),
    ).toEqual(before);
    db.close();
    const reader = ArtifactStore.open({ dbPath, workspaceDir: root, readOnly: true });
    try {
      expect(reader.search({ query: "persistent" }).artifacts).toHaveLength(1);
      await expect(reader.register(base)).rejects.toMatchObject({
        code: "artifact_store_read_only",
      });
      expect((await reader.read(base.id)).text).toBe("persistent result");
    } finally {
      reader.close();
    }
  });

  it("keeps workspace authority scoped and exposes bounded LIKE fallback", async () => {
    await write(base.relativePath, "like marker");
    await store.register(base);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE owner_artifacts_fts");
    db.close();
    const reader = ArtifactStore.open({ dbPath, workspaceDir: root, readOnly: true });
    await fs.mkdir(path.join(root, "another"));
    const unrelated = ArtifactStore.open({
      dbPath,
      workspaceDir: path.join(root, "another"),
      readOnly: true,
    });
    try {
      expect(reader.search({ query: "like marker" })).toMatchObject({
        backend: "like",
        limitation: "artifact_fts_unavailable_bounded_like",
      });
      expect(reader.search({ query: "%" }).artifacts).toEqual([]);
      expect(unrelated.search({ query: "judgment" }).artifacts).toEqual([]);
      await expect(unrelated.read(base.id)).rejects.toMatchObject({
        code: "artifact_not_registered",
      });
    } finally {
      reader.close();
      unrelated.close();
    }
  });
});

it("removes nested data URLs only inside declared media blocks", async () => {
  const value = {
    schemaVersion: "lcx_agent_artifact_v1",
    value: {
      content: [
        { type: "audio_url", audio_url: { url: "data:audio;base64,hiddenmedia" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,hiddenimageurl" } },
        { type: "input_audio", input_audio: { data: "hiddennestedbinary", format: "wav" } },
      ],
      details: { url: "https://math-source", data: "regularcashvalue" },
    },
  };
  await write(base.relativePath, JSON.stringify(value));
  await store.register(base);
  const read = await store.read(base.id);
  expect(read.text).not.toContain("hiddenmedia");
  expect(read.text).not.toContain("hiddennestedbinary");
  expect(read.text).not.toContain("hiddenimageurl");
  expect(read.text).toContain("regularcashvalue");
  expect(read.text).toContain("https://math-source");
});
