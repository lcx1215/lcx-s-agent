import { describe, expect, it } from "vitest";
import { resolveReviewTier } from "./review-tier-policy.js";

describe("resolveReviewTier", () => {
  it("keeps deterministic local tool checks local-only by default", () => {
    const decision = resolveReviewTier({
      taskKind: "local_tool_result",
      hasLocalToolResults: true,
    });

    expect(decision).toMatchObject({
      tier: "local_only",
      reviewers: [],
      tokenPolicy: "avoid_model_review",
    });
  });

  it("uses a single model for finance learning with quant math results", () => {
    const decision = resolveReviewTier({
      taskKind: "finance_learning",
      hasLocalToolResults: true,
      hasQuantMathResults: true,
    });

    expect(decision).toMatchObject({
      tier: "single_model_review",
      reviewers: ["primary_model_editor"],
      tokenPolicy: "use_primary_model",
    });
    expect(decision.reasons).toContain("has_quant_math_results");
  });

  it("escalates durable portfolio-risk memory to a three-model panel", () => {
    const decision = resolveReviewTier({
      taskKind: "research_conclusion",
      hasLocalToolResults: true,
      hasQuantMathResults: true,
      writesDurableMemory: true,
      involvesPortfolioRisk: true,
    });

    expect(decision).toMatchObject({
      tier: "three_model_review",
      reviewers: ["logic_and_expression", "risk_and_countercase", "math_and_evidence_consistency"],
      tokenPolicy: "use_three_model_panel",
    });
    expect(decision.reasons).toContain("writes_durable_memory");
    expect(decision.reasons).toContain("involves_portfolio_risk");
  });
});
