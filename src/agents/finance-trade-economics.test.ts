import { describe, expect, it } from "vitest";
import {
  estimateFinanceTradeEconomics,
  evaluateFinanceTradeEconomics,
  evaluateFinancePairedEconomics,
} from "./finance-trade-economics.js";
const policy = {
  minObservations: 4,
  priorWins: 1,
  priorLosses: 1,
  kellyFraction: 0.25,
  maxAllocationFraction: 0.2,
  maxLossBudgetFraction: 0.005,
  uncertaintyPenalty: 1,
};
const observations = Array.from({ length: 12 }, (_, i) => ({
  id: `trade-${i}`,
  entryAt: `2026-09-${String(i + 1).padStart(2, "0")}T14:00:00Z`,
  exitAt: `2026-09-${String(i + 1).padStart(2, "0")}T15:00:00Z`,
  grossReturn: i % 3 ? 0.03 : -0.01,
  costFraction: 0.001,
}));
describe("research trade economics", () => {
  it("never includes an open or future outcome in its prediction", () => {
    const args = { policy, decisionAt: observations[5].entryAt, roundTripCostFraction: 0.001 };
    const original = estimateFinanceTradeEconomics({ ...args, observations });
    const changed = observations.map((row, i) => (i >= 5 ? { ...row, grossReturn: -0.9 } : row));
    expect(estimateFinanceTradeEconomics({ ...args, observations: changed })).toEqual(original);
    expect(original.observedTrades).toBe(5);
  });
  it("requires evidence and respects cost, risk and allocation limits", () => {
    expect(
      estimateFinanceTradeEconomics({
        observations: [],
        policy,
        decisionAt: observations[0].entryAt,
        roundTripCostFraction: 0,
      }).allocationFraction,
    ).toBe(0);
    const args = { observations, policy, decisionAt: "2026-10-01T00:00:00Z" };
    const cheap = estimateFinanceTradeEconomics({ ...args, roundTripCostFraction: 0.001 });
    expect(cheap.allocationFraction).toBeGreaterThan(0);
    expect(cheap.allocationFraction).toBeLessThanOrEqual(policy.maxAllocationFraction);
    expect(
      estimateFinanceTradeEconomics({ ...args, roundTripCostFraction: 0.1 }).allocationFraction,
    ).toBe(0);
    expect(() =>
      estimateFinanceTradeEconomics({
        ...args,
        observations: [observations[0], observations[0]],
        roundTripCostFraction: 0,
      }),
    ).toThrow("duplicate");
  });
  it("records calibration and both strategies on the same cost model without promotion", () => {
    const result = evaluateFinanceTradeEconomics({
      observations,
      policy,
      additionalCostFraction: 0,
      assumedRoundTripCostFraction: 0.001,
    });
    expect(result.scoredPredictions).toBe(8);
    expect(result.brierScore).not.toBeNull();
    expect(result.promotionAllowed).toBe(false);
    expect(result.decisions[0].estimate.allocationFraction).toBe(0);
  });
});

describe("net profit diagnostics", () => {
  const evaluate = (returns: number[], costs = 0) =>
    evaluateFinanceTradeEconomics({
      observations: returns.map((grossReturn, i) => ({
        ...observations[i],
        grossReturn,
        costFraction: costs,
      })),
      policy,
      additionalCostFraction: 0,
      assumedRoundTripCostFraction: costs,
    });
  it("exposes frequent small wins erased by one large loss", () => {
    const result = evaluate([0.01, 0.01, 0.01, 0.01, -0.06]);
    const net = result.netEconomics.allOpportunities;
    expect(net.netWinRate).toBe(0.8);
    expect(net.meanNetReturn).toBeCloseTo(-0.004);
    expect(net.profitFactor).toBeCloseTo(2 / 3);
    expect(net.averageWinsErasedByLargestLoss).toBe(6);
    expect(result.calibrationTarget).toBe("gross_return_positive_before_costs");
  });
  it("counts costs that turn apparent winners into losses and does not call skipped trades wins", () => {
    const result = evaluate([0.001, 0.001], 0.002);
    expect(result.netEconomics.grossWinnersLostAfterCosts).toBe(2);
    expect(result.netEconomics.allOpportunities.netWins).toBe(0);
    expect(result.netEconomics.allOpportunities.netLosses).toBe(2);
    expect(result.netEconomics.selectedOpportunities.observations).toBe(0);
    expect(result.netEconomics.selectedOpportunities.netWinRate).toBeNull();
    expect(result.netEconomics.skippedOpportunities).toBe(2);
  });
  it("keeps missing denominators explicit for empty, no-loss and no-win samples", () => {
    expect(evaluate([]).netEconomics.allOpportunities.meanNetReturn).toBeNull();
    expect(evaluate([0.01]).netEconomics.allOpportunities.profitFactor).toBeNull();
    expect(
      evaluate([-0.01]).netEconomics.allOpportunities.averageWinsErasedByLargestLoss,
    ).toBeNull();
    expect(evaluate([0]).netEconomics.allOpportunities.netBreakevens).toBe(1);
  });
});

