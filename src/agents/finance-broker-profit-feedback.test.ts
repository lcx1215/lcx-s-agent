import { describe, it, expect } from "vitest";
import {
  summarizeFinanceBrokerFills,
  summarizeFinanceBrokerFillsByInstrument,
  attributeFinanceBrokerFills,
} from "./finance-broker-profit-feedback.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
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
});

it("does not invent ordering between opposing fills at the same timestamp", () => {
  const buy = fill("1", "buy", "1", "100");
  const sell = { ...fill("2", "sell", "1", "110"), transaction_time: buy.transaction_time };
  expect(summarizeFinanceBrokerFills([buy, sell], true)).toMatchObject({
    netMatchedPnl: null,
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
  });
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
