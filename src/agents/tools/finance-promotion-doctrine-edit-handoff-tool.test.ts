import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrineEditHandoffsFilename,
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionDecisionsFilename,
  buildFeishuFinanceDoctrinePromotionProposalsFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  parseFeishuFinanceDoctrineEditHandoffArtifact,
  renderFeishuFinanceDoctrinePromotionCandidateArtifact,
  renderFeishuFinanceDoctrinePromotionDecisionArtifact,
  renderFeishuFinanceDoctrinePromotionProposalArtifact,
  renderFeishuFinanceDoctrinePromotionReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinancePromotionDoctrineEditHandoffTool } from "./finance-promotion-doctrine-edit-handoff-tool.js";

describe("finance_promotion_doctrine_edit_handoff tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedAcceptedProposal(dateKey: string) {
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
        totalCalibrationNotes: 2,
        candidates: [
          {
            candidateKey: "closest_scenario:base_case",
            signal: "closest_scenario",
            observedValue: "base_case",
            occurrences: 2,
            reviewState: "ready_for_manual_promotion",
            reviewNotes: "repeat pattern is stable enough to consider manual promotion",
            candidateText: "closest_scenario repeated base_case in 2/2 recent calibration notes",
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
        linkedCandidateArtifact: `memory/feishu-work-receipts/${buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)}`,
        reviews: [
          {
            candidateKey: "closest_scenario:base_case",
            reviewState: "ready_for_manual_promotion",
            reviewNotes: "repeat pattern is stable enough to consider manual promotion",
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
        linkedCandidateArtifact: `memory/feishu-work-receipts/${buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)}`,
        linkedReviewArtifact: `memory/feishu-work-receipts/${buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey)}`,
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
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionProposalArtifact({
        draftedAt: "2026-03-25T20:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        sourceDecisionArtifact: `memory/feishu-work-receipts/${buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey)}`,
        linkedCandidateArtifact: `memory/feishu-work-receipts/${buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)}`,
        linkedReviewArtifact: `memory/feishu-work-receipts/${buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey)}`,
        proposals: [
          {
            proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
            candidateKey: "closest_scenario:base_case",
            sourceCandidateText:
              "closest_scenario repeated base_case in 2/2 recent calibration notes",
            proposedDoctrineChange:
              "Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.",
            rationaleFromCalibration:
              "Repeated closest_scenario=base_case in 2/2 recent calibration notes.",
            riskOrCounterargument:
              "Still needs operator review before doctrine wording is promoted.",
            operatorNextAction:
              "Review the proposal draft, manually edit doctrine text if it is strong enough, or reject/supersede the draft.",
            status: "accepted_for_manual_edit",
          },
        ],
      }),
      "utf8",
    );
  }

  it("creates a bounded doctrine-edit handoff for an accepted proposal", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-doctrine-edit-handoff-");
    const dateKey = "2026-03-25";
    await seedAcceptedProposal(dateKey);

    const tool = createFinancePromotionDoctrineEditHandoffTool({ workspaceDir });
    const result = await tool.execute("finance-doctrine-edit-handoff-create", {
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
      candidateKey: "closest_scenario:base_case",
      handoffId:
        "finance-doctrine-edit-handoff-2026-03-25-finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
      handoffStatus: "open",
      proposalPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      decisionPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      handoffPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-edit-handoffs.md",
      targetDoctrineOrCard: "memory/local-memory/holding-holdings-thesis-revalidation.md",
      action:
        "This creates an operator-facing doctrine-edit handoff only. It does not edit doctrine cards and does not promote doctrine automatically.",
    });

    const parsed = parseFeishuFinanceDoctrineEditHandoffArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineEditHandoffsFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsed?.handoffs).toEqual([
      expect.objectContaining({
        proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
        candidateKey: "closest_scenario:base_case",
        targetDoctrineOrCard: "memory/local-memory/holding-holdings-thesis-revalidation.md",
        status: "open",
      }),
    ]);
  });

  it("fails closed when the proposal is not accepted_for_manual_edit", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-doctrine-edit-handoff-");
    const dateKey = "2026-03-25";
    await seedAcceptedProposal(dateKey);
    const proposalPath = path.join(
      workspaceDir,
      "memory",
      "feishu-work-receipts",
      buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey),
    );
    await fs.writeFile(
      proposalPath,
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
              "closest_scenario repeated base_case in 2/2 recent calibration notes",
            proposedDoctrineChange:
              "Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.",
            rationaleFromCalibration:
              "Repeated closest_scenario=base_case in 2/2 recent calibration notes.",
            riskOrCounterargument:
              "Still needs operator review before doctrine wording is promoted.",
            operatorNextAction:
              "Review the proposal draft, manually edit doctrine text if it is strong enough, or reject/supersede the draft.",
            status: "draft",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionDoctrineEditHandoffTool({ workspaceDir });
    const result = await tool.execute("finance-doctrine-edit-handoff-invalid-status", {
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "proposal_not_accepted_for_manual_edit",
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
      proposalStatus: "draft",
      proposalPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      action:
        "Only finance promotion proposals already marked accepted_for_manual_edit can create a manual doctrine-edit handoff.",
    });
  });

  it("fails closed when the proposalId is unknown", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-doctrine-edit-handoff-");
    const dateKey = "2026-03-25";
    await seedAcceptedProposal(dateKey);

    const tool = createFinancePromotionDoctrineEditHandoffTool({ workspaceDir });
    const result = await tool.execute("finance-doctrine-edit-handoff-missing-proposal", {
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-unknown",
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
        "Use finance_promotion_candidates with this dateKey to inspect the current proposal ids before retrying finance_promotion_doctrine_edit_handoff.",
    });
  });

  it("fails closed when the linked decision artifact does not match the proposal links", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-doctrine-edit-handoff-");
    const dateKey = "2026-03-25";
    await seedAcceptedProposal(dateKey);
    const decisionPath = path.join(
      workspaceDir,
      "memory",
      "feishu-work-receipts",
      buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey),
    );
    await fs.writeFile(
      decisionPath,
      renderFeishuFinanceDoctrinePromotionDecisionArtifact({
        decidedAt: "2026-03-25T19:10:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedCandidateArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates-other.md",
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

    const tool = createFinancePromotionDoctrineEditHandoffTool({ workspaceDir });
    const result = await tool.execute("finance-doctrine-edit-handoff-link-mismatch", {
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "decision_artifact_link_mismatch",
      dateKey,
      proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
      candidateKey: "closest_scenario:base_case",
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      decisionPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      proposalPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      action:
        "Repair the linked decision artifact before retrying finance_promotion_doctrine_edit_handoff.",
    });
  });
});
