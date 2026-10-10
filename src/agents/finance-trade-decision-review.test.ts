import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { createConfiguredFinanceModelAdapter } from "./configured-finance-model-adapter.js";
import { buildFinanceOpportunityContext } from "./finance-expectation-gap.js";
import {
  FinanceIntradayDecisionReviewReceiptSchema,
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
  readFinanceIntradayOutcome,
  readFinanceIntradayStrategyFeedback,
  readFinanceIntradayExecutionCoverage,
} from "./finance-intraday-control-ledger.js";
import { appendFinanceBrokerHistory } from "./finance-position-ledger.js";
import {
  FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY,
  FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
  createFinanceTradeDecisionReviewer,
  isValidFinanceTradeDecisionReviewResult,
  parseFinanceTradeDecisionReviewOutput,
  type FinanceIntradayTradeDecisionReviewRequest,
  type FinanceTradeDecisionReviewRequest,
  type FinanceTradeDecisionReviewHostOptions,
  type FinanceTradeDecision,
} from "./finance-trade-decision-review.js";
import type { FinanceTradeReviewFinancialCapability } from "./finance-trade-review-evidence.js";
import { ModelAdapterError } from "./logical-agent-model-router.js";
import type { LogicalAgentModelAdapter } from "./logical-agent-model-router.js";

const request: FinanceTradeDecisionReviewRequest = {
  schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
  venue: "alpaca:paper",
  asOf: "2026-09-23T19:30:00.000Z",
  signalAnchor: "2026-08-31",
  ruleIds: ["trend_risk_normalised_v1"],
  equity: 100_000,
  rebalanceBand: 0.05,
  caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 2 },
  reconciliation: { status: "reconciled" },
  positions: [],
  candidates: [
    {
      candidateId: "2026-08-31:SPY:buy",
      instrument: "SPY",
      side: "buy",
      targetWeight: 0.25,
      currentWeight: 0.1,
      weightDelta: 0.15,
      notional: 1_000,
      strategySignal: "hold",
      annualisedVol: 0.2,
      researchClose: 500,
      lastBarDate: "2026-09-22",
      executionQuote: {
        referencePrice: 501,
        referencePriceAt: "2026-09-23T19:29:59.000Z",
        bidPrice: 500,
        askPrice: 501,
        feed: "iex",
        priceBasis: "ask",
        ageMs: 1000,
        maxAgeMs: 5000,
      },
    },
  ],
};

it.each([
  { financial: false, artifacts: false },
  { financial: true, artifacts: false },
  { financial: false, artifacts: true },
  { financial: true, artifacts: true },
])("loads optional evidence instructions only for exposed capabilities: %j", (availability) => {
  let buildPrompt: ((payload: unknown) => string) | undefined;
  createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: (_cfg, options) => {
        buildPrompt = options?.buildPrompt;
        return adapter(null);
      },
    },
  );
  const prompt = buildPrompt!({
    ...request,
    evidenceToolsAvailable: true,
    ...(availability.financial
      ? { evidenceFinancialCapabilities: [{ toolName: "retained_method", moduleIds: ["credit"] }] }
      : {}),
    ...(availability.artifacts ? { evidenceArtifactRecallAvailable: true } : {}),
  });
  expect(prompt.includes('action:"financial_capability"')).toBe(availability.financial);
  expect(prompt.includes('action:"artifact_search"')).toBe(availability.artifacts);
  expect(prompt).toContain("Built-in mathematical actions");
  expect(prompt).toContain("Never add candidates or change instrument");
  expect(prompt).toContain("execution authority");
});

