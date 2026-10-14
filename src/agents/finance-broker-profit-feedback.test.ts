import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  readFinanceBrokerInstrumentFeedback,
  readFinanceBrokerExitFeedback,
  readFinanceBrokerProfitFeedback,
  summarizeFinanceBrokerFills,
  summarizeFinanceBrokerFillsByInstrument,
  attributeFinanceBrokerFills,
} from "./finance-broker-profit-feedback.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { appendFinanceIntradayDecision } from "./finance-intraday-control-ledger.js";
import {
  appendFinanceBrokerHistory,
  appendFinanceExecutionReceipt,
  readFinanceLatestBrokerReconciliations,
  readFinancePositionLedger,
} from "./finance-position-ledger.js";

it("preserves profit and source metadata when using exact observation reads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "profit-shared-observation-"));
  const asOf = "2026-10-06T10:00:00Z";
  try {
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId: "synthetic",
      venue: "alpaca:paper",
      query: `reconciliation:${asOf}`,
      cursor: "",
      payload: [{ observedAt: asOf, positions: [], openOrders: [], status: "reconciled" }],
    });
    const baseline = await readFinanceBrokerProfitFeedback(directory, asOf);
    const positionRead = vi.fn(() => readFinancePositionLedger(directory, { asOf }));
    const reconciliationRead = vi.fn(() => readFinanceLatestBrokerReconciliations(directory));
    expect(
      await readFinanceBrokerProfitFeedback(directory, asOf, {
        positionObservation: { directory, asOf, read: positionRead },
        reconciliationObservation: { directory, asOf, read: reconciliationRead },
      }),
    ).toEqual(baseline);
    expect(positionRead).toHaveBeenCalledTimes(1);
    expect(reconciliationRead).toHaveBeenCalledTimes(1);
    for (const scope of [
      { directory: `${directory}-other`, asOf },
      { directory, asOf: "2026-10-06T09:59:00Z" },
    ]) {
      const wrongRead = vi.fn(async () => {
        throw new Error("wrong shared observation");
      });
      expect(
        await readFinanceBrokerProfitFeedback(directory, asOf, {
          positionObservation: { ...scope, read: wrongRead },
          reconciliationObservation: { ...scope, read: wrongRead },
        }),
      ).toEqual(baseline);
      expect(wrongRead).not.toHaveBeenCalled();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
const fill = (id: string, side: string, qty: string, price: string) => ({
  id,
  activity_type: "FILL",
  type: "fill",
  symbol: "SPY",
  side,
  qty,
  price,
  transaction_time: `2026-09-20T10:0${id}:00Z`,
});
describe("broker profit feedback", () => {
  it("deduplicates activities and matches partial fills without using order snapshots", () => {
    const buy = fill("1", "buy", "2", "100");
    expect(
      summarizeFinanceBrokerFills(
        [buy, buy, fill("2", "sell", "1", "110"), fill("3", "sell", "1", "95")],
        true,
      ),
    ).toMatchObject({
      buyFills: 1,
      sellFills: 2,
      matchedLotCount: 2,
      openLotCount: 0,
      grossMatchedPnl: 5,
      netMatchedPnl: 5,
    });
  });
  it("never calls open gains, unverified costs or unattributed fees net profit", () => {
    const rows = [fill("1", "buy", "2", "100"), fill("2", "sell", "1", "110")];
    expect(summarizeFinanceBrokerFills(rows, false).netMatchedPnl).toBeNull();
    expect(
      summarizeFinanceBrokerFills(
        [...rows, { id: "fee", activity_type: "CFEE", qty: "-0.01" }],
        true,
      ),
    ).toMatchObject({ netMatchedPnl: null, feeActivityCount: 1 });
    expect(summarizeFinanceBrokerFills([rows[0]], true)).toMatchObject({
      status: "no_closed_matches",
      netMatchedPnl: null,
    });
  });
  it("does not invent a cost basis for sells with missing buys", () => {
    expect(summarizeFinanceBrokerFills([fill("1", "sell", "1", "100")], true).issues).toContain(
      "unmatched_sell_or_short_position",
    );
    expect(() => summarizeFinanceBrokerFills([fill("1", "buy", "", "100")], true)).toThrow(
      "invalid activity number",
    );
  });
  it("counts REST partial-fill executions with the same canonical type contract", () => {
    const partial = { ...fill("1", "buy", "1", "100"), type: "partial_fill" };
    expect(summarizeFinanceBrokerFills([partial], true)).toMatchObject({
      buyFills: 1,
      status: "no_closed_matches",
      netMatchedPnl: null,
    });
    expect(() => summarizeFinanceBrokerFills([{ ...partial, type: "trade_bust" }], true)).toThrow(
      "unsupported fill correction or short side",
    );
  });
});

it("does not invent ordering between opposing fills at the same timestamp", () => {
  const buy = fill("1", "buy", "1", "100");
  const sell = { ...fill("2", "sell", "1", "110"), transaction_time: buy.transaction_time };
  expect(summarizeFinanceBrokerFills([buy, sell], true)).toMatchObject({
    netMatchedPnl: null,
    issues: ["ambiguous_same_time_fill_order"],
  });
  expect(
    summarizeFinanceBrokerFills(
      [buy, { ...sell, transaction_time: "2026-09-20T11:01:00+01:00" }],
      true,
    ),
  ).toMatchObject({
    netMatchedPnl: null,
    recordedCashFeePnlBounds: null,
    issues: ["ambiguous_same_time_fill_order"],
  });
});

it("allocates explicit cash fees proportionally across partial fills without double counting", () => {
  const rows = [
    { ...fill("1", "buy", "2", "100"), order_id: "buy" },
    { ...fill("2", "sell", "1", "110"), order_id: "sell" },
    {
      id: "buy-fee",
      activity_type: "FEE",
      order_id: "buy",
      status: "executed",
      currency: "USD",
      net_amount: "-2",
    },
    {
      id: "sell-fee",
      activity_type: "FEE",
      order_id: "sell",
      status: "executed",
      currency: "USD",
      net_amount: "-0.5",
    },
  ];
  expect(summarizeFinanceBrokerFills([...rows, rows[2]], true)).toMatchObject({
    grossMatchedPnl: 10,
    netMatchedPnl: 8.5,
    allocatedClosedCashFees: 1.5,
    feeActivityCount: 2,
    openLotCount: 1,
    unallocatedCashFeeAmount: 0,
    unpricedFeeActivityCount: 0,
    recordedCashFeePnlBounds: { lower: 8.5, upper: 8.5 },
  });
});

const cashFee = (id: string, net_amount: string, extra: Record<string, unknown> = {}) => ({
  id,
  activity_type: "FEE",
  status: "executed",
  currency: "USD",
  net_amount,
  ...extra,
});
// Original captured fee quantities/prices, with fixture-only identities.
const assetFees = [80537.6, 80519.3].map((price, index) => ({
  id: `asset-fee-${index}`,
  activity_type: "CFEE",
  status: "executed",
  symbol: "BTCUSD",
  currency: "USD",
  qty: "-0.0000005",
  price: String(price),
  net_amount: "0",
  created_at: "2026-09-20T05:52:39.076409Z",
}));
it("reports complete source-priced asset fees once while preserving cash-only CFEE and all existing FIFO economics", () => {
  const rows = [
    { ...fill("1", "buy", "2", "100"), symbol: "BTCUSD" },
    { ...fill("2", "sell", "1", "110"), symbol: "BTC/USD" },
    ...assetFees,
    assetFees[0],
    ...["-0.01", "-0.03", "-0.03", "-0.03"].map((cash, i) =>
      cashFee(`cash-crypto-${i}`, cash, { activity_type: "CFEE" }),
    ),
    cashFee("other-cash", "-0.11"),
  ];
  const result = summarizeFinanceBrokerFills(rows, true);
  expect(result.reportedAssetFeeValuation).toMatchObject({
    activityCount: 2,
    basis: "broker_qty_x_price_not_cash_or_closed_lot_cost",
  });
  expect(result.reportedAssetFeeValuation!.usdValue).toBeCloseTo(0.08052845, 12);
  expect(result).toMatchObject({
    grossMatchedPnl: 10,
    netMatchedPnl: null,
    allocatedClosedCashFees: 0,
    unpricedFeeActivityCount: 2,
    unallocatedFeeActivityCount: 7,
    recordedCashFeePnlBounds: null,
    status: "net_profit_unverified",
    matchedLotCount: 1,
    openLotCount: 1,
  });
  expect(result.unallocatedCashFeeAmount).toBeCloseTo(0.21, 12);
  const { reportedAssetFeeValuation: _valuation, ...economics } = result;
  const { reportedAssetFeeValuation: absentValuation, ...withoutPrices } =
    summarizeFinanceBrokerFills(
      rows.map((row) =>
        row.activity_type === "CFEE" && "price" in row && "qty" in row
          ? { ...row, price: undefined }
          : row,
      ),
      true,
    );
  expect(absentValuation).toBeNull();
  expect(economics).toEqual(withoutPrices);
  expect(summarizeFinanceBrokerFills([assetFees[0]], false)).toMatchObject({
    netMatchedPnl: null,
    status: "no_closed_matches",
    recordedCashFeePnlBounds: null,
    reportedAssetFeeValuation: { activityCount: 1, usdValue: expect.closeTo(0.0402688, 12) },
  });
});
it.each([
  ["missing price", { price: undefined }],
  ["zero price", { price: "0" }],
  ["unknown quantity", { qty: "bad" }],
  ["unknown cash-only shape", { qty: undefined, net_amount: undefined }],
  ["positive quantity", { qty: "0.0000005" }],
  ["mixed cash debit", { net_amount: "-0.01" }],
  ["rebate", { net_amount: "0.01" }],
  ["pending", { status: "pending" }],
  ["nonUSD currency", { currency: "BTC" }],
  ["missing currency", { currency: undefined }],
  ["foreign quote unit", { symbol: "ETH/BTC" }],
  ["currency token", { symbol: "USD" }],
  ["unsupported asset fee type", { activity_type: "FEE" }],
])(
  "withholds the entire asset valuation for %s instead of reporting a partial fee",
  (_kind, extra) => {
    const rows = [assetFees[0], { ...assetFees[1], ...(extra as Record<string, unknown>) }];
    expect(summarizeFinanceBrokerFills(rows, true).reportedAssetFeeValuation).toBeNull();
  },
);
it("keeps absent asset fees null and refuses overflow or underflow rather than inventing a zero valuation", () => {
  for (const rows of [
    [],
    [cashFee("cash", "-1")],
    [cashFee("cash", "-1", { activity_type: "CFEE", qty: "0" })],
    [{ ...assetFees[0], qty: "-1e308", price: "10" }],
    [
      { ...assetFees[0], qty: "-1e308", price: "1" },
      { ...assetFees[1], qty: "-1e308", price: "1" },
    ],
    [{ ...assetFees[0], qty: "-1e-320", price: "1e-10" }],
  ]) {
    expect(summarizeFinanceBrokerFills(rows, true).reportedAssetFeeValuation).toBeNull();
  }
  expect(
    summarizeFinanceBrokerFills(
      [fill("1", "buy", "1", "100"), fill("2", "sell", "1", "110")],
      true,
    ),
  ).toMatchObject({
    reportedAssetFeeValuation: null,
    netMatchedPnl: 10,
    recordedCashFeePnlBounds: { lower: 10, upper: 10 },
  });
});
it("retains instrument filtering and source identity conflicts for valued asset fees", () => {
  const equity = [fill("1", "buy", "1", "100"), fill("2", "sell", "1", "110")];
  expect(summarizeFinanceBrokerFillsByInstrument([...equity, ...assetFees], true)).toMatchObject([
    { instrument: "SPY", reportedAssetFeeValuation: null, netMatchedPnl: 10 },
  ]);
  expect(() =>
    summarizeFinanceBrokerFills([assetFees[0], { ...assetFees[0], price: "1" }], true),
  ).toThrow("conflicting activity identity");
});
it("rejects asset fee order-symbol conflicts before unsupported fee handling or instrument filtering", () => {
  const buy = { ...fill("1", "buy", "1", "100"), order_id: "buy" };
  const wrongFee = { ...assetFees[0], order_id: "buy" };
  for (const summarize of [summarizeFinanceBrokerFills, summarizeFinanceBrokerFillsByInstrument]) {
    expect(() => summarize([buy, wrongFee], true)).toThrow("conflicting fee order instrument");
    expect(() =>
      summarize(
        [buy, { ...wrongFee, qty: undefined, price: undefined, net_amount: "-0.01" }],
        true,
      ),
    ).toThrow("conflicting fee order instrument");
  }
  const rows = [
    { ...buy, symbol: "BTCUSD" },
    { ...fill("2", "sell", "1", "110"), symbol: "BTC/USD", order_id: "sell" },
    wrongFee,
  ];
  const result = summarizeFinanceBrokerFills(rows, true);
  expect(result).toMatchObject({
    grossMatchedPnl: 10,
    netMatchedPnl: null,
    allocatedClosedCashFees: 0,
    unpricedFeeActivityCount: 1,
    recordedCashFeePnlBounds: null,
    reportedAssetFeeValuation: {
      activityCount: 1,
      usdValue: expect.closeTo(0.0402688, 12),
    },
  });
  expect(summarizeFinanceBrokerFillsByInstrument(rows, true)).toEqual([
    { instrument: "BTC/USD", ...result },
  ]);
});
it.each([
  ["positive", "110", 9, 10],
  ["negative", "95", -6, -5],
  ["straddles zero", "100.5", -0.5, 0.5],
])(
  "bounds %s recorded cash-fee outcomes without asserting an exact net",
  (_kind, price, lower, upper) => {
    const fee = cashFee("pool", "-1");
    const result = summarizeFinanceBrokerFills(
      [fill("1", "buy", "2", "100"), fill("2", "sell", "1", String(price)), fee, fee],
      true,
    );
    expect(result).toMatchObject({
      netMatchedPnl: null,
      status: "net_profit_unverified",
      unallocatedCashFeeAmount: 1,
      unpricedFeeActivityCount: 0,
      unallocatedFeeActivityCount: 1,
      recordedCashFeePnlBounds: { lower, upper },
      openLotCount: 1,
      cashFeeAllocationBoundary:
        "recorded_cash_fees_only_not_exact_net_nonadditive_across_instruments",
    });
  },
);

it("uses the same unknown cash pool conservatively for each instrument and never sums instrument lower bounds", () => {
  const rows = [
    fill("1", "buy", "1", "100"),
    fill("2", "sell", "1", "110"),
    { ...fill("3", "buy", "1", "100"), symbol: "QQQ" },
    { ...fill("4", "sell", "1", "110"), symbol: "QQQ" },
    cashFee("bare-currency", "-1", { symbol: "USD", qty: "0" }),
  ];
  const instruments = summarizeFinanceBrokerFillsByInstrument(rows, true);
  expect(instruments).toHaveLength(2);
  for (const result of instruments) {
    expect(result).toMatchObject({
      netMatchedPnl: null,
      unallocatedCashFeeAmount: 1,
      recordedCashFeePnlBounds: { lower: 9, upper: 10 },
      cashFeeAllocationBoundary:
        "recorded_cash_fees_only_not_exact_net_nonadditive_across_instruments",
    });
  }
  expect(summarizeFinanceBrokerFills(rows, true).recordedCashFeePnlBounds).toEqual({
    lower: 19,
    upper: 20,
  });
  expect(instruments.reduce((sum, result) => sum + result.recordedCashFeePnlBounds!.lower, 0)).toBe(
    18,
  );
});

it.each([
  ["nonUSD", { currency: "BTC" }],
  ["in-kind", { qty: "-0.001", net_amount: "0" }],
  ["rebate", { net_amount: "1" }],
  ["pending", { status: "pending" }],
  ["missing currency", { currency: undefined }],
  ["invalid amount", { net_amount: "NaN" }],
])("keeps %s fees unpriced instead of turning them into zero cost", (_kind, extra) => {
  const result = summarizeFinanceBrokerFills(
    [
      fill("1", "buy", "1", "100"),
      fill("2", "sell", "1", "110"),
      cashFee("fee", "-1", extra as Record<string, unknown>),
    ],
    true,
  );
  expect(result).toMatchObject({
    netMatchedPnl: null,
    unallocatedCashFeeAmount: 0,
    unpricedFeeActivityCount: 1,
    recordedCashFeePnlBounds: null,
  });
});

it("withholds bounds for no closes, missing cost evidence, unmatched sells and ambiguous time ordering", () => {
  const buy = fill("1", "buy", "1", "100"),
    sell = fill("2", "sell", "1", "110"),
    fee = cashFee("fee", "-1");
  for (const [rows, verified] of [
    [[buy, fee], true],
    [[buy, sell, fee], false],
    [[sell, fee], true],
    [[buy, { ...sell, transaction_time: buy.transaction_time }, fee], true],
  ] as const) {
    expect(summarizeFinanceBrokerFills(rows, verified).recordedCashFeePnlBounds).toBeNull();
  }
});

it("treats an empty order ID as an unallocated cash fee and preserves normalized USD crypto prices", () => {
  const rows = [
    { ...fill("1", "buy", "1", "100"), order_id: "" },
    { ...fill("2", "sell", "1", "110"), order_id: "" },
    cashFee("fee", "-1", { order_id: "" }),
  ];
  expect(summarizeFinanceBrokerFills(rows, true)).toMatchObject({
    netMatchedPnl: null,
    unallocatedCashFeeAmount: 1,
    recordedCashFeePnlBounds: { lower: 9, upper: 10 },
  });
  const crypto = [
    { ...fill("1", "buy", "1", "100"), symbol: "BTCUSD", order_id: "buy", currency: "USD" },
    { ...fill("2", "sell", "1", "110"), symbol: "BTC/USD", order_id: "sell", currency: "USD" },
  ];
  expect(summarizeFinanceBrokerFillsByInstrument(crypto, true)).toMatchObject([
    {
      instrument: "BTC/USD",
      netMatchedPnl: 10,
      recordedCashFeePnlBounds: { lower: 10, upper: 10 },
    },
  ]);
  expect(
    summarizeFinanceBrokerFills(
      [crypto[0], { ...crypto[1], transaction_time: crypto[0].transaction_time }],
      true,
    ),
  ).toMatchObject({
    netMatchedPnl: null,
    recordedCashFeePnlBounds: null,
    issues: ["ambiguous_same_time_fill_order"],
  });
});

it.each(["ETH/BTC", "ETH/EUR"])("rejects %s quote units instead of labeling them USD", (symbol) => {
  expect(() =>
    summarizeFinanceBrokerFillsByInstrument([{ ...fill("1", "buy", "1", "100"), symbol }], true),
  ).toThrow("non-USD fill price unit");
});
it("rejects explicit foreign fill currency, conflicting IDs and ambiguous order/fee bindings before splitting instruments", () => {
  const buy = { ...fill("1", "buy", "1", "100"), order_id: "order" };
  for (const rows of [
    [{ ...buy, currency: "EUR" }],
    [buy, { ...buy, price: "101" }],
    [buy, { ...fill("2", "sell", "1", "110"), order_id: "order" }],
    [buy, { ...fill("2", "buy", "1", "100"), symbol: "QQQ", order_id: "order" }],
    [buy, cashFee("fee", "-1", { order_id: "order", symbol: "QQQ" })],
  ]) {
    expect(() => summarizeFinanceBrokerFills(rows, true)).toThrow();
    expect(() => summarizeFinanceBrokerFillsByInstrument(rows, true)).toThrow();
  }
});

it("isolates coin fees from equities but retains unlinked account fee uncertainty", () => {
  const rows = [
    fill("1", "buy", "1", "100"),
    fill("2", "sell", "1", "110"),
    {
      id: "coin-fee",
      activity_type: "CFEE",
      symbol: "BTCUSD",
      qty: "-0.01",
      net_amount: "0",
      currency: "USD",
      status: "executed",
    },
  ];
  expect(summarizeFinanceBrokerFillsByInstrument(rows, true)[0]).toMatchObject({
    instrument: "SPY",
    netMatchedPnl: 10,
  });
  expect(
    summarizeFinanceBrokerFillsByInstrument(
      [
        ...rows,
        {
          id: "unknown-fee",
          activity_type: "FEE",
          net_amount: "-1",
          currency: "USD",
          status: "executed",
        },
      ],
      true,
    )[0].netMatchedPnl,
  ).toBeNull();
});
it("requires matching account, order receipt and decision before attributing a fill", () => {
  const row = { ...fill("1", "buy", "1", "100"), order_id: "order-1" };
  const receipt: FinanceExecutionReceipt = {
    schemaVersion: "lcx_finance_execution_receipt_v1",
    receiptId: "r1",
    intentId: "intent:signal-1",
    runAuthorizationId: "paper-run",
    adapterId: "alpaca",
    adapterKind: "venue",
    venue: "alpaca",
    accountId: "account-a",
    instrument: "SPY",
    side: "buy",
    orderType: "market",
    quantity: 1,
    referencePrice: 100,
    referencePriceAt: row.transaction_time,
    notional: 100,
    fill: {
      filledQuantity: 1,
      fillPrice: 100,
      filledAt: row.transaction_time,
      venueRef: "alpaca:paper:order-1",
    },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: row.transaction_time,
  };
  const decisions = [
    { input: { signalId: "signal-1", instrument: "SPY", action: "buy", strategyRule: "rule-a" } },
  ];
  expect(attributeFinanceBrokerFills([row, row], [receipt], decisions, "account-a")).toMatchObject({
    attributedFillCount: 1,
    unattributedFillCount: 0,
    strategies: [{ strategyRule: "rule-a", fillCount: 1 }],
  });
  expect(
    attributeFinanceBrokerFills([row], [receipt], decisions, "account-b").unattributedFillCount,
  ).toBe(1);
  expect(attributeFinanceBrokerFills([row], [receipt], [], "account-a").unattributedFillCount).toBe(
    1,
  );
});

it("records daily-cycle decision lineage only for one exact account/order/instrument/side receipt", () => {
  const row = { ...fill("1", "buy", "1", "100"), order_id: "order-1" };
  const receipt: FinanceExecutionReceipt = {
    schemaVersion: "lcx_finance_execution_receipt_v1",
    receiptId: "daily-r1",
    intentId: "intent:daily-cycle:2026-09-30:SPY",
    decisionRef: { source: "daily_cycle_candidate", id: "paper-run:2026-09-30:SPY:buy" },
    runAuthorizationId: "paper-run",
    adapterId: "alpaca",
    adapterKind: "venue",
    venue: "alpaca",
    accountId: "account-a",
    instrument: "SPY",
    side: "buy",
    orderType: "market",
    quantity: 1,
    referencePrice: 100,
    referencePriceAt: row.transaction_time,
    notional: 100,
    fill: {
      filledQuantity: 1,
      fillPrice: 100,
      filledAt: row.transaction_time,
      venueRef: "alpaca:paper:order-1",
    },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: row.transaction_time,
  };
  const result = (receipts: FinanceExecutionReceipt[], account = "account-a") =>
    attributeFinanceBrokerFills([row], receipts, [], account).decisionSourceLineage;

  expect(result([receipt])).toMatchObject({
    dailyCycleCandidateFillCount: 1,
    unknownOrAmbiguousSourceFillCount: 0,
  });
  expect(result([{ ...receipt, accountId: "account-b" }])).toMatchObject({
    dailyCycleCandidateFillCount: 0,
    unknownOrAmbiguousSourceFillCount: 1,
  });
  expect(
    result([{ ...receipt, fill: { ...receipt.fill, venueRef: "alpaca:paper:other" } }]),
  ).toMatchObject({
    dailyCycleCandidateFillCount: 0,
    unknownOrAmbiguousSourceFillCount: 1,
  });
  expect(result([{ ...receipt, side: "sell" }])).toMatchObject({
    dailyCycleCandidateFillCount: 0,
    unknownOrAmbiguousSourceFillCount: 1,
  });
  expect(result([receipt, { ...receipt, receiptId: "daily-r2" }])).toMatchObject({
    dailyCycleCandidateFillCount: 0,
    unknownOrAmbiguousSourceFillCount: 1,
  });
  expect(result([receipt], "account-b")).toMatchObject({
    dailyCycleCandidateFillCount: 0,
    unknownOrAmbiguousSourceFillCount: 1,
  });
});

describe("sealed readonly instrument economics", () => {
  async function fixture(
    run: (
      directory: string,
      append: (
        query: string,
        payload: Record<string, unknown>[],
        accountId?: string,
      ) => Promise<unknown>,
    ) => Promise<void>,
  ) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "broker-economics-"));
    const append = (query: string, payload: Record<string, unknown>[], accountId = "paper-a") =>
      appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId,
        venue: "alpaca:paper",
        query,
        cursor: "",
        payload,
      });
    try {
      await run(directory, append);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const snapshot = {
    observedAt: "2026-10-04T10:03:00Z",
    status: "reconciled",
    feesInterpreted: true,
    issues: [],
    differences: [],
    cashDifference: 0,
  };
  const rows = [
    { ...fill("1", "buy", "1", "100"), order_id: "buy" },
    { ...fill("2", "sell", "1", "110"), order_id: "sell" },
  ];
  const read = (directory: string, asOf = "2026-10-04T10:04:00Z") =>
    readFinanceBrokerInstrumentFeedback({
      directory,
      accountId: "paper-a",
      instrument: "SPY",
      asOf,
    });
  it("reads original price-times-quantity asset fee evidence only through the sealed cutoff", async () =>
    fixture(async (directory, append) => {
      await append("activities:main", [
        { ...rows[0], symbol: "BTCUSD" },
        { ...rows[1], symbol: "BTCUSD" },
        ...assetFees,
        assetFees[0],
        cashFee("cash-crypto", "-0.1", {
          activity_type: "CFEE",
          created_at: "2026-10-03T00:00:00Z",
        }),
      ]);
      await append("reconciliation:sealed", [snapshot]);
      await append("activities:after-seal", [
        { ...assetFees[0], id: "after-seal", price: undefined },
      ]);
      const result = await readFinanceBrokerInstrumentFeedback({
        directory,
        accountId: "paper-a",
        instrument: "BTC/USD",
        asOf: "2026-10-04T10:04:00Z",
      });
      expect(result.status).toBe("present");
      if (result.status !== "present") {
        throw new Error(result.reason);
      }
      expect(result.economics.reportedAssetFeeValuation!.usdValue).toBeCloseTo(0.08052845, 12);
      expect(result.economics.reportedAssetFeeValuation?.activityCount).toBe(2);
      expect(result.economics).toMatchObject({
        unpricedFeeActivityCount: 2,
        netMatchedPnl: null,
        recordedCashFeePnlBounds: null,
      });
      expect(result.economics.unallocatedCashFeeAmount).toBeCloseTo(0.1, 12);
    }));
  it("uses only sealed account activities and ignores later fees and future snapshots", async () =>
    fixture(async (directory, append) => {
      await append("activities:main", [...rows, rows[0]]);
      await append("activities:main", [{ ...rows[1], price: "900" }], "other-account");
      await append("reconciliation:sealed", [snapshot]);
      await append("activities:later", [
        {
          id: "late",
          activity_type: "FEE",
          status: "executed",
          currency: "USD",
          net_amount: "-8",
          order_id: "sell",
          created_at: "2026-10-04T10:05:00Z",
        },
      ]);
      await append("reconciliation:future", [{ ...snapshot, observedAt: "2026-10-04T10:06:00Z" }]);
      const result = await read(directory);
      expect(result.status).toBe("present");
      if (result.status !== "present") {
        throw new Error(result.reason);
      }
      expect(result.economics.grossMatchedPnl).toBe(10);
      expect(result.economics.netMatchedPnl).toBe(10);
      expect(result.sealedSequence).toBe(3);
      expect(result.observationBoundary).toContain("no_per_record_capture_time");
    }));
  it("does not convert unallocated fees or zero closed samples into net performance", async () =>
    fixture(async (directory, append) => {
      await append("activities:main", [
        ...rows,
        {
          id: "fee",
          activity_type: "CFEE",
          status: "executed",
          currency: "USD",
          net_amount: "-0.1",
          date: "2026-10-05",
          created_at: "2026-10-03T00:00:00Z",
        },
      ]);
      await append("reconciliation:sealed", [snapshot]);
      const result = await read(directory);
      expect(result.status).toBe("present");
      if (result.status !== "present") {
        throw new Error(result.reason);
      }
      expect(result.economics.netMatchedPnl).toBeNull();
      expect(result.economics.issues).toContain("fees_not_allocated_to_closed_lots");
      const zero = await readFinanceBrokerInstrumentFeedback({
        directory,
        accountId: "paper-a",
        instrument: "NKE",
        asOf: "2026-10-04T10:04:00Z",
      });
      expect(zero.status === "present" && zero.economics.status).toBe("no_closed_matches");
      expect((await read(directory, "2026-10-04T10:09:00Z")).status).toBe("unavailable");
    }));
  it.each(["conflict", "future", "unknown"])(
    "rejects %s source evidence before FIFO calculation",
    async (kind) =>
      fixture(async (directory, append) => {
        const extra =
          kind === "conflict"
            ? { ...rows[0], price: "101" }
            : {
                id: "fee",
                activity_type: "FEE",
                status: "executed",
                currency: "USD",
                net_amount: "-0.1",
                ...(kind === "future"
                  ? { created_at: "2026-10-04T11:00:00Z" }
                  : { date: "2026-10-05" }),
              };
        await append("activities:main", [...rows, extra]);
        await append("reconciliation:sealed", [snapshot]);
        expect((await read(directory)).status).toBe("unavailable");
      }),
  );
});

