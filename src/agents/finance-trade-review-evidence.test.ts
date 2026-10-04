import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildFinanceFrameworkCoreContractPath,
  buildFinanceLearningCapabilityCandidatesPath,
  renderFinanceFrameworkCoreContractArtifact,
  renderFinanceLearningCapabilityCandidateArtifact,
} from "../hooks/bundled/lobster-brain-registry.js";
import { appendFinanceBars } from "./finance-bar-ledger.js";
import { readFinanceBrokerInstrumentFeedback } from "./finance-broker-profit-feedback.js";
import {
  FinanceIntradayDecisionReviewReceiptSchema,
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
  readFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { appendFinanceBrokerHistory } from "./finance-position-ledger.js";
import { financePositionLedgerPath } from "./finance-state-dir.js";
import {
  createFinanceTradeDecisionReviewer,
  FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  type FinanceIntradayTradeDecisionReviewRequest,
} from "./finance-trade-decision-review.js";
import {
  createFinanceTradeReviewEvidenceExecutor,
  createFinanceTradeReviewFinancialCapabilities,
  describeFinanceTradeReviewFinancialCapabilities,
  FinanceTradeReviewEvidenceRequestSchema,
  type FinanceTradeReviewFinancialCapability,
} from "./finance-trade-review-evidence.js";
import { ModelAdapterError, type LogicalAgentModelAdapter } from "./logical-agent-model-router.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
const asOf = "2026-09-30T14:00:00.000Z";
const packet: FinanceIntradayTradeDecisionReviewRequest = {
  schemaVersion: FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  venue: "alpaca:paper",
  asOf,
  signalAnchor: "signal",
  ruleIds: ["rule"],
  equity: 100000,
  caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 8 },
  positionBookObservedAt: asOf,
  reconciliation: { status: "reconciled" },
  positions: [],
  candidates: [
    {
      candidateId: "signal",
      instrument: "AAA",
      side: "buy",
      strategyRule: "opening_range_breakout_long_next_bar_v1",
      signalReason: "opening_range_breakout",
      signalReferencePrice: 100,
      signalReferencePriceAt: asOf,
      datasetHeadRef: "a".repeat(64),
      intradayOwnedQuantity: 0,
      brokerPositionQuantity: 0,
      executionQuote: {
        referencePrice: 100,
        referencePriceAt: asOf,
        sourceUrlOrArtifact: "fixture",
        ageMs: 0,
        maxAgeMs: 30000,
      },
    },
  ],
};
const decision = {
  schemaVersion: packet.schemaVersion,
  decisions: [
    {
      candidateId: "signal",
      decision: "veto",
      rationale:
        "Recorded daily relationship is not fresh intraday or profitable arbitrage evidence",
    },
  ],
};
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-evidence-"));
  dirs.push(directory);
  for (const instrument of ["AAA", "BBB"]) {
    const bars = Array.from({ length: 29 }, (_, i) => {
      const close = (instrument === "AAA" ? 100 : 50) + i + Math.sin(i);
      return {
        date: `2026-09-${String(i + 1).padStart(2, "0")}`,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
      };
    });
    await appendFinanceBars(directory, {
      instrument,
      derivation: "ohlcv",
      observedAt: "2026-09-29T23:00:00.000Z",
      provenance: { origin: "offline-fixture" },
      bars,
    });
  }
  return { directory, accountId: "paper-a", instruments: ["AAA", "BBB"] };
}
function scripted(outputs: unknown[], payloads: unknown[] = []) {
  let calls = 0;
  const model: LogicalAgentModelAdapter = {
    id: "fixture",
    provider: "offline-scripted",
    modelId: "fixture",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: [],
    invoke: vi.fn(async (call) => {
      payloads.push(call.payload);
      const output = outputs[calls++];
      if (output instanceof Error) {
        throw output;
      }
      return output;
    }),
  };
  return { model, factory: () => model };
}
const requests = [
  { candidateId: "signal", action: "max_drawdown" as const },
  {
    candidateId: "signal",
    action: "pair_spread_diagnostics" as const,
    instrumentB: "BBB",
    construction: "fixed_spread" as const,
    hedgeRatio: 2,
    relationshipRationale: "Caller hypothesis about a recorded relationship",
  },
];
it("runs real recorded math and pair diagnostics, consumes results on call2, and persists them without execution authority", async () => {
  const scope = await fixture();
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: requests,
        hypothesis: "Test daily risk and relationship before exact candidate decision",
      },
      decision,
    ],
    payloads,
  );
  const reviewer = createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: fixtureModel.factory, evidenceScope: scope },
  );
  const result = await reviewer(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    toolEvidence: [
      { action: "max_drawdown", status: "completed" },
      { action: "pair_spread_diagnostics", status: "completed" },
    ],
  });
  expect(JSON.stringify(payloads[1])).toContain(
    "recorded_daily_history_research_only_no_execution_or_fresh_quote",
  );
  expect(JSON.stringify(payloads[1])).toContain("calculationId");
  expect(JSON.parse(result.toolEvidence![1].summary).result.historyWindow).toEqual({
    firstDate: "2026-09-01",
    lastDate: "2026-09-29",
    count: 29,
  });
  expect(JSON.stringify(payloads[1])).not.toContain('"observations":[');
  await appendFinanceIntradayDecision(scope.directory, {
    signalId: "signal",
    instrument: "AAA",
    sessionDate: "2026-09-30",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: asOf,
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  const { decisions: _decisions, ...resultMetadata } = result;
  const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
    ...resultMetadata,
    request: packet,
    decision: result.decisions?.[0],
  });
  await appendFinanceIntradayOutcome(scope.directory, {
    signalId: "signal",
    status: "refused",
    reasons: ["model veto"],
    tradeDecisionReview: receipt,
  });
  expect(
    (await readFinanceIntradayOutcome(scope.directory, "signal"))?.tradeDecisionReview
      ?.toolEvidence,
  ).toEqual(result.toolEvidence);
});
it.each(["directory", "accountId", "series", "asOf", "unknownTool"])(
  "rejects model-controlled %s and mixed output before evidence execution",
  async (key) => {
    const scope = await fixture();
    const fixtureModel = scripted([
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [{ ...requests[0], [key]: "malicious" }],
        hypothesis: "test",
      },
    ]);
    expect(
      await createFinanceTradeDecisionReviewer(
        {},
        { adapterFactory: fixtureModel.factory, evidenceScope: scope },
      )(packet, new AbortController().signal),
    ).toMatchObject({ status: "failed", modelCalls: 1 });
    expect(
      FinanceTradeReviewEvidenceRequestSchema.safeParse({ ...requests[0], [key]: "bad" }).success,
    ).toBe(false);
  },
);
it("rejects duplicate, overflow and outside pair scope before reading; abort propagates", async () => {
  const scope = await fixture();
  const execute = createFinanceTradeReviewEvidenceExecutor(scope);
  for (const list of [
    [requests[0], requests[0]],
    [requests[0], requests[1], requests[0]],
    [{ ...requests[1], instrumentB: "OTHER" }],
  ]) {
    await expect(execute(list, packet, new AbortController().signal)).rejects.toThrow();
  }
  const controller = new AbortController();
  controller.abort();
  await expect(execute([requests[0]], packet, controller.signal)).rejects.toThrow();
});
it("retains the original two-call budget for truncation and refuses late evidence requests", async () => {
  const scope = await fixture();
  const fixtureModel = scripted([
    new ModelAdapterError("output_truncated"),
    { schemaVersion: packet.schemaVersion, evidenceRequests: [requests[0]], hypothesis: "late" },
  ]);
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: fixtureModel.factory, evidenceScope: scope },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({ status: "failed", modelCalls: 2 });
  expect(result.toolEvidence).toBeUndefined();
});
it("returns missing data as unknown to the final model, never fabricates economics or a third call", async () => {
  const scope = await fixture();
  const future = { ...packet, asOf: "2026-09-01T00:00:00.000Z" };
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [requests[0]],
        hypothesis: "missing data",
      },
      { schemaVersion: packet.schemaVersion, evidenceRequests: [requests[0]], hypothesis: "again" },
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: fixtureModel.factory, evidenceScope: scope },
  )(future, new AbortController().signal);
  expect(result).toMatchObject({
    status: "failed",
    modelCalls: 2,
    toolEvidence: [{ status: "unavailable" }],
  });
  expect(JSON.stringify(payloads[1])).toContain("insufficient completed daily history");
});
it("legacy direct decisions stay one-call and forged packet tool fields are stripped", async () => {
  const fixtureModel = scripted([decision]);
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: fixtureModel.factory },
  )(
    {
      ...packet,
      evidenceToolsAvailable: true,
      evidenceScope: { directory: "bad" },
    } as FinanceIntradayTradeDecisionReviewRequest,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: "completed", modelCalls: 1 });
  expect(fixtureModel.model.invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.not.objectContaining({ evidenceToolsAvailable: true }),
    }),
    expect.anything(),
  );
});

