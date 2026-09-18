import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFinanceEquityCurve,
  FINANCE_EQUITY_CURVE_SCHEMA,
  readFinanceEquityCurve,
} from "./finance-equity-curve.js";
import {
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  type FinanceExecutionReceipt,
} from "./finance-execution-adapter.js";
import {
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  type FinancePositionMark,
} from "./finance-position-ledger.js";
import { calculateMaxDrawdown } from "./tools/quant-math-tool.js";

let sequence = 0;

function fill(
  side: "buy" | "sell",
  quantity: number,
  fillPrice: number,
  at: string,
  instrument = "AAPL",
): FinanceExecutionReceipt {
  sequence += 1;
  return {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `r${sequence}`,
    intentId: `i${sequence}`,
    runAuthorizationId: "run-1",
    adapterId: "paper",
    adapterKind: "paper",
    venue: "paper",
    instrument,
    side,
    orderType: "market",
    quantity,
    referencePrice: fillPrice,
    referencePriceAt: at,
    notional: fillPrice * quantity,
    fill: { filledQuantity: quantity, fillPrice, filledAt: at, venueRef: "paper" },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: at,
  };
}

function mark(instrument: string, price: number, at: string): FinancePositionMark {
  return { instrument, price, at };
}

const CAPITAL = 1000;

