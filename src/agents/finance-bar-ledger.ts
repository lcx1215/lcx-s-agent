import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeBarLedgerPath } from "./finance-state-dir.js";

const Text = z.string().trim().min(1);
const Iso = z.string().datetime();
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Instrument = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/u);
/** Calendar day. Bars are daily; intraday would need a different key and is not modelled. */
const Date_ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const FINANCE_BAR_RECORD_SCHEMA = "lcx_finance_bar_record_v1" as const;

/**
 * Whether the bar's *range* is complete.
 *
 * This is not metadata for its own sake. Range-based measures — ATR, true drawdown,
 * support/resistance — read `high` and `low` as the extremes the instrument actually traded
 * through. That is only true of an exchange-aggregated bar.
 *
 *   - `ohlcv`: the range is complete. `high`/`low` are the extremes of the period.
 *   - `point_derived`: the bar was built from discrete point observations, so `high`/`low` are
 *     only the extremes *that were observed*. The true range is at least this wide, and is
 *     usually wider — with one observation in a day, the observed range is zero.
 *
 * A `point_derived` bar therefore understates range. It is still worth storing: the close series
 * is real, and a reader that declines to run range measures over it can still use closes. What it
 * must not do is treat the two as interchangeable.
 *
 * Note the four prices are *not* required to be equal under `point_derived`: a day sampled three
 * times legitimately yields differing open/high/low/close. The distinction is about whether the
 * extremes are known to be the period's extremes, not about whether they happen to coincide.
 */
export const FINANCE_BAR_DERIVATIONS = ["ohlcv", "point_derived"] as const;
export type FinanceBarDerivation = (typeof FINANCE_BAR_DERIVATIONS)[number];

/**
 * An exchange-aggregated bar: `high`/`low` are the extremes the instrument traded through.
 *
 * There is no `instrument` field here on purpose. The batch carries it, and every bar in a batch
 * is the same instrument, so asking each bar to restate it would only create a second place for
 * the two to disagree — which is why the batch-level value is the one that is stored.
 */
const OhlcvBar = z
  .object({
    date: Date_,
    open: z.number().finite().positive(),
    high: z.number().finite().positive(),
    low: z.number().finite().positive(),
    close: z.number().finite().positive(),
    volume: z.number().finite().nonnegative().optional(),
  })
  .strict();

/**
 * One price at one instant.
 *
 * There is deliberately no `high`/`low` field here. A point observation has no intraday range,
 * so the only way a `point_derived` bar can carry one is for this module to compute it from the
 * points it was handed. A caller therefore cannot state a range it did not observe: the shape of
 * the input is the enforcement, rather than a runtime rule whose force depends on the caller
 * telling the truth about which shape it used.
 */
const PointObservation = z
  .object({
    date: Date_,
    price: z.number().finite().positive(),
    at: Iso,
  })
  .strict();
export type FinanceBarPointObservation = z.infer<typeof PointObservation>;

const Provenance = z
  .object({
    origin: Text,
    sourceUrlOrArtifact: Text.optional(),
    note: Text.optional(),
  })
  .strict();
export type FinanceBarProvenance = z.infer<typeof Provenance>;

const OhlcvBatch = z
  .object({
    instrument: Instrument,
    derivation: z.literal("ohlcv"),
    provenance: Provenance,
    /** Observation time of the batch itself, not of any single bar. */
    observedAt: Iso,
    bars: z.array(OhlcvBar).min(1),
  })
  .strict();

const PointDerivedBatch = z
  .object({
    instrument: Instrument,
    derivation: z.literal("point_derived"),
    provenance: Provenance,
    observedAt: Iso,
    points: z.array(PointObservation).min(1),
  })
  .strict();

export const FinanceBarAppendInput = z.discriminatedUnion("derivation", [
  OhlcvBatch,
  PointDerivedBatch,
]);
export type FinanceBarAppendInput = z.infer<typeof FinanceBarAppendInput>;

