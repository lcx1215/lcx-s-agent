import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
  FINANCE_ALPACA_MARKET_CALENDAR_URL,
} from "./finance-alpaca-market-calendar.js";
import {
  compileFinanceAlpacaOrderIntent,
  type FinanceAlpacaRunRequest,
} from "./finance-alpaca-run.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { runFinanceDailyCycle } from "./finance-daily-cycle.js";
import { buildFinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { syntheticSafetyContext } from "./finance-execution-safety.test-support.js";
import {
  appendFinanceIntradayDecision,
  readFinanceIntradayOutcome,
  type FinanceIntradayStrategyBinding,
} from "./finance-intraday-control-ledger.js";
import { executeFinanceIntradayDecision } from "./finance-intraday-execution.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_EMITS,
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
  FINANCE_INTRADAY_OPENING_RANGE_RULE,
  resolveFinanceIntradayActiveRuleContract,
} from "./finance-intraday-paper.js";
import { readFinancePositionRecords } from "./finance-position-ledger.js";
import { buildFinanceResearchPortfolioPlan } from "./finance-research-portfolio-plan.js";
import {
  persistFinanceResearchThesisLearning,
  validateFinanceResearchThesisProposals,
} from "./finance-research-thesis-learning.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
} from "./finance-strategy-rule-ledger.js";
import { buildFinanceThesisDecisionContext } from "./finance-thesis-decision-context.js";
import {
  createFinanceTradeDecisionReviewer,
  type FinanceTradeDecisionReviewRequest,
} from "./finance-trade-decision-review.js";

const external = vi.hoisted(() => ({ collect: vi.fn(), fetch: vi.fn() }));
vi.mock("./finance-free-market-collection-adapters.js", () => ({
  createChinaReachableUsEodHistoryCollectionAdapter: () => ({ collect: external.collect }),
}));
const directories: string[] = [];
const decisionAt = "2026-09-18T15:00:02.000Z";
const exitAt = "2026-09-18T15:00:04.000Z";
const researchAt = "2026-09-18T14:00:00.000Z";
const accountId = "offline-paper-account";
const caps = { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 };
beforeEach(() => {
  external.fetch.mockRejectedValue(new Error("Offline acceptance forbids network calls"));
  vi.stubGlobal("fetch", external.fetch);
});
afterEach(async () => {
  expect(external.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});
async function directory() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "opportunity-consumer-"));
  directories.push(value);
  return value;
}

