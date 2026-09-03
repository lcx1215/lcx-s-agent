import type { LogicalAgentPlanResult, LogicalAgentTaskResult } from "./logical-agent-pool.js";
import {
  findQualityStageResult,
  isQualityRecord,
  qualityStringArray,
  requiredQualityText,
  type QualityHarnessArtifact,
  type QualityHarnessAttemptReceipt,
  type QualityHarnessEvidence,
  type QualityHarnessGate,
  type QualityHarnessRequest,
  type QualityHarnessStage,
  type QualityHarnessStageOutput,
  type QualityHarnessStageReceipt,
  type QualityHarnessVerification,
  type QualityHarnessVerifier,
} from "./quality-harness-contract.js";

export type QualityEvaluation = Readonly<{
  passed: boolean;
  artifact?: QualityHarnessArtifact;
  gates: readonly QualityHarnessGate[];
  feedback: readonly string[];
}>;

function normalizeFeedback(feedback: readonly string[]): string[] {
  return feedback
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().slice(0, 1_000))
    .slice(0, 12);
}

function validateGrounding(
  artifact: QualityHarnessArtifact | undefined,
  evidence: readonly QualityHarnessEvidence[],
): string[] {
  if (!artifact) {
    return ["final artifact is missing"];
  }
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  const problems: string[] = [];
  for (const claim of artifact.claims) {
    const unknown = claim.evidenceIds.filter((id) => !evidenceIds.has(id));
    if (unknown.length > 0) {
      problems.push(`claim ${claim.id} cites unknown evidence: ${unknown.join(", ")}`);
    }
    if (claim.status === "supported" && claim.evidenceIds.length === 0) {
      problems.push(`claim ${claim.id} has no evidence`);
    }
    if (claim.status === "uncertain" && !claim.uncertainty) {
      problems.push(`claim ${claim.id} hides its uncertainty reason`);
    }
  }
  return problems;
}

function reviewPassed(
  result: LogicalAgentTaskResult<QualityHarnessStageOutput> | undefined,
  stage: QualityHarnessStage,
): { passed: boolean; reason: string; feedback: string[] } {
  const review =
    result?.status === "completed" && result.output?.kind === "review"
      ? result.output.review
      : undefined;
  if (!review) {
    return {
      passed: false,
      reason: `${stage} review is missing`,
      feedback: [`${stage} review did not complete`],
    };
  }
  const feedback = [...review.criticalFindings, ...review.evidenceGaps].slice(0, 12);
  const passed = review.verdict === "pass" && feedback.length === 0;
  return {
    passed,
    reason: passed ? `${stage} review passed` : `${stage} review requires revision`,
    feedback: feedback.length > 0 ? feedback : [`${stage} verdict=${review.verdict}`],
  };
}

