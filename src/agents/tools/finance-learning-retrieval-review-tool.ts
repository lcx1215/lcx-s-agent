import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, ToolInputError } from "./common.js";

export const FINANCE_LEARNING_RETRIEVAL_RECEIPT_DIR = path.join(
  "memory",
  "finance-learning-retrieval-receipts",
);
export const FINANCE_LEARNING_RETRIEVAL_REVIEW_DIR = path.join(
  "memory",
  "finance-learning-retrieval-reviews",
);

const FinanceLearningRetrievalReviewSchema = Type.Object({
  dateKey: Type.Optional(Type.String()),
  maxFiles: Type.Optional(Type.Number()),
  writeReview: Type.Optional(Type.Boolean()),
});

export type LearningRetrievalReceipt = {
  boundary?: string;
  generatedAt?: string;
  sourceName?: string;
  learningIntent?: string;
  retainedCandidateCount?: number;
  preflightCandidateCount?: number;
  postAttachCandidateCount?: number;
  newlyRetrievableCandidateDelta?: number;
  reusedExistingBeforeLearning?: boolean;
  retrievalFirstLearningApplied?: boolean;
  noExecutionAuthority?: boolean;
  noDoctrineMutation?: boolean;
  normalizedArticleArtifactPaths?: string[];
  normalizedReferenceArtifactPaths?: string[];
};