it("rejects same-day/future bars, divergent duplicate dates and mixed request/decision outputs", async () => {
  const scope = await fixture();
  await appendFinanceBars(scope.directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-30T13:00:00.000Z",
    provenance: { origin: "conflict" },
    bars: [
      { date: "2026-09-20", open: 300, high: 301, low: 299, close: 300 },
      { date: "2026-09-30", open: 400, high: 401, low: 399, close: 400 },
    ],
  });
  const result = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [requests[0]],
    packet,
    new AbortController().signal,
  );
  expect(result).toMatchObject([{ status: "unavailable" }]);
  expect(result[0].summary).toContain("ambiguous recorded daily history");
  const fixtureModel = scripted([
    { ...decision, evidenceRequests: [requests[0]], hypothesis: "mixed" },
  ]);
  expect(
    await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: fixtureModel.factory, evidenceScope: scope },
    )(packet, new AbortController().signal),
  ).toMatchObject({ status: "failed", modelCalls: 1 });
});
it("never includes today's unfinished close or a future-observed batch in the computed series", async () => {
  const scope = await fixture();
  for (const [observedAt, date, close] of [
    ["2026-09-30T13:00:00.000Z", "2026-09-30", 10000],
    ["2026-10-01T00:00:00.000Z", "2026-09-28", 10000],
  ] as const) {
    await appendFinanceBars(scope.directory, {
      instrument: "AAA",
      derivation: "ohlcv",
      observedAt,
      provenance: { origin: "future" },
      bars: [{ date, open: close, high: close + 1, low: close - 1, close }],
    });
  }
  const result = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [{ candidateId: "signal", action: "daily_closes" }],
    packet,
    new AbortController().signal,
  );
  expect(result[0].status).toBe("completed");
  expect(result[0].summary).toContain('"count":29');
  expect(result[0].summary).toContain('"lastDate":"2026-09-29"');
  expect(result[0].summary).not.toContain("10000");
});

it("refuses first-call evidence overflow or duplicates without a second invocation", async () => {
  const scope = await fixture();
  for (const evidenceRequests of [
    [requests[0], requests[0]],
    [requests[0], requests[1], requests[0]],
  ]) {
    const fixtureModel = scripted([
      { schemaVersion: packet.schemaVersion, evidenceRequests, hypothesis: "bounded" },
    ]);
    const result = await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: fixtureModel.factory, evidenceScope: scope },
    )(packet, new AbortController().signal);
    expect(result).toMatchObject({ status: "failed", modelCalls: 1 });
    expect(result.toolEvidence).toBeUndefined();
  }
});
it("aborted evidence work cannot be consumed as successful or issue a second model call", async () => {
  const scope = await fixture();
  const controller = new AbortController();
  const fixtureModel = scripted([
    { schemaVersion: packet.schemaVersion, evidenceRequests: [requests[0]], hypothesis: "cancel" },
  ]);
  const model: LogicalAgentModelAdapter = {
    ...fixtureModel.model,
    invoke: async (call, signal) => {
      const output = await fixtureModel.model.invoke(call, signal);
      controller.abort();
      return output;
    },
  };
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: () => model, evidenceScope: scope },
  )(packet, controller.signal);
  expect(result).toMatchObject({ status: "failed", modelCalls: 1 });
  expect(result.toolEvidence).toBeUndefined();
});

