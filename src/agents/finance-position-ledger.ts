/**
 * Position and PnL ledger derived from execution receipts.
 *
 * One domain, two halves:
 *
 * 1. `projectFinancePositions` — a pure projection. It reads receipts, it never writes one
 *    and it never places an order. It exists because a receipt stream alone cannot answer
 *    "what am I holding", and because `finance_live_execution_waterflow` ends at
 *    `execution_receipt` with nothing that accumulates across runs.
 * 2. The durable store below — an append-only, hash-chained SQLite ledger of execution
 *    receipts and marks. Positions are deliberately *not* persisted: they are re-derived
 *    from the stored stream on every read, so a stored position can never drift from the
 *    fills that produced it.
 *
 * Two honesty rules are enforced here rather than left to the caller:
 *
 * 1. A mark is required to state unrealized PnL. An instrument with no mark is reported in
 *    `instrumentsWithoutMark` and the total is `null` — never silently treated as zero.
 * 2. A mark without a usable timestamp is rejected into `rejectedMarks`. A price with no
 *    "as of" cannot be called current.
 *
 * Average cost is used, and shorts are handled with the same arithmetic as longs: a fill
 * that reduces the open quantity realizes PnL against the average cost, and a fill that
 * flips the sign starts a new average at its own fill price.
 *
 * The store adds three properties the pure projection cannot have:
 *
 * - **Idempotent append.** Re-appending a receipt or a mark that is already recorded is a
 *   no-op. Double-counting a fill is the single most damaging failure mode for a position
 *   ledger, so the key is the receipt id and the mark's `(instrument, at)`, never a counter.
 * - **Conflict, not overwrite.** The same key with different content is refused instead of
 *   silently replacing the earlier record. An append-only ledger has no update path.
 * - **Tamper evidence.** Every record carries the hash of the previous record, and its own
 *   `ref` is the canonical hash of its content. A read re-verifies both.
 */

import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES } from "../shared/lcx-ontology.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import {
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  fingerprintFinanceExecutionReceipts,
} from "./finance-execution-adapter.js";
import { financePositionLedgerPath } from "./finance-state-dir.js";

export const FINANCE_POSITION_LEDGER_SCHEMA = "lcx_finance_position_ledger_v1" as const;

export type FinancePositionMark = Readonly<{
  instrument: string;
  price: number;
  /** ISO datetime the mark belongs to. Required: an untimed price is not a mark. */
  at: string;
}>;

export type FinancePosition = Readonly<{
  instrument: string;
  /** Signed: positive is long, negative is short. */
  quantity: number;
  /** Volume-weighted average cost of the open quantity; 0 when flat. */
  averageCost: number;
  realizedPnl: number;
  markPrice?: number;
  markPriceAt?: string;
  /** Present only when a mark exists, or when the position is flat (then exactly 0). */
  unrealizedPnl?: number;
  /** Named reason `unrealizedPnl` is absent. Absence is stated, never zeroed. */
  unrealizedUnavailableReason?: string;
}>;

export type FinancePositionLedger = Readonly<{
  schemaVersion: typeof FINANCE_POSITION_LEDGER_SCHEMA;
  receiptFingerprint: string;
  receiptCount: number;
  /** Paper and venue fills are counted apart so a simulated ledger is never read as real. */
  paperFillCount: number;
  venueFillCount: number;
  positions: readonly FinancePosition[];
  /** Instruments holding an open quantity but no usable mark. */
  instrumentsWithoutMark: readonly string[];
  /** Marks discarded for a missing timestamp or a non-positive price. */
  rejectedMarks: readonly string[];
  realizedPnl: number;
  /** `null` when any open position lacks a mark; a partial sum would overstate certainty. */
  unrealizedPnl: number | null;
}>;

