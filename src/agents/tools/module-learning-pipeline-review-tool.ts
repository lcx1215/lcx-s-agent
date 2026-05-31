import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, ToolInputError } from "./common.js";
import {
  MODULE_LEARNING_EVIDENCE_STATUSES,
  MODULE_LEARNING_TARGETS,
} from "./module-learning-pipeline-plan-tool.js";

export const MODULE_LEARNING_PIPELINE_PLAN_RECEIPT_DIR = path.join(
  "memory",
  "module-learning-pipeline-plan-receipts",
);
export const MODULE_LEARNING_PIPELINE_REVIEW_DIR = path.join(
  "memory",
  "module-learning-pipeline-reviews",
);

const ModuleLearningPipelineReviewSchema = Type.Object({
  dateKey: Type.Optional(Type.String()),
  targetModule: Type.Optional(Type.String()),
  maxFiles: Type.Optional(Type.Number()),
  writeReview: Type.Optional(Type.Boolean()),
});

type ModuleLearningPlanReceipt = {
  boundary?: string;
  targetModule?: string;
  moduleFamily?: string;
  status?: string;
  sourceUrlOrPath?: string | null;
  learningIntent?: string | null;
  actualReadingScope?: string | null;
  sourceRegistryRecordPath?: string | null;
  retrievalReceiptPath?: string | null;
  applicationValidationReceiptPath?: string | null;
  trainingOrEvalAbsorptionEvidencePath?: string | null;
  freshAdjacentApplicationTask?: string | null;
  keepDownrankDiscardDecision?: string | null;
  supersedesReceiptPath?: string | null;
  moduleSpecificCapabilityRule?: string | null;
  missingEvidence?: unknown;
  safetyBoundaries?: unknown;
  existingToolBridge?: unknown;
  financePipelineArgs?: unknown;
  liveTouched?: boolean;
  providerConfigTouched?: boolean;
  protectedMemoryTouched?: boolean;
};

type ReceiptReadResult =
  | {
      ok: true;
      path: string;
      receipt: ModuleLearningPlanReceipt;
    }
  | {
      ok: false;
      path: string;
      reason: string;
    };

