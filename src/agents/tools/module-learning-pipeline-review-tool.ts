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
    const weak = status !== "eval_absorbed" || structuredDataReviewTargetViolation;
    const boundaryViolation =
      receipt.liveTouched === true ||
      receipt.providerConfigTouched === true ||
      receipt.protectedMemoryTouched === true;
    return {
      receiptPath,
      targetModule: receipt.targetModule,
      moduleFamily: receipt.moduleFamily ?? null,
      status,
      sourceUrlOrPath: receipt.sourceUrlOrPath ?? null,
      learningIntent: receipt.learningIntent ?? null,
      actualReadingScope: receipt.actualReadingScope ?? null,
      sourceRegistryRecordPath: receipt.sourceRegistryRecordPath ?? null,
      retrievalReceiptPath: receipt.retrievalReceiptPath ?? null,
      applicationValidationReceiptPath: receipt.applicationValidationReceiptPath ?? null,
      trainingOrEvalAbsorptionEvidencePath: receipt.trainingOrEvalAbsorptionEvidencePath ?? null,
      freshAdjacentApplicationTask: receipt.freshAdjacentApplicationTask ?? null,
      keepDownrankDiscardDecision: receipt.keepDownrankDiscardDecision ?? "not_decided",
      supersedesReceiptPath: receipt.supersedesReceiptPath ?? null,
      superseded,
      supersededByReceiptPath,
      missingEvidence: stringArrayValue(receipt.missingEvidence),
      weak,
      failedReason: structuredDataReviewTargetViolation
        ? "data_provenance_receipt_missing_structured_review_target"
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
          : (row.missingEvidence[0] ?? row.status),
      missingEvidence: row.missingEvidence,
      action: row.structuredDataReviewTargetViolation
        ? "Route data_provenance_quality receipts through official_data_source, market_data_snapshot_source, or vendor_data_source with data_provenance_quality_review_input before claiming absorption."
        : row.status === "missing_evidence" || row.status === "stored_only"
          ? "Add source registry, actual reading scope, and retrieval receipt before claiming this module learned the source."
          : row.status === "retrieval_ready"
            ? "Run module-specific application validation on a fresh adjacent task before claiming application-ready learning."
            : row.status === "application_ready"
              ? "Add Qwen eval or training absorption evidence plus keep/downrank/discard decision before claiming eval_absorbed."
              : "Fix receipt status or boundary fields before using this as module-learning evidence.",
    }));
  return {
    boundary: "module_learning_pipeline_review",
    dateKey: params.dateKey,
    targetModule: params.targetModule ?? null,
    counts: {
      receiptFiles: rows.length,
      rawReceiptFiles: params.receiptResults.length,
      supersededReceiptFiles: supersededRows.length,
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
    },
    countsByStatus,
    rows,
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