it.each([
  "linked",
  "orphan",
  "foreign",
  "activation",
  "future",
  "too_much",
  "late_publication",
  "other_candidate",
] as const)("native exit feedback joins partial stop fills: %s", async (fault) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "exit-feedback-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T13:30:00Z"));
  const accountId = "paper-exit",
    ruleId = "opening_range_breakout_long_next_bar_v1",
    activationRef = "b".repeat(64),
    asOf = "2026-09-23T15:00:00.000Z";
  try {
    await appendFinanceIntradayDecision(directory, {
      signalId: "entry-signal",
      instrument: "SPY",
      sessionDate: "2026-09-23",
      action: "buy",
      reason: "opening_range_breakout",
      referencePrice: 100,
      referencePriceAt: "2026-09-23T13:30:00.000Z",
      datasetHeadRef: "c".repeat(64),
      strategyRule: ruleId,
      strategyBinding: {
        declarationRef: "a".repeat(64),
        activationRef,
        declaredInstruments: ["SPY"],
        parameters: { openingRangeBars: 6, rewardRisk: 2, intervalSeconds: 300, feed: "iex" },
        scope: "strategy_universe",
      },
    });
    vi.setSystemTime(new Date(asOf));
    await appendFinanceExecutionReceipt(directory, {
      schemaVersion: "lcx_finance_execution_receipt_v1",
      receiptId: "entry-receipt",
      accountId: fault === "foreign" ? "other" : accountId,
      intentId: "intent:entry-signal",
      decisionRef: { source: "intraday_signal", id: "entry-signal" },
      runAuthorizationId: "synthetic-run",
      adapterId: "alpaca",
      adapterKind: "venue",
      venue: "alpaca:paper",
      instrument: "SPY",
      side: "buy",
      orderType: "market",
      quantity: 10,
      referencePrice: 100,
      referencePriceAt: "2026-09-23T13:30:00.000Z",
      notional: 1000,
      fill: {
        filledQuantity: 10,
        fillPrice: 100,
        filledAt: "2026-09-23T13:31:00.000Z",
        venueRef: "alpaca:paper:buy-order",
        terminalOrderIdentity: { orderId: "buy-order", terminal: true },
      },
      executionAuthority: "declared_execution_adapter_required",
      recordedAt: "2026-09-23T13:31:00.000Z",
    });
    const orders = [
      {
        id: "buy-order",
        symbol: "SPY",
        side: "buy",
        order_class: "oto",
        filled_qty: "10",
        filled_at: "2026-09-23T13:31:00.000Z",
        legs:
          fault === "orphan"
            ? []
            : [
                {
                  id: "stop-order",
                  symbol: "SPY",
                  side: "sell",
                  type: "stop",
                  qty: "10",
                  filled_qty: fault === "too_much" ? "11" : "10",
                },
              ],
      },
    ];
    const activities = [
      {
        id: "buy-fill",
        activity_type: "FILL",
        type: "fill",
        order_id: "buy-order",
        symbol: "SPY",
        side: "buy",
        order_class: "oto",
        filled_qty: "10",
        filled_at: "2026-09-23T13:31:00.000Z",
        qty: "10",
        price: "100",
        transaction_time: "2026-09-23T13:31:00.000Z",
      },
      ...[
        ["3", "95"],
        [fault === "too_much" ? "8" : "7", "94"],
      ].map(([qty, price], i) => ({
        id: `stop-part-${i}`,
        activity_type: "FILL",
        type: "partial_fill",
        order_id: "stop-order",
        symbol: "SPY",
        side: "sell",
        qty,
        price,
        transaction_time:
          fault === "future" ? "2026-09-23T16:00:00.000Z" : `2026-09-23T14:0${i}:00.000Z`,
      })),
    ];
    for (const [stream, payload] of [
      ["orders", orders],
      ["activities", activities],
    ] as const) {
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId,
        venue: "alpaca:paper",
        query: `${stream}:2026-09-01T00:00:00Z:${fault === "late_publication" ? "2026-09-23T16:00:00.000Z" : asOf}`,
        cursor: "",
        payload: [...payload],
      });
    }
    const read = () =>
      readFinanceBrokerExitFeedback(directory, {
        accountId,
        instrument: "SPY",
        ruleId,
        activationRef: fault === "activation" ? "d".repeat(64) : activationRef,
        asOf,
      });
    if (fault === "future" || fault === "too_much" || fault === "orphan") {
      await expect(read()).rejects.toThrow("oto_child");
    } else {
      const feedback = await read();
      if (fault !== "linked" && fault !== "other_candidate") {
        expect(feedback).toBeUndefined();
      } else {
        expect(feedback?.entries[0]).toMatchObject({
          signalId: "entry-signal",
          instrument: "SPY",
          entryOrderId: "buy-order",
          exitOrderId: "stop-order",
          exitQuantity: 10,
          exitAveragePrice: 94.3,
          grossPnl: -57,
          partialFillCount: 2,
          fees: "not_attributed",
          netPnl: null,
        });
      }
    }
    expect((await readFinancePositionLedger(directory)).receipts).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});
