import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Type } from "@sinclair/typebox";
import { resolveStateDir } from "../../config/paths.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

/**
 * Read-only recall over the archived session transcript store
 * (`<state>/agents/<agentId>/agent/openclaw-agent.sqlite`).
 *
 * This store is a legacy archive: it is no longer written by the current code
 * path and is treated strictly as history. The tool therefore opens it read
 * only and reports a clear limitation when the file or its tables are absent,
 * instead of failing the run.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_TEXT_CHARS = 2000;

const SESSION_HISTORY_TABLES = {
  fts: "session_transcript_fts",
  events: "transcript_events",
  windows: "session_windows",
  archives: "session_transcript_archives",
} as const;

/** Bytes returned from a decompressed archive; the rest is reachable by paging. */
const MAX_EXTRACT_CHARS = 20_000;

export type SessionHistoryParams = {
  agentId?: string;
  /** Explicit override, mainly for tests and non-default state dirs. */
  dbPath?: string;
};

const SessionHistorySchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("search"),
    Type.Literal("read"),
    Type.Literal("archives"),
    Type.Literal("extract"),
  ]),
  query: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  offset: Type.Optional(Type.Number()),
});

export function resolveSessionHistoryDbPath(params: SessionHistoryParams = {}): string {
  if (params.dbPath?.trim()) {
    return params.dbPath.trim();
  }
  const agentId = params.agentId?.trim() || "main";
  return path.join(
    resolveStateDir(process.env),
    "agents",
    agentId,
    "agent",
    "openclaw-agent.sqlite",
  );
}

type Db = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

function rowText(value: unknown): string {
  // SQLite rows are typed as unknown here. String() on an unknown renders an
  // object as "[object Object]", so narrow the value before converting it.
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  return JSON.stringify(value) ?? "";
}

function withBusyTimeout(db: Db): Db {
  // Without this a concurrent writer holding the lock makes the open or the first
  // SELECT fail instantly instead of waiting for it.
  try {
    db.exec("PRAGMA busy_timeout=5000;");
  } catch {
    // A handle that rejects this PRAGMA is still usable for SELECTs.
  }
  return db;
}

function openReadOnly(dbPath: string): Db | undefined {
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }
  const { DatabaseSync } = requireNodeSqlite();
  try {
    return withBusyTimeout(new DatabaseSync(dbPath, { readOnly: true }));
  } catch {
    // A WAL sidecar can make a strict read-only open fail; fall back to a
    // normal handle that only ever runs SELECTs.
    try {
      return withBusyTimeout(new DatabaseSync(dbPath));
    } catch {
      return undefined;
    }
  }
}