it("returns actual point-derived observations as unknown and lets the final model consume the limitation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-points-"));
  dirs.push(directory);
  for (const instrument of ["AAA", "BBB"]) {
    await appendFinanceBars(directory, {
      instrument,
      derivation: "point_derived",
      observedAt: "2026-09-29T23:00:00.000Z",
      provenance: { origin: "offline-point-fixture" },
      points: Array.from({ length: 29 }, (_, i) => ({
        date: `2026-09-${String(i + 1).padStart(2, "0")}`,
        at: `2026-09-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`,
        price: 100 + i,
      })),
    });
  }
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [requests[1]],
        hypothesis: "Test the relationship only if completed daily prices exist",
      },
      decision,
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: fixtureModel.factory,
      evidenceScope: { directory, accountId: "paper-a", instruments: ["AAA", "BBB"] },
    },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    toolEvidence: [{ status: "unavailable" }],
  });
  expect(JSON.stringify(payloads[1])).toContain(
    "point observations are not completed daily closes",
  );
  expect(JSON.stringify(payloads[1])).not.toContain("calculationId");
});

it.each([21, 120])(
  "delivers actual %s-close price-return numbers and historical dates to call2 and durable receipt",
  async (count) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "math-consumption-"));
    dirs.push(directory);
    const levels = Array.from({ length: count }, (_, i) => 100 + i * 0.3 + Math.sin(i));
    const bars = levels.map((close, i) => ({
      date: new Date(Date.UTC(2026, 4, 1 + i)).toISOString().slice(0, 10),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    }));
    await appendFinanceBars(directory, {
      instrument: "AAA",
      derivation: "ohlcv",
      observedAt: "2026-09-01T00:00:00Z",
      provenance: { origin: "offline-真实日线" },
      bars,
    });
    const payloads: unknown[] = [];
    const model = scripted(
      [
        {
          schemaVersion: packet.schemaVersion,
          evidenceRequests: [
            { candidateId: packet.candidates[0].candidateId, action: "returns_from_levels" },
          ],
          hypothesis: "核实收益路径是否改变当前候选判断",
        },
        decision,
      ],
      payloads,
    );
    const result = await createFinanceTradeDecisionReviewer(
      {},
      {
        adapterFactory: model.factory,
        evidenceScope: { directory, accountId: "paper-a", instruments: ["AAA"] },
      },
    )(packet, new AbortController().signal);
    expect(result).toMatchObject({ status: "completed", modelCalls: 2 });
    const evidence = result.toolEvidence![0];
    const summary = JSON.parse(evidence.summary);
    const returns = levels.slice(1).map((level, i) => level / levels[i] - 1);
    expect(summary.result.historyWindow).toEqual({
      firstDate: bars[0].date,
      lastDate: bars.at(-1)!.date,
      count,
    });
    expect(summary.result.returnSummary.cumulativePriceReturn).toBeCloseTo(
      levels.at(-1)! / levels[0] - 1,
      12,
    );
    expect(summary.result.returnSummary.mean).toBeCloseTo(
      returns.reduce((a, b) => a + b, 0) / returns.length,
      12,
    );
    expect(evidence.resultSha256).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            action: "returns_from_levels",
            returnMode: "simple",
            observations: count,
            returns,
          }),
        )
        .digest("hex"),
    );
    expect(summary.result.returnSummary.latest).toBe(returns.at(-1));
    expect(summary.result.returnSummary.min).toBe(Math.min(...returns));
    expect(summary.result.returnSummary.max).toBe(Math.max(...returns));
    if (count === 120) {
      expect(summary.omittedKeys).toContain("returns");
      expect(summary.omittedReturnCount).toBe(119);
    } else {
      expect(summary.result.returns).toEqual(returns);
    }
    expect(JSON.stringify(payloads[1])).toContain(evidence.summary.replace(/"/g, '\\"'));
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
    await appendFinanceIntradayDecision(directory, {
      signalId: "math-signal",
      instrument: "AAA",
      sessionDate: "2026-09-30",
      action: "buy",
      reason: "opening_range_breakout",
      referencePrice: 100,
      referencePriceAt: asOf,
      datasetHeadRef: "a".repeat(64),
      strategyRule: "opening_range_breakout_long_next_bar_v1",
    });
    const { decisions: _decisions, ...metadata } = result;
    const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
      ...metadata,
      request: packet,
      decision: result.decisions?.[0],
    });
    await appendFinanceIntradayOutcome(directory, {
      signalId: "math-signal",
      status: "refused",
      reasons: ["offline veto"],
      tradeDecisionReview: receipt,
    });
    expect(
      (await readFinanceIntradayOutcome(directory, "math-signal"))?.tradeDecisionReview
        ?.toolEvidence,
    ).toEqual(result.toolEvidence);
  },
);

it("distinguishes old and recent historical windows even when all numerical z-score inputs are identical", async () => {
  const recent = await fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "old-math-window-"));
  dirs.push(directory);
  const bars = Array.from({ length: 29 }, (_, i) => {
    const close = 100 + i + Math.sin(i);
    return {
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    };
  });
  await appendFinanceBars(directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-08-30T00:00:00Z",
    provenance: { origin: "offline" },
    bars,
  });
  const request = [{ candidateId: packet.candidates[0].candidateId, action: "z_score" as const }];
  const [oldResult, newResult] = await Promise.all([
    createFinanceTradeReviewEvidenceExecutor({ ...recent, directory })(
      request,
      packet,
      new AbortController().signal,
    ),
    createFinanceTradeReviewEvidenceExecutor(recent)(request, packet, new AbortController().signal),
  ]);
  const oldSummary = JSON.parse(oldResult[0].summary).result;
  const newSummary = JSON.parse(newResult[0].summary).result;
  expect(oldSummary.zScore).toBe(newSummary.zScore);
  expect(oldSummary.historyWindow.lastDate).toBe("2026-08-29");
  expect(newSummary.historyWindow.lastDate).toBe("2026-09-29");
  expect(oldResult[0].asOf).toBe(newResult[0].asOf);
});

