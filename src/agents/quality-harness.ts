import crypto from "node:crypto";
import { inspectEvidenceMultiplicity } from "./evidence-source-identity.js";
import { planQualityHarnessEvidenceBatches } from "./local-text-model-adapter.js";
import { modelRoutingTaskTimeoutMs, type ModelCallReceipt } from "./logical-agent-model-router.js";
import {
  LogicalAgentPool,
  runLogicalAgentPlan,
  summarizeExecutedModelIdentity,
  type LogicalAgentPlanResult,
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

export function summarizeQualityModelDiversity(calls: readonly ModelCallReceipt[]) {
  const completed = calls.filter(
    (call) => call.outcome === "completed" && call.realModelInferenceObserved,
  );
  const identity = (call: ModelCallReceipt) => `${call.provider}/${call.modelId}`;
  const draft = completed.filter((call) => call.role === "research_draft").at(-1);
  const reviewModels = [
    ...new Set(
      QUALITY_HARNESS_REVIEW_AGENTS.flatMap((role) => {
        const call = completed.filter((entry) => entry.role === role).at(-1);
        return call ? [identity(call)] : [];
      }),
    ),
  ];
  return {
    draftModel: draft ? identity(draft) : null,
    reviewModels,
    hasDistinctReviewModel: !!draft && reviewModels.some((model) => model !== identity(draft)),
    allPostDraftReviewsSeparated:
      !!draft &&
      ["adversarial_challenge", "final_precheck"].every((role) => {
        const review = completed.filter((call) => call.role === role).at(-1);
        const formatter = completed.filter((call) => call.role === "formatting").at(-1);
        return (
          !!review &&
          identity(review) !== identity(draft) &&
          (role !== "final_precheck" || (!!formatter && identity(review) !== identity(formatter)))
        );
      }),
  };
}

function summarizeTask(task: string): { sha256: string; length: number } {
  return {
    sha256: crypto.createHash("sha256").update(task, "utf8").digest("hex"),
    length: task.length,
  };
}

const EVIDENCE_BATCH_FAILURE_REASONS = new Set<NonNullable<ModelCallReceipt["reason"]>>([
  "input_constraint",
  "capability_constraint",
  "role_scope_constraint",
  "model_separation_constraint",
  "model_separation_unproven",
  "model_affinity_constraint",
  "model_affinity_unproven",
  "adapter_input_constraint",
  "output_contract",
  "adapter_error",
  "prompt_input_invalid",
  "prompt_budget_exceeded",
  "output_invalid",
  "output_truncated",
  "process_error",
  "output_limit",
  "runtime_timeout",
  "provider_auth",
  "provider_payment_required",
  "provider_rate_limit",
  "call_budget_exhausted",
  "cancelled",
  "deadline",
]);

function safeEvidenceBatchFailureReason(reason: ModelCallReceipt["reason"]): string {
  return reason && EVIDENCE_BATCH_FAILURE_REASONS.has(reason) ? reason : "adapter_error";
}

function projectArtifactForEvidenceBatchAudit(
  context: Parameters<typeof createQualityHarnessStageExecutor>[0],
): Parameters<typeof createQualityHarnessStageExecutor>[0] {
  if (context.input.evidenceBatchMode !== "final_artifact_audit") {
    return context;
  }
  const formatting = context.dependencyResults.formatting;
  const artifact = formatting?.output;
  if (formatting?.status !== "completed" || artifact?.kind !== "artifact") {
    return context;
  }
  const fullArtifactJson = JSON.stringify(artifact.artifact);
  const artifactSha256 = crypto.createHash("sha256").update(fullArtifactJson, "utf8").digest("hex");
  const answerSha256 = crypto
    .createHash("sha256")
    .update(artifact.artifact.answer, "utf8")
    .digest("hex");
  const batchEvidenceIds = new Set(context.input.request.evidence.map((entry) => entry.id));
  const relevantClaims = artifact.artifact.claims.filter((claim) =>
    claim.evidenceIds.some((id) => batchEvidenceIds.has(id)),
  );
  const projectedOutput = {
    auditProjection: {
      schema: "lcx_quality_final_artifact_batch_projection_v1",
      artifactSha256,
      answerSha256,
      fullArtifactClaimCount: artifact.artifact.claims.length,
      includedClaimIds: relevantClaims.map((claim) => claim.id),
    },
    kind: "artifact" as const,
    artifact: {
      answer: `[Full formatted artifact bound by SHA-256 ${artifactSha256}; answer omitted from this batch view.]`,
      claims: relevantClaims,
    },
  };
  return {
    ...context,
    dependencyResults: {
      ...context.dependencyResults,
      formatting: { ...formatting, output: projectedOutput },
    },
  } as typeof context;
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
  routed: boolean;
  evidenceCoverage?: {
    manifest?: QualityHarnessOptions["evidenceCoverage"];
    batches?: readonly (readonly QualityHarnessRequest["evidence"][number][])[];
    issues: readonly string[];
  };
}): QualityHarnessReceipt {
  const last = params.attempts.at(-1);
  const modelCalls = params.attempts.flatMap((attempt) =>
    attempt.stages.flatMap((stage) => stage.modelCalls ?? []),
  );
  const evidenceModes = new Set(
    modelCalls.map((call) =>
      call.evidence === "adapter-attested"
        ? "adapter-attested"
        : call.mode === "deterministic"
          ? "deterministic"
          : call.mode === "adapter"
            ? "adapter-unattested"
            : "injected",
    ),
  );
  return Object.freeze({
    schemaVersion: QUALITY_HARNESS_SCHEMA_VERSION,
    harness: "lcx-quality",
    status: params.status,
    runId: params.runId,
    task: summarizeTask(params.request.task),
    modelPool: params.pool,
    execution: Object.freeze({
      backend: params.routed ? "role_model_router" : "injected_model_invoker",
      evidenceMode: evidenceModes.size > 1 ? "mixed" : ([...evidenceModes][0] ?? "injected"),
      modelCalls: Object.freeze(modelCalls),
      modelDiversity: summarizeQualityModelDiversity(
        last?.stages.flatMap((stage) => stage.modelCalls ?? []) ?? [],
      ),
      modelId: params.routed ? summarizeExecutedModelIdentity(modelCalls) : params.pool.modelId,
      realModelInferenceObserved: modelCalls.some((call) => call.realModelInferenceObserved),
      allModelCallsAttested:
        modelCalls.length > 0 && modelCalls.every((call) => call.evidence === "adapter-attested"),
      providerCallsMade: modelCalls.some((call) => call.providerCallObserved)
        ? "adapter-attested"
        : "not-observed",
      externalSideEffects: "not-observed",
    }),
    evidenceScope: inspectEvidenceMultiplicity(params.request.evidence),
    ...(params.evidenceCoverage
      ? {
          evidenceCoverage: Object.freeze({
            ...(params.evidenceCoverage.manifest
              ? { controller: params.evidenceCoverage.manifest }
              : {}),
            ...(params.evidenceCoverage.batches
              ? {
                  batches: Object.freeze(
                    params.evidenceCoverage.batches.map((batch, index) =>
                      Object.freeze({
                        index: index + 1,
                        total: params.evidenceCoverage?.batches?.length ?? 0,
                        evidenceIds: Object.freeze(batch.map((entry) => entry.id)),
                      }),
                    ),
                  ),
                }
              : {}),
            passed: params.evidenceCoverage.issues.length === 0,
            issues: Object.freeze([...params.evidenceCoverage.issues]),
          }),
        }
      : {}),
    plannedStages: QUALITY_HARNESS_STAGES,
    attempts: Object.freeze([...params.attempts]),
    ...(params.artifact ? { finalArtifact: params.artifact } : {}),
    verification: params.verification,
    quality: Object.freeze({
      passed: last?.gates.every((gate) => gate.passed) === true,
      independentRoleReviewCount: new Set(
        last?.stages
          .filter(
            (stage) =>
              stage.outputKind === "review" &&
              stage.status === "completed" &&
              (QUALITY_HARNESS_REVIEW_AGENTS as readonly string[]).includes(stage.agentId),
          )
          .map((stage) => stage.agentId) ?? [],
      ).size,
      reviewAgents: QUALITY_HARNESS_REVIEW_AGENTS,
    }),
    repair: Object.freeze({
      attemptsUsed: params.attempts.length,
      maxAttempts: params.maxAttempts,
      repairTriggered: params.attempts.length > 1,
    }),
  });
}

