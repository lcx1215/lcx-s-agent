import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileFinanceBrokerHistory } from "./finance-alpaca-history-reconciliation.js";
import { readFinanceBrokerHistory } from "./finance-alpaca-history-sync.js";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "./finance-execution-adapter.js";
import {
  appendFinanceBrokerHistory,
  appendFinanceExecutionReceipt,
} from "./finance-position-ledger.js";
import { createFinancePositionLedgerReadTool } from "./tools/finance-position-ledger-read-tool.js";

const directories: string[] = [];
const completeReceipt = (accountId: string) => ({
  accountId,
  venue: "alpaca:paper",
  status: "raw_history_synced",
  accountCreatedAt: "2025-01-01T00:00:00Z",
  after: "2025-01-01T00:00:00Z",
  until: "2025-02-01T00:00:00Z",
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("Alpaca broker history reconciliation", () => {
  it("reuses only the exact book observation with every required history stream", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "broker-observation-"));
    directories.push(directory);
    const accountId = "selected";
    const raw = await readFinanceBrokerHistory(directory, accountId, {
      streams: ["orders", "activities", "sync_receipt"],
    });
    expect(await reconcileFinanceBrokerHistory(directory, accountId, raw)).toEqual(
      await reconcileFinanceBrokerHistory(directory, accountId),
    );
    await expect(reconcileFinanceBrokerHistory(directory, "other", raw)).rejects.toThrow(
      "observation scope mismatch",
    );
    await expect(
      reconcileFinanceBrokerHistory(directory + "-other", accountId, raw),
    ).rejects.toThrow("observation scope mismatch");
    await expect(
      reconcileFinanceBrokerHistory(directory, accountId, { ...raw, streamScope: ["orders"] }),
    ).rejects.toThrow("requires orders, activities and sync receipts");
  });
  it("never lets an older complete receipt rescue the latest incomplete or malformed attempt", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "broker-latest-sync-"));
    directories.push(directory);
    const accountId = "selected";
    const append = (query: string, payload: Record<string, unknown>[]) =>
      appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId,
        venue: "alpaca:paper",
        query,
        cursor: "",
        payload,
      });
    await append("activities:window", [
      {
        id: "fill",
        activity_type: "FILL",
        type: "fill",
        order_id: "order",
        symbol: "SPY",
        side: "buy",
        qty: "1",
        price: "100",
        transaction_time: "2025-01-02T15:00:00Z",
      },
    ]);
    await append("sync_receipt:old-window", [completeReceipt(accountId)]);
    expect((await reconcileFinanceBrokerHistory(directory, accountId)).historyStatus).toBe(
      "reconciled",
    );
    for (const [query, payload] of [
      ["sync_receipt:new-window", [{ status: "incomplete" }]],
      ["sync_receipt:malformed", [{}]],
      ["sync_receipt:empty", []],
      ["sync_receipt:ambiguous", [{ status: "raw_history_synced" }, { status: "incomplete" }]],
    ] as const) {
      await append(query, [...payload]);
      const read = await readFinanceBrokerHistory(directory, accountId);
      expect((await reconcileFinanceBrokerHistory(directory, accountId, read)).historyStatus).toBe(
        "incomplete",
      );
    }
    const read = await readFinanceBrokerHistory(directory, accountId);
    expect(
      (
        await reconcileFinanceBrokerHistory(directory, accountId, {
          ...read,
          latestSyncReceipt: null,
        })
      ).historyStatus,
    ).toBe("incomplete");
  });

  it("does not assign a date-only asset fee to an unproven intraday cutoff", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "broker-fee-cutoff-"));
    directories.push(directory);
    const accountId = "fee-cutoff";
    const append = (query: string, payload: Record<string, unknown>[]) =>
      appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId,
        venue: "alpaca:paper",
        query,
        cursor: "",
        payload,
      });
    await append("activities:window", [
      {
        id: "buy",
        activity_type: "FILL",
        type: "fill",
        order_id: "order",
        symbol: "BTCUSD",
        side: "buy",
        qty: "1",
        price: "100",
        transaction_time: "2025-01-02T15:00:00Z",
      },
      {
        id: "fee",
        activity_type: "CFEE",
        symbol: "BTCUSD",
        asset: "BTC",
        net_amount: "-0.001",
        date: "2025-01-03",
      },
    ]);
    await append("sync_receipt:noon", [
      { ...completeReceipt(accountId), until: "2025-01-03T12:00:00Z" },
    ]);
    const held = await reconcileFinanceBrokerHistory(directory, accountId);
    expect(held.positionBaselineUsable).toBe(false);
    expect(held.fees).toHaveLength(1);
    await append("sync_receipt:full-day", [
      { ...completeReceipt(accountId), until: "2025-01-04T00:00:00Z" },
    ]);
    expect((await reconcileFinanceBrokerHistory(directory, accountId)).positionBaselineUsable).toBe(
      true,
    );
  });

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
          type: "fill",
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
          type: "partial_fill",
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
      payload: [completeReceipt(accountId)],
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
    expect(result.sourceHeadRef).toBe(
      (await readFinanceBrokerHistory(directory, accountId)).headRef,
    );

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
      baselineAppliedFeeCount: 0,
      orderAllocatedFeeCount: 2,
      feeTotals: [
        { currency: "BTC", amount: 0.001 },
        { currency: "USD", amount: 1.5 },
      ],
    });
    expect(result.fills.find((fill) => fill.activityId === "fill-btc")).toMatchObject({
      executionType: "partial_fill",
      quantity: 0.5,
    });
    expect(result.positions).toEqual([
      {
        instrument: "BTC/USD",
        quantity: -0.501,
        averageCost: 199.600798,
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
      payload: [completeReceipt("synthetic-account")],
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
          type: "fill",
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
      payload: [completeReceipt(accountId)],
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
    expect(result.appliedFeeCount).toBe(1);
    expect(result.unappliedFeeCount).toBe(0);
    expect(result.baselineAppliedFeeCount).toBe(1);
    expect(result.orderAllocatedFeeCount).toBe(0);
    expect(result.historyStatus).toBe("reconciled");
    expect(result.positionBaselineUsable).toBe(true);
    expect(result.feesInterpreted).toBe(true);
    expect(result.fees[0]?.orderId).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("order-level fee linkage remains unproven");
  });

  it("keeps an unlinked asset fee incomplete when no position baseline can absorb it", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-history-reconcile-"));
    directories.push(directory);
    const accountId = "fee-without-position-account";
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: "activities:window",
      cursor: "",
      payload: [
        {
          id: "fee-btc-without-position",
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
      payload: [completeReceipt(accountId)],
    });

    const result = await reconcileFinanceBrokerHistory(directory, accountId);

    expect(result.baselineAppliedFeeCount).toBe(0);
    expect(result.appliedFeeCount).toBe(0);
    expect(result.unappliedFeeCount).toBe(1);
    expect(result.historyStatus).toBe("incomplete");
    expect(result.positionBaselineUsable).toBe(true);
    expect(result.feesInterpreted).toBe(false);
    expect(result.positions).toEqual([]);
    expect(result.warnings.join(" ")).toContain("not allocated to a USD order fill");
  });
});