const intradayRequest: FinanceIntradayTradeDecisionReviewRequest = {
  schemaVersion: FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  venue: "alpaca:paper",
  asOf: "2026-09-23T19:30:00.000Z",
  signalAnchor: "intraday-signal-1",
  ruleIds: ["opening_range_breakout_long_next_bar_v1"],
  equity: 100_000,
  caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 1 },
  positionBookObservedAt: "2026-09-23T19:29:59.000Z",
  reconciliation: { status: "ready", historyStatus: "reconciled", uncertaintyReserve: 0 },
  positions: [{ instrument: "SPY", quantity: 0, marketValue: 0 }],
  candidates: [
    {
      candidateId: "intraday-signal-1",
      instrument: "SPY",
      side: "buy",
      strategyRule: "opening_range_breakout_long_next_bar_v1",
      signalReason: "opening_range_breakout",
      signalReferencePrice: 500,
      signalReferencePriceAt: "2026-09-23T19:29:55.000Z",
      stopPrice: 498,
      targetPrice: 504,
      datasetHeadRef: "c".repeat(64),
      marketSession: {
        date: "2026-09-23",
        openAt: "2026-09-23T13:30:00.000Z",
        closeAt: "2026-09-23T20:00:00.000Z",
        openMinute: 570,
        closeMinute: 960,
        observedAt: "2026-09-23T19:00:00.000Z",
        calendarRef: "d".repeat(64),
        sourceUrlOrArtifact: "fixture://market-calendar",
      },
      intradayOwnedQuantity: 0,
      brokerPositionQuantity: 0,
      executionQuote: {
        referencePrice: 501,
        referencePriceAt: "2026-09-23T19:29:59.000Z",
        bidPrice: 500,
        askPrice: 501,
        feed: "iex",
        priceBasis: "ask",
        sourceUrlOrArtifact: "fixture quote source",
        ageMs: 1000,
        maxAgeMs: 5000,
      },
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["still_relevant", "resolved"] as const)(
  "rechecks persisted strategy doubts in the original model call and records %s",
  async (disposition) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-feedback-"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T19:29:59.000Z"));
    const reassessment = {
      reason: "Spread erases this breakout's conditional upside.",
      recheckWhen: "Compare a fresh spread with this candidate's target distance.",
      alternativeHypothesis: "A range-reversion mechanism may fit; research only.",
    };
    const binding = {
      declarationRef: "a".repeat(64),
      activationRef: "b".repeat(64),
      declaredInstruments: ["SPY"],
      parameters: {
        openingRangeBars: 6,
        rewardRisk: 2,
        intervalSeconds: 300 as const,
        feed: "iex" as const,
      },
      scope: "strategy_universe" as const,
    };
    const base = {
      instrument: "SPY",
      sessionDate: "2026-09-23",
      action: "buy" as const,
      reason: "opening_range_breakout" as const,
      referencePrice: 500,
      referencePriceAt: "2026-09-23T19:29:59.000Z",
      datasetHeadRef: "c".repeat(64),
      strategyRule: "opening_range_breakout_long_next_bar_v1" as const,
      strategyBinding: binding,
    };
    const receipt = (
      packet: FinanceIntradayTradeDecisionReviewRequest,
      decision: {
        candidateId: string;
        decision: "approve" | "veto";
        rationale: string;
        strategyReassessment?: FinanceTradeDecision["strategyReassessment"];
        strategyFeedbackResponse?: {
          signalId: string;
          disposition: "still_relevant" | "resolved";
          reason: string;
        };
      },
    ) =>
      FinanceIntradayDecisionReviewReceiptSchema.parse({
        request: packet,
        status: "completed",
        attempted: true,
        provider: "offline-scripted",
        modelId: "fixture",
        latencyMs: 0,
        providerCallObserved: false,
        adapterAttested: false,
        decision,
      });
    try {
      await appendFinanceIntradayDecision(directory, { ...base, signalId: "prior-doubt" });
      const priorPacket: FinanceIntradayTradeDecisionReviewRequest = {
        ...intradayRequest,
        accountId: "paper-a",
        asOf: new Date().toISOString(),
        candidates: [{ ...intradayRequest.candidates[0], candidateId: "prior-doubt" }],
      };
      await appendFinanceIntradayOutcome(directory, {
        signalId: "prior-doubt",
        status: "refused",
        reasons: ["model veto"],
        tradeDecisionReview: receipt(priorPacket, {
          candidateId: "prior-doubt",
          decision: "veto",
          rationale: reassessment.reason,
          strategyReassessment: reassessment,
        }),
      });
      vi.setSystemTime(new Date(intradayRequest.asOf));
      const scope = {
        accountId: "paper-a",
        instrument: "SPY",
        ruleId: base.strategyRule,
        activationRef: binding.activationRef,
        asOf: intradayRequest.asOf,
        excludeSignalId: intradayRequest.candidates[0].candidateId,
      };
      const feedback = await readFinanceIntradayStrategyFeedback(directory, scope);
      expect(feedback).toMatchObject({
        origin: "model_hypothesis",
        signalId: "prior-doubt",
        reassessment,
      });
      for (const changed of [
        { accountId: "paper-b" },
        { instrument: "TLT" },
        { activationRef: "d".repeat(64) },
        { ruleId: "other" },
        { asOf: "2026-09-23T19:29:58.000Z" },
        { asOf: "2026-09-25T19:30:00.000Z" },
      ]) {
        expect(
          await readFinanceIntradayStrategyFeedback(directory, { ...scope, ...changed }),
        ).toBeUndefined();
      }
      const packet: FinanceIntradayTradeDecisionReviewRequest = {
        ...intradayRequest,
        accountId: "paper-a",
        strategyFeedback: feedback,
      };
      const model: LogicalAgentModelAdapter = {
        ...adapter(null),
        requiredSideEffects: [],
        observe: undefined,
        invoke: vi.fn(async (call) => {
          const supplied = call.payload as FinanceIntradayTradeDecisionReviewRequest;
          expect(supplied.strategyFeedback).toEqual(feedback);
          return {
            schemaVersion: packet.schemaVersion,
            decisions: [
              {
                candidateId: packet.candidates[0].candidateId,
                decision: disposition === "resolved" ? "approve" : "veto",
                rationale:
                  disposition === "resolved"
                    ? "Fresh quote resolves the old spread doubt."
                    : "Current spread still erases upside; leave cash.",
                strategyFeedbackResponse: {
                  signalId: supplied.strategyFeedback!.signalId,
                  disposition,
                  reason:
                    disposition === "resolved"
                      ? "Current spread is narrower relative to the supplied target distance."
                      : "Current spread remains larger than the supplied target distance.",
                },
                ...(disposition === "still_relevant" ? { strategyReassessment: reassessment } : {}),
              },
            ],
          };
        }),
      };
      const result = await createFinanceTradeDecisionReviewer({}, { adapterFactory: () => model })(
        packet,
        new AbortController().signal,
      );
      expect(result.status).toBe("completed");
      expect(result.providerCallObserved).toBe(false);
      expect(model.invoke).toHaveBeenCalledOnce();
      await appendFinanceIntradayDecision(directory, {
        ...base,
        signalId: packet.candidates[0].candidateId,
      });
      await appendFinanceIntradayOutcome(directory, {
        signalId: packet.candidates[0].candidateId,
        status: "refused",
        reasons: ["isolated fixture has no execution authority"],
        tradeDecisionReview: receipt(packet, result.decisions![0]),
      });
      expect(
        (await readFinanceIntradayOutcome(directory, packet.candidates[0].candidateId))
          ?.tradeDecisionReview?.decision?.strategyFeedbackResponse?.disposition,
      ).toBe(disposition);
      const next = await readFinanceIntradayStrategyFeedback(directory, {
        ...scope,
        excludeSignalId: "next-signal",
      });
      expect(next?.signalId).toBe(
        disposition === "resolved" ? undefined : packet.candidates[0].candidateId,
      );
      const coverage = await readFinanceIntradayExecutionCoverage(directory, packet.asOf);
      expect("strategyReassessments" in coverage ? coverage.strategyReassessments?.length : 0).toBe(
        disposition === "resolved" ? 0 : 1,
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it("rejects silent, forged and contradictory responses to supplied strategy feedback", () => {
  const packet: FinanceIntradayTradeDecisionReviewRequest = {
    ...intradayRequest,
    accountId: "paper-a",
    strategyFeedback: {
      origin: "model_hypothesis",
      signalId: "old",
      decisionRef: "a".repeat(64),
      outcomeRef: "b".repeat(64),
      accountId: "paper-a",
      instrument: "SPY",
      ruleId: intradayRequest.ruleIds[0],
      activationRef: "c".repeat(64),
      observedAt: "2026-09-23T19:29:00.000Z",
      expiresAt: "2026-09-24T19:29:00.000Z",
      reassessment: { reason: "Mechanism contradicted", recheckWhen: "Fresh evidence" },
    },
  };
  const decision = {
    candidateId: packet.candidates[0].candidateId,
    decision: "approve",
    rationale: "Current evidence",
  };
  for (const extra of [
    {},
    {
      strategyFeedbackResponse: {
        signalId: "wrong",
        disposition: "resolved",
        reason: "new evidence",
      },
    },
    {
      strategyFeedbackResponse: {
        signalId: "old",
        disposition: "still_relevant",
        reason: "unchanged",
      },
    },
    {
      strategyReassessment: { reason: "not suitable", recheckWhen: "later" },
      strategyFeedbackResponse: {
        signalId: "old",
        disposition: "resolved",
        reason: "new evidence",
      },
    },
  ]) {
    expect(
      parseFinanceTradeDecisionReviewOutput(
        { schemaVersion: packet.schemaVersion, decisions: [{ ...decision, ...extra }] },
        packet,
      ),
    ).toBeUndefined();
  }
  const output = {
    schemaVersion: packet.schemaVersion,
    decisions: [
      {
        ...decision,
        strategyFeedbackResponse: {
          signalId: "old",
          disposition: "resolved",
          reason: "Current conditions resolve it",
        },
      },
    ],
  };
  expect(parseFinanceTradeDecisionReviewOutput(output, packet)).toBeDefined();
  expect(
    parseFinanceTradeDecisionReviewOutput(output, { ...packet, accountId: "paper-b" }),
  ).toBeUndefined();
  expect(
    parseFinanceTradeDecisionReviewOutput(output, { ...packet, asOf: "2026-09-25T00:00:00.000Z" }),
  ).toBeUndefined();
});

it("uses the bound tool loop for a daily candidate without changing its execution authority", async () => {
  const execute = vi.fn(async () => ({
    ok: true,
    sourceUpdatedAt: "2026-09-22T12:00:00.000Z",
    finding: "A historical method is not a current market fact.",
  }));
  const first = adapter({
    schemaVersion: request.schemaVersion,
    hypothesis: "Check the retained method's scope for this daily candidate.",
    evidenceRequests: [
      {
        candidateId: request.candidates[0].candidateId,
        action: "financial_capability",
        toolName: "retained_method",
        moduleId: "credit_liquidity",
        question: "Does this method supply current market evidence?",
      },
    ],
  });
  const second = adapter({
    schemaVersion: request.schemaVersion,
    decisions: [
      {
        candidateId: request.candidates[0].candidateId,
        decision: "veto",
        rationale:
          "The retrieved historical method does not resolve the candidate's current evidence gap.",
      },
    ],
  });
  const result = await createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
      evidenceScope: {
        directory: "/fixture-retained-method-only",
        accountId: "paper-fixture",
        instruments: ["SPY"],
        financialCapabilities: [
          {
            toolName: "retained_method",
            moduleIds: ["credit_liquidity"],
            description: "Retained method only",
            execute,
          },
        ],
      },
    },
  )(request, AbortSignal.timeout(1000));
  expect(result).toMatchObject({ status: "completed", modelCalls: 2 });
  expect(result).not.toHaveProperty("quoteApprovalPolicy");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(vi.mocked(second.invoke).mock.calls[0][0].payload).toMatchObject({
    candidates: request.candidates,
    toolEvidence: [{ accountId: "paper-fixture", status: "completed" }],
  });
});

