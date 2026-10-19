import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import * as caseflow from "./finance-caseflow.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  createPaperExecutionAdapter,
  DEFAULT_FINANCE_RISK_BUDGET,
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  type FinanceExecutionReceipt,
  type FinanceOrderPlacementRequest,
  placeFinanceOrder,
} from "./finance-execution-adapter.js";
import { syntheticSafetyContext } from "./finance-execution-safety.test-support.js";
import {
  advanceFinancePositionProjection,
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  appendFinanceBrokerHistory,
  FINANCE_POSITION_LEDGER_PROJECTION,
  FINANCE_POSITION_LEDGER_SCHEMA,
  projectFinancePositions,
  readFinancePositionLedger,
  readFinancePositionProjectionStatus,
  readFinancePositionRecords,
  readFinanceLatestBrokerReconciliations,
  readFinanceBrokerHistoryRecords,
  reduceFinanceBrokerHistoryRecords,
  readFinanceBrokerHistoryActivities,
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
  it("counts historical maintenance fills without manufacturing an LCX short or entry PnL", () => {
    const maintenance = receipt({
      side: "sell",
      adapterKind: "venue",
      venue: "alpaca:paper",
      accountId: "paper-account",
      decisionRef: { source: "account_position_maintenance", id: "maintenance-1" },
    });
    const ledger = projectFinancePositions({ receipts: [maintenance] });
    expect(ledger.receiptCount).toBe(1);
    expect(ledger.venueFillCount).toBe(1);
    expect(ledger.positions).toEqual([]);
    expect(ledger.unattributedMaintenanceReceiptIds).toEqual([maintenance.receiptId]);
    expect(ledger.maintenancePnlStatus).toBe("unknown_requires_broker_history");
  });
  it.each([
    { side: "buy" as const },
    { adapterKind: "paper" as const },
    { venue: "alpaca:live" },
    { accountId: undefined },
    { accountId: " " },
  ])("refuses unsupported maintenance attribution: %j", (override) => {
    expect(() =>
      projectFinancePositions({
        receipts: [
          receipt({
            side: "sell",
            adapterKind: "venue",
            venue: "alpaca:paper",
            accountId: "paper-account",
            decisionRef: { source: "account_position_maintenance", id: "maintenance-1" },
            ...override,
          }),
        ],
      }),
    ).toThrow("invalid account position maintenance receipt");
  });
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
    const request: FinanceOrderPlacementRequest = {
      mode: "live_execution",
      adapters: [createPaperExecutionAdapter({ instruments: ["AAPL"] })],
      executionAdapterId: "paper",
      budget: {
        ...DEFAULT_FINANCE_RISK_BUDGET,
        allowedInstruments: ["AAPL"],
        maxOrderNotional: 2000,
        maxInstrumentNotional: 2000,
        maxOrdersPerRun: 1,
      },
      committedInstrumentNotional: 0,
      ordersPlacedThisRun: 0,
      intent: {
        intentId: "intent-store-1",
        instrument: "AAPL",
        side: "buy",
        orderType: "market",
        quantity: 10,
        referencePrice: 100,
        referencePriceAt: new Date().toISOString(),
        runAuthorizationId: "run-1",
        rationale: "store round trip",
      },
    };
    const placement = await placeFinanceOrder({
      ...request,
      safetyContext: syntheticSafetyContext({
        intent: request.intent,
        budget: request.budget,
        adapterId: "paper",
        venue: "paper",
      }),
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

  it("excludes fills and marks after the requested instant in a historical view", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, pastReceipt({ quantity: 10 }));
    const futureFill = pastReceipt({
      quantity: 5,
      fill: {
        filledQuantity: 5,
        fillPrice: 120,
        filledAt: "2026-09-12T00:00:00Z",
        venueRef: "paper",
      },
    });
    await appendFinanceExecutionReceipt(directory, futureFill);
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
    expect(historical.receipts).toHaveLength(1);
    expect(historical.ledger.receiptCount).toBe(1);
    expect(historical.ledger.positions[0]?.quantity).toBe(10);
    expect(historical.ledger.positions[0]?.markPrice).toBe(110);
    expect(historical.ledger.unrealizedPnl).toBe(100);

    const latest = await readFinancePositionLedger(directory);
    expect(latest.receipts).toHaveLength(2);
    expect(latest.ledger.positions[0]?.quantity).toBe(15);
    expect(latest.ledger.positions[0]?.markPrice).toBe(130);
    expect(latest.ledger.unrealizedPnl).toBe(350);
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
      expect(versions).toEqual([1, 2, 3]);
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

it("freezes research reconciliation cutoffs while current readers retain superseded checks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "broker-cutoff-"));
  try {
    const append = (query: string, observedAt: string) =>
      appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "paper-account",
        venue: "alpaca:paper",
        query,
        cursor: "",
        payload: [{ observedAt, status: "reconciled", differences: [], positions: [] }],
      });
    await append("reconciliation:before", "2026-10-03T00:00:00Z");
    const before = await readFinanceLatestBrokerReconciliations(directory, {
      asOf: "2026-10-03T00:00:01Z",
    });
    await append("reconciliation:after", "2026-10-03T00:00:02Z");
    expect(
      await readFinanceLatestBrokerReconciliations(directory, { asOf: "2026-10-03T00:00:01Z" }),
    ).toEqual(before);
    await append("orders:after", "2026-10-03T00:00:03Z");
    expect((await readFinanceLatestBrokerReconciliations(directory)).records[0].superseded).toBe(
      true,
    );
    expect(
      (await readFinanceLatestBrokerReconciliations(directory, { asOf: "2026-10-03T00:00:01Z" }))
        .records[0].superseded,
    ).toBe(false);
    await expect(
      readFinanceLatestBrokerReconciliations(directory, { asOf: "invalid" }),
    ).rejects.toThrow("invalid broker reconciliation cutoff");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("reuses canonical hashing only for byte-identical history, while returning fresh records", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: `hash-reuse-${directory}`,
    venue: "alpaca:paper",
    query: "activities:hash-reuse",
    cursor: "",
    payload: [{ id: "fill-1", quantity: 1 }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  const fingerprint = vi.spyOn(caseflow, "caseflowFingerprint");
  try {
    const cold = await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
    expect(fingerprint).toHaveBeenCalledTimes(1);
    cold.records[0].body.payload[0].quantity = 999;
    fingerprint.mockClear();
    const warm = await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
    expect(fingerprint).not.toHaveBeenCalled();
    expect(warm.records).toEqual([first.record]);

    const db = openDatabase(directory);
    try {
      const { ref: _ref, ...record } = first.record;
      db.exec("DROP TRIGGER finance_broker_history_no_update");
      db.prepare("UPDATE finance_broker_history SET body=? WHERE sequence=1").run(
        JSON.stringify(record, null, 2),
      );
    } finally {
      db.close();
    }
    const reformatted = await readFinanceBrokerHistoryRecords(
      directory,
      body.accountId,
      body.venue,
    );
    expect(fingerprint).toHaveBeenCalledTimes(1);
    expect(reformatted.records).toEqual([first.record]);
  } finally {
    fingerprint.mockRestore();
  }
});

it("keeps header normalization and fresh payloads when reusing verified byte-identical rows", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "normalized-proof",
    venue: "alpaca:paper",
    query: "activities:proof",
    cursor: "",
    payload: [{ id: "fill", qty: "1" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  const { ref: _ref, ...raw } = first.record;
  raw.body.accountId = " normalized-proof ";
  raw.body.venue = " alpaca:paper ";
  raw.body.query = " activities:proof ";
  const db = openDatabase(directory);
  try {
    db.exec("DROP TRIGGER finance_broker_history_no_update");
    db.prepare("UPDATE finance_broker_history SET body=?,ref=? WHERE sequence=1").run(
      JSON.stringify(raw),
      caseflowFingerprint(raw),
    );
  } finally {
    db.close();
  }
  const cold = await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
  expect(cold.records[0].body).toEqual(body);
  cold.records[0].body.payload[0].qty = "999";
  const warm = await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
  expect(warm.records[0].body).toEqual(body);
});

it("retains full payload normalization when the original schema transformed a raw field", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "payload-transform-proof",
    venue: "alpaca:paper",
    query: "activities:proof",
    cursor: "",
    payload: [{ id: "fill", qty: "1" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  const { ref: _ref, ...raw } = first.record;
  raw.body.payload[0] = JSON.parse('{"id":"fill","qty":"1","__proto__":{"polluted":true}}');
  const db = openDatabase(directory);
  try {
    db.exec("DROP TRIGGER finance_broker_history_no_update");
    db.prepare("UPDATE finance_broker_history SET body=?,ref=? WHERE sequence=1").run(
      JSON.stringify(raw),
      caseflowFingerprint(raw),
    );
  } finally {
    db.close();
  }
  const cold = await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
  const warm = await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
  expect(warm).toEqual(cold);
  expect(Object.getPrototypeOf(warm.records[0].body.payload[0])).toBe(Object.prototype);
});

it.each(["duplicate", "new"] as const)(
  "materializes only a selected duplicate after warm history validation: %s",
  async (operation) => {
    const directory = await storeDirectory();
    const body = {
      kind: "broker_history" as const,
      accountId: `lazy-append-${operation}`,
      venue: "alpaca:paper",
      query: "activities:lazy",
      cursor: "",
      payload: [{ id: "fill", note: "x".repeat(4096) }],
    };
    const first = await appendFinanceBrokerHistory(directory, body);
    const tail = await appendFinanceBrokerHistory(directory, { ...body, accountId: "foreign" });
    await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
    const db = openDatabase(directory);
    let encodings: Set<string>;
    try {
      encodings = new Set(
        db
          .prepare("SELECT body FROM finance_broker_history")
          .all()
          .map((row) => String(row.body)),
      );
    } finally {
      db.close();
    }
    const parse = vi.spyOn(JSON, "parse");
    try {
      const result = await appendFinanceBrokerHistory(
        directory,
        operation === "duplicate" ? body : { ...body, query: "activities:new" },
      );
      const decodedHistoryRows = parse.mock.calls.filter(([raw]) => encodings.has(raw));
      expect(decodedHistoryRows).toHaveLength(operation === "duplicate" ? 1 : 0);
      if (operation === "duplicate") {
        expect(result).toEqual({ appended: false, record: first.record });
      } else {
        expect(result.appended).toBe(true);
        expect(result.record.previousRef).toBe(tail.record.ref);
        expect(result.record.sequence).toBe(3);
      }
    } finally {
      parse.mockRestore();
    }
  },
);

it("fully validates newly encoded payloads even after an earlier proof was cached", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "changed-payload-proof",
    venue: "alpaca:paper",
    query: "activities:proof",
    cursor: "",
    payload: [{ id: "fill" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
  const { ref: _ref, ...record } = first.record;
  const raw = { ...record, body: { ...record.body, payload: ["invalid record"] } };
  const db = openDatabase(directory);
  try {
    db.exec("DROP TRIGGER finance_broker_history_no_update");
    db.prepare("UPDATE finance_broker_history SET body=?,ref=? WHERE sequence=1").run(
      JSON.stringify(raw),
      caseflowFingerprint(raw),
    );
  } finally {
    db.close();
  }
  await expect(
    readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue),
  ).rejects.toThrow();
});

it("falls back to full row decoding when a normalized header exceeds its cache budget", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "large-header-proof",
    venue: "alpaca:paper",
    query: `activities:${"界".repeat(2048)}`,
    cursor: "",
    payload: [{ id: "fill" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
  const db = openDatabase(directory);
  let encoding: string;
  try {
    encoding = String(db.prepare("SELECT body FROM finance_broker_history").get()?.body);
  } finally {
    db.close();
  }
  const parse = vi.spyOn(JSON, "parse");
  try {
    expect(await appendFinanceBrokerHistory(directory, body)).toEqual({
      record: first.record,
      appended: false,
    });
    expect(parse.mock.calls.filter(([raw]) => raw === encoding)).toHaveLength(1);
  } finally {
    parse.mockRestore();
  }
});

it("deduplicates cached normalized headers without retaining a returned payload mutation", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "normalized-append-proof",
    venue: "alpaca:paper",
    query: "activities:normalized-append",
    cursor: "",
    payload: [{ id: "fill", qty: "1" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  const { ref: _ref, ...raw } = first.record;
  raw.body.accountId = ` ${body.accountId} `;
  raw.body.query = ` ${body.query} `;
  const db = openDatabase(directory);
  try {
    db.exec("DROP TRIGGER finance_broker_history_no_update");
    db.prepare("UPDATE finance_broker_history SET body=?,ref=? WHERE sequence=1").run(
      JSON.stringify(raw),
      caseflowFingerprint(raw),
    );
  } finally {
    db.close();
  }
  const expected = (await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue))
    .records[0];
  const read = await appendFinanceBrokerHistory(directory, body);
  read.record.body.payload[0].qty = "999";
  expect(await appendFinanceBrokerHistory(directory, body)).toEqual({
    appended: false,
    record: expected,
  });
});

it("preserves bounded prefix proofs when an append-only chain outgrows the cache", async () => {
  vi.resetModules();
  const freshLedger = await import("./finance-position-ledger.js");
  const freshCaseflow = await import("./finance-caseflow.js");
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "proof-capacity",
    venue: "alpaca:paper",
    query: "activities:capacity",
    cursor: "",
    payload: [{ id: "fill" }],
  };
  const first = await freshLedger.appendFinanceBrokerHistory(directory, body);
  let previousRef = first.record.ref;
  const db = openDatabase(directory);
  try {
    // Bulk fixture construction avoids quadratic append validation; the reader still
    // validates every synthetic row through the real schema and global chain.
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare(
      "INSERT INTO finance_broker_history(sequence,ref,body) VALUES (?,?,?)",
    );
    for (let sequence = 2; sequence <= 100_001; sequence += 1) {
      const row = { sequence, previousRef, body };
      previousRef = freshCaseflow.caseflowFingerprint(row);
      insert.run(sequence, previousRef, JSON.stringify(row));
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const read = () =>
    freshLedger.reduceFinanceBrokerHistoryRecords(
      directory,
      body.accountId,
      body.venue,
      0,
      (sum, record) => sum + record.sequence,
    );
  const cold = await read();
  expect(cold).toEqual({ value: 5_000_150_001, recordCount: 100_001, headRef: previousRef });
  const fingerprint = vi.spyOn(freshCaseflow, "caseflowFingerprint");
  try {
    expect(await read()).toEqual(cold);
    expect(fingerprint).toHaveBeenCalledTimes(1);
  } finally {
    fingerprint.mockRestore();
  }
}, 20_000);

it("rejects changed references even when serialized history has already been verified", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "cached-ref-account",
    venue: "alpaca:paper",
    query: "activities:cached-ref",
    cursor: "",
    payload: [{ id: "cached-fill", quantity: 1 }],
  };
  await appendFinanceBrokerHistory(directory, body);
  await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
  const db = openDatabase(directory);
  try {
    db.exec("DROP TRIGGER finance_broker_history_no_update");
    db.prepare("UPDATE finance_broker_history SET ref=? WHERE sequence=1").run("0".repeat(64));
  } finally {
    db.close();
  }
  await expect(
    readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue),
  ).rejects.toThrow("broker history chain mismatch");
  await expect(appendFinanceBrokerHistory(directory, body)).rejects.toThrow(
    "broker history chain mismatch",
  );
});

it("retains exact broker-observation deduplication and detects tampered predecessors", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "paper-account",
    venue: "alpaca:paper",
    query: "activities:window-a",
    cursor: "",
    payload: [{ id: "fill-1", quantity: 1 }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  expect((await appendFinanceBrokerHistory(directory, body)).appended).toBe(false);
  for (const changed of [
    { accountId: "other-account" },
    { venue: "alpaca:live" },
    { query: "activities:window-b" },
    { cursor: "page-2" },
    { payload: [{ id: "fill-1", quantity: 2 }] },
    {
      payload: [
        { id: "fill-1", quantity: 1 },
        { id: "fill-2", quantity: 1 },
      ],
    },
  ]) {
    expect((await appendFinanceBrokerHistory(directory, { ...body, ...changed })).appended).toBe(
      true,
    );
  }
  expect((await appendFinanceBrokerHistory(directory, body)).record.ref).toBe(first.record.ref);
  const db = openDatabase(directory);
  try {
    db.exec("DROP TRIGGER finance_broker_history_no_update");
    const row = db.prepare("SELECT body FROM finance_broker_history WHERE sequence=1").get();
    if (typeof row?.body !== "string") {
      throw new Error("missing broker fixture");
    }
    const corrupted = JSON.parse(row.body);
    corrupted.body.payload[0].quantity = 99;
    db.prepare("UPDATE finance_broker_history SET body=? WHERE sequence=1").run(
      JSON.stringify(corrupted),
    );
  } finally {
    db.close();
  }
  await expect(
    appendFinanceBrokerHistory(directory, { ...body, query: "different-window" }),
  ).rejects.toThrow("broker history chain mismatch");
});

it.each(["body", "sequence", "previousRef", "tail"] as const)(
  "validates foreign-account predecessors and tails before returning a duplicate: %s",
  async (corruption) => {
    const directory = await storeDirectory();
    const body = {
      kind: "broker_history" as const,
      accountId: "account-a",
      venue: "alpaca:paper",
      query: "reconciliation:first",
      cursor: "",
      payload: [{ observedAt: "2026-10-03T00:00:00Z" }],
    };
    await appendFinanceBrokerHistory(directory, body);
    await appendFinanceBrokerHistory(directory, { ...body, accountId: "account-b" });
    await appendFinanceBrokerHistory(directory, { ...body, query: "tail" });
    await readFinanceBrokerHistoryRecords(directory, "account-a", "alpaca:paper");
    const db = openDatabase(directory);
    try {
      db.exec("DROP TRIGGER finance_broker_history_no_update");
      const sequence = corruption === "tail" ? 3 : 2;
      const row = db
        .prepare("SELECT body FROM finance_broker_history WHERE sequence=?")
        .get(sequence);
      if (typeof row?.body !== "string") {
        throw new Error("missing broker fixture");
      }
      const record = JSON.parse(row.body);
      if (corruption === "sequence") {
        record.sequence = 99;
      } else if (corruption === "previousRef") {
        record.previousRef = null;
      } else {
        record.body.payload[0].changed = true;
      }
      db.prepare("UPDATE finance_broker_history SET body=?,ref=? WHERE sequence=?").run(
        JSON.stringify(record),
        corruption === "sequence" || corruption === "previousRef"
          ? caseflowFingerprint(record)
          : "0".repeat(64),
        sequence,
      );
    } finally {
      db.close();
    }
    await expect(
      readFinanceBrokerHistoryRecords(directory, "account-a", "alpaca:paper"),
    ).rejects.toThrow("broker history chain mismatch");
    await expect(
      reduceFinanceBrokerHistoryRecords(
        directory,
        "account-a",
        "alpaca:paper",
        0,
        (count) => count + 1,
      ),
    ).rejects.toThrow("broker history chain mismatch");
    await expect(readFinanceLatestBrokerReconciliations(directory)).rejects.toThrow(
      "broker history chain mismatch",
    );
    await expect(
      readFinanceLatestBrokerReconciliations(directory, {
        scope: { accountId: "account-a", venue: "alpaca:paper" },
      }),
    ).rejects.toThrow("broker history chain mismatch");
    await expect(appendFinanceBrokerHistory(directory, body)).rejects.toThrow(
      "broker history chain mismatch",
    );
    await expect(appendFinanceBrokerHistory(directory, { ...body, query: "new" })).rejects.toThrow(
      "broker history chain mismatch",
    );
    const after = openDatabase(directory);
    try {
      expect(
        after.prepare("SELECT count(*) AS count FROM finance_broker_history").get()?.count,
      ).toBe(3);
    } finally {
      after.close();
    }
  },
);

it("streams scoped observations and latest snapshots without losing global tail or dedup identity", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "account-a",
    venue: "alpaca:paper",
    query: "reconciliation:first",
    cursor: "",
    payload: [{ observedAt: "2026-10-03T00:00:00Z" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  await appendFinanceBrokerHistory(directory, { ...body, accountId: "account-b" });
  const tail = await appendFinanceBrokerHistory(directory, {
    ...body,
    accountId: "account-b",
    query: "orders:tail",
  });
  expect(await appendFinanceBrokerHistory(directory, body)).toEqual({
    record: first.record,
    appended: false,
  });
  const scoped = await readFinanceBrokerHistoryRecords(directory, "account-a", "alpaca:paper");
  expect(scoped).toEqual({ records: [first.record], headRef: first.record.ref });
  const latest = await readFinanceLatestBrokerReconciliations(directory);
  expect(latest.records.map((record) => [record.accountId, record.superseded])).toEqual([
    ["account-b", true],
    ["account-a", false],
  ]);
  const appended = await appendFinanceBrokerHistory(directory, { ...body, query: "new" });
  expect(appended.record.sequence).toBe(4);
  expect(appended.record.previousRef).toBe(tail.record.ref);
});

it("projects scoped history without creating missing storage or retaining unrelated books", async () => {
  const directory = await storeDirectory();
  expect(
    await reduceFinanceBrokerHistoryRecords(directory, "selected", "alpaca:paper", 0, (n) => n + 1),
  ).toEqual({ value: 0, headRef: null, recordCount: 0 });
  await expect(fs.stat(financePositionLedgerPath(directory))).rejects.toThrow();
  const body = {
    kind: "broker_history" as const,
    accountId: "selected",
    venue: "alpaca:paper",
    query: "activities:test",
    cursor: "",
    payload: [{ id: "one" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  await appendFinanceBrokerHistory(directory, { ...body, accountId: "foreign" });
  await appendFinanceBrokerHistory(directory, { ...body, venue: "other:paper" });
  expect(
    await reduceFinanceBrokerHistoryRecords(directory, "selected", "alpaca:paper", 0, (n) => n + 1),
  ).toEqual({ value: 1, headRef: first.record.ref, recordCount: 1 });
  await expect(
    reduceFinanceBrokerHistoryRecords(directory, " ", "alpaca:paper", 0, (n) => n),
  ).rejects.toThrow("requires account and venue");
});

it("retains an exact reconciliation book older than the default three-book view", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "selected",
    venue: "alpaca:paper",
    query: "reconciliation:first",
    cursor: "",
    payload: [{ observedAt: "2026-10-09T00:00:00Z", status: "reconciled" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  await appendFinanceBrokerHistory(directory, { ...body, venue: "other:paper" });
  for (const accountId of ["b", "c", "d"]) {
    await appendFinanceBrokerHistory(directory, { ...body, accountId });
  }
  const defaults = await readFinanceLatestBrokerReconciliations(directory);
  expect(defaults.records.map((record) => record.accountId)).toEqual(["d", "c", "b"]);
  expect(defaults.omittedAccounts).toBe(2);
  const scope = { accountId: "selected", venue: "alpaca:paper" };
  const selected = await readFinanceLatestBrokerReconciliations(directory, { scope });
  expect(selected.records).toHaveLength(1);
  expect(selected.records[0]).toMatchObject({ ref: first.record.ref, superseded: false });
  expect(selected.omittedAccounts).toBe(0);
  await appendFinanceBrokerHistory(directory, { ...body, query: "activities:later" });
  expect(
    (await readFinanceLatestBrokerReconciliations(directory, { scope })).records[0]?.superseded,
  ).toBe(true);
  expect(
    (
      await readFinanceLatestBrokerReconciliations(directory, {
        scope,
        asOf: "2026-10-09T00:00:00Z",
      })
    ).records[0]?.superseded,
  ).toBe(false);
  expect(
    (
      await readFinanceLatestBrokerReconciliations(directory, {
        scope: { ...scope, accountId: "absent" },
      })
    ).records,
  ).toEqual([]);
  await expect(
    readFinanceLatestBrokerReconciliations(directory, { scope: { ...scope, accountId: " " } }),
  ).rejects.toThrow("scope requires account and venue");
});

describe("sealed broker activities projection", () => {
  async function fixture() {
    const directory = await storeDirectory();
    const append = (
      query: string,
      payload: Record<string, unknown>[],
      accountId = "account-a",
      venue = "alpaca:paper",
    ) =>
      appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId,
        venue,
        query,
        cursor: "",
        payload,
      });
    return { directory, append };
  }

  it("retains unique sealed activities, excludes other scopes and keeps the current head", async () => {
    const { directory, append } = await fixture();
    const row = { id: "fill-1", activity_type: "FILL", price: "100" };
    await append("activities:first", [row, row]);
    await append("activities:other", [{ ...row, price: "900" }], "account-b");
    await append("activities:venue", [{ ...row, price: "900" }], "account-a", "other");
    await append("orders:ignored", [{ ...row, price: "900" }]);
    const sealed = await append("reconciliation:sealed", [{ observedAt: "2026-10-09T00:00:00Z" }]);
    const tail = await append("activities:later", [{ ...row, price: "900" }]);
    expect(
      await readFinanceBrokerHistoryActivities(
        directory,
        "account-a",
        "alpaca:paper",
        sealed.record.sequence,
      ),
    ).toEqual({ activities: [row], headRef: tail.record.ref });
  });

  it("rejects conflicting or missing native identities within the sealed scope", async () => {
    const { directory, append } = await fixture();
    await append("activities:first", [{ id: "same", price: "100" }]);
    const conflict = await append("activities:conflict", [{ id: "same", price: "101" }]);
    await expect(
      readFinanceBrokerHistoryActivities(
        directory,
        "account-a",
        "alpaca:paper",
        conflict.record.sequence,
      ),
    ).rejects.toThrow("conflicting activity identity");
    const missing = await fixture();
    const row = await missing.append("activities:no-id", [{ price: "100" }]);
    await expect(
      readFinanceBrokerHistoryActivities(
        missing.directory,
        "account-a",
        "alpaca:paper",
        row.record.sequence,
      ),
    ).rejects.toThrow("missing activity identity");
  });

  it("still rejects a corrupt other-account tail beyond the sealed cutoff", async () => {
    const { directory, append } = await fixture();
    const sealed = await append("activities:first", [{ id: "fill-1" }]);
    await append("orders:other-tail", [{ id: "order-1" }], "account-b");
    const db = openDatabase(directory);
    try {
      db.exec("DROP TRIGGER finance_broker_history_no_update");
      db.prepare("UPDATE finance_broker_history SET ref=? WHERE sequence=2").run("0".repeat(64));
    } finally {
      db.close();
    }
    await expect(
      readFinanceBrokerHistoryActivities(
        directory,
        "account-a",
        "alpaca:paper",
        sealed.record.sequence,
      ),
    ).rejects.toThrow("broker history chain mismatch");
  });

  it("rejects invalid cutoff and scope without creating a missing database", async () => {
    const directory = await storeDirectory();
    for (const sequence of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        readFinanceBrokerHistoryActivities(directory, "account-a", "alpaca:paper", sequence),
      ).rejects.toThrow("sealed sequence");
    }
    await expect(
      readFinanceBrokerHistoryActivities(directory, "", "alpaca:paper", 1),
    ).rejects.toThrow("account");
    expect(
      await readFinanceBrokerHistoryActivities(directory, "account-a", "alpaca:paper", 1),
    ).toEqual({ activities: [], headRef: null });
    await expect(fs.stat(financePositionLedgerPath(directory))).rejects.toThrow();
  });
});

it("selects broker streams before repeated payload decoding while retaining the global head", async () => {
  const directory = await storeDirectory();
  for (const [accountId, stream] of [
    ["stream-select", "orders"],
    ["stream-select", "account"],
    ["foreign-select", "orders"],
  ]) {
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: `${stream}:select`,
      cursor: "",
      payload: [{ id: "fact", value: stream }],
    });
  }
  const reduce = (
    value: string[],
    record: Awaited<ReturnType<typeof readFinanceBrokerHistoryRecords>>["records"][number],
  ) => (record.body.query.startsWith("orders:") ? [...value, record.ref] : value);
  const legacy = await reduceFinanceBrokerHistoryRecords(
    directory,
    "stream-select",
    "alpaca:paper",
    [] as string[],
    reduce,
  );
  const parse = vi.spyOn(JSON, "parse");
  try {
    const selected = await reduceFinanceBrokerHistoryRecords(
      directory,
      "stream-select",
      "alpaca:paper",
      [] as string[],
      reduce,
      { streams: ["orders"] },
    );
    expect(selected).toEqual(legacy);
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});

it("rejects mutation in an omitted broker stream after its proof was warmed", async () => {
  const directory = await storeDirectory();
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId: "omitted-tamper",
    venue: "alpaca:paper",
    query: "account:select",
    cursor: "",
    payload: [{ id: "account", cash: "100" }],
  });
  await reduceFinanceBrokerHistoryRecords(
    directory,
    "omitted-tamper",
    "alpaca:paper",
    0,
    (n) => n + 1,
    { streams: ["orders"] },
  );
  const db = openDatabase(directory);
  try {
    db.exec("DROP TRIGGER finance_broker_history_no_update");
    const row = db.prepare("SELECT body FROM finance_broker_history WHERE sequence=1").get() as {
      body: string;
    };
    const raw = JSON.parse(row.body);
    raw.body.payload[0].cash = "999";
    db.prepare("UPDATE finance_broker_history SET body=? WHERE sequence=1").run(
      JSON.stringify(raw),
    );
  } finally {
    db.close();
  }
  await expect(
    reduceFinanceBrokerHistoryRecords(
      directory,
      "omitted-tamper",
      "alpaca:paper",
      0,
      (n) => n + 1,
      { streams: ["orders"] },
    ),
  ).rejects.toThrow("chain mismatch");
});

it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
  "preserves Unicode broker bytes through cold and warmed lazy reads: %s",
  async (encoding) => {
    const directory = await storeDirectory();
    const initial = openDatabase(directory);
    try {
      initial.exec(`PRAGMA encoding="${encoding}"; CREATE TABLE encoding_fixture(id INTEGER)`);
    } finally {
      initial.close();
    }
    const body = {
      kind: "broker_history" as const,
      accountId: "unicode-byte-account",
      venue: "alpaca:paper",
      query: "activities:unicode",
      cursor: "",
      payload: [{ id: "字节", note: "报价😀\uFEFF\u0000", price: 1.25 }],
    };
    const first = await appendFinanceBrokerHistory(directory, body);
    expect(
      (await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue)).records,
    ).toEqual([first.record]);
    expect(
      (await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue)).records,
    ).toEqual([first.record]);
    expect(await appendFinanceBrokerHistory(directory, body)).toEqual({
      appended: false,
      record: first.record,
    });
  },
);

