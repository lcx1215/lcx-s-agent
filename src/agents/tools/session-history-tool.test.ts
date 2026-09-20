import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { createSessionHistoryTool } from "./session-history-tool.js";

const SESSION_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SESSION_B = "bbbbbbbb-1111-2222-3333-444444444444";
const PHRASE = "kryptonian-archive-marker";

let dir: string;
let dbPath: string;

function seedArchive(target: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(target);
  db.exec(`
    CREATE TABLE session_windows (
      session_id TEXT PRIMARY KEY,
      session_key TEXT,
      status TEXT,
      updated_at INTEGER,
      transcript_observed_at INTEGER
    );
    CREATE TABLE transcript_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE VIRTUAL TABLE session_transcript_fts USING fts5(
      text,
      session_id UNINDEXED,
      message_id UNINDEXED,
      role UNINDEXED,
      timestamp UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE session_transcript_archives (
      session_id TEXT NOT NULL,
      generation TEXT,
      session_key TEXT,
      reason TEXT,
      encoding TEXT,
      archive_blob BLOB,
      archive_sha256 TEXT,
      archive_name TEXT,
      created_at INTEGER,
      published_at INTEGER,
      publish_attempts INTEGER,
      last_publish_attempt_at INTEGER,
      last_publish_error TEXT
    );
  `);
  db.prepare("INSERT INTO session_windows VALUES (?,?,?,?,?)").run(
    SESSION_A,
    "agent:main:main",
    "completed",
    1788000000000,
    1788000000000,
  );
  db.prepare("INSERT INTO session_windows VALUES (?,?,?,?,?)").run(
    SESSION_B,
    "agent:main:feishu",
    "failed",
    1787000000000,
    1787000000000,
  );
  db.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run(
    SESSION_A,
    1,
    `{"role":"user","text":"hello ${PHRASE}"}`,
    1788000000000,
  );
  db.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run(
    SESSION_A,
    2,
    `{"role":"assistant","text":"answered ${PHRASE}"}`,
    1788000001000,
  );
  db.prepare(
    "INSERT INTO session_transcript_fts (text, session_id, message_id, role, timestamp) VALUES (?,?,?,?,?)",
  ).run(`we discussed the ${PHRASE} migration`, SESSION_A, "m1", "user", 1788000000000);
  db.prepare(
    "INSERT INTO session_transcript_fts (text, session_id, message_id, role, timestamp) VALUES (?,?,?,?,?)",
  ).run("unrelated chatter about the weather", SESSION_B, "m2", "assistant", 1787000000000);
  const packed = zlib.zstdCompressSync(
    Buffer.from(`{"type":"session","id":"${SESSION_B}","note":"${PHRASE} archived"}`, "utf8"),
  );
  db.prepare(
    `INSERT INTO session_transcript_archives
     (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at, published_at, publish_attempts, last_publish_attempt_at, last_publish_error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    SESSION_B,
    "gen-1",
    "agent:main:archived",
    "deleted",
    "zstd",
    packed,
    "sha",
    `${SESSION_B}.jsonl.deleted.zst`,
    1786000000000,
    1786000000000,
    1,
    1786000000000,
    null,
  );
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-history-"));
  dbPath = path.join(dir, "openclaw-agent.sqlite");
  seedArchive(dbPath);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function execute(action: string, args: Record<string, unknown> = {}) {
  const tool = createSessionHistoryTool({ dbPath });
  const result = await tool.execute("call-1", { action, ...args });
  return result.details as Record<string, unknown>;
}

describe("session_history tool", () => {
  it("lists archived sessions newest first", async () => {
    const details = await execute("list", { limit: 10 });
    expect(details.available).toBe(true);
    const sessions = details.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(2);
    expect(sessions[0].sessionId).toBe(SESSION_A);
    expect(sessions[1].sessionId).toBe(SESSION_B);
  });

  it("finds a phrase in the archived transcript and reports the owning session", async () => {
    const details = await execute("search", { query: PHRASE, limit: 10 });
    expect(details.available).toBe(true);
    const hits = details.hits as Array<Record<string, unknown>>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sessionId).toBe(SESSION_A);
    expect(String(hits[0].text)).toContain(PHRASE);
  });

  it("returns no hits for a phrase that was never said", async () => {
    const details = await execute("search", { query: "zzz-never-spoken-marker", limit: 10 });
    const hits = details.hits as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(0);
  });

  it("reads the raw events of one session in order", async () => {
    const details = await execute("read", { sessionId: SESSION_A, limit: 10 });
    expect(details.available).toBe(true);
    const events = details.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(String(events[0].event)).toContain(PHRASE);
  });

  it("lists zstd archives without decompressing them", async () => {
    const details = await execute("archives", { limit: 10 });
    expect(details.available).toBe(true);
    const rows = details.archives as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe(SESSION_B);
    expect(rows[0].encoding).toBe("zstd");
    expect(Number(rows[0].bytes)).toBeGreaterThan(0);
  });

  it("decompresses one archived session on demand", async () => {
    const details = await execute("extract", { sessionId: SESSION_B });
    expect(details.found).toBe(true);
    expect(String(details.text)).toContain(PHRASE);
    expect(Number(details.totalChars)).toBeGreaterThan(0);
  });

  it("reports found:false instead of throwing for an unknown session", async () => {
    const details = await execute("extract", { sessionId: "no-such-session" });
    expect(details.found).toBe(false);
    expect(details.text).toBe("");
  });

  it("reports a clear limitation when the archive does not exist", async () => {
    const tool = createSessionHistoryTool({ dbPath: path.join(dir, "missing.sqlite") });
    const result = await tool.execute("call-1", { action: "list" });
    const details = result.details as Record<string, unknown>;
    expect(details.available).toBe(false);
    expect(String(details.reason)).toContain("archive not found");
  });

  it("reports a clear limitation when the archive lacks the transcript tables", async () => {
    const bare = path.join(dir, "bare.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(bare);
    db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
    db.close();
    const tool = createSessionHistoryTool({ dbPath: bare });
    const result = await tool.execute("call-1", { action: "list" });
    const details = result.details as Record<string, unknown>;
    expect(details.available).toBe(false);
    expect(String(details.reason)).toContain("session_windows");
  });
});