describe("finance equity curve", () => {
  it("samples at mark instants and reports equity against the initial capital", () => {
    const curve = buildFinanceEquityCurve({
      receipts: [fill("buy", 10, 100, "2026-09-18T00:00:00Z")],
      marks: [mark("AAPL", 110, "2026-09-18T01:00:00Z"), mark("AAPL", 120, "2026-09-18T02:00:00Z")],
      initialCapital: CAPITAL,
    });

    expect(curve.schemaVersion).toBe(FINANCE_EQUITY_CURVE_SCHEMA);
    expect(curve.boundary).toBe("equity_curve_from_ledger_stream_only");
    expect(curve.sampleCount).toBe(2);
    // 1000 + 0 realized + (110-100)*10 then (120-100)*10.
    expect(curve.levels).toEqual([1100, 1200]);
    expect(curve.levelTimestamps).toEqual(["2026-09-18T01:00:00Z", "2026-09-18T02:00:00Z"]);
    expect(curve.finalEquity).toBe(1200);
    expect(curve.undefinedEquityAt).toEqual([]);
    expect(curve.samples[0]?.openInstruments).toEqual(["AAPL"]);
  });

  it("uses only marks at or before each instant, so a later price cannot leak backwards", () => {
    const curve = buildFinanceEquityCurve({
      receipts: [fill("buy", 10, 100, "2026-09-18T00:00:00Z")],
      // Deliberately supplied newest-first: ordering must come from `at`, not from input order.
      marks: [mark("AAPL", 120, "2026-09-18T02:00:00Z"), mark("AAPL", 110, "2026-09-18T01:00:00Z")],
      initialCapital: CAPITAL,
    });

    expect(curve.levels).toEqual([1100, 1200]);
    expect(curve.samples.map((sample) => sample.unrealizedPnl)).toEqual([100, 200]);
  });

  it("names an instant with no mark instead of interpolating it into the curve", () => {
    const curve = buildFinanceEquityCurve({
      receipts: [
        fill("buy", 10, 100, "2026-09-18T00:00:00Z", "AAPL"),
        fill("buy", 5, 200, "2026-09-18T00:00:01Z", "MSFT"),
      ],
      marks: [
        mark("AAPL", 110, "2026-09-18T01:00:00Z"),
        mark("AAPL", 120, "2026-09-18T02:00:00Z"),
        mark("MSFT", 210, "2026-09-18T02:00:00Z"),
      ],
      initialCapital: CAPITAL,
    });

    // At 01:00 MSFT is open with no mark, so the total is undefined rather than MSFT-free.
    expect(curve.sampleCount).toBe(2);
    expect(curve.undefinedEquityAt).toEqual(["2026-09-18T01:00:00Z"]);
    expect(curve.samples[0]?.unrealizedPnl).toBeNull();
    expect(curve.samples[0]?.equity).toBeNull();
    expect(curve.samples[0]?.instrumentsWithoutMark).toEqual(["MSFT"]);
    // The hole is excluded, never filled with a neighbouring value.
    expect(curve.levels).toHaveLength(1);
    expect(curve.levelTimestamps).toEqual(["2026-09-18T02:00:00Z"]);
    expect(curve.levels[0]).toBe(1000 + 200 + 50);
    expect(curve.finalEquity).toBe(1250);
  });

  it("counts fills recorded after the last mark instead of dropping them silently", () => {
    const curve = buildFinanceEquityCurve({
      receipts: [
        fill("buy", 10, 100, "2026-09-18T00:00:00Z"),
        fill("buy", 10, 120, "2026-09-18T03:00:00Z"),
      ],
      marks: [mark("AAPL", 110, "2026-09-18T01:00:00Z")],
      initialCapital: CAPITAL,
    });

    expect(curve.receiptsAfterLastMark).toBe(1);
    // The sample reflects only the fill that preceded it.
    expect(curve.levels).toEqual([1100]);
  });

  it("reports the mean sample spacing so an annualised metric cannot inherit a default period", () => {
    const curve = buildFinanceEquityCurve({
      receipts: [fill("buy", 10, 100, "2026-09-18T00:00:00Z")],
      marks: [
        mark("AAPL", 110, "2026-09-18T01:00:00Z"),
        mark("AAPL", 111, "2026-09-19T01:00:00Z"),
        mark("AAPL", 112, "2026-09-20T01:00:00Z"),
      ],
      initialCapital: CAPITAL,
    });

    expect(curve.meanSampleSpacingSeconds).toBe(86_400);
  });

  it("leaves the spacing undefined when fewer than two samples have a defined equity", () => {
    const one = buildFinanceEquityCurve({
      receipts: [fill("buy", 10, 100, "2026-09-18T00:00:00Z")],
      marks: [mark("AAPL", 110, "2026-09-18T01:00:00Z")],
      initialCapital: CAPITAL,
    });
    const none = buildFinanceEquityCurve({
      receipts: [fill("buy", 10, 100, "2026-09-18T00:00:00Z")],
      initialCapital: CAPITAL,
    });

    expect(one.meanSampleSpacingSeconds).toBeNull();
    expect(none.meanSampleSpacingSeconds).toBeNull();
  });

  it("defines equity for a flat book without needing a mark", () => {
    const curve = buildFinanceEquityCurve({
      receipts: [
        fill("buy", 10, 100, "2026-09-18T00:00:00Z"),
        fill("sell", 10, 110, "2026-09-18T01:00:00Z"),
      ],
      marks: [mark("AAPL", 999, "2026-09-18T02:00:00Z")],
      initialCapital: CAPITAL,
    });

    // Flat, so the realized 100 is the whole story; the 999 mark is irrelevant to a closed book.
    expect(curve.levels).toEqual([1100]);
    expect(curve.samples[0]?.unrealizedPnl).toBe(0);
    expect(curve.samples[0]?.openInstruments).toEqual([]);
  });

  it("produces no samples when the ledger holds fills but no marks", () => {
    const curve = buildFinanceEquityCurve({
      receipts: [
        fill("buy", 10, 100, "2026-09-18T00:00:00Z"),
        fill("buy", 5, 100, "2026-09-18T01:00:00Z"),
      ],
      initialCapital: CAPITAL,
    });

    expect(curve.sampleCount).toBe(0);
    expect(curve.levels).toEqual([]);
    expect(curve.finalEquity).toBeNull();
    expect(curve.receiptsAfterLastMark).toBe(2);
  });

  it("refuses a non-positive or non-finite initial capital", () => {
    const receipts = [fill("buy", 10, 100, "2026-09-18T00:00:00Z")];

    expect(() => buildFinanceEquityCurve({ receipts, initialCapital: 0 })).toThrow(
      /initialCapital/u,
    );
    expect(() => buildFinanceEquityCurve({ receipts, initialCapital: -1 })).toThrow(
      /initialCapital/u,
    );
    expect(() => buildFinanceEquityCurve({ receipts, initialCapital: Number.NaN })).toThrow(
      /initialCapital/u,
    );
  });

  it("is a pure, frozen projection: the same stream always yields the same curve", () => {
    const params = {
      receipts: [fill("buy", 10, 100, "2026-09-18T00:00:00Z")],
      marks: [mark("AAPL", 110, "2026-09-18T01:00:00Z")],
      initialCapital: CAPITAL,
    };
    const first = buildFinanceEquityCurve(params);
    const second = buildFinanceEquityCurve(params);

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.levels)).toBe(true);
    expect(Object.isFrozen(first.samples)).toBe(true);
  });

  it("ignores unusable marks rather than marking to a zero or blank price", () => {
    const curve = buildFinanceEquityCurve({
      receipts: [fill("buy", 10, 100, "2026-09-18T00:00:00Z")],
      marks: [
        mark("AAPL", 0, "2026-09-18T01:00:00Z"),
        mark("AAPL", Number.NaN, "2026-09-18T02:00:00Z"),
        mark("  ", 150, "2026-09-18T03:00:00Z"),
      ],
      initialCapital: CAPITAL,
    });

    expect(curve.sampleCount).toBe(0);
    expect(curve.levels).toEqual([]);
  });

  it("feeds the existing metrics library directly, with no re-derivation in between", () => {
    const curve = buildFinanceEquityCurve({
      receipts: [fill("buy", 10, 100, "2026-09-18T00:00:00Z")],
      marks: [
        mark("AAPL", 120, "2026-09-18T01:00:00Z"),
        mark("AAPL", 90, "2026-09-18T02:00:00Z"),
        mark("AAPL", 110, "2026-09-18T03:00:00Z"),
      ],
      initialCapital: CAPITAL,
    });

    expect(curve.levels).toEqual([1200, 900, 1100]);
    const drawdown = calculateMaxDrawdown([...curve.levels], "levels");
    expect(drawdown.inputMode).toBe("levels");
    expect(drawdown.observations).toBe(3);
    // Peak 1200 -> trough 900.
    expect(drawdown.maxDrawdown).toBeCloseTo(-0.25, 10);
  });
});

