import { inspectEvidenceMultiplicity } from "./evidence-source-identity.js";
import {
  FINANCE_RESEARCH_CLAIM_EPISTEMIC_CLASSES,
  FINANCE_RESEARCH_EVIDENCE_RELATIONS,
} from "./finance-research-provenance.js";
import {
  buildDefaultLogicalAgentPlan,
  type LogicalAgentExecutionContext,
  type LogicalAgentModelInvoker,
  type LogicalAgentModelRouting,
  type ModelCallReceipt,
  type LogicalAgentPlanResult,
  type LogicalAgentPoolStatus,
  type LogicalAgentSideEffect,
  type LogicalAgentTask,
  type LogicalAgentTaskResult,
} from "./logical-agent-pool.js";
import {
  collectQualityFindings,
  qualityFindingPacket,
  RECONCILABLE_REVIEW_ROLES,
  type QualityFindingClosure,
  type QualityFindingPacket,
  type QualityFindingReceipt,
} from "./quality-harness-findings.js";

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

export const QUALITY_HARNESS_CLAIM_EPISTEMIC_CLASSES = FINANCE_RESEARCH_CLAIM_EPISTEMIC_CLASSES;
export const QUALITY_HARNESS_EVIDENCE_RELATIONS = FINANCE_RESEARCH_EVIDENCE_RELATIONS;

type QualityHarnessReviewAgentId = (typeof QUALITY_HARNESS_REVIEW_AGENTS)[number];

export type QualityHarnessEvidence = Readonly<{
  /** Caller-declared evidence semantics; never inferred from model disclaimers. */
  kind?: "synthetic_fixture" | "policy";
  id: string;
  text: string;
  source?: string;
}>;

/** At most 17 model stages per attempt, before the shared workflow call budget. */
export const QUALITY_HARNESS_MAX_EVIDENCE_BATCHES = 4;
export const QUALITY_HARNESS_MAX_EVIDENCE_ITEMS_PER_BATCH = 16;
export const QUALITY_HARNESS_MAX_EVIDENCE_ITEMS =
  QUALITY_HARNESS_MAX_EVIDENCE_BATCHES * QUALITY_HARNESS_MAX_EVIDENCE_ITEMS_PER_BATCH;

/** Controller-authored coverage from the original evidence packet through runner selection. */
export type QualityHarnessEvidenceCoverage = Readonly<{
  sourceEvidenceIds: readonly string[];
  selectedEvidenceIds: readonly string[];
  runnerOmittedEvidenceIds: readonly string[];
  runnerClippedEvidenceIds: readonly string[];
}>;

export type QualityHarnessRequest = Readonly<{
  task: string;
  evidence: readonly QualityHarnessEvidence[];
  /** One immutable fact packet visible to every specialist and reviewer. */
  sharedContext?: Readonly<Record<string, unknown>>;
}>;

export type QualityHarnessClaim = Readonly<{
  id: string;
  text: string;
  status: "supported" | "uncertain";
  evidenceIds: readonly string[];
  /** Epistemic origin is a model annotation, not a truth, source-quality, or promotion verdict. */
  epistemicClass?: (typeof QUALITY_HARNESS_CLAIM_EPISTEMIC_CLASSES)[number];
  /** Calculation method, estimate assumptions, or reasoning bridge for non-source claims. */
  basis?: string;
  /** When present, classifies every cited evidence ID exactly once. */
  evidenceRelations?: readonly Readonly<{
    evidenceId: string;
    relation: (typeof QUALITY_HARNESS_EVIDENCE_RELATIONS)[number];
  }>[];
  uncertainty?: string;
}>;

export type QualityHarnessArtifact = Readonly<{
  supportingAnalysis?: Readonly<Record<string, unknown>>;
  answer: string;
  claims: readonly QualityHarnessClaim[];
}>;

