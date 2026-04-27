import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  parseFeishuFinanceDoctrinePromotionCandidateArtifact,
  parseFeishuFinanceDoctrinePromotionReviewArtifact,
  renderFeishuFinanceDoctrinePromotionCandidateArtifact,
  renderFeishuFinanceDoctrinePromotionReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_PROMOTION_REVIEW_ACTIONS = [
  "deferred",
  "rejected",
  "ready_for_manual_promotion",
] as const;

const FinancePromotionBulkReviewSchema = Type.Object({
  dateKey: Type.String(),
  reviews: Type.Array(
    Type.Object({
      candidateKey: Type.String(),
      action: stringEnum(FINANCE_PROMOTION_REVIEW_ACTIONS),
      reviewNotes: Type.Optional(Type.String()),
    }),
    { minItems: 1, maxItems: 12 },
  ),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

function normalizeOptionalText(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\r\n/g, "\n");
  return normalized ? normalized : undefined;
}

export function createFinancePromotionBulkReviewTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Promotion Bulk Review",
    name: "finance_promotion_bulk_review",
    description:
      "Apply deferred, rejected, or ready_for_manual_promotion review outcomes to multiple same-day finance promotion candidates in one bounded call. This updates only the existing finance promotion candidate and review artifacts and never auto-promotes anything.",
    parameters: FinancePromotionBulkReviewSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const rawReviews = params.reviews;
      if (!Array.isArray(rawReviews) || rawReviews.length === 0) {
        throw new ToolInputError("reviews required");
      }
      const reviews = rawReviews.map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          throw new ToolInputError(`reviews[${index}] must be an object`);
        }
        const record = entry as Record<string, unknown>;
        const candidateKey = readStringParam(record, "candidateKey", { required: true });
        const action = readStringParam(record, "action", { required: true }) as
          | (typeof FINANCE_PROMOTION_REVIEW_ACTIONS)[number]
          | undefined;
        if (!action || !FINANCE_PROMOTION_REVIEW_ACTIONS.includes(action)) {
          throw new ToolInputError(
            `reviews[${index}].action must be one of: ${FINANCE_PROMOTION_REVIEW_ACTIONS.join(", ")}`,
          );
        }
        return {
          candidateKey,
          action,
          reviewNotes: normalizeOptionalText(readStringParam(record, "reviewNotes")),
        };
      });

      const duplicateCandidateKeys = Array.from(
        reviews.reduce((duplicates, review, index) => {
          const firstIndex = reviews.findIndex(
            (entry) => entry.candidateKey === review.candidateKey,
          );
          if (firstIndex !== index) {
            duplicates.add(review.candidateKey);
          }
          return duplicates;
        }, new Set<string>()),
      );
      if (duplicateCandidateKeys.length > 0) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "duplicate_candidate_keys",
          dateKey,
          duplicateCandidateKeys: duplicateCandidateKeys.toSorted(),
          action:
            "Each same-day finance promotion candidate may appear at most once per bulk review call.",
        });
      }

      const candidateRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey),
      );
      const candidateAbsPath = path.join(workspaceDir, candidateRelPath);
      let candidateArtifactContent: string;
      try {
        candidateArtifactContent = await fs.readFile(candidateAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "candidate_artifact_missing",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            action:
              "Use finance_promotion_candidates with this dateKey after the same-day finance promotion candidates exist.",
          });
        }
        throw error;
      }
      const parsedCandidateArtifact =
        parseFeishuFinanceDoctrinePromotionCandidateArtifact(candidateArtifactContent);
      if (!parsedCandidateArtifact) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_artifact_malformed",
          dateKey,
          candidatePath: candidateRelPath.replace(/\\/gu, "/"),
          action:
            "Repair or archive the malformed finance promotion candidate artifact before retrying finance_promotion_bulk_review.",
        });
      }

      const candidateByKey = new Map(
        parsedCandidateArtifact.candidates.map((candidate) => [candidate.candidateKey, candidate]),
      );
      const unknownCandidateKeys = reviews
        .map((review) => review.candidateKey)
        .filter((candidateKey) => !candidateByKey.has(candidateKey));
      if (unknownCandidateKeys.length > 0) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_not_found",
          dateKey,
          unknownCandidateKeys: unknownCandidateKeys.toSorted(),
          availableCandidateKeys: Array.from(candidateByKey.keys()).toSorted(),
          action:
            "Use finance_promotion_candidates with this dateKey to discover valid same-day candidateKey values before retrying finance_promotion_bulk_review.",
        });
      }

      const reviewRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey),
      );
      const reviewAbsPath = path.join(workspaceDir, reviewRelPath);
      let parsedReviewArtifact = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrinePromotionReviewArtifact>
        | undefined;
      try {
        parsedReviewArtifact = parseFeishuFinanceDoctrinePromotionReviewArtifact(
          await fs.readFile(reviewAbsPath, "utf8"),
        );
        if (!parsedReviewArtifact) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "review_artifact_malformed",
            dateKey,
            reviewPath: reviewRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance promotion review artifact before retrying finance_promotion_bulk_review.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const now = new Date().toISOString();
      const reviewByKey = new Map(
        parsedReviewArtifact?.reviews.map((review) => [review.candidateKey, review]) ?? [],
      );
      const appliedReviews = reviews.map((review) => {
        const candidate = candidateByKey.get(review.candidateKey)!;
        const previousReviewState =
          reviewByKey.get(review.candidateKey)?.reviewState ?? candidate.reviewState;
        const previousReviewNotes =
          reviewByKey.get(review.candidateKey)?.reviewNotes ?? candidate.reviewNotes;
        const nextReviewNotes = review.reviewNotes ?? previousReviewNotes;
        reviewByKey.set(review.candidateKey, {
          candidateKey: review.candidateKey,
          reviewState: review.action,
          reviewNotes: nextReviewNotes,
        });
        return {
          candidateKey: review.candidateKey,
          previousReviewState,
          reviewState: review.action,
          reviewNotes: nextReviewNotes ?? null,
        };
      });

      const nextCandidates = parsedCandidateArtifact.candidates.map((candidate) => {
        const updatedReview = reviewByKey.get(candidate.candidateKey);
        if (!updatedReview) {
          return candidate;
        }
        return {
          ...candidate,
          reviewState: updatedReview.reviewState,
          reviewNotes: updatedReview.reviewNotes,
        };
      });

      await fs.writeFile(
        candidateAbsPath,
        renderFeishuFinanceDoctrinePromotionCandidateArtifact({
          ...parsedCandidateArtifact,
          candidates: nextCandidates,
        }),
        "utf8",
      );
      await fs.writeFile(
        reviewAbsPath,
        renderFeishuFinanceDoctrinePromotionReviewArtifact({
          reviewedAt: now,
          consumer: parsedReviewArtifact?.consumer ?? parsedCandidateArtifact.consumer,
          linkedCandidateArtifact:
            parsedReviewArtifact?.linkedCandidateArtifact ?? candidateRelPath.replace(/\\/gu, "/"),
          reviews: Array.from(reviewByKey.values()).toSorted((left, right) =>
            left.candidateKey.localeCompare(right.candidateKey),
          ),
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        mode: "all_or_nothing",
        dateKey,
        candidatePath: candidateRelPath.replace(/\\/gu, "/"),
        reviewPath: reviewRelPath.replace(/\\/gu, "/"),
        appliedCount: appliedReviews.length,
        appliedReviews,
        action:
          "This updates finance governance state only. It does not promote any candidate and does not update doctrine cards automatically.",
      });
    },
  };
}
