import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendFinanceBars } from "./finance-bar-ledger.js";
import {
  annualisedVol,
  FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES,
} from "./finance-daily-strategy.js";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "./finance-execution-adapter.js";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import {
  buildFinanceActiveStrategyResearchEvidence,
  buildFinanceNightReviewEvidence,
  readFinanceNightReviewResearchScope,
  readFinanceActiveStrategyResearchScope,
} from "./finance-night-review-context.js";
import {
  appendFinanceBrokerHistory,
  appendFinanceExecutionReceipt,
} from "./finance-position-ledger.js";
import {
  declareFinanceStrategyRule,
  activateFinanceStrategyRule,
} from "./finance-strategy-rule-ledger.js";
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
      await appendFinanceExecutionReceipt(directory, {
        schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
        receiptId: "daily-cycle-fill",
        intentId: "intent:daily-cycle:2026-09-22:SPY",
        decisionRef: {
          source: "daily_cycle_candidate",
          id: "paper-run:2026-09-22:SPY:buy",
        },
        runAuthorizationId: "daily-paper-run",
        adapterId: "alpaca-paper",
        adapterKind: "venue",
        venue: "alpaca:paper",
        accountId: "test-account",
        instrument: "SPY",
        side: "buy",
        orderType: "market",
        quantity: 1,
        referencePrice: 500,
        referencePriceAt: "2026-09-22T15:00:00.000Z",
        notional: 500,
        fill: {
          filledQuantity: 1,
          fillPrice: 502,
          filledAt: "2026-09-22T15:00:01.000Z",
          venueRef: "alpaca:paper:broker-order",
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
            order_id: "broker-order",
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
        includeResearchScope: true,
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
        "finance-night-research-scope",
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
      expect(prompt).toContain("account_totals_not_instrument_or_strategy_totals");
      expect(prompt).toContain("do not assign account fill counts or fees");
      expect(prompt).toContain('"netMatchedPnl":null');
      expect(prompt).toContain('"sellFills":0');
      expect(prompt).toContain('"unattributedFillCount":1');
      expect(evidence[1].text.length).toBeLessThan(2000);
      expect(JSON.parse(evidence[1].text).accounts[0].decisionSourceLineage).toMatchObject({
        dailyCycleCandidateFillCount: 1,
        unknownOrAmbiguousSourceFillCount: 0,
        boundary:
          "decision_source_receipt_lineage_only_not_research_alpha_execution_alpha_or_strategy_pnl",
      });
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
      expect(JSON.parse(evidence[5].text)).toMatchObject({
        schemaVersion: "lcx_finance_night_research_scope_v1",
        asOf: "2026-09-22T22:00:00.000Z",
        activeStrategyIds: [],
        instruments: [
          {
            instrument: "SPY",
            assetClass: "us_equity",
            reasons: ["held_position"],
          },
        ],
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

it("keeps compact research references in night review and preserves legacy receipts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-lineage-"));
  try {
    const baseReceipt = {
      schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
      intentId: "intent-1",
      runAuthorizationId: "paper-run",
      adapterId: "paper",
      adapterKind: "paper" as const,
      venue: "paper",
      instrument: "SPY",
      side: "buy" as const,
      orderType: "market" as const,
      quantity: 1,
      referencePrice: 500,
      referencePriceAt: "2026-09-22T15:00:00.000Z",
      notional: 500,
      executionAuthority: "declared_execution_adapter_required" as const,
      fill: {
        filledQuantity: 1,
        fillPrice: 501,
        filledAt: "2026-09-22T15:00:01.000Z",
        venueRef: "paper",
      },
      recordedAt: "2026-09-22T15:00:02.000Z",
    };
    await appendFinanceExecutionReceipt(directory, {
      ...baseReceipt,
      receiptId: "fill-with-research",
      researchLineage: {
        portfolioPlan: {
          asOf: "2026-09-22T14:59:00.000Z",
          validUntil: "2026-09-23T00:00:00.000Z",
          accountId: "test-account",
          venue: "paper",
          provenance: {
            kind: "finance_research_allocation",
            receiptId: "research-plan-1",
            evidenceIds: ["source:spy"],
          },
        },
        targetWeight: 0.25,
        contributions: [
          {
            strategyId: "spy-intraday",
            evidenceReceiptId: "candidate:spy-1",
            stance: "accumulate",
            sleeveWeight: 0.25,
            accountWeight: 0.25,
            evidenceIds: ["source:spy"],
          },
        ],
      },
    });
    await appendFinanceExecutionReceipt(directory, {
      ...baseReceipt,
      receiptId: "legacy-fill",
      intentId: "legacy-intent",
    });

    const evidence = await buildFinanceNightReviewEvidence({
      directory,
      asOf: "2026-09-22T22:00:00.000Z",
      etDate: "2026-09-22",
      settlement: {
        scoredFiled: { appended: 0, skipped: 0 },
        reflection: null,
        pending: [],
        declined: [],
        issues: [],
      },
    });
    const portfolio = JSON.parse(
      evidence.find((item) => item.source === "finance-position-ledger")!.text,
    ) as {
      dayReceipts: { receiptId: string; researchLineageSummary?: unknown }[];
    };
    const researchedReceipt = portfolio.dayReceipts.find(
      (receipt) => receipt.receiptId === "fill-with-research",
    );
    expect(researchedReceipt?.researchLineageSummary).toEqual({
      planReceiptId: "research-plan-1",
      planAsOf: "2026-09-22T14:59:00.000Z",
      targetWeight: 0.25,
      contributions: [
        {
          strategyId: "spy-intraday",
          evidenceReceiptId: "candidate:spy-1",
          stance: "accumulate",
          accountWeight: 0.25,
        },
      ],
    });
    expect(portfolio.dayReceipts.some((receipt) => receipt.receiptId === "legacy-fill")).toBe(true);
    expect(
      portfolio.dayReceipts.some(
        (receipt) =>
          receipt.receiptId === "legacy-fill" && Object.hasOwn(receipt, "researchLineageSummary"),
      ),
    ).toBe(false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("supplies actual active rule bodies and historical closes from the controller book", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-day-context-"));
  try {
    const body = {
      frozenRule: { lookbackMonths: 12, signal: "month-end total return" },
      openRisks: ["caps未声明; readiness threshold未声明"],
    };
    const declaration = await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "trend",
      form: "trend",
      instruments: ["AAA"],
      emits: "weights",
      schedule: { kind: "monthly" },
      body,
      observedAt: "2026-09-01T00:00:00Z",
    });
    const researchAsOf = new Date(Date.parse(declaration.record.recordedAt) + 1_000).toISOString();
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "trend",
      reason: "paper test",
      observedAt: "2026-09-02T00:00:00Z",
    });
    await appendFinanceBars(directory, {
      instrument: "AAA",
      derivation: "ohlcv",
      provenance: { origin: "fixture" },
      observedAt: "2026-09-03T00:00:00Z",
      bars: [{ date: "2026-09-02", open: 100, high: 102, low: 99, close: 101 }],
    });
    await appendFinanceBars(directory, {
      instrument: "AAA",
      derivation: "ohlcv",
      provenance: { origin: "contrary-fixture" },
      observedAt: "2026-09-04T00:00:00Z",
      bars: [{ date: "2026-09-02", open: 100, high: 103, low: 99, close: 102 }],
    });
    await appendFinanceBars(directory, {
      instrument: "AAA",
      derivation: "ohlcv",
      provenance: { origin: "same-close-different-ohlc" },
      observedAt: "2026-09-04T01:00:00Z",
      bars: [{ date: "2026-09-02", open: 100, high: 104, low: 98, close: 101 }],
    });
    const evidence = await buildFinanceActiveStrategyResearchEvidence({
      directory,
      asOf: researchAsOf,
    });
    expect(JSON.parse(evidence[0].text).activeRules[0]).toMatchObject({
      ruleId: "trend",
      declaredAt: declaration.record.recordedAt,
      body,
      declarationClaimBoundary:
        "body (including openRisks) contains owner claims as of declaredAt; it is not current runtime policy or readiness",
      currentRuntimePolicyAndReadiness: "unknown_without_separately_timestamped_current_evidence",
    });
    const nightEvidence = await buildFinanceNightReviewEvidence({
      directory,
      asOf: researchAsOf,
      etDate: "2026-09-04",
      settlement: {
        scoredFiled: { appended: 0, skipped: 0 },
        reflection: null,
        pending: [],
        declined: [],
        issues: [],
      },
    });
    const nightRules = JSON.parse(
      nightEvidence.find((item) => item.source === "finance-strategy-rule-ledger")!.text,
    );
    expect(nightRules.activeRules[0]).toMatchObject({
      declaredAt: declaration.record.recordedAt,
      body,
      declarationClaimBoundary:
        "body (including openRisks) contains owner claims as of declaredAt; it is not current runtime policy or readiness",
      currentRuntimePolicyAndReadiness: "unknown_without_separately_timestamped_current_evidence",
    });
    expect(nightRules.activeRules[0].declaredAt).not.toBe(researchAsOf);
    const history = JSON.parse(evidence[1].text);
    expect(history.suppliedBarCount).toBe(2);
    expect(history.rawBarCount).toBe(3);
    expect(history.collapsedRepeatedCloses).toBe(1);
    expect(history.divergentDates).toEqual(["AAA@2026-09-02"]);
    expect(history.monthlyCloseObservations).toEqual([
      { month: "2026-09", sessionDate: "2026-09-02", closeValues: [101, 102] },
    ]);
    expect(history.divergentCloseObservations).toEqual([
      { sessionDate: "2026-09-02", closeValues: [101, 102] },
    ]);
    const before = await buildFinanceActiveStrategyResearchEvidence({
      directory,
      asOf: "2026-09-01T12:00:00Z",
    });
    expect(JSON.parse(before[0].text).activeRules).toEqual([]);
    expect(before).toHaveLength(1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("limits portfolio research scope to the exact active strategy ids", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-strategy-scope-"));
  try {
    for (const [ruleId, instrument] of [
      ["trend", "SPY"],
      ["mean", "QQQ"],
    ] as const) {
      await declareFinanceStrategyRule(directory, {
        kind: "declared",
        ruleId,
        form: "trend",
        instruments: [instrument],
        emits: "weights",
        schedule: { kind: ruleId === "mean" ? "intraday" : "daily" },
        body: { frozenRule: { lookbackMonths: 6 } },
        observedAt: "2026-09-01T00:00:00Z",
      });
      await activateFinanceStrategyRule(directory, {
        kind: "activated",
        ruleId,
        reason: "paper test",
        observedAt: "2026-09-02T00:00:00Z",
      });
    }
    const scope = await readFinanceActiveStrategyResearchScope({
      directory,
      asOf: "2026-09-05T00:00:00Z",
      strategyIds: ["mean"],
    });
    expect(scope.instruments).toEqual(["QQQ"]);
    expect(scope.intradayInstruments).toEqual(["QQQ"]);
    expect(scope.historyMonths).toBe(12);
    expect(
      JSON.parse(scope.evidence[0].text).activeRules.map((rule: { ruleId: string }) => rule.ruleId),
    ).toEqual(["mean"]);
    await expect(
      readFinanceActiveStrategyResearchScope({
        directory,
        asOf: "2026-09-05T00:00:00Z",
        strategyIds: ["retired-or-unknown"],
      }),
    ).rejects.toThrow("not active in the controller ledger");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("preserves numerical inputs while compressing controller history for model context", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-controller-history-"));
  try {
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "trend",
      form: "cross_asset_trend",
      formVersion: "1",
      instruments: ["SPY"],
      emits: "target_weights",
      schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
      body: { frozenRule: { lookbackMonths: 12 } },
      observedAt: "2026-09-01T00:00:00Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "trend",
      reason: "paper test",
      observedAt: "2026-09-02T00:00:00Z",
    });
    const bars = Array.from({ length: 365 }, (_, index) => {
      const date = new Date(Date.UTC(2025, 8, 1 + index)).toISOString().slice(0, 10);
      const close = 100 + index;
      return { date, open: close, high: close, low: close, close };
    });
    await appendFinanceBars(directory, {
      instrument: "SPY",
      derivation: "ohlcv",
      provenance: { origin: "controller-history-fixture" },
      observedAt: "2026-09-04T20:00:00Z",
      bars,
    });
    const evidence = await buildFinanceActiveStrategyResearchEvidence({
      directory,
      asOf: "2026-09-05T12:00:00.000Z",
      strategyIds: ["trend"],
    });
    const history = JSON.parse(
      evidence.find((item) => item.id === "finance-controller:eod:SPY")!.text,
    );

    expect(history.rawBarCount).toBe(365);
    expect(history.monthlyCloseObservations).toHaveLength(12);
    expect(history.monthlyCloseObservations.at(-1)).toMatchObject({
      month: "2026-08",
      sessionDate: "2026-08-31",
      closeValues: [464],
    });
    expect(history).not.toHaveProperty("closes");
    expect(
      Buffer.byteLength(evidence.find((item) => item.id === "finance-controller:eod:SPY")!.text),
    ).toBeLessThan(4_000);
    const volatility = evidence.find(
      (item) => item.id === "finance-derived:annualised-volatility:trend:SPY",
    );
    expect(volatility?.text).toContain(
      `annualisedVol=${annualisedVol(
        bars.slice(-FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES).map((bar) => bar.close),
      ).toFixed(8)}`,
    );
    expect(volatility?.text).toContain(
      "raw evidence IDs=finance-controller:active-strategies,finance-controller:eod:SPY",
    );

    await appendFinanceBars(directory, {
      instrument: "SPY",
      derivation: "ohlcv",
      provenance: { origin: "contrary-controller-history-fixture" },
      observedAt: "2026-09-04T21:00:00.000Z",
      bars: [{ date: "2026-08-31", open: 465, high: 465, low: 465, close: 465 }],
    });
    const conflicting = await buildFinanceActiveStrategyResearchEvidence({
      directory,
      asOf: "2026-09-05T12:00:00.000Z",
      strategyIds: ["trend"],
    });
    expect(conflicting.some((item) => item.id.startsWith("finance-derived:"))).toBe(false);
    expect(
      JSON.parse(conflicting.find((item) => item.id === "finance-controller:eod:SPY")!.text)
        .divergentDates,
    ).toEqual(["SPY@2026-08-31"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("retains the prior calendar-month anchor through the controller-to-research handoff", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-controller-anchor-"));
  try {
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "trend",
      form: "cross_asset_trend",
      formVersion: "1",
      instruments: ["SPY"],
      emits: "target_weights",
      schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
      body: { frozenRule: { lookbackMonths: 12 } },
      observedAt: "2025-09-01T00:00:00.000Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "trend",
      reason: "paper test",
      observedAt: "2025-09-02T00:00:00.000Z",
    });
    await appendFinanceBars(directory, {
      instrument: "SPY",
      derivation: "ohlcv",
      provenance: { origin: "controller-month-anchor-fixture" },
      observedAt: "2026-09-29T20:00:00.000Z",
      bars: [
        { date: "2025-08-29", open: 100, high: 100, low: 100, close: 100 },
        { date: "2026-08-31", open: 110, high: 110, low: 110, close: 110 },
        { date: "2026-09-29", open: 120, high: 120, low: 120, close: 120 },
      ],
    });
    const evidence = await buildFinanceActiveStrategyResearchEvidence({
      directory,
      asOf: "2026-09-30T07:00:00.000Z",
    });
    const history = JSON.parse(
      evidence.find((item) => item.id === "finance-controller:eod:SPY")!.text,
    );
    expect(history.fromDate).toBe("2025-08-01");
    expect(history.monthlyCloseObservations[0]).toEqual({
      month: "2025-08",
      sessionDate: "2025-08-29",
      closeValues: [100],
    });
    expect(history).not.toHaveProperty("closes");
    const derived = evidence.find(
      (item) => item.id === "finance-derived:monthly-close-change:trend:SPY",
    );
    expect(derived?.text).toContain("anchor close 110 on 2026-08-31");
    expect(derived?.text).toContain("prior close 100 on 2025-08-29");
    expect(derived?.text).toContain("formula (anchor/prior - 1) * 100 = +10.0%");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("preserves held crypto identity and unions it with active strategy instruments", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-research-scope-"));
  try {
    await appendFinanceExecutionReceipt(directory, {
      schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
      receiptId: "crypto-fill-1",
      intentId: "crypto-intent-1",
      runAuthorizationId: "paper-run",
      adapterId: "paper",
      adapterKind: "paper",
      venue: "paper",
      instrument: "BTC/USD",
      side: "buy",
      orderType: "market",
      quantity: 0.01,
      referencePrice: 60_000,
      referencePriceAt: "2026-09-02T12:00:00.000Z",
      notional: 600,
      executionAuthority: "declared_execution_adapter_required",
      recordedAt: "2026-09-02T12:00:01.000Z",
      fill: {
        filledQuantity: 0.01,
        fillPrice: 60_000,
        filledAt: "2026-09-02T12:00:01.000Z",
        venueRef: "paper",
      },
    });
    await appendFinanceExecutionReceipt(directory, {
      schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
      receiptId: "future-fill-1",
      intentId: "future-intent-1",
      runAuthorizationId: "paper-run",
      adapterId: "paper",
      adapterKind: "paper",
      venue: "paper",
      instrument: "XYZ",
      side: "buy",
      orderType: "market",
      quantity: 1,
      referencePrice: 20,
      referencePriceAt: "2026-09-04T12:00:00.000Z",
      notional: 20,
      executionAuthority: "declared_execution_adapter_required",
      recordedAt: "2026-09-04T12:00:02.000Z",
      fill: {
        filledQuantity: 1,
        fillPrice: 20,
        filledAt: "2026-09-04T12:00:01.000Z",
        venueRef: "paper",
      },
    });
    await appendFinanceExecutionReceipt(directory, {
      schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
      receiptId: "future-settlement-fill-1",
      intentId: "future-settlement-intent-1",
      runAuthorizationId: "paper-run",
      adapterId: "paper",
      adapterKind: "paper",
      venue: "paper",
      instrument: "ABC",
      side: "buy",
      orderType: "market",
      quantity: 1,
      referencePrice: 30,
      referencePriceAt: "2026-09-04T12:00:00.000Z",
      notional: 30,
      executionAuthority: "declared_execution_adapter_required",
      recordedAt: "2026-09-02T12:00:02.000Z",
      fill: {
        filledQuantity: 1,
        fillPrice: 30,
        filledAt: "2026-09-04T12:00:01.000Z",
        venueRef: "paper",
      },
    });
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "daily-trend",
      form: "trend",
      instruments: ["SPY"],
      emits: "weights",
      schedule: { kind: "daily" },
      body: { frozenRule: { lookbackMonths: 6 } },
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "daily-trend",
      reason: "paper test",
      observedAt: "2026-09-01T01:00:00.000Z",
    });
    const scope = await readFinanceNightReviewResearchScope({
      directory,
      asOf: "2026-09-03T00:00:00.000Z",
    });
    expect(scope.activeStrategyIds).toEqual(["daily-trend"]);
    expect(scope.instruments).toEqual([
      { instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] },
      { instrument: "SPY", assetClass: "us_equity", reasons: ["active_strategy"] },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("passes active close history to night research using the latest completed market session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-eod-handoff-"));
  try {
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "trend",
      form: "trend",
      instruments: ["SPY", "QQQ"],
      emits: "weights",
      schedule: { kind: "monthly_last_trading_day" },
      body: { frozenRule: { lookbackMonths: 6 } },
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "trend",
      reason: "paper test",
      observedAt: "2026-09-02T00:00:00.000Z",
    });
    for (const instrument of ["SPY", "QQQ"] as const) {
      await appendFinanceBars(directory, {
        instrument,
        derivation: "ohlcv",
        provenance: { origin: "night-eod-handoff-test" },
        observedAt: "2026-09-29T20:00:00.000Z",
        bars: [
          { date: "2026-09-28", open: 99, high: 101, low: 98, close: 100 },
          { date: "2026-09-29", open: 100, high: 102, low: 99, close: 101 },
        ],
      });
    }

    const evidence = await buildFinanceNightReviewEvidence({
      directory,
      asOf: "2026-09-29T21:30:00.000Z",
      etDate: "2026-09-29",
      includeResearchScope: true,
      settlement: {
        scoredFiled: { appended: 0, skipped: 0 },
        reflection: null,
        pending: [],
        declined: [],
        issues: [],
      },
    });
    const history = evidence.filter((item) => item.id.startsWith("finance-controller:eod:"));

    expect(history).toHaveLength(2);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "finance-controller:eod:SPY",
          source: "finance-bar-ledger",
          timestamp: "2026-09-29T21:30:00.000Z",
          text: expect.stringContaining('"sessionDate":"2026-09-29","closeValues":[101]'),
        }),
        expect.objectContaining({
          id: "finance-controller:eod:QQQ",
          source: "finance-bar-ledger",
        }),
      ]),
    );
    expect(evidence).toHaveLength(8);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