export type ReceiptReadResult =
  | {
      ok: true;
      path: string;
      receipt: LearningRetrievalReceipt;
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

async function readReceiptFile(receiptPath: string): Promise<ReceiptReadResult> {
  try {
    const parsed = JSON.parse(await fs.readFile(receiptPath, "utf8")) as LearningRetrievalReceipt;
    if (parsed.boundary !== "finance_learning_retrieval_receipt") {
      return {
        ok: false,
        path: receiptPath,
        reason: "not_finance_learning_retrieval_receipt",
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
  maxFiles?: number;
}): Promise<ReceiptReadResult[]> {
  const receiptDir = path.join(
    params.workspaceDir,
    FINANCE_LEARNING_RETRIEVAL_RECEIPT_DIR,
    params.dateKey,
  );
  let entries: string[];
  try {
    entries = await fs.readdir(receiptDir);
  } catch {
    return [];
  }
  const jsonFiles = entries
    .filter((entry) => entry.endsWith(".json"))
    .toSorted()
    .slice(0, params.maxFiles && params.maxFiles > 0 ? params.maxFiles : undefined)
    .map((entry) => path.join(receiptDir, entry));
  return Promise.all(jsonFiles.map((receiptPath) => readReceiptFile(receiptPath)));
}

export function buildFinanceLearningRetrievalReview(params: {
  workspaceDir: string;
  dateKey: string;
  receiptResults: ReceiptReadResult[];
}) {
  const validReceipts = params.receiptResults.filter(
    (result): result is Extract<ReceiptReadResult, { ok: true }> => result.ok,
  );
  const invalidReceipts = params.receiptResults.filter(
    (result): result is Extract<ReceiptReadResult, { ok: false }> => !result.ok,
  );
  const rows = validReceipts.map((result) => {
    const receipt = result.receipt;
    const retainedCandidateCount = numberValue(receipt.retainedCandidateCount);
    const preflightCandidateCount = numberValue(receipt.preflightCandidateCount);
    const postAttachCandidateCount = numberValue(receipt.postAttachCandidateCount);
    const newlyRetrievableCandidateDelta = numberValue(receipt.newlyRetrievableCandidateDelta);
    const weak =
      retainedCandidateCount <= 0 ||
      postAttachCandidateCount <= 0 ||
      receipt.retrievalFirstLearningApplied !== true ||
      receipt.noExecutionAuthority !== true ||
      receipt.noDoctrineMutation !== true;
    return {
      receiptPath: normalizeRelativePath(path.relative(params.workspaceDir, result.path)),
      generatedAt: receipt.generatedAt ?? null,
      sourceName: receipt.sourceName ?? null,
      learningIntent: receipt.learningIntent ?? null,
      retainedCandidateCount,
      preflightCandidateCount,
      postAttachCandidateCount,
      newlyRetrievableCandidateDelta,
      reusedExistingBeforeLearning: receipt.reusedExistingBeforeLearning === true,
      becameRetrievableAfterLearning: postAttachCandidateCount > 0,
      weak,
      normalizedArticleArtifactPaths: stringArrayValue(receipt.normalizedArticleArtifactPaths),
      normalizedReferenceArtifactPaths: stringArrayValue(receipt.normalizedReferenceArtifactPaths),
    };
  });
  const weakLearningIntents = rows
    .filter((row) => row.weak)
    .map((row) => ({
      learningIntent: row.learningIntent,
      sourceName: row.sourceName,
      receiptPath: row.receiptPath,
      reason:
        row.retainedCandidateCount <= 0
          ? "no_retained_capability_candidates"
          : row.postAttachCandidateCount <= 0
            ? "not_retrievable_after_learning"
            : "receipt_contract_incomplete",
      action:
        "Re-extract or retag the source into stable finance domains and capability tags before treating this learning as internalized.",
    }));

  return {
    schemaVersion: 1,
    boundary: "finance_learning_retrieval_review",
    dateKey: params.dateKey,
    generatedAt: new Date().toISOString(),
    counts: {
      receiptFiles: params.receiptResults.length,
      validReceipts: validReceipts.length,
      invalidReceipts: invalidReceipts.length,
      retrievableAfterLearning: rows.filter((row) => row.becameRetrievableAfterLearning).length,
      newlyRetrievable: rows.filter((row) => row.newlyRetrievableCandidateDelta > 0).length,
      reusedExistingBeforeLearning: rows.filter((row) => row.reusedExistingBeforeLearning).length,
      weakLearningReceipts: weakLearningIntents.length,
    },
    rows,
    weakLearningIntents,
    invalidReceipts: invalidReceipts.map((result) => ({
      path: normalizeRelativePath(path.relative(params.workspaceDir, result.path)),
      reason: result.reason,
    })),
    separationContract: {
      readsOnly: FINANCE_LEARNING_RETRIEVAL_RECEIPT_DIR,
      writesOnly: FINANCE_LEARNING_RETRIEVAL_REVIEW_DIR,
      languageCorpusUntouched: true,
      protectedMemoryUntouched: true,
      noExecutionAuthority: true,
      noDoctrineMutation: true,
    },
  };
}

export async function writeFinanceLearningRetrievalReview(params: {
  workspaceDir: string;
  dateKey: string;
  maxFiles?: number;
}) {
  const receiptResults = await readDailyReceipts(params);
  const review = buildFinanceLearningRetrievalReview({
    workspaceDir: params.workspaceDir,
    dateKey: params.dateKey,
    receiptResults,
  });
  const reviewRelPath = path.join(FINANCE_LEARNING_RETRIEVAL_REVIEW_DIR, `${params.dateKey}.json`);
  await fs.mkdir(path.join(params.workspaceDir, FINANCE_LEARNING_RETRIEVAL_REVIEW_DIR), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(params.workspaceDir, reviewRelPath),
    `${JSON.stringify(review, null, 2)}\n`,
    "utf8",
  );
  return {
    review,
    reviewPath: normalizeRelativePath(reviewRelPath),
  };
}

export function createFinanceLearningRetrievalReviewTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Learning Retrieval Review",
    name: "finance_learning_retrieval_review",
    description:
      "Summarize finance learning retrieval receipts into a daily quality review without touching Lark language corpus or protected memory.",
    parameters: FinanceLearningRetrievalReviewSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = normalizeDateKey(readStringParam(params, "dateKey"));
      const maxFiles = readNumberParam(params, "maxFiles", { integer: true });
      const writeReview = params.writeReview !== false;
      const writeResult = writeReview
        ? await writeFinanceLearningRetrievalReview({
            workspaceDir,
            dateKey,
            ...(maxFiles && maxFiles > 0 ? { maxFiles } : {}),
          })
        : undefined;
      const review =
        writeResult?.review ??
        buildFinanceLearningRetrievalReview({
          workspaceDir,
          dateKey,
          receiptResults: await readDailyReceipts({
            workspaceDir,
            dateKey,
            ...(maxFiles && maxFiles > 0 ? { maxFiles } : {}),
          }),
        });
      return jsonResult({
        ok: true,
        boundary: "finance_learning_review_only",
        updated: writeReview,
        reviewPath: writeResult?.reviewPath,
        counts: review.counts,
        weakLearningIntents: review.weakLearningIntents,
        separationContract: review.separationContract,
        action:
          review.counts.weakLearningReceipts > 0
            ? "Review weak learning intents before assuming the learning brain internalized them."
            : "Finance learning receipts for this date are retrievable or empty; no weak learning receipt was found.",
      });
    },
  };
}
