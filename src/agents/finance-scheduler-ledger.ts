import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applySqliteMigrations } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { parseFinanceDailyDecisionRun } from "./finance-daily-decision-record.js";

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
  db.exec("BEGIN");
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
    db.exec("ROLLBACK");
    db.close();
  }
}

/** Bounded original day/night history for research continuation; never an adoption index. */
export function readFinanceSchedulerDatabaseResearchRuns(
  directory: string,
  limit = 16,
): { runs: readonly { ref: string; run: unknown }[]; olderRunsMayExist: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new Error("invalid scheduler research history limit");
  }
  const db = openRead(directory);
  if (!db) {
    return { runs: [], olderRunsMayExist: false };
  }
  db.exec("BEGIN");
  try {
    readBody(
      db.prepare("SELECT body, digest FROM scheduler_states ORDER BY sequence DESC LIMIT 1").get(),
    );
    const rows = db
      .prepare(
        "SELECT body, digest FROM scheduler_runs WHERE mode IN ('day', 'night') ORDER BY sequence DESC LIMIT ?",
      )
      .all(limit + 1);
    // Verify the sentinel too: corruption is not evidence of an older valid page.
    const verified = rows.map((row) => {
      const body = readBody(row);
      return { ref: hash(body), run: JSON.parse(body) as unknown };
    });
    return { runs: verified.slice(0, limit), olderRunsMayExist: verified.length > limit };
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}

/** Verified original day-run history for receipt attribution; skip large night payloads.
 * Missing pre-migration history stays missing, never inferred from current plans. */
export function readFinanceSchedulerDatabaseDayRuns(
  directory: string,
  limit?: number,
): readonly { ref: string; run: unknown }[] {
  const db = openRead(directory);
  if (!db) {
    return [];
  }
  db.exec("BEGIN");
  try {
    readBody(
      db.prepare("SELECT body, digest FROM scheduler_states ORDER BY sequence DESC LIMIT 1").get(),
    );
    const runs: { ref: string; run: unknown }[] = [];
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new Error("invalid scheduler day history limit");
    }
    const statement =
      limit === undefined
        ? db.prepare("SELECT body, digest FROM scheduler_runs WHERE mode='day' ORDER BY sequence")
        : db.prepare(
            "SELECT body, digest FROM scheduler_runs WHERE mode='day' ORDER BY sequence DESC LIMIT ?",
          );
    for (const row of limit === undefined ? statement.iterate() : statement.iterate(limit)) {
      const body = readBody(row);
      runs.push({ ref: hash(body), run: JSON.parse(body) });
    }
    return limit === undefined ? runs : runs.toReversed();
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}

/** Cheap readiness check for the scheduler's existing startup/maintenance owner. */
export function isFinanceSchedulerDecisionIndexCurrent(directory: string): boolean {
  const db = openRead(directory);
  if (!db) {
    return false;
  }
  try {
    if (
      !db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_decision_index_progress'",
        )
        .get()
    ) {
      return false;
    }
    if (
      !db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='scheduler_decision_account_time'",
        )
        .get()
    ) {
      return false;
    }
    const row = db
      .prepare(`SELECT through_sequence,
      (SELECT COALESCE(MAX(sequence), 0) FROM scheduler_runs) AS latest
      FROM scheduler_decision_index_progress WHERE id=1`)
      .get();
    return row !== undefined && row.through_sequence === row.latest;
  } finally {
    db.close();
  }
}

/** Original journal projection. A bounded writer-owned backfill must finish before use. */
function indexDecisionRuns(db: Database): void {
  const cursor = db
    .prepare("SELECT through_sequence FROM scheduler_decision_index_progress WHERE id=1")
    .get();
  let through = Number(cursor?.through_sequence ?? 0);
  const rows = db
    .prepare(
      "SELECT sequence, body, digest FROM scheduler_runs WHERE mode='day' AND sequence>? ORDER BY sequence LIMIT 64",
    )
    .iterate(through);
  let processedBytes = 0;
  const insert = db.prepare(
    "INSERT INTO scheduler_decision_index(run_sequence, account_id, instrument, completed_at, source_digest) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    const body = readBody(row);
    processedBytes += Buffer.byteLength(body, "utf8");
    const record = parseFinanceDailyDecisionRun(JSON.parse(body));
    if (record) {
      for (const instrument of new Set(
        record.report.tradeDecisionReview.candidateInputs.map((candidate) => candidate.instrument),
      )) {
        insert.run(
          Number(row.sequence),
          record.report.positionBook.accountId,
          instrument,
          Date.parse(record.run.completedAt),
          String(row.digest),
        );
      }
    }
    through = Number(row.sequence);
    // Stream legacy payloads and limit each writer turn; one record remains atomic.
    if (processedBytes >= 8 * 1024 * 1024) {
      break;
    }
  }
  if (
    !db
      .prepare(
        "SELECT sequence FROM scheduler_runs WHERE mode='day' AND sequence>? ORDER BY sequence LIMIT 1",
      )
      .get(through)
  ) {
    through = Number(
      db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM scheduler_runs").get()
        ?.sequence,
    );
  }
  db.prepare(
    "INSERT INTO scheduler_decision_index_progress(id, through_sequence) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET through_sequence=excluded.through_sequence",
  ).run(through);
}

