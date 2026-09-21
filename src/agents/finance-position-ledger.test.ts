import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  createPaperExecutionAdapter,
  DEFAULT_FINANCE_RISK_BUDGET,
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  type FinanceExecutionReceipt,
  placeFinanceOrder,
} from "./finance-execution-adapter.js";
import {
  advanceFinancePositionProjection,
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  FINANCE_POSITION_LEDGER_PROJECTION,
  FINANCE_POSITION_LEDGER_SCHEMA,
  projectFinancePositions,
  readFinancePositionLedger,
  readFinancePositionProjectionStatus,
  readFinancePositionRecords,
} from "./finance-position-ledger.js";
import { financePositionLedgerPath } from "./finance-state-dir.js";

let sequence = 0;

function receipt(overrides: Partial<FinanceExecutionReceipt> = {}): FinanceExecutionReceipt {
  sequence += 1;
  const at = overrides.recordedAt ?? `2026-09-18T00:00:${String(sequence).padStart(2, "0")}Z`;
  const side = overrides.side ?? "buy";
  const quantity = overrides.quantity ?? 10;
  const fillPrice = overrides.fill?.fillPrice ?? 100;
  return {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `r${sequence}`,
    intentId: `i${sequence}`,
    runAuthorizationId: "run-1",
    adapterId: "paper",
    adapterKind: "paper",
    venue: "paper",
    instrument: "AAPL",
    side,
    orderType: "market",
    quantity,
    referencePrice: fillPrice,
    referencePriceAt: at,
    notional: fillPrice * quantity,
    fill: { filledQuantity: quantity, fillPrice, filledAt: at, venueRef: "paper" },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: at,
    ...overrides,
  };
}

function fill(
  side: "buy" | "sell",
  quantity: number,
  fillPrice: number,
  at: string,
): FinanceExecutionReceipt {
  return receipt({
    side,
    quantity,
    recordedAt: at,
    fill: { filledQuantity: quantity, fillPrice, filledAt: at, venueRef: "paper" },
  });
}

function positionOf(receipts: readonly FinanceExecutionReceipt[], instrument = "AAPL") {
  const ledger = projectFinancePositions({ receipts });
  const position = ledger.positions.find((item) => item.instrument === instrument);
  if (position === undefined) {
    throw new Error(`no position for ${instrument}`);
  }
  return { ledger, position };
}

