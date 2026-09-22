import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeIntradayLedgerPath } from "./finance-state-dir.js";

const Iso = z.string().datetime();
const Text = z.string().trim().min(1);
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Instrument = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/u);
const Interval = z.union([z.literal(60), z.literal(300), z.literal(900)]);

export const FINANCE_INTRADAY_RECORD_SCHEMA = "lcx_finance_intraday_record_v1" as const;

const IntradayBarInput = z
  .object({
    startAt: Iso,
    open: z.number().finite().positive(),
    high: z.number().finite().positive(),
    low: z.number().finite().positive(),
    close: z.number().finite().positive(),
    volume: z.number().finite().nonnegative(),
  })
  .strict();

const Provenance = z
  .object({
    origin: Text,
    sourceUrlOrArtifact: Text.optional(),
    feed: Text.optional(),
  })
  .strict();

export const FinanceIntradayAppendInput = z
  .object({
    instrument: Instrument,
    intervalSeconds: Interval,
    observedAt: Iso,
    provenance: Provenance,
    bars: z.array(IntradayBarInput).min(1),
  })
  .strict();
export type FinanceIntradayAppendInput = z.infer<typeof FinanceIntradayAppendInput>;

export const FinanceIntradayBar = IntradayBarInput.extend({
  instrument: Instrument,
  intervalSeconds: Interval,
  endAt: Iso,
}).strict();
export type FinanceIntradayBar = z.infer<typeof FinanceIntradayBar>;

const StoredRecord = z
  .object({
    schemaVersion: z.literal(FINANCE_INTRADAY_RECORD_SCHEMA),
    recordKey: Hash,
    sequence: z.number().int().positive(),
    previousRef: Hash.nullable(),
    recordedAt: Iso,
    body: z.object({
      instrument: Instrument,
      intervalSeconds: Interval,
      observedAt: Iso,
      provenance: Provenance,
      bars: z.array(FinanceIntradayBar).min(1),
    }),
  })
  .strict();

export type FinanceIntradayRecord = z.infer<typeof StoredRecord> & { ref: string };
export type FinanceIntradayLedger = Readonly<{
  bars: readonly FinanceIntradayBar[];
  recordCount: number;
  headRef: string | null;
}>;

const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: "append-only point-in-time intraday OHLCV observations",
    sql: `
      CREATE TABLE finance_intraday_records (
        ref TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        previous_ref TEXT,
        recorded_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
    `,
  },
];

type Database = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

function openDatabase(directory: string): Database {
  const { DatabaseSync } = requireNodeSqlite();
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o700);
  const databasePath = financeIntradayLedgerPath(directory);
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
  );
  applySqliteMigrations({
    db,
    ledgerTable: "finance_intraday_migrations",
    migrations: MIGRATIONS,
  });
  return db;
}

function readRecords(db: Database): FinanceIntradayRecord[] {
  const rows = db
    .prepare("SELECT ref, body FROM finance_intraday_records ORDER BY sequence")
    .all() as ReadonlyArray<{ ref?: unknown; body?: unknown }>;
  let previousRef: string | null = null;
  return rows.map((row, index) => {
    if (typeof row.ref !== "string" || typeof row.body !== "string") {
      throw new Error("invalid intraday record");
    }
    const raw: unknown = JSON.parse(row.body);
    if (caseflowFingerprint(raw) !== row.ref) {
      throw new Error("intraday record integrity mismatch");
    }
    const record = StoredRecord.parse(raw);
    if (record.sequence !== index + 1 || record.previousRef !== previousRef) {
      throw new Error("intraday record chain mismatch");
    }
    previousRef = row.ref;
    return { ...record, ref: row.ref };
  });
}

function signature(bar: FinanceIntradayBar): string {
  return caseflowFingerprint(bar);
}

