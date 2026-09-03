import crypto from "node:crypto";
import {
  buildDefaultLogicalAgentPlan,
  LogicalAgentPool,
  runLogicalAgentPlan,
  type LogicalAgentExecutionContext,
  type LogicalAgentModelInvoker,
  type LogicalAgentPlanResult,
  type LogicalAgentPoolStatus,
  type LogicalAgentSideEffect,
  type LogicalAgentTask,
  type LogicalAgentTaskResult,
} from "./logical-agent-pool.js";

export const QUALITY_HARNESS_SCHEMA_VERSION = 1 as const;

export type QualityHarnessStage =
  | "intake"
  | "extraction"
  | "classification"
  | "evidence"
  | "risk"
  | "exposure"
  | "draft"
  | "adversarial"
  | "format"
  | "precheck";

export const QUALITY_HARNESS_REVIEW_AGENTS = [
  "evidence_integrity",
  "adversarial_challenge",
  "final_precheck",
] as const;

type QualityHarnessReviewAgentId = (typeof QUALITY_HARNESS_REVIEW_AGENTS)[number];

export type QualityHarnessEvidence = Readonly<{
  id: string;
  text: string;
  source?: string;
}>;

export type QualityHarnessRequest = Readonly<{
  task: string;
  evidence: readonly QualityHarnessEvidence[];
}>;

export type QualityHarnessClaim = Readonly<{
  id: string;
  text: string;
  status: "supported" | "uncertain";
  evidenceIds: readonly string[];
  uncertainty?: string;
}>;

export type QualityHarnessArtifact = Readonly<{
  answer: string;
  claims: readonly QualityHarnessClaim[];
}>;

export type QualityHarnessReview = Readonly<{
  verdict: "pass" | "revise" | "reject";
  criticalFindings: readonly string[];
  evidenceGaps: readonly string[];
  notes: readonly string[];
}>;

export type QualityHarnessStageOutput =
  | Readonly<{
      kind: "plan";
      requirements: readonly string[];
      missingEvidence: readonly string[];
    }>
  | Readonly<{
      kind: "artifact";
      artifact: QualityHarnessArtifact;
    }>
  | Readonly<{
      kind: "review";
      review: QualityHarnessReview;
    }>;

export type QualityHarnessModelRequest = Readonly<{
  schemaVersion: typeof QUALITY_HARNESS_SCHEMA_VERSION;
  runId: string;
  attempt: number;
  stage: QualityHarnessStage;
  agentId: string;
  task: string;
  evidence: readonly QualityHarnessEvidence[];
  dependencyOutputs: Readonly<Record<string, unknown>>;
  repairFeedback: readonly string[];
  instructions: string;
}>;

export type QualityHarnessVerification = Readonly<{
  status: "not-requested" | "passed" | "failed" | "blocked";
  summary: string;
  details: readonly string[];
}>;

export type QualityHarnessVerifier = (params: {
  request: QualityHarnessRequest;
  artifact: QualityHarnessArtifact;
  attempt: number;
}) => QualityHarnessVerification | Promise<QualityHarnessVerification>;

export type QualityHarnessOptions = Readonly<{
  request: QualityHarnessRequest;
  modelInvoker: LogicalAgentModelInvoker;
  modelId?: string;
  maxConcurrency?: 1 | 2;
  memoryBudgetMb?: number;
  taskTimeoutMs?: number;
  maxAttempts?: 1 | 2;
  verify?: QualityHarnessVerifier;
  createRunId?: () => string;
  now?: () => string;
}>;

export type QualityHarnessStageInput = Readonly<{
  runId: string;
  attempt: number;
  stage: QualityHarnessStage;
  request: QualityHarnessRequest;
  repairFeedback: readonly string[];
}>;

export type QualityHarnessGate = Readonly<{
  id:
    | "all_stages_completed"
    | "artifact_contract"
    | "claims_grounded"
    | "evidence_integrity_review"
    | "adversarial_review"
    | "final_precheck"
    | "no_forbidden_side_effects";
  passed: boolean;
  reason: string;
}>;

export type QualityHarnessStageReceipt = Readonly<{
  taskId: string;
  agentId: string;
  status: string;
  modelId: string;
  outputKind?: QualityHarnessStageOutput["kind"];
  reviewVerdict?: QualityHarnessReview["verdict"];
  findingCount?: number;
  sideEffects: readonly LogicalAgentSideEffect[];
  error?: string;
}>;