it("rejects a blob impersonating previously verified broker text", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "blob-byte-account",
    venue: "alpaca:paper",
    query: "activities:blob",
    cursor: "",
    payload: [{ id: "blob" }],
  };
  await appendFinanceBrokerHistory(directory, body);
  await readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue);
  const db = openDatabase(directory);
  try {
    db.exec("DROP TRIGGER finance_broker_history_no_update");
    db.exec("UPDATE finance_broker_history SET body=CAST(body AS BLOB)");
  } finally {
    db.close();
  }
  await expect(
    readFinanceBrokerHistoryRecords(directory, body.accountId, body.venue),
  ).rejects.toThrow("invalid broker history row");
  await expect(appendFinanceBrokerHistory(directory, body)).rejects.toThrow(
    "invalid broker history row",
  );
});

it("retains header proofs for a bounded history above the old eight MiB capacity", async () => {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "header-capacity-account",
    venue: "alpaca:paper",
    query: `orders:${"q".repeat(600)}`,
    cursor: "",
    payload: [{ id: "bounded-fixture" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  const db = openDatabase(directory);
  let headRef = first.record.ref;
  try {
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare(
      "INSERT INTO finance_broker_history(sequence,ref,body) VALUES(?,?,?)",
    );
    for (let sequence = 2; sequence <= 16_000; sequence++) {
      const record = {
        sequence,
        previousRef: headRef,
        body: { ...body, cursor: String(sequence) },
      };
      headRef = caseflowFingerprint(record);
      insert.run(sequence, headRef, JSON.stringify(record));
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const read = () =>
    reduceFinanceBrokerHistoryRecords(
      directory,
      body.accountId,
      body.venue,
      0,
      (count) => count + 1,
      { streams: [] },
    );
  const cold = await read();
  const parse = vi.spyOn(JSON, "parse");
  try {
    expect(await read()).toEqual(cold);
    expect(cold).toEqual({ value: 0, recordCount: 16_000, headRef });
    expect(parse.mock.calls.length).toBe(0);
  } finally {
    parse.mockRestore();
  }
  const changed = openDatabase(directory);
  try {
    changed.exec("DROP TRIGGER finance_broker_history_no_update");
    const row = changed
      .prepare("SELECT body FROM finance_broker_history WHERE sequence=16000")
      .get();
    if (typeof row?.body !== "string") {
      throw new Error("missing capacity fixture tail");
    }
    const record = JSON.parse(row.body);
    record.body.payload[0].id = "changed-after-warm";
    changed
      .prepare("UPDATE finance_broker_history SET body=? WHERE sequence=16000")
      .run(JSON.stringify(record));
  } finally {
    changed.close();
  }
  await expect(read()).rejects.toThrow("broker history chain mismatch");
}, 30_000);

async function cooperativeHistoryFixture() {
  const directory = await storeDirectory();
  const body = {
    kind: "broker_history" as const,
    accountId: "cooperative-scan",
    venue: "alpaca:paper",
    query: "activities:cooperative",
    cursor: "",
    payload: [{ id: "fill" }],
  };
  const first = await appendFinanceBrokerHistory(directory, body);
  let previousRef = first.record.ref;
  const db = openDatabase(directory);
  try {
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare(
      "INSERT INTO finance_broker_history(sequence,ref,body) VALUES (?,?,?)",
    );
    for (let sequence = 2; sequence <= 600; sequence++) {
      const row = { sequence, previousRef, body };
      previousRef = caseflowFingerprint(row);
      insert.run(sequence, previousRef, JSON.stringify(row));
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return { directory, body };
}

it("cooperative broker scan yields to cancellation before reducing the full chain", async () => {
  const { directory, body } = await cooperativeHistoryFixture();
  const controller = new AbortController();
  const reason = new DOMException("host deadline", "AbortError");
  let reduced = 0;
  await expect(
    reduceFinanceBrokerHistoryRecords(
      directory,
      body.accountId,
      body.venue,
      0,
      (sum) => {
        reduced++;
        if (reduced === 1) {
          setImmediate(() => controller.abort(reason));
        }
        return sum + 1;
      },
      { signal: controller.signal },
    ),
  ).rejects.toBe(reason);
  expect(reduced).toBeGreaterThan(0);
  expect(reduced).toBeLessThan(600);
  expect(
    (
      await reduceFinanceBrokerHistoryRecords(
        directory,
        body.accountId,
        body.venue,
        0,
        (sum) => sum + 1,
      )
    ).value,
  ).toBe(600);
});

it("cooperative broker append cancels its scan and releases the write transaction", async () => {
  const { directory, body } = await cooperativeHistoryFixture();
  const controller = new AbortController();
  const reason = new DOMException("host deadline", "AbortError");
  setImmediate(() => controller.abort(reason));
  await expect(
    appendFinanceBrokerHistory(
      directory,
      { ...body, cursor: "new-page" },
      { signal: controller.signal },
    ),
  ).rejects.toBe(reason);
  const completed = await appendFinanceBrokerHistory(directory, {
    ...body,
    cursor: "after-cancel",
  });
  expect(completed.record.sequence).toBe(601);
  expect(completed.appended).toBe(true);
});

it("cooperative broker appends retain distinct concurrent pages without lock conflicts", async () => {
  const { directory, body } = await cooperativeHistoryFixture();
  const results = await Promise.all([
    appendFinanceBrokerHistory(directory, { ...body, cursor: "page-a" }),
    appendFinanceBrokerHistory(directory, { ...body, cursor: "page-b" }),
  ]);
  expect(
    results.map((result) => result.record.sequence).toSorted((left, right) => left - right),
  ).toEqual([601, 602]);
  expect(
    (
      await reduceFinanceBrokerHistoryRecords(
        directory,
        body.accountId,
        body.venue,
        0,
        (sum) => sum + 1,
      )
    ).recordCount,
  ).toBe(602);
});
