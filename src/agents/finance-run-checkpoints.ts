import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

const CHECKPOINT_MIGRATION_LEDGER = "finance_checkpoint_migrations";
const CHECKPOINT_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: "run budget and node reservations",
    sql: `
      CREATE TABLE IF NOT EXISTS finance_checkpoint_runs (
        run_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        max_calls INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS finance_checkpoint_nodes (
        run_id TEXT NOT NULL, job_id TEXT NOT NULL, token TEXT NOT NULL,
        status TEXT NOT NULL, cost INTEGER NOT NULL, result TEXT, result_hash TEXT,
        PRIMARY KEY(run_id, job_id)
      );
    `,
  },
];

export type FinanceCheckpointOptions = Readonly<{
  path: string;
  runId: string;
  /** Caller-owned code/config identity. A changed identity requires a new run. */
  executionFingerprint: string;
}>;

type Reservation =
  | { status: "reserved"; token: string }
  | { status: "completed"; result: unknown }
  | { status: "uncertain" | "budget_exhausted" };

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** SQLite transactions commit reservations before network dispatch, across processes. */
export function openFinanceRunCheckpoints(
  options: FinanceCheckpointOptions,
  fingerprint: string,
  maxApiCalls: number,
) {
  if (!options.runId.trim() || !options.executionFingerprint.trim() || !options.path.trim()) {
    throw new Error("checkpoint path, runId and executionFingerprint required");
  }
  if (!Number.isSafeInteger(maxApiCalls) || maxApiCalls <= 0) {
    throw new Error("invalid checkpoint budget");
  }
  fingerprint = digest(
    JSON.stringify({ input: fingerprint, execution: options.executionFingerprint }),
  );
  mkdirSync(path.dirname(options.path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(options.path);
  try {
    chmodSync(options.path, 0o600);
    // auto_vacuum must be set before the first journal_mode=WAL write: switching to WAL
    // initialises the database file and silently freezes auto_vacuum afterwards.
    db.exec(
      `PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
    );
    applySqliteMigrations({
      db,
      ledgerTable: CHECKPOINT_MIGRATION_LEDGER,
      migrations: CHECKPOINT_MIGRATIONS,
    });
    db.prepare(
      "INSERT OR IGNORE INTO finance_checkpoint_runs(run_id, fingerprint, max_calls) VALUES (?, ?, ?)",
    ).run(options.runId, fingerprint, maxApiCalls);
    const run = db
      .prepare("SELECT fingerprint, max_calls FROM finance_checkpoint_runs WHERE run_id=?")
      .get(options.runId);
    if (run?.fingerprint !== fingerprint || run.max_calls !== maxApiCalls) {
      throw new Error("checkpoint input/config mismatch; use a new runId");
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    reserve(jobId: string, cost: number): Reservation {
      if (!Number.isSafeInteger(cost) || cost < 0) {
        throw new Error("invalid reservation cost");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const node = db
          .prepare(
            "SELECT status, result, result_hash, cost FROM finance_checkpoint_nodes WHERE run_id=? AND job_id=?",
          )
          .get(options.runId, jobId);
        let result: Reservation;
        if (node) {
          if (node.cost !== cost) {
            throw new Error("checkpoint node budget mismatch");
          }
          if (node.status === "completed") {
            if (typeof node.result !== "string" || digest(node.result) !== node.result_hash) {
              throw new Error("checkpoint result integrity mismatch");
            }
            result = { status: "completed", result: JSON.parse(node.result) as unknown };
          } else {
            // A reservation may belong to a live worker or a crashed one. Never infer
            // that the external call did not happen simply because its result is absent.
            result = { status: "uncertain" };
          }
        } else {
          const updated = db
            .prepare(
              "UPDATE finance_checkpoint_runs SET reserved=reserved+? WHERE run_id=? AND reserved+?<=max_calls",
            )
            .run(cost, options.runId, cost);
          if (updated.changes === 0) {
            result = { status: "budget_exhausted" };
          } else {
            const token = randomUUID();
            db.prepare(
              "INSERT INTO finance_checkpoint_nodes(run_id,job_id,token,status,cost) VALUES (?,?,?,'reserved',?)",
            ).run(options.runId, jobId, token, cost);
            result = { status: "reserved", token };
          }
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    complete(jobId: string, token: string, result: unknown) {
      const encoded = JSON.stringify(result);
      if (encoded === undefined) {
        throw new Error("checkpoint result must be JSON");
      }
      const changed = db
        .prepare(
          "UPDATE finance_checkpoint_nodes SET status='completed',result=?,result_hash=? WHERE run_id=? AND job_id=? AND token=? AND status='reserved'",
        )
        .run(encoded, digest(encoded), options.runId, jobId, token);
      if (changed.changes !== 1) {
        throw new Error("checkpoint completion owner mismatch");
      }
    },
    reserved(): number {
      return Number(
        db.prepare("SELECT reserved FROM finance_checkpoint_runs WHERE run_id=?").get(options.runId)
          ?.reserved,
      );
    },
    close() {
      db.close();
    },
  };
}