export type QualityHarnessAttemptReceipt = Readonly<{
  attempt: number;
  status:
    | "quality-passed"
    | "quality-failed"
    | "execution-failed"
    | "verification-failed"
    | "verification-blocked";
  planStatus: LogicalAgentPlanResult<QualityHarnessStageOutput>["status"];
  stages: readonly QualityHarnessStageReceipt[];
  gates: readonly QualityHarnessGate[];
  feedback: readonly string[];
  verification: QualityHarnessVerification;
}>;

export type QualityHarnessReceipt = Readonly<{
  schemaVersion: typeof QUALITY_HARNESS_SCHEMA_VERSION;
  harness: "lcx-quality";
  status:
    | "verified"
    | "completed-unverified"
    | "quality-failed"
    | "verification-failed"
    | "failed"
    | "blocked";
  runId: string;
  task: Readonly<{ sha256: string; length: number }>;
  modelPool: LogicalAgentPoolStatus;
  execution: Readonly<{
    backend: "injected_model_invoker";
    modelId: string;
    realModelInferenceObserved: false;
    providerCallsMade: false;
    externalSideEffects: false;
  }>;
  plannedStages: readonly QualityHarnessStage[];
  attempts: readonly QualityHarnessAttemptReceipt[];
  finalArtifact?: QualityHarnessArtifact;
  verification: QualityHarnessVerification;
  quality: Readonly<{
    passed: boolean;
    independentRoleReviewCount: 3;
    reviewAgents: readonly QualityHarnessReviewAgentId[];
  }>;
  repair: Readonly<{
    attemptsUsed: number;
    maxAttempts: 1 | 2;
    repairTriggered: boolean;
  }>;
}>;

export const QUALITY_HARNESS_STAGES: readonly QualityHarnessStage[] = [
  "intake",
  "extraction",
  "classification",
  "evidence",
  "risk",
  "exposure",
  "draft",
  "adversarial",
  "format",
  "precheck",
];
const STAGES = QUALITY_HARNESS_STAGES;
const STAGE_BY_AGENT_ID: Readonly<Record<string, QualityHarnessStage>> = Object.freeze({
  data_cleaning: "intake",
  financial_extraction: "extraction",
  news_classification: "classification",
  evidence_integrity: "evidence",
  risk_check: "risk",
  portfolio_exposure: "exposure",
  research_draft: "draft",
  adversarial_challenge: "adversarial",
  formatting: "format",
  final_precheck: "precheck",
});
const MAX_TEXT_LENGTH = 12_000;
const MAX_EVIDENCE_LENGTH = 6_000;
const MAX_FEEDBACK_ITEMS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return text;
}

function stringArray(value: unknown, label: string, required = true): string[] {
  if (value === undefined && !required) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((entry, index) => requiredText(entry, `${label}[${index}]`, 1_000));
}

function normalizeRequest(request: QualityHarnessRequest): QualityHarnessRequest {
  const task = requiredText(request.task, "task");
  if (!Array.isArray(request.evidence) || request.evidence.length === 0) {
    throw new Error("quality harness requires at least one evidence item");
  }
  const ids = new Set<string>();
  const evidence = request.evidence.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`evidence[${index}] must be an object`);
    }
    const id = requiredText(entry.id, `evidence[${index}].id`, 200);
    if (ids.has(id)) {
      throw new Error(`duplicate evidence id: ${id}`);
    }
    ids.add(id);
    const source =
      entry.source === undefined ? undefined : requiredText(entry.source, "evidence.source", 1_000);
    return Object.freeze({
      id,
      text: requiredText(entry.text, `evidence[${index}].text`, MAX_EVIDENCE_LENGTH),
      ...(source ? { source } : {}),
    });
  });
  return Object.freeze({ task, evidence: Object.freeze(evidence) });
}

function normalizeFeedback(feedback: readonly string[]): string[] {
  return feedback
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().slice(0, 1_000))
    .slice(0, MAX_FEEDBACK_ITEMS);
}

