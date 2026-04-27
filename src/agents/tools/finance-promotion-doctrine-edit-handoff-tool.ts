import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrineEditHandoffsFilename,
  parseFeishuFinanceDoctrineEditHandoffArtifact,
  parseFeishuFinanceDoctrinePromotionCandidateArtifact,
  parseFeishuFinanceDoctrinePromotionDecisionArtifact,
  parseFeishuFinanceDoctrinePromotionProposalArtifact,
  parseFeishuFinanceDoctrinePromotionReviewArtifact,
  renderFeishuFinanceDoctrineEditHandoffArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const HOLDINGS_THESIS_REVALIDATION_DOCTRINE_CARD =
  "memory/local-memory/holding-holdings-thesis-revalidation.md";

const FinancePromotionDoctrineEditHandoffSchema = Type.Object({
  dateKey: Type.String(),
  proposalId: Type.String(),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

function buildHandoffId(dateKey: string, proposalId: string): string {
  const proposalSlug = proposalId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `finance-doctrine-edit-handoff-${dateKey}-${proposalSlug || "proposal"}`;
}

function resolveTargetDoctrineOrCard(consumer: string): string | undefined {
  switch (consumer) {
    case "holdings_thesis_revalidation":
      return HOLDINGS_THESIS_REVALIDATION_DOCTRINE_CARD;
    default:
      return undefined;
  }
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

export function createFinancePromotionDoctrineEditHandoffTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Doctrine Edit Handoff",
    name: "finance_promotion_doctrine_edit_handoff",
    description:
      "Create or refresh a bounded operator-facing doctrine-edit handoff for one same-day finance promotion proposal already marked accepted_for_manual_edit. This writes a durable handoff artifact and never edits doctrine cards automatically.",
    parameters: FinancePromotionDoctrineEditHandoffSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const proposalId = readStringParam(params, "proposalId", { required: true });

      const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
      const proposalRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          `${dateKey}-feishu-finance-doctrine-promotion-proposals.md`,
        )
        .replace(/\\/gu, "/");
      const proposalAbsPath = path.join(workspaceDir, proposalRelPath);

      const proposalContent = await readUtf8OrMissing(proposalAbsPath);
      if (proposalContent == null) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "proposal_artifact_missing",
          dateKey,
          proposalId,
          proposalPath: proposalRelPath,
          action:
            "Create or restore the same-day finance promotion proposal artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }

      const parsedProposals = parseFeishuFinanceDoctrinePromotionProposalArtifact(proposalContent);
      if (!parsedProposals) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "proposal_artifact_malformed",
          dateKey,
          proposalId,
          proposalPath: proposalRelPath,
          action:
            "Repair or archive the malformed finance promotion proposal artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }

      const proposal = parsedProposals.proposals.find((entry) => entry.proposalId === proposalId);
      if (!proposal) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "proposal_not_found",
          dateKey,
          proposalId,
          proposalPath: proposalRelPath,
          availableProposalIds: parsedProposals.proposals.map((entry) => entry.proposalId),
          action:
            "Use finance_promotion_candidates with this dateKey to inspect the current proposal ids before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }

      if (proposal.status !== "accepted_for_manual_edit") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "proposal_not_accepted_for_manual_edit",
          dateKey,
          proposalId,
          proposalStatus: proposal.status,
          proposalPath: proposalRelPath,
          action:
            "Only finance promotion proposals already marked accepted_for_manual_edit can create a manual doctrine-edit handoff.",
        });
      }

      const targetDoctrineOrCard = resolveTargetDoctrineOrCard(parsedProposals.consumer);
      if (!targetDoctrineOrCard) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "unsupported_doctrine_target",
          dateKey,
          proposalId,
          consumer: parsedProposals.consumer,
          proposalPath: proposalRelPath,
          action:
            "Add an explicit bounded doctrine/card target for this finance consumer before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }

      const candidateRelPath = parsedProposals.linkedCandidateArtifact;
      const reviewRelPath = parsedProposals.linkedReviewArtifact;
      const decisionRelPath = parsedProposals.sourceDecisionArtifact;
      const candidateAbsPath = path.join(workspaceDir, candidateRelPath);
      const reviewAbsPath = path.join(workspaceDir, reviewRelPath);
      const decisionAbsPath = path.join(workspaceDir, decisionRelPath);

      const candidateContent = await readUtf8OrMissing(candidateAbsPath);
      if (candidateContent == null) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_artifact_missing",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          candidatePath: candidateRelPath,
          proposalPath: proposalRelPath,
          action:
            "Restore the linked finance promotion candidate artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }
      const parsedCandidates =
        parseFeishuFinanceDoctrinePromotionCandidateArtifact(candidateContent);
      if (!parsedCandidates) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_artifact_malformed",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          candidatePath: candidateRelPath,
          proposalPath: proposalRelPath,
          action:
            "Repair or archive the malformed finance promotion candidate artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }
      const candidate = parsedCandidates.candidates.find(
        (entry) => entry.candidateKey === proposal.candidateKey,
      );
      if (!candidate) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_not_found",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          candidatePath: candidateRelPath,
          proposalPath: proposalRelPath,
          action:
            "Repair the proposal-to-candidate linkage before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }

      const reviewContent = await readUtf8OrMissing(reviewAbsPath);
      if (reviewContent == null) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "review_artifact_missing",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          reviewPath: reviewRelPath,
          proposalPath: proposalRelPath,
          action:
            "Restore the linked finance promotion review artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }
      const parsedReview = parseFeishuFinanceDoctrinePromotionReviewArtifact(reviewContent);
      if (!parsedReview) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "review_artifact_malformed",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          reviewPath: reviewRelPath,
          proposalPath: proposalRelPath,
          action:
            "Repair or archive the malformed finance promotion review artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }
      if (parsedReview.linkedCandidateArtifact !== candidateRelPath) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "review_artifact_link_mismatch",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          candidatePath: candidateRelPath,
          reviewPath: reviewRelPath,
          proposalPath: proposalRelPath,
          action:
            "Repair the linked review artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }
      const reviewEntry = parsedReview.reviews.find(
        (entry) => entry.candidateKey === proposal.candidateKey,
      );
      if (!reviewEntry) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "review_not_found_for_candidate",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          reviewPath: reviewRelPath,
          proposalPath: proposalRelPath,
          action:
            "Repair the proposal-to-review linkage before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }

      const decisionContent = await readUtf8OrMissing(decisionAbsPath);
      if (decisionContent == null) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "decision_artifact_missing",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          decisionPath: decisionRelPath,
          proposalPath: proposalRelPath,
          action:
            "Restore the linked finance promotion decision artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }
      const parsedDecisions = parseFeishuFinanceDoctrinePromotionDecisionArtifact(decisionContent);
      if (!parsedDecisions) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "decision_artifact_malformed",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          decisionPath: decisionRelPath,
          proposalPath: proposalRelPath,
          action:
            "Repair or archive the malformed finance promotion decision artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }
      if (
        parsedDecisions.linkedCandidateArtifact !== candidateRelPath ||
        parsedDecisions.linkedReviewArtifact !== reviewRelPath
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "decision_artifact_link_mismatch",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          candidatePath: candidateRelPath,
          reviewPath: reviewRelPath,
          decisionPath: decisionRelPath,
          proposalPath: proposalRelPath,
          action:
            "Repair the linked decision artifact before retrying finance_promotion_doctrine_edit_handoff.",
        });
      }
      const decisionEntry = parsedDecisions.decisions.find(
        (entry) => entry.candidateKey === proposal.candidateKey,
      );
      if (!decisionEntry || decisionEntry.decisionOutcome !== "proposal_created") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "decision_not_proposal_created",
          dateKey,
          proposalId,
          candidateKey: proposal.candidateKey,
          decisionPath: decisionRelPath,
          proposalPath: proposalRelPath,
          action:
            "Only proposal_created finance promotion decisions can produce a manual doctrine-edit handoff.",
        });
      }

      const handoffRelPath = path
        .join(
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineEditHandoffsFilename(dateKey),
        )
        .replace(/\\/gu, "/");
      const handoffAbsPath = path.join(workspaceDir, handoffRelPath);
      let parsedHandoffs = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineEditHandoffArtifact>
        | undefined;
      const handoffContent = await readUtf8OrMissing(handoffAbsPath);
      if (handoffContent != null) {
        parsedHandoffs = parseFeishuFinanceDoctrineEditHandoffArtifact(handoffContent);
        if (!parsedHandoffs) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "handoff_artifact_malformed",
            dateKey,
            proposalId,
            handoffPath: handoffRelPath,
            action:
              "Repair or archive the malformed finance doctrine-edit handoff artifact before retrying finance_promotion_doctrine_edit_handoff.",
          });
        }
      }

      const handoffByProposalId = new Map(
        parsedHandoffs?.handoffs.map((entry) => [entry.proposalId, entry]) ?? [],
      );
      const existingHandoff = handoffByProposalId.get(proposalId);
      if (
        existingHandoff &&
        existingHandoff.status !== "open" &&
        existingHandoff.status !== "superseded"
      ) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "handoff_status_locked",
          dateKey,
          proposalId,
          handoffId: existingHandoff.handoffId,
          handoffStatus: existingHandoff.status,
          handoffPath: handoffRelPath,
          action:
            "Only open or superseded doctrine-edit handoffs may be refreshed automatically. Review the existing handoff state first.",
        });
      }

      const handoffId = existingHandoff?.handoffId ?? buildHandoffId(dateKey, proposalId);
      const manualEditChecklist = [
        `Confirm the target doctrine/card path remains ${targetDoctrineOrCard}.`,
        `Manually review whether ${proposal.proposedDoctrineChange} is specific enough to edit doctrine text without broadening scope.`,
        "Preserve research-only and no auto-promotion semantics in any manual doctrine wording.",
        "Record the manual edit outcome separately after operator review instead of treating this handoff as doctrine mutation.",
      ].join(" ");

      handoffByProposalId.set(proposalId, {
        handoffId,
        proposalId,
        candidateKey: proposal.candidateKey,
        proposedDoctrineChange: proposal.proposedDoctrineChange,
        rationaleFromCalibration: proposal.rationaleFromCalibration,
        riskOrCounterargument: proposal.riskOrCounterargument,
        targetDoctrineOrCard,
        manualEditChecklist,
        operatorDecisionNeeded:
          "Decide whether to edit the target doctrine/card manually, reject the edit after review, or supersede this handoff with a better draft. No doctrine card has been changed yet.",
        status: "open",
      });

      await fs.mkdir(receiptsDir, { recursive: true });
      await fs.writeFile(
        handoffAbsPath,
        renderFeishuFinanceDoctrineEditHandoffArtifact({
          handedOffAt: new Date().toISOString(),
          consumer: parsedHandoffs?.consumer ?? parsedProposals.consumer,
          sourceProposalArtifact: parsedHandoffs?.sourceProposalArtifact ?? proposalRelPath,
          sourceDecisionArtifact: parsedHandoffs?.sourceDecisionArtifact ?? decisionRelPath,
          linkedCandidateArtifact: parsedHandoffs?.linkedCandidateArtifact ?? candidateRelPath,
          linkedReviewArtifact: parsedHandoffs?.linkedReviewArtifact ?? reviewRelPath,
          handoffs: Array.from(handoffByProposalId.values()).toSorted((left, right) =>
            left.candidateKey.localeCompare(right.candidateKey),
          ),
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        proposalId,
        candidateKey: proposal.candidateKey,
        handoffId,
        handoffStatus: "open",
        proposalPath: proposalRelPath,
        decisionPath: decisionRelPath,
        candidatePath: candidateRelPath,
        reviewPath: reviewRelPath,
        handoffPath: handoffRelPath,
        targetDoctrineOrCard,
        action:
          "This creates an operator-facing doctrine-edit handoff only. It does not edit doctrine cards and does not promote doctrine automatically.",
      });
    },
  };
}
