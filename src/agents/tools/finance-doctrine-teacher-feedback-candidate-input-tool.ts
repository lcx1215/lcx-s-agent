import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputsFilename,
  buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename,
  buildFeishuFinanceDoctrineTeacherFeedbackFilename,
  buildFeishuFinanceDoctrineTeacherReviewFilename,
  parseFeishuFinanceDoctrineTeacherCandidateInputArtifact,
  parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
  renderFeishuFinanceDoctrineTeacherCandidateInputArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FinanceDoctrineTeacherFeedbackCandidateInputSchema = Type.Object({
  dateKey: Type.String(),
  handoffId: Type.String(),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

function buildCandidateInputId(dateKey: string, handoffId: string): string {
  const handoffSlug = handoffId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `finance-teacher-candidate-input-${dateKey}-${handoffSlug || "handoff"}`;
}

export function createFinanceDoctrineTeacherFeedbackCandidateInputTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Doctrine Teacher Candidate Input",
    name: "finance_doctrine_teacher_feedback_candidate_input",
    description:
      "Create or refresh one bounded finance governance candidate-input artifact from a same-day teacher-elevation handoff already marked converted_to_candidate_input. This writes only the durable candidate-input artifact and does not create promotion candidates automatically, promote doctrine, or mutate doctrine cards.",
    parameters: FinanceDoctrineTeacherFeedbackCandidateInputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const handoffId = readStringParam(params, "handoffId", { required: true });

      const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
      const teacherElevationHandoffRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const teacherElevationHandoffAbsPath = path.join(
        workspaceDir,
        teacherElevationHandoffRelPath,
      );

      let teacherElevationHandoffContent: string;
      try {
        teacherElevationHandoffContent = await fs.readFile(teacherElevationHandoffAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "teacher_elevation_handoff_artifact_missing",
            dateKey,
            handoffId,
            teacherElevationHandoffPath: teacherElevationHandoffRelPath,
            action:
              "Create the same-day finance teacher-elevation handoff first before creating a teacher candidate input.",
          });
        }
        throw error;
      }

      const parsedTeacherElevationHandoffs =
        parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact(teacherElevationHandoffContent);
      if (!parsedTeacherElevationHandoffs) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_elevation_handoff_artifact_malformed",
          dateKey,
          handoffId,
          teacherElevationHandoffPath: teacherElevationHandoffRelPath,
          action:
            "Repair or archive the malformed finance teacher-elevation handoff artifact before retrying finance_doctrine_teacher_feedback_candidate_input.",
        });
      }

      const expectedTeacherFeedbackPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const expectedTeacherReviewPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const expectedTargetGovernancePath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      if (
        parsedTeacherElevationHandoffs.sourceTeacherFeedbackArtifact !==
          expectedTeacherFeedbackPath ||
        parsedTeacherElevationHandoffs.sourceTeacherReviewArtifact !== expectedTeacherReviewPath
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_elevation_handoff_linkage_mismatch",
          dateKey,
          handoffId,
          teacherElevationHandoffPath: teacherElevationHandoffRelPath,
          teacherFeedbackPath: parsedTeacherElevationHandoffs.sourceTeacherFeedbackArtifact,
          teacherReviewPath: parsedTeacherElevationHandoffs.sourceTeacherReviewArtifact,
          action:
            "Repair the teacher-elevation handoff linkage before retrying finance_doctrine_teacher_feedback_candidate_input.",
        });
      }

      const sourceHandoff = parsedTeacherElevationHandoffs.handoffs.find(
        (handoff) => handoff.handoffId === handoffId,
      );
      if (!sourceHandoff) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_elevation_handoff_not_found",
          dateKey,
          handoffId,
          teacherElevationHandoffPath: teacherElevationHandoffRelPath,
          availableHandoffIds: parsedTeacherElevationHandoffs.handoffs.map(
            (handoff) => handoff.handoffId,
          ),
          action:
            "Use finance_promotion_candidates with this dateKey to inspect current teacher-elevation handoff ids before retrying finance_doctrine_teacher_feedback_candidate_input.",
        });
      }

      if (
        sourceHandoff.status !== "converted_to_candidate_input" ||
        sourceHandoff.targetGovernancePath !== expectedTargetGovernancePath
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason:
            sourceHandoff.status !== "converted_to_candidate_input"
              ? "teacher_elevation_handoff_not_converted"
              : "teacher_elevation_handoff_linkage_mismatch",
          dateKey,
          handoffId,
          handoffStatus: sourceHandoff.status,
          teacherElevationHandoffPath: teacherElevationHandoffRelPath,
          targetGovernancePath: sourceHandoff.targetGovernancePath,
          action:
            sourceHandoff.status !== "converted_to_candidate_input"
              ? "Only teacher-elevation handoffs already marked converted_to_candidate_input can create a finance candidate-input artifact."
              : "Repair the teacher-elevation handoff target governance path before retrying finance_doctrine_teacher_feedback_candidate_input.",
        });
      }

      const candidateInputRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const candidateInputAbsPath = path.join(workspaceDir, candidateInputRelPath);
      let parsedCandidateInputs = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherCandidateInputArtifact>
        | undefined;
      try {
        parsedCandidateInputs = parseFeishuFinanceDoctrineTeacherCandidateInputArtifact(
          await fs.readFile(candidateInputAbsPath, "utf8"),
        );
        if (!parsedCandidateInputs) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "teacher_candidate_input_artifact_malformed",
            dateKey,
            handoffId,
            teacherCandidateInputPath: candidateInputRelPath,
            action:
              "Repair or archive the malformed finance teacher candidate-input artifact before retrying finance_doctrine_teacher_feedback_candidate_input.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      if (
        parsedCandidateInputs &&
        (parsedCandidateInputs.sourceTeacherElevationHandoffArtifact !==
          teacherElevationHandoffRelPath ||
          parsedCandidateInputs.sourceTeacherFeedbackArtifact !== expectedTeacherFeedbackPath ||
          parsedCandidateInputs.sourceTeacherReviewArtifact !== expectedTeacherReviewPath)
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_candidate_input_linkage_mismatch",
          dateKey,
          handoffId,
          teacherCandidateInputPath: candidateInputRelPath,
          teacherElevationHandoffPath: parsedCandidateInputs.sourceTeacherElevationHandoffArtifact,
          teacherFeedbackPath: parsedCandidateInputs.sourceTeacherFeedbackArtifact,
          teacherReviewPath: parsedCandidateInputs.sourceTeacherReviewArtifact,
          action:
            "Repair the teacher candidate-input linkage before retrying finance_doctrine_teacher_feedback_candidate_input.",
        });
      }

      const candidateInputId = buildCandidateInputId(dateKey, handoffId);
      const previousCandidateInput = parsedCandidateInputs?.candidateInputs.find(
        (candidateInput) => candidateInput.handoffId === handoffId,
      );
      const nextCandidateInputs = new Map(
        parsedCandidateInputs?.candidateInputs.map((candidateInput) => [
          candidateInput.handoffId,
          candidateInput,
        ]) ?? [],
      );
      nextCandidateInputs.set(handoffId, {
        candidateInputId: previousCandidateInput?.candidateInputId ?? candidateInputId,
        handoffId,
        feedbackId: sourceHandoff.feedbackId,
        critiqueType: sourceHandoff.critiqueType,
        critiqueText: sourceHandoff.critiqueText,
        suggestedCandidateText: sourceHandoff.suggestedCandidateText,
        evidenceNeeded: sourceHandoff.evidenceNeeded,
        riskOfAdopting: sourceHandoff.riskOfAdopting,
        targetGovernancePath: sourceHandoff.targetGovernancePath,
        operatorNextAction: sourceHandoff.operatorNextAction,
      });

      await fs.mkdir(receiptsDir, { recursive: true });
      await fs.writeFile(
        candidateInputAbsPath,
        renderFeishuFinanceDoctrineTeacherCandidateInputArtifact({
          createdAt: new Date().toISOString(),
          sourceTeacherElevationHandoffArtifact: teacherElevationHandoffRelPath,
          sourceTeacherFeedbackArtifact: expectedTeacherFeedbackPath,
          sourceTeacherReviewArtifact: expectedTeacherReviewPath,
          candidateInputs: Array.from(nextCandidateInputs.values()).toSorted((left, right) =>
            left.handoffId.localeCompare(right.handoffId),
          ),
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        handoffId,
        feedbackId: sourceHandoff.feedbackId,
        candidateInputId: previousCandidateInput?.candidateInputId ?? candidateInputId,
        teacherElevationHandoffPath: teacherElevationHandoffRelPath,
        teacherCandidateInputPath: candidateInputRelPath,
        targetGovernancePath: sourceHandoff.targetGovernancePath,
        action:
          "This creates a bounded finance governance candidate-input artifact only. It does not create promotion candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
      });
    },
  };
}
