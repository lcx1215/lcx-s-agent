import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import {
  attributeFinancePaperEconomics,
  readFinancePaperEconomicAttribution,
} from "./finance-paper-economic-attribution.js";
import { appendFinanceBrokerHistory } from "./finance-position-ledger.js";

const from = "2026-10-15T05:18:54.810Z",
  through = "2026-10-15T06:00:00.000Z";
function fill(id: string, side: string, qty: number, price: number, at: string) {
  return {
    id,
    order_id: id,
    activity_type: "FILL",
    type: "fill",
    side,
    symbol: "SPY",
    qty: String(qty),
    price: String(price),
    transaction_time: at,
  };
}
function receipt(
  id: string,
  side: "buy" | "sell",
  qty: number,
  price: number,
  at: string,
): FinanceExecutionReceipt {
  return {
    schemaVersion: "lcx_finance_execution_receipt_v1",
    receiptId: `receipt-${id}`,
    accountId: "paper",
    intentId: `intent:${id}`,
    decisionRef: { source: "intraday_signal", id },
    runAuthorizationId: "fixture",
    adapterId: "alpaca",
    adapterKind: "venue",
    venue: "alpaca:paper",
    instrument: "SPY",
    side,
    orderType: "market",
    quantity: qty,
    referencePrice: price,
    referencePriceAt: at,
    notional: qty * price,
    fill: {
      filledQuantity: qty,
      fillPrice: price,
      filledAt: at,
      venueRef: `alpaca:paper:${id}`,
      terminalOrderIdentity: { orderId: id, terminal: true },
    },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: at,
  };
}
function decision(id: string, action: "buy" | "sell", at: string) {
  return {
    ref: id.repeat(64),
    recordedAt: at,
    input: {
      signalId: id,
      instrument: "SPY",
      action,
      strategyRule: "test-rule",
      strategyBinding: {
        declarationRef: "d".repeat(64),
        activationRef: "a".repeat(64),
        declaredInstruments: ["SPY"],
        declaredSignalNamespace: "intraday-test",
      },
    },
  };
}
function snapshot(at: string, equity: number, qty: number, price: number) {
  return {
    status: "reconciled",
    observedAt: at,
    feesInterpreted: true,
    accountObservation: {
      accountId: "paper",
      currency: "USD",
      equity,
      observedAt: at,
      accruedFees: 0,
      pendingRegTafFees: 0,
    },
    positions: qty ? [{ symbol: "SPY", qty: String(qty), market_value: String(qty * price) }] : [],
  };
}
function fixture() {
  const sellAt = "2026-10-15T05:30:00.000Z",
    buyAt = "2026-10-15T05:40:00.000Z";
  return {
    accountId: "paper",
    anchor: { at: from, equity: 2000, ref: "opening" },
    opening: snapshot(from, 2000, 10, 110),
    closing: snapshot(through, 2137, 8, 125),
    closingRef: "closing",
    activities: [
      fill("old", "buy", 10, 100, "2026-10-14T19:00:00.000Z"),
      fill("sell", "sell", 4, 120, sellAt),
      fill("buy", "buy", 2, 120, buyAt),
      {
        id: "fee",
        activity_type: "FEE",
        order_id: "sell",
        status: "executed",
        currency: "USD",
        qty: "0",
        net_amount: "-3",
        transaction_time: sellAt,
      },
    ],
    receipts: [receipt("sell", "sell", 4, 120, sellAt), receipt("buy", "buy", 2, 120, buyAt)],
    decisions: [
      decision("sell", "sell", "2026-10-15T05:29:00.000Z"),
      decision("buy", "buy", "2026-10-15T05:39:00.000Z"),
    ],
  };
}
it("rebases inherited partial exits, joins new entry and exit decisions, and leaves cash fees in the account residual", () => {
  const r = attributeFinancePaperEconomics(fixture());
  expect(r.cohorts.inheritedPositions).toMatchObject({
    realizedGrossPnl: 40,
    unrealizedGrossPnl: 90,
    grossPnl: 130,
  });
  expect(r.cohorts.newDecisions.grossPnl).toBe(10);
  expect(r.inheritedExitsByNewDecision.grossPnl).toBe(40);
  expect(r.attributedGrossPnl).toBe(140);
  expect(r.accountEquityChange).toBe(137);
  expect(r.unallocatedPnl).toBe(-3);
  expect(r.fees.periodConfirmedReportedCashFees).toBe(3);
  expect(r.fees.historicalReportedCashFees).toBe(3);
  expect(r.modelBill).toBeNull();
});
it.each(["foreign", "duplicate", "quantity", "late", "old_decision"])(
  "keeps %s entry lineage outside new decisions",
  (mode) => {
    const f = fixture();
    if (mode === "foreign") {
      f.receipts[1] = { ...f.receipts[1], accountId: "other" };
    }
    if (mode === "duplicate") {
      f.receipts.push({ ...f.receipts[1], receiptId: "duplicate" });
    }
    if (mode === "quantity") {
      f.receipts[1] = { ...f.receipts[1], fill: { ...f.receipts[1].fill, filledQuantity: 1 } };
    }
    if (mode === "late") {
      f.decisions[1].recordedAt = "2026-10-15T05:41:00.000Z";
    }
    if (mode === "old_decision") {
      f.decisions[1].recordedAt = "2026-10-14T20:00:00.000Z";
    }
    const r = attributeFinancePaperEconomics(f);
    expect(r.cohorts.newDecisions.grossPnl).toBe(0);
    expect(r.cohorts.unlinkedPostAnchorEntries.grossPnl).toBe(10);
    expect(r.issues).toContain("post_anchor_entry_decision_unverified");
  },
);
it("does not invent missing opening or closing valuation or absorb corporate-action quantity gaps", () => {
  const f = fixture();
  f.opening.positions = [];
  const r = attributeFinancePaperEconomics(f);
  expect(r.issues).toContain("fifo_position_quantity_mismatch:SPY");
  expect(r.evidence.every((e) => e.grossPnl === null)).toBe(true);
  expect(r.cohorts.inheritedPositions.grossPnl).toBeNull();
  expect(r.unallocatedPnl).toBe(137);
});
it("deduplicates actual fee activities and keeps date-only timing, noncash valuation and final bill distinct", () => {
  const f = fixture();
  const fees: Record<string, unknown>[] = [
    ...f.activities,
    f.activities[3],
    {
      id: "day",
      activity_type: "FEE",
      status: "executed",
      currency: "USD",
      net_amount: "-1",
      date: "2026-10-15",
    },
    {
      id: "asset",
      activity_type: "CFEE",
      status: "executed",
      currency: "USD",
      symbol: "BTC/USD",
      qty: "-0.002",
      price: "100",
      net_amount: "0",
      date: "2026-10-14",
    },
  ];
  const r = attributeFinancePaperEconomics({ ...f, activities: fees });
  expect(r.fees.historicalReportedCashFees).toBe(4);
  expect(r.fees.periodConfirmedReportedCashFees).toBe(3);
  expect(r.fees.periodTimeAmbiguousActivityIds).toEqual(["day"]);
  expect(r.fees.historicalAssetFeeValuation?.usdValue).toBeCloseTo(0.2);
  expect(r.fees.feeEvidence).toHaveLength(3);
  expect(r.fees.pendingFeesCompleteness).toContain("unknown");
});
it("rejects conflicting activities, account/anchor mismatches and future fills", () => {
  const f = fixture();
  expect(() => attributeFinancePaperEconomics({ ...f, accountId: "other" })).toThrow("mismatch");
  expect(() =>
    attributeFinancePaperEconomics({ ...f, anchor: { ...f.anchor, equity: 1 } }),
  ).toThrow("mismatch");
  expect(() =>
    attributeFinancePaperEconomics({
      ...f,
      activities: [...f.activities, { ...f.activities[0], price: "999" }],
    }),
  ).toThrow("conflicting");
  expect(() =>
    attributeFinancePaperEconomics({
      ...f,
      activities: [...f.activities, fill("future", "buy", 1, 100, "2026-10-15T07:00:00.000Z")],
    }),
  ).toThrow("outside");
});
it("separates realized and still-open gains of a verified new entry after the inherited position closes", () => {
  const f = fixture();
  f.activities[1] = fill("sell", "sell", 10, 120, "2026-10-15T05:30:00.000Z");
  f.receipts[0] = receipt("sell", "sell", 10, 120, "2026-10-15T05:30:00.000Z");
  f.activities.push(fill("new-exit", "sell", 1, 130, "2026-10-15T05:50:00.000Z"));
  f.closing = snapshot(through, 2112, 1, 125);
  const r = attributeFinancePaperEconomics(f);
  expect(r.cohorts.inheritedPositions.grossPnl).toBe(100);
  expect(r.cohorts.newDecisions).toMatchObject({
    realizedGrossPnl: 10,
    unrealizedGrossPnl: 5,
    grossPnl: 15,
  });
  expect(r.unallocatedPnl).toBe(-3);
});
it("excludes pre-anchor FIFO residuals only for reconciled flat endpoints without window fills", () => {
  const f = fixture();
  const oldDust = {
    ...fill("dust", "buy", 0.000001, 100, "2026-09-20T10:00:00.000Z"),
    symbol: "BTC/USD",
  };
  const r = attributeFinancePaperEconomics({ ...f, activities: [...f.activities, oldDust] });
  expect(r.preAnchorFifoResiduals.symbols).toEqual(["BTC/USD"]);
  expect(r.attributedGrossPnl).toBe(140);
  expect(r.status).toBe("gross_price_contributions_attributed");
  const post = { ...oldDust, transaction_time: "2026-10-15T05:40:00.000Z" };
  const invalid = attributeFinancePaperEconomics({ ...f, activities: [...f.activities, post] });
  expect(invalid.preAnchorFifoResiduals.symbols).toEqual([]);
  expect(invalid.unresolvedPositionSymbols).toContain("BTC/USD");
});
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
it("reads exact hash-bound snapshots and cutoff from the original ledger without new trades", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "economic-attribution-"));
  dirs.push(dir);
  const f = fixture();
  async function append(query: string, payload: Record<string, unknown>[]) {
    return appendFinanceBrokerHistory(dir, {
      kind: "broker_history",
      accountId: "paper",
      venue: "alpaca:paper",
      query,
      cursor: "",
      payload,
    });
  }
  await append("activities:initial", [f.activities[0]]);
  const opening = await append(`reconciliation:${from}`, [f.opening]);
  const close = snapshot(through, 2050, 10, 115);
  await append(`reconciliation:${through}`, [close]);
  await append("reconciliation:future", [snapshot("2026-10-15T07:00:00.000Z", 9999, 10, 999)]);
  const r = await readFinancePaperEconomicAttribution(
    dir,
    "paper",
    { ...f.anchor, ref: opening.record.ref },
    through,
  );
  expect(r).toMatchObject({ through, attributedGrossPnl: 50, unallocatedPnl: 0 });
  expect(
    await readFinancePaperEconomicAttribution(
      dir,
      "other",
      { ...f.anchor, ref: opening.record.ref },
      through,
    ),
  ).toHaveProperty("status", "unavailable");
});
