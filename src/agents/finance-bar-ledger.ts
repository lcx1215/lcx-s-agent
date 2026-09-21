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
   * Bars in `(instrument, date)` order, one per observed instrument-date *value*.
   *
   * Two observations of the same instrument-date stay apart only when they disagree: a divergence
   * is a fact about the sources, and collapsing it would hide it. An exact replay — the same day
   * with the same OHLCV, which is what two overlapping collection windows produce — carries no
   * such fact and is collapsed to one bar, because leaving it in doubles that day in every
   * downstream measure: a duplicated day is a zero-return day, and zero returns *deflate*
   * volatility. Measured on the live book, the recent 120 rows were duplicated such that 60 of
   * 119 adjacent pairs had zero return, giving 0.080 annualised against 0.131 for the same days
   * read once. A chart analysis handed that series understates risk by roughly a third.
   */
  bars: readonly FinanceBar[];
  /** Instrument-dates observed more than once with differing closes. */
  divergentDates: readonly string[];
  /** How many exact replays were collapsed out of `bars`. Reported, not silently dropped. */
  collapsedRepeats: number;
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
  /**
   * Bars in the submitted batch that were exact replays of a bar already in the book, and were
   * therefore not filed again.
   *
   * This is what keeps a daily full-history collection from growing the book by its own size
   * every day: the cycle re-collects the whole series (the vendor has no incremental endpoint),
   * so batch identity cannot be the dedupe key — one new day makes every batch "new", and the
   * book would gain a full copy of history per run. Content is the key instead: a day that is
   * already recorded with the same values carries no new evidence. A day whose values *changed*
   * is not a replay and is still filed, so a vendor revision still reaches the book as a
   * divergence.
   */
  repeatsSkipped: number;
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

      // Content, not batch identity, decides what is new: see `repeatsSkipped`.
      const known = new Set<string>();
      for (const record of records) {
        for (const bar of record.body.bars) {
          known.add(barSignature(bar));
        }
      }
      const fresh = body.bars.filter((bar) => !known.has(barSignature(bar)));
      const repeatsSkipped = body.bars.length - fresh.length;

      if (fresh.length === 0) {
        db.exec("COMMIT");
        // Everything here was already on file. Report the record that holds it, so "nothing was
        // filed" can be told apart from "the book is empty and nothing was ever filed".
        const first = body.bars[0];
        const holder = first
          ? [...records]
              .toReversed()
              .find((record) =>
                record.body.bars.some((bar) => barSignature(bar) === barSignature(first)),
              )
          : undefined;
        return Object.freeze({
          record: holder ?? records.at(-1)!,
          appended: false,
          repeatsSkipped,
          recordCount: records.length,
          headRef: records.at(-1)?.ref ?? null,
        });
      }

      const filed = { ...body, bars: fresh };
      const recordKey = caseflowFingerprint({
        instrument: filed.instrument,
        derivation: filed.derivation,
        origin: filed.provenance.origin,
        bars: [...filed.bars]
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
          repeatsSkipped,
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
        body: filed,
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
        repeatsSkipped,
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

/**
 * Identity of one observation's *content*. Two bars with the same signature are the same
 * measurement, whatever record carried them, so the second one is a replay rather than evidence.
 * Provenance is deliberately not part of it: two vendors agreeing on a day still describe one
 * day, and the agreement itself is reported as a collapsed replay count, not as two bars.
 */
export function barSignature(bar: FinanceBar): string {
  return [
    bar.instrument,
    bar.date,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume ?? "",
    bar.sampleCount ?? "",
  ].join("|");
}

/**
 * Drop exact replays from a bar series, keeping every genuine second opinion.
 *
 * Writes no longer create replays (see `repeatsSkipped`), but the book is append-only: books
 * written before that change still hold them, and a replay of one day is a zero-return day, which
 * deflates every range and volatility measure taken from the series. Collapsing on read makes
 * those books correct without rewriting their history.
 */
export function collapseRepeatedBars(bars: readonly FinanceBar[]): {
  bars: FinanceBar[];
  collapsedRepeats: number;
} {
  const signatures = new Set<string>();
  const kept: FinanceBar[] = [];
  let collapsedRepeats = 0;
  for (const bar of bars) {
    const signature = barSignature(bar);
    if (signatures.has(signature)) {
      collapsedRepeats += 1;
      continue;
    }
    signatures.add(signature);
    kept.push(bar);
  }
  return { bars: kept, collapsedRepeats };
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
      collapsedRepeats: 0,
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
        const key = `${bar.instrument}@${bar.date}`;
        const closes = byKey.get(key) ?? new Set<number>();
        closes.add(bar.close);
        byKey.set(key, closes);
        bars.push(bar);
      }
    }
    // Divergence is computed before collapsing: which source said what is a fact about the
    // sources, and it must survive the removal of replays.
    const divergentDates = [...byKey.entries()]
      .filter(([, closes]) => closes.size > 1)
      .map(([key]) => key)
      .toSorted();
    const collapsed = collapseRepeatedBars(bars);
    const ordered = collapsed.bars.toSorted(
      (left, right) =>
        left.instrument.localeCompare(right.instrument) || left.date.localeCompare(right.date),
    );

    return Object.freeze({
      bars: Object.freeze(ordered),
      divergentDates: Object.freeze(divergentDates),
      collapsedRepeats: collapsed.collapsedRepeats,
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