export type QualityHarnessReview = Readonly<{
  verdict: "pass" | "revise" | "reject";
  criticalFindings: readonly string[];
  evidenceGaps: readonly string[];
  notes: readonly string[];
  findingClosure?: QualityFindingClosure;
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
  sharedContext: Readonly<Record<string, unknown>>;
  dependencyOutputs: Readonly<Record<string, unknown>>;
  repairFeedback: readonly string[];
  instructions: string;
  /** Identifies controller-planned review passes over a bounded evidence packet. */
  evidenceBatchMode?: "context_extraction" | "final_artifact_audit";
  findingPacket?: QualityFindingPacket;
  /** Trusted controller metadata; this is never read from a model response. */
  evidenceCoverage?: QualityHarnessEvidenceCoverage;
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
  allowProviderCalls?: boolean;
  request: QualityHarnessRequest;
  requireEvidenceCoverage?: boolean;
  evidenceCoverage?: QualityHarnessEvidenceCoverage;
  modelInvoker?: LogicalAgentModelInvoker;
  modelRouting?: LogicalAgentModelRouting;
  signal?: AbortSignal;
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
  evidenceBatchMode?: "context_extraction" | "final_artifact_audit";
  evidenceCoverage?: QualityHarnessEvidenceCoverage;
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
    | "evidence_coverage"
    | "evidence_batch_reviews"
    | "no_forbidden_side_effects";
  passed: boolean;
  reason: string;
}>;

export type QualityHarnessStageReceipt = Readonly<{
  taskId: string;
  agentId: string;
  status: string;
  modelId: string;
  modelCalls?: readonly ModelCallReceipt[];
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
  /** Same-run preparation outputs reused without a new model call. */
  reusedStageIds?: readonly string[];
  gates: readonly QualityHarnessGate[];
  findings?: readonly QualityFindingReceipt[];
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
    backend: "injected_model_invoker" | "role_model_router";
    evidenceMode:
      | "deterministic"
      | "injected"
      | "adapter-unattested"
      | "adapter-attested"
      | "mixed";
    modelCalls: readonly ModelCallReceipt[];
    modelDiversity?: Readonly<{
      draftModel: string | null;
      reviewModels: readonly string[];
      hasDistinctReviewModel: boolean;
      allPostDraftReviewsSeparated?: boolean;
    }>;
    modelId: string;
    realModelInferenceObserved: boolean;
    allModelCallsAttested: boolean;
    providerCallsMade: "not-observed" | "caller-attested" | "adapter-attested";
    externalSideEffects: "not-observed" | "caller-attested" | "adapter-attested";
  }>;
  evidenceScope?: ReturnType<typeof inspectEvidenceMultiplicity>;
  evidenceCoverage?: Readonly<{
    controller?: QualityHarnessEvidenceCoverage;
    batches?: readonly Readonly<{
      index: number;
      total: number;
      evidenceIds: readonly string[];
    }>[];
    passed: boolean;
    issues: readonly string[];
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
export const STAGE_BY_AGENT_ID: Readonly<Record<string, QualityHarnessStage>> = Object.freeze({
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
    if (entry.kind !== undefined && entry.kind !== "synthetic_fixture" && entry.kind !== "policy") {
      throw new Error("evidence.kind must be synthetic_fixture or policy");
    }
    const source =
      entry.source === undefined
        ? undefined
        : requiredQualityText(entry.source, "evidence.source", 1_000);
    return Object.freeze({
      id,
      text: requiredQualityText(entry.text, `evidence[${index}].text`, MAX_EVIDENCE_LENGTH),
      ...(source ? { source } : {}),
      ...(entry.kind ? { kind: entry.kind } : {}),
    });
  });
  const sharedContext =
    request.sharedContext === undefined
      ? undefined
      : normalizeQualitySharedContext(request.sharedContext);
  return Object.freeze({
    task,
    evidence: Object.freeze(evidence),
    sharedContext: Object.freeze({
      ...sharedContext,
      evidenceMultiplicity: inspectEvidenceMultiplicity(evidence),
    }),
  });
}