describe("same-model prospective paired selection diagnostics", () => {
  const hash = "a".repeat(64);
  const protocol = {
    schemaVersion: "lcx_finance_paired_economics_protocol_v1" as const,
    frozenAt: "2026-10-05T00:00:00Z",
    sourceSha: "b".repeat(40),
    modelRef: "configured/model",
    modelConfigRef: hash,
    promptRefs: { system: hash, baseline: "c".repeat(64) },
    maxModelCalls: 2,
    maxToolCalls: 2,
    timeoutMs: 60_000,
    notionalUsd: 100,
    horizonSeconds: 3_600,
  };
  const candidate = () => ({
    id: "candidate-1",
    candidateAt: "2026-10-06T14:00:00Z",
    registeredAt: "2026-10-06T14:00:01Z",
    requestRef: hash,
    system: {
      modelRef: protocol.modelRef,
      modelConfigRef: hash,
      promptRef: protocol.promptRefs.system,
      decidedAt: "2026-10-06T14:00:20Z",
      decision: "approve" as "approve" | "veto" | "failed",
      modelCalls: 1,
      toolCalls: 0,
      latencyMs: 19_000,
      inferenceCostUsd: 0.02 as number | null,
      receiptRef: hash,
    },
    baseline: {
      modelRef: protocol.modelRef,
      modelConfigRef: hash,
      promptRef: protocol.promptRefs.baseline,
      decidedAt: "2026-10-06T14:00:25Z",
      decision: "veto" as "approve" | "veto" | "failed",
      modelCalls: 1,
      toolCalls: 0,
      latencyMs: 24_000,
      inferenceCostUsd: 0.01 as number | null,
      receiptRef: hash,
    },
    outcome: {
      basis: "common_quote_replay" as const,
      entryAt: "2026-10-06T14:01:00Z",
      exitAt: "2026-10-06T15:01:00Z",
      grossPnlUsd: 2,
      tradingCostUsd: 0.1 as number | null,
      notionalUsd: 100,
      receiptRef: hash,
    },
  });
  const evaluate = (
    rows: Parameters<typeof evaluateFinancePairedEconomics>[0]["candidates"],
    asOf = "2026-10-06T16:00:00Z",
  ) => evaluateFinancePairedEconomics({ protocol, candidates: rows, asOf });
  it("charges both inference bills, including abstention, without calling replay broker profit", () => {
    const result = evaluate([candidate()]);
    expect(result.rows[0].systemNetPnlUsd).toBeCloseTo(1.88);
    expect(result.rows[0].baselineNetPnlUsd).toBe(-0.01);
    expect(result.fullManifestIncrementalNetPnlUsd).toBeCloseTo(1.89);
    expect(result.promotionAllowed).toBe(false);
    expect(result.executionAuthority).toBe("none");
  });
  it("shows losing approvals and cost differences when both arms abstain", () => {
    const row = candidate();
    row.outcome.grossPnlUsd = -2;
    expect(evaluate([row]).fullManifestIncrementalNetPnlUsd).toBeCloseTo(-2.11);
    row.system.decision = "veto";
    expect(evaluate([row]).fullManifestIncrementalNetPnlUsd).toBeCloseTo(-0.01);
  });
  it("retains missing/failed candidates and refuses an aggregate winner from incomplete coverage", () => {
    const row = candidate();
    row.id = "candidate-2";
    const result = evaluate([candidate(), { ...row, baseline: null }]);
    expect(result.totalCandidates).toBe(2);
    expect(result.coverage).toBe(0.5);
    expect(result.coveredPairs.incrementalNetPnlUsd).toBeCloseTo(1.89);
    expect(result.fullManifestIncrementalNetPnlUsd).toBeNull();
    row.system.decision = "failed";
    expect(evaluate([row]).rows[0].issues).toContain("system_decision_failed");
  });
  it.each(["inference", "trading", "outcome"])("preserves unknown %s costs or outcomes", (kind) => {
    const row = candidate();
    if (kind === "inference") {
      row.baseline.inferenceCostUsd = null;
    }
    if (kind === "trading") {
      row.outcome.tradingCostUsd = null;
    }
    const result = evaluate([{ ...row, ...(kind === "outcome" ? { outcome: null } : {}) }]);
    expect(result.scoredCandidates).toBe(0);
    expect(result.coveredPairs.incrementalNetPnlUsd).toBeNull();
  });
  it.each(["model", "capacity", "prompt", "calls", "tools", "latency", "notional"])(
    "rejects %s mismatch instead of silently normalizing it",
    (kind) => {
      const row = candidate();
      if (kind === "model") {
        row.baseline.modelRef = "different/model";
      }
      if (kind === "capacity") {
        row.baseline.modelConfigRef = "d".repeat(64);
      }
      if (kind === "prompt") {
        row.baseline.promptRef = hash;
      }
      if (kind === "calls") {
        row.baseline.modelCalls = 3;
      }
      if (kind === "tools") {
        row.baseline.toolCalls = 3;
      }
      if (kind === "latency") {
        row.baseline.latencyMs = 60_001;
      }
      if (kind === "notional") {
        row.outcome.notionalUsd = 101;
      }
      expect(evaluate([row]).scoredCandidates).toBe(0);
    },
  );
  it.each([
    "historical",
    "late_registration",
    "future_decision",
    "late_decision",
    "horizon",
    "future_outcome",
  ])("rejects %s timing leakage", (kind) => {
    const row = candidate();
    if (kind === "historical") {
      row.candidateAt = "2026-10-04T14:00:00Z";
    }
    if (kind === "late_registration") {
      row.registeredAt = "2026-10-06T14:00:30Z";
    }
    if (kind === "future_decision") {
      row.system.decidedAt = "2026-10-07T14:00:00Z";
    }
    if (kind === "late_decision") {
      row.system.decidedAt = "2026-10-06T14:01:01Z";
    }
    if (kind === "horizon") {
      row.outcome.exitAt = "2026-10-06T15:02:00Z";
    }
    if (kind === "future_outcome") {
      row.outcome.exitAt = "2026-10-07T15:01:00Z";
    }
    expect(evaluate([row]).scoredCandidates).toBe(0);
  });
  it("requires strict temporal precedence rather than ties without sequence authority", () => {
    const row = candidate();
    row.system.decidedAt = row.registeredAt;
    expect(evaluate([row]).rows[0].issues).toContain("system_decision_time_invalid");
    row.system.decidedAt = row.outcome.entryAt;
    expect(evaluate([row]).rows[0].issues).toContain("outcome_time_invalid_or_not_yet_available");
  });
  it("does not serialize derived or aggregate overflow as a completed comparison", () => {
    const row = candidate();
    row.outcome.grossPnlUsd = -1e308;
    row.outcome.tradingCostUsd = 1e308;
    expect(evaluate([row]).rows[0].issues).toContain("nonfinite_derived_economics");
    row.outcome.grossPnlUsd = 1e308;
    row.outcome.tradingCostUsd = 0;
    const result = evaluate([row, { ...row, id: "candidate-2" }]);
    expect(result.evaluationIssues).toContain("nonfinite_aggregate_economics");
    expect(result.status).toBe("incomplete_evidence");
    expect(result.fullManifestIncrementalNetPnlUsd).toBeNull();
    expect(result.coveredPairs.incrementalNetPnlUsd).toBeNull();
  });
  it("does not rank empty samples, duplicate candidates or an unfrozen policy", () => {
    expect(evaluate([]).coverage).toBeNull();
    expect(evaluate([]).fullManifestIncrementalNetPnlUsd).toBeNull();
    expect(() => evaluate([candidate(), candidate()])).toThrow("duplicate");
    expect(() => evaluate([], "2026-10-04T23:59:59Z")).toThrow("not frozen");
  });
});
