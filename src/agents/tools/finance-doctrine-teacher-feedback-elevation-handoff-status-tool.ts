import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename,
  buildFeishuFinanceDoctrineTeacherFeedbackFilename,
  buildFeishuFinanceDoctrineTeacherReviewFilename,
  parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
  renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_DOCTRINE_TEACHER_ELEVATION_HANDOFF_TARGET_STATUSES = [
  "converted_to_candidate_input",
  "rejected_after_handoff_review",
  "superseded",
] as const;

const FinanceDoctrineTeacherFeedbackElevationHandoffStatusSchema = Type.Object({
  dateKey: Type.String(),
  handoffId: Type.String(),
  status: stringEnum(FINANCE_DOCTRINE_TEACHER_ELEVATION_HANDOFF_TARGET_STATUSES),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

export function createFinanceDoctrineTeacherFeedbackElevationHandoffStatusTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Doctrine Teacher Elevation Handoff Status",
    name: "finance_doctrine_teacher_feedback_elevation_handoff_status",
    description:
      "Record a bounded status action for one same-day finance teacher-elevation handoff by handoffId. This updates the durable handoff artifact only and does not create finance candidates automatically or mutate doctrine cards.",
    parameters: FinanceDoctrineTeacherFeedbackElevationHandoffStatusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const handoffId = readStringParam(params, "handoffId", { required: true });
      const status = readStringParam(params, "status", { required: true }) as
        | (typeof FINANCE_DOCTRINE_TEACHER_ELEVATION_HANDOFF_TARGET_STATUSES)[number]
        | undefined;
      if (!status || !FINANCE_DOCTRINE_TEACHER_ELEVATION_HANDOFF_TARGET_STATUSES.includes(status)) {
        throw new ToolInputError(
          `status must be one of: ${FINANCE_DOCTRINE_TEACHER_ELEVATION_HANDOFF_TARGET_STATUSES.join(", ")}`,
        );
      }

      const handoffRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const handoffAbsPath = path.join(workspaceDir, handoffRelPath);

      let handoffContent: string;
      try {
        handoffContent = await fs.readFile(handoffAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "teacher_elevation_handoff_artifact_missing",
            dateKey,
            handoffId,
            teacherElevationHandoffPath: handoffRelPath,
            action:
              "Create the same-day finance teacher-elevation handoff first before recording a conversion action.",
          });
        }
        throw error;
      }

      const parsedHandoffs =
        parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact(handoffContent);
      if (!parsedHandoffs) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_elevation_handoff_artifact_malformed",
          dateKey,
          handoffId,
          teacherElevationHandoffPath: handoffRelPath,
          action:
            "Repair or archive the malformed finance teacher-elevation handoff artifact before retrying finance_doctrine_teacher_feedback_elevation_handoff_status.",
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
      if (
        parsedHandoffs.sourceTeacherFeedbackArtifact !== expectedTeacherFeedbackPath ||
        parsedHandoffs.sourceTeacherReviewArtifact !== expectedTeacherReviewPath
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_elevation_handoff_linkage_mismatch",
          dateKey,
          handoffId,
          teacherElevationHandoffPath: handoffRelPath,
          teacherFeedbackPath: parsedHandoffs.sourceTeacherFeedbackArtifact,
          teacherReviewPath: parsedHandoffs.sourceTeacherReviewArtifact,
          action:
            "Repair the teacher-elevation handoff linkage before retrying finance_doctrine_teacher_feedback_elevation_handoff_status.",
        });
      }

      const targetHandoff = parsedHandoffs.handoffs.find(
        (handoff) => handoff.handoffId === handoffId,
      );
      if (!targetHandoff) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_elevation_handoff_not_found",
          dateKey,
          handoffId,
          teacherElevationHandoffPath: handoffRelPath,
          availableHandoffIds: parsedHandoffs.handoffs.map((handoff) => handoff.handoffId),
          action:
            "Use finance_promotion_candidates with this dateKey to inspect current teacher-elevation handoff ids before retrying finance_doctrine_teacher_feedback_elevation_handoff_status.",
        });
      }

      if (targetHandoff.status !== "open") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "invalid_teacher_elevation_handoff_status_transition",
          dateKey,
          handoffId,
          currentStatus: targetHandoff.status,
          requestedStatus: status,
          teacherElevationHandoffPath: handoffRelPath,
          action:
            "Only teacher-elevation handoffs still in open status can be marked converted_to_candidate_input, rejected_after_handoff_review, or superseded.",
        });
      }

      const nextHandoffs = parsedHandoffs.handoffs.map((handoff) =>
        handoff.handoffId === handoffId ? { ...handoff, status } : handoff,
      );

      await fs.writeFile(
        handoffAbsPath,
        renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
          ...parsedHandoffs,
          handoffs: nextHandoffs,
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        handoffId,
        feedbackId: targetHandoff.feedbackId,
        previousStatus: targetHandoff.status,
        handoffStatus: status,
        teacherElevationHandoffPath: handoffRelPath,
        action:
          "This records teacher-elevation conversion state only. It does not create finance candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
      });
    },
  };
}
