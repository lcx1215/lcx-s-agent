import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "./finance-execution-adapter.js";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { buildFinanceNightReviewEvidence } from "./finance-night-review-context.js";
import {
  appendFinanceBrokerHistory,
  appendFinanceExecutionReceipt,
} from "./finance-position-ledger.js";
import { buildQualityHarnessModelPrompt } from "./local-text-model-adapter.js";

describe("finance night review context", () => {
  it("projects settlement and durable intraday refusals into bounded evidence", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-context-"));
    try {
      const decision = await appendFinanceIntradayDecision(directory, {
        signalId: "signal-1",
        instrument: "SPY",
        sessionDate: "2026-09-22",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-22T15:00:00.000Z",
        stopPrice: 495,
        targetPrice: 510,
        datasetHeadRef: "a".repeat(64),
        strategyRule: "opening_range_breakout_long_next_bar_v1",
      });
      await appendFinanceIntradayOutcome(directory, {
        signalId: decision.record.input.signalId,
        status: "refused",
        reasons: ["risk_gate_blocked"],
      });
      await appendFinanceExecutionReceipt(directory, {
        schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
        receiptId: "fill-1",
        intentId: "intent-1",
        runAuthorizationId: "paper-run",
        adapterId: "paper",
        adapterKind: "paper",
        venue: "paper",
        instrument: "SPY",
        side: "buy",
        orderType: "market",
        quantity: 2,
        referencePrice: 500,
        referencePriceAt: "2026-09-22T15:00:00.000Z",
        notional: 1000,
        fill: {
          filledQuantity: 1,
          fillPrice: 501,
          filledAt: "2026-09-22T15:00:01.000Z",
          venueRef: "paper",
        },
        executionAuthority: "declared_execution_adapter_required",
        recordedAt: "2026-09-22T15:00:02.000Z",
      });
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "test-account",
        venue: "alpaca:paper",
        query: "activities:window",
        cursor: "",
        payload: [
          {
            id: "broker-fill",
            activity_type: "FILL",
            type: "fill",
            symbol: "SPY",
            side: "buy",
            qty: "1",
            price: "502",
            transaction_time: "2026-09-22T15:00:01.000Z",
          },
        ],
      });
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "test-account",
        venue: "alpaca:paper",
        query: "reconciliation:window",
        cursor: "",
        payload: [
          { observedAt: "2026-09-22T21:59:00.000Z", status: "reconciled", feesInterpreted: true },
        ],
      });
      const evidence = await buildFinanceNightReviewEvidence({
        directory,
        asOf: "2026-09-22T22:00:00.000Z",
        etDate: "2026-09-22",
        settlement: {
          scoredFiled: { appended: 1, skipped: 0 },
          reflection: { lesson: "retain uncertainty" },
          pending: [],
          declined: [],
          issues: [],
        },
      });
      expect(evidence.map((item) => item.source)).toEqual([
        "finance-night-settlement",
        "finance-broker-profit-summary",
        "finance-position-ledger",
        "finance-strategy-rule-ledger",
        "finance-intraday-control-ledger",
      ]);
      expect(evidence[4].text).toContain("risk_gate_blocked");
      const review = JSON.parse(evidence[0].text).profitReview;
      expect(review.questions).toHaveLength(5);
      expect(review.boundaries.join(" ")).toContain("do not invent missed profits");
      const portfolio = JSON.parse(evidence[2].text);
      expect(portfolio.costsReconciled).toBe(false);
      // Exercise the real model prompt compactor, including a noisy portfolio entry.
      const prompt = buildQualityHarnessModelPrompt({
        schemaVersion: 1,
        runId: "night",
        attempt: 1,
        stage: "adversarial",
        agentId: "adversarial_challenge",
        task: "review profit",
        evidence: evidence.map((item) =>
          item.source === "finance-position-ledger" ? { ...item, text: "x".repeat(5000) } : item,
        ),
        sharedContext: {},
        repairFeedback: [],
        instructions: "review",
        dependencyOutputs: {},
      });
      expect(prompt).toContain('"netMatchedPnl":null');
      expect(prompt).toContain('"sellFills":0');
      expect(prompt).toContain('"unattributedFillCount":1');
      expect(evidence[1].text.length).toBeLessThan(2000);
      expect(portfolio.brokerProfit.accounts[0]).toMatchObject({
        buyFills: 1,
        sellFills: 0,
        status: "no_closed_matches",
        netMatchedPnl: null,
      });
      expect(JSON.stringify(portfolio.brokerProfit)).not.toContain("test-account");
      expect(portfolio.dayReceipts[0]).toMatchObject({
        quantity: 2,
        referencePrice: 500,
        fill: { filledQuantity: 1, fillPrice: 501 },
      });
      expect(evidence[0].text).toContain('"appended":1');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
