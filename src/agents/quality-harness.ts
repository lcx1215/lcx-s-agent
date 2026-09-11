import crypto from "node:crypto";
import {
  LogicalAgentPool,
  runLogicalAgentPlan,
  type LogicalAgentPoolStatus,
} from "./logical-agent-pool.js";
import {
  buildQualityHarnessPlan,
  createQualityHarnessStageExecutor,
  normalizeQualityRequest,
  QUALITY_HARNESS_REVIEW_AGENTS,
  QUALITY_HARNESS_SCHEMA_VERSION,
  QUALITY_HARNESS_STAGES,
  type QualityHarnessArtifact,
  type QualityHarnessAttemptReceipt,
  type QualityHarnessOptions,
  type QualityHarnessReceipt,
  type QualityHarnessRequest,
  type QualityHarnessStageInput,
  type QualityHarnessStageOutput,
  type QualityHarnessVerification,
} from "./quality-harness-contract.js";
import {
  evaluateQuality,
  qualityAttemptStatus,
  qualityFeedback,
  normalizeQualityVerification,
  runQualityVerifier,
  summarizeQualityStageResult,
} from "./quality-harness-quality.js";

export * from "./quality-harness-contract.js";

function summarizeTask(task: string): { sha256: string; length: number } {
  return {
    sha256: crypto.createHash("sha256").update(task, "utf8").digest("hex"),
    length: task.length,
  };
}

function createQualityReceipt(params: {
  runId: string;
  request: QualityHarnessRequest;
  pool: LogicalAgentPoolStatus;
  attempts: QualityHarnessReceipt["attempts"];
  artifact?: QualityHarnessArtifact;
  verification: QualityHarnessVerification;
  status: QualityHarnessReceipt["status"];
  maxAttempts: 1 | 2;
}): QualityHarnessReceipt {
  const last = params.attempts.at(-1);
  return Object.freeze({
    schemaVersion: QUALITY_HARNESS_SCHEMA_VERSION,
    harness: "lcx-quality",
    status: params.status,
    runId: params.runId,
    task: summarizeTask(params.request.task),
    modelPool: params.pool,
    execution: Object.freeze({
      backend: "injected_model_invoker",
      modelId: params.pool.modelId,
      realModelInferenceObserved: false,
      providerCallsMade: "not-observed",
      externalSideEffects: "not-observed",
    }),
    plannedStages: QUALITY_HARNESS_STAGES,
    attempts: Object.freeze([...params.attempts]),
    ...(params.artifact ? { finalArtifact: params.artifact } : {}),
    verification: params.verification,
    quality: Object.freeze({
      passed: last?.gates.every((gate) => gate.passed) === true,
      independentRoleReviewCount:
        last?.stages.filter(
          (stage) =>
            stage.outputKind === "review" &&
            stage.status === "completed" &&
            (QUALITY_HARNESS_REVIEW_AGENTS as readonly string[]).includes(stage.agentId),
        ).length ?? 0,
      reviewAgents: QUALITY_HARNESS_REVIEW_AGENTS,
    }),
    repair: Object.freeze({
      attemptsUsed: params.attempts.length,
      maxAttempts: params.maxAttempts,
      repairTriggered: params.attempts.length > 1,
    }),
  });
}

export async function runQualityHarness(
  options: QualityHarnessOptions,
): Promise<QualityHarnessReceipt> {
  const request = normalizeQualityRequest(options.request);
  const maxAttempts = options.maxAttempts ?? 2;
  if (maxAttempts !== 1 && maxAttempts !== 2) {
    throw new Error("quality harness maxAttempts must be 1 or 2");
  }
  const runId = options.createRunId?.() ?? crypto.randomUUID();
  const pool = new LogicalAgentPool<QualityHarnessStageInput, QualityHarnessStageOutput>({
    modelId: options.modelId,
    maxConcurrency: options.maxConcurrency,
    memoryBudgetMb: options.memoryBudgetMb,
    taskTimeoutMs: options.taskTimeoutMs,
    modelInvoker: options.modelInvoker,
  });
  const attempts: QualityHarnessAttemptReceipt[] = [];
  let feedback: string[] = [];
  let finalArtifact: QualityHarnessArtifact | undefined;
  let finalVerification: QualityHarnessVerification = Object.freeze({
    status: "not-requested",
    summary: "deterministic verifier was not supplied",
    details: [],
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const plan = await runLogicalAgentPlan({
      pool,
      tasks: buildQualityHarnessPlan({ runId, attempt, request, repairFeedback: feedback }),
      finalTaskId: "final_precheck",
      executor: createQualityHarnessStageExecutor,
    });
    const quality = evaluateQuality(plan, request);
    finalArtifact = quality.artifact ?? finalArtifact;
    let verification = normalizeQualityVerification({
      status: "not-requested",
      summary: options.verify
        ? "quality gates did not pass"
        : "deterministic verifier was not supplied",
      details: [],
    });
    if (quality.passed && quality.artifact && options.verify) {
      verification = await runQualityVerifier(
        options.verify,
        request,
        quality.artifact,
        attempt,
        options.verifierTimeoutMs,
      );
    }
    const status = qualityAttemptStatus({
      planStatus: plan.status,
      qualityPassed: quality.passed,
      verification,
    });
    const attemptFeedback = qualityFeedback({ quality, verification });
    attempts.push(
      Object.freeze({
        attempt,
        status,
        planStatus: plan.status,
        stages: Object.freeze(plan.tasks.map(summarizeQualityStageResult)),
        gates: quality.gates,
        feedback: Object.freeze(attemptFeedback),
        verification,
      }),
    );
    finalVerification = verification;
    if (quality.passed && (!options.verify || verification.status === "passed")) {
      return createQualityReceipt({
        runId,
        request,
        pool: pool.status,
        attempts,
        artifact: quality.artifact,
        verification,
        status: options.verify ? "verified" : "completed-unverified",
        maxAttempts,
      });
    }
    feedback = attemptFeedback;
  }

  const last = attempts.at(-1);
  const status: QualityHarnessReceipt["status"] =
    last?.planStatus !== "completed"
      ? "failed"
      : last.status === "verification-blocked"
        ? "blocked"
        : last.status === "verification-failed"
          ? "verification-failed"
          : "quality-failed";
  return createQualityReceipt({
    runId,
    request,
    pool: pool.status,
    attempts,
    ...(finalArtifact ? { artifact: finalArtifact } : {}),
    verification: finalVerification,
    status,
    maxAttempts,
  });
}
