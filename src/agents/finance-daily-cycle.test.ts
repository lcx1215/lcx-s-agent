import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  annualisedVol,
  attemptCycleOrder,
  currentWeightsFromPositions,
  lastCompletedMonthEnd,
  receiptsForVenue,
  recordCycleFill,
  solveInvalidationPrice,
  venueReconciliationIssue,
} from "./finance-daily-cycle.js";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "./finance-execution-adapter.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import type { FinancePosition } from "./finance-position-ledger.js";
import { readFinancePositionLedger } from "./finance-position-ledger.js";

const bar = (date: string, close: number) => ({ date, close });

describe("lastCompletedMonthEnd", () => {
  it("skips the current month even when it already has bars", () => {
    const months = [
      bar("2026-06-30", 1),
      bar("2026-07-31", 2),
      bar("2026-08-31", 3),
      bar("2026-09-18", 4),
    ];
    // September has data but is not finished; the signal must not use it.
    expect(lastCompletedMonthEnd(months, "2026-09-20T00:00:00.000Z")?.date).toBe("2026-08-31");
  });

  it("returns the last month end once the month has rolled over", () => {
    const months = [bar("2026-08-31", 3), bar("2026-09-30", 4)];
    expect(lastCompletedMonthEnd(months, "2026-10-02T00:00:00.000Z")?.date).toBe("2026-09-30");
  });

  it("is undefined when nothing precedes the current month", () => {
    const months = [bar("2026-09-18", 4)];
    expect(lastCompletedMonthEnd(months, "2026-09-20T00:00:00.000Z")).toBeUndefined();
  });

  it("stays constant across the whole month", () => {
    // The property the whole design rests on: the anchor cannot move intra-month,
    // otherwise the monthly rule degrades into a daily one.
    const months = [bar("2026-07-31", 2), bar("2026-08-31", 3), bar("2026-09-18", 4)];
    const seen = new Set(
      ["2026-09-01", "2026-09-10", "2026-09-18", "2026-09-30"].map(
        (day) => lastCompletedMonthEnd(months, `${day}T12:00:00.000Z`)?.date,
      ),
    );
    expect([...seen]).toEqual(["2026-08-31"]);
  });
});

describe("solveInvalidationPrice", () => {
  it("solves a stop that makes risk sizing land on the intended notional", () => {
    // 100k equity, 1% risk fraction -> size = 1000 / stop.
    // Wanting 10k means a 10% stop, so the level is 10% below 200.
    expect(solveInvalidationPrice(200, 10_000, 100_000)).toBeCloseTo(180, 2);
  });

  it("gives different stops to different notionals instead of one flat stop", () => {
    // This is the regression the fix addresses: a fixed 15% stop made every
    // instrument size the same, flattening the inverse-volatility allocation.
    const small = solveInvalidationPrice(200, 4_000, 100_000);
    const large = solveInvalidationPrice(200, 10_000, 100_000);
    // Bigger order -> tighter stop -> the level sits CLOSER to the current price.
    expect(large).toBeGreaterThan(small);
    expect(small).not.toBe(large);
  });

  it("clamps a stop that would be too tight to survive ordinary noise", () => {
    // Wanting the whole book in one order solves to a 1% stop; that is not tradeable.
    expect(solveInvalidationPrice(100, 100_000, 100_000)).toBeCloseTo(95, 2);
  });

  it("clamps a stop that would be absurdly wide", () => {
    expect(solveInvalidationPrice(100, 100, 100_000)).toBeCloseTo(70, 2);
  });

  it("falls back to the widest stop when notional is zero", () => {
    expect(solveInvalidationPrice(100, 0, 100_000)).toBeCloseTo(70, 2);
  });
});