function normalizeInstrument(instrument: string): string {
  return instrument.trim().toUpperCase();
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

type MutablePosition = {
  instrument: string;
  quantity: number;
  averageCost: number;
  realizedPnl: number;
};

function applyFill(position: MutablePosition, signedQuantity: number, fillPrice: number): void {
  const openQuantity = position.quantity;
  const closing =
    Math.sign(openQuantity) === Math.sign(signedQuantity)
      ? 0
      : Math.min(Math.abs(openQuantity), Math.abs(signedQuantity));

  if (closing > 0) {
    // Long closed by a sell gains when the fill is above cost; a short closed by a buy
    // gains when the fill is below cost. `sign(openQuantity)` carries both cases.
    position.realizedPnl += closing * (fillPrice - position.averageCost) * Math.sign(openQuantity);
  }

  const nextQuantity = openQuantity + signedQuantity;
  const sameSide = Math.sign(nextQuantity) === Math.sign(openQuantity) && openQuantity !== 0;
  if (nextQuantity === 0) {
    position.averageCost = 0;
  } else if (closing > 0 && sameSide) {
    // Partial close: the remainder keeps its original cost basis. Re-weighting here would
    // silently move the cost of the still-open quantity to the closing fill's price.
  } else if (closing === 0 && sameSide) {
    // Genuinely adding to the position, so the average is re-weighted over the whole size.
    position.averageCost =
      (Math.abs(openQuantity) * position.averageCost + Math.abs(signedQuantity) * fillPrice) /
      (Math.abs(openQuantity) + Math.abs(signedQuantity));
  } else {
    // Opened from flat, or flipped sides: the new side starts at this fill's price.
    position.averageCost = fillPrice;
  }
  position.quantity = nextQuantity;
}

/**
 * Project receipts into positions. Ordering is by `recordedAt` then `receiptId`, so a
 * receipt set has exactly one projection regardless of the order it was collected in.
 */
export function projectFinancePositions(params: {
  receipts: readonly FinanceExecutionReceipt[];
  marks?: readonly FinancePositionMark[];
}): FinancePositionLedger {
  const ordered = params.receipts.toSorted((left, right) =>
    left.recordedAt === right.recordedAt
      ? left.receiptId.localeCompare(right.receiptId)
      : left.recordedAt.localeCompare(right.recordedAt),
  );

  const byInstrument = new Map<string, MutablePosition>();
  let paperFillCount = 0;
  let venueFillCount = 0;

  for (const receipt of ordered) {
    const instrument = normalizeInstrument(receipt.instrument);
    const position = byInstrument.get(instrument) ?? {
      instrument,
      quantity: 0,
      averageCost: 0,
      realizedPnl: 0,
    };
    const signedQuantity = receipt.side === "buy" ? receipt.quantity : -receipt.quantity;
    applyFill(position, signedQuantity, receipt.fill.fillPrice);
    byInstrument.set(instrument, position);
    if (receipt.adapterKind === "paper") {
      paperFillCount += 1;
    } else {
      venueFillCount += 1;
    }
  }

  const marks = new Map<string, FinancePositionMark>();
  const rejectedMarks: string[] = [];
  for (const mark of params.marks ?? []) {
    const instrument = normalizeInstrument(mark.instrument);
    if (instrument.length === 0 || !isPositiveFinite(mark.price) || mark.at.trim().length === 0) {
      rejectedMarks.push(mark.instrument);
      continue;
    }
    marks.set(instrument, { instrument, price: mark.price, at: mark.at });
  }

  const positions: FinancePosition[] = [];
  const instrumentsWithoutMark: string[] = [];
  let realizedPnl = 0;
  let unrealizedPnl: number | null = 0;

  for (const position of byInstrument.values()) {
    realizedPnl += position.realizedPnl;
    const mark = marks.get(position.instrument);
    if (position.quantity === 0) {
      positions.push({
        instrument: position.instrument,
        quantity: 0,
        averageCost: 0,
        realizedPnl: round6(position.realizedPnl),
        unrealizedPnl: 0,
      });
      continue;
    }
    if (mark === undefined) {
      instrumentsWithoutMark.push(position.instrument);
      unrealizedPnl = null;
      positions.push({
        instrument: position.instrument,
        quantity: round6(position.quantity),
        averageCost: round6(position.averageCost),
        realizedPnl: round6(position.realizedPnl),
        unrealizedUnavailableReason: "mark_required_for_unrealized_pnl",
      });
      continue;
    }
    // Not rejected for predating the fill, and deliberately so: a run that trades at a historical
    // close records `filledAt` as the moment it placed the order, which is later than the close
    // the price belongs to. Rejecting a mark older than the fill would therefore refuse the very
    // price the position was opened at. The live book has both shapes — see the capability map
    // under the 2026-09-21 audit, where the one non-zero unrealized PnL came from a mark written
    // the day before its fill by hand, and the same rule that would have caught it also catches
    // every ordinary mark-to-close.
    const positionUnrealized = (mark.price - position.averageCost) * position.quantity;
    if (unrealizedPnl !== null) {
      unrealizedPnl += positionUnrealized;
    }
    positions.push({
      instrument: position.instrument,
      quantity: round6(position.quantity),
      averageCost: round6(position.averageCost),
      realizedPnl: round6(position.realizedPnl),
      markPrice: mark.price,
      markPriceAt: mark.at,
      unrealizedPnl: round6(positionUnrealized),
    });
  }

  return Object.freeze({
    schemaVersion: FINANCE_POSITION_LEDGER_SCHEMA,
    receiptFingerprint: fingerprintFinanceExecutionReceipts(ordered),
    receiptCount: ordered.length,
    paperFillCount,
    venueFillCount,
    positions: Object.freeze(positions),
    instrumentsWithoutMark: Object.freeze(instrumentsWithoutMark),
    rejectedMarks: Object.freeze(rejectedMarks),
    realizedPnl: round6(realizedPnl),
    unrealizedPnl: unrealizedPnl === null ? null : round6(unrealizedPnl),
  });
}

/* -------------------------------------------------------------------------- */
/* Durable store                                                              */
/* -------------------------------------------------------------------------- */

export const FINANCE_POSITION_RECORD_SCHEMA = "lcx_finance_position_record_v1" as const;

const Text = z.string().trim().min(1);
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);