// Reuse the existing portfolio-cycle replay: slow trend is positive while fast is negative.
function recordedHistory() {
  return Array.from({ length: 620 }, (_, i) => {
    const date = new Date(Date.parse("2025-01-11T00:00:00Z") + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const close = i < 420 ? 100 + i / 4 : 205 - (i - 420) * 0.15;
    return {
      data: { date, close, open: close, high: close + 1, low: close - 1, volume: 100 },
      observedAt: "2026-09-22T20:00:30.000Z",
      sourceTimestamp: date + "T20:00:00Z",
      providerName: "offline-fixture",
      sourceUrlOrArtifact: "fixture://recorded-history",
    };
  });
}
function allocation(slowFraction: number, fastFraction: number, evidenceId = "regime") {
  return buildFinanceResearchPortfolioPlan({
    asOf: "2026-09-22T20:00:30.000Z",
    context: {
      accountId,
      venue: "paper",
      validityMinutes: 240,
      conflictPolicy: "block",
      activeStrategyIds: ["slow", "fast"],
      requiredInstruments: ["SPY"],
    },
    proposal: {
      allocations: [
        { strategyId: "slow", budgetFraction: slowFraction, evidenceIds: [evidenceId] },
        { strategyId: "fast", budgetFraction: fastFraction, evidenceIds: [evidenceId] },
      ],
    },
    supportedEvidenceIds: new Set(["regime"]),
    researchReceiptId: "quality:offline-allocation",
  });
}

function thesisInput(contrary: boolean, horizon: "intraday" | "long_term" = "intraday") {
  const evidence = [
    {
      id: "finance-model:SPY",
      source: "offline-source",
      timestamp: researchAt,
      text: "SPY supports the bounded continuation hypothesis.",
    },
    ...(contrary
      ? [
          {
            id: "contrary:SPY",
            source: "offline-source",
            timestamp: researchAt,
            text: "SPY has candidate-specific counterevidence in this observation window.",
          },
        ]
      : []),
  ];
  return {
    value: [
      {
        claimId: "continuation",
        instrument: "SPY",
        applicability: { horizon, validUntil: "2026-09-18T20:00:00.000Z" },
        expectationGap: {
          origin: "model_hypothesis",
          edgeKind: "timing",
          marketExpectation: null,
          variantView: "Continuation is conditional on the supplied observation.",
          catalyst: "This session",
          invalidation: "Recorded counterevidence or the existing stop",
          costRiskAssessment: "Fees and profitability remain unknown.",
        },
        invalidationConditions: ["Continuation is contradicted by the cited evidence."],
      },
    ],
    claims: [
      {
        id: "continuation",
        text: "SPY continuation is a bounded research hypothesis.",
        status: "supported" as const,
        epistemicClass: "hypothesis" as const,
        basis: "Conditional reading of explicitly synthetic source observations.",
        evidenceIds: evidence.map((item) => item.id),
        evidenceRelations: evidence.map((item) => ({
          evidenceId: item.id,
          relation: item.id.startsWith("contrary")
            ? ("contradicts" as const)
            : ("supports" as const),
        })),
      },
    ],
    evidence,
    instruments: ["SPY"],
    asOf: researchAt,
    receiptReference: "fixture://offline-research-receipt",
    runId: contrary ? "contrary-run" : "support-run",
  };
}
async function persistThesis(root: string, contrary: boolean) {
  const result = await persistFinanceResearchThesisLearning({
    directory: root,
    eligible: true,
    proposals: validateFinanceResearchThesisProposals(thesisInput(contrary)),
    observedAt: researchAt,
  });
  expect(result.status).toBe("persisted");
}
async function activeBinding(root: string): Promise<FinanceIntradayStrategyBinding> {
  await declareFinanceStrategyRule(root, {
    kind: "declared",
    ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE,
    form: FINANCE_INTRADAY_OPENING_RANGE_FORM,
    formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
    instruments: ["SPY"],
    emits: FINANCE_INTRADAY_OPENING_RANGE_EMITS,
    schedule: { kind: "intraday", timezone: "America/New_York" },
    body: {
      universe: ["SPY"],
      frozenRule: { openingRangeBars: 6, rewardRisk: 2 },
      data: { intervalSeconds: 300, feed: "iex" },
      paperExecutionEligibility: "paper_execution_eligible",
    },
    observedAt: "2026-09-17T00:00:00Z",
  });
  await activateFinanceStrategyRule(root, {
    kind: "activated",
    ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE,
    reason: "Offline replay of existing Paper rule",
    observedAt: "2026-09-17T00:01:00Z",
  });
  const rule = (await readFinanceStrategyRuleLedger(root)).ledger.rules[0];
  const contract = resolveFinanceIntradayActiveRuleContract(rule);
  const date = "2026-09-18",
    openAt = date + "T13:30:00.000Z",
    closeAt = date + "T20:00:00.000Z";
  const sourceUrlOrArtifact =
    FINANCE_ALPACA_MARKET_CALENDAR_URL + "?start=" + date + "&end=" + date + "&date_type=TRADING";
  return {
    declarationRef: contract.declarationRef,
    activationRef: contract.activationRef,
    declaredInstruments: [...contract.instruments],
    scope: "strategy_universe",
    parameters: {
      openingRangeBars: contract.openingRangeBars,
      rewardRisk: contract.rewardRisk,
      intervalSeconds: contract.intervalSeconds,
      feed: contract.feed,
    },
    marketSession: {
      date,
      openAt,
      closeAt,
      openMinute: 570,
      closeMinute: 960,
      observedAt: "2026-09-18T14:59:59.000Z",
      sourceUrlOrArtifact,
      calendarRef: caseflowFingerprint({
        source: FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
        sourceUrlOrArtifact,
        date,
        openAt,
        closeAt,
      }),
    },
  };
}
async function candidate(root: string, binding: FinanceIntradayStrategyBinding, exit = false) {
  return (
    await appendFinanceIntradayDecision(root, {
      signalId: exit ? "intraday-opportunity-protective" : "intraday-opportunity",
      instrument: "SPY",
      sessionDate: "2026-09-18",
      action: exit ? "sell" : "buy",
      reason: exit ? "opening_range_stop" : "opening_range_breakout",
      referencePrice: 500,
      referencePriceAt: "2026-09-18T15:00:00.000Z",
      ...(exit ? {} : { stopPrice: 498, targetPrice: 504 }),
      datasetHeadRef: "a".repeat(64),
      strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
      strategyBinding: binding,
    })
  ).record;
}
function controller(quantity = 0) {
  return {
    accountId,
    accountBookProvider: async () => ({
      accountId,
      venue: "alpaca:paper" as const,
      observedAt: decisionAt,
      expiresAt: "2026-09-18T15:01:00.000Z",
      equity: 100_000,
      positions: quantity ? [{ instrument: "SPY", quantity, marketValue: quantity * 500 }] : [],
    }),
    executionQuoteProvider: async () => ({
      referencePrice: 500,
      referencePriceAt: "2026-09-18T15:00:01.000Z",
      sourceUrlOrArtifact: "fixture://offline-quote",
      bidPrice: 499.9,
      askPrice: 500,
      maxAgeMs: 30_000,
    }),
    createSafetyContext: syntheticSafetyContext,
  };
}
function offlineVenue() {
  return vi.fn(async (request: FinanceAlpacaRunRequest) => {
    const compiled = compileFinanceAlpacaOrderIntent(request);
    if (!compiled.ok) {
      throw new Error(compiled.refusals.join(", "));
    }
    expect(request.mode).toBe("paper");
    expect(compiled.intent.instrument).toBe("SPY");
    const filledAt = compiled.intent.side === "sell" ? exitAt : decisionAt;
    const receipt = buildFinanceExecutionReceipt({
      intent: compiled.intent,
      adapter: { id: "offline-venue-stub", kind: "venue", venue: "alpaca:paper" },
      fill: {
        filledQuantity: compiled.intent.quantity,
        fillPrice: request.market.referencePrice,
        filledAt,
        venueRef: "fixture://synthetic-fill",
        terminalOrderIdentity: { orderId: compiled.intent.intentId, terminal: true },
      },
      recordedAt: filledAt,
      accountId,
    });
    return { ok: true as const, receipt, notes: compiled.notes };
  });
}
function contextConsumer() {
  const payloads: FinanceTradeDecisionReviewRequest[] = [];
  const invoke = vi.fn(async ({ payload }: { payload: unknown }) => {
    const request = payload as FinanceTradeDecisionReviewRequest;
    payloads.push(request);
    const thesis = request.decisionContext?.theses[0];
    expect(thesis?.instrument).toBe("SPY");
    expect(thesis?.expectationGap?.origin).toBe("model_hypothesis");
    const contrary = thesis?.evidence.some((item) => item.relation === "contradicts");
    return {
      schemaVersion: request.schemaVersion,
      decisions: request.candidates.map((item) => ({
        candidateId: item.candidateId,
        decision: contrary ? "veto" : "approve",
        rationale:
          "Offline script consumed " +
          thesis?.thesisId +
          (contrary ? " counterevidence" : " supporting evidence"),
      })),
    };
  });
  const reviewer = createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: () => ({
        id: "offline-script",
        provider: "offline-scripted",
        modelId: "offline-script",
        mode: "deterministic",
        capabilities: ["quality_harness"],
        requiredTools: [],
        requiredSideEffects: [],
        invoke,
      }),
    },
  );
  return { reviewer, invoke, payloads };
}