describe("attemptCycleOrder", () => {
  it("passes a refusal through untouched", async () => {
    const outcome = {
      ok: false as const,
      stage: "place" as const,
      refusals: ["risk_budget_order_count_exceeded"],
    };
    const result = await attemptCycleOrder(async () => outcome);
    expect(result).toBe(outcome);
  });

  it("turns a thrown adapter error into a refusal instead of aborting the cycle", async () => {
    const result = await attemptCycleOrder(async () => {
      throw new Error("Alpaca order rejected (http 422): insufficient buying power");
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    // The reason has to survive: a refusal that says only "something failed" is not actionable.
    expect(result.refusals.join(" ")).toContain("order path threw");
    expect(result.refusals.join(" ")).toContain("insufficient buying power");
  });

  it("contains an order whose fill state never resolved", async () => {
    const result = await attemptCycleOrder(async () => {
      throw new Error("Alpaca order ord-77 was submitted but its fill state is unknown");
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    // The order id must reach the operator: the order exists even though the receipt does not.
    expect(result.refusals.join(" ")).toContain("ord-77");
  });
});

const PAST = "2026-09-10T00:00:00Z";

function cycleReceipt(overrides: Partial<FinanceExecutionReceipt> = {}): FinanceExecutionReceipt {
  const quantity = overrides.quantity ?? 10;
  const fillPrice = overrides.fill?.fillPrice ?? 100;
  return {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: "cycle-receipt-1",
    intentId: "cycle-intent-1",
    runAuthorizationId: "cycle-run",
    adapterId: "alpaca-venue",
    adapterKind: "venue",
    venue: "alpaca:paper",
    instrument: "SPY",
    side: "buy",
    orderType: "market",
    quantity,
    referencePrice: fillPrice,
    referencePriceAt: PAST,
    notional: fillPrice * quantity,
    fill: { filledQuantity: quantity, fillPrice, filledAt: PAST, venueRef: "alpaca:paper:ord-1" },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: PAST,
    ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-cycle-"));
  tempDirs.push(directory);
  return directory;
}

describe("venueReconciliationIssue", () => {
  it("says nothing when the venue and the ledger agree", () => {
    expect(
      venueReconciliationIssue({
        instrument: "SPY",
        openOrders: 0,
        venueQuantity: 10,
        ledgerQuantity: 10,
      }),
    ).toBeNull();
  });

  it("refuses when the venue already has an open order for the instrument", () => {
    // The duplicate by construction: the previous order is still working there.
    const issue = venueReconciliationIssue({
      instrument: "SPY",
      openOrders: 1,
      venueQuantity: 0,
      ledgerQuantity: 0,
    });
    expect(issue).toContain("open order");
  });

  it("refuses when the venue holds more than the ledger knows about", () => {
    // A fill the ledger missed. Buying again would over-size a position that is already there.
    const issue = venueReconciliationIssue({
      instrument: "SPY",
      openOrders: 0,
      venueQuantity: 10,
      ledgerQuantity: 0,
    });
    expect(issue).toContain("out of sync");
    expect(issue).toContain("10");
    expect(issue).toContain("0");
  });

  it("does not treat an unknown venue quantity as agreement", () => {
    // Absent is not zero: nothing was read for this instrument, so there is nothing to compare.
    expect(
      venueReconciliationIssue({ instrument: "SPY", openOrders: 0, ledgerQuantity: 10 }),
    ).toBeNull();
  });
});

describe("receiptsForVenue", () => {
  // Measured, not assumed: a `--venue paper --place` rehearsal writes fills the venue will
  // never hold, and reading them into an alpaca run made every instrument fail reconciliation
  // with "out of sync" — permanently, because nothing in the system can remove them.
  const simulated = cycleReceipt({ adapterKind: "paper", venue: "paper" });
  const atVenue = cycleReceipt({ adapterKind: "venue", venue: "alpaca:paper" });

  it("reads only simulated fills for a paper run", () => {
    const picked = receiptsForVenue([simulated, atVenue], "paper");
    expect(picked.map((item) => item.venue)).toEqual(["paper"]);
  });

  it("reads only venue fills for an alpaca run, so a rehearsal cannot brick it", () => {
    const picked = receiptsForVenue([simulated, atVenue], "alpaca");
    expect(picked.map((item) => item.venue)).toEqual(["alpaca:paper"]);
  });

  it("excludes a fill from a different venue even when it is a real one", () => {
    // Another broker's fill is not this account's book. Both are `adapterKind: "venue"`, so
    // the venue name is what separates them.
    const elsewhere = cycleReceipt({ adapterKind: "venue", venue: "ibkr:live" });
    expect(receiptsForVenue([elsewhere, atVenue], "alpaca").map((item) => item.venue)).toEqual([
      "alpaca:paper",
    ]);
  });
});

function position(overrides: Partial<FinancePosition> = {}): FinancePosition {
  return { instrument: "SPY", quantity: 10, averageCost: 100, realizedPnl: 0, ...overrides };
}

describe("currentWeightsFromPositions", () => {
  it("weights a priced position by its mark", () => {
    const { weights, unpriced } = currentWeightsFromPositions(
      [position({ markPrice: 500 })],
      100_000,
    );
    // 10 shares at 500 out of 100k.
    expect(weights.get("SPY")).toBeCloseTo(0.05, 6);
    expect(unpriced).toEqual([]);
  });

  it("reports a held position with no mark instead of calling it flat", () => {
    // The duplicate-order shape: the position is real, the price is missing, and a silent
    // zero weight here is what makes the cycle buy the same thing again tomorrow.
    const { weights, unpriced } = currentWeightsFromPositions([position({})], 100_000);
    expect(weights.has("SPY")).toBe(false);
    expect(unpriced).toEqual(["SPY"]);
  });

  it("drops a flat position into neither bucket", () => {
    const { weights, unpriced } = currentWeightsFromPositions([position({ quantity: 0 })], 100_000);
    expect(weights.has("SPY")).toBe(false);
    // A flat position must not be reported as unpriced: that would refuse trades forever.
    expect(unpriced).toEqual([]);
  });

  it("weights nothing when equity is unusable", () => {
    const { weights } = currentWeightsFromPositions([position({ markPrice: 500 })], 0);
    expect(weights.size).toBe(0);
  });
});

describe("recordCycleFill", () => {
  it("writes the fill to the ledger, so the next cycle does not buy the same thing again", async () => {
    const directory = await storeDirectory();
    const record = await recordCycleFill({ directory, receipt: cycleReceipt() });
    expect(record.recorded).toBe(true);
    expect(record.marked).toBe(true);
    expect(record.quantity).toBe(10);
    expect(record.notional).toBeCloseTo(1_000, 2);
    expect(record.committedNotional).toBeCloseTo(1_000, 2);

    // The property that matters: tomorrow's cycle reads current weights from this ledger,
    // and it needs a PRICE to do that. A receipt without a mark is a position the next run
    // cannot weight — which reads exactly like an empty book.
    const ledger = await readFinancePositionLedger(directory);
    expect(ledger.ledger.positions[0]).toMatchObject({
      instrument: "SPY",
      quantity: 10,
      markPrice: 100,
    });
  });

  it("weights the position it just recorded, so the next cycle sees it", async () => {
    const directory = await storeDirectory();
    await recordCycleFill({ directory, receipt: cycleReceipt() });
    const ledger = await readFinancePositionLedger(directory);
    const derived = currentWeightsFromPositions(ledger.ledger.positions, 100_000);
    // 10 shares at 100 out of 100k — without the mark this would be `unpriced` instead.
    expect(derived.unpriced).toEqual([]);
    expect(derived.weights.get("SPY")).toBeCloseTo(0.01, 6);
  });

  it("accumulates committed notional across the run", async () => {
    const directory = await storeDirectory();
    const first = await recordCycleFill({ directory, receipt: cycleReceipt() });
    const second = await recordCycleFill({
      directory,
      receipt: cycleReceipt({ receiptId: "cycle-receipt-2", intentId: "cycle-intent-2" }),
      committedNotional: first.committedNotional,
    });
    expect(second.committedNotional).toBeCloseTo(2_000, 2);
  });

  it("records nothing when the venue reported no fill, instead of inventing a position", async () => {
    const directory = await storeDirectory();
    const record = await recordCycleFill({
      directory,
      receipt: cycleReceipt({
        fill: { filledQuantity: 0, fillPrice: 0, filledAt: PAST, venueRef: "alpaca:paper:ord-2" },
      }),
    });
    expect(record.recorded).toBe(false);
    expect(record.quantity).toBe(0);
    expect(record.committedNotional).toBe(0);
    expect(record.refusal).toContain("no fill");
    // The venue reference survives so the order can be reconciled by hand.
    expect(record.refusal).toContain("ord-2");
    const ledger = await readFinancePositionLedger(directory);
    expect(ledger.ledger.positions).toHaveLength(0);
  });

  it("still counts committed money when the ledger write fails", async () => {
    const directory = await storeDirectory();
    await fs.writeFile(path.join(directory, "blocked"), "not a directory");
    const record = await recordCycleFill({
      directory: path.join(directory, "blocked"),
      receipt: cycleReceipt(),
      committedNotional: 500,
    });
    expect(record.recorded).toBe(false);
    // The order exists at the venue whether or not the write landed: under-counting here
    // would let the run exceed the instrument cap on money it has already spent.
    expect(record.committedNotional).toBeCloseTo(1_500, 2);
    expect(record.refusal).toContain("ledger write failed");
  });
});

describe("annualisedVol", () => {
  it("is undefined rather than zero when there is too little history", () => {
    expect(Number.isFinite(annualisedVol([1, 2, 3]))).toBe(false);
  });

  it("scales with the dispersion of returns", () => {
    const calm = Array.from({ length: 120 }, (_, index) => 100 + (index % 2) * 0.1);
    const wild = Array.from({ length: 120 }, (_, index) => 100 + (index % 2) * 10);
    expect(annualisedVol(wild)).toBeGreaterThan(annualisedVol(calm));
  });
});
