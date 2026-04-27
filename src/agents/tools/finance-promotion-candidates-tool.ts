import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputsFilename,
  buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename,
  buildFeishuFinanceDoctrineTeacherFeedbackFilename,
  buildFeishuFinanceDoctrineTeacherReviewFilename,
  buildFeishuFinanceDoctrineEditHandoffsFilename,
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionDecisionsFilename,
  buildFeishuFinanceDoctrinePromotionProposalsFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  parseFeishuFinanceDoctrineTeacherCandidateInputArtifact,
  parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
  parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact,
  parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
  parseFeishuFinanceDoctrineTeacherFeedbackArtifact,
  parseFeishuFinanceDoctrineTeacherReviewArtifact,
  parseFeishuFinanceDoctrineEditHandoffArtifact,
  parseFeishuFinanceDoctrinePromotionCandidateArtifact,
  parseFeishuFinanceDoctrinePromotionDecisionArtifact,
  parseFeishuFinanceDoctrinePromotionProposalArtifact,
  parseFeishuFinanceDoctrinePromotionReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_PROMOTION_REVIEW_ACTIONS = [
  "deferred",
  "rejected",
  "ready_for_manual_promotion",
] as const;
const FINANCE_PROMOTION_DECISION_OUTCOMES = [
  "proposal_created",
  "deferred_after_promotion_review",
  "rejected_after_promotion_review",
] as const;
const FINANCE_PROMOTION_PROPOSAL_TARGET_STATUSES = [
  "accepted_for_manual_edit",
  "rejected",
  "superseded",
] as const;
const FINANCE_DOCTRINE_TEACHER_REVIEW_OUTCOMES = [
  "deferred",
  "rejected",
  "elevated_for_governance_review",
] as const;
const FINANCE_DOCTRINE_TEACHER_ELEVATION_HANDOFF_TARGET_STATUSES = [
  "converted_to_candidate_input",
  "rejected_after_handoff_review",
  "superseded",
] as const;
const FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_REVIEW_OUTCOMES = [
  "consumed_into_candidate_flow",
  "rejected_before_candidate_flow",
  "superseded",
] as const;
const FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_MODES = [
  "link_existing_candidate",
  "new_candidate_reference",
] as const;
const FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_TARGET_STATUSES = [
  "linked_to_existing_candidate",
  "created_as_new_candidate_reference",
  "rejected_before_reconciliation",
  "superseded",
] as const;

