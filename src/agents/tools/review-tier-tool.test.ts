import { describe, expect, it } from "vitest";
import { createReviewTierTool } from "./review-tier-tool.js";

describe("createReviewTierTool", () => {
  it("returns the lowest sufficient tier for ordinary local tool output", async () => {
    const tool = createReviewTierTool();
    const result = await tool.execute("review-tier-1", {
      taskKind: "local_tool_result",
      hasLocalToolResults: true,
    });

    expect(result.details).toMatchObject({
      tier: "local_only",
      tokenPolicy: "avoid_model_review",
    });
  });

  it("escalates strict portfolio-risk research to three model review", async () => {
    const tool = createReviewTierTool();
    const result = await tool.execute("review-tier-2", {
      taskKind: "research_conclusion",
      hasLocalToolResults: true,
      hasQuantMathResults: true,
      writesDurableMemory: true,
      involvesPortfolioRisk: true,
      explicitlyRequestedStrictReview: true,
    });

    expect(result.details).toMatchObject({
      tier: "three_model_review",
      reviewers: ["logic_and_expression", "risk_and_countercase", "math_and_evidence_consistency"],
      tokenPolicy: "use_three_model_panel",
    });
  });
});
