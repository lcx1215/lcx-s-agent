import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrinePromotionProposalsFilename,
  parseFeishuFinanceDoctrinePromotionProposalArtifact,
  renderFeishuFinanceDoctrinePromotionProposalArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_PROMOTION_PROPOSAL_TARGET_STATUSES = [
  "accepted_for_manual_edit",
  "rejected",
  "superseded",
] as const;

const FinancePromotionProposalStatusSchema = Type.Object({
  dateKey: Type.String(),
  proposalId: Type.String(),
  status: stringEnum(FINANCE_PROMOTION_PROPOSAL_TARGET_STATUSES),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

export function createFinancePromotionProposalStatusTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Promotion Proposal Status",
    name: "finance_promotion_proposal_status",
    description:
      "Record a bounded status action for one same-day finance promotion proposal draft by proposalId. This updates the durable proposal artifact only and does not promote doctrine automatically.",
    parameters: FinancePromotionProposalStatusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const proposalId = readStringParam(params, "proposalId", { required: true });
      const status = readStringParam(params, "status", { required: true }) as
        | (typeof FINANCE_PROMOTION_PROPOSAL_TARGET_STATUSES)[number]
        | undefined;
      if (!status || !FINANCE_PROMOTION_PROPOSAL_TARGET_STATUSES.includes(status)) {
        throw new ToolInputError(
          `status must be one of: ${FINANCE_PROMOTION_PROPOSAL_TARGET_STATUSES.join(", ")}`,
        );
      }

      const proposalRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey),
      );
      const proposalAbsPath = path.join(workspaceDir, proposalRelPath);

      let proposalContent: string;
      try {
        proposalContent = await fs.readFile(proposalAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "proposal_artifact_missing",
            dateKey,
            proposalId,
            proposalPath: proposalRelPath.replace(/\\/gu, "/"),
            action:
              "Create the same-day finance promotion proposal draft first before recording a proposal status action.",
          });
        }
        throw error;
      }

      const parsedProposals = parseFeishuFinanceDoctrinePromotionProposalArtifact(proposalContent);
      if (!parsedProposals) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "proposal_artifact_malformed",
          dateKey,
          proposalId,
          proposalPath: proposalRelPath.replace(/\\/gu, "/"),
          action:
            "Repair or archive the malformed finance promotion proposal artifact before retrying finance_promotion_proposal_status.",
        });
      }

      const targetProposal = parsedProposals.proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!targetProposal) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "proposal_not_found",
          dateKey,
          proposalId,
          proposalPath: proposalRelPath.replace(/\\/gu, "/"),
          availableProposalIds: parsedProposals.proposals.map((proposal) => proposal.proposalId),
          action:
            "Use finance_promotion_candidates with this dateKey to inspect the current proposal draft ids before retrying finance_promotion_proposal_status.",
        });
      }

      if (targetProposal.status !== "draft") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "invalid_proposal_status_transition",
          dateKey,
          proposalId,
          currentStatus: targetProposal.status,
          requestedStatus: status,
          proposalPath: proposalRelPath.replace(/\\/gu, "/"),
          action:
            "Only proposal drafts still in draft status can be marked accepted_for_manual_edit, rejected, or superseded.",
        });
      }

      const nextProposals = parsedProposals.proposals.map((proposal) =>
        proposal.proposalId === proposalId ? { ...proposal, status } : proposal,
      );

      await fs.writeFile(
        proposalAbsPath,
        renderFeishuFinanceDoctrinePromotionProposalArtifact({
          ...parsedProposals,
          proposals: nextProposals,
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        proposalId,
        candidateKey: targetProposal.candidateKey,
        previousStatus: targetProposal.status,
        proposalStatus: status,
        proposalPath: proposalRelPath.replace(/\\/gu, "/"),
        action:
          "This records proposal status only. It does not promote doctrine and does not update doctrine cards automatically.",
      });
    },
  };
}
