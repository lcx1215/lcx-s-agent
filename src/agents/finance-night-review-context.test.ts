import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendFinanceBars } from "./finance-bar-ledger.js";
import { readFinanceBrokerReconciliation } from "./finance-broker-reconciliation.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  annualisedVol,
  FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES,
} from "./finance-daily-strategy.js";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "./finance-execution-adapter.js";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
  type FinanceIntradayOutcomeRecord,
} from "./finance-intraday-control-ledger.js";
import {
  buildFinanceActiveStrategyResearchEvidence,
  buildFinanceBrokerAccountResearchEvidence,
  buildFinanceNightReviewEvidence,
  summarizeFinanceNightIntradayEvidence,
  readFinanceNightReviewResearchScope,
  readFinanceActiveStrategyResearchScope,
} from "./finance-night-review-context.js";
import {
  appendFinanceBrokerHistory,
  appendFinanceExecutionReceipt,
  readFinanceLatestBrokerReconciliations,
} from "./finance-position-ledger.js";
import {
  declareFinanceStrategyRule,
  activateFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
} from "./finance-strategy-rule-ledger.js";
import { buildQualityHarnessModelPrompt } from "./local-text-model-adapter.js";
import { QUALITY_HARNESS_MAX_EVIDENCE_TEXT_LENGTH } from "./quality-harness-contract.js";