function verifyEvidenceCoverage(params: {
  required: boolean;
  request: QualityHarnessRequest;
  manifest?: QualityHarnessOptions["evidenceCoverage"];
  batches: readonly (readonly QualityHarnessRequest["evidence"][number][])[];
  plan: LogicalAgentPlanResult<QualityHarnessStageOutput>;
  reusedStageIds?: readonly string[];
  attestedReusableStageIds?: ReadonlySet<string>;
}): string[] {
  if (!params.required) {
    return [];
  }
  const issues: string[] = controllerEvidenceCoverageIssues(params.request, params.manifest);
  const appendIdIssues = (prefix: string, ids: readonly string[]) => {
    for (const id of ids) {
      issues.push(`${prefix}:${id}`);
    }
  };
  const selectedIds = params.request.evidence.map((entry) => entry.id);
  const batchedIds = params.batches.flatMap((batch) => batch.map((entry) => entry.id));
  if (
    JSON.stringify([...batchedIds].toSorted()) !== JSON.stringify([...selectedIds].toSorted()) ||
    new Set(batchedIds).size !== batchedIds.length
  ) {
    appendIdIssues("evidence_coverage_batch_partition_mismatch", selectedIds);
  }
  const batchesByTaskId = new Map<string, readonly string[]>();
  for (const task of params.plan.tasks) {
    const match = /^evidence_batch_(?:extract|review)_(\d+)$/u.exec(task.taskId);
    const batchIndex = match ? Number(match[1]) - 1 : 0;
    const batch = params.batches[batchIndex];
    if (batch) {
      batchesByTaskId.set(
        task.taskId,
        batch.map((entry) => entry.id),
      );
    }
  }
  const calls = params.plan.tasks.flatMap((task) => {
    const expectedIds =
      batchesByTaskId.get(task.taskId) ?? params.batches[0]?.map((entry) => entry.id);
    if (!expectedIds) {
      return [];
    }
    const recordedCalls = task.modelCalls ?? [];
    const attemptedCalls = recordedCalls.filter(
      (call) => call.mode !== "deterministic" && call.adapterInvoked,
    );
    const taskCalls = attemptedCalls.filter((call) => call.outcome === "completed");
    if (
      taskCalls.length === 0 &&
      params.reusedStageIds?.includes(task.taskId) &&
      params.attestedReusableStageIds?.has(task.taskId)
    ) {
      return [];
    }
    if (/^evidence_batch_(?:extract|review)_\d+$/u.test(task.taskId) && taskCalls.length === 0) {
      if (attemptedCalls.length > 0) {
        for (const call of attemptedCalls) {
          issues.push(
            `evidence_batch_model_call_attempt_failed:${task.taskId}:${call.attempt}:${safeEvidenceBatchFailureReason(call.reason)}`,
          );
        }
      } else if (task.status === "blocked") {
        issues.push(`evidence_batch_model_call_blocked:${task.taskId}`);
      } else {
        issues.push(`evidence_batch_model_call_no_attempt:${task.taskId}`);
      }
    }
    return taskCalls.map((call) => ({ call, expectedIds, taskId: task.taskId }));
  });
  if (calls.length === 0) {
    issues.push("evidence_coverage_model_calls_missing");
  }
  for (const { call, expectedIds, taskId } of calls) {
    const coverage = call.evidenceCoverage;
    if (!coverage) {
      issues.push(`evidence_coverage_attestation_missing:${taskId}`);
      appendIdIssues("evidence_coverage_attestation_missing_id", expectedIds);
      continue;
    }
    const boundary: unknown = coverage.boundary;
    if (boundary !== "canonical_prompt") {
      issues.push(`evidence_coverage_boundary_mismatch:${taskId}`);
    }
    if (
      boundary === "canonical_prompt" &&
      (!coverage.promptSha256 || !/^[a-f0-9]{64}$/u.test(coverage.promptSha256))
    ) {
      issues.push(`evidence_coverage_prompt_digest_missing:${taskId}`);
    }
    if (JSON.stringify(coverage.suppliedEvidenceIds) !== JSON.stringify(expectedIds)) {
      issues.push(`evidence_coverage_supplied_ids_mismatch:${taskId}`);
    }
    if (JSON.stringify(coverage.includedEvidenceIds) !== JSON.stringify(expectedIds)) {
      issues.push(`evidence_omitted_from_prompt:${taskId}`);
      appendIdIssues("evidence_omitted_from_prompt_id", coverage.omittedEvidenceIds);
      appendIdIssues(
        "evidence_omitted_from_prompt_missing_id",
        expectedIds.filter((id) => !coverage.includedEvidenceIds.includes(id)),
      );
    }
    if (coverage.omittedEvidenceIds.length > 0) {
      issues.push(`evidence_omitted_from_prompt:${taskId}`);
      appendIdIssues("evidence_omitted_from_prompt_id", coverage.omittedEvidenceIds);
    }
    if (coverage.clippedEvidenceIds.length > 0) {
      issues.push(`evidence_clipped_in_prompt:${taskId}`);
      appendIdIssues("evidence_clipped_in_prompt_id", coverage.clippedEvidenceIds);
    }
  }
  return [...new Set(issues)];
}