const StoredBar = z
  .object({
    instrument: Instrument,
    date: Date_,
    open: z.number().finite().positive(),
    high: z.number().finite().positive(),
    low: z.number().finite().positive(),
    close: z.number().finite().positive(),
    volume: z.number().finite().nonnegative().optional(),
    /**
     * How many point observations produced this bar; `null` for an exchange-aggregated bar.
     * `1` means `high === low` — the range is *unknown*, not zero. A reader that needs a true
     * range must read this before running a range-based measure, which is the entire point of
     * recording it rather than letting `high - low` stand in for a range nobody observed.
     */
    sampleCount: z.number().int().positive().nullable(),
  })
  .strict();
export type FinanceBar = z.infer<typeof StoredBar>;

const StoredRecordSchema = z
  .object({
    schemaVersion: z.literal(FINANCE_BAR_RECORD_SCHEMA),
    recordKey: Text,
    sequence: z.number().int().positive(),
    previousRef: Hash.nullable(),
    recordedAt: Iso,
    body: z.object({
      instrument: Instrument,
      derivation: z.enum(FINANCE_BAR_DERIVATIONS),
      provenance: Provenance,
      observedAt: Iso,
      bars: z.array(StoredBar).min(1),
    }),
  })
  .strict();
export type FinanceBarRecord = z.infer<typeof StoredRecordSchema> & { ref: string };

export type FinanceBarLedger = Readonly<{
  /**
   * Bars in `(instrument, date)` order. When two origins observed the same instrument-date with
   * different values, both are present: the divergence is a fact about the sources, and
   * collapsing it here would hide it.
   */
  bars: readonly FinanceBar[];
  /** Instrument-dates observed more than once with differing closes. */
  divergentDates: readonly string[];
  recordCount: number;
  headRef: string | null;
}>;

const BAR_LEDGER_MIGRATION_LEDGER = "finance_bar_migrations";

const BAR_LEDGER_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: "bar records: append-only batch observations keyed by content fingerprint",
    sql: `
      CREATE TABLE finance_bar_records (
        ref TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        previous_ref TEXT,
        recorded_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX finance_bar_records_sequence ON finance_bar_records(sequence);
    `,
  },
];

type BarDatabase = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