it("rejects nonfinite derived returns before hashing or successful JSON serialization", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nonfinite-math-"));
  dirs.push(directory);
  await appendFinanceBars(directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-29T23:00:00Z",
    provenance: { origin: "offline" },
    bars: Array.from({ length: 21 }, (_, i) => {
      const close = i % 2 ? Number("1e300") : Number("1e-300");
      return {
        date: `2026-09-${String(i + 1).padStart(2, "0")}`,
        open: close,
        high: close,
        low: close,
        close,
      };
    }),
  });
  const result = await createFinanceTradeReviewEvidenceExecutor({
    directory,
    accountId: "paper-a",
    instruments: ["AAA"],
  })(
    [{ candidateId: packet.candidates[0].candidateId, action: "returns_from_levels" }],
    packet,
    new AbortController().signal,
  );
  expect(result[0].status).toBe("unavailable");
  expect(JSON.parse(result[0].summary).result).toHaveProperty("reason");
  expect(result[0].summary).not.toContain('"returns"');
});

it("uses actual price endpoints rather than rounded minus-one return products for cumulative price change", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "endpoint-math-"));
  dirs.push(directory);
  await appendFinanceBars(directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-29T23:00:00Z",
    provenance: { origin: "offline" },
    bars: Array.from({ length: 21 }, (_, i) => {
      const close = i % 2 ? Number("1e-150") : Number("1e150");
      return {
        date: `2026-09-${String(i + 1).padStart(2, "0")}`,
        open: close,
        high: close,
        low: close,
        close,
      };
    }),
  });
  const result = await createFinanceTradeReviewEvidenceExecutor({
    directory,
    accountId: "paper-a",
    instruments: ["AAA"],
  })(
    [{ candidateId: packet.candidates[0].candidateId, action: "returns_from_levels" }],
    packet,
    new AbortController().signal,
  );
  expect(result[0].status).toBe("completed");
  expect(JSON.parse(result[0].summary).result.returnSummary.cumulativePriceReturn).toBe(0);
});

const financialRequest = {
  candidateId: "signal",
  action: "financial_capability" as const,
  toolName: "finance_framework_core_inspect",
  moduleId: "credit_liquidity" as const,
  question: "Which funding risk would invalidate this candidate?",
};
async function seedKnowledge(directory: string, updatedAt = "2026-09-01T00:00:00.000Z") {
  const contractPath = path.join(directory, buildFinanceFrameworkCoreContractPath());
  await fs.mkdir(path.dirname(contractPath), { recursive: true });
  await fs.writeFile(
    contractPath,
    renderFinanceFrameworkCoreContractArtifact({
      updatedAt,
      entries: [
        {
          domain: "credit_liquidity",
          sourceArtifacts: ["memory/articles/funding.md"],
          evidenceCategories: ["credit_evidence", "liquidity_evidence"],
          evidenceSummary: "Recorded funding and credit evidence, requiring current verification.",
          baseCase: "Credit pressure can weaken liquidity.",
          bullCase: "Funding stress recedes.",
          bearCase: "Funding pressure worsens.",
          keyCausalChain: "Funding pressure -> liquidity loss -> weaker prices.",
          upstreamDrivers: ["funding"],
          downstreamAssetImpacts: ["AAA liquidity"],
          confidenceOrConviction: "low",
          whatChangesMyMind: "Reject this hypothesis if fresh funding evidence contradicts it.",
          noActionReason: "Recorded knowledge alone cannot approve a trade.",
          riskGateNotes: "Preserve the exact stop and verify costs.",
          allowedActionAuthority: "research_only",
        },
      ],
    }),
  );
  const learningPath = path.join(directory, buildFinanceLearningCapabilityCandidatesPath());
  await fs.writeFile(
    learningPath,
    renderFinanceLearningCapabilityCandidateArtifact({
      updatedAt,
      frameworkContractPath: buildFinanceFrameworkCoreContractPath(),
      candidates: Array.from({ length: 3 }, (_, index) => ({
        candidateId: `funding-${index}`,
        sourceArticlePath: "memory/articles/funding.md",
        title: "Credit liquidity framework",
        sourceType: "public_web_article" as const,
        collectionMethod: "public_article_capture" as const,
        extractionSummary: "Use credit liquidity and funding data to test a bounded hypothesis.",
        rawNotes: "Stored method, requiring current evidence.",
        capabilityName: `Credit funding risk ${index}`,
        capabilityType: "research_framework" as const,
        relatedFinanceDomains: ["credit_liquidity" as const],
        capabilityTags: ["causal_mapping" as const],
        evidenceCategories: ["credit_evidence" as const, "liquidity_evidence" as const],
        evidenceSummary: "Credit spreads and funding pressure provide the required evidence.",
        methodSummary: "Evaluate funding pressure and credit liquidity.",
        requiredDataSources: ["funding pressure", "credit spreads"],
        causalOrMechanisticClaim: "Funding pressure may reduce liquidity.",
        evidenceLevel: "hypothesis" as const,
        implementationRequirements: "Check fresh funding data before applying.",
        riskAndFailureModes: "Reject unsupported timing and preserve stops.",
        overfittingOrSpuriousRisk: "A small sample cannot prove persistent edge.",
        complianceOrCollectionNotes: "Public source only.",
        suggestedAttachmentPoint: "finance_framework_domain:credit_liquidity",
        allowedActionAuthority: "research_only" as const,
      })),
    }),
  );
  return { contractPath, learningPath };
}

