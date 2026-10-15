import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { publishMemoryIndex } from "./memory-index-publication.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
import { requireNodeSqlite } from "./sqlite.js";

const roots: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(async () => {
  for (const handle of handles.splice(0).toReversed()) {
    try {
      handle.close();
    } catch {}
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(ftsEnabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-publish-"));
  roots.push(root);
  const targetPath = path.join(root, "index.sqlite");
  const preparedPath = path.join(root, "prepared.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  const target = new DatabaseSync(targetPath, { allowExtension: true });
  const prepared = new DatabaseSync(preparedPath, { allowExtension: true });
  handles.push(target, prepared);
  for (const db of [target, prepared]) {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled,
    });
  }
  const writer = ArtifactStore.open({ dbPath: targetPath, workspaceDir: root });
  handles.push(writer);
  const register = async (id: string) => {
    const relativePath = `state/runs/${id}.json`;
    await fs.mkdir(path.join(root, "state/runs"), { recursive: true });
    await fs.writeFile(path.join(root, relativePath), JSON.stringify({ marker: `${id}marker` }));
    return writer.register({
      id,
      owner: "central-harness",
      runId: `run-${id}`,
      observedAt: "2026-10-04T10:00:00Z",
      relativePath,
      mimeType: "application/json",
      summary: `${id}marker original evidence`,
      conclusion: "hold",
    });
  };
  return { root, target, prepared, targetPath, preparedPath, writer, register };
}

function seed(db: DatabaseSync, id: string, ftsEnabled = true) {
  db.prepare("INSERT INTO meta(key,value) VALUES('memory_index_meta_v1',?)").run(id);
  db.prepare("INSERT INTO files(path,source,hash,mtime,size) VALUES(?,'memory',?,1,10)").run(
    id,
    id,
  );
  db.prepare(
    "INSERT INTO chunks(id,path,source,start_line,end_line,hash,model,text,embedding,updated_at) VALUES(?,?,'memory',1,1,?,'fixture',?,'[]',1)",
  ).run(id, id, id, `${id}memorymarker`);
  db.prepare(
    "INSERT INTO embedding_cache(provider,model,provider_key,hash,embedding,dims,updated_at) VALUES('fixture','fixture','fixture',?,'[]',0,1)",
  ).run(id);
  if (ftsEnabled) {
    db.prepare(
      "INSERT INTO chunks_fts(text,id,path,source,model,start_line,end_line) VALUES(?,?,?,'memory','fixture',1,1)",
    ).run(`${id}memorymarker`, id, id);
  }
}

function memoryRows(db: DatabaseSync) {
  return Object.fromEntries(
    ["meta", "files", "chunks", "embedding_cache", "chunks_fts"].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table}`).all(),
    ]),
  );
}

describe("same-file prepared memory publication", () => {
  it("preserves second-open owner registrations, their FTS, and migration ledger across a memory-only publication", async () => {
    const run = await fixture();
    seed(run.target, "old");
    await run.register("before");
    const inode = (await fs.stat(run.targetPath)).ino;
    const ledger = run.target
      .prepare("SELECT * FROM memory_index_migrations ORDER BY version")
      .all();
    seed(run.prepared, "new");
    // This second handle writes while the separately prepared rebuild exists.
    await run.register("during");
    run.prepared.close();
    publishMemoryIndex({ db: run.target, preparedPath: run.preparedPath });
    await run.register("after");
    expect((await fs.stat(run.targetPath)).ino).toBe(inode);
    expect(run.target.prepare("SELECT id FROM chunks").all()).toEqual([{ id: "new" }]);
    expect(run.target.prepare("SELECT value FROM meta").get()).toEqual({ value: "new" });
    expect(run.target.prepare("SELECT path FROM files").all()).toEqual([{ path: "new" }]);
    expect(run.target.prepare("SELECT hash FROM embedding_cache").all()).toEqual([{ hash: "new" }]);
    expect(
      run.target
        .prepare("SELECT id FROM chunks_fts WHERE chunks_fts MATCH 'newmemorymarker'")
        .all(),
    ).toEqual([{ id: "new" }]);
    expect(
      run.target
        .prepare("SELECT id FROM chunks_fts WHERE chunks_fts MATCH 'oldmemorymarker'")
        .all(),
    ).toEqual([]);
    expect(
      run.target.prepare("SELECT * FROM memory_index_migrations ORDER BY version").all(),
    ).toEqual(ledger);
    for (const id of ["before", "during", "after"]) {
      expect(run.writer.search({ query: `${id}marker` }).artifacts.map((item) => item.id)).toEqual([
        id,
      ]);
      expect((await run.writer.read(id)).artifact.id).toBe(id);
    }
    expect(
      run.target
        .prepare("PRAGMA database_list")
        .all()
        .map((row) => row.name),
    ).toEqual(["main"]);
  });

  it("rolls back memory and FTS replacement on an invalid prepared virtual schema without disturbing owner rows", async () => {
    const run = await fixture();
    seed(run.target, "old");
    seed(run.prepared, "new");
    await run.register("before");
    const before = memoryRows(run.target);
    const artifacts = run.target.prepare("SELECT * FROM owner_artifacts").all();
    run.prepared.exec("CREATE TABLE chunks_vec (id TEXT, embedding BLOB)");
    run.prepared.close();
    expect(() => publishMemoryIndex({ db: run.target, preparedPath: run.preparedPath })).toThrow(
      "Unexpected prepared memory virtual schema: chunks_vec",
    );
    expect(memoryRows(run.target)).toEqual(before);
    expect(run.target.prepare("SELECT * FROM owner_artifacts").all()).toEqual(artifacts);
    expect(run.writer.search({ query: "beforemarker" }).artifacts).toHaveLength(1);
    expect(
      run.target
        .prepare("PRAGMA database_list")
        .all()
        .map((row) => row.name),
    ).toEqual(["main"]);
    await run.register("after");
    expect(run.writer.search({ query: "aftermarker" }).artifacts).toHaveLength(1);
  });

  it("rolls back partial core replacement when the prepared core is incomplete", async () => {
    const run = await fixture();
    seed(run.target, "old");
    seed(run.prepared, "new");
    const before = memoryRows(run.target);
    run.prepared.exec("DROP TABLE embedding_cache");
    run.prepared.close();
    expect(() => publishMemoryIndex({ db: run.target, preparedPath: run.preparedPath })).toThrow(
      /embedding_cache/,
    );
    expect(memoryRows(run.target)).toEqual(before);
  });

  it("removes stale memory FTS when the prepared index has no FTS, retaining owner FTS", async () => {
    const run = await fixture();
    seed(run.target, "old");
    seed(run.prepared, "new", false);
    run.prepared.exec("DROP TABLE chunks_fts");
    await run.register("before");
    run.prepared.close();
    publishMemoryIndex({ db: run.target, preparedPath: run.preparedPath });
    expect(
      run.target.prepare("SELECT name FROM sqlite_master WHERE name='chunks_fts'").get(),
    ).toBeUndefined();
    expect(run.target.prepare("SELECT id FROM chunks").all()).toEqual([{ id: "new" }]);
    expect(run.writer.search({ query: "beforemarker" }).artifacts).toHaveLength(1);
  });

  it("publishes without either memory FTS table", async () => {
    const run = await fixture(false);
    seed(run.target, "old", false);
    seed(run.prepared, "new", false);
    run.prepared.close();
    publishMemoryIndex({ db: run.target, preparedPath: run.preparedPath });
    expect(run.target.prepare("SELECT id FROM chunks").all()).toEqual([{ id: "new" }]);
  });

  it("changes real sqlite-vec dimensions atomically and clears vectors absent from a later prepared index", async ({
    skip,
  }) => {
    const run = await fixture();
    const loaded = await Promise.all(
      [run.target, run.prepared].map((db) => loadSqliteVecExtension({ db })),
    );
    if (loaded.some((result) => !result.ok)) {
      skip();
    }
    seed(run.target, "old");
    seed(run.prepared, "new");
    run.target.exec(
      "CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])",
    );
    run.prepared.exec(
      "CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3])",
    );
    run.target.prepare("INSERT INTO chunks_vec(id,embedding) VALUES(?,?)").run("old", "[1,2]");
    run.prepared.prepare("INSERT INTO chunks_vec(id,embedding) VALUES(?,?)").run("new", "[1,2,3]");
    await run.register("before");
    run.prepared.close();
    publishMemoryIndex({ db: run.target, preparedPath: run.preparedPath });
    expect(
      run.target
        .prepare("SELECT id FROM chunks_vec WHERE embedding MATCH ? AND k=1")
        .all("[1,2,3]"),
    ).toEqual([{ id: "new" }]);
    expect(run.writer.search({ query: "beforemarker" }).artifacts).toHaveLength(1);
    const { DatabaseSync } = requireNodeSqlite();
    const noVectorPath = path.join(run.root, "no-vector.sqlite");
    const noVector = new DatabaseSync(noVectorPath);
    handles.push(noVector);
    ensureMemoryIndexSchema({
      db: noVector,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    seed(noVector, "later", false);
    noVector.close();
    publishMemoryIndex({ db: run.target, preparedPath: noVectorPath });
    expect(
      run.target.prepare("SELECT name FROM sqlite_master WHERE name='chunks_vec'").get(),
    ).toBeUndefined();
    expect(run.target.prepare("SELECT id FROM chunks").all()).toEqual([{ id: "later" }]);
    expect(run.writer.search({ query: "beforemarker" }).artifacts).toHaveLength(1);
  });
  it("fails closed when old vectors require a module unavailable to the target connection", async ({
    skip,
  }) => {
    const run = await fixture();
    const loaded = await loadSqliteVecExtension({ db: run.target });
    if (!loaded.ok) {
      skip();
    }
    seed(run.target, "old");
    seed(run.prepared, "new");
    await run.register("before");
    run.target.exec(
      "CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])",
    );
    run.target.prepare("INSERT INTO chunks_vec(id,embedding) VALUES(?,?)").run("old", "[1,2]");
    run.target.close();
    const { DatabaseSync } = requireNodeSqlite();
    const targetWithoutExtension = new DatabaseSync(run.targetPath, { allowExtension: false });
    handles.push(targetWithoutExtension);
    const before = memoryRows(targetWithoutExtension);
    run.prepared.close();
    expect(() =>
      publishMemoryIndex({ db: targetWithoutExtension, preparedPath: run.preparedPath }),
    ).toThrow(/no such module.*vec0/);
    expect(memoryRows(targetWithoutExtension)).toEqual(before);
    expect(
      targetWithoutExtension
        .prepare("SELECT name FROM sqlite_master WHERE name='chunks_vec'")
        .get(),
    ).toEqual({ name: "chunks_vec" });
    expect(
      targetWithoutExtension
        .prepare("PRAGMA database_list")
        .all()
        .map((row) => row.name),
    ).toEqual(["main"]);
    expect(run.writer.search({ query: "beforemarker" }).artifacts).toHaveLength(1);
    await run.register("after");
    expect(run.writer.search({ query: "aftermarker" }).artifacts).toHaveLength(1);
  });
});