it("supported allocation changes the real daily target/drift while withholding and conflicts preserve cash", async () => {
  external.collect.mockResolvedValue(recordedHistory());
  const reports = [];
  for (const [slow, fast] of [
    [0.08, 0],
    [0.12, 0],
    [0.12, 0.2],
  ]) {
    reports.push(
      await runFinanceDailyCycle({
        directory: await directory(),
        instruments: ["SPY"],
        asOf: "2026-09-22T20:00:30.000Z",
        equity: 100_000,
        caps: { maxOrderNotional: 10_000, maxInstrumentNotional: 20_000, maxOrdersPerRun: 2 },
        runAuthorizationId: "offline-allocation",
        portfolioPlan: allocation(slow, fast),
        trendStrategies: [
          { ruleId: "slow", lookbackMonths: 12, instruments: ["SPY"] },
          { ruleId: "fast", lookbackMonths: 6, instruments: ["SPY"] },
        ],
        place: false,
      }),
    );
  }
  expect(reports[0].drift).toMatchObject([
    { instrument: "SPY", target: 0.08, action: "buy", notional: 3000 },
  ]);
  expect(reports[1].drift).toMatchObject([
    { instrument: "SPY", target: 0.12, action: "buy", notional: 7000 },
  ]);
  expect(reports[0].portfolio?.withheldStrategies).toMatchObject([
    { strategyId: "fast", budgetFraction: 0 },
  ]);
  expect(reports[1].portfolio?.targets[0].contributions).toMatchObject([
    { strategyId: "slow", evidenceIds: ["regime"] },
  ]);
  expect(reports[1].portfolio?.unallocatedCashWeight).toBeCloseTo(0.88);
  expect(reports[2].drift).toMatchObject([{ action: "none", notional: 0 }]);
  expect(reports[2].portfolio?.targets[0].blocked).toBe(true);
  expect(reports.every((report) => report.placed.length === 0)).toBe(true);
  expect(() => allocation(0.08, 0, "unsupported")).toThrow("unsupported evidence");
});