it("selects real registered math and stored financial knowledge, consumes both on call2 and preserves raw hash and original receipt", async () => {
  const scope = await fixture();
  const { contractPath } = await seedKnowledge(scope.directory);
  const before = await fs.readFile(contractPath);
  const financialCapabilities = createFinanceTradeReviewFinancialCapabilities({
    workspaceDir: scope.directory,
  });
  const catalog = describeFinanceTradeReviewFinancialCapabilities({
    ...scope,
    financialCapabilities,
  });
  expect(catalog.map((item) => item.toolName)).toEqual([
    "finance_framework_core_inspect",
    "finance_learning_capability_apply",
  ]);
  expect(catalog[0].moduleIds).toContain("credit_liquidity");
  expect(catalog[0].moduleIds).not.toContain("quant_math");
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [requests[0], financialRequest],
        hypothesis: "Check mathematical risk and stored funding falsifier",
      },
      decision,
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: fixtureModel.factory, evidenceScope: { ...scope, financialCapabilities } },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    toolEvidence: [
      { action: "max_drawdown", status: "completed" },
      {
        action: "financial_capability",
        status: "completed",
        accountId: "paper-a",
        asOf,
        boundary: "recorded_financial_knowledge_research_only_not_market_or_account_facts",
      },
    ],
  });
  const evidence = result.toolEvidence![1];
  expect(JSON.stringify(payloads[1])).toContain(
    "Reject this hypothesis if fresh funding evidence contradicts it.",
  );
  expect(JSON.stringify(payloads[1])).toContain(
    "stored_knowledge_not_current_market_account_or_point_in_time_facts",
  );
  const raw = await financialCapabilities[0].execute(
    {
      moduleId: financialRequest.moduleId,
      candidate: packet.candidates[0],
      question: financialRequest.question,
    },
    new AbortController().signal,
  );
  expect(evidence.resultSha256).toBe(
    createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
  );
  expect(evidence.requestSha256).toBe(
    createHash("sha256")
      .update(JSON.stringify(FinanceTradeReviewEvidenceRequestSchema.parse(financialRequest)))
      .digest("hex"),
  );
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
  expect(await fs.readFile(contractPath)).toEqual(before);
  const { decisions: _decisions, ...metadata } = result;
  await appendFinanceIntradayDecision(scope.directory, {
    signalId: "signal",
    instrument: "AAA",
    sessionDate: "2026-09-30",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: asOf,
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
    ...metadata,
    request: packet,
    decision: result.decisions![0],
  });
  await appendFinanceIntradayOutcome(scope.directory, {
    signalId: "signal",
    status: "refused",
    reasons: ["model veto"],
    tradeDecisionReview: receipt,
  });
  expect(
    (await readFinanceIntradayOutcome(scope.directory, "signal"))?.tradeDecisionReview
      ?.toolEvidence,
  ).toEqual(result.toolEvidence);
});

it("queries native retained guidance without any bar book or usage writes and caps actual retrieved cards", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-knowledge-"));
  dirs.push(directory);
  const { learningPath } = await seedKnowledge(directory);
  const before = await fs.readFile(learningPath);
  const scope = {
    directory,
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: createFinanceTradeReviewFinancialCapabilities({
      workspaceDir: directory,
    }),
  };
  const request = {
    ...financialRequest,
    toolName: "finance_learning_capability_apply",
    question: "credit liquidity funding risk",
  };
  const [result] = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [request],
    packet,
    new AbortController().signal,
  );
  expect(result.status, result.summary).toBe("completed");
  const summary = JSON.parse(result.summary);
  expect(summary.result.candidateCount).toBe(2);
  expect(result.summary).toContain("Credit funding risk");
  expect(summary.omittedKeys).toContain("answerSkeleton");
  expect(summary.result.sourceTime).toBe(
    "recorded_metadata_at_or_before_cutoff_not_market_freshness",
  );
  expect(await fs.readFile(learningPath)).toEqual(before);
  await expect(
    fs.access(path.join(directory, "memory", "finance-learning-apply-usage-receipts")),
  ).rejects.toThrow();
  await expect(
    fs.access(path.join(directory, "memory", "finance-learning-apply-usage-reviews")),
  ).rejects.toThrow();
  await expect(fs.access(path.join(directory, "finance-bars.sqlite"))).rejects.toThrow();
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
});

