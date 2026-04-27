import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildLarkRoutingCandidatePromotionReview,
  LARK_LANGUAGE_CANDIDATE_DIR,
  readLarkRoutingCandidatePromotionArtifacts,
  writeLarkRoutingCandidatePromotionReview,
} from "../../../extensions/feishu/src/lark-routing-candidate-corpus.js";
import { LARK_ROUTING_CORPUS } from "../../../extensions/feishu/src/lark-routing-corpus.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, ToolInputError } from "./common.js";

const LARK_LANGUAGE_REVIEW_DIR = path.join("memory", "lark-language-routing-reviews");

const LarkLanguageCorpusReviewSchema = Type.Object({
  dateKey: Type.Optional(Type.String()),
  rootDir: Type.Optional(Type.String()),
  minAcceptedPerFamily: Type.Optional(Type.Number()),
  maxFiles: Type.Optional(Type.Number()),
  writeReview: Type.Optional(Type.Boolean()),
});

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

function resolveCandidateRoot(params: {
  workspaceDir: string;
  rootDir?: string;
  dateKey?: string;
}): string {
  const explicitRoot = params.rootDir?.trim();
  if (explicitRoot) {
    return path.isAbsolute(explicitRoot)
      ? explicitRoot
      : path.join(params.workspaceDir, explicitRoot);
  }
  const base = path.join(params.workspaceDir, LARK_LANGUAGE_CANDIDATE_DIR);
  return params.dateKey ? path.join(base, params.dateKey) : base;
}

export function createLarkLanguageCorpusReviewTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Lark Language Corpus Review",
    name: "lark_language_corpus_review",
    description:
      "Review pending Lark language-routing candidate artifacts, score same-family batches, and write a review JSON plus patch text without modifying the formal routing corpus.",
    parameters: LarkLanguageCorpusReviewSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = normalizeDateKey(readStringParam(params, "dateKey"));
      const rootDir = resolveCandidateRoot({
        workspaceDir,
        rootDir: readStringParam(params, "rootDir"),
        dateKey,
      });
      const minAcceptedPerFamily = readNumberParam(params, "minAcceptedPerFamily", {
        integer: true,
      });
      const maxFiles = readNumberParam(params, "maxFiles", { integer: true });
      const writeReview = params.writeReview !== false;

      const reviewRelPath = path.join(LARK_LANGUAGE_REVIEW_DIR, `${dateKey}.json`);
      const patchRelPath = path.join(LARK_LANGUAGE_REVIEW_DIR, `${dateKey}.patch.ts`);
      const writeResult = writeReview
        ? await writeLarkRoutingCandidatePromotionReview({
            workspaceDir,
            dateKey,
            rootDir,
            existingCorpus: LARK_ROUTING_CORPUS,
            minAcceptedPerFamily:
              minAcceptedPerFamily && minAcceptedPerFamily > 0 ? minAcceptedPerFamily : undefined,
            ...(maxFiles && maxFiles > 0 ? { maxFiles } : {}),
          })
        : undefined;
      const dryReadResult = writeResult
        ? undefined
        : await readLarkRoutingCandidatePromotionArtifacts({
            rootDir,
            ...(maxFiles && maxFiles > 0 ? { maxFiles } : {}),
          });
      const review =
        writeResult?.review ??
        buildLarkRoutingCandidatePromotionReview({
          artifacts: dryReadResult?.artifacts ?? [],
          existingCorpus: LARK_ROUTING_CORPUS,
          minAcceptedPerFamily:
            minAcceptedPerFamily && minAcceptedPerFamily > 0 ? minAcceptedPerFamily : undefined,
        });

      return jsonResult({
        ok: true,
        boundary: "language_routing_only",
        updated: writeReview,
        sourceRoot: normalizeRelativePath(path.relative(workspaceDir, rootDir) || "."),
        reviewPath: writeReview ? normalizeRelativePath(reviewRelPath) : undefined,
        patchPath: writeReview ? normalizeRelativePath(patchRelPath) : undefined,
        counts: review.counts,
        familyDecisions: review.familyDecisions,
        skipped: (writeResult?.skipped ?? dryReadResult?.skipped ?? []).map((entry) => ({
          ...entry,
          path: normalizeRelativePath(path.relative(workspaceDir, entry.path) || entry.path),
        })),
        action:
          review.counts.promotedCases > 0
            ? "Review the generated patch text before manually appending any cases to LARK_ROUTING_CORPUS."
            : "No formal corpus patch is ready yet; keep collecting pending language-routing candidates.",
      });
    },
  };
}
