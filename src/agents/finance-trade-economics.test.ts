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
