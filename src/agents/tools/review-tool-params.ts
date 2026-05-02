import type { ReviewTierInput } from "../review-tier-policy.js";
import { ToolInputError, readStringParam } from "./common.js";

const TASK_KINDS = new Set<ReviewTierInput["taskKind"]>([
  "routine_chat",
  "local_tool_result",
  "finance_learning",
  "research_conclusion",
]);

export function readBooleanToolParam(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolInputError(`${key} must be boolean`);
  }
  return value;
}

export function readReviewTaskKind(params: Record<string, unknown>): ReviewTierInput["taskKind"] {
  const taskKind = readStringParam(params, "taskKind", { required: true });
  if (!TASK_KINDS.has(taskKind as ReviewTierInput["taskKind"])) {
    throw new ToolInputError(
      "taskKind must be one of routine_chat, local_tool_result, finance_learning, research_conclusion",
    );
  }
  return taskKind as ReviewTierInput["taskKind"];
}

export function readReviewTierInput(params: Record<string, unknown>): ReviewTierInput {
  return {
    taskKind: readReviewTaskKind(params),
    hasLocalToolResults: readBooleanToolParam(params, "hasLocalToolResults"),
    hasQuantMathResults: readBooleanToolParam(params, "hasQuantMathResults"),
    writesDurableMemory: readBooleanToolParam(params, "writesDurableMemory"),
    affectsDoctrineOrPromotion: readBooleanToolParam(params, "affectsDoctrineOrPromotion"),
    involvesPortfolioRisk: readBooleanToolParam(params, "involvesPortfolioRisk"),
    explicitlyRequestedStrictReview: readBooleanToolParam(
      params,
      "explicitlyRequestedStrictReview",
    ),
  };
}
