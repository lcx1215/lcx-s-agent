import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputsFilename,
  parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
  renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_TARGET_STATUSES = [
  "linked_to_existing_candidate",
  "created_as_new_candidate_reference",
  "rejected_before_reconciliation",
  "superseded",
] as const;

const FinanceDoctrineTeacherFeedbackCandidateInputReconciliationStatusSchema = Type.Object({
  dateKey: Type.String(),
  reconciliationId: Type.String(),
  status: stringEnum(FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_TARGET_STATUSES),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

export function createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationStatusTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Doctrine Teacher Candidate Input Reconciliation Status",
    name: "finance_doctrine_teacher_feedback_candidate_input_reconciliation_status",
    description:
      "Record a bounded status action for one same-day teacher candidate-input reconciliation by reconciliationId. This updates the durable reconciliation artifact only and does not create promotion candidates automatically, promote doctrine, or mutate doctrine cards.",
    parameters: FinanceDoctrineTeacherFeedbackCandidateInputReconciliationStatusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const reconciliationId = readStringParam(params, "reconciliationId", { required: true });
      const status = readStringParam(params, "status", { required: true }) as
        | (typeof FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_TARGET_STATUSES)[number]
        | undefined;
      if (
        !status ||
        !FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_TARGET_STATUSES.includes(status)
      ) {
        throw new ToolInputError(
          `status must be one of: ${FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_TARGET_STATUSES.join(", ")}`,
        );
      }

      const reconciliationRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const reconciliationAbsPath = path.join(workspaceDir, reconciliationRelPath);

      let reconciliationContent: string;
      try {
        reconciliationContent = await fs.readFile(reconciliationAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "teacher_candidate_input_reconciliation_artifact_missing",
            dateKey,
            reconciliationId,
            teacherCandidateInputReconciliationPath: reconciliationRelPath,
            action:
              "Create the same-day finance teacher candidate-input reconciliation first before recording a reconciliation status action.",
          });
        }
        throw error;
      }

      const parsedReconciliation =
        parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact(
          reconciliationContent,
        );
      if (!parsedReconciliation) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_reconciliation_artifact_malformed",
          dateKey,
          reconciliationId,
          teacherCandidateInputReconciliationPath: reconciliationRelPath,
          action:
            "Repair or archive the malformed finance teacher candidate-input reconciliation artifact before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation_status.",
        });
      }

      const expectedTeacherCandidateInputPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const expectedTeacherCandidateInputReviewPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      if (
        parsedReconciliation.sourceTeacherCandidateInputArtifact !==
          expectedTeacherCandidateInputPath ||
        parsedReconciliation.sourceTeacherCandidateInputReviewArtifact !==
          expectedTeacherCandidateInputReviewPath
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_reconciliation_linkage_mismatch",
          dateKey,
          reconciliationId,
          teacherCandidateInputReconciliationPath: reconciliationRelPath,
          teacherCandidateInputPath: parsedReconciliation.sourceTeacherCandidateInputArtifact,
          teacherCandidateInputReviewPath:
            parsedReconciliation.sourceTeacherCandidateInputReviewArtifact,
          action:
            "Repair the teacher candidate-input reconciliation linkage before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation_status.",
        });
      }

      const expectedTargetFinanceCandidatePath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey),
        )
        .replace(/\\/gu, "/");

      const targetReconciliation = parsedReconciliation.reconciliations.find(
        (reconciliation) => reconciliation.reconciliationId === reconciliationId,
      );
      if (!targetReconciliation) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_reconciliation_not_found",
          dateKey,
          reconciliationId,
          teacherCandidateInputReconciliationPath: reconciliationRelPath,
          availableReconciliationIds: parsedReconciliation.reconciliations.map(
            (reconciliation) => reconciliation.reconciliationId,
          ),
          action:
            "Use finance_promotion_candidates with this dateKey to inspect current teacher candidate-input reconciliation ids before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation_status.",
        });
      }

      if (
        targetReconciliation.sourceTeacherCandidateInputArtifact !==
          expectedTeacherCandidateInputPath ||
        targetReconciliation.sourceTeacherCandidateInputReviewArtifact !==
          expectedTeacherCandidateInputReviewPath ||
        targetReconciliation.targetFinanceCandidatePath !== expectedTargetFinanceCandidatePath
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_reconciliation_linkage_mismatch",
          dateKey,
          reconciliationId,
          teacherCandidateInputReconciliationPath: reconciliationRelPath,
          teacherCandidateInputPath: targetReconciliation.sourceTeacherCandidateInputArtifact,
          teacherCandidateInputReviewPath:
            targetReconciliation.sourceTeacherCandidateInputReviewArtifact,
          targetFinanceCandidatePath: targetReconciliation.targetFinanceCandidatePath,
          action:
            "Repair the teacher candidate-input reconciliation linkage before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation_status.",
        });
      }

      if (targetReconciliation.status !== "open") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "invalid_teacher_candidate_input_reconciliation_status_transition",
          dateKey,
          reconciliationId,
          currentStatus: targetReconciliation.status,
          requestedStatus: status,
          teacherCandidateInputReconciliationPath: reconciliationRelPath,
          action:
            "Only teacher candidate-input reconciliations still in open status can be marked linked_to_existing_candidate, created_as_new_candidate_reference, rejected_before_reconciliation, or superseded.",
        });
      }

      const nextReconciliations = parsedReconciliation.reconciliations.map((reconciliation) =>
        reconciliation.reconciliationId === reconciliationId
          ? { ...reconciliation, status }
          : reconciliation,
      );

      await fs.writeFile(
        reconciliationAbsPath,
        renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact({
          ...parsedReconciliation,
          reconciliations: nextReconciliations,
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        reconciliationId,
        candidateInputId: targetReconciliation.candidateInputId,
        previousStatus: targetReconciliation.status,
        reconciliationStatus: status,
        teacherCandidateInputReconciliationPath: reconciliationRelPath,
        action:
          "This records teacher candidate-input reconciliation status only. It does not create promotion candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
      });
    },
  };
}
