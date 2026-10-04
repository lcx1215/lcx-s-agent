import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { appendFinanceBars } from "./finance-bar-ledger.js";
import {
  FinanceIntradayDecisionReviewReceiptSchema,
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
  readFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import {
  createFinanceTradeDecisionReviewer,
  FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  type FinanceIntradayTradeDecisionReviewRequest,
} from "./finance-trade-decision-review.js";
import {
  createFinanceTradeReviewEvidenceExecutor,
  FinanceTradeReviewEvidenceRequestSchema,
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