function normalizeQualitySharedContext(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("quality harness sharedContext must be an object");
  }
  let cloned: Readonly<Record<string, unknown>>;
  try {
    cloned = structuredClone(value);
  } catch {
    throw new Error("quality harness sharedContext must be structured-cloneable");
  }
  return Object.freeze(cloned);
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
  evidenceBatches?: readonly (readonly QualityHarnessEvidence[])[];
  auditEvidenceBatches?: boolean;
  evidenceCoverage?: QualityHarnessEvidenceCoverage;
  repairFeedback?: readonly string[];
}): Array<LogicalAgentTask<QualityHarnessStageInput>> {
  const evidenceBatches = params.evidenceBatches ?? [params.request.evidence];
  const primaryRequest = Object.freeze({
    ...params.request,
    evidence: evidenceBatches[0] ?? params.request.evidence,
  });
  const batchExtractTaskIds = params.auditEvidenceBatches
    ? evidenceBatches.slice(1).map((_, index) => `evidence_batch_extract_${index + 2}`)
    : [];
  const batchReviewTaskIds = params.auditEvidenceBatches
    ? evidenceBatches.map((_, index) => `evidence_batch_review_${index + 1}`)
    : [];
  const input = (
    stage: QualityHarnessStage,
    request = primaryRequest,
    evidenceBatchMode?: QualityHarnessStageInput["evidenceBatchMode"],
  ): QualityHarnessStageInput =>
    Object.freeze({
      runId: requiredQualityText(params.runId, "runId", 200),
      attempt: params.attempt,
      stage,
      request,
      ...(evidenceBatchMode ? { evidenceBatchMode } : {}),
      ...(params.evidenceCoverage ? { evidenceCoverage: params.evidenceCoverage } : {}),
      repairFeedback: Object.freeze(normalizeFeedback(params.repairFeedback ?? [])),
    });
  const basePlan = buildDefaultLogicalAgentPlan({
    ask: primaryRequest.task,
    evidence: primaryRequest.evidence.map((entry) => `[${entry.id}] ${entry.text}`),
  });
  const plan = basePlan.map((task) => {
    const stage = STAGE_BY_AGENT_ID[task.agentId];
    if (!stage) {
      throw new Error(`quality harness has no stage mapping for ${task.agentId}`);
    }
    const extraDependencies =
      task.id === "research_draft"
        ? batchExtractTaskIds
        : task.id === "final_precheck"
          ? batchReviewTaskIds
          : [];
    return {
      id: task.id,
      agentId: task.agentId,
      input: input(stage, primaryRequest),
      ...(task.dependsOn
        ? {
            dependsOn:
              task.id === "final_precheck"
                ? [
                    ...new Set([
                      ...task.dependsOn,
                      ...RECONCILABLE_REVIEW_ROLES,
                      "research_draft",
                      ...extraDependencies,
                    ]),
                  ]
                : task.id === "research_draft"
                  ? [...new Set([...task.dependsOn, ...extraDependencies])]
                  : task.dependsOn,
          }
        : {}),
    };
  });
  for (let index = 1; params.auditEvidenceBatches && index < evidenceBatches.length; index += 1) {
    const batchNumber = index + 1;
    const evidence = evidenceBatches[index];
    if (!evidence) {
      continue;
    }
    const batchRequest = Object.freeze({ ...params.request, evidence });
    plan.push({
      id: `evidence_batch_extract_${batchNumber}`,
      agentId: "evidence_integrity",
      input: input("extraction", batchRequest, "context_extraction"),
      dependsOn: ["data_cleaning"],
    });
  }
  if (params.auditEvidenceBatches) {
    evidenceBatches.forEach((evidence, index) => {
      const batchRequest = Object.freeze({ ...params.request, evidence });
      plan.push({
        id: `evidence_batch_review_${index + 1}`,
        agentId: "evidence_integrity",
        input: input("evidence", batchRequest, "final_artifact_audit"),
        dependsOn: ["formatting"],
      });
    });
  }
  return plan;
}

