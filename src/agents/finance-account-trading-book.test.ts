import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readFinanceAccountTradingBook } from "./finance-account-trading-book.js";
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

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-account-book-"));
  directories.push(directory);
  const accountId = "account-book";
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId,
    venue: "alpaca:paper",
    query: "orders:window",
    cursor: "",
    payload: [
      { id: "order-spy", status: "filled", filled_qty: "1" },
      { id: "order-btc", status: "filled", filled_qty: "0.0004" },
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
        transaction_time: "2026-09-20T01:00:00Z",
      },
      {
        id: "fill-btc",
        activity_type: "FILL",
        order_id: "order-btc",
        symbol: "BTCUSD",
        side: "buy",
        qty: "0.0004",
        price: "80000",
        transaction_time: "2026-09-20T02:00:00Z",
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
    adapterId: "alpaca-venue",
    adapterKind: "venue",
    venue: "alpaca:paper",
    instrument: "SPY",
    side: "buy",
    orderType: "market",
    quantity: 1,
    referencePrice: 100,
    referencePriceAt: "2026-09-20T01:00:00Z",
    notional: 100,
    fill: {
      filledQuantity: 1,
      fillPrice: 100,
      filledAt: "2026-09-20T01:00:00Z",
      venueRef: "alpaca:paper:order-spy",
      terminalOrderIdentity: { orderId: "order-spy", terminal: true },
    },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: "2026-09-20T01:00:00Z",
  });
  return { directory, accountId };
}

it("uses reconciled broker history as a position baseline without inventing receipts", async () => {
  const f = await fixture();
  const book = await readFinanceAccountTradingBook({
    directory: f.directory,
    accountId: f.accountId,
    venue: "alpaca:paper",
  });
  expect(book.baselineSource).toBe("broker_history");
  expect(book.brokerBaselineUsable).toBe(true);
  expect(book.executionReceiptCount).toBe(1);
  expect(book.matchedReceiptCount).toBe(1);
  expect(book.unmatchedFillCount).toBe(1);
  expect(book.historicalOnlyInstruments).toEqual(["BTC/USD"]);
  expect(book.positions).toEqual([
    {
      instrument: "BTC/USD",
      quantity: 0.0004,
      averageCost: 80000,
      realizedPnl: 0,
      appliedUsdFees: 0,
    },
    { instrument: "SPY", quantity: 1, averageCost: 100, realizedPnl: 0, appliedUsdFees: 0 },
  ]);
  expect(book.execution.receipts).toHaveLength(1);
});

it("falls back to execution receipts when broker history is unavailable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-account-book-"));
  directories.push(directory);
  const accountId = "account-only-receipts";
  await appendFinanceExecutionReceipt(directory, {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: "receipt-spy",
    accountId,
    intentId: "intent-spy",
    runAuthorizationId: "run-spy",
    adapterId: "alpaca-venue",
    adapterKind: "venue",
    venue: "alpaca:paper",
    instrument: "SPY",
    side: "buy",
    orderType: "market",
    quantity: 1,
    referencePrice: 100,
    referencePriceAt: "2026-09-20T01:00:00Z",
    notional: 100,
    fill: {
      filledQuantity: 1,
      fillPrice: 100,
      filledAt: "2026-09-20T01:00:00Z",
      venueRef: "fixture",
    },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: "2026-09-20T01:00:00Z",
  });
  const book = await readFinanceAccountTradingBook({
    directory,
    accountId,
    venue: "alpaca:paper",
  });
  expect(book.baselineSource).toBe("execution_receipts");
  expect(book.brokerBaselineUsable).toBe(false);
  expect(book.positions[0]).toMatchObject({ instrument: "SPY", quantity: 1 });
});
