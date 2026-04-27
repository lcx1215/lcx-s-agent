import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputsFilename,
  buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename,
  buildFeishuFinanceDoctrineTeacherFeedbackFilename,
  buildFeishuFinanceDoctrineTeacherReviewFilename,
  buildFeishuFinanceDoctrineEditHandoffsFilename,
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionDecisionsFilename,
  buildFeishuFinanceDoctrinePromotionProposalsFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  renderFeishuFinanceDoctrineTeacherCandidateInputArtifact,
  renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
  renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
  renderFeishuFinanceDoctrineTeacherReviewArtifact,
  renderFeishuFinanceDoctrinePromotionCandidateArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinancePromotionCandidatesTool } from "./finance-promotion-candidates-tool.js";
import { createFinancePromotionDecisionTool } from "./finance-promotion-decision-tool.js";
import { createFinancePromotionProposalDraftTool } from "./finance-promotion-proposal-draft-tool.js";
import { createFinancePromotionReviewTool } from "./finance-promotion-review-tool.js";

describe("finance_promotion_candidates tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("lists same-day unreviewed finance promotion candidates with exact candidate keys", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
        totalCalibrationNotes: 3,
        candidates: [
          {
            candidateKey: "closest_scenario:base_case",
            signal: "closest_scenario",
            observedValue: "base_case",
            occurrences: 2,
            reviewState: "unreviewed",
            candidateText: "closest_scenario repeated base_case in 2/3 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
          },
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 2,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 2/3 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-list", { dateKey });
    const details = result.details as {
      ok: boolean;
      dateKey: string;
      stateSource: string;
      candidateCount: number;
      bulkActionTarget: {
        tool: string;
        dateKey: string;
        allowedActions: string[];
      };
      candidates: Array<{
        candidateKey: string;
        candidateText: string;
        reviewState: string;
        reviewNotes: string | null;
        actionTarget: {
          tool: string;
          dateKey: string;
          candidateKey: string;
          allowedActions: string[];
        };
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.dateKey).toBe(dateKey);
    expect(details.stateSource).toBe("candidate_artifact_only");
    expect(details.candidateCount).toBe(2);
    expect(details.bulkActionTarget).toEqual({
      tool: "finance_promotion_bulk_review",
      dateKey,
      allowedActions: ["deferred", "rejected", "ready_for_manual_promotion"],
    });
    expect(details.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "closest_scenario:base_case",
          candidateText: "closest_scenario repeated base_case in 2/3 recent calibration notes",
          reviewState: "unreviewed",
          reviewNotes: null,
          actionTarget: {
            tool: "finance_promotion_review",
            dateKey,
            candidateKey: "closest_scenario:base_case",
            allowedActions: ["deferred", "rejected", "ready_for_manual_promotion"],
          },
        }),
      ]),
    );
  });

  it("shows reviewed state written by the finance_promotion_review action seam", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
        totalCalibrationNotes: 2,
        candidates: [
          {
            candidateKey: "closest_scenario:base_case",
            signal: "closest_scenario",
            observedValue: "base_case",
            occurrences: 2,
            reviewState: "unreviewed",
            candidateText: "closest_scenario repeated base_case in 2/2 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
          },
        ],
      }),
      "utf8",
    );

    const reviewTool = createFinancePromotionReviewTool({ workspaceDir });
    await reviewTool.execute("finance-promotion-review", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
      action: "ready_for_manual_promotion",
      reviewNotes: "repeat pattern is stable enough to consider manual promotion",
    });

    const listTool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await listTool.execute("finance-promotion-candidates-reviewed", { dateKey });
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      reviewPath: string | null;
      candidates: Array<{
        candidateKey: string;
        reviewState: string;
        reviewNotes: string | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe("candidate_artifact_plus_review_artifact");
    expect(details.reviewPath).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
    );
    expect(details.candidates).toEqual([
      {
        candidateKey: "closest_scenario:base_case",
        candidateText: "closest_scenario repeated base_case in 2/2 recent calibration notes",
        signal: "closest_scenario",
        observedValue: "base_case",
        occurrences: 2,
        reviewState: "ready_for_manual_promotion",
        reviewNotes: "repeat pattern is stable enough to consider manual promotion",
        promotionDecision: null,
        doctrineEditHandoff: null,
        actionTarget: {
          tool: "finance_promotion_review",
          dateKey,
          candidateKey: "closest_scenario:base_case",
          allowedActions: ["deferred", "rejected", "ready_for_manual_promotion"],
        },
        promotionDecisionTarget: {
          tool: "finance_promotion_decision",
          dateKey,
          candidateKey: "closest_scenario:base_case",
          allowedDecisions: [
            "proposal_created",
            "deferred_after_promotion_review",
            "rejected_after_promotion_review",
          ],
        },
        proposalDraft: null,
        proposalDraftTarget: null,
        proposalStatusTarget: null,
        doctrineEditHandoffTarget: null,
      },
    ]);
  });

  it("shows same-day promotion decisions written after a ready_for_manual_promotion review state", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
        totalCalibrationNotes: 2,
        candidates: [
          {
            candidateKey: "closest_scenario:base_case",
            signal: "closest_scenario",
            observedValue: "base_case",
            occurrences: 2,
            reviewState: "unreviewed",
            candidateText: "closest_scenario repeated base_case in 2/2 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
          },
        ],
      }),
      "utf8",
    );

    const reviewTool = createFinancePromotionReviewTool({ workspaceDir });
    await reviewTool.execute("finance-promotion-review", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
      action: "ready_for_manual_promotion",
      reviewNotes: "repeat pattern is stable enough to consider manual promotion",
    });

    const decisionTool = createFinancePromotionDecisionTool({ workspaceDir });
    await decisionTool.execute("finance-promotion-decision", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
      decision: "proposal_created",
      decisionNotes: "create a manual doctrine proposal draft for operator review",
    });

    const listTool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await listTool.execute("finance-promotion-candidates-decided", { dateKey });
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      decisionPath: string | null;
      candidates: Array<{
        candidateKey: string;
        reviewState: string;
        promotionDecision: {
          decisionOutcome: string;
          reviewStateAtDecision: string;
          decisionNotes: string | null;
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe("candidate_review_and_decision_artifacts");
    expect(details.decisionPath).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
    );
    expect(details.candidates).toEqual([
      {
        candidateKey: "closest_scenario:base_case",
        candidateText: "closest_scenario repeated base_case in 2/2 recent calibration notes",
        signal: "closest_scenario",
        observedValue: "base_case",
        occurrences: 2,
        reviewState: "ready_for_manual_promotion",
        reviewNotes: "repeat pattern is stable enough to consider manual promotion",
        promotionDecision: {
          decisionOutcome: "proposal_created",
          reviewStateAtDecision: "ready_for_manual_promotion",
          decisionNotes: "create a manual doctrine proposal draft for operator review",
        },
        doctrineEditHandoff: null,
        actionTarget: {
          tool: "finance_promotion_review",
          dateKey,
          candidateKey: "closest_scenario:base_case",
          allowedActions: ["deferred", "rejected", "ready_for_manual_promotion"],
        },
        promotionDecisionTarget: {
          tool: "finance_promotion_decision",
          dateKey,
          candidateKey: "closest_scenario:base_case",
          allowedDecisions: [
            "proposal_created",
            "deferred_after_promotion_review",
            "rejected_after_promotion_review",
          ],
        },
        proposalDraft: null,
        proposalDraftTarget: {
          tool: "finance_promotion_proposal_draft",
          dateKey,
          candidateKey: "closest_scenario:base_case",
        },
        proposalStatusTarget: null,
        doctrineEditHandoffTarget: null,
      },
    ]);
  });

  it("shows same-day proposal drafts linked to proposal_created decisions", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
        totalCalibrationNotes: 2,
        candidates: [
          {
            candidateKey: "closest_scenario:base_case",
            signal: "closest_scenario",
            observedValue: "base_case",
            occurrences: 2,
            reviewState: "unreviewed",
            candidateText: "closest_scenario repeated base_case in 2/2 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );

    const reviewTool = createFinancePromotionReviewTool({ workspaceDir });
    await reviewTool.execute("finance-promotion-review", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
      action: "ready_for_manual_promotion",
      reviewNotes: "repeat pattern is stable enough to consider manual promotion",
    });

    const decisionTool = createFinancePromotionDecisionTool({ workspaceDir });
    await decisionTool.execute("finance-promotion-decision", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
      decision: "proposal_created",
      decisionNotes: "create a manual doctrine proposal draft for operator review",
    });

    const proposalTool = createFinancePromotionProposalDraftTool({ workspaceDir });
    await proposalTool.execute("finance-promotion-proposal-draft", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
    });

    const listTool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await listTool.execute("finance-promotion-candidates-proposal", { dateKey });
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      proposalPath: string | null;
      candidates: Array<{
        candidateKey: string;
        proposalDraft: {
          proposalId: string;
          sourceDecisionArtifact: string;
          status: string;
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe("candidate_review_decision_and_proposal_artifacts");
    expect(details.proposalPath).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
    );
    expect(details.candidates).toEqual([
      {
        candidateKey: "closest_scenario:base_case",
        candidateText: "closest_scenario repeated base_case in 2/2 recent calibration notes",
        signal: "closest_scenario",
        observedValue: "base_case",
        occurrences: 2,
        reviewState: "ready_for_manual_promotion",
        reviewNotes: "repeat pattern is stable enough to consider manual promotion",
        promotionDecision: {
          decisionOutcome: "proposal_created",
          reviewStateAtDecision: "ready_for_manual_promotion",
          decisionNotes: "create a manual doctrine proposal draft for operator review",
        },
        proposalDraft: {
          proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
          sourceDecisionArtifact:
            "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
          status: "draft",
        },
        doctrineEditHandoff: null,
        actionTarget: {
          tool: "finance_promotion_review",
          dateKey,
          candidateKey: "closest_scenario:base_case",
          allowedActions: ["deferred", "rejected", "ready_for_manual_promotion"],
        },
        promotionDecisionTarget: {
          tool: "finance_promotion_decision",
          dateKey,
          candidateKey: "closest_scenario:base_case",
          allowedDecisions: [
            "proposal_created",
            "deferred_after_promotion_review",
            "rejected_after_promotion_review",
          ],
        },
        proposalDraftTarget: {
          tool: "finance_promotion_proposal_draft",
          dateKey,
          candidateKey: "closest_scenario:base_case",
        },
        proposalStatusTarget: {
          tool: "finance_promotion_proposal_status",
          dateKey,
          proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
          allowedStatuses: ["accepted_for_manual_edit", "rejected", "superseded"],
        },
        doctrineEditHandoffTarget: null,
      },
    ]);
  });

  it("shows non-draft proposal status without offering another status action target", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
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
      "# Feishu Finance Doctrine Promotion Review\n\n- **Reviewed At**: 2026-03-25T18:00:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n\n## Reviews\n### Review 1\n- **Candidate Key**: closest_scenario:base_case\n- **Review State**: ready_for_manual_promotion\n- **Review Notes**: repeat pattern is stable enough to consider manual promotion\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey)),
      "# Feishu Finance Doctrine Promotion Decisions\n\n- **Decided At**: 2026-03-25T19:10:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n- **Linked Review Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md\n\n## Decisions\n### Decision 1\n- **Candidate Key**: closest_scenario:base_case\n- **Decision Outcome**: proposal_created\n- **Review State At Decision**: ready_for_manual_promotion\n- **Decision Notes**: create a manual doctrine proposal draft for operator review\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey)),
      "# Feishu Finance Doctrine Promotion Proposals\n\n- **Drafted At**: 2026-03-25T20:00:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Source Decision Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n- **Linked Review Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md\n\n## Proposals\n### Proposal 1\n- **Proposal ID**: finance-doctrine-proposal-2026-03-25-closest-scenario-base-case\n- **Candidate Key**: closest_scenario:base_case\n- **Source Candidate Text**: closest_scenario repeated base_case in 2/2 recent calibration notes\n- **Proposed Doctrine Change**: Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.\n- **Rationale From Calibration**: Repeated closest_scenario=base_case in 2/2 recent calibration notes.\n- **Risk Or Counterargument**: Still needs operator review before doctrine wording is promoted.\n- **Operator Next Action**: Review the proposal draft, manually edit doctrine text if it is strong enough, or reject/supersede the draft.\n- **Status**: accepted_for_manual_edit\n",
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-non-draft-proposal", {
      dateKey,
    });
    const details = result.details as {
      ok: boolean;
      candidates: Array<{
        candidateKey: string;
        proposalDraft: { status: string } | null;
        proposalStatusTarget: unknown;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.candidates).toEqual([
      expect.objectContaining({
        candidateKey: "closest_scenario:base_case",
        proposalDraft: expect.objectContaining({
          status: "accepted_for_manual_edit",
        }),
        proposalStatusTarget: null,
      }),
    ]);
  });

  it("shows doctrine-edit handoff visibility for accepted proposals", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
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
      "# Feishu Finance Doctrine Promotion Review\n\n- **Reviewed At**: 2026-03-25T18:00:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n\n## Reviews\n### Review 1\n- **Candidate Key**: closest_scenario:base_case\n- **Review State**: ready_for_manual_promotion\n- **Review Notes**: repeat pattern is stable enough to consider manual promotion\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey)),
      "# Feishu Finance Doctrine Promotion Decisions\n\n- **Decided At**: 2026-03-25T19:10:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n- **Linked Review Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md\n\n## Decisions\n### Decision 1\n- **Candidate Key**: closest_scenario:base_case\n- **Decision Outcome**: proposal_created\n- **Review State At Decision**: ready_for_manual_promotion\n- **Decision Notes**: create a manual doctrine proposal draft for operator review\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey)),
      "# Feishu Finance Doctrine Promotion Proposals\n\n- **Drafted At**: 2026-03-25T20:00:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Source Decision Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n- **Linked Review Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md\n\n## Proposals\n### Proposal 1\n- **Proposal ID**: finance-doctrine-proposal-2026-03-25-closest-scenario-base-case\n- **Candidate Key**: closest_scenario:base_case\n- **Source Candidate Text**: closest_scenario repeated base_case in 2/2 recent calibration notes\n- **Proposed Doctrine Change**: Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.\n- **Rationale From Calibration**: Repeated closest_scenario=base_case in 2/2 recent calibration notes.\n- **Risk Or Counterargument**: Still needs operator review before doctrine wording is promoted.\n- **Operator Next Action**: Review the proposal draft, manually edit doctrine text if it is strong enough, or reject/supersede the draft.\n- **Status**: accepted_for_manual_edit\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineEditHandoffsFilename(dateKey)),
      "# Feishu Finance Doctrine Edit Handoffs\n\n- **Handed Off At**: 2026-03-25T21:00:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Source Proposal Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md\n- **Source Decision Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n- **Linked Review Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md\n\n## Handoffs\n### Handoff 1\n- **Handoff ID**: finance-doctrine-edit-handoff-2026-03-25-finance-doctrine-proposal-2026-03-25-closest-scenario-base-case\n- **Proposal ID**: finance-doctrine-proposal-2026-03-25-closest-scenario-base-case\n- **Candidate Key**: closest_scenario:base_case\n- **Proposed Doctrine Change**: Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.\n- **Rationale From Calibration**: Repeated closest_scenario=base_case in 2/2 recent calibration notes.\n- **Risk Or Counterargument**: Still needs operator review before doctrine wording is promoted.\n- **Target Doctrine Or Card**: memory/local-memory/holding-holdings-thesis-revalidation.md\n- **Manual Edit Checklist**: Confirm the target doctrine/card path remains memory/local-memory/holding-holdings-thesis-revalidation.md.\n- **Operator Decision Needed**: Decide whether to edit the target doctrine/card manually, reject the edit after review, or supersede this handoff with a better draft.\n- **Status**: open\n",
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-handoff-visibility", {
      dateKey,
    });
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      handoffPath: string | null;
      candidates: Array<{
        candidateKey: string;
        doctrineEditHandoff: {
          handoffId: string;
          sourceProposalArtifact: string;
          targetDoctrineOrCard: string;
          status: string;
        } | null;
        doctrineEditHandoffTarget: unknown;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe("candidate_review_decision_proposal_and_handoff_artifacts");
    expect(details.handoffPath).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-edit-handoffs.md",
    );
    expect(details.candidates).toEqual([
      expect.objectContaining({
        candidateKey: "closest_scenario:base_case",
        doctrineEditHandoff: {
          handoffId:
            "finance-doctrine-edit-handoff-2026-03-25-finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
          sourceProposalArtifact:
            "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
          targetDoctrineOrCard: "memory/local-memory/holding-holdings-thesis-revalidation.md",
          status: "open",
        },
        doctrineEditHandoffTarget: null,
      }),
    ]);
  });

  it("shows same-day teacher feedback as candidate evidence in inspection", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
        totalCalibrationNotes: 2,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 2,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 2/2 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      "# Feishu Finance Doctrine Teacher Feedback\n\n- **Generated At**: 2026-03-25T21:30:00.000Z\n- **Teacher Task**: finance_calibration_audit\n\n## Feedback\n### Feedback 1\n- **Feedback ID**: finance-teacher-feedback-2026-03-25-feishu-finance-doctrine-calibration-190000-000z-control-room-msg-1-overconfident_conviction\n- **Source Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md\n- **Teacher Model**: openai/gpt-5.2\n- **Critique Type**: overconfident_conviction\n- **Critique Text**: The calibration artifact admits conviction looked too high but never names the earlier de-risk trigger.\n- **Suggested Candidate Text**: teacher critique: holdings_thesis_revalidation calibration repeatedly flags conviction as too high without a concrete earlier-de-risk trigger\n- **Evidence Needed**: Need repeated later calibration notes showing the same missing trigger degrades decision quality.\n- **Risk Of Adopting**: Could hard-code de-risking language too early and reduce flexibility in ambiguous regimes.\n- **Recommended Next Action**: Inspect adjacent calibration artifacts and only promote this critique if the missing trigger repeats.\n",
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-teacher-feedback", {
      dateKey,
    });
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      teacherFeedbackPath: string | null;
      teacherReviewPath: string | null;
      teacherElevationHandoffPath: string | null;
      teacherCandidateInputPath: string | null;
      teacherFeedback: Array<{
        feedbackId: string;
        sourceArtifact: string;
        teacherModel: string;
        critiqueType: string;
        critiqueText: string;
        suggestedCandidateText: string;
        evidenceNeeded: string;
        riskOfAdopting: string;
        recommendedNextAction: string;
        reviewOutcome: string | null;
        reviewTarget: {
          tool: string;
          dateKey: string;
          feedbackId: string;
          allowedOutcomes: string[];
        } | null;
        elevationHandoff: {
          handoffId: string;
          targetGovernancePath: string;
          status: string;
        } | null;
        elevationHandoffTarget: {
          tool: string;
          dateKey: string;
          feedbackId: string;
        } | null;
        candidateInput: {
          candidateInputId: string;
          sourceTeacherElevationHandoffArtifact: string;
          targetGovernancePath: string;
        } | null;
        candidateInputTarget: {
          tool: string;
          dateKey: string;
          handoffId: string;
        } | null;
        candidateInputReview: {
          reviewOutcome: string;
          sourceTeacherCandidateInputArtifact: string;
        } | null;
        candidateInputReviewTarget: {
          tool: string;
          dateKey: string;
          candidateInputId: string;
          allowedOutcomes: string[];
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe(
      "candidate_review_decision_proposal_handoff_and_teacher_feedback_artifacts",
    );
    expect(details.teacherFeedbackPath).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-teacher-feedback.md",
    );
    expect(details.teacherReviewPath).toBeNull();
    expect(details.teacherElevationHandoffPath).toBeNull();
    expect(details.teacherCandidateInputPath).toBeNull();
    expect(details.teacherFeedback).toEqual([
      {
        feedbackId:
          "finance-teacher-feedback-2026-03-25-feishu-finance-doctrine-calibration-190000-000z-control-room-msg-1-overconfident_conviction",
        sourceArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
        teacherModel: "openai/gpt-5.2",
        critiqueType: "overconfident_conviction",
        critiqueText:
          "The calibration artifact admits conviction looked too high but never names the earlier de-risk trigger.",
        suggestedCandidateText:
          "teacher critique: holdings_thesis_revalidation calibration repeatedly flags conviction as too high without a concrete earlier-de-risk trigger",
        evidenceNeeded:
          "Need repeated later calibration notes showing the same missing trigger degrades decision quality.",
        riskOfAdopting:
          "Could hard-code de-risking language too early and reduce flexibility in ambiguous regimes.",
        recommendedNextAction:
          "Inspect adjacent calibration artifacts and only promote this critique if the missing trigger repeats.",
        reviewOutcome: null,
        reviewTarget: {
          tool: "finance_doctrine_teacher_feedback_review",
          dateKey,
          feedbackId:
            "finance-teacher-feedback-2026-03-25-feishu-finance-doctrine-calibration-190000-000z-control-room-msg-1-overconfident_conviction",
          allowedOutcomes: ["deferred", "rejected", "elevated_for_governance_review"],
        },
        elevationHandoff: null,
        elevationHandoffTarget: null,
        elevationHandoffStatusTarget: null,
        candidateInput: null,
        candidateInputTarget: null,
        candidateInputReview: null,
        candidateInputReviewTarget: null,
        candidateInputReconciliation: null,
        candidateInputReconciliationTarget: null,
        candidateInputReconciliationStatusTarget: null,
      },
    ]);
  });

  it("shows retained teacher review state and pending teacher critiques in inspection", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-04-16T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-04-10",
        windowEndDate: "2026-04-16",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-04-16T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: missing_causal_chain
- **Critique Text**: The calibration artifact omits the rates-to-index causal chain.
- **Suggested Candidate Text**: teacher critique: make the rates-to-index transmission explicit before leaning on conviction
- **Evidence Needed**: Need repeated calibration artifacts showing the same omitted chain weakens later review quality.
- **Risk Of Adopting**: Could overcorrect into boilerplate macro narration.
- **Recommended Next Action**: Check adjacent calibration artifacts before promotion.

### Feedback 2
- **Feedback ID**: feedback-2
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-191500-000Z-control-room-msg-2.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: weak_risk_gate
- **Critique Text**: The calibration artifact never names the risk gate that would block action.
- **Suggested Candidate Text**: teacher critique: force an explicit risk gate before treating no-action discipline as sufficient
- **Evidence Needed**: Need repeated evidence that missing risk gates degrade later doctrine review quality.
- **Risk Of Adopting**: Could hard-code risk language too broadly.
- **Recommended Next Action**: Compare with adjacent risk-sensitive receipts before governance review.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
            reviewOutcome: "elevated_for_governance_review",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-teacher-review", {
      dateKey,
    });
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      teacherFeedbackPath: string | null;
      teacherReviewPath: string | null;
      teacherElevationHandoffPath: string | null;
      teacherCandidateInputPath: string | null;
      teacherFeedback: Array<{
        feedbackId: string;
        sourceArtifact: string;
        teacherModel: string;
        critiqueType: string;
        critiqueText: string;
        suggestedCandidateText: string;
        evidenceNeeded: string;
        riskOfAdopting: string;
        recommendedNextAction: string;
        reviewOutcome: string | null;
        reviewTarget: {
          tool: string;
          dateKey: string;
          feedbackId: string;
          allowedOutcomes: string[];
        } | null;
        elevationHandoff: {
          handoffId: string;
          targetGovernancePath: string;
          status: string;
        } | null;
        elevationHandoffTarget: {
          tool: string;
          dateKey: string;
          feedbackId: string;
        } | null;
        candidateInput: {
          candidateInputId: string;
          sourceTeacherElevationHandoffArtifact: string;
          targetGovernancePath: string;
        } | null;
        candidateInputTarget: {
          tool: string;
          dateKey: string;
          handoffId: string;
        } | null;
        candidateInputReview: {
          reviewOutcome: string;
          sourceTeacherCandidateInputArtifact: string;
        } | null;
        candidateInputReviewTarget: {
          tool: string;
          dateKey: string;
          candidateInputId: string;
          allowedOutcomes: string[];
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe(
      "candidate_review_decision_proposal_handoff_teacher_feedback_and_teacher_review_artifacts",
    );
    expect(details.teacherFeedbackPath).toBe(
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
    );
    expect(details.teacherReviewPath).toBe(
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
    );
    expect(details.teacherElevationHandoffPath).toBeNull();
    expect(details.teacherCandidateInputPath).toBeNull();
    expect(details.teacherFeedback).toEqual([
      {
        feedbackId: "feedback-1",
        sourceArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
        teacherModel: "openai/gpt-5.2",
        critiqueType: "missing_causal_chain",
        critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
        suggestedCandidateText:
          "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
        evidenceNeeded:
          "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
        riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
        recommendedNextAction: "Check adjacent calibration artifacts before promotion.",
        reviewOutcome: "elevated_for_governance_review",
        reviewTarget: null,
        elevationHandoff: null,
        elevationHandoffTarget: {
          tool: "finance_doctrine_teacher_feedback_elevation_handoff",
          dateKey,
          feedbackId: "feedback-1",
        },
        elevationHandoffStatusTarget: null,
        candidateInput: null,
        candidateInputTarget: null,
        candidateInputReview: null,
        candidateInputReviewTarget: null,
        candidateInputReconciliation: null,
        candidateInputReconciliationTarget: null,
        candidateInputReconciliationStatusTarget: null,
      },
      {
        feedbackId: "feedback-2",
        sourceArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-191500-000Z-control-room-msg-2.md",
        teacherModel: "openai/gpt-5.2",
        critiqueType: "weak_risk_gate",
        critiqueText: "The calibration artifact never names the risk gate that would block action.",
        suggestedCandidateText:
          "teacher critique: force an explicit risk gate before treating no-action discipline as sufficient",
        evidenceNeeded:
          "Need repeated evidence that missing risk gates degrade later doctrine review quality.",
        riskOfAdopting: "Could hard-code risk language too broadly.",
        recommendedNextAction:
          "Compare with adjacent risk-sensitive receipts before governance review.",
        reviewOutcome: null,
        reviewTarget: {
          tool: "finance_doctrine_teacher_feedback_review",
          dateKey,
          feedbackId: "feedback-2",
          allowedOutcomes: ["deferred", "rejected", "elevated_for_governance_review"],
        },
        elevationHandoff: null,
        elevationHandoffTarget: null,
        elevationHandoffStatusTarget: null,
        candidateInput: null,
        candidateInputTarget: null,
        candidateInputReview: null,
        candidateInputReviewTarget: null,
        candidateInputReconciliation: null,
        candidateInputReconciliationTarget: null,
        candidateInputReconciliationStatusTarget: null,
      },
    ]);
  });

  it("shows teacher elevation handoffs for elevated teacher critiques in inspection", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-04-16T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-04-10",
        windowEndDate: "2026-04-16",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-04-16T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: missing_causal_chain
- **Critique Text**: The calibration artifact omits the rates-to-index causal chain.
- **Suggested Candidate Text**: teacher critique: make the rates-to-index transmission explicit before leaning on conviction
- **Evidence Needed**: Need repeated calibration artifacts showing the same omitted chain weakens later review quality.
- **Risk Of Adopting**: Could overcorrect into boilerplate macro narration.
- **Recommended Next Action**: Check adjacent calibration artifacts before promotion.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
            reviewOutcome: "elevated_for_governance_review",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
        handedOffAt: "2026-04-16T22:30:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        handoffs: [
          {
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.",
            status: "open",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-teacher-elevation-handoff", {
      dateKey,
    });
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      teacherElevationHandoffPath: string | null;
      teacherCandidateInputPath: string | null;
      teacherFeedback: Array<{
        feedbackId: string;
        elevationHandoff: {
          handoffId: string;
          targetGovernancePath: string;
          status: string;
        } | null;
        elevationHandoffTarget: {
          tool: string;
          dateKey: string;
          feedbackId: string;
        } | null;
        elevationHandoffStatusTarget: {
          tool: string;
          dateKey: string;
          handoffId: string;
          allowedStatuses: string[];
        } | null;
        candidateInput: {
          candidateInputId: string;
          sourceTeacherElevationHandoffArtifact: string;
          targetGovernancePath: string;
        } | null;
        candidateInputTarget: {
          tool: string;
          dateKey: string;
          handoffId: string;
        } | null;
        candidateInputReview: {
          reviewOutcome: string;
          sourceTeacherCandidateInputArtifact: string;
        } | null;
        candidateInputReviewTarget: {
          tool: string;
          dateKey: string;
          candidateInputId: string;
          allowedOutcomes: string[];
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe(
      "candidate_review_decision_proposal_handoff_teacher_feedback_teacher_review_and_teacher_elevation_handoff_artifacts",
    );
    expect(details.teacherElevationHandoffPath).toBe(
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
    );
    expect(details.teacherCandidateInputPath).toBeNull();
    expect(details.teacherFeedback).toEqual([
      expect.objectContaining({
        feedbackId: "feedback-1",
        elevationHandoff: {
          handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          targetGovernancePath:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
          status: "open",
        },
        elevationHandoffTarget: null,
        elevationHandoffStatusTarget: {
          tool: "finance_doctrine_teacher_feedback_elevation_handoff_status",
          dateKey,
          handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          allowedStatuses: [
            "converted_to_candidate_input",
            "rejected_after_handoff_review",
            "superseded",
          ],
        },
        candidateInput: null,
        candidateInputTarget: null,
        candidateInputReview: null,
        candidateInputReviewTarget: null,
      }),
    ]);
  });

  it("shows resolved teacher elevation handoffs without another status action target", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-04-16T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-04-10",
        windowEndDate: "2026-04-16",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-04-16T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: missing_causal_chain
- **Critique Text**: The calibration artifact omits the rates-to-index causal chain.
- **Suggested Candidate Text**: teacher critique: make the rates-to-index transmission explicit before leaning on conviction
- **Evidence Needed**: Need repeated calibration artifacts showing the same omitted chain weakens later review quality.
- **Risk Of Adopting**: Could overcorrect into boilerplate macro narration.
- **Recommended Next Action**: Compare this critique against same-day finance governance candidates before converting anything manually.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
            reviewOutcome: "elevated_for_governance_review",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
        handedOffAt: "2026-04-16T22:30:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        handoffs: [
          {
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.",
            status: "converted_to_candidate_input",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute(
      "finance-promotion-candidates-resolved-teacher-elevation-handoff",
      { dateKey },
    );
    const details = result.details as {
      ok: boolean;
      teacherElevationHandoffPath: string | null;
      teacherCandidateInputPath: string | null;
      teacherFeedback: Array<{
        feedbackId: string;
        elevationHandoff: {
          handoffId: string;
          targetGovernancePath: string;
          status: string;
        } | null;
        elevationHandoffStatusTarget: {
          tool: string;
          dateKey: string;
          handoffId: string;
          allowedStatuses: string[];
        } | null;
        candidateInputTarget: {
          tool: string;
          dateKey: string;
          handoffId: string;
        } | null;
        candidateInputReview: {
          reviewOutcome: string;
          sourceTeacherCandidateInputArtifact: string;
        } | null;
        candidateInputReviewTarget: {
          tool: string;
          dateKey: string;
          candidateInputId: string;
          allowedOutcomes: string[];
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.teacherElevationHandoffPath).toBe(
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
    );
    expect(details.teacherCandidateInputPath).toBeNull();
    expect(details.teacherFeedback).toEqual([
      expect.objectContaining({
        feedbackId: "feedback-1",
        elevationHandoff: {
          handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          targetGovernancePath:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
          status: "converted_to_candidate_input",
        },
        elevationHandoffStatusTarget: null,
        candidateInputTarget: {
          tool: "finance_doctrine_teacher_feedback_candidate_input",
          dateKey,
          handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
        },
        candidateInputReview: null,
        candidateInputReviewTarget: null,
      }),
    ]);
  });

  it("shows teacher candidate-input artifacts for converted teacher handoffs in inspection", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-04-16T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-04-10",
        windowEndDate: "2026-04-16",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-04-16T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: missing_causal_chain
- **Critique Text**: The calibration artifact omits the rates-to-index causal chain.
- **Suggested Candidate Text**: teacher critique: make the rates-to-index transmission explicit before leaning on conviction
- **Evidence Needed**: Need repeated calibration artifacts showing the same omitted chain weakens later review quality.
- **Risk Of Adopting**: Could overcorrect into boilerplate macro narration.
- **Recommended Next Action**: Compare this critique against same-day finance governance candidates before converting anything manually.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
            reviewOutcome: "elevated_for_governance_review",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
        handedOffAt: "2026-04-16T22:30:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        handoffs: [
          {
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.",
            status: "converted_to_candidate_input",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherCandidateInputArtifact({
        createdAt: "2026-04-16T23:10:00.000Z",
        sourceTeacherElevationHandoffArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        candidateInputs: [
          {
            candidateInputId:
              "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this converted teacher critique against the same-day finance governance candidate flow before any later governance action.",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-teacher-candidate-input", {
      dateKey,
    });
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      teacherCandidateInputPath: string | null;
      teacherCandidateInputReviewPath: string | null;
      teacherFeedback: Array<{
        feedbackId: string;
        candidateInput: {
          candidateInputId: string;
          sourceTeacherElevationHandoffArtifact: string;
          targetGovernancePath: string;
        } | null;
        candidateInputTarget: {
          tool: string;
          dateKey: string;
          handoffId: string;
        } | null;
        candidateInputReview: {
          reviewOutcome: string;
          sourceTeacherCandidateInputArtifact: string;
        } | null;
        candidateInputReviewTarget: {
          tool: string;
          dateKey: string;
          candidateInputId: string;
          allowedOutcomes: string[];
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe(
      "candidate_review_decision_proposal_handoff_teacher_feedback_teacher_review_teacher_elevation_handoff_and_teacher_candidate_input_artifacts",
    );
    expect(details.teacherCandidateInputPath).toBe(
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
    );
    expect(details.teacherCandidateInputReviewPath).toBeNull();
    expect(details.teacherFeedback).toEqual([
      expect.objectContaining({
        feedbackId: "feedback-1",
        candidateInput: {
          candidateInputId:
            "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          sourceTeacherElevationHandoffArtifact:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
          targetGovernancePath:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
        },
        candidateInputTarget: null,
        candidateInputReview: null,
        candidateInputReviewTarget: {
          tool: "finance_doctrine_teacher_feedback_candidate_input_review",
          dateKey,
          candidateInputId:
            "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          allowedOutcomes: [
            "consumed_into_candidate_flow",
            "rejected_before_candidate_flow",
            "superseded",
          ],
        },
      }),
    ]);
  });

  it("shows reviewed teacher candidate-input artifacts without another review action target", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-04-16T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-04-10",
        windowEndDate: "2026-04-16",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-04-16T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: missing_causal_chain
- **Critique Text**: The calibration artifact omits the rates-to-index causal chain.
- **Suggested Candidate Text**: teacher critique: make the rates-to-index transmission explicit before leaning on conviction
- **Evidence Needed**: Need repeated calibration artifacts showing the same omitted chain weakens later review quality.
- **Risk Of Adopting**: Could overcorrect into boilerplate macro narration.
- **Recommended Next Action**: Compare this critique against same-day finance governance candidates before converting anything manually.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
            reviewOutcome: "elevated_for_governance_review",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
        handedOffAt: "2026-04-16T22:30:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        handoffs: [
          {
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.",
            status: "converted_to_candidate_input",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherCandidateInputArtifact({
        createdAt: "2026-04-16T23:10:00.000Z",
        sourceTeacherElevationHandoffArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        candidateInputs: [
          {
            candidateInputId:
              "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this converted teacher critique against the same-day finance governance candidate flow before any later governance action.",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(
        receiptsDir,
        "2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
      ),
      `# Feishu Finance Doctrine Teacher Candidate Input Review

- **Reviewed At**: 2026-04-16T23:40:00.000Z
- **Source Teacher Candidate Input Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md

## Reviews
### Review 1
- **Candidate Input ID**: finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1
- **Handoff ID**: finance-teacher-elevation-handoff-2026-04-16-feedback-1
- **Feedback ID**: feedback-1
- **Target Governance Path**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md
- **Review Outcome**: consumed_into_candidate_flow
`,
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute(
      "finance-promotion-candidates-reviewed-teacher-candidate-input",
      { dateKey },
    );
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      teacherCandidateInputReviewPath: string | null;
      teacherFeedback: Array<{
        feedbackId: string;
        candidateInputReview: {
          reviewOutcome: string;
          sourceTeacherCandidateInputArtifact: string;
        } | null;
        candidateInputReviewTarget: {
          tool: string;
          dateKey: string;
          candidateInputId: string;
          allowedOutcomes: string[];
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe(
      "candidate_review_decision_proposal_handoff_teacher_feedback_teacher_review_teacher_elevation_handoff_teacher_candidate_input_and_teacher_candidate_input_review_artifacts",
    );
    expect(details.teacherCandidateInputReviewPath).toBe(
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
    );
    expect(details.teacherFeedback).toEqual([
      expect.objectContaining({
        feedbackId: "feedback-1",
        candidateInputReview: {
          reviewOutcome: "consumed_into_candidate_flow",
          sourceTeacherCandidateInputArtifact:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
        },
        candidateInputReviewTarget: null,
      }),
    ]);
  });

  it("shows teacher candidate-input reconciliation artifacts once consumed teacher input is bridged into the finance candidate flow", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-04-16T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-04-10",
        windowEndDate: "2026-04-16",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-04-16T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: missing_causal_chain
- **Critique Text**: The calibration artifact omits the rates-to-index causal chain.
- **Suggested Candidate Text**: teacher critique: make the rates-to-index transmission explicit before leaning on conviction
- **Evidence Needed**: Need repeated calibration artifacts showing the same omitted chain weakens later review quality.
- **Risk Of Adopting**: Could overcorrect into boilerplate macro narration.
- **Recommended Next Action**: Compare this critique against same-day finance governance candidates before converting anything manually.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
            reviewOutcome: "elevated_for_governance_review",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
        handedOffAt: "2026-04-16T22:30:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        handoffs: [
          {
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.",
            status: "converted_to_candidate_input",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherCandidateInputArtifact({
        createdAt: "2026-04-16T23:10:00.000Z",
        sourceTeacherElevationHandoffArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        candidateInputs: [
          {
            candidateInputId:
              "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this converted teacher critique against the same-day finance governance candidate flow before any later governance action.",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(
        receiptsDir,
        "2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
      ),
      `# Feishu Finance Doctrine Teacher Candidate Input Review

- **Reviewed At**: 2026-04-16T23:40:00.000Z
- **Source Teacher Candidate Input Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md

## Reviews
### Review 1
- **Candidate Input ID**: finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1
- **Handoff ID**: finance-teacher-elevation-handoff-2026-04-16-feedback-1
- **Feedback ID**: feedback-1
- **Target Governance Path**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md
- **Review Outcome**: consumed_into_candidate_flow
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(
        receiptsDir,
        buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename(dateKey),
      ),
      renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact({
        reconciledAt: "2026-04-16T23:55:00.000Z",
        sourceTeacherCandidateInputArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
        sourceTeacherCandidateInputReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
        reconciliations: [
          {
            reconciliationId:
              "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            sourceTeacherCandidateInputArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
            sourceTeacherCandidateInputReviewArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
            candidateInputId:
              "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            targetFinanceCandidatePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            reconciliationMode: "link_existing_candidate",
            reconciliationNotes:
              "Keep this teacher candidate-input linked to the same-day finance candidate flow as bounded evidence only.",
            status: "open",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute(
      "finance-promotion-candidates-teacher-candidate-input-reconciliation",
      { dateKey },
    );
    const details = result.details as {
      ok: boolean;
      stateSource: string;
      teacherCandidateInputReconciliationPath: string | null;
      teacherFeedback: Array<{
        feedbackId: string;
        candidateInputReconciliation: {
          reconciliationId: string;
          sourceTeacherCandidateInputArtifact: string;
          sourceTeacherCandidateInputReviewArtifact: string;
          targetFinanceCandidatePath: string;
          reconciliationMode: string;
          reconciliationNotes: string;
          status: string;
        } | null;
        candidateInputReconciliationTarget: {
          tool: string;
          dateKey: string;
          candidateInputId: string;
          allowedModes: string[];
        } | null;
        candidateInputReconciliationStatusTarget: {
          tool: string;
          dateKey: string;
          reconciliationId: string;
          allowedStatuses: string[];
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.stateSource).toBe(
      "candidate_review_decision_proposal_handoff_teacher_feedback_teacher_review_teacher_elevation_handoff_teacher_candidate_input_teacher_candidate_input_review_and_teacher_candidate_input_reconciliation_artifacts",
    );
    expect(details.teacherCandidateInputReconciliationPath).toBe(
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-reconciliation.md",
    );
    expect(details.teacherFeedback).toEqual([
      expect.objectContaining({
        feedbackId: "feedback-1",
        candidateInputReconciliation: {
          reconciliationId:
            "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          sourceTeacherCandidateInputArtifact:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
          sourceTeacherCandidateInputReviewArtifact:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
          targetFinanceCandidatePath:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
          reconciliationMode: "link_existing_candidate",
          reconciliationNotes:
            "Keep this teacher candidate-input linked to the same-day finance candidate flow as bounded evidence only.",
          status: "open",
        },
        candidateInputReconciliationTarget: null,
        candidateInputReconciliationStatusTarget: {
          tool: "finance_doctrine_teacher_feedback_candidate_input_reconciliation_status",
          dateKey,
          reconciliationId:
            "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          allowedStatuses: [
            "linked_to_existing_candidate",
            "created_as_new_candidate_reference",
            "rejected_before_reconciliation",
            "superseded",
          ],
        },
      }),
    ]);
  });

  it("shows resolved teacher candidate-input reconciliation status without another status action target", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-04-16T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-04-10",
        windowEndDate: "2026-04-16",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-04-16T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: missing_causal_chain
- **Critique Text**: The calibration artifact omits the rates-to-index causal chain.
- **Suggested Candidate Text**: teacher critique: make the rates-to-index transmission explicit before leaning on conviction
- **Evidence Needed**: Need repeated calibration artifacts showing the same omitted chain weakens later review quality.
- **Risk Of Adopting**: Could overcorrect into boilerplate macro narration.
- **Recommended Next Action**: Compare this critique against same-day finance governance candidates before converting anything manually.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
            reviewOutcome: "elevated_for_governance_review",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
        handedOffAt: "2026-04-16T22:30:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        handoffs: [
          {
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.",
            status: "converted_to_candidate_input",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherCandidateInputArtifact({
        createdAt: "2026-04-16T23:10:00.000Z",
        sourceTeacherElevationHandoffArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        candidateInputs: [
          {
            candidateInputId:
              "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this converted teacher critique against the same-day finance governance candidate flow before any later governance action.",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(
        receiptsDir,
        "2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
      ),
      `# Feishu Finance Doctrine Teacher Candidate Input Review

- **Reviewed At**: 2026-04-16T23:40:00.000Z
- **Source Teacher Candidate Input Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md

## Reviews
### Review 1
- **Candidate Input ID**: finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1
- **Handoff ID**: finance-teacher-elevation-handoff-2026-04-16-feedback-1
- **Feedback ID**: feedback-1
- **Target Governance Path**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md
- **Review Outcome**: consumed_into_candidate_flow
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(
        receiptsDir,
        buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename(dateKey),
      ),
      renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact({
        reconciledAt: "2026-04-16T23:55:00.000Z",
        sourceTeacherCandidateInputArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
        sourceTeacherCandidateInputReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
        reconciliations: [
          {
            reconciliationId:
              "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            sourceTeacherCandidateInputArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
            sourceTeacherCandidateInputReviewArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
            candidateInputId:
              "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            targetFinanceCandidatePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            reconciliationMode: "new_candidate_reference",
            reconciliationNotes:
              "Map this consumed teacher input into a new candidate reference without treating it as adopted doctrine.",
            status: "created_as_new_candidate_reference",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute(
      "finance-promotion-candidates-resolved-teacher-candidate-input-reconciliation",
      { dateKey },
    );
    const details = result.details as {
      ok: boolean;
      teacherFeedback: Array<{
        feedbackId: string;
        candidateInputReconciliation: {
          status: string;
          reconciliationMode: string;
        } | null;
        candidateInputReconciliationStatusTarget: {
          tool: string;
          dateKey: string;
          reconciliationId: string;
          allowedStatuses: string[];
        } | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.teacherFeedback).toEqual([
      expect.objectContaining({
        feedbackId: "feedback-1",
        candidateInputReconciliation: expect.objectContaining({
          status: "created_as_new_candidate_reference",
          reconciliationMode: "new_candidate_reference",
        }),
        candidateInputReconciliationStatusTarget: null,
      }),
    ]);
  });

  it("fails closed when the same-day teacher-feedback artifact is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      "# Feishu Finance Doctrine Teacher Feedback\n\n- **Generated At**: 2026-03-25T21:30:00.000Z\n\n## Feedback\n### Feedback 1\n- **Feedback ID**: feedback-1\n- **Source Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md\n- **Teacher Model**: openai/gpt-5.2\n- **Critique Type**: missing_bear_case\n- **Critique Text**: critique text\n- **Suggested Candidate Text**: suggested candidate\n- **Evidence Needed**: evidence\n- **Risk Of Adopting**: risk\n- **Recommended Next Action**: next action\n",
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-malformed-teacher-feedback", {
      dateKey,
    });

    expect(result.details).toEqual({
      ok: false,
      reason: "teacher_feedback_artifact_malformed",
      dateKey,
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath: null,
      decisionPath: null,
      proposalPath: null,
      handoffPath: null,
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-teacher-feedback.md",
      action:
        "Repair or archive the malformed finance teacher-feedback artifact before retrying finance_promotion_candidates.",
    });
  });

  it("fails closed when the same-day teacher-review artifact is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-04-16T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-04-10",
        windowEndDate: "2026-04-16",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-04-16T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: missing_causal_chain
- **Critique Text**: critique text
- **Suggested Candidate Text**: suggested candidate
- **Evidence Needed**: evidence
- **Risk Of Adopting**: risk
- **Recommended Next Action**: next action
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Review

- **Reviewed At**: 2026-04-16T22:00:00.000Z

## Reviews
### Review 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Review Outcome**: deferred
`,
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-malformed-teacher-review", {
      dateKey,
    });

    expect(result.details).toEqual({
      ok: false,
      reason: "teacher_review_artifact_malformed",
      dateKey,
      candidatePath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath: null,
      decisionPath: null,
      proposalPath: null,
      handoffPath: null,
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      teacherReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      action:
        "Repair or archive the malformed finance teacher-review artifact before retrying finance_promotion_candidates.",
    });
  });

  it("fails closed when the same-day teacher-elevation handoff artifact is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-04-16T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-04-10",
        windowEndDate: "2026-04-16",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "conviction_looks repeated too_high in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-04-16T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: missing_causal_chain
- **Critique Text**: critique text
- **Suggested Candidate Text**: suggested candidate
- **Evidence Needed**: evidence
- **Risk Of Adopting**: risk
- **Recommended Next Action**: next action
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
            reviewOutcome: "elevated_for_governance_review",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey)),
      `# Feishu Finance Doctrine Teacher Elevation Handoffs

- **Handed Off At**: 2026-04-16T22:30:00.000Z
- **Source Teacher Feedback Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md

## Handoffs
### Handoff 1
- **Handoff ID**: handoff-1
- **Feedback ID**: feedback-1
- **Critique Type**: missing_causal_chain
- **Critique Text**: critique text
- **Suggested Candidate Text**: suggested candidate
- **Evidence Needed**: evidence
- **Risk Of Adopting**: risk
- **Target Governance Path**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md
- **Operator Next Action**: next action
- **Status**: open
`,
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute(
      "finance-promotion-candidates-malformed-teacher-elevation-handoff",
      {
        dateKey,
      },
    );

    expect(result.details).toEqual({
      ok: false,
      reason: "teacher_elevation_handoff_artifact_malformed",
      dateKey,
      candidatePath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath: null,
      decisionPath: null,
      proposalPath: null,
      handoffPath: null,
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      teacherReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      teacherElevationHandoffPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
      action:
        "Repair or archive the malformed finance teacher-elevation handoff artifact before retrying finance_promotion_candidates.",
    });
  });

  it("fails closed when the same-day handoff artifact is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
        totalCalibrationNotes: 1,
        candidates: [
          {
            candidateKey: "closest_scenario:base_case",
            signal: "closest_scenario",
            observedValue: "base_case",
            occurrences: 1,
            reviewState: "unreviewed",
            candidateText: "closest_scenario repeated base_case in 1/1 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; still needs operator review for doctrine wording and bounded scope",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineEditHandoffsFilename(dateKey)),
      "# Feishu Finance Doctrine Edit Handoffs\n\n- **Handed Off At**: 2026-03-25T21:00:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n\n## Handoffs\n### Handoff 1\n- **Handoff ID**: finance-doctrine-edit-handoff-2026-03-25-test\n- **Proposal ID**: finance-doctrine-proposal-2026-03-25-test\n- **Candidate Key**: closest_scenario:base_case\n- **Proposed Doctrine Change**: Draft a bounded manual doctrine update\n- **Rationale From Calibration**: repeated pattern\n- **Risk Or Counterargument**: still needs review\n- **Target Doctrine Or Card**: memory/local-memory/holding-holdings-thesis-revalidation.md\n- **Manual Edit Checklist**: confirm the target doctrine path\n- **Operator Decision Needed**: decide whether to edit doctrine manually\n- **Status**: open\n",
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-malformed-handoff", {
      dateKey,
    });

    expect(result.details).toEqual({
      ok: false,
      reason: "handoff_artifact_malformed",
      dateKey,
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath: null,
      decisionPath: null,
      proposalPath: null,
      handoffPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-edit-handoffs.md",
      action:
        "Repair or archive the malformed finance doctrine-edit handoff artifact before retrying finance_promotion_candidates.",
    });
  });

  it("fails closed when the same-day candidate artifact is missing", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const tool = createFinancePromotionCandidatesTool({ workspaceDir });

    const result = await tool.execute("finance-promotion-candidates-missing", {
      dateKey: "2026-03-25",
    });

    expect(result.details).toEqual({
      ok: false,
      reason: "candidate_artifact_missing",
      dateKey: "2026-03-25",
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      action:
        "No same-day finance promotion candidate artifact exists yet. Generate it first before trying to inspect candidate keys.",
    });
  });

  it("fails closed when the same-day review artifact is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
        totalCalibrationNotes: 2,
        candidates: [
          {
            candidateKey: "closest_scenario:base_case",
            signal: "closest_scenario",
            observedValue: "base_case",
            occurrences: 2,
            reviewState: "unreviewed",
            candidateText: "closest_scenario repeated base_case in 2/2 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey)),
      "# malformed review artifact\n",
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-bad-review", { dateKey });

    expect(result.details).toEqual({
      ok: false,
      reason: "review_artifact_malformed",
      dateKey,
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      action:
        "Repair or archive the malformed finance promotion review artifact before retrying finance_promotion_candidates.",
    });
  });

  it("fails closed when the same-day decision artifact is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
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
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey)),
      "# Feishu Finance Doctrine Promotion Review\n\n- **Reviewed At**: 2026-03-25T18:00:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n\n## Reviews\n### Review 1\n- **Candidate Key**: closest_scenario:base_case\n- **Review State**: ready_for_manual_promotion\n- **Review Notes**: repeat pattern is stable enough to consider manual promotion\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey)),
      "# malformed decision artifact\n",
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-bad-decision", { dateKey });

    expect(result.details).toEqual({
      ok: false,
      reason: "decision_artifact_malformed",
      dateKey,
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      decisionPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      action:
        "Repair or archive the malformed finance promotion decision artifact before retrying finance_promotion_candidates.",
    });
  });

  it("fails closed when the same-day proposal artifact is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-candidates-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";

    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
      renderFeishuFinanceDoctrinePromotionCandidateArtifact({
        generatedAt: "2026-03-25T15:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        windowDays: 7,
        windowStartDate: "2026-03-19",
        windowEndDate: "2026-03-25",
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
      "# Feishu Finance Doctrine Promotion Review\n\n- **Reviewed At**: 2026-03-25T18:00:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n\n## Reviews\n### Review 1\n- **Candidate Key**: closest_scenario:base_case\n- **Review State**: ready_for_manual_promotion\n- **Review Notes**: repeat pattern is stable enough to consider manual promotion\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey)),
      "# Feishu Finance Doctrine Promotion Decisions\n\n- **Decided At**: 2026-03-25T19:10:00.000Z\n- **Consumer**: holdings_thesis_revalidation\n- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md\n- **Linked Review Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md\n\n## Decisions\n### Decision 1\n- **Candidate Key**: closest_scenario:base_case\n- **Decision Outcome**: proposal_created\n- **Review State At Decision**: ready_for_manual_promotion\n- **Decision Notes**: create a manual doctrine proposal draft for operator review\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionProposalsFilename(dateKey)),
      "# malformed proposal artifact\n",
      "utf8",
    );

    const tool = createFinancePromotionCandidatesTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-candidates-bad-proposal", { dateKey });

    expect(result.details).toEqual({
      ok: false,
      reason: "proposal_artifact_malformed",
      dateKey,
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      decisionPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      proposalPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      action:
        "Repair or archive the malformed finance promotion proposal artifact before retrying finance_promotion_candidates.",
    });
  });
});
