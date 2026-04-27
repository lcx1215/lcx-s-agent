import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputsFilename,
  parseFeishuFinanceDoctrineTeacherCandidateInputArtifact,
  parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
  parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact,
  renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_MODES = [
  "link_existing_candidate",
  "new_candidate_reference",
] as const;

const FinanceDoctrineTeacherFeedbackCandidateInputReconciliationSchema = Type.Object({
  dateKey: Type.String(),
  candidateInputId: Type.String(),
  reconciliationMode: stringEnum(FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_MODES),
  reconciliationNotes: Type.String(),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

function buildReconciliationId(dateKey: string, candidateInputId: string): string {
  const candidateInputSlug = candidateInputId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `finance-teacher-candidate-input-reconciliation-${dateKey}-${candidateInputSlug || "candidate-input"}`;
}

export function createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Doctrine Teacher Candidate Input Reconciliation",
    name: "finance_doctrine_teacher_feedback_candidate_input_reconciliation",
    description:
      "Create or refresh one bounded finance-candidate reconciliation artifact from a same-day teacher candidate-input already reviewed as consumed_into_candidate_flow. This writes only the durable reconciliation artifact and does not create promotion candidates automatically, promote doctrine, or mutate doctrine cards.",
    parameters: FinanceDoctrineTeacherFeedbackCandidateInputReconciliationSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const candidateInputId = readStringParam(params, "candidateInputId", { required: true });
      const reconciliationMode = readStringParam(params, "reconciliationMode", {
        required: true,
      }) as (typeof FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_MODES)[number];
      if (
        !FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_MODES.includes(reconciliationMode)
      ) {
        throw new ToolInputError(
          `reconciliationMode must be one of: ${FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_MODES.join(", ")}`,
        );
      }
      const reconciliationNotes = readStringParam(params, "reconciliationNotes", {
        required: true,
      }).trim();
      if (!reconciliationNotes) {
        throw new ToolInputError("reconciliationNotes must be non-empty");
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
              "Create the same-day finance teacher candidate-input artifact first before reconciling it into the finance candidate flow.",
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
            "Repair or archive the malformed finance teacher candidate-input artifact before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
        });
      }

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
            "Use finance_promotion_candidates with this dateKey to inspect current teacher candidate-input ids before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
        });
      }

      const expectedTargetFinanceCandidatePath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      if (sourceCandidateInput.targetGovernancePath !== expectedTargetFinanceCandidatePath) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_linkage_mismatch",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          targetFinanceCandidatePath: sourceCandidateInput.targetGovernancePath,
          action:
            "Repair the teacher candidate-input target governance path before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
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
      let reviewContent: string;
      try {
        reviewContent = await fs.readFile(reviewAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "teacher_candidate_input_review_artifact_missing",
            dateKey,
            candidateInputId,
            teacherCandidateInputPath: candidateInputRelPath,
            teacherCandidateInputReviewPath: reviewRelPath,
            action:
              "Record the same-day teacher candidate-input review state first before reconciling it into the finance candidate flow.",
          });
        }
        throw error;
      }

      const parsedReview =
        parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact(reviewContent);
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
            "Repair or archive the malformed finance teacher candidate-input review artifact before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
        });
      }

      if (parsedReview.sourceTeacherCandidateInputArtifact !== candidateInputRelPath) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_review_linkage_mismatch",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherCandidateInputReviewPath: reviewRelPath,
          action:
            "Repair the teacher candidate-input review linkage before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
        });
      }

      const sourceReview = parsedReview.reviews.find(
        (review) => review.candidateInputId === candidateInputId,
      );
      if (!sourceReview) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_review_not_found",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherCandidateInputReviewPath: reviewRelPath,
          action:
            "Use finance_promotion_candidates with this dateKey to inspect current teacher candidate-input review state before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
        });
      }

      if (
        sourceReview.handoffId !== sourceCandidateInput.handoffId ||
        sourceReview.feedbackId !== sourceCandidateInput.feedbackId ||
        sourceReview.targetGovernancePath !== sourceCandidateInput.targetGovernancePath
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
            "Repair the teacher candidate-input review linkage before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
        });
      }

      if (sourceReview.reviewOutcome !== "consumed_into_candidate_flow") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_not_consumed",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherCandidateInputReviewPath: reviewRelPath,
          reviewOutcome: sourceReview.reviewOutcome,
          action:
            "Only teacher candidate-input artifacts already marked consumed_into_candidate_flow can create a finance-candidate reconciliation artifact.",
        });
      }

      const reconciliationRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const reconciliationAbsPath = path.join(workspaceDir, reconciliationRelPath);
      let parsedReconciliation = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact>
        | undefined;
      try {
        parsedReconciliation =
          parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact(
            await fs.readFile(reconciliationAbsPath, "utf8"),
          );
        if (!parsedReconciliation) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "teacher_candidate_input_reconciliation_artifact_malformed",
            dateKey,
            candidateInputId,
            teacherCandidateInputPath: candidateInputRelPath,
            teacherCandidateInputReviewPath: reviewRelPath,
            teacherCandidateInputReconciliationPath: reconciliationRelPath,
            action:
              "Repair or archive the malformed finance teacher candidate-input reconciliation artifact before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      if (
        parsedReconciliation &&
        (parsedReconciliation.sourceTeacherCandidateInputArtifact !== candidateInputRelPath ||
          parsedReconciliation.sourceTeacherCandidateInputReviewArtifact !== reviewRelPath)
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_reconciliation_linkage_mismatch",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherCandidateInputReviewPath: reviewRelPath,
          teacherCandidateInputReconciliationPath: reconciliationRelPath,
          action:
            "Repair the teacher candidate-input reconciliation linkage before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
        });
      }

      const existingReconciliation = parsedReconciliation?.reconciliations.find(
        (reconciliation) => reconciliation.candidateInputId === candidateInputId,
      );
      if (
        existingReconciliation &&
        (existingReconciliation.sourceTeacherCandidateInputArtifact !== candidateInputRelPath ||
          existingReconciliation.sourceTeacherCandidateInputReviewArtifact !== reviewRelPath ||
          existingReconciliation.targetFinanceCandidatePath !==
            sourceCandidateInput.targetGovernancePath)
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_reconciliation_linkage_mismatch",
          dateKey,
          candidateInputId,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherCandidateInputReviewPath: reviewRelPath,
          teacherCandidateInputReconciliationPath: reconciliationRelPath,
          action:
            "Repair the teacher candidate-input reconciliation linkage before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
        });
      }

      if (existingReconciliation && existingReconciliation.status !== "open") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "invalid_teacher_candidate_input_reconciliation_transition",
          dateKey,
          candidateInputId,
          currentStatus: existingReconciliation.status,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherCandidateInputReviewPath: reviewRelPath,
          teacherCandidateInputReconciliationPath: reconciliationRelPath,
          action:
            "Teacher candidate-input reconciliation artifacts can only be refreshed while still open. Resolved reconciliation state must not be silently overwritten.",
        });
      }

      const reconciliationId =
        existingReconciliation?.reconciliationId ??
        buildReconciliationId(dateKey, candidateInputId);
      const nextReconciliations = new Map(
        parsedReconciliation?.reconciliations.map((reconciliation) => [
          reconciliation.candidateInputId,
          reconciliation,
        ]) ?? [],
      );
      nextReconciliations.set(candidateInputId, {
        reconciliationId,
        sourceTeacherCandidateInputArtifact: candidateInputRelPath,
        sourceTeacherCandidateInputReviewArtifact: reviewRelPath,
        candidateInputId,
        targetFinanceCandidatePath: sourceCandidateInput.targetGovernancePath,
        reconciliationMode,
        reconciliationNotes,
        status: "open",
      });

      await fs.mkdir(path.dirname(reconciliationAbsPath), { recursive: true });
      await fs.writeFile(
        reconciliationAbsPath,
        renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact({
          reconciledAt: new Date().toISOString(),
          sourceTeacherCandidateInputArtifact: candidateInputRelPath,
          sourceTeacherCandidateInputReviewArtifact: reviewRelPath,
          reconciliations: [...nextReconciliations.values()].toSorted((left, right) =>
            left.reconciliationId.localeCompare(right.reconciliationId),
          ),
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        candidateInputId,
        reconciliationId,
        targetFinanceCandidatePath: sourceCandidateInput.targetGovernancePath,
        reconciliationMode,
        reconciliationNotes,
        status: "open",
        teacherCandidateInputPath: candidateInputRelPath,
        teacherCandidateInputReviewPath: reviewRelPath,
        teacherCandidateInputReconciliationPath: reconciliationRelPath,
        action:
          "This creates a bounded finance-candidate reconciliation artifact only. It does not create promotion candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
      });
    },
  };
}
