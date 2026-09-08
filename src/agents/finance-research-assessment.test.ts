import { expect, it } from "vitest";
import { verifyFinanceResearchAssessment } from "./finance-research-assessment.js";
const value = {
  causalHypotheses: ["liquidity", "earnings"].map((id) => ({
    id,
    cause: id,
    effect: "return",
    mechanism: "discounting",
    evidenceIds: ["e"],
    alternativeExplanations: ["risk premium"],
    disconfirmingTest: "compare non-event windows",
    status: "hypothesis",
  })),
  scenarios: ["base", "up", "down"].map((id, i) => ({
    id,
    probability: [0.5, 0.3, 0.2][i],
    condition: id,
    expectedEffect: "conditional repricing",
    invalidation: "new evidence",
    evidenceIds: ["e"],
  })),
};
it("checks scenario math and references independently of model approval", () => {
  expect(verifyFinanceResearchAssessment(value, new Set(["e"])).passed).toBe(true);
  expect(verifyFinanceResearchAssessment(value, new Set()).passed).toBe(false);
  expect(
    verifyFinanceResearchAssessment(
      { ...value, scenarios: value.scenarios.map((s) => ({ ...s, probability: 0.8 })) },
      new Set(["e"]),
    ).passed,
  ).toBe(false);
});
it("rejects prose-only attribution and certain-causality labels", () => {
  expect(verifyFinanceResearchAssessment(undefined, new Set()).passed).toBe(false);
  expect(
    verifyFinanceResearchAssessment(
      {
        ...value,
        causalHypotheses: value.causalHypotheses.map((h) => ({ ...h, status: "proven" })),
      },
      new Set(["e"]),
    ).passed,
  ).toBe(false);
});