it("uses the host financial catalog, consumes a non-math result, and keeps the exact candidate", async () => {
  const execute = vi.fn<FinanceTradeReviewFinancialCapability["execute"]>(async (input) => {
    expect(input.moduleId).toBe("company_fundamentals_value");
    expect(input.candidate).toEqual(intradayRequest.candidates[0]);
    expect(Object.keys(input).toSorted()).toEqual([
      "accountId",
      "asOf",
      "candidate",
      "moduleId",
      "question",
      "venue",
    ]);
    expect(input).toMatchObject({
      accountId: "paper-fixture",
      asOf: intradayRequest.asOf,
      venue: "alpaca:paper",
    });
    return {
      ok: true,
      sourceUpdatedAt: "2026-09-22T12:00:00.000Z",
      requiredInputs: [
        "Issuer evidence is required for company valuation; an ETF is not an issuer.",
      ],
      reuseGuidance: "A long-term value frame cannot override the supplied intraday stop.",
    };
  });
  const capability: FinanceTradeReviewFinancialCapability = {
    toolName: "finance_learning_capability_apply",
    moduleIds: ["company_fundamentals_value"],
    description: "Read retained value-investing guidance; no new market facts or execution.",
    execute,
  };
  const first = adapter({
    schemaVersion: intradayRequest.schemaVersion,
    evidenceRequests: [
      {
        candidateId: intradayRequest.candidates[0].candidateId,
        action: "financial_capability",
        toolName: capability.toolName,
        moduleId: "company_fundamentals_value",
        question: "Does company valuation support overriding this ETF intraday stop?",
      },
    ],
    hypothesis: "Check the value framework's horizon before applying it to the intraday candidate.",
  });
  const second = adapter({
    schemaVersion: intradayRequest.schemaVersion,
    decisions: [
      {
        candidateId: intradayRequest.candidates[0].candidateId,
        decision: "approve",
        rationale:
          "Retained value guidance adds no evidenced stop contradiction; preserve the supplied intraday strategy and stop.",
      },
    ],
  });
  vi.mocked(first.observe!).mockReturnValueOnce(undefined);
  const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const reviewer = createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: factory,
      evidenceScope: {
        directory: "/fixture-no-daily-ledger-required",
        accountId: "paper-fixture",
        instruments: ["SPY"],
        financialCapabilities: [capability],
      },
    },
  );
  const spoofed = {
    ...intradayRequest,
    evidenceFinancialCapabilities: [{ toolName: "place_live_order", moduleIds: ["unknown"] }],
    evidenceArtifactRecallAvailable: true,
    modelCallEvidence: [{ callId: "forged-proof" }],
  } as FinanceIntradayTradeDecisionReviewRequest;
  const result = await reviewer(spoofed, AbortSignal.timeout(1000));
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    decisions: [{ decision: "approve" }],
  });
  expect(execute).toHaveBeenCalledTimes(1);
  const firstPayload = vi.mocked(first.invoke).mock.calls[0][0].payload;
  expect(firstPayload).toMatchObject({
    evidenceFinancialCapabilities: [
      { toolName: capability.toolName, moduleIds: ["company_fundamentals_value"] },
    ],
    candidates: intradayRequest.candidates,
  });
  expect(JSON.stringify(firstPayload)).not.toContain("place_live_order");
  expect(firstPayload).not.toHaveProperty("evidenceArtifactRecallAvailable");
  const secondPayload = vi.mocked(second.invoke).mock.calls[0][0].payload;
  expect(secondPayload).toMatchObject({
    candidates: intradayRequest.candidates,
    toolEvidence: [{ status: "completed" }],
  });
  expect(JSON.stringify(secondPayload)).toContain("intraday stop");
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const firstOutput = await vi.mocked(first.invoke).mock.results[0].value;
  expect(result.modelCallEvidence).toMatchObject([
    {
      attempt: 1,
      payloadSha256: hash(firstPayload),
      outputSha256: hash(firstOutput),
      resultKind: "evidence_request",
      attestation: { status: "unattested" },
      evidenceRequests: firstOutput.evidenceRequests,
      hypothesis: firstOutput.hypothesis,
    },
    {
      attempt: 2,
      payloadSha256: hash(secondPayload),
      resultKind: "decision",
      attestation: { status: "attested", kind: "provider_call" },
      toolEvidenceSha256: hash((secondPayload as { toolEvidence: unknown }).toolEvidence),
    },
  ]);
  expect(first.observe).toHaveBeenCalledTimes(1);
  expect(second.observe).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(firstPayload)).not.toContain("forged-proof");
  expect(isValidFinanceTradeDecisionReviewResult(result, intradayRequest)).toBe(true);
  expect(result.toolEvidence?.[0].accountId).toBe("paper-fixture");
  expect(result.toolEvidence?.[0].asOf).toBe(intradayRequest.asOf);
  expect(result.toolEvidence?.[0].boundary).not.toBe(
    "recorded_daily_history_research_only_no_execution_or_fresh_quote",
  );
});

it.each([
  { toolName: "finance_research_run", moduleId: "company_fundamentals_value" },
  { toolName: "finance_learning_capability_apply", moduleId: "options_volatility" },
  {
    toolName: "finance_learning_capability_apply",
    moduleId: "company_fundamentals_value",
    directory: "/untrusted",
  },
])(
  "rejects unregistered tools, out-of-scope modules and model-owned paths before dispatch: %j",
  async (fields) => {
    const execute = vi.fn<FinanceTradeReviewFinancialCapability["execute"]>(async () => ({
      ok: true,
    }));
    const first = adapter({
      schemaVersion: intradayRequest.schemaVersion,
      evidenceRequests: [
        {
          candidateId: intradayRequest.candidates[0].candidateId,
          action: "financial_capability",
          question: "Check the candidate horizon",
          ...fields,
        },
      ],
      hypothesis: "candidate-specific check",
    });
    const factory = vi.fn(() => first);
    const reviewer = createFinanceTradeDecisionReviewer(
      {},
      {
        adapterFactory: factory,
        evidenceScope: {
          directory: "/fixture-no-daily-ledger-required",
          accountId: "paper-fixture",
          instruments: ["SPY"],
          financialCapabilities: [
            {
              toolName: "finance_learning_capability_apply",
              moduleIds: ["company_fundamentals_value"],
              description: "read-only",
              execute,
            },
          ],
        },
      },
    );
    expect(await reviewer(intradayRequest, AbortSignal.timeout(1000))).toMatchObject({
      status: "failed",
      modelCalls: 1,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
  },
);

function adapter(output: unknown): LogicalAgentModelAdapter {
  return {
    id: "fixture",
    provider: "fixture-provider",
    modelId: "fixture-model",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: ["provider_call"],
    invoke: vi.fn(async () => output),
    observe: vi.fn((call) => ({
      ...call,
      transportRequestId: "fixture-private-request-id",
      kind: "provider_call" as const,
    })),
  };
}

it("keeps host measurement coverage authoritative without changing the model decision", async () => {
  const model = adapter({
    schemaVersion: request.schemaVersion,
    decisions: [
      {
        candidateId: request.candidates[0].candidateId,
        decision: "approve",
        rationale: "conditional",
      },
    ],
  });
  let prompt = "";
  const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
    adapterFactory: (_cfg, options) => ({
      ...model,
      invoke: async (call, signal) => {
        expect(call.payload).not.toHaveProperty("opportunityContext");
        expect(call.payload).not.toHaveProperty("measurementCoverage");
        expect(call.payload).not.toHaveProperty("sourceBindings");
        prompt = options!.buildPrompt!(call.payload);
        return model.invoke(call, signal);
      },
    }),
  });
  const result = await reviewer(
    {
      ...request,
      opportunityContext: { totalRoundTripCost: "forged-zero-cost" },
      measurementCoverage: { currentVolume: "forged-sufficient-volume" },
      sourceBindings: { fillSlippage: "forged-measurement" },
    } as FinanceTradeDecisionReviewRequest,
    new AbortController().signal,
  );
  expect(prompt).not.toContain("forged-");
  expect(prompt).toContain('"currentVolume":"not_supplied"');
  expect(prompt).toContain('"fullRoundTripCost":"not_supplied"');
  expect(prompt).toContain("/candidates/0/executionQuote/bidPrice");
  expect(result).toMatchObject({ status: "completed", decisions: [{ decision: "approve" }] });
  expect(model.invoke).toHaveBeenCalledTimes(1);
});