export function buildQualityHarnessPlan(params: {
  runId: string;
  attempt: number;
  request: QualityHarnessRequest;
  repairFeedback?: readonly string[];
}): Array<LogicalAgentTask<QualityHarnessStageInput>> {
  const input = (stage: QualityHarnessStage): QualityHarnessStageInput =>
    Object.freeze({
      runId: requiredText(params.runId, "runId", 200),
      attempt: params.attempt,
      stage,
      request: params.request,
      repairFeedback: Object.freeze(normalizeFeedback(params.repairFeedback ?? [])),
    });
  const basePlan = buildDefaultLogicalAgentPlan({
    ask: params.request.task,
    evidence: params.request.evidence.map((entry) => `[${entry.id}] ${entry.text}`),
  });
  return basePlan.map((task) => {
    const stage = STAGE_BY_AGENT_ID[task.agentId];
    if (!stage) {
      throw new Error(`quality harness has no stage mapping for ${task.agentId}`);
    }
    return {
      id: task.id,
      agentId: task.agentId,
      input: input(stage),
      ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}),
    };
  });
}

function stageInstructions(stage: QualityHarnessStage): string {
  switch (stage) {
    case "intake":
      return "Return JSON {kind:'plan',requirements:string[],missingEvidence:string[]}; normalize the task and do not invent facts.";
    case "extraction":
      return "Extract only facts present in the evidence and return a review JSON; flag missing fields instead of filling them.";
    case "classification":
      return "Classify the task and evidence implications without adding facts; return a review JSON with uncertainty visible.";
    case "evidence":
      return "Audit the evidence and intake plan. Return JSON {kind:'review',review:{verdict:'pass'|'revise'|'reject',criticalFindings:string[],evidenceGaps:string[],notes:string[]}}.";
    case "risk":
      return "Check downside, constraints, unsafe overclaiming, and action-authority leakage. Return a review JSON.";
    case "exposure":
      return "Check scope, concentration, dependencies, and missing inputs relevant to the task. Return a review JSON.";
    case "draft":
      return "Return JSON {kind:'artifact',artifact:{answer:string,claims:[{id,text,status:'supported'|'uncertain',evidenceIds:string[],uncertainty?:string}]}}. Every supported claim must cite evidence ids; mark gaps uncertain.";
    case "adversarial":
      return "Try to falsify the draft. Return JSON review. Use pass only when there is no critical finding and no evidence gap.";
    case "format":
      return "Rewrite the draft after the challenge without dropping caveats or evidence links. Return the artifact JSON contract exactly.";
    case "precheck":
      return "Perform the final independent role check. Return JSON review and reject unsupported claims, missing evidence, unsafe overclaiming, or dropped uncertainty.";
  }
}

function compactOutput(output: QualityHarnessStageOutput): unknown {
  if (output.kind === "plan") {
    return output;
  }
  if (output.kind === "review") {
    return output;
  }
  return {
    kind: output.kind,
    artifact: {
      answer: output.artifact.answer.slice(0, 6_000),
      claims: output.artifact.claims.slice(0, 50),
    },
  };
}

function buildModelRequest(
  context: LogicalAgentExecutionContext<QualityHarnessStageInput, QualityHarnessStageOutput>,
): QualityHarnessModelRequest {
  const dependencyOutputs: Record<string, unknown> = {};
  for (const [taskId, result] of Object.entries(context.dependencyResults)) {
    dependencyOutputs[taskId] = {
      agentId: result.agentId,
      status: result.status,
      output: result.output === undefined ? undefined : compactOutput(result.output),
      error: result.error,
    };
  }
  return Object.freeze({
    schemaVersion: QUALITY_HARNESS_SCHEMA_VERSION,
    runId: context.input.runId,
    attempt: context.input.attempt,
    stage: context.input.stage,
    agentId: context.agent.id,
    task: context.input.request.task,
    evidence: context.input.request.evidence,
    dependencyOutputs: Object.freeze(dependencyOutputs),
    repairFeedback: context.input.repairFeedback,
    instructions: stageInstructions(context.input.stage),
  });
}

function parseModelJson(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!isRecord(parsed)) {
    throw new Error("quality harness model output must be a JSON object");
  }
  return parsed;
}

