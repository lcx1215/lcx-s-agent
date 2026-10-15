import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applySqliteMigrations } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

export const FINANCE_SCHEDULER_DATABASE = "scheduler-ledger_1.sqlite";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
type Database = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

function readBody(row: Record<string, unknown> | undefined): string {
  if (typeof row?.body !== "string" || row.digest !== hash(row.body)) {
    throw new Error("scheduler database missing or corrupt; refusing to replay unknown attempts");
  }
  return row.body;
}

function openRead(directory: string): Database | undefined {
  const filename = path.join(directory, FINANCE_SCHEDULER_DATABASE);
  if (!fs.existsSync(filename)) {
    return undefined;
  }
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(filename, { readOnly: true });
}

/** Undefined means no migration yet, never an empty or corrupt existing database. */
export function readFinanceSchedulerDatabaseState(directory: string): string | undefined {
  const db = openRead(directory);
  if (!db) {
    return undefined;
  }
  try {
    return readBody(
      db.prepare("SELECT body, digest FROM scheduler_states ORDER BY sequence DESC LIMIT 1").get(),
    );
  } finally {
    db.close();
  }
}

/** Indexed reads do not lose the day run behind a large night-review payload. */
export function readFinanceSchedulerDatabaseRuns(
  directory: string,
): Record<string, unknown> | undefined {
  const db = openRead(directory);
  if (!db) {
    return undefined;
  }
  try {
    readBody(
      db.prepare("SELECT body, digest FROM scheduler_states ORDER BY sequence DESC LIMIT 1").get(),
    );
    const latest: Record<string, unknown> = {};
    for (const mode of ["day", "night"]) {
      const row = db
        .prepare(
          "SELECT body, digest FROM scheduler_runs WHERE mode=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(mode);
      if (row) {
        latest[mode] = JSON.parse(readBody(row));
      }
    }
    return latest;
  } finally {
    db.close();
  }
}

/** Called only by the existing scheduler write owner under its process lock. */
export function commitFinanceSchedulerDatabaseState(
  directory: string,
  body: string,
  runs: readonly Record<string, unknown>[],
): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, FINANCE_SCHEDULER_DATABASE);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filename);
  try {
    fs.chmodSync(filename, 0o600);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    applySqliteMigrations({
      db,
      ledgerTable: "finance_scheduler_migrations",
      migrations: [
        {
          version: 1,
          description: "Atomic scheduler state and terminal run journal",
          sql: `
        CREATE TABLE IF NOT EXISTS scheduler_states (
          sequence INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scheduler_runs (
          sequence INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, mode TEXT NOT NULL,
          body TEXT NOT NULL, digest TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS scheduler_runs_mode ON scheduler_runs(mode, sequence);
      `,
        },
      ],
    });
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const run of runs) {
        if (run.mode !== "day" && run.mode !== "night") {
          throw new Error("invalid scheduler run mode; history was not imported");
        }
        const raw = JSON.stringify(run);
        const digest = hash(raw);
        const key = typeof run.runId === "string" ? run.runId : `legacy:${digest}`;
        const existing = db
          .prepare("SELECT body, digest FROM scheduler_runs WHERE event_key=?")
          .get(key);
        if (existing) {
          if (readBody(existing) !== raw) {
            throw new Error("scheduler run identity conflict; refusing to overwrite history");
          }
        } else {
          db.prepare(
            "INSERT INTO scheduler_runs(event_key, mode, body, digest) VALUES (?, ?, ?, ?)",
          ).run(key, run.mode, raw, digest);
        }
      }
      const latest = db
        .prepare("SELECT body, digest FROM scheduler_states ORDER BY sequence DESC LIMIT 1")
        .get();
      if (!latest || readBody(latest) !== body) {
        db.prepare("INSERT INTO scheduler_states(recorded_at, body, digest) VALUES (?, ?, ?)").run(
          new Date().toISOString(),
          body,
          hash(body),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
