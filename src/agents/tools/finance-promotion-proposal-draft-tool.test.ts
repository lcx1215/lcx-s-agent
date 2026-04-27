import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionDecisionsFilename,
  buildFeishuFinanceDoctrinePromotionProposalsFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  parseFeishuFinanceDoctrinePromotionProposalArtifact,
  renderFeishuFinanceDoctrinePromotionCandidateArtifact,
  renderFeishuFinanceDoctrinePromotionDecisionArtifact,
  renderFeishuFinanceDoctrinePromotionReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinancePromotionProposalDraftTool } from "./finance-promotion-proposal-draft-tool.js";

describe("finance_promotion_proposal_draft tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedPromotionDecision(dateKey: string, decisionOutcome = "proposal_created") {
    const receiptsDir = path.join(workspaceDir!, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: dateKey,
        totalCalibrationNotes: 3,
        candidates: [
          {
            candidateKey: "closest_scenario:base_case",
            signal: "closest_scenario",
            observedValue: "base_case",
            occurrences: 2,
            reviewState: "ready_for_manual_promotion",
            reviewNotes: "repeat pattern is stable enough for manual doctrine review",
            candidateText: "closest_scenario repeated base_case in 2/3 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionReviewArtifact({
        reviewedAt: "2026-03-25T18:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedCandidateArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
        reviews: [
          {
            candidateKey: "closest_scenario:base_case",
            reviewState: "ready_for_manual_promotion",
            reviewNotes: "repeat pattern is stable enough for manual doctrine review",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionDecisionArtifact({
        decidedAt: "2026-03-25T19:10:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedCandidateArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
        linkedReviewArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
        decisions: [
          {
            candidateKey: "closest_scenario:base_case",
            decisionOutcome: decisionOutcome as
              | "proposal_created"
              | "deferred_after_promotion_review"
              | "rejected_after_promotion_review",
            reviewStateAtDecision: "ready_for_manual_promotion",
            decisionNotes: "create a manual doctrine proposal draft for operator review",
          },
        ],
      }),
      "utf8",
    );
  }

  it("creates a durable proposal draft from a proposal_created decision", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-proposal-");
    const dateKey = "2026-03-25";
    await seedPromotionDecision(dateKey);

    const tool = createFinancePromotionProposalDraftTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-proposal-draft", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      candidateKey: "closest_scenario:base_case",
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
      proposalStatus: "draft",
      sourceDecisionArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      decisionPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      proposalPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      action:
        "This creates an operator-reviewable proposal draft only. It does not promote doctrine and does not update doctrine cards automatically.",
    });

    const parsedProposalArtifact = parseFeishuFinanceDoctrinePromotionProposalArtifact(
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
    expect(parsedProposalArtifact?.sourceDecisionArtifact).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
    );
    expect(parsedProposalArtifact?.proposals).toEqual([
      expect.objectContaining({
        proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
        candidateKey: "closest_scenario:base_case",
        status: "draft",
      }),
    ]);
  });

  it("fails closed when the source decision is not proposal_created", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-proposal-");
    const dateKey = "2026-03-25";
    await seedPromotionDecision(dateKey, "deferred_after_promotion_review");

    const tool = createFinancePromotionProposalDraftTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-proposal-draft-bad-decision", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "decision_not_proposal_created",
      dateKey,
      candidateKey: "closest_scenario:base_case",
      decisionOutcome: "deferred_after_promotion_review",
      decisionPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      action:
        "Only candidates whose same-day decision outcome is proposal_created can create a bounded proposal draft.",
    });
  });

  it("fails closed when the decision artifact links to the wrong candidate artifact", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-proposal-");
    const dateKey = "2026-03-25";
    await seedPromotionDecision(dateKey);
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionDecisionArtifact({
        decidedAt: "2026-03-25T19:10:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedCandidateArtifact:
          "memory/feishu-work-receipts/WRONG-feishu-finance-doctrine-promotion-candidates.md",
        linkedReviewArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
        decisions: [
          {
            candidateKey: "closest_scenario:base_case",
            decisionOutcome: "proposal_created",
            reviewStateAtDecision: "ready_for_manual_promotion",
            decisionNotes: "create a manual doctrine proposal draft for operator review",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionProposalDraftTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-proposal-draft-link-mismatch", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "decision_artifact_link_mismatch",
      dateKey,
      candidateKey: "closest_scenario:base_case",
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      decisionPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      action:
        "Repair the same-day decision artifact linkage before retrying finance_promotion_proposal_draft.",
    });
  });
});