function parseArtifact(value: unknown): QualityHarnessArtifact {
  const record = parseModelJson(value);
  if (record.kind !== "artifact" || !isRecord(record.artifact)) {
    throw new Error("quality harness stage expected kind=artifact");
  }
  const artifact = record.artifact;
  const answer = requiredText(artifact.answer, "artifact.answer");
  if (!Array.isArray(artifact.claims) || artifact.claims.length === 0) {
    throw new Error("artifact.claims must contain at least one claim");
  }
  const claimIds = new Set<string>();
  const claims = artifact.claims.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`artifact.claims[${index}] must be an object`);
    }
    const id = requiredText(entry.id, `artifact.claims[${index}].id`, 200);
    if (claimIds.has(id)) {
      throw new Error(`duplicate artifact claim id: ${id}`);
    }
    claimIds.add(id);
    const status = entry.status;
    if (status !== "supported" && status !== "uncertain") {
      throw new Error(`artifact.claims[${index}].status is invalid`);
    }
    const evidenceIds = stringArray(entry.evidenceIds, `artifact.claims[${index}].evidenceIds`);
    const uncertainty =
      entry.uncertainty === undefined
        ? undefined
        : requiredText(entry.uncertainty, "claim.uncertainty", 1_000);
    if (status === "supported" && evidenceIds.length === 0) {
      throw new Error(`supported claim ${id} must cite evidence`);
    }
    if (status === "uncertain" && !uncertainty) {
      throw new Error(`uncertain claim ${id} must explain uncertainty`);
    }
    return Object.freeze({
      id,
      text: requiredText(entry.text, `artifact.claims[${index}].text`, 4_000),
      status,
      evidenceIds: Object.freeze(evidenceIds),
      ...(uncertainty ? { uncertainty } : {}),
    });
  });
  return Object.freeze({ answer, claims: Object.freeze(claims) });
}

function parseReview(value: unknown): QualityHarnessReview {
  const record = parseModelJson(value);
  if (record.kind !== "review" || !isRecord(record.review)) {
    throw new Error("quality harness stage expected kind=review");
  }
  const review = record.review;
  const verdict = review.verdict;
  if (verdict !== "pass" && verdict !== "revise" && verdict !== "reject") {
    throw new Error("review.verdict is invalid");
  }
  return Object.freeze({
    verdict,
    criticalFindings: Object.freeze(
      stringArray(review.criticalFindings, "review.criticalFindings"),
    ),
    evidenceGaps: Object.freeze(stringArray(review.evidenceGaps, "review.evidenceGaps")),
    notes: Object.freeze(stringArray(review.notes, "review.notes", false)),
  });
}

function parseStageOutput(stage: QualityHarnessStage, value: unknown): QualityHarnessStageOutput {
  if (stage === "intake") {
    const record = parseModelJson(value);
    if (record.kind !== "plan") {
      throw new Error("intake stage expected kind=plan");
    }
    return Object.freeze({
      kind: "plan",
      requirements: Object.freeze(stringArray(record.requirements, "plan.requirements")),
      missingEvidence: Object.freeze(stringArray(record.missingEvidence, "plan.missingEvidence")),
    });
  }
  if (stage === "draft" || stage === "format") {
    return Object.freeze({ kind: "artifact", artifact: parseArtifact(value) });
  }
  return Object.freeze({ kind: "review", review: parseReview(value) });
}

function createStageExecutor(
  context: LogicalAgentExecutionContext<QualityHarnessStageInput, QualityHarnessStageOutput>,
): Promise<{ output: QualityHarnessStageOutput; sideEffects: readonly [] }> {
  return context.modelSlot.invoke(buildModelRequest(context), context.signal).then((value) => ({
    output: parseStageOutput(context.input.stage, value),
    sideEffects: [] as const,
  }));
}

function findStageResult(
  result: LogicalAgentPlanResult<QualityHarnessStageOutput>,
  taskId: string,
): LogicalAgentTaskResult<QualityHarnessStageOutput> | undefined {
  return result.tasks.find((entry) => entry.taskId === taskId);
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
  const feedback = [...review.criticalFindings, ...review.evidenceGaps].slice(
    0,
    MAX_FEEDBACK_ITEMS,
  );
  const passed = review.verdict === "pass" && feedback.length === 0;
  return {
    passed,
    reason: passed ? `${stage} review passed` : `${stage} review requires revision`,
    feedback: feedback.length > 0 ? feedback : [`${stage} verdict=${review.verdict}`],
  };
}