function controllerEvidenceCoverageIssues(
  request: QualityHarnessRequest,
  manifest?: QualityHarnessOptions["evidenceCoverage"],
): string[] {
  if (!manifest) {
    return ["evidence_coverage_manifest_missing"];
  }
  const issues: string[] = [];
  const selectedIds = request.evidence.map((entry) => entry.id);
  const sourceIds = [...manifest.sourceEvidenceIds].toSorted();
  const selectedAndOmitted = [
    ...manifest.selectedEvidenceIds,
    ...manifest.runnerOmittedEvidenceIds,
  ].toSorted();
  if (JSON.stringify(sourceIds) !== JSON.stringify(selectedAndOmitted)) {
    issues.push("evidence_coverage_controller_partition_mismatch");
  }
  if (JSON.stringify(manifest.selectedEvidenceIds) !== JSON.stringify(selectedIds)) {
    issues.push("evidence_coverage_selected_ids_mismatch");
  }
  if (manifest.runnerOmittedEvidenceIds.length > 0) {
    issues.push(
      ...manifest.runnerOmittedEvidenceIds.map((id) => `evidence_omitted_by_runner:${id}`),
    );
  }
  if (manifest.runnerClippedEvidenceIds.length > 0) {
    issues.push(
      ...manifest.runnerClippedEvidenceIds.map((id) => `evidence_clipped_by_runner:${id}`),
    );
  }
  return issues;
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
  let evidenceBatches: readonly (readonly QualityHarnessRequest["evidence"][number][])[] = [
    request.evidence,
  ];
  let auditEvidenceBatches = false;
  let controllerPlanningIssues: string[] = [];
  const batchPlanningIssues: string[] = [];
  if (options.requireEvidenceCoverage) {
    controllerPlanningIssues = controllerEvidenceCoverageIssues(request, options.evidenceCoverage);
    if (controllerPlanningIssues.length === 0) {
      const plan = planQualityHarnessEvidenceBatches({
        task: request.task,
        evidence: request.evidence,
        sharedContext: request.sharedContext ?? {},
        maxEvidenceBatches: options.maxEvidenceBatches,
      });
      evidenceBatches = plan.batches;
      batchPlanningIssues.push(...plan.issues);
      auditEvidenceBatches = plan.issues.length === 0;
      if (plan.batches.length === 0 && request.evidence.length > 0) {
        batchPlanningIssues.push("evidence_batch_plan_empty");
      }
    }
  }
  const pool = new LogicalAgentPool<QualityHarnessStageInput, QualityHarnessStageOutput>({
    allowProviderCalls: options.allowProviderCalls,
    modelId: options.modelId,
    maxConcurrency: options.maxConcurrency,
    memoryBudgetMb: options.memoryBudgetMb,
    taskTimeoutMs:
      options.taskTimeoutMs ??
      (options.modelRouting ? modelRoutingTaskTimeoutMs(options.modelRouting) : undefined),
    modelInvoker: options.modelInvoker,
    modelRouting: options.modelRouting,
  });
  const attempts: QualityHarnessAttemptReceipt[] = [];
  let feedback: string[] = [];
  let finalArtifact: QualityHarnessArtifact | undefined;
  let finalCoverageIssues: string[] = [];
  let finalVerification: QualityHarnessVerification = Object.freeze({
    status: "not-requested",
    summary: "deterministic verifier was not supplied",
    details: [],
  });

  // Same-run source preparation can survive a downstream transport/contract failure.
  // Never reuse draft-dependent reviews or carry a receipt across runs/evidence packets.
  const reusable = new Map<string, QualityHarnessStageOutput>();
  const attestedReusableStageIds = new Set<string>();
  const preflightIssues = [...controllerPlanningIssues, ...batchPlanningIssues];
  if (preflightIssues.length > 0) {
    const verification = normalizeQualityVerification({
      status: "failed",
      summary: "evidence coverage failed its bounded multi-pass preflight",
      details: preflightIssues,
    });
    const attempt: QualityHarnessAttemptReceipt = Object.freeze({
      attempt: 1,
      status: "quality-failed",
      planStatus: "blocked",
      stages: Object.freeze([]),
      reusedStageIds: Object.freeze([]),
      gates: Object.freeze([
        Object.freeze({
          id: "evidence_coverage" as const,
          passed: false,
          reason: preflightIssues.join("; "),
        }),
      ]),
      feedback: Object.freeze(preflightIssues),
      verification,
    });
    return createQualityReceipt({
      runId,
      request,
      pool: pool.status,
      attempts: [attempt],
      verification,
      status: "quality-failed",
      maxAttempts,
      routed: options.modelRouting !== undefined,
      evidenceCoverage: {
        ...(options.evidenceCoverage ? { manifest: options.evidenceCoverage } : {}),
        batches: controllerPlanningIssues.length > 0 ? [] : evidenceBatches,
        issues: preflightIssues,
      },
    });
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reusedStageIds: string[] = [];
    const plan = await runLogicalAgentPlan({
      pool,
      runId: `${runId}:attempt:${attempt}`,
      signal: options.signal,
      tasks: buildQualityHarnessPlan({
        runId,
        attempt,
        request,
        evidenceBatches,
        auditEvidenceBatches,
        evidenceCoverage: options.evidenceCoverage,
        repairFeedback: feedback,
      }),
      finalTaskId: "final_precheck",
      executor: (context) => {
        const cached = reusable.get(context.task.id);
        if (cached) {
          reusedStageIds.push(context.task.id);
          return Promise.resolve({ output: cached, sideEffects: [] as const });
        }
        return createQualityHarnessStageExecutor(projectArtifactForEvidenceBatchAudit(context));
      },
      sharedContext: request.sharedContext ?? {},
    });
    const evaluatedQuality = evaluateQuality(plan, request, evidenceBatches, auditEvidenceBatches);
    const coverageIssues = verifyEvidenceCoverage({
      required: options.requireEvidenceCoverage === true,
      request,
      manifest: options.evidenceCoverage,
      batches: evidenceBatches,
      plan,
      reusedStageIds,
      attestedReusableStageIds,
    });
    finalCoverageIssues = coverageIssues;
    const quality = coverageIssues.length
      ? Object.freeze({
          ...evaluatedQuality,
          passed: false,
          gates: Object.freeze([
            ...evaluatedQuality.gates,
            Object.freeze({
              id: "evidence_coverage" as const,
              passed: false,
              reason: coverageIssues.join("; "),
            }),
          ]),
        })
      : evaluatedQuality;
    finalArtifact = quality.artifact ?? finalArtifact;
    let verification = normalizeQualityVerification({
      status: coverageIssues.length > 0 ? "failed" : "not-requested",
      summary: coverageIssues.length
        ? "quality evidence coverage is incomplete"
        : options.verify
          ? "quality gates did not pass"
          : "deterministic verifier was not supplied",
      details: coverageIssues,
    });
    if (quality.passed && quality.artifact && options.verify) {
      verification = await runQualityVerifier(
        options.verify,
        request,
        quality.artifact,
        attempt,
        options.verifierTimeoutMs,
        options.signal,
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
        reusedStageIds: Object.freeze([...reusedStageIds]),
        gates: quality.gates,
        findings: quality.findings,
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
        routed: options.modelRouting !== undefined,
        ...(options.requireEvidenceCoverage
          ? {
              evidenceCoverage: {
                ...(options.evidenceCoverage ? { manifest: options.evidenceCoverage } : {}),
                batches: evidenceBatches,
                issues: coverageIssues,
              },
            }
          : {}),
      });
    }
    if (coverageIssues.length > 0) {
      return createQualityReceipt({
        runId,
        request,
        pool: pool.status,
        attempts,
        ...(finalArtifact ? { artifact: finalArtifact } : {}),
        verification,
        status: "quality-failed",
        maxAttempts,
        routed: options.modelRouting !== undefined,
        ...(options.requireEvidenceCoverage
          ? {
              evidenceCoverage: {
                ...(options.evidenceCoverage ? { manifest: options.evidenceCoverage } : {}),
                batches: evidenceBatches,
                issues: coverageIssues,
              },
            }
          : {}),
      });
    }
    // A new artifact cannot repair provider availability or replenish this run's
    // call budget. Allow a successful router fallback, but never restart a DAG
    // whose required stage still failed for one of these terminal causes.
    const terminalModelFailure = plan.tasks.some(
      (task) =>
        task.status !== "completed" &&
        task.modelCalls?.some(
          (call) =>
            call.reason === "provider_payment_required" ||
            call.reason === "provider_auth" ||
            call.reason === "provider_rate_limit" ||
            call.reason === "call_budget_exhausted",
        ),
    );
    if (terminalModelFailure) {
      break;
    }
    reusable.clear();
    const downstreamNeedsRepair =
      quality.artifact !== undefined ||
      plan.tasks.some(
        (task) =>
          (task.agentId === "research_draft" ||
            task.agentId === "formatting" ||
            task.agentId === "final_precheck") &&
          task.status === "failed",
      );
    const failedGateIds = quality.gates.filter((gate) => !gate.passed).map((gate) => gate.id);
    const finalArtifactOnlyRepair =
      plan.status === "completed" &&
      quality.artifact !== undefined &&
      failedGateIds.length === 1 &&
      failedGateIds[0] === "finance_answer_safety" &&
      plan.tasks.every(
        (task) =>
          task.status === "completed" && task.sideEffects.length === 0 && task.output !== undefined,
      );
    // Clean source preparation remains valid when the artifact's judgment fails.
    // Drafting and every artifact-dependent review still run again with feedback.
    if (downstreamNeedsRepair && !options.signal?.aborted) {
      const preparationIds = new Set([
        "data_cleaning",
        "financial_extraction",
        "news_classification",
        ...evidenceBatches.slice(1).map((_, index) => `evidence_batch_extract_${index + 2}`),
      ]);
      // A single deterministic final-answer gate can be repaired locally: the original
      // same-run draft and its upstream reviews remain valid, while formatting and every
      // final-artifact audit/precheck must run again against the revised artifact.
      const reuseCandidates = finalArtifactOnlyRepair
        ? plan.tasks.filter(
            (task) =>
              task.taskId !== "formatting" &&
              task.taskId !== "adversarial_challenge" &&
              task.taskId !== "final_precheck" &&
              !task.taskId.startsWith("evidence_batch_review_"),
          )
        : plan.tasks.filter((task) => preparationIds.has(task.taskId));
      const reusableTasks = reuseCandidates.filter((task) =>
        finalArtifactOnlyRepair ? true : preparationIds.has(task.taskId),
      );
      const reuseSetComplete = finalArtifactOnlyRepair
        ? reusableTasks.length > 0
        : reusableTasks.length === preparationIds.size;
      const reusableOutputsValid = reusableTasks.every(
        (task) =>
          task.status === "completed" &&
          task.sideEffects.length === 0 &&
          (finalArtifactOnlyRepair ||
            task.output?.kind === "plan" ||
            (task.output?.kind === "review" &&
              task.output.review.verdict === "pass" &&
              task.output.review.criticalFindings.length === 0 &&
              task.output.review.evidenceGaps.length === 0 &&
              (task.taskId.startsWith("evidence_batch_extract_")
                ? evidenceBatches[
                    Number(task.taskId.slice("evidence_batch_extract_".length)) - 1
                  ]?.every(
                    (entry) =>
                      task.output?.kind === "review" &&
                      task.output.review.notes.some((note) => note.includes(`[${entry.id}]`)),
                  )
                : true))),
      );
      if (reuseSetComplete && reusableOutputsValid) {
        for (const task of reusableTasks) {
          if (task.output) {
            reusable.set(task.taskId, task.output);
            if (coverageIssues.length === 0) {
              attestedReusableStageIds.add(task.taskId);
            }
          }
        }
      }
    }
    feedback = attemptFeedback;
    if (options.signal?.aborted) {
      break;
    }
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
    routed: options.modelRouting !== undefined,
    ...(options.requireEvidenceCoverage
      ? {
          evidenceCoverage: {
            ...(options.evidenceCoverage ? { manifest: options.evidenceCoverage } : {}),
            batches: evidenceBatches,
            issues: finalCoverageIssues,
          },
        }
      : {}),
  });
}