describe("finance position ledger", () => {
  it("opens a long position at the fill price and marks it unrealized against a supplied mark", () => {
    const { ledger, position } = positionOf(
      [fill("buy", 10, 100, "2026-09-18T01:00:00Z")],
      undefined,
    );
    const withMark = projectFinancePositions({
      receipts: [fill("buy", 10, 100, "2026-09-18T01:00:00Z")],
      marks: [{ instrument: "AAPL", price: 110, at: "2026-09-18T02:00:00Z" }],
    });

    expect(ledger.positions).toHaveLength(1);
    expect(position.quantity).toBe(10);
    expect(position.averageCost).toBe(100);
    expect(position.realizedPnl).toBe(0);
    expect(withMark.positions[0]).toMatchObject({
      markPrice: 110,
      markPriceAt: "2026-09-18T02:00:00Z",
      unrealizedPnl: 100,
    });
    expect(withMark.unrealizedPnl).toBe(100);
  });

  it("re-weights the average only when size is added", () => {
    const { position } = positionOf([
      fill("buy", 10, 100, "2026-09-18T01:00:00Z"),
      fill("buy", 10, 120, "2026-09-18T02:00:00Z"),
    ]);

    expect(position.quantity).toBe(20);
    expect(position.averageCost).toBe(110);
    expect(position.realizedPnl).toBe(0);
  });

  it("keeps the original cost basis when a position is partially closed", () => {
    const { ledger, position } = positionOf([
      fill("buy", 10, 100, "2026-09-18T01:00:00Z"),
      fill("sell", 4, 120, "2026-09-18T02:00:00Z"),
    ]);

    expect(position.quantity).toBe(6);
    // Re-weighting on a partial close would move this to 108 and misstate every later close.
    expect(position.averageCost).toBe(100);
    expect(position.realizedPnl).toBe(80);
    expect(ledger.realizedPnl).toBe(80);
  });

  it("realizes a loss on a full close and leaves the position flat with no cost", () => {
    const { position } = positionOf([
      fill("buy", 10, 100, "2026-09-18T01:00:00Z"),
      fill("sell", 10, 90, "2026-09-18T02:00:00Z"),
    ]);

    expect(position.quantity).toBe(0);
    expect(position.averageCost).toBe(0);
    expect(position.realizedPnl).toBe(-100);
    expect(position.unrealizedPnl).toBe(0);
  });

  it("handles a short with the same arithmetic as a long", () => {
    const profitableShort = positionOf([
      fill("sell", 10, 100, "2026-09-18T01:00:00Z"),
      fill("buy", 10, 90, "2026-09-18T02:00:00Z"),
    ]).position;
    expect(profitableShort.quantity).toBe(0);
    expect(profitableShort.realizedPnl).toBe(100);

    const openShort = positionOf([fill("sell", 10, 100, "2026-09-18T01:00:00Z")]).position;
    expect(openShort.quantity).toBe(-10);
    expect(openShort.averageCost).toBe(100);
  });

  it("marks an open short against the mark in the profitable direction", () => {
    const ledger = projectFinancePositions({
      receipts: [fill("sell", 10, 100, "2026-09-18T01:00:00Z")],
      marks: [{ instrument: "AAPL", price: 90, at: "2026-09-18T02:00:00Z" }],
    });

    expect(ledger.positions[0]?.unrealizedPnl).toBe(100);
  });

  it("starts a new cost basis when a fill flips the side", () => {
    const { position } = positionOf([
      fill("buy", 10, 100, "2026-09-18T01:00:00Z"),
      fill("sell", 15, 120, "2026-09-18T02:00:00Z"),
    ]);

    expect(position.quantity).toBe(-5);
    expect(position.averageCost).toBe(120);
    expect(position.realizedPnl).toBe(200);
  });

  it("states that unrealized PnL is unavailable instead of reporting it as zero", () => {
    const ledger = projectFinancePositions({
      receipts: [fill("buy", 10, 100, "2026-09-18T01:00:00Z")],
    });

    expect(ledger.unrealizedPnl).toBeNull();
    expect(ledger.instrumentsWithoutMark).toEqual(["AAPL"]);
    expect(ledger.positions[0]?.unrealizedPnl).toBeUndefined();
    expect(ledger.positions[0]?.unrealizedUnavailableReason).toBe(
      "mark_required_for_unrealized_pnl",
    );
  });

  it("rejects a mark with no timestamp or a non-positive price rather than assuming it is current", () => {
    const ledger = projectFinancePositions({
      receipts: [fill("buy", 10, 100, "2026-09-18T01:00:00Z")],
      marks: [
        { instrument: "AAPL", price: 110, at: "   " },
        { instrument: "MSFT", price: 0, at: "2026-09-18T02:00:00Z" },
      ],
    });

    expect(ledger.rejectedMarks).toEqual(["AAPL", "MSFT"]);
    expect(ledger.unrealizedPnl).toBeNull();
  });

  it("projects one ledger regardless of the order receipts were collected in", () => {
    const receipts = [
      fill("buy", 10, 100, "2026-09-18T01:00:00Z"),
      fill("sell", 4, 120, "2026-09-18T02:00:00Z"),
      fill("buy", 2, 130, "2026-09-18T03:00:00Z"),
    ];
    const forward = projectFinancePositions({ receipts });
    const reversed = projectFinancePositions({ receipts: receipts.toReversed() });

    expect(reversed.receiptFingerprint).toBe(forward.receiptFingerprint);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("counts paper and venue fills apart so a simulated ledger is never read as real", () => {
    const ledger = projectFinancePositions({
      receipts: [
        fill("buy", 10, 100, "2026-09-18T01:00:00Z"),
        receipt({
          side: "buy",
          quantity: 1,
          recordedAt: "2026-09-18T02:00:00Z",
          adapterId: "broker",
          adapterKind: "venue",
          venue: "broker",
          fill: {
            filledQuantity: 1,
            fillPrice: 101,
            filledAt: "2026-09-18T02:00:00Z",
            venueRef: "broker",
          },
        }),
      ],
    });

    expect(ledger.schemaVersion).toBe(FINANCE_POSITION_LEDGER_SCHEMA);
    expect(ledger.paperFillCount).toBe(1);
    expect(ledger.venueFillCount).toBe(1);
    expect(ledger.receiptCount).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Durable store                                                              */
/* -------------------------------------------------------------------------- */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-positions-"));
  directories.push(directory);
  return directory;
}

/** Safely in the past, so the store's future-observation guard is never what a test measures. */
const PAST = "2026-09-10T00:00:00Z";

function pastReceipt(overrides: Partial<FinanceExecutionReceipt> = {}): FinanceExecutionReceipt {
  return receipt({ recordedAt: PAST, ...overrides });
}

function openDatabase(directory: string) {
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(financePositionLedgerPath(directory));
}

describe("finance position ledger store", () => {
  it("appends a receipt produced by the real execution seam and re-derives the position", async () => {
    const directory = await storeDirectory();
    const placement = await placeFinanceOrder({
      mode: "live_execution",
      adapters: [createPaperExecutionAdapter({ instruments: ["AAPL"] })],
      executionAdapterId: "paper",
      budget: { ...DEFAULT_FINANCE_RISK_BUDGET, allowedInstruments: ["AAPL"] },
      committedInstrumentNotional: 0,
      ordersPlacedThisRun: 0,
      intent: {
        intentId: "intent-store-1",
        instrument: "AAPL",
        side: "buy",
        orderType: "market",
        quantity: 10,
        referencePrice: 100,
        referencePriceAt: PAST,
        runAuthorizationId: "run-1",
        rationale: "store round trip",
      },
    });
    if (placement.receipt === undefined) {
      throw new Error(`expected a placed order, got ${placement.refusalReasons.join(",")}`);
    }
    // The persisted schema is the only thing standing between a real receipt and the ledger,
    // so storing one this seam actually produced is the check that it has not drifted.
    expect((await appendFinanceExecutionReceipt(directory, placement.receipt)).appended).toBe(true);

    const read = await readFinancePositionLedger(directory);
    expect(read.receiptRecordCount).toBe(1);
    expect(read.ledger.receiptCount).toBe(1);
    expect(read.ledger.positions[0]).toMatchObject({
      instrument: "AAPL",
      quantity: 10,
      averageCost: 100,
      unrealizedUnavailableReason: "mark_required_for_unrealized_pnl",
    });
    expect(read.ledger.unrealizedPnl).toBeNull();

    await appendFinancePositionMark(directory, {
      instrument: "aapl",
      price: 110,
      at: "2026-09-11T00:00:00Z",
    });
    const marked = await readFinancePositionLedger(directory);
    expect(marked.ledger.positions[0]?.markPrice).toBe(110);
    expect(marked.ledger.unrealizedPnl).toBe(100);
  });

  it("does not count a replayed receipt twice", async () => {
    const directory = await storeDirectory();
    const one = pastReceipt({ quantity: 10 });

    const first = await appendFinanceExecutionReceipt(directory, one);
    const replay = await appendFinanceExecutionReceipt(directory, one);

    expect(first.appended).toBe(true);
    expect(replay.appended).toBe(false);
    expect(replay.record.ref).toBe(first.record.ref);
    const read = await readFinancePositionLedger(directory);
    expect(read.recordCount).toBe(1);
    expect(read.ledger.positions[0]?.quantity).toBe(10);
  });

  it("refuses a second receipt with the same id but different content", async () => {
    const directory = await storeDirectory();
    const one = pastReceipt({ quantity: 10 });
    await appendFinanceExecutionReceipt(directory, one);

    await expect(
      appendFinanceExecutionReceipt(directory, { ...one, quantity: 11, notional: 1_100 }),
    ).rejects.toThrow(/already recorded with different content/u);

    const read = await readFinancePositionLedger(directory);
    expect(read.receiptRecordCount).toBe(1);
    expect(read.ledger.positions[0]?.quantity).toBe(10);
  });

  it("treats an identical mark as a replay and a different price at the same instant as a conflict", async () => {
    const directory = await storeDirectory();
    const mark = { instrument: "AAPL", price: 110, at: "2026-09-11T00:00:00Z" };

    expect((await appendFinancePositionMark(directory, mark)).appended).toBe(true);
    expect(
      (await appendFinancePositionMark(directory, { ...mark, instrument: " aapl " })).appended,
    ).toBe(false);
    await expect(appendFinancePositionMark(directory, { ...mark, price: 111 })).rejects.toThrow(
      /already recorded with different content/u,
    );

    const read = await readFinancePositionRecords(directory);
    expect(read.records).toHaveLength(1);
    expect(read.marks).toEqual([{ instrument: "AAPL", price: 110, at: mark.at }]);
  });

  it("refuses a fill or a mark dated in the future", async () => {
    const directory = await storeDirectory();
    const future = new Date(Date.now() + 86_400_000).toISOString();

    await expect(
      appendFinanceExecutionReceipt(directory, pastReceipt({ recordedAt: future })),
    ).rejects.toThrow(/cannot be dated in the future/u);
    await expect(
      appendFinancePositionMark(directory, { instrument: "AAPL", price: 1, at: future }),
    ).rejects.toThrow(/cannot be dated in the future/u);

    expect((await readFinancePositionRecords(directory)).records).toEqual([]);
  });

  it("keeps the table append-only at the database level", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, pastReceipt());
    const db = openDatabase(directory);
    try {
      expect(() =>
        db.exec("UPDATE finance_position_records SET body='{}' WHERE sequence=1"),
      ).toThrow(/append-only/u);
      expect(() => db.exec("DELETE FROM finance_position_records WHERE sequence=1")).toThrow(
        /append-only/u,
      );
    } finally {
      db.close();
    }
  });

  it("rejects a stored record whose body no longer matches its ref", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, pastReceipt({ quantity: 10 }));
    const db = openDatabase(directory);
    try {
      // Drop the guard so the file can be edited the way an out-of-band change would.
      db.exec("DROP TRIGGER finance_position_no_update");
      const rows = db.prepare("SELECT body FROM finance_position_records WHERE sequence=1").all();
      const stored = rows[0];
      if (stored === undefined || typeof stored.body !== "string") {
        throw new Error("expected a stored record body");
      }
      const tampered = stored.body.replace('"quantity":10', '"quantity":999');
      // Guard against a silent no-op: the tamper must actually change the stored bytes.
      expect(tampered).not.toBe(stored.body);
      db.prepare("UPDATE finance_position_records SET body=? WHERE sequence=1").run(tampered);
    } finally {
      db.close();
    }

    await expect(readFinancePositionRecords(directory)).rejects.toThrow(/integrity mismatch/u);
  });

  it("links every record to its predecessor and reports the chain head", async () => {
    const directory = await storeDirectory();
    const first = await appendFinanceExecutionReceipt(
      directory,
      pastReceipt({ recordedAt: "2026-09-10T01:00:00Z" }),
    );
    const second = await appendFinancePositionMark(directory, {
      instrument: "AAPL",
      price: 110,
      at: "2026-09-10T02:00:00Z",
    });

    expect(first.record.previousRef).toBeNull();
    expect(first.record.sequence).toBe(1);
    expect(second.record.previousRef).toBe(first.record.ref);
    expect(second.record.sequence).toBe(2);

    const read = await readFinancePositionRecords(directory);
    expect(read.records).toHaveLength(2);
    expect(read.headRef).toBe(second.record.ref);
  });

  it("reports an empty ledger for a directory that was never written", async () => {
    const directory = await storeDirectory();

    const read = await readFinancePositionLedger(directory);
    expect(read).toMatchObject({
      recordCount: 0,
      receiptRecordCount: 0,
      markRecordCount: 0,
      headRef: null,
    });
    expect(read.ledger.positions).toEqual([]);
    expect(read.ledger.realizedPnl).toBe(0);
    expect(read.ledger.unrealizedPnl).toBe(0);
  });

  it("treats a database file with no table as an empty ledger", async () => {
    const directory = await storeDirectory();
    openDatabase(directory).close();

    const read = await readFinancePositionLedger(directory);
    expect(read.recordCount).toBe(0);
    expect(read.headRef).toBeNull();
  });

  it("excludes marks after the requested instant so a historical view is reproducible", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, pastReceipt({ quantity: 10 }));
    await appendFinancePositionMark(directory, {
      instrument: "AAPL",
      price: 110,
      at: "2026-09-11T00:00:00Z",
    });
    await appendFinancePositionMark(directory, {
      instrument: "AAPL",
      price: 130,
      at: "2026-09-12T00:00:00Z",
    });

    const historical = await readFinancePositionLedger(directory, {
      asOf: "2026-09-11T12:00:00Z",
    });
    expect(historical.markRecordCount).toBe(2);
    expect(historical.ledger.positions[0]?.markPrice).toBe(110);
    expect(historical.ledger.unrealizedPnl).toBe(100);

    const latest = await readFinancePositionLedger(directory);
    expect(latest.ledger.positions[0]?.markPrice).toBe(130);
    expect(latest.ledger.unrealizedPnl).toBe(300);
  });

  it("re-derives exactly what the same receipts and marks project to directly", async () => {
    const directory = await storeDirectory();
    const receipts = [
      pastReceipt({ side: "buy", quantity: 10, recordedAt: "2026-09-10T01:00:00Z" }),
      pastReceipt({ side: "sell", quantity: 4, recordedAt: "2026-09-10T02:00:00Z" }),
    ];
    for (const item of receipts) {
      await appendFinanceExecutionReceipt(directory, item);
    }
    const marks = [{ instrument: "AAPL", price: 130, at: "2026-09-10T03:00:00Z" }];
    await appendFinancePositionMark(directory, marks[0]);

    const read = await readFinancePositionLedger(directory);
    expect(JSON.stringify(read.ledger)).toBe(
      JSON.stringify(projectFinancePositions({ receipts, marks })),
    );
    expect(read.ledger.positions[0]).toMatchObject({
      quantity: 6,
      averageCost: 100,
      realizedPnl: 0,
    });
  });

  it("keeps paper and venue fills counted apart after a round trip through storage", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(
      directory,
      pastReceipt({ recordedAt: "2026-09-10T01:00:00Z" }),
    );
    await appendFinanceExecutionReceipt(
      directory,
      pastReceipt({
        recordedAt: "2026-09-10T02:00:00Z",
        adapterId: "broker",
        adapterKind: "venue",
        venue: "broker",
        fill: {
          filledQuantity: 1,
          fillPrice: 101,
          filledAt: "2026-09-10T02:00:00Z",
          venueRef: "broker",
        },
      }),
    );

    const read = await readFinancePositionLedger(directory);
    expect(read.ledger.paperFillCount).toBe(1);
    expect(read.ledger.venueFillCount).toBe(1);
    expect(read.ledger.receiptCount).toBe(2);
  });

  it("refuses a receipt that is missing a persisted field instead of storing a partial record", async () => {
    const directory = await storeDirectory();
    const broken = { ...pastReceipt(), fill: undefined } as unknown as FinanceExecutionReceipt;

    await expect(appendFinanceExecutionReceipt(directory, broken)).rejects.toThrow();
    expect((await readFinancePositionRecords(directory)).records).toEqual([]);
  });
});