describe("configured finance trade decision reviewer", () => {
  it.each([true, false])(
    "uses low reasoning only when supported and preserves exact-candidate veto binding (reasoning=%s)",
    async (reasoning) => {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new Error("expected serialized model request");
        }
        const body = JSON.parse(init.body) as Record<string, unknown>;
        expect(body.reasoning_effort).toBe(reasoning ? "low" : undefined);
        const messages = body.messages as { content: string }[];
        expect(messages[0].content).toContain("SPY has no privileged status");
        expect(messages[0].content).toContain("does not need per-order human confirmation");
        expect(messages[0].content).toContain(
          "last evidence-based challenge of this exact candidate",
        );
        return new Response(
          JSON.stringify({
            id: "fixture-trade-review-reasoning",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
                    decisions: [
                      {
                        candidateId: request.candidates[0].candidateId,
                        decision: "veto",
                        rationale: "The supplied evidence contradicts this exact candidate.",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const cfg = {
        agents: { defaults: { model: { primary: "fixture/selected" } } },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              apiKey: "fixture-credential",
              models: [
                {
                  id: "selected",
                  name: "Selected",
                  reasoning,
                  compat: { supportsReasoningEffort: reasoning },
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000_000,
                  maxTokens: 384_000,
                },
              ],
            },
          },
        },
      } as OpenClawConfig;
      const reviewer = createFinanceTradeDecisionReviewer(cfg);

      const result = await reviewer(request, AbortSignal.timeout(1000));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
      if (typeof requestBody !== "string") {
        throw new Error("expected serialized JSON body");
      }
      expect(JSON.parse(requestBody).max_tokens).toBe(384_000);
      expect(result).toMatchObject({
        status: "completed",
        attempted: true,
        modelId: "selected",
        decisions: [{ candidateId: request.candidates[0].candidateId, decision: "veto" }],
      });
      expect(result.modelCalls).toBe(1);
    },
  );

  it("does not impose an all-evidence-complete veto on daily or intraday candidates", () => {
    const prompts: string[] = [];
    createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: (_cfg, options) => {
        if (!options?.buildPrompt) {
          throw new Error("review prompt builder missing");
        }
        prompts.push(options.buildPrompt(request), options.buildPrompt(intradayRequest));
        return adapter(null);
      },
    });
    for (const prompt of prompts) {
      expect(prompt).toContain(
        "Incomplete or conflicting auxiliary evidence alone is not a mandatory veto",
      );
      expect(prompt).toContain("label that as model judgment");
      expect(prompt).toContain("economic decision reviewer");
      expect(prompt).toContain("consumed their results");
      expect(prompt).toContain("no profit forecast or proof is a prerequisite");
      expect(prompt).toContain("Never force activity to satisfy a target");
      expect(prompt).toContain("Use the smallest sufficient subset of capabilities");
      expect(prompt).toContain("supplied facts and simple quantitative reasoning first");
      expect(prompt).toContain("finance_trade_result_recall");
      expect(prompt).toContain("a past refusal is not a current veto");
      expect(prompt).toContain("reassess the doubt and decide when evidence suffices");
      expect(prompt).toContain("never call every level by habit");
      expect(prompt).toContain("Full research or all modules passing is not a prerequisite");
      expect(prompt).toContain("Do not seek simulator-only advantages");
      expect(prompt).toContain("IEX observations are not the consolidated market");
      expect(prompt).toContain("never Live authority");
      expect(prompt).toContain("Never add candidates or change instrument");
      expect(prompt).not.toContain("If evidence is incomplete, contradictory, or not sufficient");
    }
  });

  it("exposes conditional geometry to the original reviewer without treating close as a target deadline", () => {
    let prompt = "";
    const packet: FinanceIntradayTradeDecisionReviewRequest = {
      ...intradayRequest,
      candidates: [{ ...intradayRequest.candidates[0], targetPrice: 557 }],
    };
    createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: (_cfg, options) => {
        prompt = options!.buildPrompt!(packet);
        return adapter(null);
      },
    });
    const start = prompt.indexOf("Deterministic opportunity context");
    const context = JSON.parse(prompt.slice(start).split("\n")[1]);
    expect(context).toEqual(buildFinanceOpportunityContext(packet));
    expect(context[0].conditionalUpsideFraction).toBeCloseTo(56 / 501, 12);
    expect(context[0].plannedHoldingHorizonMinutes).toBeNull();
    expect(prompt).toContain("session close is not a declared holding deadline");
    expect(prompt).toContain("frame a testable question");
    expect(prompt).toContain("Daily history can describe historical scale");
    expect(prompt).toContain("if the packet already suffices, decide directly");
  });

  it("uses model capacity while retaining call and timeout budgets", () => {
    const model = adapter(null);
    const adapterFactory = vi.fn<typeof createConfiguredFinanceModelAdapter>(() => model);

    createFinanceTradeDecisionReviewer({} as OpenClawConfig, { adapterFactory });

    expect(adapterFactory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxCalls: 1, timeoutMs: 60_000 }),
    );
    expect(adapterFactory.mock.calls[0]?.[1]).not.toHaveProperty("maxTokens");
  });

  it("returns only exact candidate-bound approve/veto decisions and hashes transport identity", async () => {
    const model = adapter({
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: request.candidates[0].candidateId,
          decision: "approve",
          rationale: "The proposed rebalance fits the supplied evidence and limits.",
        },
      ],
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
      now: vi.fn().mockReturnValueOnce(100).mockReturnValue(125),
    });

    const result = await reviewer(request, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "completed",
      attempted: true,
      provider: "fixture-provider",
      modelId: "fixture-model",
      latencyMs: 25,
      providerCallObserved: true,
      adapterAttested: true,
      decisions: [{ candidateId: request.candidates[0].candidateId, decision: "approve" }],
    });
    expect(result.requestIdSha256).toMatch(/^[a-f\d]{64}$/u);
    expect(JSON.stringify(result)).not.toContain("fixture-private-request-id");
    expect(model.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ role: "risk_check", payload: request }),
      expect.any(AbortSignal),
    );
    expect(result.modelCalls).toBe(1);
  });

  it("does not claim an observed provider call when the adapter has no transport attestation", async () => {
    const model = adapter({
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: request.candidates[0].candidateId,
          decision: "approve",
          rationale: "The supplied evidence supports this exact candidate.",
        },
      ],
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => ({ ...model, observe: undefined }),
    });

    const result = await reviewer(request, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "completed",
      attempted: true,
      modelCalls: 1,
      providerCallObserved: false,
      adapterAttested: false,
    });
    expect(result.requestIdSha256).toBeUndefined();
  });

  it("keeps local model inference evidence distinct from a provider call", async () => {
    const model = adapter({
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: request.candidates[0].candidateId,
          decision: "approve",
          rationale: "The supplied evidence supports this exact candidate.",
        },
      ],
    });
    const localModel = {
      ...model,
      observe: vi.fn((call) => ({
        ...call,
        transportRequestId: "local-inference-receipt",
        kind: "model_inference" as const,
      })),
    };
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => localModel,
    });

    const result = await reviewer(request, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "completed",
      providerCallObserved: false,
      adapterAttested: true,
    });
    expect(result.requestIdSha256).toMatch(/^[a-f\d]{64}$/u);
  });

  it("reports provider truncation without spending a second call", async () => {
    const truncated = adapter(null);
    vi.mocked(truncated.invoke).mockRejectedValueOnce(new ModelAdapterError("output_truncated"));
    const adapterFactory = vi.fn(() => truncated);
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, { adapterFactory });
    const result = await reviewer(request, AbortSignal.timeout(1000));
    expect(result).toMatchObject({
      status: "failed",
      failureCode: "output_truncated",
      modelCalls: 1,
    });
    expect(result.modelCallEvidence?.map((call) => call.resultKind)).toEqual(["output_truncated"]);
    expect(adapterFactory).toHaveBeenCalledTimes(1);
    expect(truncated.invoke).toHaveBeenCalledTimes(1);
  });

  it("adds the quote policy only to successful host intraday results", async () => {
    const output = (packet: FinanceTradeDecisionReviewRequest) => ({
      schemaVersion: packet.schemaVersion,
      decisions: [
        {
          candidateId: packet.candidates[0].candidateId,
          decision: "approve",
          rationale: "Supported exact candidate.",
        },
      ],
    });
    const intraday = await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: () => adapter(output(intradayRequest)) },
    )(intradayRequest, new AbortController().signal);
    expect(intraday.quoteApprovalPolicy).toBe(FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY);
    expect(isValidFinanceTradeDecisionReviewResult(intraday, intradayRequest)).toBe(true);
    expect(
      isValidFinanceTradeDecisionReviewResult(
        { ...intraday, quoteApprovalPolicy: "ignore_quote" },
        intradayRequest,
      ),
    ).toBe(false);
    expect(
      isValidFinanceTradeDecisionReviewResult(
        { ...intraday, quoteApprovalPolicy: undefined },
        intradayRequest,
      ),
    ).toBe(true);
    const daily = await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: () => adapter(output(request)) },
    )(request, new AbortController().signal);
    expect(daily).not.toHaveProperty("quoteApprovalPolicy");
    const forged = await createFinanceTradeDecisionReviewer(
      {},
      {
        adapterFactory: () =>
          adapter({
            ...output(intradayRequest),
            quoteApprovalPolicy: FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY,
          }),
      },
    )(intradayRequest, new AbortController().signal);
    expect(forged).toMatchObject({ status: "failed", failureCode: "output_contract" });
    expect(forged).not.toHaveProperty("quoteApprovalPolicy");
  });

  it.each([
    "provider_rate_limit",
    "provider_payment_required",
    "prompt_input_invalid",
    "prompt_budget_exceeded",
  ] as const)("does not retry provider error %s", async (failureCode) => {
    const model = adapter(null);
    vi.mocked(model.invoke).mockRejectedValueOnce(new ModelAdapterError(failureCode));
    const adapterFactory = vi.fn(() => model);
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, { adapterFactory });

    const result = await reviewer(request, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "failed",
      failureCode,
      modelCalls: 1,
    });
    expect(adapterFactory).toHaveBeenCalledOnce();
  });

  it("binds an intraday review to one exact signal and its own response schema", async () => {
    const model = adapter({
      schemaVersion: FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: intradayRequest.candidates[0].candidateId,
          decision: "approve",
          rationale: "The supplied signal, quote, and reconciled account facts are consistent.",
        },
      ],
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
    });

    const result = await reviewer(intradayRequest, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "completed",
      decisions: [{ candidateId: "intraday-signal-1", decision: "approve" }],
    });
    expect(model.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ role: "risk_check", payload: intradayRequest }),
      expect.any(AbortSignal),
    );
  });

  it("accepts a versioned pre-close sell candidate for review", async () => {
    const preCloseRequest: FinanceIntradayTradeDecisionReviewRequest = {
      ...intradayRequest,
      signalAnchor: "intraday-pre-close-signal",
      ruleIds: ["opening_range_breakout_long_pre_close_v2"],
      candidates: [
        {
          ...intradayRequest.candidates[0],
          side: "sell",
          strategyRule: "opening_range_breakout_long_pre_close_v2",
          signalReason: "pre_close",
          intradayOwnedQuantity: 1,
          brokerPositionQuantity: 1,
        },
      ],
    };
    const model = adapter({
      schemaVersion: FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: preCloseRequest.candidates[0].candidateId,
          decision: "approve",
          rationale: "The pre-close policy is bound to the active versioned rule.",
        },
      ],
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
    });

    const result = await reviewer(preCloseRequest, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "completed",
      decisions: [{ candidateId: "intraday-signal-1", decision: "approve" }],
    });
  });

  it("does not accept a daily-review response schema for an intraday request", async () => {
    const model = adapter({
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: intradayRequest.candidates[0].candidateId,
          decision: "approve",
          rationale: "Wrong response contract.",
        },
      ],
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
    });

    const result = await reviewer(intradayRequest, AbortSignal.timeout(1000));

    expect(result).toMatchObject({ status: "failed", failureCode: "output_contract" });
    expect(result.decisions).toBeUndefined();
  });

  it.each([
    {
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: "invented:TSLA:buy",
          decision: "approve",
          rationale: "Invented candidate.",
        },
      ],
    },
    {
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: request.candidates[0].candidateId,
          decision: "approve",
          rationale: "Approved.",
        },
        {
          candidateId: request.candidates[0].candidateId,
          decision: "veto",
          rationale: "Duplicate.",
        },
      ],
    },
    {
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: request.candidates[0].candidateId,
          decision: "buy",
          rationale: "Model must not choose an order side.",
        },
      ],
    },
  ])("fails closed on an output outside the decision contract", async (output) => {
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => adapter(output),
    });

    const result = await reviewer(request, AbortSignal.timeout(1000));

    expect(result).toMatchObject({ status: "failed", failureCode: "output_contract" });
    expect(result.decisions).toBeUndefined();
  });

  it("records bounded provider failure codes without leaking transport or exception text", async () => {
    const model = adapter(null);
    vi.mocked(model.invoke).mockRejectedValueOnce(new Error("synthetic provider secret"));
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
    });

    const result = await reviewer(request, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "failed",
      attempted: true,
      failureCode: "process_error",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic provider secret");
  });

  it("classifies an aborted review deadline without exposing the abort reason", async () => {
    const model = adapter(null);
    vi.mocked(model.invoke).mockImplementation(async (_call, signal) => {
      throw signal.reason;
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
    });
    const controller = new AbortController();
    controller.abort(new DOMException("synthetic deadline", "TimeoutError"));

    const result = await reviewer(request, controller.signal);

    expect(result).toMatchObject({ status: "failed", failureCode: "runtime_timeout" });
    expect(JSON.stringify(result)).not.toContain("synthetic deadline");
  });
});