it.each([
  "directory",
  "accountId",
  "asOf",
  "series",
  "instrumentB",
  "hedgeRatio",
  "construction",
  "lookbackWindow",
])("rejects injected or mixed financial %s before any host execution", async (key) => {
  const execute = vi.fn(async () => ({ ok: true }));
  const scope = {
    directory: "unused",
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: [
      {
        toolName: financialRequest.toolName,
        moduleIds: [financialRequest.moduleId],
        description: "Offline host read",
        execute,
      },
    ],
  };
  await expect(
    createFinanceTradeReviewEvidenceExecutor(scope)(
      [financialRequest, { ...financialRequest, [key]: "bad" }],
      packet,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it("prevalidates all tools, modules, candidates, registration identities and UTF8 questions before dispatch", async () => {
  const execute = vi.fn(async () => ({ ok: true }));
  const capability: FinanceTradeReviewFinancialCapability = {
    toolName: financialRequest.toolName,
    moduleIds: [financialRequest.moduleId],
    description: "Offline host read",
    execute,
  };
  const scope = {
    directory: "unused",
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: [capability],
  };
  for (const invalid of [
    { ...financialRequest, toolName: "unregistered" },
    { ...financialRequest, moduleId: "quant_math" as const },
    { ...financialRequest, candidateId: "other" },
    { ...financialRequest, question: "中".repeat(81) },
    financialRequest,
  ]) {
    await expect(
      createFinanceTradeReviewEvidenceExecutor(scope)(
        [financialRequest, invalid],
        packet,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
  expect(execute).not.toHaveBeenCalled();
  expect(
    FinanceTradeReviewEvidenceRequestSchema.safeParse({
      ...financialRequest,
      question: "中".repeat(80),
    }).success,
  ).toBe(true);
  expect(() =>
    describeFinanceTradeReviewFinancialCapabilities({
      ...scope,
      financialCapabilities: [capability, capability],
    }),
  ).toThrow();
  expect(() =>
    describeFinanceTradeReviewFinancialCapabilities({
      ...scope,
      financialCapabilities: [
        { ...capability, moduleIds: [financialRequest.moduleId, financialRequest.moduleId] },
      ],
    }),
  ).toThrow();
  await expect(
    createFinanceTradeReviewEvidenceExecutor({ ...scope, instruments: ["BBB"] })(
      [financialRequest],
      packet,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it("returns absent or future stored knowledge as actual unknown for call2 and propagates cancellation after await", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-unknown-"));
  dirs.push(directory);
  const financialCapabilities = createFinanceTradeReviewFinancialCapabilities({
    workspaceDir: directory,
  });
  const scope = { directory, accountId: "paper-a", instruments: ["AAA"], financialCapabilities };
  for (const future of [false, true]) {
    if (future) {
      await seedKnowledge(directory, "2026-10-01T00:00:00.000Z");
    }
    const payloads: unknown[] = [];
    const fixtureModel = scripted(
      [
        {
          schemaVersion: packet.schemaVersion,
          evidenceRequests: [financialRequest],
          hypothesis: "Check recorded funding frame",
        },
        decision,
      ],
      payloads,
    );
    const result = await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: fixtureModel.factory, evidenceScope: scope },
    )(packet, new AbortController().signal);
    expect(result).toMatchObject({
      status: "completed",
      modelCalls: 2,
      toolEvidence: [{ status: "unavailable" }],
    });
    expect(JSON.stringify(payloads[1])).toContain(
      future ? "after review cutoff" : "finance_framework_core_contract_missing",
    );
    if (future) {
      expect(JSON.stringify(payloads[1])).not.toContain("Funding pressure worsens.");
    }
  }
  const controller = new AbortController();
  const custom: FinanceTradeReviewFinancialCapability = {
    toolName: "host_local_read",
    moduleIds: ["credit_liquidity"],
    description: "Host read only",
    execute: async () => {
      await Promise.resolve();
      controller.abort();
      return { ok: true };
    },
  };
  await expect(
    createFinanceTradeReviewEvidenceExecutor({ ...scope, financialCapabilities: [custom] })(
      [{ ...financialRequest, toolName: custom.toolName }],
      packet,
      controller.signal,
    ),
  ).rejects.toThrow();
});

it("does not expose an arbitrary capability handler exception or label nonfinite results successful", async () => {
  for (const output of [new Error("synthetic provider secret"), { risk: Infinity }]) {
    const capability: FinanceTradeReviewFinancialCapability = {
      toolName: "host_local_read",
      moduleIds: ["credit_liquidity"],
      description: "Host read only",
      execute: async () => {
        if (output instanceof Error) {
          throw output;
        }
        return output;
      },
    };
    const [result] = await createFinanceTradeReviewEvidenceExecutor({
      directory: "unused",
      accountId: "paper-a",
      instruments: ["AAA"],
      financialCapabilities: [capability],
    })(
      [{ ...financialRequest, toolName: capability.toolName }],
      packet,
      new AbortController().signal,
    );
    expect(result.status).toBe("unavailable");
    expect(result.summary).not.toContain("synthetic provider secret");
    expect(result.summary).toContain(
      output instanceof Error
        ? "financial_capability_unavailable"
        : "nonfinite mathematical result",
    );
  }
});

it("preserves scoped custom read values with unknown source time and whole-field UTF8 omissions", async () => {
  const raw = { ok: true, value: 42, untrustedText: "中".repeat(1000) };
  const execute = vi.fn(
    async ({
      candidate,
      question,
    }: Parameters<FinanceTradeReviewFinancialCapability["execute"]>[0]) => {
      expect(candidate.instrument).toBe("AAA");
      expect(question).toBe("What is recorded?");
      return raw;
    },
  );
  const capability: FinanceTradeReviewFinancialCapability = {
    toolName: "host_local_read",
    moduleIds: ["credit_liquidity"],
    description: "Actual host read",
    execute,
  };
  const scope = {
    directory: "unused",
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: [capability],
  };
  expect(describeFinanceTradeReviewFinancialCapabilities(scope)).toEqual([
    {
      toolName: capability.toolName,
      moduleIds: ["credit_liquidity"],
      description: "Actual host read",
      boundary: "recorded_financial_knowledge_research_only_not_market_or_account_facts",
    },
  ]);
  const [result] = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [{ ...financialRequest, toolName: capability.toolName, question: "What is recorded?" }],
    packet,
    new AbortController().signal,
  );
  const summary = JSON.parse(result.summary);
  expect(summary.result.value).toBe(42);
  expect(summary.result.sourceTime).toBe("source_time_unverified");
  expect(summary.omittedKeys).toContain("untrustedText");
  expect(summary.result).not.toHaveProperty("untrustedText");
  expect(result.resultSha256).toBe(createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
  const controller = new AbortController();
  controller.abort();
  await expect(
    createFinanceTradeReviewEvidenceExecutor(scope)(
      [{ ...financialRequest, toolName: capability.toolName }],
      packet,
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
});

it("degrades an oversized financial projection to named unknown while keeping full raw SHA and scope within 2048 bytes", async () => {
  const raw = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`field_${i}`, "中".repeat(300)]),
  );
  const capability: FinanceTradeReviewFinancialCapability = {
    toolName: "host_local_read",
    moduleIds: ["credit_liquidity"],
    description: "Actual host read",
    execute: async () => raw,
  };
  const [result] = await createFinanceTradeReviewEvidenceExecutor({
    directory: "unused",
    accountId: "a".repeat(240),
    instruments: ["AAA"],
    financialCapabilities: [capability],
  })(
    [{ ...financialRequest, toolName: capability.toolName }],
    packet,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: "unavailable", accountId: "a".repeat(240), asOf });
  expect(JSON.parse(result.summary).result.reason).toBe(
    "financial_capability_result_omitted_by_budget",
  );
  expect(JSON.parse(result.summary).omittedKeys).toEqual(["result"]);
  expect(result.resultSha256).toBe(createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
});

it.each(["unknown", "failed", "absent"])(
  "preserves a registered reader's %s result as unavailable rather than fabricated completion",
  async (status) => {
    const capability: FinanceTradeReviewFinancialCapability = {
      toolName: "host_local_read",
      moduleIds: ["credit_liquidity"],
      description: "Host read only",
      execute: async () => ({ status, reason: "Recorded knowledge missing" }),
    };
    const [result] = await createFinanceTradeReviewEvidenceExecutor({
      directory: "unused",
      accountId: "paper-a",
      instruments: ["AAA"],
      financialCapabilities: [capability],
    })(
      [{ ...financialRequest, toolName: capability.toolName }],
      packet,
      new AbortController().signal,
    );
    expect(result.status).toBe("unavailable");
    expect(JSON.parse(result.summary).result.status).toBe(status);
  },
);

const brokerRequest = { candidateId: "signal", action: "broker_fill_feedback" as const };
async function brokerFixture(
  options: {
    scope?: Awaited<ReturnType<typeof fixture>>;
    unknownFee?: boolean;
    observedAt?: string;
    accountId?: string;
  } = {},
) {
  const directory =
    options.scope?.directory ?? (await fs.mkdtemp(path.join(os.tmpdir(), "review-broker-")));
  if (!options.scope) {
    dirs.push(directory);
  }
  const scope = options.scope ?? {
    directory,
    accountId: options.accountId ?? "paper-a",
    instruments: ["AAA"],
  };
  const append = (query: string, payload: Record<string, unknown>[], accountId = scope.accountId) =>
    appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query,
      cursor: "",
      payload,
    });
  await append("activities:offline-fixture", [
    ...(["buy", "sell"] as const).map((side, i) => ({
      id: side,
      activity_type: "FILL",
      type: "fill",
      symbol: "AAA",
      side,
      qty: side === "buy" ? "2" : "1",
      price: side === "buy" ? "100" : "110",
      order_id: side,
      transaction_time: `2026-09-30T13:0${i}:00.000Z`,
    })),
    ...(["buy", "sell"] as const).map((order, i) => ({
      id: `${order}-fee`,
      activity_type: "FEE",
      status: "executed",
      currency: "USD",
      net_amount: order === "buy" ? "-2" : "-0.5",
      order_id: order,
      transaction_time: `2026-09-30T13:0${i}:00.000Z`,
    })),
    ...(options.unknownFee
      ? [
          {
            id: "unallocated-fee",
            activity_type: "CFEE",
            status: "executed",
            currency: "USD",
            net_amount: "-0.1",
            transaction_time: "2026-09-30T13:02:00.000Z",
          },
        ]
      : []),
  ]);
  await append(
    "activities:other-account",
    [
      {
        id: "foreign-buy",
        activity_type: "FILL",
        type: "fill",
        symbol: "AAA",
        side: "buy",
        qty: "100",
        price: "900",
        transaction_time: "2026-09-30T13:00:00.000Z",
      },
    ],
    "paper-other",
  );
  await append("reconciliation:offline-sealed", [
    {
      observedAt: options.observedAt ?? asOf,
      status: "reconciled",
      feesInterpreted: true,
      issues: [],
      differences: [],
      cashDifference: 0,
    },
  ]);
  return scope;
}

it("consumes real sealed FIFO and math together on call2 and persists additive broker evidence", async () => {
  const scope = await brokerFixture({ scope: await fixture() });
  const databaseBefore = await fs.readFile(financePositionLedgerPath(scope.directory));
  const raw = await readFinanceBrokerInstrumentFeedback({ ...scope, instrument: "AAA", asOf });
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [brokerRequest, requests[0]],
        hypothesis: "Inspect recorded costs and historical risk",
      },
      decision,
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: fixtureModel.factory,
      evidenceScope: scope,
    },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    toolEvidence: [
      {
        action: "broker_fill_feedback",
        status: "completed",
        accountId: scope.accountId,
        asOf,
        boundary: "recorded_broker_fill_feedback_not_strategy_edge_or_expected_return",
      },
      { action: "max_drawdown", status: "completed" },
    ],
  });
  const evidence = result.toolEvidence![0];
  const summary = JSON.parse(evidence.summary);
  expect(summary.result.economics).toMatchObject({
    basis: "broker_fill_fifo_usd_not_strategy_attribution",
    buyFills: 1,
    sellFills: 1,
    matchedLotCount: 1,
    openLotCount: 1,
    grossMatchedPnl: 10,
    netMatchedPnl: 8.5,
    allocatedClosedCashFees: 1.5,
    unallocatedFeeActivityCount: 0,
    feeActivityCount: 2,
  });
  expect(summary.result).toMatchObject({
    freshness: "fresh",
    observedAt: asOf,
    sealedSequence: 3,
    observationBoundary: "snapshot_observedAt_and_sequence_only_no_per_record_capture_time",
  });
  expect(summary.result.snapshotRef).toMatch(/^[a-f\d]{64}$/u);
  expect(evidence.resultSha256).toBe(
    createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
  );
  expect(evidence.requestSha256).toBe(
    createHash("sha256").update(JSON.stringify(brokerRequest)).digest("hex"),
  );
  expect(JSON.stringify(payloads[1])).toContain('\\"netMatchedPnl\\":8.5');
  expect(
    result.toolEvidence!.every((item) => Buffer.byteLength(JSON.stringify(item)) <= 2048),
  ).toBe(true);
  expect(await fs.readFile(financePositionLedgerPath(scope.directory))).toEqual(databaseBefore);
  await appendFinanceIntradayDecision(scope.directory, {
    signalId: "signal",
    instrument: "AAA",
    sessionDate: "2026-09-30",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: asOf,
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  const { decisions: _decisions, ...metadata } = result;
  await appendFinanceIntradayOutcome(scope.directory, {
    signalId: "signal",
    status: "refused",
    reasons: ["offline-scripted veto"],
    tradeDecisionReview: FinanceIntradayDecisionReviewReceiptSchema.parse({
      ...metadata,
      request: packet,
      decision: result.decisions![0],
    }),
  });
  expect(
    (await readFinanceIntradayOutcome(scope.directory, "signal"))?.tradeDecisionReview
      ?.toolEvidence,
  ).toEqual(result.toolEvidence);
});

it("keeps unknown fees and absent closed samples explicit without reading a bar ledger or granting authority", async () => {
  const scope = await brokerFixture({ unknownFee: true });
  const execute = createFinanceTradeReviewEvidenceExecutor({
    ...scope,
    instruments: ["AAA", "BBB"],
  });
  const [evidence] = await execute([brokerRequest], packet, new AbortController().signal);
  expect(evidence.status).toBe("completed");
  expect(JSON.parse(evidence.summary).result.economics).toMatchObject({
    grossMatchedPnl: 10,
    netMatchedPnl: null,
    unallocatedFeeActivityCount: 1,
    issues: ["fees_not_allocated_to_closed_lots"],
    status: "net_profit_unverified",
  });
  const otherPacket: FinanceIntradayTradeDecisionReviewRequest = {
    ...packet,
    candidates: [{ ...packet.candidates[0], instrument: "BBB" }],
  };
  const [other] = await execute([brokerRequest], otherPacket, new AbortController().signal);
  expect(JSON.parse(other.summary).result.economics).toMatchObject({
    instrument: "BBB",
    matchedLotCount: 0,
    netMatchedPnl: null,
    status: "no_closed_matches",
  });
  expect(other.sourceRef).not.toBe(evidence.sourceRef);
  expect(evidence).not.toHaveProperty("executionAuthority");
});

it.each([
  ["stale", "2026-09-30T13:54:59.999Z", "snapshot_stale"],
  ["future", "2026-09-30T14:00:00.001Z", "missing_snapshot_at_cutoff"],
])(
  "passes %s native snapshot limitations to call2 without fabricating net economics",
  async (_kind, observedAt, reason) => {
    const scope = await brokerFixture({ observedAt });
    const payloads: unknown[] = [];
    const fixtureModel = scripted(
      [
        {
          schemaVersion: packet.schemaVersion,
          evidenceRequests: [brokerRequest],
          hypothesis: "Use only recorded accounting within cutoff",
        },
        decision,
      ],
      payloads,
    );
    const result = await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: fixtureModel.factory, evidenceScope: scope },
    )(packet, new AbortController().signal);
    expect(result).toMatchObject({
      status: "completed",
      modelCalls: 2,
      toolEvidence: [{ status: "unavailable" }],
    });
    expect(JSON.parse(result.toolEvidence![0].summary).result.reason).toBe(reason);
    expect(JSON.stringify(payloads[1])).toContain(reason);
    expect(JSON.parse(result.toolEvidence![0].summary).result).not.toHaveProperty("economics");
  },
);

it.each([
  "directory",
  "accountId",
  "asOf",
  "instrument",
  "toolName",
  "moduleId",
  "lookbackWindow",
  "question",
])("rejects broker %s overrides rather than accepting financial or math fields", (key) => {
  expect(
    FinanceTradeReviewEvidenceRequestSchema.safeParse({ ...brokerRequest, [key]: "injected" })
      .success,
  ).toBe(false);
});

it("keeps full broker raw hash and explicit unknown when a UTF8 account scope exhausts the envelope budget", async () => {
  const scope = await brokerFixture({ accountId: "户".repeat(240) });
  const raw = await readFinanceBrokerInstrumentFeedback({ ...scope, instrument: "AAA", asOf });
  expect(raw.status).toBe("present");
  const [evidence] = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [brokerRequest],
    packet,
    new AbortController().signal,
  );
  expect(evidence.status).toBe("unavailable");
  expect(JSON.parse(evidence.summary)).toMatchObject({
    result: { reason: "broker_fill_feedback_result_omitted_by_budget" },
    omittedKeys: ["result"],
  });
  expect(evidence.resultSha256).toBe(
    createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
  );
  expect(evidence.accountId).toBe(scope.accountId);
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
});

