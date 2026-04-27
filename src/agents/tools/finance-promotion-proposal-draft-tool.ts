import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionDecisionsFilename,
  buildFeishuFinanceDoctrinePromotionProposalsFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  parseFeishuFinanceDoctrinePromotionCandidateArtifact,
  parseFeishuFinanceDoctrinePromotionDecisionArtifact,
  parseFeishuFinanceDoctrinePromotionProposalArtifact,
  parseFeishuFinanceDoctrinePromotionReviewArtifact,
  renderFeishuFinanceDoctrinePromotionProposalArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FinancePromotionProposalDraftSchema = Type.Object({
  dateKey: Type.String(),
  candidateKey: Type.String(),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

function buildProposalId(dateKey: string, candidateKey: string): string {
  const candidateSlug = candidateKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `finance-doctrine-proposal-${dateKey}-${candidateSlug || "candidate"}`;
}

export function createFinancePromotionProposalDraftTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Promotion Proposal Draft",
    name: "finance_promotion_proposal_draft",
    description:
      "Create or refresh a bounded operator-reviewable proposal draft for one same-day finance promotion candidate whose latest decision outcome is proposal_created. This writes a durable proposal artifact and does not promote doctrine automatically.",
    parameters: FinancePromotionProposalDraftSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const candidateKey = readStringParam(params, "candidateKey", { required: true });

      const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
      const candidateRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey),
      );
      const reviewRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey),
      );
      const decisionRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey),
      );
      const proposalRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey),
      );

      const candidateAbsPath = path.join(workspaceDir, candidateRelPath);
      const reviewAbsPath = path.join(workspaceDir, reviewRelPath);
      const decisionAbsPath = path.join(workspaceDir, decisionRelPath);
      const proposalAbsPath = path.join(workspaceDir, proposalRelPath);

      let candidateContent: string;
      try {
        candidateContent = await fs.readFile(candidateAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "candidate_artifact_missing",
            dateKey,
            candidateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            action:
              "Generate the same-day finance promotion candidates first before creating a proposal draft.",
          });
        }
        throw error;
      }
      const parsedCandidates =
        parseFeishuFinanceDoctrinePromotionCandidateArtifact(candidateContent);
      if (!parsedCandidates) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_artifact_malformed",
          dateKey,
          candidateKey,
          candidatePath: candidateRelPath.replace(/\\/gu, "/"),
          action:
            "Repair or archive the malformed finance promotion candidate artifact before retrying finance_promotion_proposal_draft.",
        });
      }
      const candidate = parsedCandidates.candidates.find(
        (entry) => entry.candidateKey === candidateKey,
      );
      if (!candidate) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_not_found",
          dateKey,
          candidateKey,
          candidatePath: candidateRelPath.replace(/\\/gu, "/"),
          availableCandidateKeys: parsedCandidates.candidates.map((entry) => entry.candidateKey),
          action:
            "Use finance_promotion_candidates with this dateKey to discover valid same-day candidateKey values before retrying finance_promotion_proposal_draft.",
        });
      }

      let reviewContent: string;
      try {
        reviewContent = await fs.readFile(reviewAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "review_artifact_missing",
            dateKey,
            candidateKey,
            reviewPath: reviewRelPath.replace(/\\/gu, "/"),
            action:
              "Record the same-day finance promotion review state first before creating a proposal draft.",
          });
        }
        throw error;
      }
      const parsedReview = parseFeishuFinanceDoctrinePromotionReviewArtifact(reviewContent);
      if (!parsedReview) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "review_artifact_malformed",
          dateKey,
          candidateKey,
          reviewPath: reviewRelPath.replace(/\\/gu, "/"),
          action:
            "Repair or archive the malformed finance promotion review artifact before retrying finance_promotion_proposal_draft.",
        });
      }
      if (parsedReview.linkedCandidateArtifact !== candidateRelPath.replace(/\\/gu, "/")) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "review_candidate_link_mismatch",
          dateKey,
          candidateKey,
          candidatePath: candidateRelPath.replace(/\\/gu, "/"),
          reviewPath: reviewRelPath.replace(/\\/gu, "/"),
          action:
            "Repair the same-day review artifact linkage before retrying finance_promotion_proposal_draft.",
        });
      }

      let decisionContent: string;
      try {
        decisionContent = await fs.readFile(decisionAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "decision_artifact_missing",
            dateKey,
            candidateKey,
            decisionPath: decisionRelPath.replace(/\\/gu, "/"),
            action:
              "Record a same-day finance promotion decision first before creating a proposal draft.",
          });
        }
        throw error;
      }
      const parsedDecisions = parseFeishuFinanceDoctrinePromotionDecisionArtifact(decisionContent);
      if (!parsedDecisions) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "decision_artifact_malformed",
          dateKey,
          candidateKey,
          decisionPath: decisionRelPath.replace(/\\/gu, "/"),
          action:
            "Repair or archive the malformed finance promotion decision artifact before retrying finance_promotion_proposal_draft.",
        });
      }
      if (
        parsedDecisions.linkedCandidateArtifact !== candidateRelPath.replace(/\\/gu, "/") ||
        parsedDecisions.linkedReviewArtifact !== reviewRelPath.replace(/\\/gu, "/")
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "decision_artifact_link_mismatch",
          dateKey,
          candidateKey,
          candidatePath: candidateRelPath.replace(/\\/gu, "/"),
          reviewPath: reviewRelPath.replace(/\\/gu, "/"),
          decisionPath: decisionRelPath.replace(/\\/gu, "/"),
          action:
            "Repair the same-day decision artifact linkage before retrying finance_promotion_proposal_draft.",
        });
      }
      const sourceDecision = parsedDecisions.decisions.find(
        (entry) => entry.candidateKey === candidateKey,
      );
      if (!sourceDecision) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "decision_not_found_for_candidate",
          dateKey,
          candidateKey,
          decisionPath: decisionRelPath.replace(/\\/gu, "/"),
          action:
            "Record a same-day finance promotion decision for this candidate before retrying finance_promotion_proposal_draft.",
        });
      }
      if (sourceDecision.decisionOutcome !== "proposal_created") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "decision_not_proposal_created",
          dateKey,
          candidateKey,
          decisionOutcome: sourceDecision.decisionOutcome,
          decisionPath: decisionRelPath.replace(/\\/gu, "/"),
          action:
            "Only candidates whose same-day decision outcome is proposal_created can create a bounded proposal draft.",
        });
      }

      let parsedProposals = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrinePromotionProposalArtifact>
        | undefined;
      try {
        parsedProposals = parseFeishuFinanceDoctrinePromotionProposalArtifact(
          await fs.readFile(proposalAbsPath, "utf8"),
        );
        if (!parsedProposals) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "proposal_artifact_malformed",
            dateKey,
            candidateKey,
            proposalPath: proposalRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance promotion proposal artifact before retrying finance_promotion_proposal_draft.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const proposalByKey = new Map(
        parsedProposals?.proposals.map((entry) => [entry.candidateKey, entry]) ?? [],
      );
      const existingProposal = proposalByKey.get(candidateKey);
      if (
        existingProposal &&
        existingProposal.status !== "draft" &&
        existingProposal.status !== "superseded"
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "proposal_status_locked",
          dateKey,
          candidateKey,
          proposalId: existingProposal.proposalId,
          proposalStatus: existingProposal.status,
          proposalPath: proposalRelPath.replace(/\\/gu, "/"),
          action:
            "Only draft or superseded proposal entries may be refreshed automatically. Review the existing proposal state first.",
        });
      }

      const reviewEntry = parsedReview.reviews.find((entry) => entry.candidateKey === candidateKey);
      const proposalId = existingProposal?.proposalId ?? buildProposalId(dateKey, candidateKey);
      const rationaleParts = [
        `Repeated ${candidate.signal}=${candidate.observedValue} in ${candidate.occurrences}/${parsedCandidates.totalCalibrationNotes} recent calibration notes within the ${parsedCandidates.windowDays}-day window ending ${parsedCandidates.windowEndDate}.`,
        `Candidate text: ${candidate.candidateText}`,
        reviewEntry?.reviewNotes ? `Review notes: ${reviewEntry.reviewNotes}` : undefined,
        sourceDecision.decisionNotes
          ? `Decision notes: ${sourceDecision.decisionNotes}`
          : undefined,
      ].filter(Boolean);

      proposalByKey.set(candidateKey, {
        proposalId,
        candidateKey,
        sourceCandidateText: candidate.candidateText,
        proposedDoctrineChange: `Draft a bounded manual doctrine update for ${parsedCandidates.consumer} covering recurring signal ${candidate.signal}=${candidate.observedValue}. Keep it consumer-specific until an operator manually edits doctrine text.`,
        rationaleFromCalibration: rationaleParts.join(" "),
        riskOrCounterargument: `${candidate.notEnoughForPromotion} This remains a proposal draft only and still needs operator review before any manual doctrine edit.`,
        operatorNextAction:
          "Review the proposal draft, manually edit doctrine text if it is strong enough, or reject/supersede the draft. No doctrine card has been changed.",
        status: "draft",
      });

      await fs.mkdir(receiptsDir, { recursive: true });
      await fs.writeFile(
        proposalAbsPath,
        renderFeishuFinanceDoctrinePromotionProposalArtifact({
          draftedAt: new Date().toISOString(),
          consumer: parsedProposals?.consumer ?? parsedCandidates.consumer,
          sourceDecisionArtifact:
            parsedProposals?.sourceDecisionArtifact ?? decisionRelPath.replace(/\\/gu, "/"),
          linkedCandidateArtifact:
            parsedProposals?.linkedCandidateArtifact ?? candidateRelPath.replace(/\\/gu, "/"),
          linkedReviewArtifact:
            parsedProposals?.linkedReviewArtifact ?? reviewRelPath.replace(/\\/gu, "/"),
          proposals: Array.from(proposalByKey.values()).toSorted((left, right) =>
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
        proposalId,
        proposalStatus: "draft",
        sourceDecisionArtifact: decisionRelPath.replace(/\\/gu, "/"),
        candidatePath: candidateRelPath.replace(/\\/gu, "/"),
        reviewPath: reviewRelPath.replace(/\\/gu, "/"),
        decisionPath: decisionRelPath.replace(/\\/gu, "/"),
        proposalPath: proposalRelPath.replace(/\\/gu, "/"),
        action:
          "This creates an operator-reviewable proposal draft only. It does not promote doctrine and does not update doctrine cards automatically.",
      });
    },
  };
}