it("keeps conditional upside separate from net expected value and handles unknown quote costs", () => {
  expect(buildFinanceOpportunityContext(intradayRequest)[0]).toMatchObject({
    spreadPerUnit: 1,
    conditionalUpsidePerUnit: 3,
    plannedStopDistancePerUnit: 3,
    totalRoundTripCost: null,
    netExpectedValue: null,
  });
  const candidate = intradayRequest.candidates[0];
  expect(
    buildFinanceOpportunityContext({
      ...intradayRequest,
      candidates: [
        { ...candidate, executionQuote: { ...candidate.executionQuote, bidPrice: undefined } },
      ],
    })[0],
  ).toMatchObject({ spreadPerUnit: null, conditionalUpsidePerUnit: null, netExpectedValue: null });
  expect(
    buildFinanceOpportunityContext({
      ...intradayRequest,
      candidates: [{ ...candidate, targetPrice: 500 }],
    })[0],
  ).toMatchObject({ conditionalUpsidePerUnit: -1 });
});
it("persists a candidate-bound opportunity hypothesis without treating it as measured consensus", async () => {
  const expectationGap = {
    origin: "model_hypothesis",
    edgeKind: "timing",
    marketExpectation: null,
    variantView: "A supplied breakout may continue despite uncertain fundamental consensus.",
    catalyst: "Continuation during this session",
    invalidation: "Supplied stop fails",
    costRiskAssessment: "Spread known; fees, slippage and expected win rate unknown.",
  };
  const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
    adapterFactory: () =>
      adapter({
        schemaVersion: intradayRequest.schemaVersion,
        decisions: [
          {
            candidateId: intradayRequest.candidates[0].candidateId,
            decision: "approve",
            rationale: "Trade the supplied signal within its Paper budget.",
            expectationGap,
          },
        ],
      }),
  });
  const result = await reviewer(intradayRequest, AbortSignal.timeout(1000));
  expect(result).toMatchObject({
    status: "completed",
    decisions: [{ decision: "approve", expectationGap }],
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "expectation-gap-"));
  try {
    await appendFinanceIntradayDecision(directory, {
      signalId: "intraday-signal-1",
      instrument: "SPY",
      sessionDate: "2026-09-23",
      action: "buy",
      reason: "opening_range_breakout",
      referencePrice: 500,
      referencePriceAt: "2026-09-23T19:29:55.000Z",
      datasetHeadRef: "c".repeat(64),
      strategyRule: "opening_range_breakout_long_next_bar_v1",
    });
    await appendFinanceIntradayOutcome(directory, {
      signalId: "intraday-signal-1",
      status: "refused",
      reasons: ["synthetic fixture, no broker execution"],
      tradeDecisionReview: FinanceIntradayDecisionReviewReceiptSchema.parse({
        request: intradayRequest,
        status: "completed",
        attempted: result.attempted,
        provider: result.provider,
        modelId: result.modelId,
        latencyMs: result.latencyMs,
        providerCallObserved: result.providerCallObserved,
        adapterAttested: result.adapterAttested,
        decision: result.decisions?.[0],
      }),
    });
    expect(await readFinanceIntradayOutcome(directory, "intraday-signal-1")).toMatchObject({
      tradeDecisionReview: { decision: { expectationGap } },
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
it.each(["verified_fact", "market_consensus"])(
  "rejects an assessment that upgrades model origin to %s",
  async (origin) => {
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () =>
        adapter({
          schemaVersion: request.schemaVersion,
          decisions: [
            {
              candidateId: request.candidates[0].candidateId,
              decision: "approve",
              rationale: "fixture",
              expectationGap: {
                origin,
                edgeKind: "unknown",
                marketExpectation: null,
                variantView: null,
                catalyst: null,
                invalidation: null,
                costRiskAssessment: null,
              },
            },
          ],
        }),
    });
    expect(await reviewer(request, AbortSignal.timeout(1000))).toMatchObject({ status: "failed" });
  },
);

it.each([
  { hypothesis: "x".repeat(240), accepted: true },
  { hypothesis: "疑".repeat(80), accepted: true },
  { hypothesis: "疑".repeat(81), accepted: false },
])(
  "aligns evidence hypothesis guidance and consumption with UTF8 bytes: %j",
  async ({ hypothesis, accepted }) => {
    const execute = vi.fn(async () => ({ ok: true, value: "recorded method" }));
    const capability: FinanceTradeReviewFinancialCapability = {
      toolName: "fixture_method_read",
      moduleIds: ["finance_learning_memory"],
      description: "Read a recorded method without market facts or execution.",
      execute,
    };
    const first = adapter({
      schemaVersion: intradayRequest.schemaVersion,
      evidenceRequests: [
        {
          candidateId: intradayRequest.candidates[0].candidateId,
          action: "financial_capability",
          toolName: capability.toolName,
          moduleId: "finance_learning_memory",
          question: "Check the retained method.",
        },
      ],
      hypothesis,
    });
    const second = adapter({
      schemaVersion: intradayRequest.schemaVersion,
      decisions: [
        {
          candidateId: intradayRequest.candidates[0].candidateId,
          decision: "approve",
          rationale: "The recorded method adds no candidate-specific contradiction.",
        },
      ],
    });
    let prompt = "";
    const models = [first, second];
    const factory = vi.fn<typeof createConfiguredFinanceModelAdapter>((_cfg, options) => {
      const model = models.shift()!;
      return {
        ...model,
        invoke: async (call, signal) => {
          prompt ||= options!.buildPrompt!(call.payload);
          if (model === second) {
            expect(call.payload).toMatchObject({ evidenceHypothesis: hypothesis });
          }
          return model.invoke(call, signal);
        },
      };
    });
    const reviewer = createFinanceTradeDecisionReviewer(
      {},
      {
        adapterFactory: factory,
        evidenceScope: {
          directory: "/fixture-method-only",
          accountId: "paper-fixture",
          instruments: ["SPY"],
          financialCapabilities: [capability],
        },
      },
    );
    const result = await reviewer(intradayRequest, AbortSignal.timeout(1000));
    expect(prompt).toContain("Hypothesis at most 240 UTF-8 bytes");
    expect(prompt).not.toContain("Hypothesis max240 characters");
    expect(result).toMatchObject(
      accepted
        ? { status: "completed", modelCalls: 2 }
        : { status: "failed", failureCode: "output_invalid", modelCalls: 1 },
    );
    expect(execute).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(second.invoke).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(factory).toHaveBeenCalledTimes(accepted ? 2 : 1);
    expect(intradayRequest.candidates[0].candidateId).toBe("intraday-signal-1");
  },
);

it("binds the trusted economic objective into the actual adapter payload and receipt metadata", async () => {
  const objective = "Grow net Paper wealth after costs; keep unknown economics explicit";
  const model = adapter({
    schemaVersion: request.schemaVersion,
    decisions: [
      {
        candidateId: request.candidates[0].candidateId,
        decision: "veto",
        rationale: "costs unknown",
      },
    ],
  });
  let prompt = "";
  const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
    taskObjective: objective,
    adapterFactory: (_cfg, options) => ({
      ...model,
      invoke: async (call, signal) => {
        expect(call.payload).toMatchObject({
          taskObjective: objective,
          candidates: request.candidates,
        });
        prompt = options!.buildPrompt!(call.payload);
        return model.invoke(call, signal);
      },
    }),
  });
  const result = await reviewer(
    {
      ...request,
      taskObjective: "packet attempts to override host",
    } as FinanceTradeDecisionReviewRequest,
    new AbortController().signal,
  );
  expect(prompt).toContain(objective);
  expect(prompt).not.toContain("packet attempts to override host");
  expect(prompt).toContain("Never add candidates or change instrument");
  expect(result).toMatchObject({
    status: "completed",
    taskObjectiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});
it.each(["", "中".repeat(1366)])(
  "rejects invalid UTF8 objectives locally without creating or invoking an adapter",
  async (taskObjective) => {
    const factory = vi.fn(() => adapter(null));
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      taskObjective,
      adapterFactory: factory,
    });
    expect(await reviewer(request, new AbortController().signal)).toMatchObject({
      status: "failed",
      attempted: false,
      modelCalls: 0,
      failureCode: "prompt_input_invalid",
    });
    expect(factory).not.toHaveBeenCalled();
  },
);