describe("finance night review context", () => {
  it("projects settlement and durable intraday refusals into bounded evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
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
        accountId: "future-account",
        venue: "alpaca:paper",
        query: "reconciliation:future",
        cursor: "",
        payload: [
          {
            observedAt: "2026-09-22T22:00:01.000Z",
            positions: [{ symbol: "SECRET-FUTURE", qty: "999" }],
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
          {
            observedAt: "2026-09-22T21:59:00.000Z",
            status: "reconciled",
            feesInterpreted: true,
            positions: [{ symbol: "SPY", qty: "1" }],
            protection: {
              coverage: [
                {
                  instrument: "SPY",
                  positionQuantity: 1,
                  recognizedStopQuantity: 1,
                  uncoveredQuantity: 0,
                  status: "covered",
                },
              ],
            },
          },
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
      expect(
        evidence.reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0),
      ).toBeLessThanOrEqual(250_000);
      expect(JSON.parse(evidence[4].text).coverage).toMatchObject({
        totalDecisionCount: 1,
        includedDecisionCount: 1,
        omittedDecisionCount: 0,
      });
      const review = JSON.parse(evidence[0].text).profitReview;
      expect(review.questions).toHaveLength(8);
      expect(review.questions).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Use accountPerformance"),
          expect.stringContaining("Use methodPerformance"),
        ]),
      );
      expect(review.boundaries.join(" ")).toContain("do not invent missed profits");
      const portfolio = JSON.parse(evidence[2].text);
      expect(portfolio.costsReconciled).toBe(false);
      expect(portfolio).toMatchObject({
        positionMeaning:
          "broker_account_inventory_only; see accountInventories for exact account and venue",
        paperFillCount: 1,
        venueFillCount: 1,
        positions: null,
        currentAccountInventoryStatus: "unknown",
      });
      const brokerSummary = JSON.parse(evidence[1].text);
      const sharedBrokerSummary = await buildFinanceBrokerAccountResearchEvidence({
        directory,
        asOf: "2026-09-22T22:00:00.000Z",
      });
      expect(sharedBrokerSummary.id).toBe("finance-controller:broker-account-summary");
      expect(sharedBrokerSummary.source).toBe(evidence[1].source);
      // The legacy night report retains rejected-snapshot diagnostics; the shared
      // account reader selects only sealed snapshots available at the cutoff.
      expect(JSON.parse(sharedBrokerSummary.text)).toMatchObject({
        ...brokerSummary,
        accountPerformance: [{ status: "unavailable", reason: "no_account_economic_observation" }],
        accounts: brokerSummary.accounts.filter(
          (account: { status: string }) => account.status !== "snapshot_outside_cutoff",
        ),
        positionSnapshots: brokerSummary.positionSnapshots.filter(
          (snapshot: { accountId: string }) => snapshot.accountId !== "future-account",
        ),
      });
      expect(brokerSummary.accountPerformance).toHaveLength(2);
      expect(sharedBrokerSummary.text).not.toContain("future-account");
      expect(brokerSummary).not.toHaveProperty("executionAuthority");
      expect(brokerSummary.positionSnapshots[0]).not.toHaveProperty("brokerCash");
      expect(brokerSummary.positionSnapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: "test-account",
            venue: "alpaca:paper",
            positions: [{ symbol: "SPY", quantity: 1 }],
            protectionCoverage: [expect.objectContaining({ status: "covered" })],
          }),
          expect.objectContaining({ accountId: "future-account", freshness: "outside_cutoff" }),
        ]),
      );
      expect(JSON.stringify(brokerSummary.positionSnapshots)).not.toContain("SECRET-FUTURE");
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
        accountId: "test-account",
        venue: "alpaca:paper",
        buyFills: 1,
        sellFills: 0,
        status: "no_closed_matches",
        netMatchedPnl: null,
      });
      expect(portfolio.brokerProfit.executionAuthority).toBe("none");
      expect(portfolio.brokerProfit.accounts[1]).toMatchObject({
        accountId: "future-account",
        status: "snapshot_outside_cutoff",
      });
      expect(JSON.stringify(portfolio.brokerProfit)).not.toContain("SECRET-FUTURE");
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
      vi.useRealTimers();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds a large intraday history while retaining full-session counts and recent decisions", () => {
    const oversizedReview = {
      status: "completed",
      attempted: true,
      provider: "test-provider",
      modelId: "test-model",
      latencyMs: 12,
      providerCallObserved: true,
      adapterAttested: true,
      request: { repeatedAccountContext: "private-request-marker".repeat(400) },
      decision: {
        candidateId: "candidate-1",
        decision: "approve",
        rationale: "R".repeat(1_000),
      },
    } as unknown as NonNullable<FinanceIntradayOutcomeRecord["tradeDecisionReview"]>;
    const decisions = Array.from({ length: 337 }, (_, index) => ({
      recordedAt: `2026-10-01T${String(13 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
      signalId: `signal-${index}`,
      instrument: index % 2 === 0 ? "SPY" : "QQQ",
      action: "buy",
      reason: "opening_range_breakout",
      referencePrice: 500,
      referencePriceAt: "2026-10-01T14:00:00.000Z",
      outcome: {
        signalId: `signal-${index}`,
        status: "refused",
        reasons: ["risk_gate_blocked"],
        tradeDecisionReview: oversizedReview,
      } as unknown as FinanceIntradayOutcomeRecord,
    }));

    const text = summarizeFinanceNightIntradayEvidence(
      { asOf: "2026-10-01T21:38:58.214Z", sessionDate: "2026-10-01", decisions },
      150_000,
    );
    const summary = JSON.parse(text);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(150_000);
    expect(summary.coverage).toMatchObject({
      totalDecisionCount: 337,
      includedDecisionCount: 100,
      omittedDecisionCount: 237,
    });
    expect(summary.distributions.byInstrument.values).toEqual([
      { value: "SPY", count: 169 },
      { value: "QQQ", count: 168 },
    ]);
    expect(summary.decisions[0].outcome.tradeDecisionReview.decision.rationale).toBe(
      `${"R".repeat(240)}…`,
    );
    expect(text).not.toContain("private-request-marker");
    expect(summary.decisions[0].outcome.tradeDecisionReview).not.toHaveProperty("toolEvidence");
    expect(summary.decisions[0].outcome.tradeDecisionReview).not.toHaveProperty(
      "modelCallEvidence",
    );
  });

  it.each(["R", "风险"])(
    "keeps night packet intraday JSON within the quality input limit with %s text",
    async (rationaleText) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-01T22:00:00.000Z"));
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-quality-budget-"));
      try {
        for (let index = 0; index < 315; index++) {
          await appendFinanceIntradayDecision(directory, {
            signalId: `signal-${index}`,
            instrument: index % 2 === 0 ? "SPY" : "QQQ",
            sessionDate: "2026-10-01",
            action: "buy",
            reason: "opening_range_breakout",
            referencePrice: 500,
            referencePriceAt: "2026-10-01T14:00:00.000Z",
            stopPrice: 495,
            targetPrice: 510,
            datasetHeadRef: "a".repeat(64),
            strategyRule: "opening_range_breakout_long_next_bar_v1",
          });
          await appendFinanceIntradayOutcome(directory, {
            signalId: `signal-${index}`,
            status: "refused",
            reasons: ["risk_gate_blocked"],
            tradeDecisionReview: {
              status: "completed",
              attempted: true,
              provider: "test-provider",
              modelId: "test-model",
              latencyMs: 12,
              providerCallObserved: true,
              adapterAttested: true,
              modelCalls: 2,
              toolEvidence: [
                {
                  action: "max_drawdown",
                  candidateId: `candidate-${index}`,
                  accountId: "private-tool-account-marker",
                  asOf: "2026-10-01T22:00:00.000Z",
                  status: "completed",
                  sourceRef: "a".repeat(64),
                  requestSha256: "b".repeat(64),
                  resultSha256: "c".repeat(64),
                  summary: JSON.stringify({
                    result: { maxDrawdown: -0.183, note: rationaleText.repeat(180) },
                  }),
                  boundary: "recorded_daily_history_research_only_no_execution_or_fresh_quote",
                },
              ],
              modelCallEvidence: [
                {
                  attempt: 1,
                  callId: "fixture-first",
                  payloadSha256: "d".repeat(64),
                  outputSha256: "e".repeat(64),
                  resultKind: "evidence_request",
                  attestation: { status: "unattested" },
                  evidenceRequests: [{ action: "max_drawdown", candidateId: `candidate-${index}` }],
                  hypothesis: rationaleText.repeat(30),
                },
                {
                  attempt: 2,
                  callId: "fixture-second",
                  payloadSha256: "f".repeat(64),
                  outputSha256: "a".repeat(64),
                  resultKind: "decision",
                  toolEvidenceSha256: "b".repeat(64),
                  attestation: { status: "unattested" },
                },
              ],
              request: {
                schemaVersion: "lcx_finance_intraday_trade_decision_review_v1",
                venue: "alpaca:paper",
                asOf: "2026-10-01T22:00:00.000Z",
                signalAnchor: `signal-${index}`,
                ruleIds: ["opening_range_breakout_long_next_bar_v1"],
                equity: 100_000,
                caps: { maxOrderNotional: 500, maxInstrumentNotional: 1_000, maxOrdersPerRun: 1 },
                positionBookObservedAt: "2026-10-01T22:00:00.000Z",
                reconciliation: { status: "unresolved" },
                positions: [],
                candidates: [
                  {
                    candidateId: `candidate-${index}`,
                    instrument: index % 2 === 0 ? "SPY" : "QQQ",
                    side: "buy",
                    strategyRule: "opening_range_breakout_long_next_bar_v1",
                    signalReason: "opening_range_breakout",
                    signalReferencePrice: 500,
                    signalReferencePriceAt: "2026-10-01T14:00:00.000Z",
                    datasetHeadRef: "a".repeat(64),
                    intradayOwnedQuantity: 0,
                    brokerPositionQuantity: 0,
                    executionQuote: {
                      referencePrice: 500,
                      referencePriceAt: "2026-10-01T14:00:00.000Z",
                      sourceUrlOrArtifact: "fixture",
                      ageMs: 0,
                      maxAgeMs: 30_000,
                    },
                  },
                ],
              },
              decision: {
                candidateId: `candidate-${index}`,
                decision: "approve",
                rationale: rationaleText.repeat(300),
              },
            },
            executionSafetyFailure: {
              stage: "facts",
              category: "account_snapshot_unavailable",
              operation: "read_account_safety_facts",
              provider: { reason: "alpaca_safety_facts_inconsistent", stage: "account_arithmetic" },
            },
          });
        }
        const evidence = await buildFinanceNightReviewEvidence({
          directory,
          asOf: "2026-10-01T22:00:00.000Z",
          etDate: "2026-10-01",
          settlement: {
            scoredFiled: { appended: 0, skipped: 0 },
            reflection: {},
            pending: [],
            declined: [],
            issues: [],
          },
        });
        const text = evidence.find(
          (item) => item.source === "finance-intraday-control-ledger",
        )!.text;
        expect(text.length).toBeLessThanOrEqual(QUALITY_HARNESS_MAX_EVIDENCE_TEXT_LENGTH);
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
          QUALITY_HARNESS_MAX_EVIDENCE_TEXT_LENGTH,
        );
        const summary = JSON.parse(text);
        expect(summary.coverage.totalDecisionCount).toBe(315);
        expect(summary.coverage.includedDecisionCount).toBeGreaterThan(0);
        expect(summary.coverage.includedDecisionCount).toBeLessThan(100);
        expect(summary.coverage.omittedDecisionCount).toBe(315 - summary.decisions.length);
        expect(summary.decisions.at(-1).signalId).toBe("signal-314");
        const projectedReview = summary.decisions.at(-1).outcome.tradeDecisionReview;
        expect(projectedReview.toolEvidence).toHaveLength(1);
        expect(JSON.parse(projectedReview.toolEvidence[0].summary).result.maxDrawdown).toBe(-0.183);
        expect(
          projectedReview.modelCallEvidence.map((call: { resultKind: string }) => call.resultKind),
        ).toEqual(["evidence_request", "decision"]);
        expect(projectedReview.omittedToolEvidenceCount).toBe(0);
        expect(projectedReview.omittedModelCallEvidenceCount).toBe(0);
        expect(summary.coverage.recordedReviewEvidence).toEqual({
          reviewsWithToolEvidence: 315,
          completedToolEvidenceCount: 315,
          unavailableToolEvidenceCount: 0,
          reviewsWithModelCallEvidence: 315,
          modelCallEvidenceCount: 630,
        });
        expect(text).not.toContain("private-tool-account-marker");
        expect(text).not.toContain('"request":');
        expect(
          evidence.reduce((bytes, item) => bytes + Buffer.byteLength(item.text, "utf8"), 0),
        ).toBeLessThanOrEqual(250_000);
        expect(summary.decisions.at(-1).outcome.executionSafetyFailure.provider.stage).toBe(
          "account_arithmetic",
        );
        expect(summary.distributions.byInstrument.values).toEqual([
          { value: "SPY", count: 158 },
          { value: "QQQ", count: 157 },
        ]);
        expect(summary.distributions.byOutcomeStatus.values).toEqual([
          { value: "refused", count: 315 },
        ]);
        expect(evidence.some((item) => item.source === "finance-night-settlement")).toBe(true);
      } finally {
        vi.useRealTimers();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("retains recorded whole-session evidence counts when the latest sample omits the only tool review", () => {
    const tool = {
      action: "max_drawdown",
      candidateId: "candidate-proof",
      accountId: "private-account-marker",
      asOf: "2026-10-01T14:00:00.000Z",
      status: "completed" as const,
      sourceRef: "a".repeat(64),
      requestSha256: "b".repeat(64),
      resultSha256: "c".repeat(64),
      summary: '{"result":{"maxDrawdown":-0.183}}',
      boundary: "recorded_daily_history_research_only_no_execution_or_fresh_quote" as const,
    };
    const call = {
      attempt: 1 as const,
      callId: "fixture-first",
      payloadSha256: "d".repeat(64),
      resultKind: "evidence_request" as const,
      attestation: { status: "unattested" as const },
    };
    const reviewed = {
      status: "completed",
      attempted: true,
      provider: "fixture",
      modelId: "fixture",
      latencyMs: 1,
      providerCallObserved: false,
      adapterAttested: false,
      request: { repeatedAccountContext: "private-request-marker" },
      toolEvidence: [tool, { ...tool, status: "unavailable" }, tool],
      modelCallEvidence: [call, call, call],
    } as unknown as NonNullable<FinanceIntradayOutcomeRecord["tradeDecisionReview"]>;
    const first = {
      recordedAt: "2026-10-01T14:00:00.000Z",
      signalId: "signal-proof",
      instrument: "SPY",
      action: "buy",
      reason: "opening_range_breakout",
      referencePrice: 500,
      referencePriceAt: "2026-10-01T14:00:00.000Z",
      outcome: {
        signalId: "signal-proof",
        status: "refused",
        reasons: [],
        tradeDecisionReview: reviewed,
      } as unknown as FinanceIntradayOutcomeRecord,
    };
    const direct = JSON.parse(
      summarizeFinanceNightIntradayEvidence(
        {
          asOf: "2026-10-01T22:00:00.000Z",
          sessionDate: "2026-10-01",
          decisions: [first],
        },
        60_000,
      ),
    );
    expect(direct.decisions[0].outcome.tradeDecisionReview.toolEvidence).toHaveLength(2);
    expect(direct.decisions[0].outcome.tradeDecisionReview.modelCallEvidence).toHaveLength(2);
    expect(direct.decisions[0].outcome.tradeDecisionReview.omittedToolEvidenceCount).toBe(1);
    expect(direct.decisions[0].outcome.tradeDecisionReview.omittedModelCallEvidenceCount).toBe(1);
    const decisions = [
      first,
      ...Array.from({ length: 100 }, (_, index) => ({
        ...first,
        signalId: `legacy-${index}`,
        outcome: {
          signalId: `legacy-${index}`,
          status: "refused",
          reasons: [],
        } as unknown as FinanceIntradayOutcomeRecord,
      })),
    ];
    const bounded = JSON.parse(
      summarizeFinanceNightIntradayEvidence(
        {
          asOf: "2026-10-01T22:00:00.000Z",
          sessionDate: "2026-10-01",
          decisions,
        },
        60_000,
      ),
    );
    expect(bounded.coverage).toMatchObject({
      totalDecisionCount: 101,
      omittedDecisionCount: 1,
      recordedReviewEvidence: {
        reviewsWithToolEvidence: 1,
        completedToolEvidenceCount: 2,
        unavailableToolEvidenceCount: 1,
        reviewsWithModelCallEvidence: 1,
        modelCallEvidenceCount: 3,
      },
    });
    expect(
      bounded.decisions.some((item: { signalId: string }) => item.signalId === "signal-proof"),
    ).toBe(false);
    expect(JSON.stringify(direct)).not.toContain("private-account-marker");
    expect(JSON.stringify(direct)).not.toContain("private-request-marker");
  });
});

it("excludes later decisions and account diagnostics from historical night evidence", async () => {
  vi.useFakeTimers();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-asof-"));
  try {
    const settlement = {
      scoredFiled: { appended: 0, skipped: 0 },
      reflection: {},
      pending: [],
      declined: [],
      issues: [],
    };
    const readDecisions = async (asOf: string) => {
      const evidence = await buildFinanceNightReviewEvidence({
        directory,
        asOf,
        etDate: "2026-09-22",
        settlement,
      });
      return JSON.parse(
        evidence.find((item) => item.source === "finance-intraday-control-ledger")!.text,
      ).decisions as { signalId: string; outcome: unknown }[];
    };
    vi.setSystemTime(new Date("2026-09-22T21:59:00.000Z"));
    await appendFinanceIntradayDecision(directory, {
      signalId: "late-outcome",
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
    expect(await readDecisions("2026-09-22T21:58:00.000Z")).toEqual([]);
    expect(await readDecisions("2026-09-22T22:00:00.000Z")).toMatchObject([
      { signalId: "late-outcome", outcome: null },
    ]);
    vi.setSystemTime(new Date("2026-09-22T22:01:00.000Z"));
    await appendFinanceIntradayOutcome(directory, {
      signalId: "late-outcome",
      status: "refused",
      reasons: ["execution_safety_account_snapshot_unavailable"],
      executionSafetyFailure: {
        stage: "facts",
        category: "account_snapshot_unavailable",
        operation: "read_account_safety_facts",
        provider: { reason: "alpaca_safety_facts_inconsistent", stage: "account_arithmetic" },
      },
    });
    expect(await readDecisions("2026-09-22T22:00:00.000Z")).toMatchObject([
      { signalId: "late-outcome", outcome: null },
    ]);
    vi.setSystemTime(new Date("2026-09-22T22:02:00.000Z"));
    expect(await readDecisions("2026-09-22T22:02:00.000Z")).toMatchObject([
      {
        signalId: "late-outcome",
        outcome: { executionSafetyFailure: { provider: { stage: "account_arithmetic" } } },
      },
    ]);
  } finally {
    vi.useRealTimers();
    await fs.rm(directory, { recursive: true, force: true });
  }
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
    // A future stored event must not become the cutoff's projected rule head.
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "future",
      form: "trend",
      instruments: ["FUTURE"],
      emits: "weights",
      schedule: { kind: "daily" },
      body: { frozenRule: { lookbackMonths: 99 } },
      observedAt: "2026-09-06T00:00:00Z",
    });
    const scope = await readFinanceActiveStrategyResearchScope({
      directory,
      asOf: "2026-09-05T00:00:00Z",
      strategyIds: ["mean"],
    });
    const ledger = await readFinanceStrategyRuleLedger(directory, { asOf: "2026-09-05T00:00:00Z" });
    expect(scope.source).toEqual({
      directory,
      asOf: "2026-09-05T00:00:00Z",
      storedHeadRef: ledger.headRef,
      projectedHeadRef: ledger.ledger.headRef,
      storedRecordCount: 5,
      projectedRecordCount: 4,
      selectedRuleIds: ["mean"],
      selectedRulesSha256: caseflowFingerprint(JSON.parse(scope.evidence[0].text).activeRules),
    });
    expect(scope.source.storedHeadRef).not.toBe(scope.source.projectedHeadRef);
    expect(scope.evidence[0].text).not.toContain('"future"');
    expect(scope.instruments).toEqual(["QQQ"]);
    expect(scope.intradayInstruments).toEqual(["QQQ"]);
    expect(scope.historyMonths).toBe(12);
    expect(
      JSON.parse(scope.evidence[0].text).activeRules.map((rule: { ruleId: string }) => rule.ruleId),
    ).toEqual(["mean"]);
    expect(JSON.parse(scope.evidence[0].text)).toMatchObject({
      scope: "portfolio_allocation_subset",
      allControllerActiveRuleIds: ["trend", "mean"],
      allocationStrategyIds: ["mean"],
      ruleScope: expect.stringContaining("does not enumerate every active controller rule"),
    });
    const allRules = await buildFinanceActiveStrategyResearchEvidence({
      directory,
      asOf: "2026-09-05T00:00:00Z",
    });
    expect(JSON.parse(allRules[0].text)).toMatchObject({
      scope: "all_controller_active_rules",
      allControllerActiveRuleIds: ["trend", "mean"],
    });
    expect(JSON.parse(allRules[0].text)).not.toHaveProperty("allocationStrategyIds");
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

it("rotates overflow active instruments by ET date with stable same-date selection and coverage", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-scope-rotation-"));
  try {
    const instruments = Array.from(
      { length: 18 },
      (_, index) => `A${String.fromCharCode(65 + index)}`,
    );
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "wide-rule",
      form: "trend",
      instruments,
      emits: "weights",
      schedule: { kind: "daily" },
      body: { frozenRule: { lookbackMonths: 6 } },
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "wide-rule",
      reason: "scope rotation fixture",
      observedAt: "2026-09-02T00:00:00.000Z",
    });
    const asOf = "2026-09-29T21:00:00.000Z";
    const [first, repeated, nextDate] = await Promise.all([
      readFinanceNightReviewResearchScope({ directory, asOf }),
      readFinanceNightReviewResearchScope({ directory, asOf }),
      readFinanceNightReviewResearchScope({
        directory,
        asOf: "2026-09-30T21:00:00.000Z",
      }),
    ]);
    expect(first).toEqual(repeated);
    expect(first.instruments).toHaveLength(14);
    expect(first.coverage).toMatchObject({
      totalInstrumentCount: 18,
      selectionMethod: "held_priority_et_date_rotation_v1",
    });
    expect(first.coverage?.deferredInstruments).toHaveLength(4);
    expect(new Set(first.instruments.map((item) => item.instrument))).not.toEqual(
      new Set(nextDate.instruments.map((item) => item.instrument)),
    );
    expect(
      new Set([...first.instruments, ...nextDate.instruments].map((item) => item.instrument)).size,
    ).toBe(18);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("prioritizes held local projections and rotates held overflow when it alone exceeds the cap", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-held-rotation-"));
  try {
    for (let index = 0; index < 17; index += 1) {
      const instrument = `B${String.fromCharCode(65 + index)}`;
      await appendFinanceExecutionReceipt(directory, {
        schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
        receiptId: `held-${index}`,
        intentId: `held-intent-${index}`,
        runAuthorizationId: "paper-run",
        adapterId: "paper",
        adapterKind: "paper",
        venue: "paper",
        instrument,
        side: "buy",
        orderType: "market",
        quantity: 1,
        referencePrice: 10,
        referencePriceAt: "2026-09-29T20:00:00.000Z",
        notional: 10,
        executionAuthority: "declared_execution_adapter_required",
        recordedAt: `2026-09-29T20:00:${String(index).padStart(2, "0")}.000Z`,
        fill: {
          filledQuantity: 1,
          fillPrice: 10,
          filledAt: `2026-09-29T20:00:${String(index).padStart(2, "0")}.000Z`,
          venueRef: "paper",
        },
      });
    }
    const first = await readFinanceNightReviewResearchScope({
      directory,
      asOf: "2026-09-29T21:00:00.000Z",
    });
    const nextDate = await readFinanceNightReviewResearchScope({
      directory,
      asOf: "2026-09-30T21:00:00.000Z",
    });
    expect(first.instruments).toHaveLength(14);
    expect(first.instruments.every((item) => item.reasons.includes("held_position"))).toBe(true);
    expect(first.coverage?.totalInstrumentCount).toBe(17);
    expect(first.coverage?.deferredInstruments).toHaveLength(3);
    expect(new Set(first.instruments.map((item) => item.instrument))).not.toEqual(
      new Set(nextDate.instruments.map((item) => item.instrument)),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each([14, 16])(
  "reserves one rotating slot for active-only rules with %i held instruments",
  async (heldCount) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-mixed-rotation-"));
    try {
      const heldSymbols = Array.from(
        { length: heldCount },
        (_, index) => `D${String.fromCharCode(65 + index)}`,
      );
      for (const [index, instrument] of heldSymbols.entries()) {
        const at = `2026-09-29T20:00:${String(index).padStart(2, "0")}.000Z`;
        await appendFinanceExecutionReceipt(directory, {
          schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
          receiptId: `mixed-held-${index}`,
          intentId: `mixed-held-intent-${index}`,
          runAuthorizationId: "paper-run",
          adapterId: "paper",
          adapterKind: "paper",
          venue: "paper",
          instrument,
          side: "buy",
          orderType: "market",
          quantity: 1,
          referencePrice: 10,
          referencePriceAt: at,
          notional: 10,
          executionAuthority: "declared_execution_adapter_required",
          recordedAt: at,
          fill: { filledQuantity: 1, fillPrice: 10, filledAt: at, venueRef: "paper" },
        });
      }
      await declareFinanceStrategyRule(directory, {
        kind: "declared",
        ruleId: "mixed-active-rule",
        form: "trend",
        instruments: ["VA", "VB"],
        emits: "weights",
        schedule: { kind: "daily" },
        body: { frozenRule: { lookbackMonths: 6 } },
        observedAt: "2026-09-01T00:00:00.000Z",
      });
      await activateFinanceStrategyRule(directory, {
        kind: "activated",
        ruleId: "mixed-active-rule",
        reason: "mixed scope rotation fixture",
        observedAt: "2026-09-02T00:00:00.000Z",
      });
      const first = await readFinanceNightReviewResearchScope({
        directory,
        asOf: "2026-09-29T21:00:00.000Z",
      });
      const nextDate = await readFinanceNightReviewResearchScope({
        directory,
        asOf: "2026-09-30T21:00:00.000Z",
      });
      for (const scope of [first, nextDate]) {
        expect(scope.instruments).toHaveLength(14);
        expect(
          scope.instruments.filter((item) => item.reasons.includes("held_position")),
        ).toHaveLength(13);
        expect(scope.instruments.filter((item) => item.instrument.startsWith("V"))).toHaveLength(1);
      }
      expect(
        new Set([...first.instruments, ...nextDate.instruments].map((item) => item.instrument))
          .size,
      ).toBe(heldCount + 2);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it("rejects future scope cutoffs and active symbols the scope cannot explain", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-invalid-scope-"));
  try {
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "invalid-symbol-rule",
      form: "trend",
      instruments: ["BAD_SYMBOL"],
      emits: "weights",
      schedule: { kind: "daily" },
      body: { frozenRule: { lookbackMonths: 6 } },
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "invalid-symbol-rule",
      reason: "invalid identity fixture",
      observedAt: "2026-09-02T00:00:00.000Z",
    });
    await expect(
      readFinanceNightReviewResearchScope({
        directory,
        asOf: "2026-09-29T21:00:00.000Z",
      }),
    ).rejects.toThrow(/unsupported instrument identity/);
    await expect(
      readFinanceNightReviewResearchScope({
        directory,
        asOf: "2030-09-29T21:00:00.000Z",
      }),
    ).rejects.toThrow(/non-future asOf/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("keeps close evidence bounded to selected active instruments while retaining all active rules", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-selected-eod-"));
  try {
    const instruments = Array.from(
      { length: 18 },
      (_, index) => `C${String.fromCharCode(65 + index)}`,
    );
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "wide-eod-rule",
      form: "trend",
      instruments,
      emits: "weights",
      schedule: { kind: "daily" },
      body: { frozenRule: { lookbackMonths: 6 } },
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "wide-eod-rule",
      reason: "scope rotation fixture",
      observedAt: "2026-09-02T00:00:00.000Z",
    });
    const evidence = await buildFinanceNightReviewEvidence({
      directory,
      asOf: "2026-09-29T21:00:00.000Z",
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
    const scopeItem = evidence.find((item) => item.id === "finance-night:research-scope");
    const scope = JSON.parse(scopeItem?.text ?? "{}") as {
      instruments?: readonly { instrument: string; reasons: readonly string[] }[];
    };
    const rules = evidence.find((item) => item.id === "finance-night:rules:2026-09-29");
    expect(JSON.parse(rules?.text ?? "{}").activeRules).toHaveLength(1);
    expect(evidence.filter((item) => item.id.startsWith("finance-controller:eod:"))).toHaveLength(
      14,
    );
    expect(scope.instruments).toHaveLength(14);
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

describe("shared broker account research evidence", () => {
  const asOf = "2026-09-22T22:00:00.000Z";
  it.each([
    [
      "valid",
      "https://paper-api.alpaca.markets/v2/account",
      "2026-09-22T21:58:59.000Z",
      "selected",
    ],
    [
      "wrong source",
      "https://api.alpaca.markets/v2/account",
      "2026-09-22T21:58:59.000Z",
      "selected",
    ],
    [
      "future",
      "https://paper-api.alpaca.markets/v2/account",
      "2026-09-22T22:00:01.000Z",
      "selected",
    ],
    [
      "wrong account",
      "https://paper-api.alpaca.markets/v2/account",
      "2026-09-22T21:58:59.000Z",
      "other",
    ],
  ])(
    "uses only a matching fresh account observation: %s",
    async (_case, source, observedAt, accountId) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-account-observation-"));
      try {
        await appendFinanceBrokerHistory(directory, {
          kind: "broker_history",
          accountId: "selected",
          venue: "alpaca:paper",
          query: "reconciliation:observation",
          cursor: "",
          payload: [
            {
              observedAt: "2026-09-22T21:59:00.000Z",
              brokerCash: 100,
              positions: [{ symbol: "SPY", qty: "1" }],
              protection: { coverage: [] },
              status: "unresolved",
              cashDifference: 1.29,
              issues: ["cash_difference"],
              accountObservation: {
                accountId,
                currency: "USD",
                source,
                observedAt,
                cash: 100,
                equity: 200,
                buyingPower: 300,
                portfolioValue: 200,
                balanceAsOf: "2026-09-20",
                accruedFees: 0,
                pendingRegTafFees: 1.29,
                intradayAdjustments: -0.25,
              },
            },
          ],
        });
        const evidence = await buildFinanceBrokerAccountResearchEvidence({
          directory,
          asOf,
          accountId: "selected",
          venue: "alpaca:paper",
        });
        const snapshot = JSON.parse(evidence.text).positionSnapshots[0];
        const reconciliation = await readFinanceBrokerReconciliation(
          directory,
          "selected",
          Date.parse(asOf),
        );
        expect(reconciliation.ok).toBe(false);
        expect(reconciliation.reason).toBe("unresolved");
        expect(reconciliation.snapshot?.cashDifference).toBe(1.29);
        if (_case === "valid") {
          expect(snapshot).toMatchObject({
            equity: 200,
            buyingPower: 300,
            portfolioValue: 200,
            accountObservationSource: source,
            accountObservationObservedAt: observedAt,
            missingFields: [],
            accountBalanceDiagnostics: {
              balanceAsOf: "2026-09-20",
              accruedFees: 0,
              pendingRegTafFees: 1.29,
              intradayAdjustments: -0.25,
            },
          });
        } else {
          expect(snapshot).toMatchObject({
            equity: null,
            buyingPower: null,
            portfolioValue: null,
            accountObservationSource: null,
            missingFields: ["equity", "buyingPower", "portfolioValue"],
            accountBalanceDiagnostics: {
              balanceAsOf: null,
              accruedFees: null,
              pendingRegTafFees: null,
              intradayAdjustments: null,
            },
          });
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
  it.each([
    ["legacy", {}],
    [
      "partial",
      {
        balanceAsOf: "2026-02-30",
        accruedFees: 0,
        pendingRegTafFees: "1.29",
        intradayAdjustments: false,
      },
    ],
  ])("keeps %s balance diagnostics unknown without losing valid facts", async (kind, fields) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-balance-diagnostics-"));
    try {
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "selected",
        venue: "alpaca:paper",
        query: "reconciliation:balance-diagnostics",
        cursor: "",
        payload: [
          {
            observedAt: asOf,
            brokerCash: 100,
            positions: [],
            protection: { coverage: [] },
            accountObservation: {
              accountId: "selected",
              currency: "USD",
              source: "https://paper-api.alpaca.markets/v2/account",
              observedAt: asOf,
              cash: 100,
              equity: 200,
              buyingPower: 300,
              portfolioValue: 200,
              ...fields,
            },
          },
        ],
      });
      const summary = JSON.parse(
        (
          await buildFinanceBrokerAccountResearchEvidence({
            directory,
            asOf,
            accountId: "selected",
            venue: "alpaca:paper",
          })
        ).text,
      );
      expect(summary.executionAuthority).toBe("none");
      expect(summary.positionSnapshots[0]).toMatchObject({
        brokerCash: 100,
        equity: 200,
        accountBalanceDiagnostics: {
          balanceAsOf: null,
          accruedFees: kind === "partial" ? 0 : null,
          pendingRegTafFees: null,
          intradayAdjustments: null,
        },
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("reads the exact account and venue even outside the aggregate's latest three books", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-account-context-"));
    try {
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "selected",
        venue: "alpaca:paper",
        query: "reconciliation:selected",
        cursor: "",
        payload: [
          {
            observedAt: "2026-09-22T21:59:00.000Z",
            brokerCash: 100,
            positions: [{ symbol: "SPY", qty: "1" }],
            protection: { coverage: [] },
          },
        ],
      });
      for (const [accountId, venue] of [
        ["selected", "paper"],
        ["other", "alpaca:paper"],
        ["third", "alpaca:paper"],
      ]) {
        await appendFinanceBrokerHistory(directory, {
          kind: "broker_history",
          accountId,
          venue,
          query: "reconciliation:other",
          cursor: "",
          payload: [
            {
              observedAt: "2026-09-22T21:59:00.000Z",
              brokerCash: 999,
              positions: [{ symbol: "OTHER-ACCOUNT-SECRET", qty: "9" }],
            },
          ],
        });
      }
      const evidence = await buildFinanceBrokerAccountResearchEvidence({
        directory,
        asOf,
        accountId: "selected",
        venue: "alpaca:paper",
      });
      const summary = JSON.parse(evidence.text);
      expect(summary).toMatchObject({
        accountScope: { accountId: "selected", venue: "alpaca:paper" },
        currentAccountFactsStatus: "observed",
        executionAuthority: "none",
        positionSnapshots: [
          {
            accountId: "selected",
            venue: "alpaca:paper",
            freshness: "fresh",
            brokerCash: 100,
            equity: null,
            buyingPower: null,
            missingFields: ["equity", "buyingPower", "portfolioValue"],
            positions: [{ symbol: "SPY", quantity: 1 }],
          },
        ],
        missingFields: [],
        accounts: [
          {
            accountId: "selected",
            venue: "alpaca:paper",
            status: "no_closed_matches",
            netMatchedPnl: null,
          },
        ],
      });
      expect(summary.accounts[0].snapshotRef).toBe(summary.positionSnapshots[0].snapshotRef);
      expect(evidence.text).not.toContain("OTHER-ACCOUNT-SECRET");
      const localPaper = JSON.parse(
        (
          await buildFinanceBrokerAccountResearchEvidence({
            directory,
            asOf,
            accountId: "selected",
            venue: "paper",
          })
        ).text,
      );
      expect(localPaper.positionSnapshots[0].venue).toBe("paper");
      expect(localPaper.positionSnapshots[0].brokerCash).toBe(999);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it.each([true, false])("keeps account research at its cutoff with scoped=%s", async (scoped) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-account-fixed-cutoff-"));
    try {
      const append = (query: string, observedAt: string, brokerCash: number, symbol: string) =>
        appendFinanceBrokerHistory(directory, {
          kind: "broker_history",
          accountId: "selected",
          venue: "alpaca:paper",
          query,
          cursor: "",
          payload: [{ observedAt, brokerCash, positions: [{ symbol, qty: "1" }] }],
        });
      await append("reconciliation:before", "2026-09-22T21:59:00.000Z", 100, "SPY");
      const read = () =>
        buildFinanceBrokerAccountResearchEvidence({
          directory,
          asOf,
          ...(scoped ? { accountId: "selected", venue: "alpaca:paper" } : {}),
        });
      const before = JSON.parse((await read()).text);
      await append("reconciliation:after", "2026-09-22T22:00:01.000Z", 999, "FUTURE-CONTENT");
      await append("orders:after", "2026-09-22T22:00:02.000Z", 999, "FUTURE-CONTENT");
      const evidence = await read();
      const after = JSON.parse(evidence.text);
      expect(after.positionSnapshots).toEqual(before.positionSnapshots);
      expect(after.accounts).toEqual(before.accounts);
      expect(after.positionSnapshots[0]).toMatchObject({ freshness: "fresh", brokerCash: 100 });
      expect(after.executionAuthority).toBe("none");
      if (scoped) {
        expect(after.currentAccountFactsStatus).toBe("observed");
      }
      expect(evidence.text).not.toContain("FUTURE-CONTENT");
      const current = await readFinanceLatestBrokerReconciliations(directory);
      expect(current.records[0].superseded).toBe(true);
      expect(current.records[0].ref).not.toBe(after.positionSnapshots[0].snapshotRef);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    ["2026-09-22T21:50:00.000Z", "stale"],
    ["2026-09-22T22:00:01.000Z", "outside_cutoff"],
    ["invalid", "invalid_timestamp"],
  ])("marks current account facts unknown for %s", async (observedAt, freshness) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-account-cutoff-"));
    try {
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "selected",
        venue: "alpaca:paper",
        query: "reconciliation:cutoff",
        cursor: "",
        payload: [
          { observedAt, brokerCash: 100, positions: [{ symbol: "CUTOFF-CONTENT", qty: "1" }] },
        ],
      });
      const evidence = await buildFinanceBrokerAccountResearchEvidence({
        directory,
        asOf,
        accountId: "selected",
        venue: "alpaca:paper",
      });
      const summary = JSON.parse(evidence.text);
      expect(summary.currentAccountFactsStatus).toBe("unknown");
      if (freshness === "outside_cutoff") {
        expect(summary.positionSnapshots).toEqual([]);
        expect(summary.missingFields).toContain("positionSnapshots");
      } else {
        expect(summary.positionSnapshots[0].freshness).toBe(freshness);
        expect(summary.positionSnapshots[0].brokerCash).toBeNull();
        expect(summary.positionSnapshots[0].positions).toBeNull();
      }
      expect(evidence.text).not.toContain("CUTOFF-CONTENT");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("does not interpret a missing book or partial snapshot as zero cash or empty holdings", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-account-missing-"));
    try {
      const read = () =>
        buildFinanceBrokerAccountResearchEvidence({
          directory,
          asOf,
          accountId: "selected",
          venue: "alpaca:paper",
        });
      const missing = JSON.parse((await read()).text);
      expect(missing.currentAccountFactsStatus).toBe("unknown");
      expect(missing.positionSnapshots).toEqual([]);
      expect(missing.missingFields).toContain("positionSnapshots");
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "selected",
        venue: "alpaca:paper",
        query: "reconciliation:partial",
        cursor: "",
        payload: [{ observedAt: "2026-09-22T21:59:00.000Z" }],
      });
      const partial = JSON.parse((await read()).text);
      expect(partial.currentAccountFactsStatus).toBe("unknown");
      expect(partial.positionSnapshots[0]).toMatchObject({
        brokerCash: null,
        equity: null,
        missingFields: [
          "brokerCash",
          "equity",
          "buyingPower",
          "portfolioValue",
          "positions",
          "protectionCoverage",
          "usable_current_account_facts",
        ],
      });
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "selected",
        venue: "alpaca:paper",
        query: "reconciliation:invalid-position",
        cursor: "",
        payload: [
          {
            observedAt: "2026-09-22T21:59:00.000Z",
            brokerCash: 100,
            positions: [
              { symbol: "SPY", qty: "1" },
              { symbol: "BTCUSD", qty: "invalid" },
            ],
          },
        ],
      });
      const invalidPosition = JSON.parse((await read()).text);
      expect(invalidPosition.currentAccountFactsStatus).toBe("unknown");
      expect(invalidPosition.positionSnapshots[0].missingFields).toContain(
        "positions.invalid_entries",
      );
      await expect(
        buildFinanceBrokerAccountResearchEvidence({ directory, asOf, accountId: "selected" }),
      ).rejects.toThrow("both accountId and venue");
      await expect(
        buildFinanceBrokerAccountResearchEvidence({ directory, asOf: "invalid" }),
      ).rejects.toThrow("valid non-future asOf");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

const brokerInventoryCases = [
  "reconciled",
  "cash_difference",
  "other_issue",
  "cash_with_other_issue",
  "stale",
  "differences",
  "invalid_quantity",
  "live",
];
it.each(brokerInventoryCases)(
  "uses only usable Paper broker inventory for night targets: %s",
  async (kind) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "night-broker-holdings-"));
    const asOf = new Date().toISOString();
    try {
      await appendFinanceExecutionReceipt(directory, {
        schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
        receiptId: "old-entry",
        intentId: "old-entry",
        accountId: "paper-account",
        runAuthorizationId: "paper-run",
        adapterId: "alpaca-venue",
        adapterKind: "venue",
        venue: "alpaca:paper",
        instrument: "UTHR",
        side: "buy",
        orderType: "market",
        quantity: 1,
        referencePrice: 100,
        referencePriceAt: asOf,
        notional: 100,
        fill: { filledQuantity: 1, fillPrice: 100, filledAt: asOf, venueRef: "alpaca:paper:entry" },
        executionAuthority: "declared_execution_adapter_required",
        recordedAt: asOf,
      });
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "paper-account",
        venue: kind === "live" ? "alpaca:live" : "alpaca:paper",
        query: "reconciliation:test",
        cursor: "",
        payload: [
          {
            observedAt: kind === "stale" ? new Date(Date.parse(asOf) - 300001).toISOString() : asOf,
            status:
              kind === "cash_difference" ||
              kind === "other_issue" ||
              kind === "cash_with_other_issue"
                ? "unresolved"
                : "reconciled",
            issues:
              kind === "cash_difference"
                ? ["cash_difference"]
                : kind === "other_issue"
                  ? ["broker_history_invalid"]
                  : kind === "cash_with_other_issue"
                    ? ["cash_difference", "broker_history_invalid"]
                    : [],
            differences: kind === "differences" ? ["quantity_difference"] : [],
            positions: [
              {
                symbol: "BTCUSD",
                qty: kind === "invalid_quantity" ? "invalid" : "0.000399",
                asset_class: "crypto",
              },
            ],
          },
        ],
      });
      const scope = await readFinanceNightReviewResearchScope({ directory, asOf });
      const evidence = await buildFinanceNightReviewEvidence({
        directory,
        asOf,
        etDate: asOf.slice(0, 10),
        includeResearchScope: true,
        settlement: {
          scoredFiled: { appended: 0, skipped: 0 },
          reflection: {},
          pending: [],
          declined: [],
          issues: [],
        },
      });
      expect(
        JSON.parse(evidence.find((item) => item.source === "finance-night-research-scope")!.text),
      ).toEqual(scope);
      if (kind === "reconciled" || kind === "cash_difference") {
        expect(scope.instruments).toEqual([
          { instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] },
        ]);
        expect(scope.holdingBasis).toMatchObject({
          source: "broker_reconciliation",
          issues: kind === "cash_difference" ? ["broker_cash_unreconciled:paper-account"] : [],
          executionAuthority: "none",
        });
        // A later broker update must not invalidate the original controller cutoff.
        await appendFinanceBrokerHistory(directory, {
          kind: "broker_history",
          accountId: "paper-account",
          venue: "alpaca:paper",
          query: "reconciliation:later",
          cursor: "",
          payload: [
            {
              observedAt: new Date(Date.parse(asOf) + 1000).toISOString(),
              status: "reconciled",
              differences: [],
              positions: [],
            },
          ],
        });
        expect(await readFinanceNightReviewResearchScope({ directory, asOf })).toEqual(scope);
        // A confirmed flat inventory must remove old receipt holdings even while cash is pending.
        await appendFinanceBrokerHistory(directory, {
          kind: "broker_history",
          accountId: "paper-account",
          venue: "alpaca:paper",
          query: "reconciliation:flat",
          cursor: "",
          payload: [
            {
              observedAt: asOf,
              status: kind === "cash_difference" ? "unresolved" : "reconciled",
              issues: kind === "cash_difference" ? ["cash_difference"] : [],
              differences: [],
              positions: [],
            },
          ],
        });
        await expect(readFinanceNightReviewResearchScope({ directory, asOf })).rejects.toThrow(
          "night research scope has no held positions or active strategy instruments",
        );
      } else {
        expect(scope.instruments.map((item) => item.instrument)).toEqual(["UTHR"]);
        if (kind !== "live") {
          expect(scope.holdingBasis?.issues.length).toBeGreaterThan(0);
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["cash_difference", "stale", "multiple_accounts", "no_broker"])(
  "keeps simulation TLT400 separate from actual TLT12: %s",
  async (kind) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "night-risk-inventory-"));
    const asOf = new Date().toISOString();
    try {
      for (const [adapterKind, venue, quantity] of [
        ["paper", "paper", 400],
        ["venue", "alpaca:paper", 12],
      ] as const) {
        await appendFinanceExecutionReceipt(directory, {
          schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
          receiptId: `TLT-${adapterKind}`,
          intentId: `TLT-${adapterKind}`,
          accountId: "selected",
          runAuthorizationId: "run",
          adapterId: adapterKind,
          adapterKind,
          venue,
          instrument: "TLT",
          side: "buy",
          orderType: "market",
          quantity,
          referencePrice: 100,
          referencePriceAt: asOf,
          notional: quantity * 100,
          fill: { filledQuantity: quantity, fillPrice: 100, filledAt: asOf, venueRef: venue },
          executionAuthority: "declared_execution_adapter_required",
          recordedAt: asOf,
        });
      }
      if (kind !== "no_broker") {
        for (const accountId of kind === "multiple_accounts"
          ? ["selected", "other"]
          : ["selected"]) {
          await appendFinanceBrokerHistory(directory, {
            kind: "broker_history",
            accountId,
            venue: "alpaca:paper",
            query: "reconciliation:test",
            cursor: "",
            payload: [
              {
                observedAt:
                  kind === "stale" ? new Date(Date.parse(asOf) - 300001).toISOString() : asOf,
                status: "unresolved",
                issues: ["cash_difference"],
                differences: [],
                positions: [{ symbol: "TLT", qty: accountId === "selected" ? "12" : "5" }],
              },
            ],
          });
        }
      }
      const evidence = await buildFinanceNightReviewEvidence({
        directory,
        asOf,
        etDate: asOf.slice(0, 10),
        settlement: {
          scoredFiled: { appended: 0, skipped: 0 },
          reflection: {},
          pending: [],
          declined: [],
          issues: [],
        },
      });
      const portfolio = JSON.parse(
        evidence.find((item) => item.id.startsWith("finance-night:portfolio:"))!.text,
      );
      expect(
        portfolio.localExecutionProjections.map(
          (p: { positions: { quantity: number }[] }) => p.positions[0].quantity,
        ),
      ).toEqual([400, 12]);
      expect(portfolio.realizedPnl).toBeNull();
      expect(portfolio.unrealizedPnl).toBeNull();
      if (kind === "cash_difference") {
        expect(portfolio.positions).toEqual([{ instrument: "TLT", quantity: 12 }]);
        expect(portfolio.accountInventories[0].issues).toEqual([
          "broker_cash_unreconciled:selected",
        ]);
      } else {
        expect(portfolio.positions).toBeNull();
        expect(portfolio.currentAccountInventoryStatus).toBe("unknown");
      }
      if (kind === "multiple_accounts") {
        expect(
          portfolio.accountInventories.map(
            (p: { positions: { quantity: number }[] }) => p.positions[0].quantity,
          ),
        ).toEqual(expect.arrayContaining([12, 5]));
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