describe("finance equity curve from the durable ledger", () => {
  const directories: string[] = [];
  // The store refuses an observation dated in the future, so every instant written here is
  // deliberately historical: the guard must never be what a store test measures.
  const PAST = "2026-09-10T00:00:00Z";
  const PAST_MARK_1 = "2026-09-10T01:00:00Z";
  const PAST_MARK_2 = "2026-09-10T02:00:00Z";

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  async function storeDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-equity-curve-"));
    directories.push(directory);
    return directory;
  }

  it("round-trips a real append-only ledger into the same curve a direct projection gives", async () => {
    const directory = await storeDirectory();
    const receipt = fill("buy", 10, 100, PAST);
    await appendFinanceExecutionReceipt(directory, receipt);
    await appendFinancePositionMark(directory, mark("AAPL", 110, PAST_MARK_1));
    await appendFinancePositionMark(directory, mark("AAPL", 120, PAST_MARK_2));

    const curve = await readFinanceEquityCurve(directory, { initialCapital: CAPITAL });
    const direct = buildFinanceEquityCurve({
      receipts: [receipt],
      marks: [mark("AAPL", 110, PAST_MARK_1), mark("AAPL", 120, PAST_MARK_2)],
      initialCapital: CAPITAL,
    });

    expect(curve.levels).toEqual([1100, 1200]);
    expect(curve).toEqual(direct);
  });

  it("treats a never-written directory as an empty ledger rather than an error", async () => {
    const directory = await storeDirectory();
    const curve = await readFinanceEquityCurve(directory, { initialCapital: CAPITAL });

    expect(curve.sampleCount).toBe(0);
    expect(curve.levels).toEqual([]);
    expect(curve.finalEquity).toBeNull();
    expect(curve.receiptsAfterLastMark).toBe(0);
  });

  it("does not double count a replayed receipt, so the curve is replay-safe", async () => {
    const directory = await storeDirectory();
    const receipt = fill("buy", 10, 100, PAST);
    await appendFinanceExecutionReceipt(directory, receipt);
    const replay = await appendFinanceExecutionReceipt(directory, receipt);
    await appendFinancePositionMark(directory, mark("AAPL", 110, PAST_MARK_1));

    const curve = await readFinanceEquityCurve(directory, { initialCapital: CAPITAL });

    expect(replay.appended).toBe(false);
    // Quantity stays 10: a doubled fill would show 1300 here.
    expect(curve.levels).toEqual([1100]);
  });
});