const FinancePositionMarkRecordSchema = z
  .object({
    instrument: Text,
    price: z.number().finite().positive(),
    at: z.string().datetime(),
  })
  .strict();

const FinanceExecutionReceiptRecordSchema = z
  .object({
    schemaVersion: z.literal(FINANCE_EXECUTION_RECEIPT_SCHEMA),
    receiptId: Text,
    intentId: Text,
    runAuthorizationId: z.string(),
    adapterId: Text,
    adapterKind: z.enum(["paper", "venue"]),
    venue: Text,
    instrument: Text,
    side: z.enum(["buy", "sell"]),
    orderType: z.enum(["market", "limit"]),
    quantity: z.number().finite().positive(),
    limitPrice: z.number().finite().positive().optional(),
    referencePrice: z.number().finite().positive(),
    referencePriceAt: z.string().datetime(),
    notional: z.number().finite(),
    fill: z
      .object({
        filledQuantity: z.number().finite().positive(),
        fillPrice: z.number().finite().positive(),
        filledAt: z.string().datetime(),
        venueRef: Text,
        terminalOrderIdentity: z
          .object({ orderId: Text, terminal: z.literal(true) })
          .strict()
          .optional(),
      })
      .strict(),
    executionAuthority: z.enum([...LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES]),
    recordedAt: z.string().datetime(),
  })
  .strict();

/**
 * The record body. `kind` doubles as the SQL discriminator, and the two variants carry the
 * only two things this ledger accumulates: what was filled, and what it was worth later.
 */
const FinancePositionRecordBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("receipt"), receipt: FinanceExecutionReceiptRecordSchema }).strict(),
  z.object({ kind: z.literal("mark"), mark: FinancePositionMarkRecordSchema }).strict(),
]);

export type FinancePositionRecordBody = z.infer<typeof FinancePositionRecordBodySchema>;