type QualityEvaluation = Readonly<{
  passed: boolean;
  artifact?: QualityHarnessArtifact;
  gates: readonly QualityHarnessGate[];
  feedback: readonly string[];
}>;

function evaluateQuality(
  result: LogicalAgentPlanResult<QualityHarnessStageOutput>,
  request: QualityHarnessRequest,
): QualityEvaluation {
  const format = findStageResult(result, "formatting");
  const artifact =
    format?.status === "completed" && format.output?.kind === "artifact"
      ? format.output.artifact
      : undefined;
  const groundingProblems = validateGrounding(artifact, request.evidence);
  const evidenceReview = reviewPassed(findStageResult(result, "evidence_integrity"), "evidence");
  const adversarialReview = reviewPassed(
    findStageResult(result, "adversarial_challenge"),
    "adversarial",
  );
  const precheck = reviewPassed(findStageResult(result, "final_precheck"), "precheck");
  const allStagesCompleted = result.status === "completed" && result.tasks.length === STAGES.length;
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

function summarizeStageResult(
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

function normalizeVerification(value: QualityHarnessVerification): QualityHarnessVerification {
  if (
    !isRecord(value) ||
    !["not-requested", "passed", "failed", "blocked"].includes(value.status as string)
  ) {
    throw new Error("quality verifier returned an invalid status");
  }
  return Object.freeze({
    status: value.status,
    summary: requiredText(value.summary, "verification.summary", 2_000),
    details: Object.freeze(stringArray(value.details, "verification.details", false)),
  });
}

async function runVerifier(
  verifier: QualityHarnessVerifier,
  request: QualityHarnessRequest,
  artifact: QualityHarnessArtifact,
  attempt: number,
): Promise<QualityHarnessVerification> {
  try {
    return normalizeVerification(await verifier({ request, artifact, attempt }));
  } catch (error: unknown) {
    return Object.freeze({
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      details: [],
    });
  }
}

function summarizeTask(task: string): { sha256: string; length: number } {
  return {
    sha256: crypto.createHash("sha256").update(task, "utf8").digest("hex"),
    length: task.length,
  };
}

function createReceipt(params: {
  runId: string;
  request: QualityHarnessRequest;
  pool: LogicalAgentPoolStatus;
  attempts: readonly QualityHarnessAttemptReceipt[];
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
      providerCallsMade: false,
      externalSideEffects: false,
    }),
    plannedStages: STAGES,
    attempts: Object.freeze([...params.attempts]),
    ...(params.artifact ? { finalArtifact: params.artifact } : {}),
    verification: params.verification,
    quality: Object.freeze({
      passed: last?.gates.every((gate) => gate.passed) === true,
      independentRoleReviewCount: 3,
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
  const request = normalizeRequest(options.request);
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
      executor: createStageExecutor,
    });
    const quality = evaluateQuality(plan, request);
    finalArtifact = quality.artifact ?? finalArtifact;
    let verification = Object.freeze({
      status: "not-requested",
      summary: "quality gates did not pass",
      details: [],
    }) as QualityHarnessVerification;
    if (quality.passed && quality.artifact && options.verify) {
      verification = await runVerifier(options.verify, request, quality.artifact, attempt);
    }
    const status: QualityHarnessAttemptReceipt["status"] =
      plan.status !== "completed"
        ? "execution-failed"
        : !quality.passed
          ? "quality-failed"
          : verification.status === "failed"
            ? "verification-failed"
            : verification.status === "blocked"
              ? "verification-blocked"
              : "quality-passed";
    const attemptFeedback = normalizeFeedback([
      ...quality.feedback,
      ...(verification.status === "failed" || verification.status === "blocked"
        ? [verification.summary, ...verification.details]
        : []),
    ]);
    attempts.push(
      Object.freeze({
        attempt,
        status,
        planStatus: plan.status,
        stages: Object.freeze(plan.tasks.map(summarizeStageResult)),
        gates: quality.gates,
        feedback: Object.freeze(attemptFeedback),
        verification,
      }),
    );
    finalVerification = verification;
    if (quality.passed && (!options.verify || verification.status === "passed")) {
      return createReceipt({
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
  return createReceipt({
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