describe("cash merger reaches original account book and result consumer", () => {
  it.each(["complete", "missing_leg", "ambiguous_time", "later_buy"] as const)(
    "handles %s without making a sell or pretending unknown timing",
    async (mode) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cash-merger-book-"));
      directories.push(directory);
      const accountId = "original-paper-account";
      const buy = {
        id: "original-buy",
        order_id: "original-buy-order",
        activity_type: "FILL",
        type: "fill",
        side: "buy",
        symbol: "WBD",
        qty: "10",
        price: "10",
        transaction_time:
          mode === "ambiguous_time" ? "2025-01-05T10:00:00Z" : "2025-01-02T10:00:00Z",
      };
      const fee = {
        id: "entry-fee",
        order_id: buy.order_id,
        activity_type: "FEE",
        status: "executed",
        currency: "USD",
        net_amount: "-1",
        transaction_time: buy.transaction_time,
      };
      const merger = {
        activity_type: "MA",
        activity_sub_type: "CMA",
        group_id: "merger-group",
        corporate_action_id: "merger-action",
        symbol: "WBD",
        currency: "USD",
        status: "executed",
        date: "2025-01-05",
        created_at: "2025-01-05T12:00:00Z",
      };
      const cash = { ...merger, id: "cash-leg", net_amount: "110" };
      const shares = { ...merger, id: "share-leg", net_amount: "0", qty: "-10", price: "999" };
      const later = {
        ...buy,
        id: "later-buy",
        order_id: "later-order",
        qty: "2",
        price: "20",
        transaction_time: "2025-01-06T10:00:00Z",
      };
      const activities = [
        buy,
        fee,
        cash,
        ...(mode === "missing_leg" ? [] : [shares]),
        ...(mode === "later_buy" ? [later] : []),
      ];
      for (const [query, payload] of [
        [
          "orders:window",
          [
            { id: buy.order_id, status: "filled", filled_qty: "10" },
            ...(mode === "later_buy"
              ? [{ id: later.order_id, status: "filled", filled_qty: "2" }]
              : []),
          ],
        ],
        ["activities:window", activities],
        ["sync_receipt:window", [completeReceipt(accountId)]],
      ] as const) {
        await appendFinanceBrokerHistory(directory, {
          kind: "broker_history",
          accountId,
          venue: "alpaca:paper",
          query,
          cursor: "",
          payload: [...payload],
        });
      }
      const result = await reconcileFinanceBrokerHistory(directory, accountId);
      expect(result.brokerFillCount).toBe(mode === "later_buy" ? 2 : 1);
      expect(result.matchedReceiptCount).toBe(0);
      if (mode === "missing_leg" || mode === "ambiguous_time") {
        expect(result.positionBaselineUsable).toBe(false);
        expect(result.invalidCorporateActionCount).toBeGreaterThan(0);
        expect(result.corporateSettlements).toBeUndefined();
      } else {
        expect(result.positionBaselineUsable).toBe(true);
        expect(result.positions[0]).toMatchObject({
          instrument: "WBD",
          quantity: mode === "later_buy" ? 2 : 0,
          averageCost: mode === "later_buy" ? 20 : 0,
          realizedPnl: 0,
        });
        expect(result.corporateSettlements?.[0]).toMatchObject({
          cash: 110,
          costBasis: 101,
          settlementPnl: 9,
          boundary: "corporate_settlement_not_order_fill_or_strategy_pnl",
        });
        const toolResult = await createFinancePositionLedgerReadTool().execute(
          "actual-original-book-read",
          { directory, brokerAccountId: accountId },
        );
        const diagnostic = (
          toolResult.details as { brokerTradeEconomics: { diagnostic: Record<string, unknown> } }
        ).brokerTradeEconomics.diagnostic;
        expect(diagnostic.realizedTradePnlAfterFees).toBe(0);
        expect(diagnostic.corporateSettlementOutcomes).toMatchObject({ observedSettlementPnl: 9 });
        expect(diagnostic.executionThresholdPromotionEligible).toBe(false);
      }
    },
  );
});
