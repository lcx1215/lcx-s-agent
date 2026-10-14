import { describe, expect, it } from "vitest";
import { createQuantMathTool } from "./quant-math-tool.js";

const policy = {
  minObservations: 2,
  priorWins: 1,
  priorLosses: 1,
  kellyFraction: 0.25,
  maxAllocationFraction: 0.5,
  maxLossBudgetFraction: 0.01,
  uncertaintyPenalty: 1.96,
};
function task(returns = [0.002, -0.003, 0.001]) {
  return {
    action: "trade_economics_eval",
    observations: returns.map((grossReturn, i) => ({
      id: `trade-${i}`,
      entryAt: `2026-01-0${i + 1}T14:30:00.000Z`,
      exitAt: `2026-01-0${i + 1}T15:30:00.000Z`,
      grossReturn,
      costFraction: 0.001,
    })),
    policy,
    additionalCostFraction: 0.002,
    assumedRoundTripCostFraction: 0.003,
  };
}
async function evaluate(input = task()) {
  const result = await createQuantMathTool().execute("method-task", input);
  return result.details as {
    datasetRef: string;
    policyRef: string;
    executionAuthority: string;
    promotionAllowed: boolean;
    netEconomics: {
      allOpportunities: { meanNetReturn: number };
      grossWinnersLostAfterCosts: number;
    };
    lastDecision: {
      actualNetReturn: number;
      estimate: { observedTrades: number; evidenceRef: string; expectedNetReturn: number };
    };
    feedback: {
      datasetRef: string;
      policyRef: string;
      corrections: string[];
      sourceMethodAdoption: string;
    };
  };
}

describe("quant_math native economics result and correction feedback", () => {
  it("evaluates actual task returns after declared costs and returns concrete corrections", async () => {
    const result = await evaluate();
    expect(result.netEconomics.allOpportunities.meanNetReturn).toBeCloseTo(-0.003, 10);
    expect(result.netEconomics.grossWinnersLostAfterCosts).toBe(2);
    expect(result.lastDecision.actualNetReturn).toBeCloseTo(-0.002, 10);
    expect(result.feedback.corrections).toEqual(
      expect.arrayContaining([
        expect.stringContaining("nonpositive_sample_net_return"),
        expect.stringContaining("costs_erase_gross_winners"),
        expect.stringContaining("no_selected_trades"),
      ]),
    );
    expect(result.feedback.datasetRef).toBe(result.datasetRef);
    expect(result.feedback.policyRef).toBe(result.policyRef);
    expect(result.executionAuthority).toBe("none");
    expect(result.promotionAllowed).toBe(false);
    expect(result.feedback.sourceMethodAdoption).toBe("not_proven_by_arithmetic");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
  });

  it("changes feedback with task results without leaking the current outcome into its estimate", async () => {
    const before = await evaluate();
    const after = await evaluate(task([0.002, -0.003, 0.2]));
    expect(after.datasetRef).not.toBe(before.datasetRef);
    expect(after.lastDecision.actualNetReturn).toBeCloseTo(0.197, 10);
    expect(after.lastDecision.estimate).toEqual(before.lastDecision.estimate);
    expect(after.lastDecision.estimate.observedTrades).toBe(2);
    expect(
      after.feedback.corrections.some((c) => c.startsWith("nonpositive_sample_net_return")),
    ).toBe(false);
  });

  it.each([
    "empty",
    "too_many",
    "invalid_cost",
    "overlap",
    "missing_policy",
    "duplicate_id",
    "long_id",
  ])("refuses %s rather than produce successful feedback", async (kind) => {
    const input = task();
    if (kind === "duplicate_id") {
      input.observations[1].id = input.observations[0].id;
    }
    if (kind === "long_id") {
      input.observations[0].id = "x".repeat(121);
    }
    if (kind === "empty") {
      input.observations = [];
    }
    if (kind === "too_many") {
      input.observations = Array.from({ length: 501 }, () => input.observations[0]);
    }
    if (kind === "invalid_cost") {
      input.additionalCostFraction = -1;
    }
    if (kind === "overlap") {
      input.observations[0].exitAt = input.observations[2].exitAt;
    }
    if (kind === "missing_policy") {
      Reflect.deleteProperty(input, "policy");
    }
    await expect(evaluate(input)).rejects.toThrow();
  });
});
