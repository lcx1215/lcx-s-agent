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

const FINANCE_REQUEST_PATTERN =
  /股票|股价|投资|金融|市场|组合|持仓|ETF|基金|期权|收益|估值|财报|半导体|(?:stock|equity|portfolio|finance|market|invest|etf|fund|option|yield|valuation|earnings)/iu;
const CURRENT_DATA_PATTERN =
  /当前|最新|今天|今日|现在|截至|实时|股价|价格|市值|收益率|行情|current|latest|today|now|as of|price|market cap|yield/iu;
const DIRECT_TRADE_ACTION_PATTERN =
  /(?:\b(?:you\s+should|i\s+(?:recommend|would)|recommend(?:ed)?|consider|please)\b[^.!?\n]{0,60}\b(?:buy|sell|add|reduce|go long|go short)\b|\b(?:buy|sell|add|reduce|go long|go short)\b\s+(?:now|today|shares?|position|[A-Z]{1,6}\b)|(?:建议|应该|推荐|考虑|立即|现在)[^\n。！？]{0,30}(?:买入|卖出|加仓|减仓|做多|做空|增持|减持)|(?:买入|卖出|加仓|减仓|做多|做空|增持|减持)[^\n。！？]{0,12}(?:股票|仓位|标的|[A-Z]{1,6}\b))/iu;

function extractDataNumbers(text: string): string[] {
  return (text.match(/[$€£¥]?\s*\d[\d,]*(?:\.\d+)?%?/g) ?? []).map((value) =>
    value.replace(/\s+/g, ""),
  );
}

function normalizedNumber(value: string): string {
  return value.replace(/[$€£¥,%\s]/g, "").replace(/,/g, "");
}

function hasEvidenceTimestamp(evidence: QualityHarnessEvidence): boolean {
  return Boolean(
    evidence.source?.trim() ||
    /\b20\d{2}[-/]\d{1,2}(?:[-/]\d{1,2})?(?:[T ]\d{1,2}:\d{2})?\b|\b(?:UTC|北京时间|as of)\b/iu.test(
      evidence.text,
    ),
  );
}

function validateFinanceAnswerSafety(
  artifact: QualityHarnessArtifact | undefined,
  request: QualityHarnessRequest,
): string[] {
  if (!artifact || !FINANCE_REQUEST_PATTERN.test(request.task)) {
    return [];
  }
  const problems: string[] = [];
  if (DIRECT_TRADE_ACTION_PATTERN.test(artifact.answer)) {
    problems.push("final finance answer contains a direct trade action or recommendation");
  }

  if (CURRENT_DATA_PATTERN.test(request.task) || CURRENT_DATA_PATTERN.test(artifact.answer)) {
    const answerNumbers = extractDataNumbers(artifact.answer);
    if (answerNumbers.length > 0) {
      const evidenceById = new Map(request.evidence.map((entry) => [entry.id, entry]));
      const citedEvidence = artifact.claims
        .filter((claim) => claim.status === "supported")
        .flatMap((claim) => claim.evidenceIds)
        .map((id) => evidenceById.get(id))
        .filter((entry): entry is QualityHarnessEvidence => entry !== undefined);
      const citedNumbers = new Set(
        citedEvidence.flatMap((entry) => extractDataNumbers(entry.text).map(normalizedNumber)),
      );
      const unsupportedNumbers = answerNumbers.filter(
        (number) => !citedNumbers.has(normalizedNumber(number)),
      );
      if (unsupportedNumbers.length > 0) {
        problems.push(
          `final finance answer contains current-data numbers without matching cited evidence: ${unsupportedNumbers.join(", ")}`,
        );
      }
      if (!citedEvidence.some(hasEvidenceTimestamp)) {
        problems.push("current finance numbers require cited evidence with a source or timestamp");
      }
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
  const financeSafetyProblems = validateFinanceAnswerSafety(artifact, request);
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
      id: "finance_answer_safety",
      passed: financeSafetyProblems.length === 0,
      reason:
        financeSafetyProblems.length === 0
          ? "final finance answer contains no direct trade instruction or ungrounded current-data number"
          : financeSafetyProblems.join("; "),
    },
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
    ...financeSafetyProblems,
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
  timeoutMs = 30_000,
): Promise<QualityHarnessVerification> {
  const boundedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 2_147_483_647) : 30_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => verifier({ request, artifact, attempt, signal: controller.signal }))
        .then((value) => ({ kind: "result" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ kind: "timeout" });
        }, boundedTimeoutMs);
      }),
    ]);
    if (result.kind === "timeout") {
      return Object.freeze({
        status: "blocked",
        summary: `quality verifier timed out after ${boundedTimeoutMs}ms`,
        details: ["verifier was aborted after exceeding its bounded timeout"],
      });
    }
    return normalizeQualityVerification(result.value);
  } catch (error: unknown) {
    return Object.freeze({
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      details: [],
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
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