describe("finance position projection watermarks", () => {
  it("reports a projection that never ran as stale once the stream has records", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, pastReceipt());

    const status = await readFinancePositionProjectionStatus(directory);
    expect(status).toMatchObject({
      projection: FINANCE_POSITION_LEDGER_PROJECTION,
      sequence: 0,
      ref: null,
      updatedAt: null,
      headSequence: 1,
      recordsSince: 1,
      stale: true,
    });
    expect(status.headRef).not.toBeNull();
  });

  it("becomes current only after the projection is advanced, and goes stale again on the next append", async () => {
    const directory = await storeDirectory();
    const receiptRecord = await appendFinanceExecutionReceipt(directory, pastReceipt());

    const advanced = await advanceFinancePositionProjection(directory);
    expect(advanced).toMatchObject({
      sequence: 1,
      ref: receiptRecord.record.ref,
      headSequence: 1,
      recordsSince: 0,
      stale: false,
    });
    expect(advanced.updatedAt).not.toBeNull();

    const mark = await appendFinancePositionMark(directory, {
      instrument: "AAPL",
      price: 110,
      at: "2026-09-11T00:00:00Z",
    });
    const stale = await readFinancePositionProjectionStatus(directory);
    expect(stale).toMatchObject({ sequence: 1, headSequence: 2, recordsSince: 1, stale: true });
    expect(stale.headRef).toBe(mark.record.ref);

    const caughtUp = await advanceFinancePositionProjection(directory);
    expect(caughtUp).toMatchObject({ sequence: 2, recordsSince: 0, stale: false });
  });

  it("never advances the watermark from a read, so a stale projection stays visibly stale", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, pastReceipt());

    await readFinancePositionLedger(directory);
    await readFinancePositionProjectionStatus(directory);
    await readFinancePositionProjectionStatus(directory);

    // The agent-side read tool proves its read-only claim by observing that nothing changed;
    // a read that quietly advanced this cursor would break that proof.
    expect((await readFinancePositionProjectionStatus(directory)).sequence).toBe(0);
  });

  it("tracks projections independently by name", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, pastReceipt());

    await advanceFinancePositionProjection(directory, { projection: "equity_curve" });

    expect(await readFinancePositionProjectionStatus(directory, "equity_curve")).toMatchObject({
      projection: "equity_curve",
      sequence: 1,
      stale: false,
    });
    expect(await readFinancePositionProjectionStatus(directory)).toMatchObject({
      projection: FINANCE_POSITION_LEDGER_PROJECTION,
      sequence: 0,
      stale: true,
    });
  });

  it("pins an advance over an empty ledger at sequence zero rather than inventing a head", async () => {
    const directory = await storeDirectory();

    const status = await advanceFinancePositionProjection(directory);
    expect(status).toMatchObject({ sequence: 0, ref: null, headSequence: 0, recordsSince: 0 });
    expect(status.stale).toBe(false);
    expect(status.headRef).toBeNull();
  });

  it("reports a zeroed watermark for a database written before the watermark migration", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, pastReceipt());
    const db = openDatabase(directory);
    try {
      db.exec("DROP TABLE finance_position_projection_state");
    } finally {
      db.close();
    }

    // An absent table must read as "never projected", not as an error and not as "current".
    const status = await readFinancePositionProjectionStatus(directory);
    expect(status).toMatchObject({ sequence: 0, updatedAt: null, stale: true, recordsSince: 1 });
  });

  it("records the watermark migration in the migration ledger", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, pastReceipt());
    const db = openDatabase(directory);
    try {
      const versions = db
        .prepare("SELECT version FROM finance_position_migrations ORDER BY version")
        .all()
        .map((row) => (row as { version: number }).version);
      expect(versions).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });
});