function normalize(input: FinanceIntradayAppendInput): FinanceIntradayBar[] {
  const observedMs = Date.parse(input.observedAt);
  if (observedMs > Date.now()) {
    throw new Error("intraday observation cannot be dated in the future");
  }
  const seen = new Set<string>();
  return input.bars
    .map((bar) => {
      const startMs = Date.parse(bar.startAt);
      const durationMs = input.intervalSeconds * 1_000;
      if (startMs % durationMs !== 0) {
        throw new Error(`intraday bar ${bar.startAt} is not aligned to ${input.intervalSeconds}s`);
      }
      if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)) {
        throw new Error(`intraday bar ${bar.startAt} has impossible OHLC prices`);
      }
      const endAt = new Date(startMs + durationMs).toISOString();
      if (observedMs < Date.parse(endAt)) {
        throw new Error(`intraday bar ${bar.startAt} was observed before it closed`);
      }
      const key = `${input.instrument}|${input.intervalSeconds}|${bar.startAt}`;
      if (seen.has(key)) {
        throw new Error(`intraday batch contains duplicate interval ${key}`);
      }
      seen.add(key);
      return FinanceIntradayBar.parse({
        ...bar,
        instrument: input.instrument,
        intervalSeconds: input.intervalSeconds,
        endAt,
      });
    })
    .toSorted((left, right) => left.startAt.localeCompare(right.startAt));
}

export async function appendFinanceIntradayBars(
  directory: string,
  rawInput: FinanceIntradayAppendInput,
): Promise<
  Readonly<{
    appended: boolean;
    repeatsSkipped: number;
    recordCount: number;
    headRef: string | null;
  }>
> {
  const parsed = FinanceIntradayAppendInput.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid intraday append: ${issues}`);
  }
  const input = parsed.data;
  const bars = normalize(input);
  const db = openDatabase(directory);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const records = readRecords(db);
      const byInterval = new Map<string, FinanceIntradayBar>();
      for (const record of records) {
        for (const bar of record.body.bars) {
          byInterval.set(`${bar.instrument}|${bar.intervalSeconds}|${bar.startAt}`, bar);
        }
      }
      const fresh: FinanceIntradayBar[] = [];
      let repeatsSkipped = 0;
      for (const bar of bars) {
        const key = `${bar.instrument}|${bar.intervalSeconds}|${bar.startAt}`;
        const existing = byInterval.get(key);
        if (!existing) {
          fresh.push(bar);
        } else if (signature(existing) === signature(bar)) {
          repeatsSkipped += 1;
        } else {
          throw new Error(`conflicting intraday bar for ${key}`);
        }
      }
      if (fresh.length === 0) {
        db.exec("COMMIT");
        return Object.freeze({
          appended: false,
          repeatsSkipped,
          recordCount: records.length,
          headRef: records.at(-1)?.ref ?? null,
        });
      }
      const body = {
        instrument: input.instrument,
        intervalSeconds: input.intervalSeconds,
        observedAt: input.observedAt,
        provenance: input.provenance,
        bars: fresh,
      };
      const record = StoredRecord.parse({
        schemaVersion: FINANCE_INTRADAY_RECORD_SCHEMA,
        recordKey: caseflowFingerprint(body),
        sequence: records.length + 1,
        previousRef: records.at(-1)?.ref ?? null,
        recordedAt: new Date().toISOString(),
        body,
      });
      const ref = caseflowFingerprint(record);
      db.prepare(
        "INSERT INTO finance_intraday_records (ref, sequence, previous_ref, recorded_at, body) VALUES (?, ?, ?, ?, ?)",
      ).run(ref, record.sequence, record.previousRef, record.recordedAt, JSON.stringify(record));
      db.exec("COMMIT");
      return Object.freeze({
        appended: true,
        repeatsSkipped,
        recordCount: records.length + 1,
        headRef: ref,
      });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function readFinanceIntradayLedger(
  directory: string,
  options: { instrument?: string; asOf?: string } = {},
): Promise<FinanceIntradayLedger> {
  try {
    await fs.stat(financeIntradayLedgerPath(directory));
  } catch {
    return Object.freeze({ bars: Object.freeze([]), recordCount: 0, headRef: null });
  }
  const db = openDatabase(directory);
  try {
    const records = readRecords(db);
    const visible = records.filter(
      (record) =>
        (!options.instrument || record.body.instrument === options.instrument) &&
        (!options.asOf || record.body.observedAt <= options.asOf),
    );
    const bars = visible
      .flatMap((record) => record.body.bars)
      .toSorted(
        (left, right) =>
          left.instrument.localeCompare(right.instrument) ||
          left.startAt.localeCompare(right.startAt),
      );
    return Object.freeze({
      bars: Object.freeze(bars),
      recordCount: records.length,
      headRef: records.at(-1)?.ref ?? null,
    });
  } finally {
    db.close();
  }
}