export function stageInstructions(stage: QualityHarnessStage): string {
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
      return `Return JSON {kind:'artifact',artifact:{answer:string,claims:[{id,text,status:'supported'|'uncertain',evidenceIds:string[],epistemicClass?:'${FINANCE_RESEARCH_CLAIM_EPISTEMIC_CLASSES.join("'|'")}',basis?:string,evidenceRelations?:[{evidenceId,relation:'${FINANCE_RESEARCH_EVIDENCE_RELATIONS.join("'|'")}'}],uncertainty?:string}]}}. Every supported claim must cite evidence IDs. sharedContext.evidenceMultiplicity is computed from the supplied packet: duplicateGroups are not independent corroboration; distinctPacketGroups is not an independent source count. Upstream lineage and semantic truth remain unassessed. For each claim classify epistemic origin without implying truth or source quality; provide basis for calculations, estimates, inferences, and hypotheses; when evidenceRelations is present, include every cited evidence ID exactly once and do not hide contrary evidence. Mark gaps uncertain.`;
    case "adversarial":
      return "Try to falsify the draft. Return JSON review. Use pass only when there is no critical finding and no evidence gap.";
    case "format":
      return "Rewrite the draft after the challenge without dropping caveats, claim provenance, or evidence links. Return the artifact JSON contract exactly.";
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
      ...(output.artifact.supportingAnalysis === undefined
        ? {}
        : { supportingAnalysis: output.artifact.supportingAnalysis }),
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
      output:
        result.output === undefined
          ? undefined
          : context.input.stage === "precheck" && taskId === "formatting"
            ? result.output
            : compactOutput(result.output),
      error: result.error,
    };
  }
  const format = context.dependencyResults.formatting?.output;
  const hasEvidenceBatchReviews = Object.keys(context.dependencyResults).some((taskId) =>
    taskId.startsWith("evidence_batch_review_"),
  );
  const findingPacket =
    context.input.stage === "precheck" && format?.kind === "artifact"
      ? qualityFindingPacket(
          format.artifact,
          context.input.request.evidence,
          collectQualityFindings(
            Object.values(context.dependencyResults).flatMap((result) =>
              result.status === "completed" && result.output?.kind === "review"
                ? [{ role: result.agentId, review: result.output.review }]
                : [],
            ),
          ),
        )
      : undefined;
  return Object.freeze({
    ...(findingPacket ? { findingPacket } : {}),
    schemaVersion: QUALITY_HARNESS_SCHEMA_VERSION,
    runId: context.input.runId,
    attempt: context.input.attempt,
    stage: context.input.stage,
    agentId: context.agent.id,
    task: context.input.request.task,
    evidence: context.input.request.evidence,
    ...(context.input.evidenceCoverage ? { evidenceCoverage: context.input.evidenceCoverage } : {}),
    sharedContext: context.sharedContext,
    dependencyOutputs: Object.freeze(dependencyOutputs),
    repairFeedback: context.input.repairFeedback,
    instructions:
      context.input.evidenceBatchMode === "context_extraction"
        ? `${stageInstructions(context.input.stage)} Review only this bounded evidence batch. Add one concise note for every supplied item, beginning with its exact ID in brackets, such as [item-id]. State its source/time limits and whether it supports, contradicts, contextualizes, or does not address the task. Preserve material facts for the draft stage.`
        : context.input.evidenceBatchMode === "final_artifact_audit"
          ? `${stageInstructions(context.input.stage)} Review the final formatted artifact in dependencyOutputs.formatting against only this bounded evidence batch. Add one concise note for every supplied item, beginning with its exact ID in brackets, such as [item-id]. State whether it supports, contradicts, contextualizes, or does not address each claim it bears on. Flag unsupported claims and cross-source contradictions with evidence IDs; do not infer a global pass from this packet-local review.`
          : hasEvidenceBatchReviews && context.input.stage === "precheck"
            ? `${stageInstructions(context.input.stage)} Compare every evidence_batch_review output with the final artifact and with the other batch reviews. Reconcile contradictions by source and time; if they cannot be reconciled, narrow the affected claim or mark it uncertain. A packet-local pass does not establish global consistency.`
            : stageInstructions(context.input.stage),
    ...(context.input.evidenceBatchMode
      ? { evidenceBatchMode: context.input.evidenceBatchMode }
      : {}),
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
  if (
    /^(bounded answer|cross.asset analysis|supported claim|answer|analysis)[.!。]?$/iu.test(answer)
  ) {
    throw new Error("artifact.answer contains a schema placeholder, not analysis");
  }
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
    const rawEpistemicClass = entry.epistemicClass;
    let epistemicClass: (typeof QUALITY_HARNESS_CLAIM_EPISTEMIC_CLASSES)[number] | undefined;
    if (rawEpistemicClass !== undefined) {
      if (
        typeof rawEpistemicClass !== "string" ||
        !QUALITY_HARNESS_CLAIM_EPISTEMIC_CLASSES.includes(
          rawEpistemicClass as (typeof QUALITY_HARNESS_CLAIM_EPISTEMIC_CLASSES)[number],
        )
      ) {
        throw new Error(`artifact.claims[${index}].epistemicClass is invalid`);
      }
      epistemicClass =
        rawEpistemicClass as (typeof QUALITY_HARNESS_CLAIM_EPISTEMIC_CLASSES)[number];
    }
    const basis =
      entry.basis === undefined
        ? undefined
        : requiredQualityText(entry.basis, "claim.basis", 2_000);
    let evidenceRelations:
      | readonly Readonly<{
          evidenceId: string;
          relation: (typeof QUALITY_HARNESS_EVIDENCE_RELATIONS)[number];
        }>[]
      | undefined;
    if (entry.evidenceRelations !== undefined) {
      if (!Array.isArray(entry.evidenceRelations)) {
        throw new Error(`artifact.claims[${index}].evidenceRelations must be an array`);
      }
      const relations = entry.evidenceRelations.map((relationEntry, relationIndex) => {
        if (!isQualityRecord(relationEntry)) {
          throw new Error(
            `artifact.claims[${index}].evidenceRelations[${relationIndex}] must be an object`,
          );
        }
        const evidenceId = requiredQualityText(
          relationEntry.evidenceId,
          `artifact.claims[${index}].evidenceRelations[${relationIndex}].evidenceId`,
          200,
        );
        const relation = relationEntry.relation;
        if (
          typeof relation !== "string" ||
          !QUALITY_HARNESS_EVIDENCE_RELATIONS.includes(
            relation as (typeof QUALITY_HARNESS_EVIDENCE_RELATIONS)[number],
          )
        ) {
          throw new Error(
            `artifact.claims[${index}].evidenceRelations[${relationIndex}].relation is invalid`,
          );
        }
        return Object.freeze({
          evidenceId,
          relation: relation as (typeof QUALITY_HARNESS_EVIDENCE_RELATIONS)[number],
        });
      });
      const relationIds = relations.map((item) => item.evidenceId);
      if (
        new Set(relationIds).size !== relationIds.length ||
        relationIds.length !== evidenceIds.length ||
        evidenceIds.some((id) => !relationIds.includes(id))
      ) {
        throw new Error(
          `artifact.claims[${index}].evidenceRelations must classify every evidenceId exactly once`,
        );
      }
      evidenceRelations = Object.freeze(relations);
    }
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
      ...(epistemicClass === undefined ? {} : { epistemicClass }),
      ...(basis === undefined ? {} : { basis }),
      ...(evidenceRelations === undefined ? {} : { evidenceRelations }),
      ...(uncertainty ? { uncertainty } : {}),
    });
  });
  if (artifact.supportingAnalysis !== undefined && !isQualityRecord(artifact.supportingAnalysis)) {
    throw new Error("artifact.supportingAnalysis must be an object");
  }
  return Object.freeze({
    answer,
    claims: Object.freeze(claims),
    ...(artifact.supportingAnalysis === undefined
      ? {}
      : { supportingAnalysis: artifact.supportingAnalysis }),
  });
}

