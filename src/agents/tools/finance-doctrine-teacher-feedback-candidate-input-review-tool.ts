import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputsFilename,
  parseFeishuFinanceDoctrineTeacherCandidateInputArtifact,
  parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact,
  renderFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_REVIEW_OUTCOMES = [
  "consumed_into_candidate_flow",
  "rejected_before_candidate_flow",
  "superseded",
] as const;

const FinanceDoctrineTeacherFeedbackCandidateInputReviewSchema = Type.Object({
  dateKey: Type.String(),
  candidateInputId: Type.String(),
  outcome: stringEnum(FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_REVIEW_OUTCOMES),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

export function createFinanceDoctrineTeacherFeedbackCandidateInputReviewTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Doctrine Teacher Candidate Input Review",
    name: "finance_doctrine_teacher_feedback_candidate_input_review",
    description:
      "Record one bounded governance outcome for an existing same-day teacher candidate-input artifact by exact candidateInputId. This writes retained review state only and does not create promotion candidates automatically, promote doctrine, or mutate doctrine cards.",
    parameters: FinanceDoctrineTeacherFeedbackCandidateInputReviewSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const candidateInputId = readStringParam(params, "candidateInputId", { required: true });
      const outcome = readStringParam(params, "outcome", { required: true }) as
        | (typeof FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_REVIEW_OUTCOMES)[number]
        | undefined;
      if (!outcome || !FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_REVIEW_OUTCOMES.includes(outcome)) {
        throw new ToolInputError(
          `outcome must be one of: ${FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_REVIEW_OUTCOMES.join(", ")}`,
        );
      }

      const candidateInputRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const candidateInputAbsPath = path.join(workspaceDir, candidateInputRelPath);

      let candidateInputContent: string;
      try {
        candidateInputContent = await fs.readFile(candidateInputAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "teacher_candidate_input_artifact_missing",
            dateKey,
            candidateInputId,
            teacherCandidateInputPath: candidateInputRelPath,
            action:
              "Create the same-day finance teacher candidate-input artifact first before recording a consumption outcome.",
          });
        }
        throw error;
      }

      const parsedCandidateInputs =
        parseFeishuFinanceDoctrineTeacherCandidateInputArtifact(candidateInputContent);
      if (!parsedCandidateInputs) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_artifact_malformed",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          action:
            "Repair or archive the malformed finance teacher candidate-input artifact before retrying finance_doctrine_teacher_feedback_candidate_input_review.",
        });
      }

      const expectedTargetGovernancePath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey),
        )
        .replace(/\\/gu, "/");

      const sourceCandidateInput = parsedCandidateInputs.candidateInputs.find(
        (candidateInput) => candidateInput.candidateInputId === candidateInputId,
      );
      if (!sourceCandidateInput) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_not_found",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          availableCandidateInputIds: parsedCandidateInputs.candidateInputs.map(
            (candidateInput) => candidateInput.candidateInputId,
          ),
          action:
            "Use finance_promotion_candidates with this dateKey to inspect current teacher candidate-input ids before retrying finance_doctrine_teacher_feedback_candidate_input_review.",
        });
      }

      if (sourceCandidateInput.targetGovernancePath !== expectedTargetGovernancePath) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_linkage_mismatch",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          targetGovernancePath: sourceCandidateInput.targetGovernancePath,
          action:
            "Repair the teacher candidate-input target governance path before retrying finance_doctrine_teacher_feedback_candidate_input_review.",
        });
      }

      const reviewRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const reviewAbsPath = path.join(workspaceDir, reviewRelPath);
      let parsedReview = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact>
        | undefined;
      try {
        parsedReview = parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact(
          await fs.readFile(reviewAbsPath, "utf8"),
        );
        if (!parsedReview) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "teacher_candidate_input_review_artifact_malformed",
            dateKey,
            candidateInputId,
            teacherCandidateInputPath: candidateInputRelPath,
            teacherCandidateInputReviewPath: reviewRelPath,
            action:
              "Repair or archive the malformed finance teacher candidate-input review artifact before retrying finance_doctrine_teacher_feedback_candidate_input_review.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      if (
        parsedReview &&
        parsedReview.sourceTeacherCandidateInputArtifact !== candidateInputRelPath
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_review_linkage_mismatch",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherCandidateInputReviewPath: reviewRelPath,
          action:
            "Repair the teacher candidate-input review linkage before retrying finance_doctrine_teacher_feedback_candidate_input_review.",
        });
      }

      const existingReview = parsedReview?.reviews.find(
        (review) => review.candidateInputId === candidateInputId,
      );
      if (
        existingReview &&
        (existingReview.handoffId !== sourceCandidateInput.handoffId ||
          existingReview.feedbackId !== sourceCandidateInput.feedbackId ||
          existingReview.targetGovernancePath !== sourceCandidateInput.targetGovernancePath)
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_review_linkage_mismatch",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherCandidateInputReviewPath: reviewRelPath,
          action:
            "Repair the teacher candidate-input review linkage before retrying finance_doctrine_teacher_feedback_candidate_input_review.",
        });
      }

      if (existingReview) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "invalid_teacher_candidate_input_review_transition",
          dateKey,
          candidateInputId,
          currentOutcome: existingReview.reviewOutcome,
          requestedOutcome: outcome,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherCandidateInputReviewPath: reviewRelPath,
          action:
            "Teacher candidate-input artifacts can only move once from pending into consumed_into_candidate_flow, rejected_before_candidate_flow, or superseded.",
        });
      }

      await fs.writeFile(
        reviewAbsPath,
        renderFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact({
          reviewedAt: new Date().toISOString(),
          sourceTeacherCandidateInputArtifact: candidateInputRelPath,
          reviews: [
            ...(parsedReview?.reviews ?? []),
            {
              candidateInputId,
              handoffId: sourceCandidateInput.handoffId,
              feedbackId: sourceCandidateInput.feedbackId,
              targetGovernancePath: sourceCandidateInput.targetGovernancePath,
              reviewOutcome: outcome,
            },
          ],
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        candidateInputId,
        handoffId: sourceCandidateInput.handoffId,
        feedbackId: sourceCandidateInput.feedbackId,
        targetGovernancePath: sourceCandidateInput.targetGovernancePath,
        reviewOutcome: outcome,
        teacherCandidateInputPath: candidateInputRelPath,
        teacherCandidateInputReviewPath: reviewRelPath,
        action:
          "This records bounded teacher candidate-input consumption state only. It does not create promotion candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
      });
    },
  };
}