function tableExists(db: Db, name: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(name) as { ok?: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

/** Escape an FTS5 query: force a single phrase so user input cannot inject syntax. */
function toFtsPhrase(query: string): string {
  const cleaned = query.replace(/"/g, '""').trim();
  return `"${cleaned}"`;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.trunc(value), MAX_LIMIT);
}

function clip(value: string): string {
  const text = value.trim();
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}…`;
}

function unavailable(reason: string) {
  return jsonResult({
    available: false,
    reason,
    note: "The archived transcript store is history only; it is not written by the current code path.",
  });
}

export function createSessionHistoryTool(params: SessionHistoryParams = {}): AnyAgentTool {
  return {
    label: "session_history",
    name: "session_history",
    description:
      "Read-only recall over archived session transcripts. list = recent sessions, search = full-text match, read = events for one session.",
    parameters: SessionHistorySchema,
    execute: async (_toolCallId, input) => {
      const args = (input ?? {}) as Record<string, unknown>;
      const action = readStringParam(args, "action", { required: true }) as
        | "list"
        | "search"
        | "read"
        | "archives"
        | "extract";
      const dbPath = resolveSessionHistoryDbPath(params);
      const db = openReadOnly(dbPath);
      if (!db) {
        return unavailable(`archive not found at ${dbPath}`);
      }

      try {
        if (!tableExists(db, SESSION_HISTORY_TABLES.windows)) {
          return unavailable(`table ${SESSION_HISTORY_TABLES.windows} missing`);
        }

        if (action === "list") {
          const rows = db
            .prepare(
              `SELECT session_id, session_key, status, updated_at, transcript_observed_at
               FROM ${SESSION_HISTORY_TABLES.windows}
               ORDER BY updated_at DESC
               LIMIT ?`,
            )
            .all(clampLimit(readNumberParam(args, "limit"))) as Record<string, unknown>[];
          return jsonResult({
            available: true,
            archivePath: dbPath,
            count: rows.length,
            sessions: rows.map((row) => ({
              sessionId: rowText(row.session_id),
              sessionKey: rowText(row.session_key),
              status: rowText(row.status),
              updatedAt: row.updated_at ? Number(row.updated_at) : null,
            })),
          });
        }

        // Archives are the zstd-packed transcripts of deleted sessions. They are
        // listed without decompressing and unpacked only on demand.
        if (action === "archives") {
          if (!tableExists(db, SESSION_HISTORY_TABLES.archives)) {
            return unavailable(`table ${SESSION_HISTORY_TABLES.archives} missing`);
          }
          const rows = db
            .prepare(
              `SELECT session_id, session_key, archive_name, encoding, created_at,
                      length(archive_blob) AS blob_bytes
               FROM ${SESSION_HISTORY_TABLES.archives}
               ORDER BY created_at DESC
               LIMIT ?`,
            )
            .all(clampLimit(readNumberParam(args, "limit"))) as Record<string, unknown>[];
          return jsonResult({
            available: true,
            archivePath: dbPath,
            count: rows.length,
            archives: rows.map((row) => ({
              sessionId: rowText(row.session_id),
              sessionKey: rowText(row.session_key),
              archiveName: rowText(row.archive_name),
              encoding: rowText(row.encoding),
              bytes: Number(row.blob_bytes ?? 0),
              createdAt: row.created_at ? Number(row.created_at) : null,
            })),
          });
        }

        if (action === "extract") {
          if (!tableExists(db, SESSION_HISTORY_TABLES.archives)) {
            return unavailable(`table ${SESSION_HISTORY_TABLES.archives} missing`);
          }
          const sessionId = readStringParam(args, "sessionId", { required: true });
          const row = db
            .prepare(
              `SELECT archive_blob, encoding, archive_name
               FROM ${SESSION_HISTORY_TABLES.archives}
               WHERE session_id = ?
               LIMIT 1`,
            )
            .get(sessionId) as Record<string, unknown> | undefined;
          if (!row) {
            return jsonResult({
              available: true,
              archivePath: dbPath,
              sessionId,
              found: false,
              text: "",
            });
          }
          const blob = row.archive_blob as Uint8Array;
          const encoding = rowText(row.encoding);
          let text: string;
          if (encoding === "zstd") {
            if (typeof zlib.zstdDecompressSync !== "function") {
              return unavailable("this Node build cannot decompress zstd archives");
            }
            text = zlib.zstdDecompressSync(blob).toString("utf8");
          } else {
            text = Buffer.from(blob).toString("utf8");
          }
          const start = Math.max(0, Math.trunc(readNumberParam(args, "offset") ?? 0));
          return jsonResult({
            available: true,
            archivePath: dbPath,
            sessionId,
            found: true,
            archiveName: rowText(row.archive_name),
            offset: start,
            totalChars: text.length,
            truncated: text.length - start > MAX_EXTRACT_CHARS,
            text: text.slice(start, start + MAX_EXTRACT_CHARS),
          });
        }

        if (!tableExists(db, SESSION_HISTORY_TABLES.fts)) {
          return unavailable(`table ${SESSION_HISTORY_TABLES.fts} missing`);
        }

        if (action === "search") {
          const query = readStringParam(args, "query", { required: true });
          const rows = db
            .prepare(
              `SELECT text, session_id, message_id, role, timestamp
               FROM ${SESSION_HISTORY_TABLES.fts}
               WHERE ${SESSION_HISTORY_TABLES.fts} MATCH ?
               ORDER BY rank
               LIMIT ?`,
            )
            .all(toFtsPhrase(query), clampLimit(readNumberParam(args, "limit"))) as Record<
            string,
            unknown
          >[];
          return jsonResult({
            available: true,
            archivePath: dbPath,
            query,
            count: rows.length,
            hits: rows.map((row) => ({
              sessionId: rowText(row.session_id),
              messageId: rowText(row.message_id),
              role: rowText(row.role),
              timestamp: row.timestamp ? Number(row.timestamp) : null,
              text: clip(rowText(row.text)),
            })),
          });
        }

        if (!tableExists(db, SESSION_HISTORY_TABLES.events)) {
          return unavailable(`table ${SESSION_HISTORY_TABLES.events} missing`);
        }
        const sessionId = readStringParam(args, "sessionId", { required: true });
        const offset = Math.max(0, Math.trunc(readNumberParam(args, "offset") ?? 0));
        const rows = db
          .prepare(
            `SELECT seq, event_json, created_at
             FROM ${SESSION_HISTORY_TABLES.events}
             WHERE session_id = ?
             ORDER BY seq
             LIMIT ? OFFSET ?`,
          )
          .all(sessionId, clampLimit(readNumberParam(args, "limit")), offset) as Record<
          string,
          unknown
        >[];
        return jsonResult({
          available: true,
          archivePath: dbPath,
          sessionId,
          offset,
          count: rows.length,
          events: rows.map((row) => ({
            seq: Number(row.seq ?? 0),
            createdAt: row.created_at ? Number(row.created_at) : null,
            event: clip(rowText(row.event_json)),
          })),
        });
      } catch (err) {
        return unavailable(err instanceof Error ? err.message : String(err));
      } finally {
        try {
          db.close();
        } catch {
          // Closing is best effort.
        }
      }
    },
  };
}