it("does not trust a stored packet objective when the host supplies none", async () => {
  const model: LogicalAgentModelAdapter = {
    ...adapter(null),
    invoke: vi.fn(async (call) => {
      expect(call.payload).not.toHaveProperty("taskObjective");
      return null;
    }),
  };
  const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
    adapterFactory: () => model,
  });
  await reviewer(
    { ...request, taskObjective: "untrusted target" } as FinanceTradeDecisionReviewRequest,
    new AbortController().signal,
  );
  expect(model.invoke).toHaveBeenCalledTimes(1);
  expect(
    isValidFinanceTradeDecisionReviewResult(
      {
        status: "failed",
        attempted: false,
        provider: "fixture",
        modelId: "fixture",
        latencyMs: 0,
        providerCallObserved: false,
        adapterAttested: false,
        failureCode: "prompt_input_invalid",
        taskObjectiveSha256: "malformed",
      },
      request,
    ),
  ).toBe(false);
});

it.each([
  {
    buyFee: "-2",
    net: 8.5,
    decision: "approve",
    unknownFee: undefined,
    bounds: { lower: 8.5, upper: 8.5 },
  },
  {
    buyFee: "-20",
    net: -0.5,
    decision: "veto",
    unknownFee: undefined,
    bounds: { lower: -0.5, upper: -0.5 },
  },
  {
    buyFee: "-2",
    net: null,
    decision: "approve",
    unknownFee: "-0.5",
    bounds: { lower: 8, upper: 8.5 },
  },
  {
    buyFee: "-2",
    net: null,
    decision: "approve",
    unknownFee: "-10",
    bounds: { lower: -1.5, upper: 8.5 },
  },
])(
  "consumes recorded net accounting, preserves the candidate and persists the result: %j",
  async ({ buyFee, net, decision, unknownFee, bounds }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-fill-feedback-"));
    try {
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "paper-fixture",
        venue: "alpaca:paper",
        query: "activities:fixture",
        cursor: "",
        payload: [
          {
            id: "buy",
            order_id: "buy-order",
            activity_type: "FILL",
            type: "fill",
            symbol: "SPY",
            side: "buy",
            qty: "2",
            price: "100",
            transaction_time: "2026-09-23T19:00:00Z",
          },
          {
            id: "sell",
            order_id: "sell-order",
            activity_type: "FILL",
            type: "fill",
            symbol: "SPY",
            side: "sell",
            qty: "1",
            price: "110",
            transaction_time: "2026-09-23T19:10:00Z",
          },
          {
            id: "buy-fee",
            order_id: "buy-order",
            activity_type: "FEE",
            status: "executed",
            currency: "USD",
            net_amount: buyFee,
            transaction_time: "2026-09-23T19:00:01Z",
          },
          {
            id: "sell-fee",
            order_id: "sell-order",
            activity_type: "FEE",
            status: "executed",
            currency: "USD",
            net_amount: "-0.5",
            transaction_time: "2026-09-23T19:10:01Z",
          },
          ...(unknownFee === undefined
            ? []
            : [
                {
                  id: "unlinked-fee",
                  activity_type: "FEE",
                  status: "executed",
                  currency: "USD",
                  net_amount: unknownFee,
                  transaction_time: "2026-09-23T19:10:02Z",
                },
              ]),
        ],
      });
      await appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "paper-fixture",
        venue: "alpaca:paper",
        query: "reconciliation:2026-09-23T19:29:59.000Z",
        cursor: "",
        payload: [
          {
            observedAt: "2026-09-23T19:29:59.000Z",
            status: "reconciled",
            feesInterpreted: true,
            cashDifference: 0,
            issues: [],
            differences: [],
            positions: [],
          },
        ],
      });
      const first = adapter({
        schemaVersion: intradayRequest.schemaVersion,
        evidenceRequests: [
          {
            candidateId: intradayRequest.candidates[0].candidateId,
            action: "broker_fill_feedback",
          },
        ],
        hypothesis: "Does the recorded gross profit remain positive after allocated fees?",
      });
      // A deterministic consumer verifies transport and causality, not a real model's tool choice.
      const second: LogicalAgentModelAdapter = {
        ...adapter(null),
        invoke: vi.fn(async (call) => {
          const payload = call.payload as {
            candidates: unknown;
            toolEvidence: readonly { status: string; summary: string; boundary: string }[];
          };
          expect(payload.candidates).toEqual(intradayRequest.candidates);
          expect(payload.toolEvidence).toHaveLength(1);
          expect(payload.toolEvidence[0].status).toBe("completed");
          expect(payload.toolEvidence[0].boundary).toBe(
            "recorded_broker_fill_feedback_not_strategy_edge_or_expected_return",
          );
          const facts = (
            JSON.parse(payload.toolEvidence[0].summary) as {
              result: { economics: Record<string, unknown> };
            }
          ).result.economics;
          expect(facts.grossMatchedPnl).toBe(10);
          expect(facts.netMatchedPnl).toBe(net);
          expect(facts.openLotCount).toBe(1);
          expect(facts.recordedCashFeePnlBounds).toEqual(bounds);
          const consumedNet = facts.netMatchedPnl as number | null;
          const consumedBounds = facts.recordedCashFeePnlBounds as { lower: number; upper: number };
          return {
            schemaVersion: intradayRequest.schemaVersion,
            decisions: [
              {
                candidateId: intradayRequest.candidates[0].candidateId,
                decision: consumedNet === null || consumedNet > 0 ? "approve" : "veto",
                rationale: `Recorded FIFO gross=10; net=${consumedNet}; possible recorded cash-fee allocation is [${consumedBounds.lower},${consumedBounds.upper}]. Unknown allocation does not create a mandatory veto or establish this strategy's edge.`,
              },
            ],
          };
        }),
      };
      let prompt = "";
      const models = [first, second];
      const factory = vi.fn<typeof createConfiguredFinanceModelAdapter>((_cfg, options) => {
        const model = models.shift()!;
        return {
          ...model,
          invoke: async (call, signal) => {
            prompt = options!.buildPrompt!(call.payload);
            return model.invoke(call, signal);
          },
        };
      });
      const reviewer = createFinanceTradeDecisionReviewer(
        {},
        {
          adapterFactory: factory,
          maxCandidateModelCalls: 2,
          evidenceScope: { directory, accountId: "paper-fixture", instruments: ["SPY"] },
        },
      );
      const result = await reviewer(intradayRequest, AbortSignal.timeout(5000));
      expect(result).toMatchObject({
        status: "completed",
        modelCalls: 2,
        decisions: [{ decision }],
      });
      expect(isValidFinanceTradeDecisionReviewResult(result, intradayRequest)).toBe(true);
      expect(prompt).toContain("Cash reconciliation does not prove fee allocation");
      expect(prompt).toContain("never substitute them for exact or full-cost net profit");
      expect(result.decisions?.[0].rationale).toContain(`[${bounds.lower},${bounds.upper}]`);
      expect(second.invoke).toHaveBeenCalledTimes(1);
      expect(
        await reviewer(intradayRequest, AbortSignal.timeout(1000), { maxModelCalls: 1 }),
      ).toMatchObject({
        status: "failed",
        attempted: false,
        modelCalls: 0,
        failureCode: "call_budget_exhausted",
      });
      expect(factory).toHaveBeenCalledTimes(2);
      await appendFinanceIntradayDecision(directory, {
        signalId: intradayRequest.signalAnchor,
        instrument: "SPY",
        sessionDate: "2026-09-23",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-23T19:29:55.000Z",
        datasetHeadRef: "c".repeat(64),
        strategyRule: "opening_range_breakout_long_next_bar_v1",
      });
      const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
        request: intradayRequest,
        status: result.status,
        attempted: result.attempted,
        modelCalls: result.modelCalls,
        provider: result.provider,
        modelId: result.modelId,
        latencyMs: result.latencyMs,
        providerCallObserved: result.providerCallObserved,
        adapterAttested: result.adapterAttested,
        toolEvidence: result.toolEvidence,
        decision: result.decisions?.[0],
      });
      await appendFinanceIntradayOutcome(directory, {
        signalId: intradayRequest.signalAnchor,
        status: "refused",
        reasons: ["Synthetic acceptance only"],
        tradeDecisionReview: receipt,
      });
      const stored = await readFinanceIntradayOutcome(directory, intradayRequest.signalAnchor);
      expect(stored?.tradeDecisionReview).toEqual(receipt);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["cyclic", "bigint"])(
  "preserves original invalid-input failure without invented proof (%s)",
  async (kind) => {
    const extra: Record<string, unknown> = {};
    extra.value = kind === "cyclic" ? extra : 1n;
    const invalid = { ...intradayRequest, extra } as FinanceIntradayTradeDecisionReviewRequest;
    const model = adapter(null);
    vi.mocked(model.invoke).mockRejectedValueOnce(new ModelAdapterError("prompt_input_invalid"));
    vi.mocked(model.observe!).mockReturnValueOnce(undefined);
    const reviewer = createFinanceTradeDecisionReviewer({}, { adapterFactory: () => model });
    const result = await reviewer(invalid, AbortSignal.timeout(1000));
    expect(result).toMatchObject({
      status: "failed",
      failureCode: "prompt_input_invalid",
      modelCalls: 1,
    });
    expect(result.modelCallEvidence).toBeUndefined();
    expect(isValidFinanceTradeDecisionReviewResult(result, intradayRequest)).toBe(true);
    expect(model.invoke).toHaveBeenCalledTimes(1);
  },
);