export function evaluateQuality(
  result: LogicalAgentPlanResult<QualityHarnessStageOutput>,
  request: QualityHarnessRequest,
): QualityEvaluation {
  const format = findQualityStageResult(result, "formatting");
  const artifact =
    format?.status === "completed" && format.output?.kind === "artifact"
      ? format.output.artifact
      : undefined;
  const groundingProblems = validateGrounding(artifact, request.evidence);
  const evidenceReview = reviewPassed(
    findQualityStageResult(result, "evidence_integrity"),
    "evidence",
  );
  const supportingReviews = [
    reviewPassed(findQualityStageResult(result, "financial_extraction"), "extraction"),
    reviewPassed(findQualityStageResult(result, "news_classification"), "classification"),
    reviewPassed(findQualityStageResult(result, "risk_check"), "risk"),
    reviewPassed(findQualityStageResult(result, "portfolio_exposure"), "exposure"),
  ];
  const adversarialReview = reviewPassed(
    findQualityStageResult(result, "adversarial_challenge"),
    "adversarial",
  );
  const precheck = reviewPassed(findQualityStageResult(result, "final_precheck"), "precheck");
  const allStagesCompleted = result.status === "completed" && result.tasks.length === 10;
  const sideEffects = result.tasks.flatMap((entry) => entry.sideEffects);
  const gates: QualityHarnessGate[] = [
    {
      id: "all_stages_completed",
      passed: allStagesCompleted,
      reason: allStagesCompleted
        ? "all ten existing role stages completed"
        : "one or more role stages failed or were blocked",
    },
    {
      id: "artifact_contract",
      passed: artifact !== undefined,
      reason: artifact
        ? "format stage returned a structured artifact"
        : "format stage did not return an artifact",
    },
    {
      id: "claims_grounded",
      passed: groundingProblems.length === 0,
      reason:
        groundingProblems.length === 0
          ? "claims cite known evidence or explicit uncertainty"
          : groundingProblems.join("; "),
    },
    {
      id: "supporting_role_reviews",
      passed: supportingReviews.every((review) => review.passed),
      reason: supportingReviews.every((review) => review.passed)
        ? "extraction, classification, risk, and exposure roles passed"
        : supportingReviews
            .filter((review) => !review.passed)
            .map((review) => review.reason)
            .join("; "),
    },
    {
      id: "evidence_integrity_review",
      passed: evidenceReview.passed,
      reason: evidenceReview.reason,
    },
    {
      id: "adversarial_review",
      passed: adversarialReview.passed,
      reason: adversarialReview.reason,
    },
    { id: "final_precheck", passed: precheck.passed, reason: precheck.reason },
    {
      id: "no_forbidden_side_effects",
      passed: sideEffects.length === 0,
      reason:
        sideEffects.length === 0
          ? "all local role stages declared no side effects"
          : `unexpected side effects: ${sideEffects.join(", ")}`,
    },
  ];
  const feedback = normalizeFeedback([
    ...groundingProblems,
    ...supportingReviews.flatMap((review) => review.feedback),
    ...evidenceReview.feedback,
    ...adversarialReview.feedback,
    ...precheck.feedback,
    ...gates.filter((gate) => !gate.passed).map((gate) => gate.reason),
  ]);
  return Object.freeze({
    passed: gates.every((gate) => gate.passed),
    ...(artifact ? { artifact } : {}),
    gates: Object.freeze(gates),
    feedback: Object.freeze(feedback),
  });
}

export function summarizeQualityStageResult(
  result: LogicalAgentTaskResult<QualityHarnessStageOutput>,
): QualityHarnessStageReceipt {
  const output = result.output;
  const review = output?.kind === "review" ? output.review : undefined;
  return Object.freeze({
    taskId: result.taskId,
    agentId: result.agentId,
    status: result.status,
    modelId: result.modelId,
    ...(output ? { outputKind: output.kind } : {}),
    ...(review
      ? {
          reviewVerdict: review.verdict,
          findingCount: review.criticalFindings.length + review.evidenceGaps.length,
        }
      : {}),
    sideEffects: Object.freeze([...result.sideEffects]),
    ...(result.error ? { error: result.error.slice(0, 1_000) } : {}),
  });
}

export function normalizeQualityVerification(
  value: QualityHarnessVerification,
): QualityHarnessVerification {
  if (
    !isQualityRecord(value) ||
    !["not-requested", "passed", "failed", "blocked"].includes(value.status as string)
  ) {
    throw new Error("quality verifier returned an invalid status");
  }
  return Object.freeze({
    status: value.status,
    summary: requiredQualityText(value.summary, "verification.summary", 2_000),
    details: Object.freeze(qualityStringArray(value.details, "verification.details", false)),
  });
}

export async function runQualityVerifier(
  verifier: QualityHarnessVerifier,
  request: QualityHarnessRequest,
  artifact: QualityHarnessArtifact,
  attempt: number,
): Promise<QualityHarnessVerification> {
  try {
    return normalizeQualityVerification(await verifier({ request, artifact, attempt }));
  } catch (error: unknown) {
    return Object.freeze({
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      details: [],
    });
  }
}

export function qualityAttemptStatus(params: {
  planStatus: LogicalAgentPlanResult<QualityHarnessStageOutput>["status"];
  qualityPassed: boolean;
  verification: QualityHarnessVerification;
}): QualityHarnessAttemptReceipt["status"] {
  if (params.planStatus !== "completed") {
    return "execution-failed";
  }
  if (!params.qualityPassed) {
    return "quality-failed";
  }
  if (params.verification.status === "failed") {
    return "verification-failed";
  }
  if (params.verification.status === "blocked") {
    return "verification-blocked";
  }
  return "quality-passed";
}

export function qualityFeedback(params: {
  quality: QualityEvaluation;
  verification: QualityHarnessVerification;
}): string[] {
  return normalizeFeedback([
    ...params.quality.feedback,
    ...(params.verification.status === "failed" || params.verification.status === "blocked"
      ? [params.verification.summary, ...params.verification.details]
      : []),
  ]);
}