function normalizeDateKey(value?: string): string {
  const normalized = value?.trim();
  if (normalized && /^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    return normalized;
  }
  if (normalized) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return new Date().toISOString().slice(0, 10);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasKeepDownrankDiscardDecision(value: unknown): boolean {
  return value === "keep" || value === "downrank" || value === "discard";
}

function isTerminalNonAbsorbedDecision(value: unknown): boolean {
  return value === "downrank" || value === "discard";
}

function filterTerminalMissingProof(params: {
  receipt: ModuleLearningPlanReceipt;
  missingProof: string[];
}): string[] {
  if (!isTerminalNonAbsorbedDecision(params.receipt.keepDownrankDiscardDecision)) {
    return params.missingProof;
  }
  const terminalDecisionOptionalProof = new Set([
    "capability_card_or_retrieval_receipt",
    "application_validation_receipt",
    "training_or_eval_absorption_evidence",
    "fresh_adjacent_application_task",
  ]);
  return params.missingProof.filter((proof) => !terminalDecisionOptionalProof.has(proof));
}

function buildProofCompleteness(params: {
  receipt: ModuleLearningPlanReceipt;
  boundaryViolation: boolean;
  structuredDataReviewTargetViolation: boolean;
}) {
  const safetyBoundaries = stringArrayValue(params.receipt.safetyBoundaries);
  return {
    source_registry_record: hasString(params.receipt.sourceRegistryRecordPath),
    actual_reading_scope: hasString(params.receipt.actualReadingScope),
    module_specific_capability_rule: hasString(params.receipt.moduleSpecificCapabilityRule),
    capability_card_or_retrieval_receipt: hasString(params.receipt.retrievalReceiptPath),
    application_validation_receipt: hasString(params.receipt.applicationValidationReceiptPath),
    training_or_eval_absorption_evidence: hasString(
      params.receipt.trainingOrEvalAbsorptionEvidencePath,
    ),
    fresh_adjacent_application_task: hasString(params.receipt.freshAdjacentApplicationTask),
    keep_downrank_or_discard_decision: hasKeepDownrankDiscardDecision(
      params.receipt.keepDownrankDiscardDecision,
    ),
    safety_boundary: safetyBoundaries.length > 0 && safetyBoundaries.includes("research_only"),
    structured_review_target: !params.structuredDataReviewTargetViolation,
    boundary_clean: !params.boundaryViolation,
  };
}

function exactMissingProof(params: {
  receipt: ModuleLearningPlanReceipt;
  missingEvidence: string[];
  boundaryViolation: boolean;
  structuredDataReviewTargetViolation: boolean;
}): string[] {
  const completeness = buildProofCompleteness(params);
  const missingProof = [
    ...params.missingEvidence,
    ...Object.entries(completeness)
      .filter(([, present]) => !present)
      .map(([field]) => field),
  ].filter((entry, index, array) => entry.length > 0 && array.indexOf(entry) === index);
  return filterTerminalMissingProof({
    receipt: params.receipt,
    missingProof,
  });
}

function nextProofOwner(missingProof: string[]): string {
  if (
    missingProof.some((field) =>
      [
        "source_registry_record",
        "source_url_or_local_source_path",
        "actual_reading_scope",
      ].includes(field),
    )
  ) {
    return "source_registry_and_reading_scope";
  }
  if (
    missingProof.some((field) =>
      [
        "module_specific_capability_rule",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "fresh_adjacent_application_task",
      ].includes(field),
    )
  ) {
    return "module_learning_pipeline_apply_validation";
  }
  if (missingProof.includes("training_or_eval_absorption_evidence")) {
    return "local_brain_eval_or_training_absorption";
  }
  if (missingProof.includes("keep_downrank_or_discard_decision")) {
    return "operator_keep_downrank_discard_decision";
  }
  if (
    missingProof.some((field) =>
      ["safety_boundary", "structured_review_target", "boundary_clean"].includes(field),
    )
  ) {
    return "boundary_repair";
  }
  return "none";
}

function claimStatus(status: string): string {
  if (status === "eval_absorbed") {
    return "eval_absorbed";
  }
  if (status === "application_ready") {
    return "application_ready";
  }
  if (status === "retrieval_ready") {
    return "retrieval_ready";
  }
  return "receipt_only";
}

function normalizeTargetModule(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (!MODULE_LEARNING_TARGETS.includes(normalized as (typeof MODULE_LEARNING_TARGETS)[number])) {
    throw new ToolInputError(`unsupported targetModule: ${normalized}`);
  }
  return normalized;
}

function statusKey(status: unknown): string {
  return typeof status === "string" &&
    MODULE_LEARNING_EVIDENCE_STATUSES.includes(
      status as (typeof MODULE_LEARNING_EVIDENCE_STATUSES)[number],
    )
    ? status
    : "invalid_or_missing_status";
}

function statusRank(status: unknown): number {
  const ordered = MODULE_LEARNING_EVIDENCE_STATUSES;
  const key = statusKey(status);
  const index = ordered.indexOf(key as (typeof ordered)[number]);
  return index >= 0 ? index : -1;
}

function newerReceipt(
  left: Extract<ReceiptReadResult, { ok: true }>,
  right: Extract<ReceiptReadResult, { ok: true }>,
): Extract<ReceiptReadResult, { ok: true }> {
  const leftRank = statusRank(left.receipt.status);
  const rightRank = statusRank(right.receipt.status);
  if (leftRank !== rightRank) {
    return leftRank > rightRank ? left : right;
  }
  return left.path.localeCompare(right.path) >= 0 ? left : right;
}

async function readReceiptFile(receiptPath: string): Promise<ReceiptReadResult> {
  try {
    const parsed = JSON.parse(await fs.readFile(receiptPath, "utf8")) as ModuleLearningPlanReceipt;
    if (parsed.boundary !== "dev_module_learning_pipeline_plan") {
      return {
        ok: false,
        path: receiptPath,
        reason: "not_module_learning_pipeline_plan_receipt",
      };
    }
    if (!parsed.targetModule || typeof parsed.targetModule !== "string") {
      return {
        ok: false,
        path: receiptPath,
        reason: "missing_target_module",
      };
    }
    return { ok: true, path: receiptPath, receipt: parsed };
  } catch {
    return {
      ok: false,
      path: receiptPath,
      reason: "unreadable_or_invalid_json",
    };
  }
}

async function readDailyReceipts(params: {
  workspaceDir: string;
  dateKey: string;
  targetModule?: string;
  maxFiles?: number;
}): Promise<ReceiptReadResult[]> {
  const receiptDir = path.join(
    params.workspaceDir,
    MODULE_LEARNING_PIPELINE_PLAN_RECEIPT_DIR,
    params.dateKey,
  );
  let entries: string[];
  try {
    entries = await fs.readdir(receiptDir);
  } catch {
    return [];
  }
  const limit = params.maxFiles && params.maxFiles > 0 ? Math.floor(params.maxFiles) : undefined;
  const jsonFiles = entries
    .filter((entry) => entry.endsWith(".json"))
    .toSorted()
    .slice(0, limit)
    .map((entry) => path.join(receiptDir, entry));
  const results = await Promise.all(jsonFiles.map((receiptPath) => readReceiptFile(receiptPath)));
  if (!params.targetModule) {
    return results;
  }
  return results.filter(
    (result) => !result.ok || result.receipt.targetModule === params.targetModule,
  );
}

function activeReceiptKey(receipt: ModuleLearningPlanReceipt): string {
  return [
    receipt.targetModule ?? "unknown",
    receipt.sourceUrlOrPath ?? "unknown_source",
    receipt.applicationValidationReceiptPath ??
      receipt.retrievalReceiptPath ??
      receipt.actualReadingScope ??
      "unknown_application",
  ].join("\n");
}

export function buildModuleLearningPipelineReview(params: {
  workspaceDir: string;
  dateKey: string;
  targetModule?: string;
  receiptResults: ReceiptReadResult[];
}) {
  const validReceipts = params.receiptResults.filter(
    (result): result is Extract<ReceiptReadResult, { ok: true }> => result.ok,
  );
  const invalidReceipts = params.receiptResults.filter(
    (result): result is Extract<ReceiptReadResult, { ok: false }> => !result.ok,
  );
  const latestByKey = new Map<string, Extract<ReceiptReadResult, { ok: true }>>();
  for (const result of validReceipts) {
    const key = activeReceiptKey(result.receipt);
    const previous = latestByKey.get(key);
    if (!previous) {
      latestByKey.set(key, result);
    } else {
      latestByKey.set(key, newerReceipt(result, previous));
    }
  }
  const supersededByPath = new Map<string, string>();
  for (const result of validReceipts) {
    const superseded = result.receipt.supersedesReceiptPath;
    if (superseded && typeof superseded === "string") {
      supersededByPath.set(
        superseded,
        normalizeRelativePath(path.relative(params.workspaceDir, result.path)),
      );
    }
  }
  const allRows = validReceipts.map((result) => {
    const receipt = result.receipt;
    const receiptPath = normalizeRelativePath(path.relative(params.workspaceDir, result.path));
    const latestForKey = latestByKey.get(activeReceiptKey(receipt))?.path;
    const supersededByReceiptPath =
      supersededByPath.get(receiptPath) ??
      (latestForKey && latestForKey !== result.path
        ? normalizeRelativePath(path.relative(params.workspaceDir, latestForKey))
        : null);
    const superseded = supersededByReceiptPath !== null;
    const status = statusKey(receipt.status);
    const financePipelineArgs = recordValue(receipt.financePipelineArgs);
    const structuredDataReviewTargetViolation =
      receipt.targetModule === "data_provenance_quality" &&
      !(
        financePipelineArgs?.expectedNextReviewTarget === "data_provenance_quality_review_input" &&
        (financePipelineArgs.sourceType === "official_data_source" ||
          financePipelineArgs.sourceType === "market_data_snapshot_source" ||
          financePipelineArgs.sourceType === "vendor_data_source")
      );
    const boundaryViolation =
      receipt.liveTouched === true ||
      receipt.providerConfigTouched === true ||
      receipt.protectedMemoryTouched === true;
    const missingEvidence = stringArrayValue(receipt.missingEvidence);
    const proofCompleteness = buildProofCompleteness({
      receipt,
      boundaryViolation,
      structuredDataReviewTargetViolation,
    });
    const missingProof = exactMissingProof({
      receipt,
      missingEvidence,
      boundaryViolation,
      structuredDataReviewTargetViolation,
    });
    const terminalNonAbsorbedDecision = isTerminalNonAbsorbedDecision(
      receipt.keepDownrankDiscardDecision,
    );
    const weak =
      (!terminalNonAbsorbedDecision && status !== "eval_absorbed") ||
      structuredDataReviewTargetViolation ||
      boundaryViolation ||
      missingProof.length > 0;
    return {
      receiptPath,
      targetModule: receipt.targetModule,
      moduleFamily: receipt.moduleFamily ?? null,
      status,
      claimStatus: claimStatus(status),
      sourceUrlOrPath: receipt.sourceUrlOrPath ?? null,
      learningIntent: receipt.learningIntent ?? null,
      actualReadingScope: receipt.actualReadingScope ?? null,
      sourceRegistryRecordPath: receipt.sourceRegistryRecordPath ?? null,
      retrievalReceiptPath: receipt.retrievalReceiptPath ?? null,
      applicationValidationReceiptPath: receipt.applicationValidationReceiptPath ?? null,
      trainingOrEvalAbsorptionEvidencePath: receipt.trainingOrEvalAbsorptionEvidencePath ?? null,
      freshAdjacentApplicationTask: receipt.freshAdjacentApplicationTask ?? null,
      keepDownrankDiscardDecision: receipt.keepDownrankDiscardDecision ?? "not_decided",
      terminalNonAbsorbedDecision,
      moduleSpecificCapabilityRule: receipt.moduleSpecificCapabilityRule ?? null,
      supersedesReceiptPath: receipt.supersedesReceiptPath ?? null,
      superseded,
      supersededByReceiptPath,
      missingEvidence,
      proofCompleteness,
      exactMissingProof: missingProof,
      nextProofOwner: nextProofOwner(missingProof),
      weak,
      failedReason: structuredDataReviewTargetViolation
        ? "data_provenance_receipt_missing_structured_review_target"
        : missingProof.length > 0
          ? missingProof[0]
          : weak
            ? status
            : null,
      boundaryViolation,
      structuredDataReviewTargetViolation,
      safetyBoundaries: stringArrayValue(receipt.safetyBoundaries),
      existingToolBridge: receipt.existingToolBridge ?? null,
      financePipelineArgs: receipt.financePipelineArgs ?? null,
    };
  });
  const rows = allRows.filter((row) => !row.superseded);
  const supersededRows = allRows
    .filter((row) => row.superseded)
    .map((row) => ({
      receiptPath: row.receiptPath,
      targetModule: row.targetModule,
      sourceUrlOrPath: row.sourceUrlOrPath,
      supersededByReceiptPath: row.supersededByReceiptPath,
      status: row.status,
    }));
  const countsByStatus = Object.fromEntries(
    [...MODULE_LEARNING_EVIDENCE_STATUSES, "invalid_or_missing_status"].map((status) => [
      status,
      rows.filter((row) => row.status === status).length,
    ]),
  );
  const weakModuleLearning = rows
    .filter((row) => row.weak || row.boundaryViolation)
    .map((row) => ({
      targetModule: row.targetModule,
      learningIntent: row.learningIntent,
      receiptPath: row.receiptPath,
      status: row.status,
      failedReason: row.boundaryViolation
        ? "receipt_boundary_violation"
        : row.structuredDataReviewTargetViolation
          ? "data_provenance_receipt_missing_structured_review_target"
          : (row.exactMissingProof[0] ?? row.status),
      missingEvidence: row.missingEvidence,
      exactMissingProof: row.exactMissingProof,
      nextProofOwner: row.nextProofOwner,
      action: row.structuredDataReviewTargetViolation
        ? "Route data_provenance_quality receipts through official_data_source, market_data_snapshot_source, or vendor_data_source with data_provenance_quality_review_input before claiming absorption."
        : row.terminalNonAbsorbedDecision
          ? "Keep this receipt out of absorption claims; the operator downrank/discard decision is terminal for this weak learning item."
          : row.status === "missing_evidence" || row.status === "stored_only"
            ? "Add source registry, actual reading scope, and retrieval receipt before claiming this module learned the source."
            : row.status === "retrieval_ready"
              ? "Run module-specific application validation on a fresh adjacent task before claiming application-ready learning."
              : row.status === "application_ready"
                ? "Add Qwen eval or training absorption evidence plus keep/downrank/discard decision before claiming eval_absorbed."
                : "Fix receipt status or boundary fields before using this as module-learning evidence.",
    }));
  const proofGapSummary = rows.reduce<Record<string, number>>((summary, row) => {
    for (const proof of row.exactMissingProof) {
      summary[proof] = (summary[proof] ?? 0) + 1;
    }
    return summary;
  }, {});
  const nextProofQueue = rows
    .filter((row) => row.exactMissingProof.length > 0 || row.weak || row.boundaryViolation)
    .map((row) => ({
      targetModule: row.targetModule,
      receiptPath: row.receiptPath,
      status: row.status,
      claimStatus: row.claimStatus,
      exactMissingProof: row.exactMissingProof,
      nextProofOwner: row.nextProofOwner,
      action: row.terminalNonAbsorbedDecision
        ? "No absorption proof required; terminal downrank/discard decision keeps this receipt out of learned-capability claims."
        : row.nextProofOwner === "source_registry_and_reading_scope"
          ? "Add or repair the source registry record and actual reading scope before retrieval/application claims."
          : row.nextProofOwner === "module_learning_pipeline_apply_validation"
            ? "Add module capability/retrieval/apply validation evidence and a fresh adjacent task."
            : row.nextProofOwner === "local_brain_eval_or_training_absorption"
              ? "Wait for or attach Qwen eval/training absorption evidence through the existing local-brain path."
              : row.nextProofOwner === "operator_keep_downrank_discard_decision"
                ? "Record an explicit keep/downrank/discard decision after reviewing the eval or application evidence."
                : row.nextProofOwner === "boundary_repair"
                  ? "Repair boundary or structured-review-target evidence before this receipt can count."
                  : "No proof action required.",
    }));
  const terminalNonAbsorbedRows = rows.filter((row) => row.terminalNonAbsorbedDecision);
  return {
    boundary: "module_learning_pipeline_review",
    dateKey: params.dateKey,
    targetModule: params.targetModule ?? null,
    counts: {
      receiptFiles: rows.length,
      rawReceiptFiles: params.receiptResults.length,
      supersededReceiptFiles: supersededRows.length,
      terminalNonAbsorbed: terminalNonAbsorbedRows.length,
      validReceipts: validReceipts.length,
      invalidReceipts: invalidReceipts.length,
      missingEvidence: countsByStatus.missing_evidence,
      storedOnly: countsByStatus.stored_only,
      retrievalReady: countsByStatus.retrieval_ready,
      applicationReady: countsByStatus.application_ready,
      evalAbsorbed: countsByStatus.eval_absorbed,
      weakModuleLearning: weakModuleLearning.length,
      boundaryViolations: rows.filter((row) => row.boundaryViolation).length,
      structuredDataReviewTargetViolations: rows.filter(
        (row) => row.structuredDataReviewTargetViolation,
      ).length,
      exactMissingProofReceipts: rows.filter((row) => row.exactMissingProof.length > 0).length,
    },
    countsByStatus,
    proofGapSummary,
    nextProofQueue,
    rows,
    terminalNonAbsorbedRows: terminalNonAbsorbedRows.map((row) => ({
      receiptPath: row.receiptPath,
      targetModule: row.targetModule,
      status: row.status,
      keepDownrankDiscardDecision: row.keepDownrankDiscardDecision,
      sourceUrlOrPath: row.sourceUrlOrPath,
    })),
    supersededRows,
    weakModuleLearning,
    invalidReceipts: invalidReceipts.map((result) => ({
      receiptPath: normalizeRelativePath(path.relative(params.workspaceDir, result.path)),
      reason: result.reason,
    })),
    separationContract: {
      readsOnly: MODULE_LEARNING_PIPELINE_PLAN_RECEIPT_DIR,
      writesOnly: MODULE_LEARNING_PIPELINE_REVIEW_DIR,
      languageCorpusUntouched: true,
      protectedMemoryUntouched: true,
      liveTouched: false,
      providerConfigTouched: false,
      noExecutionAuthority: true,
    },
  };
}

async function writeReview(params: {
  workspaceDir: string;
  dateKey: string;
  review: ReturnType<typeof buildModuleLearningPipelineReview>;
}): Promise<string> {
  const relativePath = path
    .join(MODULE_LEARNING_PIPELINE_REVIEW_DIR, `${params.dateKey}.json`)
    .split(path.sep)
    .join("/");
  const absolutePath = path.join(params.workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(params.review, null, 2)}\n`, "utf8");
  return relativePath;
}

export function createModuleLearningPipelineReviewTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Module Learning Pipeline Review",
    name: "module_learning_pipeline_review",
    description:
      "Review module_learning_pipeline_plan receipts for one day, flag incomplete module-learning claims, and optionally write a dev/local review without touching live/provider/protected-memory state.",
    parameters: ModuleLearningPipelineReviewSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = normalizeDateKey(readStringParam(params, "dateKey", { allowEmpty: true }));
      const targetModule = normalizeTargetModule(
        readStringParam(params, "targetModule", { allowEmpty: true }),
      );
      const maxFiles = readNumberParam(params, "maxFiles");
      const writeReviewFlag = params.writeReview !== false;
      const receiptResults = await readDailyReceipts({
        workspaceDir,
        dateKey,
        targetModule,
        maxFiles,
      });
      const review = buildModuleLearningPipelineReview({
        workspaceDir,
        dateKey,
        targetModule,
        receiptResults,
      });
      const reviewPath = writeReviewFlag
        ? await writeReview({
            workspaceDir,
            dateKey,
            review,
          })
        : undefined;
      return jsonResult({
        ...review,
        ok: true,
        boundary: "module_learning_pipeline_review_only",
        updated: writeReviewFlag,
        reviewPath,
      });
    },
  };
}