it("validates the whole mixed batch before a reader starts, retains the shared request bound and propagates abort", async () => {
  const scope = await brokerFixture();
  const execute = vi.fn(async () => ({ value: "not reached" }));
  const executor = createFinanceTradeReviewEvidenceExecutor({
    ...scope,
    financialCapabilities: [
      {
        toolName: "host_read",
        moduleIds: ["credit_liquidity"],
        description: "Offline registered read",
        execute,
      },
    ],
  });
  await expect(
    executor(
      [
        { ...financialRequest, toolName: "host_read", moduleId: "credit_liquidity" },
        { ...brokerRequest, candidateId: "outside" },
      ],
      packet,
      new AbortController().signal,
    ),
  ).rejects.toThrow("outside host candidate/instrument scope");
  expect(execute).not.toHaveBeenCalled();
  await expect(
    executor([brokerRequest, brokerRequest], packet, new AbortController().signal),
  ).rejects.toThrow("duplicate");
  await expect(
    executor([brokerRequest, requests[0], requests[1]], packet, new AbortController().signal),
  ).rejects.toThrow("count");
  const controller = new AbortController();
  const pending = executor([brokerRequest], packet, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  const [wrongAccount] = await createFinanceTradeReviewEvidenceExecutor({
    ...scope,
    accountId: "unknown-paper",
  })([brokerRequest], packet, new AbortController().signal);
  expect(wrongAccount.status).toBe("unavailable");
  expect(JSON.parse(wrongAccount.summary).result.reason).toBe("missing_snapshot_at_cutoff");
});