const FinancePromotionCandidatesSchema = Type.Object({
  dateKey: Type.String(),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

export function createFinancePromotionCandidatesTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Promotion Candidates",
    name: "finance_promotion_candidates",
    description:
      "List the same-day finance doctrine promotion candidates from retained governance state, including candidateKey, recognizable candidate text, current review state, and any review notes needed before using finance_promotion_review.",
    parameters: FinancePromotionCandidatesSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const candidateRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey),
      );
      const candidateAbsPath = path.join(workspaceDir, candidateRelPath);

      let candidateContent: string;
      try {
        candidateContent = await fs.readFile(candidateAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            reason: "candidate_artifact_missing",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            action:
              "No same-day finance promotion candidate artifact exists yet. Generate it first before trying to inspect candidate keys.",
          });
        }
        throw error;
      }

      const parsedCandidates =
        parseFeishuFinanceDoctrinePromotionCandidateArtifact(candidateContent);
      if (!parsedCandidates) {
        return jsonResult({
          ok: false,
          reason: "candidate_artifact_malformed",
          dateKey,
          candidatePath: candidateRelPath.replace(/\\/gu, "/"),
          action:
            "Repair or archive the malformed finance promotion candidate artifact before retrying finance_promotion_candidates.",
        });
      }

      const reviewRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey),
      );
      const reviewAbsPath = path.join(workspaceDir, reviewRelPath);
      let parsedReview = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrinePromotionReviewArtifact>
        | undefined;
      let stateSource = "candidate_artifact_only";
      try {
        const reviewContent = await fs.readFile(reviewAbsPath, "utf8");
        parsedReview = parseFeishuFinanceDoctrinePromotionReviewArtifact(reviewContent);
        if (!parsedReview) {
          return jsonResult({
            ok: false,
            reason: "review_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: reviewRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance promotion review artifact before retrying finance_promotion_candidates.",
          });
        }
        stateSource = "candidate_artifact_plus_review_artifact";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const decisionRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey),
      );
      const decisionAbsPath = path.join(workspaceDir, decisionRelPath);
      let parsedDecisions = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrinePromotionDecisionArtifact>
        | undefined;
      try {
        const decisionContent = await fs.readFile(decisionAbsPath, "utf8");
        parsedDecisions = parseFeishuFinanceDoctrinePromotionDecisionArtifact(decisionContent);
        if (!parsedDecisions) {
          return jsonResult({
            ok: false,
            reason: "decision_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: decisionRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance promotion decision artifact before retrying finance_promotion_candidates.",
          });
        }
        stateSource = "candidate_review_and_decision_artifacts";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const reviewByKey = new Map(
        parsedReview?.reviews.map((review) => [review.candidateKey, review]) ?? [],
      );
      const decisionByKey = new Map(
        parsedDecisions?.decisions.map((decision) => [decision.candidateKey, decision]) ?? [],
      );
      const proposalRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey),
      );
      const proposalAbsPath = path.join(workspaceDir, proposalRelPath);
      let parsedProposals = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrinePromotionProposalArtifact>
        | undefined;
      try {
        const proposalContent = await fs.readFile(proposalAbsPath, "utf8");
        parsedProposals = parseFeishuFinanceDoctrinePromotionProposalArtifact(proposalContent);
        if (!parsedProposals) {
          return jsonResult({
            ok: false,
            reason: "proposal_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
            proposalPath: proposalRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance promotion proposal artifact before retrying finance_promotion_candidates.",
          });
        }
        stateSource = "candidate_review_decision_and_proposal_artifacts";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const proposalByKey = new Map(
        parsedProposals?.proposals.map((proposal) => [proposal.candidateKey, proposal]) ?? [],
      );
      const handoffRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrineEditHandoffsFilename(dateKey),
      );
      const handoffAbsPath = path.join(workspaceDir, handoffRelPath);
      let parsedHandoffs = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineEditHandoffArtifact>
        | undefined;
      try {
        const handoffContent = await fs.readFile(handoffAbsPath, "utf8");
        parsedHandoffs = parseFeishuFinanceDoctrineEditHandoffArtifact(handoffContent);
        if (!parsedHandoffs) {
          return jsonResult({
            ok: false,
            reason: "handoff_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
            proposalPath: parsedProposals ? proposalRelPath.replace(/\\/gu, "/") : null,
            handoffPath: handoffRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance doctrine-edit handoff artifact before retrying finance_promotion_candidates.",
          });
        }
        stateSource = "candidate_review_decision_proposal_and_handoff_artifacts";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const handoffByKey = new Map(
        parsedHandoffs?.handoffs.map((handoff) => [handoff.candidateKey, handoff]) ?? [],
      );
      const teacherFeedbackRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey),
      );
      const teacherFeedbackAbsPath = path.join(workspaceDir, teacherFeedbackRelPath);
      let parsedTeacherFeedback = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherFeedbackArtifact>
        | undefined;
      try {
        const teacherFeedbackContent = await fs.readFile(teacherFeedbackAbsPath, "utf8");
        parsedTeacherFeedback =
          parseFeishuFinanceDoctrineTeacherFeedbackArtifact(teacherFeedbackContent);
        if (!parsedTeacherFeedback) {
          return jsonResult({
            ok: false,
            reason: "teacher_feedback_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
            proposalPath: parsedProposals ? proposalRelPath.replace(/\\/gu, "/") : null,
            handoffPath: parsedHandoffs ? handoffRelPath.replace(/\\/gu, "/") : null,
            teacherFeedbackPath: teacherFeedbackRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance teacher-feedback artifact before retrying finance_promotion_candidates.",
          });
        }
        stateSource = "candidate_review_decision_proposal_handoff_and_teacher_feedback_artifacts";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const teacherReviewRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey),
      );
      const teacherReviewAbsPath = path.join(workspaceDir, teacherReviewRelPath);
      let parsedTeacherReview = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherReviewArtifact>
        | undefined;
      try {
        const teacherReviewContent = await fs.readFile(teacherReviewAbsPath, "utf8");
        parsedTeacherReview = parseFeishuFinanceDoctrineTeacherReviewArtifact(teacherReviewContent);
        if (!parsedTeacherReview) {
          return jsonResult({
            ok: false,
            reason: "teacher_review_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
            proposalPath: parsedProposals ? proposalRelPath.replace(/\\/gu, "/") : null,
            handoffPath: parsedHandoffs ? handoffRelPath.replace(/\\/gu, "/") : null,
            teacherFeedbackPath: parsedTeacherFeedback
              ? teacherFeedbackRelPath.replace(/\\/gu, "/")
              : null,
            teacherReviewPath: teacherReviewRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance teacher-review artifact before retrying finance_promotion_candidates.",
          });
        }
        stateSource =
          "candidate_review_decision_proposal_handoff_teacher_feedback_and_teacher_review_artifacts";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const teacherReviewByFeedbackId = new Map(
        parsedTeacherReview?.reviews.map((review) => [review.feedbackId, review]) ?? [],
      );
      const teacherElevationHandoffRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey),
      );
      const teacherElevationHandoffAbsPath = path.join(
        workspaceDir,
        teacherElevationHandoffRelPath,
      );
      let parsedTeacherElevationHandoffs = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact>
        | undefined;
      try {
        const teacherElevationHandoffContent = await fs.readFile(
          teacherElevationHandoffAbsPath,
          "utf8",
        );
        parsedTeacherElevationHandoffs = parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact(
          teacherElevationHandoffContent,
        );
        if (!parsedTeacherElevationHandoffs) {
          return jsonResult({
            ok: false,
            reason: "teacher_elevation_handoff_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
            proposalPath: parsedProposals ? proposalRelPath.replace(/\\/gu, "/") : null,
            handoffPath: parsedHandoffs ? handoffRelPath.replace(/\\/gu, "/") : null,
            teacherFeedbackPath: parsedTeacherFeedback
              ? teacherFeedbackRelPath.replace(/\\/gu, "/")
              : null,
            teacherReviewPath: parsedTeacherReview
              ? teacherReviewRelPath.replace(/\\/gu, "/")
              : null,
            teacherElevationHandoffPath: teacherElevationHandoffRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance teacher-elevation handoff artifact before retrying finance_promotion_candidates.",
          });
        }
        stateSource =
          "candidate_review_decision_proposal_handoff_teacher_feedback_teacher_review_and_teacher_elevation_handoff_artifacts";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const teacherElevationHandoffByFeedbackId = new Map(
        parsedTeacherElevationHandoffs?.handoffs.map((handoff) => [handoff.feedbackId, handoff]) ??
          [],
      );
      const teacherCandidateInputRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey),
      );
      const teacherCandidateInputAbsPath = path.join(workspaceDir, teacherCandidateInputRelPath);
      let parsedTeacherCandidateInputs = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherCandidateInputArtifact>
        | undefined;
      try {
        const teacherCandidateInputContent = await fs.readFile(
          teacherCandidateInputAbsPath,
          "utf8",
        );
        parsedTeacherCandidateInputs = parseFeishuFinanceDoctrineTeacherCandidateInputArtifact(
          teacherCandidateInputContent,
        );
        if (!parsedTeacherCandidateInputs) {
          return jsonResult({
            ok: false,
            reason: "teacher_candidate_input_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
            proposalPath: parsedProposals ? proposalRelPath.replace(/\\/gu, "/") : null,
            handoffPath: parsedHandoffs ? handoffRelPath.replace(/\\/gu, "/") : null,
            teacherFeedbackPath: parsedTeacherFeedback
              ? teacherFeedbackRelPath.replace(/\\/gu, "/")
              : null,
            teacherReviewPath: parsedTeacherReview
              ? teacherReviewRelPath.replace(/\\/gu, "/")
              : null,
            teacherElevationHandoffPath: parsedTeacherElevationHandoffs
              ? teacherElevationHandoffRelPath.replace(/\\/gu, "/")
              : null,
            teacherCandidateInputPath: teacherCandidateInputRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance teacher candidate-input artifact before retrying finance_promotion_candidates.",
          });
        }
        stateSource =
          "candidate_review_decision_proposal_handoff_teacher_feedback_teacher_review_teacher_elevation_handoff_and_teacher_candidate_input_artifacts";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const teacherCandidateInputByHandoffId = new Map(
        parsedTeacherCandidateInputs?.candidateInputs.map((candidateInput) => [
          candidateInput.handoffId,
          candidateInput,
        ]) ?? [],
      );
      const teacherCandidateInputReviewRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename(dateKey),
      );
      const teacherCandidateInputReviewAbsPath = path.join(
        workspaceDir,
        teacherCandidateInputReviewRelPath,
      );
      let parsedTeacherCandidateInputReview = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact>
        | undefined;
      try {
        const teacherCandidateInputReviewContent = await fs.readFile(
          teacherCandidateInputReviewAbsPath,
          "utf8",
        );
        parsedTeacherCandidateInputReview =
          parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact(
            teacherCandidateInputReviewContent,
          );
        if (!parsedTeacherCandidateInputReview) {
          return jsonResult({
            ok: false,
            reason: "teacher_candidate_input_review_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
            proposalPath: parsedProposals ? proposalRelPath.replace(/\\/gu, "/") : null,
            handoffPath: parsedHandoffs ? handoffRelPath.replace(/\\/gu, "/") : null,
            teacherFeedbackPath: parsedTeacherFeedback
              ? teacherFeedbackRelPath.replace(/\\/gu, "/")
              : null,
            teacherReviewPath: parsedTeacherReview
              ? teacherReviewRelPath.replace(/\\/gu, "/")
              : null,
            teacherElevationHandoffPath: parsedTeacherElevationHandoffs
              ? teacherElevationHandoffRelPath.replace(/\\/gu, "/")
              : null,
            teacherCandidateInputPath: parsedTeacherCandidateInputs
              ? teacherCandidateInputRelPath.replace(/\\/gu, "/")
              : null,
            teacherCandidateInputReviewPath: teacherCandidateInputReviewRelPath.replace(
              /\\/gu,
              "/",
            ),
            action:
              "Repair or archive the malformed finance teacher candidate-input review artifact before retrying finance_promotion_candidates.",
          });
        }
        stateSource =
          "candidate_review_decision_proposal_handoff_teacher_feedback_teacher_review_teacher_elevation_handoff_teacher_candidate_input_and_teacher_candidate_input_review_artifacts";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const teacherCandidateInputReviewByCandidateInputId = new Map(
        parsedTeacherCandidateInputReview?.reviews.map((review) => [
          review.candidateInputId,
          review,
        ]) ?? [],
      );
      const teacherCandidateInputReconciliationRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename(dateKey),
      );
      const teacherCandidateInputReconciliationAbsPath = path.join(
        workspaceDir,
        teacherCandidateInputReconciliationRelPath,
      );
      let parsedTeacherCandidateInputReconciliation = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact>
        | undefined;
      try {
        const teacherCandidateInputReconciliationContent = await fs.readFile(
          teacherCandidateInputReconciliationAbsPath,
          "utf8",
        );
        parsedTeacherCandidateInputReconciliation =
          parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact(
            teacherCandidateInputReconciliationContent,
          );
        if (!parsedTeacherCandidateInputReconciliation) {
          return jsonResult({
            ok: false,
            reason: "teacher_candidate_input_reconciliation_artifact_malformed",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
            proposalPath: parsedProposals ? proposalRelPath.replace(/\\/gu, "/") : null,
            handoffPath: parsedHandoffs ? handoffRelPath.replace(/\\/gu, "/") : null,
            teacherFeedbackPath: parsedTeacherFeedback
              ? teacherFeedbackRelPath.replace(/\\/gu, "/")
              : null,
            teacherReviewPath: parsedTeacherReview
              ? teacherReviewRelPath.replace(/\\/gu, "/")
              : null,
            teacherElevationHandoffPath: parsedTeacherElevationHandoffs
              ? teacherElevationHandoffRelPath.replace(/\\/gu, "/")
              : null,
            teacherCandidateInputPath: parsedTeacherCandidateInputs
              ? teacherCandidateInputRelPath.replace(/\\/gu, "/")
              : null,
            teacherCandidateInputReviewPath: parsedTeacherCandidateInputReview
              ? teacherCandidateInputReviewRelPath.replace(/\\/gu, "/")
              : null,
            teacherCandidateInputReconciliationPath:
              teacherCandidateInputReconciliationRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance teacher candidate-input reconciliation artifact before retrying finance_promotion_candidates.",
          });
        }
        if (
          !parsedTeacherCandidateInputs ||
          !parsedTeacherCandidateInputReview ||
          parsedTeacherCandidateInputReconciliation.sourceTeacherCandidateInputArtifact !==
            teacherCandidateInputRelPath.replace(/\\/gu, "/") ||
          parsedTeacherCandidateInputReconciliation.sourceTeacherCandidateInputReviewArtifact !==
            teacherCandidateInputReviewRelPath.replace(/\\/gu, "/")
        ) {
          return jsonResult({
            ok: false,
            reason: "teacher_candidate_input_reconciliation_linkage_mismatch",
            dateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
            decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
            proposalPath: parsedProposals ? proposalRelPath.replace(/\\/gu, "/") : null,
            handoffPath: parsedHandoffs ? handoffRelPath.replace(/\\/gu, "/") : null,
            teacherFeedbackPath: parsedTeacherFeedback
              ? teacherFeedbackRelPath.replace(/\\/gu, "/")
              : null,
            teacherReviewPath: parsedTeacherReview
              ? teacherReviewRelPath.replace(/\\/gu, "/")
              : null,
            teacherElevationHandoffPath: parsedTeacherElevationHandoffs
              ? teacherElevationHandoffRelPath.replace(/\\/gu, "/")
              : null,
            teacherCandidateInputPath: parsedTeacherCandidateInputs
              ? teacherCandidateInputRelPath.replace(/\\/gu, "/")
              : null,
            teacherCandidateInputReviewPath: parsedTeacherCandidateInputReview
              ? teacherCandidateInputReviewRelPath.replace(/\\/gu, "/")
              : null,
            teacherCandidateInputReconciliationPath:
              teacherCandidateInputReconciliationRelPath.replace(/\\/gu, "/"),
            action:
              "Repair the teacher candidate-input reconciliation linkage before retrying finance_promotion_candidates.",
          });
        }
        stateSource =
          "candidate_review_decision_proposal_handoff_teacher_feedback_teacher_review_teacher_elevation_handoff_teacher_candidate_input_teacher_candidate_input_review_and_teacher_candidate_input_reconciliation_artifacts";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const teacherCandidateInputReconciliationByCandidateInputId = new Map(
        parsedTeacherCandidateInputReconciliation?.reconciliations.map((reconciliation) => [
          reconciliation.candidateInputId,
          reconciliation,
        ]) ?? [],
      );
      const candidates = parsedCandidates.candidates.map((candidate) => {
        const reviewed = reviewByKey.get(candidate.candidateKey);
        const reviewState = reviewed?.reviewState ?? candidate.reviewState;
        const reviewNotes = reviewed?.reviewNotes ?? candidate.reviewNotes ?? null;
        const promotionDecision = decisionByKey.get(candidate.candidateKey) ?? null;
        const proposalDraft = proposalByKey.get(candidate.candidateKey) ?? null;
        const doctrineEditHandoff = handoffByKey.get(candidate.candidateKey) ?? null;
        return {
          candidateKey: candidate.candidateKey,
          candidateText: candidate.candidateText,
          signal: candidate.signal,
          observedValue: candidate.observedValue,
          occurrences: candidate.occurrences,
          reviewState,
          reviewNotes,
          promotionDecision: promotionDecision
            ? {
                decisionOutcome: promotionDecision.decisionOutcome,
                reviewStateAtDecision: promotionDecision.reviewStateAtDecision,
                decisionNotes: promotionDecision.decisionNotes ?? null,
              }
            : null,
          proposalDraft: proposalDraft
            ? {
                proposalId: proposalDraft.proposalId,
                sourceDecisionArtifact:
                  parsedProposals?.sourceDecisionArtifact ?? decisionRelPath.replace(/\\/gu, "/"),
                status: proposalDraft.status,
              }
            : null,
          doctrineEditHandoff: doctrineEditHandoff
            ? {
                handoffId: doctrineEditHandoff.handoffId,
                sourceProposalArtifact:
                  parsedHandoffs?.sourceProposalArtifact ?? proposalRelPath.replace(/\\/gu, "/"),
                targetDoctrineOrCard: doctrineEditHandoff.targetDoctrineOrCard,
                status: doctrineEditHandoff.status,
              }
            : null,
          actionTarget: {
            tool: "finance_promotion_review",
            dateKey,
            candidateKey: candidate.candidateKey,
            allowedActions: FINANCE_PROMOTION_REVIEW_ACTIONS,
          },
          promotionDecisionTarget:
            reviewState === "ready_for_manual_promotion"
              ? {
                  tool: "finance_promotion_decision",
                  dateKey,
                  candidateKey: candidate.candidateKey,
                  allowedDecisions: FINANCE_PROMOTION_DECISION_OUTCOMES,
                }
              : null,
          proposalDraftTarget:
            promotionDecision?.decisionOutcome === "proposal_created" &&
            (!proposalDraft ||
              proposalDraft.status === "draft" ||
              proposalDraft.status === "superseded")
              ? {
                  tool: "finance_promotion_proposal_draft",
                  dateKey,
                  candidateKey: candidate.candidateKey,
                }
              : null,
          proposalStatusTarget:
            proposalDraft?.status === "draft"
              ? {
                  tool: "finance_promotion_proposal_status",
                  dateKey,
                  proposalId: proposalDraft.proposalId,
                  allowedStatuses: FINANCE_PROMOTION_PROPOSAL_TARGET_STATUSES,
                }
              : null,
          doctrineEditHandoffTarget:
            proposalDraft?.status === "accepted_for_manual_edit" &&
            (!doctrineEditHandoff || doctrineEditHandoff.status === "superseded")
              ? {
                  tool: "finance_promotion_doctrine_edit_handoff",
                  dateKey,
                  proposalId: proposalDraft.proposalId,
                }
              : null,
        };
      });

      return jsonResult({
        ok: true,
        dateKey,
        stateSource,
        candidatePath: candidateRelPath.replace(/\\/gu, "/"),
        reviewPath: parsedReview ? reviewRelPath.replace(/\\/gu, "/") : null,
        decisionPath: parsedDecisions ? decisionRelPath.replace(/\\/gu, "/") : null,
        proposalPath: parsedProposals ? proposalRelPath.replace(/\\/gu, "/") : null,
        handoffPath: parsedHandoffs ? handoffRelPath.replace(/\\/gu, "/") : null,
        teacherFeedbackPath: parsedTeacherFeedback
          ? teacherFeedbackRelPath.replace(/\\/gu, "/")
          : null,
        teacherReviewPath: parsedTeacherReview ? teacherReviewRelPath.replace(/\\/gu, "/") : null,
        teacherElevationHandoffPath: parsedTeacherElevationHandoffs
          ? teacherElevationHandoffRelPath.replace(/\\/gu, "/")
          : null,
        teacherCandidateInputPath: parsedTeacherCandidateInputs
          ? teacherCandidateInputRelPath.replace(/\\/gu, "/")
          : null,
        teacherCandidateInputReviewPath: parsedTeacherCandidateInputReview
          ? teacherCandidateInputReviewRelPath.replace(/\\/gu, "/")
          : null,
        teacherCandidateInputReconciliationPath: parsedTeacherCandidateInputReconciliation
          ? teacherCandidateInputReconciliationRelPath.replace(/\\/gu, "/")
          : null,
        teacherFeedback:
          parsedTeacherFeedback?.feedbacks.map((feedback) => {
            const teacherReview = teacherReviewByFeedbackId.get(feedback.feedbackId) ?? null;
            const teacherElevationHandoff =
              teacherElevationHandoffByFeedbackId.get(feedback.feedbackId) ?? null;
            const teacherCandidateInput = teacherElevationHandoff
              ? (teacherCandidateInputByHandoffId.get(teacherElevationHandoff.handoffId) ?? null)
              : null;
            const teacherCandidateInputReview = teacherCandidateInput
              ? (teacherCandidateInputReviewByCandidateInputId.get(
                  teacherCandidateInput.candidateInputId,
                ) ?? null)
              : null;
            const teacherCandidateInputReconciliation = teacherCandidateInput
              ? (teacherCandidateInputReconciliationByCandidateInputId.get(
                  teacherCandidateInput.candidateInputId,
                ) ?? null)
              : null;
            return {
              feedbackId: feedback.feedbackId,
              sourceArtifact: feedback.sourceArtifact,
              teacherModel: feedback.teacherModel,
              critiqueType: feedback.critiqueType,
              critiqueText: feedback.critiqueText,
              suggestedCandidateText: feedback.suggestedCandidateText,
              evidenceNeeded: feedback.evidenceNeeded,
              riskOfAdopting: feedback.riskOfAdopting,
              recommendedNextAction: feedback.recommendedNextAction,
              reviewOutcome: teacherReview?.reviewOutcome ?? null,
              reviewTarget: !teacherReview
                ? {
                    tool: "finance_doctrine_teacher_feedback_review",
                    dateKey,
                    feedbackId: feedback.feedbackId,
                    allowedOutcomes: FINANCE_DOCTRINE_TEACHER_REVIEW_OUTCOMES,
                  }
                : null,
              elevationHandoff: teacherElevationHandoff
                ? {
                    handoffId: teacherElevationHandoff.handoffId,
                    targetGovernancePath: teacherElevationHandoff.targetGovernancePath,
                    status: teacherElevationHandoff.status,
                  }
                : null,
              elevationHandoffTarget:
                teacherReview?.reviewOutcome === "elevated_for_governance_review" &&
                (!teacherElevationHandoff || teacherElevationHandoff.status === "superseded")
                  ? {
                      tool: "finance_doctrine_teacher_feedback_elevation_handoff",
                      dateKey,
                      feedbackId: feedback.feedbackId,
                    }
                  : null,
              elevationHandoffStatusTarget:
                teacherElevationHandoff?.status === "open"
                  ? {
                      tool: "finance_doctrine_teacher_feedback_elevation_handoff_status",
                      dateKey,
                      handoffId: teacherElevationHandoff.handoffId,
                      allowedStatuses: FINANCE_DOCTRINE_TEACHER_ELEVATION_HANDOFF_TARGET_STATUSES,
                    }
                  : null,
              candidateInput: teacherCandidateInput
                ? {
                    candidateInputId: teacherCandidateInput.candidateInputId,
                    sourceTeacherElevationHandoffArtifact:
                      parsedTeacherCandidateInputs?.sourceTeacherElevationHandoffArtifact ??
                      teacherElevationHandoffRelPath.replace(/\\/gu, "/"),
                    targetGovernancePath: teacherCandidateInput.targetGovernancePath,
                  }
                : null,
              candidateInputTarget:
                teacherElevationHandoff?.status === "converted_to_candidate_input" &&
                !teacherCandidateInput
                  ? {
                      tool: "finance_doctrine_teacher_feedback_candidate_input",
                      dateKey,
                      handoffId: teacherElevationHandoff.handoffId,
                    }
                  : null,
              candidateInputReview: teacherCandidateInputReview
                ? {
                    reviewOutcome: teacherCandidateInputReview.reviewOutcome,
                    sourceTeacherCandidateInputArtifact:
                      parsedTeacherCandidateInputReview?.sourceTeacherCandidateInputArtifact ??
                      teacherCandidateInputRelPath.replace(/\\/gu, "/"),
                  }
                : null,
              candidateInputReviewTarget:
                teacherCandidateInput && !teacherCandidateInputReview
                  ? {
                      tool: "finance_doctrine_teacher_feedback_candidate_input_review",
                      dateKey,
                      candidateInputId: teacherCandidateInput.candidateInputId,
                      allowedOutcomes: FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_REVIEW_OUTCOMES,
                    }
                  : null,
              candidateInputReconciliation: teacherCandidateInputReconciliation
                ? {
                    reconciliationId: teacherCandidateInputReconciliation.reconciliationId,
                    sourceTeacherCandidateInputArtifact:
                      teacherCandidateInputReconciliation.sourceTeacherCandidateInputArtifact,
                    sourceTeacherCandidateInputReviewArtifact:
                      teacherCandidateInputReconciliation.sourceTeacherCandidateInputReviewArtifact,
                    targetFinanceCandidatePath:
                      teacherCandidateInputReconciliation.targetFinanceCandidatePath,
                    reconciliationMode: teacherCandidateInputReconciliation.reconciliationMode,
                    reconciliationNotes: teacherCandidateInputReconciliation.reconciliationNotes,
                    status: teacherCandidateInputReconciliation.status,
                  }
                : null,
              candidateInputReconciliationTarget:
                teacherCandidateInputReview?.reviewOutcome === "consumed_into_candidate_flow" &&
                !teacherCandidateInputReconciliation
                  ? {
                      tool: "finance_doctrine_teacher_feedback_candidate_input_reconciliation",
                      dateKey,
                      candidateInputId: teacherCandidateInput?.candidateInputId,
                      allowedModes: FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_MODES,
                    }
                  : null,
              candidateInputReconciliationStatusTarget:
                teacherCandidateInputReconciliation?.status === "open"
                  ? {
                      tool: "finance_doctrine_teacher_feedback_candidate_input_reconciliation_status",
                      dateKey,
                      reconciliationId: teacherCandidateInputReconciliation.reconciliationId,
                      allowedStatuses:
                        FINANCE_DOCTRINE_TEACHER_CANDIDATE_INPUT_RECONCILIATION_TARGET_STATUSES,
                    }
                  : null,
            };
          }) ?? [],
        candidateCount: candidates.length,
        bulkActionTarget: {
          tool: "finance_promotion_bulk_review",
          dateKey,
          allowedActions: FINANCE_PROMOTION_REVIEW_ACTIONS,
        },
        candidates,
      });
    },
  };
}