const StoredRecordSchema = z
  .object({
    schemaVersion: z.literal(FINANCE_POSITION_RECORD_SCHEMA),
    recordKey: Text,
    sequence: z.number().int().positive(),
    previousRef: Hash.nullable(),
    recordedAt: z.string().datetime(),
    body: FinancePositionRecordBodySchema,
  })
  .strict();

export type FinancePositionRecord = z.infer<typeof StoredRecordSchema> & { ref: string };

export type FinancePositionRecordAppend = Readonly<{
  record: FinancePositionRecord;
  /** `false` when an identical record was already present, so a caller can spot a replay. */
  appended: boolean;
}>;

export type FinancePositionRecordsRead = Readonly<{
  records: readonly FinancePositionRecord[];
  receipts: readonly FinanceExecutionReceipt[];
  marks: readonly FinancePositionMark[];
  /** `ref` of the newest record, i.e. the chain head at read time. `null` for an empty ledger. */
  headRef: string | null;
}>;

export type FinancePositionLedgerRead = Readonly<{
  ledger: FinancePositionLedger;
  /**
   * The exact stream `ledger` was derived from, after the `asOf` filter was applied.
   *
   * A downstream projection (a behaviour profile, a second metric) must describe the same
   * stream the positions beside it came from. Re-deriving the filter at each call site would
   * mean two copies of the `asOf` rule that can drift apart, so the read reports what it used.
   */
  receipts: readonly FinanceExecutionReceipt[];
  marks: readonly FinancePositionMark[];
  recordCount: number;
  receiptRecordCount: number;
  markRecordCount: number;
  headRef: string | null;
}>;

/**
 * The ledger file is generation-suffixed (`position-ledger_1.sqlite`). `finance-state-dir.ts`
 * owns that name so the writers and the agent-side readers cannot disagree about it.
 */
const databasePath = financePositionLedgerPath;

