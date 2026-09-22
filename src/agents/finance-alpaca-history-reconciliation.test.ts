import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileFinanceBrokerHistory } from "./finance-alpaca-history-reconciliation.js";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "./finance-execution-adapter.js";
import {
  appendFinanceBrokerHistory,
  appendFinanceExecutionReceipt,
} from "./finance-position-ledger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("Alpaca broker history reconciliation", () => {
  it("projects old fills and fees without manufacturing execution receipts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-history-reconcile-"));
    directories.push(directory);
    const accountId = "synthetic-account";
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: "orders:window",
      cursor: "",
      payload: [
        {
          id: "order-spy",
          status: "filled",
          filled_qty: "1",
          submitted_at: "2025-01-02T00:00:00Z",
        },
        {
          id: "order-btc",
          status: "partially_filled",
          filled_qty: "0.5",
          submitted_at: "2025-01-03T00:00:00Z",
        },
      ],
    });
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: "activities:window",
      cursor: "",
      payload: [
        {
          id: "fill-spy",
          activity_type: "FILL",
          order_id: "order-spy",
          symbol: "SPY",
          side: "buy",
          qty: "1",
          price: "100",
          transaction_time: "2025-01-02T15:00:00Z",
        },
        {
          id: "fee-spy",
          activity_type: "FEE",
          order_id: "order-spy",
          symbol: "SPY",
          currency: "USD",
          net_amount: "-1.50",
          date: "2025-01-02",
        },
        {
          id: "fill-btc",
          activity_type: "FILL",
          order_id: "order-btc",
          symbol: "BTCUSD",
          side: "sell",
          qty: "0.5",
          price: "200",
          transaction_time: "2025-01-03T15:00:00Z",
        },
        {
          id: "fee-btc",
          activity_type: "CFEE",
          order_id: "order-btc",
          symbol: "BTCUSD",
          asset: "BTC",
          net_amount: "-0.001",
          date: "2025-01-03",
        },
      ],
    });
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: "sync_receipt:window",
      cursor: "",
      payload: [{ status: "raw_history_synced" }],
    });
    await appendFinanceExecutionReceipt(directory, {
      schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
      receiptId: "receipt-spy",
      accountId,
      intentId: "intent-spy",
      runAuthorizationId: "run-spy",
      adapterId: "alpaca",
      adapterKind: "venue",
      venue: "alpaca:paper",
      instrument: "SPY",
      side: "buy",
      orderType: "market",
      quantity: 1,
      referencePrice: 100,
      referencePriceAt: "2025-01-02T15:00:00Z",
      notional: 100,
      fill: {
        filledQuantity: 1,
        fillPrice: 100,
        filledAt: "2025-01-02T15:00:00Z",
        venueRef: "alpaca:paper:order-spy",
        terminalOrderIdentity: { orderId: "order-spy", terminal: true },
      },
      executionAuthority: "declared_execution_adapter_required",
      recordedAt: "2025-01-02T15:00:00Z",
    });

    const result = await reconcileFinanceBrokerHistory(directory, accountId);

    expect(result).toMatchObject({
      historyStatus: "reconciled",
      positionsReconciled: true,
      positionBaselineUsable: true,
      feesInterpreted: true,
      brokerFillCount: 2,
      brokerFeeCount: 2,
      matchedReceiptCount: 1,
      unmatchedFillCount: 1,
      appliedFeeCount: 2,
      unappliedFeeCount: 0,
      feeTotals: [
        { currency: "BTC", amount: 0.001 },
        { currency: "USD", amount: 1.5 },
      ],
    });
    expect(result.positions).toEqual([
      {
        instrument: "BTC/USD",
        quantity: -0.501,
        averageCost: 200,
        realizedPnl: 0,
        appliedUsdFees: 0,
      },
      { instrument: "SPY", quantity: 1, averageCost: 101.5, realizedPnl: 0, appliedUsdFees: 1.5 },
    ]);
    expect(result.warnings.join(" ")).toContain("historical projection only");
  });

  it("refuses to certify a malformed fill or a filled order with no activity", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-history-reconcile-"));
    directories.push(directory);
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId: "synthetic-account",
      venue: "alpaca:paper",
      query: "orders:window",
      cursor: "",
      payload: [{ id: "order-missing-fill", status: "filled", filled_qty: "1" }],
    });
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId: "synthetic-account",
      venue: "alpaca:paper",
      query: "activities:window",
      cursor: "",
      payload: [
        {
          id: "bad-fill",
          activity_type: "FILL",
          order_id: "order-bad",
          symbol: "SPY",
          side: "buy",
          qty: "1",
          transaction_time: "2025-01-02T15:00:00Z",
        },
      ],
    });
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId: "synthetic-account",
      venue: "alpaca:paper",
      query: "sync_receipt:window",
      cursor: "",
      payload: [{ status: "raw_history_synced" }],
    });

    const result = await reconcileFinanceBrokerHistory(directory, "synthetic-account");

    expect(result.historyStatus).toBe("incomplete");
    expect(result.positionsReconciled).toBe(false);
    expect(result.positionBaselineUsable).toBe(false);
    expect(result.invalidFillCount).toBe(1);
    expect(result.ordersMissingFillActivityCount).toBe(1);
  });

  it("uses an explicit non-USD fee quantity for the net position without inventing order linkage", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-history-reconcile-"));
    directories.push(directory);
    const accountId = "crypto-fee-account";
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: "orders:window",
      cursor: "",
      payload: [{ id: "order-btc", status: "filled", filled_qty: "1" }],
    });
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: "activities:window",
      cursor: "",
      payload: [
        {
          id: "fill-btc",
          activity_type: "FILL",
          order_id: "order-btc",
          symbol: "BTCUSD",
          side: "buy",
          qty: "1",
          price: "100",
          transaction_time: "2025-01-02T15:00:00Z",
        },
        {
          id: "fee-btc",
          activity_type: "CFEE",
          symbol: "BTCUSD",
          qty: "-0.001",
          net_amount: "0",
          currency: "USD",
          description: "Coin Pair Transaction Fee (Non USD)",
          created_at: "2025-01-02T15:00:01Z",
        },
      ],
    });
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: "sync_receipt:window",
      cursor: "",
      payload: [{ status: "raw_history_synced" }],
    });

    const result = await reconcileFinanceBrokerHistory(directory, accountId);

    expect(result.positions).toEqual([
      {
        instrument: "BTC/USD",
        quantity: 0.999,
        averageCost: 100,
        realizedPnl: 0,
        appliedUsdFees: 0,
      },
    ]);
    expect(result.assetFeeAdjustedInstruments).toEqual(["BTC/USD"]);
    expect(result.appliedFeeCount).toBe(0);
    expect(result.unappliedFeeCount).toBe(1);
    expect(result.positionBaselineUsable).toBe(true);
    expect(result.feesInterpreted).toBe(false);
  });
});
