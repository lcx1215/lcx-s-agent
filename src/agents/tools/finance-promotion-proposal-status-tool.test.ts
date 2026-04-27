import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrinePromotionProposalsFilename,
  parseFeishuFinanceDoctrinePromotionProposalArtifact,
  renderFeishuFinanceDoctrinePromotionProposalArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinancePromotionProposalStatusTool } from "./finance-promotion-proposal-status-tool.js";

describe("finance_promotion_proposal_status tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedProposalArtifact(dateKey: string, status = "draft") {
    const receiptsDir = path.join(workspaceDir!, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionProposalArtifact({
        draftedAt: "2026-03-25T20:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        sourceDecisionArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
        linkedCandidateArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
        linkedReviewArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
        proposals: [
          {
            proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
            candidateKey: "closest_scenario:base_case",
            sourceCandidateText:
              "closest_scenario repeated base_case in 2/3 recent calibration notes",
            proposedDoctrineChange:
              "Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.",
            rationaleFromCalibration:
              "Repeated closest_scenario=base_case in 2/3 recent calibration notes.",
            riskOrCounterargument:
              "Still needs operator review before doctrine wording is promoted.",
            operatorNextAction:
              "Review the proposal draft, manually edit doctrine text if it is strong enough, or reject/supersede the draft.",
            status: status as "draft" | "accepted_for_manual_edit" | "rejected" | "superseded",
          },
        ],
      }),
      "utf8",
    );
  }

  it("records a bounded proposal status action for a draft", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-proposal-status-");
    const dateKey = "2026-03-25";
    await seedProposalArtifact(dateKey);

    const tool = createFinancePromotionProposalStatusTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-proposal-status", {
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
      status: "accepted_for_manual_edit",
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
      candidateKey: "closest_scenario:base_case",
      previousStatus: "draft",
      proposalStatus: "accepted_for_manual_edit",
      proposalPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      action:
        "This records proposal status only. It does not promote doctrine and does not update doctrine cards automatically.",
    });

    const parsed = parseFeishuFinanceDoctrinePromotionProposalArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsed?.proposals[0]?.status).toBe("accepted_for_manual_edit");
  });

  it("fails closed when the proposalId is unknown", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-proposal-status-");
    const dateKey = "2026-03-25";
    await seedProposalArtifact(dateKey);

    const tool = createFinancePromotionProposalStatusTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-proposal-status-missing", {
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-unknown",
      status: "rejected",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "proposal_not_found",
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-unknown",
      proposalPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      availableProposalIds: ["finance-doctrine-proposal-2026-03-25-closest-scenario-base-case"],
      action:
        "Use finance_promotion_candidates with this dateKey to inspect the current proposal draft ids before retrying finance_promotion_proposal_status.",
    });
  });

  it("fails closed on invalid transition from a non-draft proposal state", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-proposal-status-");
    const dateKey = "2026-03-25";
    await seedProposalArtifact(dateKey, "rejected");

    const tool = createFinancePromotionProposalStatusTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-proposal-status-invalid-transition", {
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
      status: "accepted_for_manual_edit",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "invalid_proposal_status_transition",
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
      currentStatus: "rejected",
      requestedStatus: "accepted_for_manual_edit",
      proposalPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      action:
        "Only proposal drafts still in draft status can be marked accepted_for_manual_edit, rejected, or superseded.",
    });
  });
});
