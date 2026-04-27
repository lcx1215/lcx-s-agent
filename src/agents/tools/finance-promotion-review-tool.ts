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

const FinancePromotionReviewSchema = Type.Object({
  dateKey: Type.String(),
  candidateKey: Type.String(),
  action: stringEnum(FINANCE_PROMOTION_REVIEW_ACTIONS),
  reviewNotes: Type.Optional(Type.String()),
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

export function createFinancePromotionReviewTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Promotion Review",
    name: "finance_promotion_review",
    description:
      "Record a bounded review action for one finance doctrine promotion candidate by candidateKey. This updates the same-day finance promotion review artifact and mirrors the chosen review state into the generated candidate artifact without promoting anything automatically.",
    parameters: FinancePromotionReviewSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const candidateKey = readStringParam(params, "candidateKey", { required: true });
      const action = readStringParam(params, "action", { required: true }) as
        | (typeof FINANCE_PROMOTION_REVIEW_ACTIONS)[number]
        | undefined;
      const reviewNotes = normalizeOptionalText(readStringParam(params, "reviewNotes"));
      if (!action || !FINANCE_PROMOTION_REVIEW_ACTIONS.includes(action)) {
        throw new ToolInputError(
          `action must be one of: ${FINANCE_PROMOTION_REVIEW_ACTIONS.join(", ")}`,
        );
      }

      const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
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
            candidateKey,
            dateKey,
            candidatePath: candidateRelPath,
            action:
              "Generate the same-day finance promotion candidates first before recording a review action.",
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
          candidateKey,
          dateKey,
          candidatePath: candidateRelPath,
          action:
            "Repair or archive the malformed finance promotion candidate artifact before retrying finance_promotion_review.",
        });
      }

      const targetCandidate = parsedCandidateArtifact.candidates.find(
        (candidate) => candidate.candidateKey === candidateKey,
      );
      if (!targetCandidate) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_not_found",
          candidateKey,
          dateKey,
          candidatePath: candidateRelPath,
          availableCandidateKeys: parsedCandidateArtifact.candidates.map(
            (candidate) => candidate.candidateKey,
          ),
          action:
            "Use finance_promotion_candidates with this dateKey to discover the current candidateKey values before retrying finance_promotion_review.",
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
            candidateKey,
            dateKey,
            reviewPath: reviewRelPath,
            action:
              "Repair or archive the malformed finance promotion review artifact before retrying finance_promotion_review.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const now = new Date().toISOString();
      const previousReviewState = targetCandidate.reviewState;
      const previousReviewNotes = targetCandidate.reviewNotes;
      const nextReviewNotes = reviewNotes ?? previousReviewNotes;
      const nextCandidates = parsedCandidateArtifact.candidates.map((candidate) =>
        candidate.candidateKey === candidateKey
          ? {
              ...candidate,
              reviewState: action,
              reviewNotes: nextReviewNotes,
            }
          : candidate,
      );
      const reviewByKey = new Map(
        parsedReviewArtifact?.reviews.map((review) => [review.candidateKey, review]) ?? [],
      );
      reviewByKey.set(candidateKey, {
        candidateKey,
        reviewState: action,
        reviewNotes: nextReviewNotes,
      });

      await fs.mkdir(receiptsDir, { recursive: true });
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
        dateKey,
        candidateKey,
        reviewState: action,
        previousReviewState,
        reviewNotes: nextReviewNotes ?? null,
        candidatePath: candidateRelPath.replace(/\\/gu, "/"),
        reviewPath: reviewRelPath.replace(/\\/gu, "/"),
        action:
          "This records governance state only. It does not promote the candidate and does not update doctrine cards automatically.",
      });
    },
  };
}