/** Select relevant history before the packet limit; never scan full run bodies per decision. */
export function readFinanceSchedulerDecisionRuns(
  directory: string,
  scope: {
    accountId: string;
    asOf: string;
    instruments?: readonly string[];
    limit: number;
  },
): readonly { ref: string; run: unknown }[] {
  if (
    !Number.isSafeInteger(scope.limit) ||
    scope.limit < 1 ||
    scope.limit > 100 ||
    !Number.isFinite(Date.parse(scope.asOf))
  ) {
    throw new Error("invalid scheduler decision scope");
  }
  const db = openRead(directory);
  if (!db) {
    throw new Error("scheduler decision history unavailable");
  }
  db.exec("BEGIN");
  try {
    readBody(
      db.prepare("SELECT body, digest FROM scheduler_states ORDER BY sequence DESC LIMIT 1").get(),
    );
    const through = db
      .prepare("SELECT through_sequence FROM scheduler_decision_index_progress WHERE id=1")
      .get();
    const latest = db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM scheduler_runs")
      .get();
    if (!through || through.through_sequence !== latest?.sequence) {
      throw new Error("scheduler decision history indexing incomplete");
    }
    const selected = new Map<number, { digest: string; instrument: string; completedAt: number }>();
    if (scope.instruments === undefined) {
      // Account configuration needs operations across holdings and candidates. Read
      // the existing derived index in completion order, stopping after distinct
      // runs rather than letting a many-candidate run consume the run window.
      const rows = db.prepare(`SELECT run_sequence, source_digest, completed_at, instrument
        FROM scheduler_decision_index INDEXED BY scheduler_decision_account_time
        WHERE account_id=? AND completed_at<?
        ORDER BY completed_at DESC, run_sequence DESC`);
      for (const row of rows.iterate(scope.accountId, Date.parse(scope.asOf))) {
        selected.set(Number(row.run_sequence), {
          digest: String(row.source_digest),
          instrument: String(row.instrument),
          completedAt: Number(row.completed_at),
        });
        if (selected.size === scope.limit) {
          break;
        }
      }
    } else {
      const query =
        db.prepare(`SELECT run_sequence, source_digest, completed_at FROM scheduler_decision_index
      WHERE account_id=? AND instrument=? AND completed_at<?
      ORDER BY completed_at DESC, run_sequence DESC LIMIT ?`);
      const queues = [...new Set(scope.instruments)].map((instrument) => ({
        instrument,
        rows: query.all(scope.accountId, instrument, Date.parse(scope.asOf), scope.limit),
      }));
      for (let depth = 0; depth < scope.limit && selected.size < scope.limit; depth++) {
        for (const queue of queues) {
          const row = queue.rows[depth];
          if (row) {
            selected.set(Number(row.run_sequence), {
              digest: String(row.source_digest),
              instrument: queue.instrument,
              completedAt: Number(row.completed_at),
            });
          }
          if (selected.size === scope.limit) {
            break;
          }
        }
      }
    }
    const read = db.prepare(
      "SELECT body, digest FROM scheduler_runs WHERE sequence=? AND mode='day'",
    );
    return (
      [...selected]
        // Recovery imports may append older decisions after newer ones.
        .toSorted(([left, a], [right, b]) => a.completedAt - b.completedAt || left - right)
        .map(([sequence, indexed]) => {
          const row = read.get(sequence);
          const body = readBody(row);
          const run: unknown = JSON.parse(body);
          const parsed = parseFinanceDailyDecisionRun(run);
          if (
            row?.digest !== indexed.digest ||
            !parsed ||
            parsed.report.positionBook.accountId !== scope.accountId ||
            Date.parse(parsed.run.completedAt) !== indexed.completedAt ||
            Date.parse(parsed.run.completedAt) >= Date.parse(scope.asOf) ||
            !parsed.report.tradeDecisionReview.candidateInputs.some(
              (candidate) => candidate.instrument === indexed.instrument,
            )
          ) {
            throw new Error("scheduler decision index does not match verified run");
          }
          return { ref: hash(body), run };
        })
    );
  } finally {
    db.exec("ROLLBACK");
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
        {
          version: 2,
          description: "Derived account and instrument decision lookup with resumable backfill",
          sql: `
            CREATE TABLE IF NOT EXISTS scheduler_decision_index (
              run_sequence INTEGER NOT NULL, account_id TEXT NOT NULL, instrument TEXT NOT NULL,
              completed_at INTEGER NOT NULL, source_digest TEXT NOT NULL,
              PRIMARY KEY(run_sequence, instrument)
            );
            CREATE INDEX IF NOT EXISTS scheduler_decision_scope
              ON scheduler_decision_index(account_id, instrument, completed_at DESC, run_sequence DESC);
            CREATE TABLE IF NOT EXISTS scheduler_decision_index_progress (
              id INTEGER PRIMARY KEY CHECK(id=1), through_sequence INTEGER NOT NULL
            );
          `,
        },
        {
          version: 3,
          description: "Bounded account-wide execution history for research configuration",
          sql: `CREATE INDEX IF NOT EXISTS scheduler_decision_account_time
            ON scheduler_decision_index(account_id, completed_at DESC, run_sequence DESC);`,
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
      indexDecisionRuns(db);
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
