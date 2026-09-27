import { describe, expect, it } from "vitest";
import {
  estimateFinanceTradeEconomics,
  evaluateFinanceTradeEconomics,
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