const POSITION_LEDGER_MIGRATION_LEDGER = "finance_position_migrations";
const POSITION_LEDGER_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: "append-only execution receipt and mark ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS finance_position_records (
        kind TEXT NOT NULL, record_key TEXT NOT NULL, sequence INTEGER NOT NULL,
        ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
        PRIMARY KEY(kind,record_key), UNIQUE(sequence)
      );
      CREATE TRIGGER IF NOT EXISTS finance_position_no_update BEFORE UPDATE ON finance_position_records BEGIN SELECT RAISE(ABORT,'position records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS finance_position_no_delete BEFORE DELETE ON finance_position_records BEGIN SELECT RAISE(ABORT,'position records are append-only'); END;
    `,
  },
  {
    version: 2,
    description: "projection watermarks",
    sql: `
      CREATE TABLE IF NOT EXISTS finance_position_projection_state (
        projection TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
        ref TEXT, updated_at TEXT NOT NULL
      );
    `,
  },
];

type PositionDatabase = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

/**
 * Read every record and re-verify the chain. A row whose stored `ref` no longer matches its
 * body, or whose sequence or back-link is off, is a hard error rather than a silent skip.
 */
function readStoredRecords(db: PositionDatabase): FinancePositionRecord[] {
  const rows = db.prepare("SELECT ref, body FROM finance_position_records ORDER BY sequence").all();
  let previousRef: string | null = null;
  return rows.map((row, index) => {
    if (typeof row.body !== "string" || typeof row.ref !== "string") {
      throw new Error("invalid position record");
    }
    const raw: unknown = JSON.parse(row.body);
    if (caseflowFingerprint(raw) !== row.ref) {
      throw new Error("position record integrity mismatch");
    }
    const record = StoredRecordSchema.parse(raw);
    if (record.sequence !== index + 1 || record.previousRef !== previousRef) {
      throw new Error("position record chain mismatch");
    }
    previousRef = row.ref;
    return { ...record, ref: row.ref };
  });
}

async function appendRecord(
  directory: string,
  body: FinancePositionRecordBody,
  recordKey: string,
  observedAt: string,
): Promise<FinancePositionRecordAppend> {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) {
    throw new Error("position record requires an ISO observation timestamp");
  }
  if (observed > Date.now()) {
    // A fill or a mark dated in the future is not an observation, and admitting one would
    // price today's position with a number from tomorrow.
    throw new Error("position record observation cannot be dated in the future");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath(directory));
  try {
    chmodSync(databasePath(directory), 0o600);
    // auto_vacuum must be set before the first journal_mode=WAL write: switching to WAL
    // initialises the database file and silently freezes auto_vacuum afterwards.
    db.exec(
      `PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
    );
    applySqliteMigrations({
      db,
      ledgerTable: POSITION_LEDGER_MIGRATION_LEDGER,
      migrations: POSITION_LEDGER_MIGRATIONS,
    });
    db.exec("BEGIN IMMEDIATE");
    try {
      const records = readStoredRecords(db);
      const existing = records.find(
        (item) => item.body.kind === body.kind && item.recordKey === recordKey,
      );
      if (existing) {
        const comparable = (value: typeof body) => {
          if (
            value.kind === "receipt" &&
            value.receipt.adapterKind === "venue" &&
            value.receipt.fill.terminalOrderIdentity?.terminal
          ) {
            const { recordedAt: _observedAt, ...economicReceipt } = value.receipt;
            return { ...value, receipt: economicReceipt };
          }
          return value;
        };
        if (
          caseflowFingerprint(comparable(existing.body)) !== caseflowFingerprint(comparable(body))
        ) {
          throw new Error(
            `position record ${recordKey} already recorded with different content; ` +
              "the ledger is append-only and has no correction path",
          );
        }
        db.exec("COMMIT");
        return Object.freeze({ record: existing, appended: false });
      }
      const record = StoredRecordSchema.parse({
        schemaVersion: FINANCE_POSITION_RECORD_SCHEMA,
        recordKey,
        sequence: records.length + 1,
        previousRef: records.at(-1)?.ref ?? null,
        recordedAt: new Date().toISOString(),
        body,
      });
      const ref = caseflowFingerprint(record);
      db.prepare(
        "INSERT INTO finance_position_records(kind,record_key,sequence,ref,body) VALUES (?,?,?,?,?)",
      ).run(body.kind, recordKey, record.sequence, ref, JSON.stringify(record));
      db.exec("COMMIT");
      return Object.freeze({ record: Object.freeze({ ...record, ref }), appended: true });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * Record one execution receipt. Idempotent on `receiptId`: replaying the same receipt never
 * counts the fill twice, which is the one failure a position ledger cannot recover from.
 */
export async function appendFinanceExecutionReceipt(
  directory: string,
  receipt: FinanceExecutionReceipt,
): Promise<FinancePositionRecordAppend> {
  const parsed = FinanceExecutionReceiptRecordSchema.parse(receipt);
  return appendRecord(
    directory,
    { kind: "receipt", receipt: parsed },
    `receipt:${parsed.receiptId}`,
    parsed.recordedAt,
  );
}

/**
 * Record one mark. Idempotent on `(instrument, at)`; a second, different price for the same
 * instrument at the same instant is a conflict rather than a silent overwrite.
 */
export async function appendFinancePositionMark(
  directory: string,
  mark: FinancePositionMark,
): Promise<FinancePositionRecordAppend> {
  const parsed = FinancePositionMarkRecordSchema.parse(mark);
  const instrument = normalizeInstrument(parsed.instrument);
  return appendRecord(
    directory,
    { kind: "mark", mark: { instrument, price: parsed.price, at: parsed.at } },
    `mark:${instrument}@${parsed.at}`,
    parsed.at,
  );
}

/** Open the ledger read-only, or `null` when no database file exists yet. */
async function openReadOnly(directory: string): Promise<PositionDatabase | null> {
  try {
    await fs.access(databasePath(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(databasePath(directory), { readOnly: true });
}

/**
 * A table can be absent from a database that was written before the migration which adds it, so
 * every optional table is probed explicitly instead of matching a driver error string.
 */
function hasTable(db: PositionDatabase, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(name).length > 0
  );
}

/** Read the stored stream. An absent database is an empty ledger, not an error. */
export async function readFinancePositionRecords(
  directory: string,
): Promise<FinancePositionRecordsRead> {
  const empty: FinancePositionRecordsRead = Object.freeze({
    records: Object.freeze([] as FinancePositionRecord[]),
    receipts: Object.freeze([] as FinanceExecutionReceipt[]),
    marks: Object.freeze([] as FinancePositionMark[]),
    headRef: null,
  });
  const db = await openReadOnly(directory);
  if (!db) {
    return empty;
  }
  try {
    if (!hasTable(db, "finance_position_records")) {
      return empty;
    }
    const records = readStoredRecords(db);
    return Object.freeze({
      records: Object.freeze(records),
      receipts: Object.freeze(
        records.flatMap((item) => (item.body.kind === "receipt" ? [item.body.receipt] : [])),
      ),
      marks: Object.freeze(
        records.flatMap((item) => (item.body.kind === "mark" ? [item.body.mark] : [])),
      ),
      headRef: records.at(-1)?.ref ?? null,
    });
  } finally {
    db.close();
  }
}

/**
 * Re-derive positions and PnL from the stored stream, optionally as of an instant. Marks
 * after `asOf` are excluded, so a historical view is reproducible instead of "latest wins".
 */
export async function readFinancePositionLedger(
  directory: string,
  options: { asOf?: string } = {},
): Promise<FinancePositionLedgerRead> {
  const read = await readFinancePositionRecords(directory);
  const asOf = options.asOf?.trim() ?? "";
  if (asOf.length > 0 && !Number.isFinite(Date.parse(asOf))) {
    throw new Error("asOf must be an ISO datetime");
  }
  const considered =
    asOf.length === 0
      ? read.marks
      : read.marks.filter((mark) => Date.parse(mark.at) <= Date.parse(asOf));
  // The projection lets the last mark per instrument win, so sorting by time makes "last"
  // mean "latest"; a stable sort keeps append order as the tie-break.
  const ordered = considered.toSorted((left, right) => left.at.localeCompare(right.at));
  return Object.freeze({
    ledger: projectFinancePositions({ receipts: read.receipts, marks: ordered }),
    receipts: Object.freeze([...read.receipts]),
    marks: Object.freeze([...ordered]),
    recordCount: read.records.length,
    receiptRecordCount: read.receipts.length,
    markRecordCount: read.marks.length,
    headRef: read.headRef,
  });
}

/**
 * Projection watermarks.
 *
 * The store above accumulates the record stream; everything read out of it — positions, PnL,
 * the equity curve — is a projection re-derived on demand. That recomputation is what stops a
 * derived number from disagreeing with the fills behind it, but it also means the ledger cannot
 * answer *which stream head a projection was last derived from*, and a consumer that caches
 * anything has no way to tell whether its cache is still current.
 *
 * A watermark answers exactly that and nothing more. It stores the *cursor* — the highest
 * `sequence` and its `ref` — and deliberately stores no derived value, so it can never become a
 * second source of truth. It is advanced only by an explicit `advance…` call: a read must not
 * mutate the file, because the agent-side read tool proves its read-only claim by observing
 * that the database does not change.
 */
export const FINANCE_POSITION_LEDGER_PROJECTION = "position_ledger" as const;

export type FinancePositionProjectionWatermark = Readonly<{
  projection: string;
  /** Highest `sequence` this projection is known to have consumed. `0` when it never ran. */
  sequence: number;
  /** `ref` of that record — the chain head the projection last saw. `null` when it never ran. */
  ref: string | null;
  updatedAt: string | null;
}>;

export type FinancePositionProjectionStatus = FinancePositionProjectionWatermark &
  Readonly<{
    /** Stream head at read time. `0` for an empty ledger. */
    headSequence: number;
    headRef: string | null;
    /** Records the stream holds that the projection has not consumed. `0` when current. */
    recordsSince: number;
    /** `true` when the stream has advanced past the watermark. */
    stale: boolean;
  }>;

const NEVER_PROJECTED: Omit<FinancePositionProjectionWatermark, "projection"> = Object.freeze({
  sequence: 0,
  ref: null,
  updatedAt: null,
});

function readWatermark(
  db: PositionDatabase,
  projection: string,
): FinancePositionProjectionWatermark {
  if (!hasTable(db, "finance_position_projection_state")) {
    return Object.freeze({ projection, ...NEVER_PROJECTED });
  }
  const row = db
    .prepare(
      "SELECT sequence, ref, updated_at FROM finance_position_projection_state WHERE projection=?",
    )
    .get(projection) as { sequence: number; ref: string | null; updated_at: string } | undefined;
  if (!row) {
    return Object.freeze({ projection, ...NEVER_PROJECTED });
  }
  return Object.freeze({
    projection,
    sequence: row.sequence,
    ref: row.ref,
    updatedAt: row.updated_at,
  });
}

/**
 * Sequences are contiguous from 1 — the chain read enforces `sequence === index + 1` — so the
 * gap between the head and the watermark is the exact number of unconsumed records.
 */
function statusOf(
  watermark: FinancePositionProjectionWatermark,
  head: FinancePositionRecord | undefined,
): FinancePositionProjectionStatus {
  const headSequence = head?.sequence ?? 0;
  const recordsSince = Math.max(0, headSequence - watermark.sequence);
  return Object.freeze({
    ...watermark,
    headSequence,
    headRef: head?.ref ?? null,
    recordsSince,
    stale: recordsSince > 0,
  });
}

/**
 * Report how far `projection` has consumed the stream. Read-only: the watermark is never
 * advanced here, so a stale projection stays visibly stale.
 */
export async function readFinancePositionProjectionStatus(
  directory: string,
  projection: string = FINANCE_POSITION_LEDGER_PROJECTION,
): Promise<FinancePositionProjectionStatus> {
  const read = await readFinancePositionRecords(directory);
  const head = read.records.at(-1);
  const db = await openReadOnly(directory);
  if (!db) {
    return statusOf(Object.freeze({ projection, ...NEVER_PROJECTED }), head);
  }
  try {
    return statusOf(readWatermark(db, projection), head);
  } finally {
    db.close();
  }
}

/**
 * Record that `projection` has consumed the stream up to its current head. The only writer of
 * the watermark table: advancing it from a read would break the read-only guarantee callers
 * rely on. Advancing over an empty ledger is allowed and pins the watermark at `sequence` 0.
 */
export async function advanceFinancePositionProjection(
  directory: string,
  params: { projection?: string } = {},
): Promise<FinancePositionProjectionStatus> {
  const projection = params.projection?.trim() || FINANCE_POSITION_LEDGER_PROJECTION;
  if (projection.length === 0) {
    throw new Error("projection name must not be blank");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath(directory));
  try {
    chmodSync(databasePath(directory), 0o600);
    // auto_vacuum must be set before the first journal_mode=WAL write: switching to WAL
    // initialises the database file and silently freezes auto_vacuum afterwards.
    db.exec(
      `PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
    );
    applySqliteMigrations({
      db,
      ledgerTable: POSITION_LEDGER_MIGRATION_LEDGER,
      migrations: POSITION_LEDGER_MIGRATIONS,
    });
    const head = readStoredRecords(db).at(-1);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "INSERT INTO finance_position_projection_state(projection,sequence,ref,updated_at) " +
          "VALUES (?,?,?,?) ON CONFLICT(projection) DO UPDATE SET " +
          "sequence=excluded.sequence, ref=excluded.ref, updated_at=excluded.updated_at",
      ).run(projection, head?.sequence ?? 0, head?.ref ?? null, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return statusOf(readWatermark(db, projection), head);
  } finally {
    db.close();
  }
}
