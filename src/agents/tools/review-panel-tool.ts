import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveReviewTier } from "../review-tier-policy.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { readBooleanToolParam, readReviewTierInput } from "./review-tool-params.js";

const ReviewPanelSchema = Type.Object({
  taskKind: Type.String(),
  outputText: Type.String(),
  hasLocalToolResults: Type.Optional(Type.Boolean()),
  hasQuantMathResults: Type.Optional(Type.Boolean()),
  writesDurableMemory: Type.Optional(Type.Boolean()),
  affectsDoctrineOrPromotion: Type.Optional(Type.Boolean()),
  involvesPortfolioRisk: Type.Optional(Type.Boolean()),
  explicitlyRequestedStrictReview: Type.Optional(Type.Boolean()),
  runLocalArbitration: Type.Optional(Type.Boolean()),
  writeReceipt: Type.Optional(Type.Boolean()),
});

type ReviewPanelStatus =
  | "not_required"
  | "single_model_review_required"
  | "three_model_panel_ready"
  | "three_model_panel_arbitrated";

function buildReviewerTasks(outputText: string) {
  return [
    {
      reviewer: "logic_and_expression",
      objective:
        "Check whether the answer is coherent, concise, and directly answers the operator without hiding uncertainty.",
      focus: ["claim clarity", "missing caveats", "overstatement", "actionable summary"],
      prompt: [
        "Review the candidate output for logic and expression.",
        "Return only defects, required edits, and a keep/discard recommendation.",
        "",
        outputText,
      ].join("\n"),
    },
    {
      reviewer: "risk_and_countercase",
      objective:
        "Find portfolio-risk, regime, behavior, and counter-case failures before the output reaches the operator.",
      focus: [
        "risk boundary",
        "invalidating evidence",
        "overconfidence",
        "trade-authority leakage",
      ],
      prompt: [
        "Review the candidate output for risk and counter-cases.",
        "Return the strongest objection, missing risk gate, and whether the output should be softened.",
        "",
        outputText,
      ].join("\n"),
    },
    {
      reviewer: "math_and_evidence_consistency",
      objective:
        "Check whether quantitative claims are backed by local tool outputs and evidence rather than model guesswork.",
      focus: [
        "math/tool consistency",
        "citation to local results",
        "unsupported numbers",
        "evidence gaps",
      ],
      prompt: [
        "Review the candidate output for math and evidence consistency.",
        "Return any unsupported numeric claim, missing tool-result reference, or evidence mismatch.",
        "",
        outputText,
      ].join("\n"),
    },
  ];
}

function includesAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function buildLocalArbitration(params: {
  outputText: string;
  reviewerTasks: Array<{ reviewer: string }>;
}) {
  if (params.reviewerTasks.length < 3) {
    return null;
  }
  const text = params.outputText.toLowerCase();
  const findings = [
    {
      reviewer: "logic_and_expression",
      status: params.outputText.trim().length > 0 ? "pass" : "block",
      finding:
        params.outputText.trim().length > 0
          ? "Candidate output is non-empty and can be reviewed."
          : "Candidate output is empty.",
    },
    {
      reviewer: "risk_and_countercase",
      status:
        includesAny(text, ["research_only", "research-only"]) &&
        includesAny(text, ["no_execution_authority", "no trade", "no-action"])
          ? "pass"
          : "block",
      finding:
        "Research-only and no-execution boundaries must be visible before operator-facing use.",
    },
    {
      reviewer: "math_and_evidence_consistency",
      status:
        includesAny(text, ["quant_math", "no_model_math_guessing"]) &&
        includesAny(text, ["risk_budget_deviation", "rolling_beta", "drawdown_duration"])
          ? "pass"
          : "block",
      finding:
        "Quantitative claims must reference deterministic local math checks rather than model guessing.",
    },
  ];
  const blockingFindings = findings.filter((entry) => entry.status === "block");
  return {
    status: blockingFindings.length === 0 ? "passed" : "blocked",
    mode: "local_deterministic_arbitration",
    providerCallsMade: false,
    reviewerFindings: findings,
    blockingFindings,
    reconciliationDecision:
      blockingFindings.length === 0
        ? "keep_with_research_only_boundary"
        : "revise_before_operator_send",
    boundary:
      "Local arbitration is deterministic receipt proof that reviewer work orders were checked; it is not a completed external provider review.",
  };
}

function buildPanelResult(params: {
  outputText: string;
  tier: ReturnType<typeof resolveReviewTier>;
  runLocalArbitration: boolean;
}) {
  const { tier } = params;
  let status: ReviewPanelStatus = "not_required";
  if (tier.tier === "single_model_review") {
    status = "single_model_review_required";
  } else if (tier.tier === "three_model_review") {
    status = "three_model_panel_ready";
  }

  const reviewerTasks =
    tier.tier === "three_model_review" ? buildReviewerTasks(params.outputText) : [];
  const localArbitration = params.runLocalArbitration
    ? buildLocalArbitration({ outputText: params.outputText, reviewerTasks })
    : null;
  if (localArbitration?.status === "passed") {
    status = "three_model_panel_arbitrated";
  }

  return {
    status,
    tier: tier.tier,
    tokenPolicy: tier.tokenPolicy,
    reviewers: tier.reviewers,
    reasons: tier.reasons,
    reviewerTasks,
    localArbitration,
    reconciliation: {
      mode: tier.tier === "three_model_review" ? "block_on_conflict" : "not_required",
      mergeRule:
        "Do not average reviewer opinions. If reviewers conflict, preserve the stricter risk/math objection and require a revised output before sending.",
      sendBoundary:
        "This tool prepares the review panel work order and receipt; provider/model execution is intentionally outside this bounded tool.",
    },
  };
}

async function writePanelReceipt(params: {
  workspaceDir: string;
  payload: Record<string, unknown>;
}) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const relPath = path.join(
    "memory",
    "review-panel-receipts",
    dateKey,
    `${new Date().toISOString().replace(/[:.]/gu, "-")}__review-panel.json`,
  );
  const absPath = path.join(params.workspaceDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, `${JSON.stringify(params.payload, null, 2)}\n`);
  return relPath.split(path.sep).join("/");
}

export function createReviewPanelTool(options?: { workspaceDir?: string }): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Review Panel",
    name: "review_panel",
    description:
      "Prepare a bounded review-panel work order from a candidate output. It uses review_tier policy, creates three reviewer tasks only for high-risk three_model_review cases, and can write a receipt without calling providers or changing memory doctrine.",
    parameters: ReviewPanelSchema,
    execute: async (_toolCallId, params) => {
      const outputText = readStringParam(params, "outputText", { required: true });
      const tier = resolveReviewTier(readReviewTierInput(params));
      const runLocalArbitration = readBooleanToolParam(params, "runLocalArbitration") ?? false;
      const result = buildPanelResult({ outputText, tier, runLocalArbitration });
      const writeReceipt = readBooleanToolParam(params, "writeReceipt") ?? false;
      const receiptPath = writeReceipt
        ? await writePanelReceipt({
            workspaceDir,
            payload: {
              schemaVersion: 1,
              boundary: "review_panel_work_order",
              generatedAt: new Date().toISOString(),
              result,
            },
          })
        : null;
      return jsonResult({
        ...result,
        receiptPath,
        providerCallsMade: false,
        noDurableDoctrineMutation: true,
      });
    },
  };
}