describe("candidate-wide reviewer call budget", () => {
  const approval = (packet: FinanceTradeDecisionReviewRequest = intradayRequest) => ({
    schemaVersion: packet.schemaVersion,
    decisions: [
      {
        candidateId: packet.candidates[0].candidateId,
        decision: "approve",
        rationale: "Review the exact host plan.",
      },
    ],
  });

  it("uses fresh adapters for a one-call quote re-review, but never resets the shared native pool", async () => {
    const models: LogicalAgentModelAdapter[] = [];
    const factory = vi.fn<typeof createConfiguredFinanceModelAdapter>((_cfg, options) => {
      const base = adapter(approval());
      const model: LogicalAgentModelAdapter = {
        ...base,
        invoke: vi.fn(async (call, signal) => {
          options!.callBudget!.reserve();
          return base.invoke(call, signal);
        }),
      };
      models.push(model);
      return model;
    });
    const reviewer = createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: factory, maxCandidateModelCalls: 2 },
    );
    expect(await reviewer(intradayRequest, new AbortController().signal)).toMatchObject({
      status: "completed",
      modelCalls: 1,
    });
    expect(
      await reviewer(intradayRequest, new AbortController().signal, { maxModelCalls: 1 }),
    ).toMatchObject({ status: "completed", modelCalls: 1 });
    expect(factory.mock.calls[0][1]!.callBudget).toBe(factory.mock.calls[1][1]!.callBudget);
    expect(factory.mock.calls[0][1]!.callBudget!.snapshot()).toEqual({
      limit: 2,
      reserved: 2,
      remaining: 0,
    });
    expect(await reviewer(intradayRequest, new AbortController().signal)).toMatchObject({
      status: "failed",
      attempted: false,
      modelCalls: 0,
      failureCode: "call_budget_exhausted",
    });
    expect(models).toHaveLength(2);
    expect(models[0].invoke).toHaveBeenCalledTimes(1);
    expect(models[1].invoke).toHaveBeenCalledTimes(1);
  });

  it("bounds actual configured-adapter transport to two requests across re-entry", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "fixture-shared-budget",
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(approval()) } }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "fixture/selected" } } },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            apiKey: "fixture-credential",
            models: [
              {
                id: "selected",
                name: "Selected",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1000000,
                maxTokens: 384000,
              },
            ],
          },
        },
      },
    };
    const reviewer = createFinanceTradeDecisionReviewer(cfg, { maxCandidateModelCalls: 2 });
    expect(await reviewer(intradayRequest, new AbortController().signal)).toMatchObject({
      status: "completed",
      modelCalls: 1,
      providerCallObserved: true,
    });
    expect(
      await reviewer(intradayRequest, new AbortController().signal, { maxModelCalls: 1 }),
    ).toMatchObject({ status: "completed", modelCalls: 1, providerCallObserved: true });
    expect(await reviewer(intradayRequest, new AbortController().signal)).toMatchObject({
      status: "failed",
      attempted: false,
      failureCode: "call_budget_exhausted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps injected adapters at two calls even when they never reserve or report misleading output metadata", async () => {
    const model = adapter(approval());
    const factory = vi.fn(() => model);
    const reviewer = createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: factory, maxCandidateModelCalls: 2 },
    );
    for (let call = 0; call < 4; call++) {
      const result = await reviewer(intradayRequest, new AbortController().signal, {
        maxModelCalls: 1,
      });
      expect(result.status).toBe(call < 2 ? "completed" : "failed");
      expect(result.modelCalls).toBe(call < 2 ? 1 : 0);
    }
    expect(model.invoke).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("disables new evidence on a trusted one-call re-review", async () => {
    const model = adapter({
      schemaVersion: intradayRequest.schemaVersion,
      evidenceRequests: [
        { candidateId: intradayRequest.candidates[0].candidateId, action: "daily_closes" },
      ],
      hypothesis: "Request fresh evidence.",
    });
    const reviewer = createFinanceTradeDecisionReviewer(
      {},
      {
        adapterFactory: () => model,
        evidenceScope: { directory: "/fixture", accountId: "paper", instruments: ["SPY"] },
      },
    );
    const result = await reviewer(intradayRequest, new AbortController().signal, {
      maxModelCalls: 1,
    });
    expect(result).toMatchObject({
      status: "failed",
      failureCode: "output_invalid",
      modelCalls: 1,
    });
    expect(vi.mocked(model.invoke).mock.calls[0][0].payload).not.toHaveProperty(
      "evidenceToolsAvailable",
    );
    expect(result).not.toHaveProperty("toolEvidence");
    expect(model.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    { maxModelCalls: 0 },
    { maxModelCalls: 5 },
    { maxModelCalls: 1.5 },
    { maxModelCalls: "1" },
    { maxModelCalls: 1, resetBudget: true },
  ])("rejects malformed host options before dispatch: %j", async (options) => {
    const model = adapter(approval());
    const reviewer = createFinanceTradeDecisionReviewer({}, { adapterFactory: () => model });
    expect(
      await reviewer(
        intradayRequest,
        new AbortController().signal,
        options as FinanceTradeDecisionReviewHostOptions,
      ),
    ).toMatchObject({
      status: "failed",
      attempted: false,
      modelCalls: 0,
      failureCode: "prompt_input_invalid",
    });
    expect(model.invoke).not.toHaveBeenCalled();
    expect(await reviewer(intradayRequest, new AbortController().signal)).toMatchObject({
      status: "completed",
      modelCalls: 1,
    });
  });

  it("does not dispatch or spend the local budget when already cancelled", async () => {
    const model = adapter(approval());
    const reviewer = createFinanceTradeDecisionReviewer({}, { adapterFactory: () => model });
    const controller = new AbortController();
    controller.abort();
    expect(await reviewer(intradayRequest, controller.signal)).toMatchObject({
      status: "failed",
      attempted: false,
      modelCalls: 0,
      failureCode: "process_error",
    });
    expect(model.invoke).not.toHaveBeenCalled();
    expect(await reviewer(intradayRequest, new AbortController().signal)).toMatchObject({
      status: "completed",
      modelCalls: 1,
    });
  });

  it.each(["provider", "modelId"] as const)(
    "refuses a changed %s on the re-review without dispatch",
    async (field) => {
      const first = adapter(approval());
      const changed = { ...adapter(approval()), [field]: "changed" };
      const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(changed);
      const reviewer = createFinanceTradeDecisionReviewer({}, { adapterFactory: factory });
      expect(await reviewer(intradayRequest, new AbortController().signal)).toMatchObject({
        status: "completed",
        modelCalls: 1,
      });
      expect(
        await reviewer(intradayRequest, new AbortController().signal, { maxModelCalls: 1 }),
      ).toMatchObject({
        status: "failed",
        attempted: false,
        modelCalls: 0,
        failureCode: "process_error",
      });
      expect(changed.invoke).not.toHaveBeenCalled();
    },
  );

  it("discloses host preflight sizing while rejecting model sizing edits", async () => {
    const packet: FinanceIntradayTradeDecisionReviewRequest = {
      ...intradayRequest,
      candidates: [{ ...intradayRequest.candidates[0], plannedQuantity: 2, plannedNotional: 1002 }],
    };
    let prompt = "";
    const model = adapter(approval(packet));
    const reviewer = createFinanceTradeDecisionReviewer(
      {},
      {
        adapterFactory: (_cfg, options) => ({
          ...model,
          invoke: async (call, signal) => {
            prompt = options!.buildPrompt!(call.payload);
            return model.invoke(call, signal);
          },
        }),
      },
    );
    expect(await reviewer(packet, new AbortController().signal)).toMatchObject({
      status: "completed",
    });
    expect(prompt).toContain('"plannedQuantity":2');
    expect(prompt).toContain('"plannedNotional":1002');
    expect(prompt).toContain("do not grant model sizing authority");
    const forged = adapter({
      ...approval(packet),
      decisions: [{ ...approval(packet).decisions[0], plannedQuantity: 20 }],
    });
    expect(
      await createFinanceTradeDecisionReviewer({}, { adapterFactory: () => forged })(
        packet,
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "failed", failureCode: "output_contract" });
  });
});