it("real supported/contrary thesis context changes one unchanged intraday candidate into placed/veto receipts", async () => {
  const payloads: FinanceTradeDecisionReviewRequest[] = [];
  for (const contrary of [false, true]) {
    const root = await directory();
    await persistThesis(root, contrary);
    const decision = await candidate(root, await activeBinding(root));
    const scripted = contextConsumer(),
      venue = offlineVenue();
    const result = await executeFinanceIntradayDecision({
      directory: root,
      decision,
      controller: controller(),
      caps,
      tradeDecisionReviewer: scripted.reviewer,
      runOrder: venue,
      now: () => Date.parse(decisionAt),
    });
    expect(result.status).toBe(contrary ? "refused" : "placed");
    expect(scripted.invoke).toHaveBeenCalledTimes(1);
    expect(venue).toHaveBeenCalledTimes(contrary ? 0 : 1);
    payloads.push(scripted.payloads[0]);
    const outcome = await readFinanceIntradayOutcome(root, decision.input.signalId);
    expect(outcome?.tradeDecisionReview).toMatchObject({
      status: "completed",
      providerCallObserved: false,
      adapterAttested: false,
      decision: { candidateId: "intraday-opportunity", decision: contrary ? "veto" : "approve" },
    });
    expect(
      outcome?.tradeDecisionReview?.request.decisionContext?.theses[0].evidence.some(
        (item) => item.relation === "contradicts",
      ),
    ).toBe(contrary);
    expect((await readFinancePositionRecords(root)).receipts).toHaveLength(contrary ? 0 : 1);
    expect(outcome?.receiptId === undefined).toBe(contrary);
  }
  expect(payloads[0].candidates).toEqual(payloads[1].candidates);
});

it("an owned protective exit bypasses the same discretionary context consumer even with real counterevidence", async () => {
  const root = await directory();
  await persistThesis(root, true);
  const binding = await activeBinding(root),
    entry = await candidate(root, binding),
    venue = offlineVenue();
  const bought = await executeFinanceIntradayDecision({
    directory: root,
    decision: entry,
    controller: controller(),
    caps,
    runOrder: venue,
    now: () => Date.parse(decisionAt),
  });
  expect(bought.status).toBe("placed");
  if (!("receipt" in bought)) {
    throw new Error("offline entry did not persist a fill");
  }
  const scripted = contextConsumer();
  const exit = await candidate(root, binding, true);
  const sold = await executeFinanceIntradayDecision({
    directory: root,
    decision: exit,
    controller: controller(bought.receipt.quantity),
    caps,
    tradeDecisionReviewer: scripted.reviewer,
    runOrder: venue,
    now: () => Date.parse(exitAt),
  });
  expect(sold.status).toBe("placed");
  expect(scripted.invoke).not.toHaveBeenCalled();
  expect(venue).toHaveBeenCalledTimes(2);
  expect(venue.mock.calls[1][0].quantityOverride).toBe(bought.receipt.quantity);
  const outcome = await readFinanceIntradayOutcome(root, exit.input.signalId);
  expect(outcome?.tradeDecisionReview).toBeUndefined();
  expect(outcome?.reasons.join()).toContain("protective exit");
});

it("future/out-of-scope research is refused and a valid long-term thesis cannot enter intraday context", async () => {
  const source = thesisInput(false);
  expect(() => validateFinanceResearchThesisProposals({ ...source, instruments: ["QQQ"] })).toThrow(
    "declared universe",
  );
  expect(() =>
    validateFinanceResearchThesisProposals({
      ...source,
      evidence: source.evidence.map((item) => ({ ...item, timestamp: "2026-09-19T00:00:00.000Z" })),
    }),
  ).toThrow("as-of window");
  const root = await directory();
  await persistFinanceResearchThesisLearning({
    directory: root,
    eligible: true,
    proposals: validateFinanceResearchThesisProposals(thesisInput(false, "long_term")),
    observedAt: researchAt,
  });
  const context = await buildFinanceThesisDecisionContext({
    directory: root,
    asOf: decisionAt,
    instruments: ["SPY"],
    horizon: "intraday",
  });
  expect(context).toMatchObject({ activeThesisCount: 1, theses: [], excludedThesisCount: 1 });
});