function openDatabase(directory: string): BarDatabase {
  const { DatabaseSync } = requireNodeSqlite();
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o700);
  const databasePath = financeBarLedgerPath(directory);
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  // Order matters: auto_vacuum must precede journal_mode, because switching journal_mode
  // initialises the database file and silently freezes auto_vacuum afterwards.
  db.exec(
    `PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
  );
  applySqliteMigrations({
    db,
    ledgerTable: BAR_LEDGER_MIGRATION_LEDGER,
    migrations: BAR_LEDGER_MIGRATIONS,
  });
  return db;
}

/**
 * Reject a bar whose four prices cannot be true together. This is the same sanity rule the
 * collection adapters apply to vendor history, reused rather than restated.
 *
 * It deliberately does *not* constrain `point_derived` beyond this: the honest way to keep a
 * derived range from being misread is the `derivation` label plus a writer that computes the
 * range instead of accepting one, not a shape rule that also rejects legitimate data.
 */
function validateBar(bar: FinanceBar): void {
  const { open, high, low, close, date, instrument } = bar;
  if (low > Math.min(open, close) || high < Math.max(open, close)) {
    throw new Error(
      `bar ${instrument}@${date} has impossible prices: low ${low}, high ${high}, open ${open}, close ${close}`,
    );
  }
}

/** Vendor bars already carry a range; keep it, and record that the range came from the venue. */
function normalizeOhlcvBars(
  instrument: string,
  bars: ReadonlyArray<z.infer<typeof OhlcvBar>>,
): FinanceBar[] {
  const normalized: FinanceBar[] = bars.map((bar) => ({ instrument, ...bar, sampleCount: null }));
  for (const bar of normalized) {
    validateBar(bar);
  }
  const dates = new Set(normalized.map((bar) => bar.date));
  if (dates.size !== normalized.length) {
    throw new Error("bar batch contains duplicate dates; one observation per instrument-day");
  }
  return normalized;
}

/**
 * Collapse discrete point observations into daily bars.
 *
 * `open` is the first observation of the day and `close` the last, so the close series is real.
 * `high`/`low` are the extremes *among the observations* — with one observation in a day they are
 * equal, which is why `sampleCount` is stored beside them: `high === low` means "range unknown",
 * and a reader that treats it as "no range" would silently understate every range measure.
 */
function deriveBarsFromPoints(
  instrument: string,
  points: ReadonlyArray<FinanceBarPointObservation>,
): FinanceBar[] {
  const byDate = new Map<string, FinanceBarPointObservation[]>();
  for (const point of points) {
    // The day must agree with the instant. A mark stamped 23:00Z filed under the previous UTC
    // day would otherwise widen that day's range with a price that belongs to the next one.
    if (!point.at.startsWith(point.date)) {
      throw new Error(
        `point ${instrument}@${point.at} is filed under day ${point.date}, which does not match; ` +
          `the day must be the UTC date of the observation`,
      );
    }
    const day = byDate.get(point.date) ?? [];
    day.push(point);
    byDate.set(point.date, day);
  }
  const bars: FinanceBar[] = [];
  for (const date of [...byDate.keys()].toSorted()) {
    const day = [...(byDate.get(date) ?? [])].toSorted((left, right) =>
      left.at.localeCompare(right.at),
    );
    const prices = day.map((point) => point.price);
    const open = prices[0];
    const close = prices[prices.length - 1];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    validateBar({ instrument, date, open, high, low, close, sampleCount: day.length });
    bars.push({ instrument, date, open, high, low, close, sampleCount: day.length });
  }
  return bars;
}

export type FinanceBarAppend = Readonly<{
  record: FinanceBarRecord;
  /** `false` when the identical record was already present: append-only, and idempotent. */
  appended: boolean;
  recordCount: number;
  headRef: string | null;
}>;

export async function appendFinanceBars(
  directory: string,
  input: FinanceBarAppendInput,
): Promise<FinanceBarAppend> {
  const parsed = FinanceBarAppendInput.safeParse(input);
  if (!parsed.success) {
    // The path is the useful half of a zod issue. "expected string, received undefined" tells an
    // operator nothing about which of twenty fields in their JSON file is missing; naming the
    // path does.
    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new Error(`invalid bar append: ${issues}`);
  }
  const batch = parsed.data;
  const body = {
    instrument: batch.instrument,
    derivation: batch.derivation,
    provenance: batch.provenance,
    observedAt: batch.observedAt,
    bars:
      batch.derivation === "ohlcv"
        ? normalizeOhlcvBars(batch.instrument, batch.bars)
        : deriveBarsFromPoints(batch.instrument, batch.points),
  };

  const observed = Date.parse(body.observedAt);
  if (!Number.isFinite(observed)) {
    throw new Error("bar record requires an ISO observation timestamp");
  }
  if (observed > Date.now()) {
    throw new Error("bar record observation cannot be dated in the future");
  }

  const db = openDatabase(directory);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const records = readStoredRecords(db);
      const recordKey = caseflowFingerprint({
        instrument: body.instrument,
        derivation: body.derivation,
        origin: body.provenance.origin,
        bars: [...body.bars]
          .map(
            (bar) =>
              `${bar.date}:${bar.open}:${bar.high}:${bar.low}:${bar.close}:${bar.volume ?? ""}:${bar.sampleCount ?? ""}`,
          )
          .toSorted(),
      });
      const existing = records.find((record) => record.recordKey === recordKey);
      if (existing) {
        db.exec("COMMIT");
        return Object.freeze({
          record: existing,
          appended: false,
          recordCount: records.length,
          headRef: records.at(-1)?.ref ?? null,
        });
      }
      const record = StoredRecordSchema.parse({
        schemaVersion: FINANCE_BAR_RECORD_SCHEMA,
        recordKey,
        sequence: records.length + 1,
        previousRef: records.at(-1)?.ref ?? null,
        recordedAt: new Date().toISOString(),
        body,
      });
      const ref = caseflowFingerprint(record);
      db.prepare(
        "INSERT INTO finance_bar_records (ref, sequence, previous_ref, recorded_at, body) VALUES (?, ?, ?, ?, ?)",
      ).run(ref, record.sequence, record.previousRef, record.recordedAt, JSON.stringify(record));
      db.exec("COMMIT");
      const after = readStoredRecords(db);
      return Object.freeze({
        record: { ...record, ref },
        appended: true,
        recordCount: after.length,
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

/**
 * Read every record and re-verify the chain, matching the other finance books. A row whose
 * stored `ref` no longer matches its body, or whose sequence or back-link is off, is a hard
 * error rather than a silent skip: a book that quietly drops rows would report "no bars were
 * recorded", which reads the same as "nothing happened".
 */
function readStoredRecords(db: BarDatabase): FinanceBarRecord[] {
  const rows = db
    .prepare("SELECT ref, body FROM finance_bar_records ORDER BY sequence")
    .all() as ReadonlyArray<{ ref?: unknown; body?: unknown }>;
  let previousRef: string | null = null;
  return rows.map((row, index) => {
    if (typeof row.body !== "string" || typeof row.ref !== "string") {
      throw new Error("invalid bar record");
    }
    const raw: unknown = JSON.parse(row.body);
    if (caseflowFingerprint(raw) !== row.ref) {
      throw new Error("bar record integrity mismatch");
    }
    const record = StoredRecordSchema.parse(raw);
    if (record.sequence !== index + 1 || record.previousRef !== previousRef) {
      throw new Error("bar record chain mismatch");
    }
    previousRef = row.ref;
    return { ...record, ref: row.ref };
  });
}

export async function readFinanceBarLedger(
  directory: string,
  options: { asOf?: string; instrument?: string } = {},
): Promise<FinanceBarLedger> {
  // Opening the database would create it. A read must not have that side effect, and must not
  // destroy the "this book does not exist yet" state just by looking: after one read, an absent
  // book would otherwise report itself as present-but-empty forever.
  if (!(await financeBarLedgerExists(directory))) {
    return Object.freeze({
      bars: Object.freeze([]),
      divergentDates: Object.freeze([]),
      recordCount: 0,
      headRef: null,
    });
  }
  const db = openDatabase(directory);
  try {
    const stored = readStoredRecords(db);
    const asOf = options.asOf;
    const scoped = stored.filter((record) => {
      if (asOf !== undefined && asOf.length > 0 && record.body.observedAt.localeCompare(asOf) > 0) {
        return false;
      }
      if (options.instrument !== undefined && record.body.instrument !== options.instrument) {
        return false;
      }
      return true;
    });

    const byKey = new Map<string, Set<number>>();
    const bars: FinanceBar[] = [];
    for (const record of scoped) {
      for (const bar of record.body.bars) {
        bars.push(bar);
        const key = `${bar.instrument}@${bar.date}`;
        const closes = byKey.get(key) ?? new Set<number>();
        closes.add(bar.close);
        byKey.set(key, closes);
      }
    }
    const ordered = bars.toSorted(
      (left, right) =>
        left.instrument.localeCompare(right.instrument) || left.date.localeCompare(right.date),
    );
    const divergentDates = [...byKey.entries()]
      .filter(([, closes]) => closes.size > 1)
      .map(([key]) => key)
      .toSorted();

    return Object.freeze({
      bars: Object.freeze(ordered),
      divergentDates: Object.freeze(divergentDates),
      recordCount: stored.length,
      headRef: stored.at(-1)?.ref ?? null,
    });
  } finally {
    db.close();
  }
}

/** True when a directory already holds a bar book. Reading never creates one. */
export async function financeBarLedgerExists(directory: string): Promise<boolean> {
  try {
    await fs.stat(financeBarLedgerPath(directory));
    return true;
  } catch {
    return false;
  }
}