it("keeps the default four-call native budget shared across re-entry and skips unused follow-ups", async () => {
  const nativeBudgets: NonNullable<
    Parameters<typeof createConfiguredFinanceModelAdapter>[1]
  >["callBudget"][] = [];
  const factory = vi.fn<typeof createConfiguredFinanceModelAdapter>((_cfg, options) => {
    nativeBudgets.push(options!.callBudget);
    return {
      ...adapter({
        schemaVersion: intradayRequest.schemaVersion,
        decisions: [
          {
            candidateId: intradayRequest.candidates[0].candidateId,
            decision: "approve",
            rationale: "Supplied facts suffice.",
          },
        ],
      }),
      invoke: vi.fn(async () => {
        options!.callBudget!.reserve();
        return {
          schemaVersion: intradayRequest.schemaVersion,
          decisions: [
            {
              candidateId: intradayRequest.candidates[0].candidateId,
              decision: "approve",
              rationale: "Supplied facts suffice.",
            },
          ],
        };
      }),
    };
  });
  const reviewer = createFinanceTradeDecisionReviewer({}, { adapterFactory: factory });
  for (let run = 0; run < 4; run += 1) {
    expect(await reviewer(intradayRequest, new AbortController().signal)).toMatchObject({
      status: "completed",
      modelCalls: 1,
    });
  }
  expect(await reviewer(intradayRequest, new AbortController().signal)).toMatchObject({
    status: "failed",
    modelCalls: 0,
    failureCode: "call_budget_exhausted",
  });
  expect(new Set(nativeBudgets).size).toBe(1);
  expect(nativeBudgets[0]!.snapshot()).toEqual({ limit: 4, reserved: 4, remaining: 0 });
  expect(factory).toHaveBeenCalledTimes(4);
});