function parseFindingClosure(value: unknown): QualityFindingClosure {
  if (!isQualityRecord(value) || !Array.isArray(value.resolutions)) {
    throw new Error("review.findingClosure must contain resolutions");
  }
  const hash = (value: unknown) => {
    const text = requiredQualityText(value, "finding closure hash", 64);
    if (!/^[a-f0-9]{64}$/u.test(text)) {
      throw new Error("invalid finding closure hash");
    }
    return text;
  };
  if (value.resolutions.length > 100) {
    throw new Error("too many finding resolutions");
  }
  return Object.freeze({
    artifactSha256: hash(value.artifactSha256),
    evidenceSha256: hash(value.evidenceSha256),
    resolutions: Object.freeze(
      value.resolutions.map((entry) => {
        if (!isQualityRecord(entry) || !["resolved", "unresolved"].includes(String(entry.status))) {
          throw new Error("invalid finding resolution");
        }
        return Object.freeze({
          findingId: hash(entry.findingId),
          status: entry.status as "resolved" | "unresolved",
          evidenceIds: Object.freeze(
            qualityStringArray(entry.evidenceIds, "resolution.evidenceIds"),
          ),
          artifactQuote:
            typeof entry.artifactQuote === "string" ? entry.artifactQuote.slice(0, 4000) : "",
          artifactClaimId: requiredQualityText(
            entry.artifactClaimId,
            "resolution.artifactClaimId",
            200,
          ),
          rationale: requiredQualityText(entry.rationale, "resolution.rationale", 2000),
        });
      }),
    ),
  });
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
    ...(review.findingClosure === undefined
      ? {}
      : { findingClosure: parseFindingClosure(review.findingClosure) }),
    criticalFindings: Object.freeze(
      qualityStringArray(review.criticalFindings, "review.criticalFindings"),
    ),
    evidenceGaps: Object.freeze(qualityStringArray(review.evidenceGaps, "review.evidenceGaps")),
    notes: Object.freeze(qualityStringArray(review.notes, "review.notes", false)),
  });
}

