export type ReviewTier = "local_only" | "single_model_review" | "three_model_review";

export type ReviewTierInput = {
  taskKind: "routine_chat" | "local_tool_result" | "finance_learning" | "research_conclusion";
  hasLocalToolResults?: boolean;
  hasQuantMathResults?: boolean;
  writesDurableMemory?: boolean;
  affectsDoctrineOrPromotion?: boolean;
  involvesPortfolioRisk?: boolean;
  explicitlyRequestedStrictReview?: boolean;
};

export type ReviewTierDecision = {
  tier: ReviewTier;
  reviewers: string[];
  reasons: string[];
  tokenPolicy: "avoid_model_review" | "use_primary_model" | "use_three_model_panel";
  boundary: string;
};

export function resolveReviewTier(input: ReviewTierInput): ReviewTierDecision {
  const reasons: string[] = [];

  if (input.explicitlyRequestedStrictReview) {
    reasons.push("operator_requested_strict_review");
  }
  if (input.writesDurableMemory) {
    reasons.push("writes_durable_memory");
  }
  if (input.affectsDoctrineOrPromotion) {
    reasons.push("affects_doctrine_or_promotion");
  }
  if (input.involvesPortfolioRisk) {
    reasons.push("involves_portfolio_risk");
  }
  if (input.hasQuantMathResults) {
    reasons.push("has_quant_math_results");
  }
  if (input.hasLocalToolResults) {
    reasons.push("has_local_tool_results");
  }

  if (
    input.explicitlyRequestedStrictReview ||
    input.affectsDoctrineOrPromotion ||
    (input.writesDurableMemory && input.involvesPortfolioRisk) ||
    (input.taskKind === "research_conclusion" && input.involvesPortfolioRisk)
  ) {
    return {
      tier: "three_model_review",
      reviewers: ["logic_and_expression", "risk_and_countercase", "math_and_evidence_consistency"],
      reasons,
      tokenPolicy: "use_three_model_panel",
      boundary:
        "Three-model review is reserved for high-value or high-risk research output; it is not a default chat path.",
    };
  }

  if (
    input.taskKind === "finance_learning" ||
    input.taskKind === "research_conclusion" ||
    input.hasQuantMathResults ||
    input.writesDurableMemory
  ) {
    return {
      tier: "single_model_review",
      reviewers: ["primary_model_editor"],
      reasons,
      tokenPolicy: "use_primary_model",
      boundary:
        "Primary model review checks wording, omissions, and whether local tool results are explained without replacing deterministic math.",
    };
  }

  return {
    tier: "local_only",
    reviewers: [],
    reasons,
    tokenPolicy: "avoid_model_review",
    boundary:
      "Local-only review is for bounded deterministic checks where model review would waste tokens.",
  };
}
