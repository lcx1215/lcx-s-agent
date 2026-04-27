import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrineTeacherFeedbackFilename,
  buildFeishuFinanceDoctrineTeacherReviewFilename,
  parseFeishuFinanceDoctrineCalibrationFilename,
  parseFeishuFinanceDoctrineTeacherFeedbackArtifact,
  parseFeishuFinanceDoctrineTeacherReviewArtifact,
  renderFeishuFinanceDoctrineTeacherReviewArtifact,
  type FeishuFinanceDoctrineTeacherReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_DOCTRINE_TEACHER_REVIEW_OUTCOMES = [
  "deferred",
  "rejected",
  "elevated_for_governance_review",
] as const;

const FinanceDoctrineTeacherFeedbackReviewSchema = Type.Object({
  dateKey: Type.String(),
  feedbackId: Type.String(),
  outcome: stringEnum(FINANCE_DOCTRINE_TEACHER_REVIEW_OUTCOMES),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

async function readUtf8OrMissing(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function createFinanceDoctrineTeacherFeedbackReviewTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Doctrine Teacher Feedback Review",
    name: "finance_doctrine_teacher_feedback_review",
    description:
      "Record one bounded governance review outcome for an existing same-day finance teacher-feedback entry by feedbackId. This writes retained review state only and does not adopt knowledge, promote doctrine, or mutate doctrine cards automatically.",
    parameters: FinanceDoctrineTeacherFeedbackReviewSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const feedbackId = readStringParam(params, "feedbackId", { required: true });
      const outcome = readStringParam(params, "outcome", { required: true }) as
        | (typeof FINANCE_DOCTRINE_TEACHER_REVIEW_OUTCOMES)[number]
        | undefined;
      if (!outcome || !FINANCE_DOCTRINE_TEACHER_REVIEW_OUTCOMES.includes(outcome)) {
        throw new ToolInputError(
          `outcome must be one of: ${FINANCE_DOCTRINE_TEACHER_REVIEW_OUTCOMES.join(", ")}`,
        );
      }

      const feedbackRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const feedbackAbsPath = path.join(workspaceDir, feedbackRelPath);
      const feedbackContent = await readUtf8OrMissing(feedbackAbsPath);
      if (feedbackContent == null) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_feedback_artifact_missing",
          dateKey,
          feedbackId,
          teacherFeedbackPath: feedbackRelPath,
          action:
            "Create or restore the same-day finance teacher-feedback artifact before retrying finance_doctrine_teacher_feedback_review.",
        });
      }

      const parsedFeedback = parseFeishuFinanceDoctrineTeacherFeedbackArtifact(feedbackContent);
      if (!parsedFeedback) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_feedback_artifact_malformed",
          dateKey,
          feedbackId,
          teacherFeedbackPath: feedbackRelPath,
          action:
            "Repair or archive the malformed finance teacher-feedback artifact before retrying finance_doctrine_teacher_feedback_review.",
        });
      }

      const feedback = parsedFeedback.feedbacks.find((entry) => entry.feedbackId === feedbackId);
      if (!feedback) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "feedback_not_found",
          dateKey,
          feedbackId,
          teacherFeedbackPath: feedbackRelPath,
          availableFeedbackIds: parsedFeedback.feedbacks.map((entry) => entry.feedbackId),
          action:
            "Use finance_promotion_candidates with this dateKey to inspect current teacher feedback ids before retrying finance_doctrine_teacher_feedback_review.",
        });
      }

      const feedbackSourceFilename = path.posix.basename(feedback.sourceArtifact);
      const parsedSourceFilename =
        parseFeishuFinanceDoctrineCalibrationFilename(feedbackSourceFilename);
      if (!parsedSourceFilename || parsedSourceFilename.dateStr !== dateKey) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "source_artifact_link_mismatch",
          dateKey,
          feedbackId,
          sourceArtifact: feedback.sourceArtifact,
          teacherFeedbackPath: feedbackRelPath,
          action:
            "Repair the teacher feedback source-artifact linkage before retrying finance_doctrine_teacher_feedback_review.",
        });
      }

      const reviewRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const reviewAbsPath = path.join(workspaceDir, reviewRelPath);
      const reviewContent = await readUtf8OrMissing(reviewAbsPath);
      const parsedReview = reviewContent
        ? parseFeishuFinanceDoctrineTeacherReviewArtifact(reviewContent)
        : undefined;

      if (reviewContent != null && !parsedReview) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_review_artifact_malformed",
          dateKey,
          feedbackId,
          teacherFeedbackPath: feedbackRelPath,
          teacherReviewPath: reviewRelPath,
          action:
            "Repair or archive the malformed finance teacher-review artifact before retrying finance_doctrine_teacher_feedback_review.",
        });
      }

      if (parsedReview && parsedReview.sourceTeacherFeedbackArtifact !== feedbackRelPath) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_review_artifact_link_mismatch",
          dateKey,
          feedbackId,
          teacherFeedbackPath: feedbackRelPath,
          teacherReviewPath: reviewRelPath,
          action:
            "Repair the teacher-review artifact linkage before retrying finance_doctrine_teacher_feedback_review.",
        });
      }

      const existingReview = parsedReview?.reviews.find((entry) => entry.feedbackId === feedbackId);
      if (existingReview && existingReview.sourceArtifact !== feedback.sourceArtifact) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "source_artifact_link_mismatch",
          dateKey,
          feedbackId,
          sourceArtifact: feedback.sourceArtifact,
          teacherFeedbackPath: feedbackRelPath,
          teacherReviewPath: reviewRelPath,
          action:
            "Repair the teacher feedback review linkage before retrying finance_doctrine_teacher_feedback_review.",
        });
      }

      if (existingReview) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "invalid_teacher_review_transition",
          dateKey,
          feedbackId,
          sourceArtifact: feedback.sourceArtifact,
          currentOutcome: existingReview.reviewOutcome,
          requestedOutcome: outcome,
          teacherFeedbackPath: feedbackRelPath,
          teacherReviewPath: reviewRelPath,
          action:
            "Teacher feedback entries can only move once from pending into deferred, rejected, or elevated_for_governance_review.",
        });
      }

      const nextArtifact: FeishuFinanceDoctrineTeacherReviewArtifact = {
        reviewedAt: new Date().toISOString(),
        sourceTeacherFeedbackArtifact: feedbackRelPath,
        reviews: [
          ...(parsedReview?.reviews ?? []),
          {
            feedbackId,
            sourceArtifact: feedback.sourceArtifact,
            reviewOutcome: outcome,
          },
        ],
      };

      await fs.writeFile(
        reviewAbsPath,
        renderFeishuFinanceDoctrineTeacherReviewArtifact(nextArtifact),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        feedbackId,
        sourceArtifact: feedback.sourceArtifact,
        reviewOutcome: outcome,
        teacherFeedbackPath: feedbackRelPath,
        teacherReviewPath: reviewRelPath,
        action:
          "This records bounded teacher review state only. It does not adopt knowledge, does not promote doctrine, and does not mutate doctrine cards automatically.",
      });
    },
  };
}