it("replays terminal venue receipt once but rejects changed economic fields or venue event time", async () => {
  const directory = await storeDirectory();
  const first = receipt({
    adapterKind: "venue",
    adapterId: "alpaca",
    venue: "alpaca:paper",
    recordedAt: PAST,
    fill: {
      filledQuantity: 10,
      fillPrice: 100,
      filledAt: PAST,
      venueRef: "alpaca:paper:order1",
      terminalOrderIdentity: { orderId: "order1", terminal: true },
    },
  });
  expect((await appendFinanceExecutionReceipt(directory, first)).appended).toBe(true);
  expect(
    (
      await appendFinanceExecutionReceipt(directory, {
        ...first,
        recordedAt: "2026-09-11T00:00:00Z",
      })
    ).appended,
  ).toBe(false);
  expect((await readFinancePositionLedger(directory)).ledger.positions[0].quantity).toBe(10);
  await expect(
    appendFinanceExecutionReceipt(directory, { ...first, fill: { ...first.fill, fillPrice: 101 } }),
  ).rejects.toThrow("different content");
  await expect(
    appendFinanceExecutionReceipt(directory, {
      ...first,
      fill: { ...first.fill, filledAt: "2026-09-11T00:00:00Z" },
    }),
  ).rejects.toThrow("different content");
});
