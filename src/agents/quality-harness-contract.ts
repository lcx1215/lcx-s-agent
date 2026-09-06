import {
  buildDefaultLogicalAgentPlan,
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
  signal: AbortSignal;
}) => QualityHarnessVerification | Promise<QualityHarnessVerification>;

export type QualityHarnessOptions = Readonly<{
  request: QualityHarnessRequest;
  modelInvoker: LogicalAgentModelInvoker;
  modelId?: string;
  maxConcurrency?: 1 | 2;
  memoryBudgetMb?: number;
  taskTimeoutMs?: number;
  verifierTimeoutMs?: number;
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
    | "supporting_role_reviews"
    | "evidence_integrity_review"
    | "adversarial_review"
    | "final_precheck"
    | "finance_answer_safety"
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
    providerCallsMade: "not-observed" | "caller-attested";
    externalSideEffects: "not-observed" | "caller-attested";
  }>;
  plannedStages: readonly QualityHarnessStage[];
  attempts: readonly QualityHarnessAttemptReceipt[];
  finalArtifact?: QualityHarnessArtifact;
  verification: QualityHarnessVerification;
  quality: Readonly<{
    passed: boolean;
    independentRoleReviewCount: number;
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

export function isQualityRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredQualityText(
  value: unknown,
  label: string,
  maxLength = MAX_TEXT_LENGTH,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return text;
}

export function qualityStringArray(value: unknown, label: string, required = true): string[] {
  if (value === undefined && !required) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((entry, index) => requiredQualityText(entry, `${label}[${index}]`, 1_000));
}

export function normalizeQualityRequest(request: QualityHarnessRequest): QualityHarnessRequest {
  const task = requiredQualityText(request.task, "task");
  if (!Array.isArray(request.evidence) || request.evidence.length === 0) {
    throw new Error("quality harness requires at least one evidence item");
  }
  const ids = new Set<string>();
  const evidence = request.evidence.map((entry, index) => {
    if (!isQualityRecord(entry)) {
      throw new Error(`evidence[${index}] must be an object`);
    }
    const id = requiredQualityText(entry.id, `evidence[${index}].id`, 200);
    if (ids.has(id)) {
      throw new Error(`duplicate evidence id: ${id}`);
    }
    ids.add(id);
    const source =
      entry.source === undefined
        ? undefined
        : requiredQualityText(entry.source, "evidence.source", 1_000);
    return Object.freeze({
      id,
      text: requiredQualityText(entry.text, `evidence[${index}].text`, MAX_EVIDENCE_LENGTH),
      ...(source ? { source } : {}),
    });
  });
  return Object.freeze({ task, evidence: Object.freeze(evidence) });
}

function normalizeFeedback(feedback: readonly string[]): string[] {
  return feedback
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().slice(0, 1_000))
    .slice(0, 12);
}

export function buildQualityHarnessPlan(params: {
  runId: string;
  attempt: number;
  request: QualityHarnessRequest;
  repairFeedback?: readonly string[];
}): Array<LogicalAgentTask<QualityHarnessStageInput>> {
  const input = (stage: QualityHarnessStage): QualityHarnessStageInput =>
    Object.freeze({
      runId: requiredQualityText(params.runId, "runId", 200),
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
  if (output.kind === "plan" || output.kind === "review") {
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
  if (!isQualityRecord(parsed)) {
    throw new Error("quality harness model output must be a JSON object");
  }
  return parsed;
}

function parseArtifact(value: unknown): QualityHarnessArtifact {
  const record = parseModelJson(value);
  if (record.kind !== "artifact" || !isQualityRecord(record.artifact)) {
    throw new Error("quality harness stage expected kind=artifact");
  }
  const artifact = record.artifact;
  const answer = requiredQualityText(artifact.answer, "artifact.answer");
  if (!Array.isArray(artifact.claims) || artifact.claims.length === 0) {
    throw new Error("artifact.claims must contain at least one claim");
  }
  const claimIds = new Set<string>();
  const claims = artifact.claims.map((entry, index) => {
    if (!isQualityRecord(entry)) {
      throw new Error(`artifact.claims[${index}] must be an object`);
    }
    const id = requiredQualityText(entry.id, `artifact.claims[${index}].id`, 200);
    if (claimIds.has(id)) {
      throw new Error(`duplicate artifact claim id: ${id}`);
    }
    claimIds.add(id);
    const status = entry.status;
    if (status !== "supported" && status !== "uncertain") {
      throw new Error(`artifact.claims[${index}].status is invalid`);
    }
    const evidenceIds = qualityStringArray(
      entry.evidenceIds,
      `artifact.claims[${index}].evidenceIds`,
    );
    const uncertainty =
      entry.uncertainty === undefined
        ? undefined
        : requiredQualityText(entry.uncertainty, "claim.uncertainty", 1_000);
    if (status === "supported" && evidenceIds.length === 0) {
      throw new Error(`supported claim ${id} must cite evidence`);
    }
    if (status === "uncertain" && !uncertainty) {
      throw new Error(`uncertain claim ${id} must explain uncertainty`);
    }
    return Object.freeze({
      id,
      text: requiredQualityText(entry.text, `artifact.claims[${index}].text`, 4_000),
      status,
      evidenceIds: Object.freeze(evidenceIds),
      ...(uncertainty ? { uncertainty } : {}),
    });
  });
  return Object.freeze({ answer, claims: Object.freeze(claims) });
}

function parseReview(value: unknown): QualityHarnessReview {
  const record = parseModelJson(value);
  if (record.kind !== "review" || !isQualityRecord(record.review)) {
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
      qualityStringArray(review.criticalFindings, "review.criticalFindings"),
    ),
    evidenceGaps: Object.freeze(qualityStringArray(review.evidenceGaps, "review.evidenceGaps")),
    notes: Object.freeze(qualityStringArray(review.notes, "review.notes", false)),
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
      requirements: Object.freeze(qualityStringArray(record.requirements, "plan.requirements")),
      missingEvidence: Object.freeze(
        qualityStringArray(record.missingEvidence, "plan.missingEvidence"),
      ),
    });
  }
  if (stage === "draft" || stage === "format") {
    return Object.freeze({ kind: "artifact", artifact: parseArtifact(value) });
  }
  return Object.freeze({ kind: "review", review: parseReview(value) });
}

export function createQualityHarnessStageExecutor(
  context: LogicalAgentExecutionContext<QualityHarnessStageInput, QualityHarnessStageOutput>,
): Promise<{ output: QualityHarnessStageOutput; sideEffects: readonly [] }> {
  return context.modelSlot.invoke(buildModelRequest(context), context.signal).then((value) => ({
    output: parseStageOutput(context.input.stage, value),
    sideEffects: [] as const,
  }));
}
export function findQualityStageResult(
  result: LogicalAgentPlanResult<QualityHarnessStageOutput>,
  taskId: string,
): LogicalAgentTaskResult<QualityHarnessStageOutput> | undefined {
  return result.tasks.find((entry) => entry.taskId === taskId);
}