const PRE_DRAFT_ARTIFACT_ABSENCE =
  /\b(?:final|formatted|draft)\s+(?:research\s+)?artifact\b.{0,80}\b(?:missing|absent|not\s+(?:present|available|created))\b/iu;

function normalizePreDraftReview(
  stage: QualityHarnessStage,
  review: QualityHarnessReview,
): QualityHarnessReview {
  if (stage !== "extraction" && stage !== "classification") {
    return review;
  }

  const deferred: string[] = [];
  const retainFinding = (finding: string) => {
    if (PRE_DRAFT_ARTIFACT_ABSENCE.test(finding)) {
      deferred.push(finding);
      return false;
    }
    return true;
  };
  const criticalFindings = review.criticalFindings.filter(retainFinding);
  const evidenceGaps = review.evidenceGaps.filter(retainFinding);
  if (deferred.length === 0) {
    return review;
  }

  const hasActionableFindings = criticalFindings.length > 0 || evidenceGaps.length > 0;
  const verdict = !hasActionableFindings
    ? "pass"
    : review.verdict === "reject" && criticalFindings.length === 0
      ? "revise"
      : review.verdict;
  return Object.freeze({
    ...review,
    verdict,
    criticalFindings: Object.freeze(criticalFindings),
    evidenceGaps: Object.freeze(evidenceGaps),
    notes: Object.freeze([
      ...review.notes,
      ...deferred.map(
        (finding) => `[pre-draft observation; final artifact is created downstream] ${finding}`,
      ),
    ]),
  });
}

export function parseStageOutput(
  stage: QualityHarnessStage,
  value: unknown,
): QualityHarnessStageOutput {
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
  return Object.freeze({
    kind: "review",
    review: normalizePreDraftReview(stage, parseReview(value)),
  });
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
