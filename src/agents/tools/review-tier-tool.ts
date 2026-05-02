import { Type } from "@sinclair/typebox";
import { resolveReviewTier } from "../review-tier-policy.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { readReviewTierInput } from "./review-tool-params.js";

const ReviewTierSchema = Type.Object({
  taskKind: Type.String(),
  hasLocalToolResults: Type.Optional(Type.Boolean()),
  hasQuantMathResults: Type.Optional(Type.Boolean()),
  writesDurableMemory: Type.Optional(Type.Boolean()),
  affectsDoctrineOrPromotion: Type.Optional(Type.Boolean()),
  involvesPortfolioRisk: Type.Optional(Type.Boolean()),
  explicitlyRequestedStrictReview: Type.Optional(Type.Boolean()),
});

export function createReviewTierTool(): AnyAgentTool {
  return {
    label: "Review Tier",
    name: "review_tier",
    description:
      "Choose the lowest sufficient review tier before sending or preserving an agent output: local_only, single_model_review, or three_model_review. Use this to avoid unnecessary token burn while escalating high-risk finance, portfolio-risk, doctrine, durable-memory, or strict-review work.",
    parameters: ReviewTierSchema,
    execute: async (_toolCallId, params) => {
      return jsonResult(resolveReviewTier(readReviewTierInput(params)));
    },
  };
}
