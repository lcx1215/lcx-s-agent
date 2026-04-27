import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename,
  buildFeishuFinanceDoctrineTeacherFeedbackFilename,
  buildFeishuFinanceDoctrineTeacherReviewFilename,
  parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
  parseFeishuFinanceDoctrineTeacherFeedbackArtifact,
  parseFeishuFinanceDoctrineTeacherReviewArtifact,
  renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const OPENABLE_TEACHER_ELEVATION_HANDOFF_STATUSES = ["open", "superseded"] as const;

const FinanceDoctrineTeacherFeedbackElevationHandoffSchema = Type.Object({
  dateKey: Type.String(),
  feedbackId: Type.String(),
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

function buildTeacherElevationHandoffId(dateKey: string, feedbackId: string): string {
  const feedbackSlug = feedbackId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `finance-teacher-elevation-handoff-${dateKey}-${feedbackSlug || "feedback"}`;
}

function buildOperatorNextAction(): string {
  return "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.";
}

export function createFinanceDoctrineTeacherFeedbackElevationHandoffTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Doctrine Teacher Elevation Handoff",
    name: "finance_doctrine_teacher_feedback_elevation_handoff",
    description:
      "Create or refresh a bounded finance governance handoff for one same-day teacher critique already reviewed as elevated_for_governance_review. This writes a durable handoff artifact only and does not adopt knowledge, promote doctrine, or mutate doctrine cards automatically.",
    parameters: FinanceDoctrineTeacherFeedbackElevationHandoffSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const feedbackId = readStringParam(params, "feedbackId", { required: true });

      const teacherFeedbackRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const teacherFeedbackAbsPath = path.join(workspaceDir, teacherFeedbackRelPath);
      const teacherFeedbackContent = await readUtf8OrMissing(teacherFeedbackAbsPath);
      if (teacherFeedbackContent == null) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_feedback_artifact_missing",
          dateKey,
          feedbackId,
          teacherFeedbackPath: teacherFeedbackRelPath,
          action:
            "Create or restore the same-day finance teacher-feedback artifact before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      const parsedTeacherFeedback =
        parseFeishuFinanceDoctrineTeacherFeedbackArtifact(teacherFeedbackContent);
      if (!parsedTeacherFeedback) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_feedback_artifact_malformed",
          dateKey,
          feedbackId,
          teacherFeedbackPath: teacherFeedbackRelPath,
          action:
            "Repair or archive the malformed finance teacher-feedback artifact before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      const feedback = parsedTeacherFeedback.feedbacks.find(
        (entry) => entry.feedbackId === feedbackId,
      );
      if (!feedback) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "feedback_not_found",
          dateKey,
          feedbackId,
          teacherFeedbackPath: teacherFeedbackRelPath,
          availableFeedbackIds: parsedTeacherFeedback.feedbacks.map((entry) => entry.feedbackId),
          action:
            "Use finance_promotion_candidates with this dateKey to inspect current teacher feedback ids before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      const teacherReviewRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const teacherReviewAbsPath = path.join(workspaceDir, teacherReviewRelPath);
      const teacherReviewContent = await readUtf8OrMissing(teacherReviewAbsPath);
      if (teacherReviewContent == null) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_review_artifact_missing",
          dateKey,
          feedbackId,
          teacherFeedbackPath: teacherFeedbackRelPath,
          teacherReviewPath: teacherReviewRelPath,
          action:
            "Create or restore the same-day finance teacher-review artifact before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      const parsedTeacherReview =
        parseFeishuFinanceDoctrineTeacherReviewArtifact(teacherReviewContent);
      if (!parsedTeacherReview) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_review_artifact_malformed",
          dateKey,
          feedbackId,
          teacherFeedbackPath: teacherFeedbackRelPath,
          teacherReviewPath: teacherReviewRelPath,
          action:
            "Repair or archive the malformed finance teacher-review artifact before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      if (parsedTeacherReview.sourceTeacherFeedbackArtifact !== teacherFeedbackRelPath) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_review_artifact_link_mismatch",
          dateKey,
          feedbackId,
          teacherFeedbackPath: teacherFeedbackRelPath,
          teacherReviewPath: teacherReviewRelPath,
          action:
            "Repair the teacher-review artifact linkage before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      const teacherReview = parsedTeacherReview.reviews.find(
        (entry) => entry.feedbackId === feedbackId,
      );
      if (!teacherReview) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "feedback_not_reviewed",
          dateKey,
          feedbackId,
          teacherFeedbackPath: teacherFeedbackRelPath,
          teacherReviewPath: teacherReviewRelPath,
          action:
            "Review the teacher critique first before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      if (teacherReview.sourceArtifact !== feedback.sourceArtifact) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "linkage_mismatch",
          dateKey,
          feedbackId,
          sourceArtifact: feedback.sourceArtifact,
          teacherFeedbackPath: teacherFeedbackRelPath,
          teacherReviewPath: teacherReviewRelPath,
          action:
            "Repair the teacher feedback and teacher review linkage before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      if (teacherReview.reviewOutcome !== "elevated_for_governance_review") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_review_not_elevated",
          dateKey,
          feedbackId,
          reviewOutcome: teacherReview.reviewOutcome,
          teacherFeedbackPath: teacherFeedbackRelPath,
          teacherReviewPath: teacherReviewRelPath,
          action:
            "Only teacher critiques already marked elevated_for_governance_review can create a finance governance elevation handoff.",
        });
      }

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
      const teacherElevationHandoffContent = await readUtf8OrMissing(
        teacherElevationHandoffAbsPath,
      );
      const parsedTeacherElevationHandoff = teacherElevationHandoffContent
        ? parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact(teacherElevationHandoffContent)
        : undefined;

      if (teacherElevationHandoffContent != null && !parsedTeacherElevationHandoff) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_elevation_handoff_artifact_malformed",
          dateKey,
          feedbackId,
          teacherFeedbackPath: teacherFeedbackRelPath,
          teacherReviewPath: teacherReviewRelPath,
          teacherElevationHandoffPath: teacherElevationHandoffRelPath,
          action:
            "Repair or archive the malformed finance teacher-elevation handoff artifact before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      if (
        parsedTeacherElevationHandoff &&
        (parsedTeacherElevationHandoff.sourceTeacherFeedbackArtifact !== teacherFeedbackRelPath ||
          parsedTeacherElevationHandoff.sourceTeacherReviewArtifact !== teacherReviewRelPath)
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "linkage_mismatch",
          dateKey,
          feedbackId,
          teacherFeedbackPath: teacherFeedbackRelPath,
          teacherReviewPath: teacherReviewRelPath,
          teacherElevationHandoffPath: teacherElevationHandoffRelPath,
          action:
            "Repair the teacher-elevation handoff linkage before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
        });
      }

      const existingHandoff = parsedTeacherElevationHandoff?.handoffs.find(
        (entry) => entry.feedbackId === feedbackId,
      );
      if (
        existingHandoff &&
        !OPENABLE_TEACHER_ELEVATION_HANDOFF_STATUSES.includes(existingHandoff.status)
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "invalid_teacher_elevation_handoff_transition",
          dateKey,
          feedbackId,
          currentStatus: existingHandoff.status,
          teacherFeedbackPath: teacherFeedbackRelPath,
          teacherReviewPath: teacherReviewRelPath,
          teacherElevationHandoffPath: teacherElevationHandoffRelPath,
          action: "Only open or superseded teacher-elevation handoffs can be refreshed.",
        });
      }

      const targetGovernancePath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey),
        )
        .replace(/\\/gu, "/");

      const handoff = {
        handoffId:
          existingHandoff?.handoffId ?? buildTeacherElevationHandoffId(dateKey, feedbackId),
        feedbackId,
        critiqueType: feedback.critiqueType,
        critiqueText: feedback.critiqueText,
        suggestedCandidateText: feedback.suggestedCandidateText,
        evidenceNeeded: feedback.evidenceNeeded,
        riskOfAdopting: feedback.riskOfAdopting,
        targetGovernancePath,
        operatorNextAction: buildOperatorNextAction(),
        status: "open" as const,
      };

      const nextHandoffs = parsedTeacherElevationHandoff
        ? [
            ...parsedTeacherElevationHandoff.handoffs.filter(
              (entry) => entry.feedbackId !== feedbackId,
            ),
            handoff,
          ]
        : [handoff];

      await fs.writeFile(
        teacherElevationHandoffAbsPath,
        renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
          handedOffAt: new Date().toISOString(),
          sourceTeacherFeedbackArtifact: teacherFeedbackRelPath,
          sourceTeacherReviewArtifact: teacherReviewRelPath,
          handoffs: nextHandoffs,
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        feedbackId,
        critiqueType: feedback.critiqueType,
        teacherFeedbackPath: teacherFeedbackRelPath,
        teacherReviewPath: teacherReviewRelPath,
        teacherElevationHandoffPath: teacherElevationHandoffRelPath,
        targetGovernancePath,
        handoffId: handoff.handoffId,
        handoffStatus: handoff.status,
        action:
          "This writes a bounded teacher-elevation handoff only. It does not adopt knowledge, does not create finance candidates automatically, and does not mutate doctrine cards automatically.",
      });
    },
  };
}
