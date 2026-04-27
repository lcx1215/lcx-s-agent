import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionDecisionsFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  parseFeishuFinanceDoctrinePromotionDecisionArtifact,
  renderFeishuFinanceDoctrinePromotionCandidateArtifact,
  renderFeishuFinanceDoctrinePromotionReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinancePromotionDecisionTool } from "./finance-promotion-decision-tool.js";

describe("finance_promotion_decision tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedReadyCandidate(dateKey: string) {
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
            reviewNotes: "repeat pattern is stable enough for manual doctrine review",
            candidateText: "closest_scenario repeated base_case in 2/2 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
          },
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 2,
            reviewState: "deferred",
            reviewNotes: "still too generic",
            candidateText: "conviction_looks repeated too_high in 2/2 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
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
          {
            candidateKey: "conviction_looks:too_high",
            reviewState: "deferred",
            reviewNotes: "still too generic",
          },
        ],
      }),
      "utf8",
    );
  }

  it("records a durable manual promotion decision for an eligible candidate", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-decision-");
    const dateKey = "2026-03-25";
    await seedReadyCandidate(dateKey);

    const tool = createFinancePromotionDecisionTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-decision", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
      decision: "proposal_created",
      decisionNotes: "create a manual doctrine proposal draft for operator review",
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      candidateKey: "closest_scenario:base_case",
      currentReviewState: "ready_for_manual_promotion",
      decisionOutcome: "proposal_created",
      previousDecisionOutcome: null,
      decisionNotes: "create a manual doctrine proposal draft for operator review",
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      reviewPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      decisionPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      action:
        "This records a bounded manual promotion decision only. It does not promote doctrine and does not update doctrine cards automatically.",
    });

    const parsedDecisionArtifact = parseFeishuFinanceDoctrinePromotionDecisionArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsedDecisionArtifact?.linkedCandidateArtifact).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
    );
    expect(parsedDecisionArtifact?.linkedReviewArtifact).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
    );
    expect(parsedDecisionArtifact?.decisions).toEqual([
      {
        candidateKey: "closest_scenario:base_case",
        decisionOutcome: "proposal_created",
        reviewStateAtDecision: "ready_for_manual_promotion",
        decisionNotes: "create a manual doctrine proposal draft for operator review",
      },
    ]);
  });

  it("fails closed when the candidate key is unknown", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-decision-");
    const dateKey = "2026-03-25";
    await seedReadyCandidate(dateKey);

    const tool = createFinancePromotionDecisionTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-decision-missing", {
      dateKey,
      candidateKey: "change_my_mind_triggered:no",
      decision: "proposal_created",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "candidate_not_found",
      dateKey,
      candidateKey: "change_my_mind_triggered:no",
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      availableCandidateKeys: ["closest_scenario:base_case", "conviction_looks:too_high"],
      action:
        "Use finance_promotion_candidates with this dateKey to discover valid same-day candidateKey values before retrying finance_promotion_decision.",
    });
    await expect(
      fs.access(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey),
        ),
      ),
    ).rejects.toThrow();
  });

  it("fails closed when the candidate is not currently ready_for_manual_promotion", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-decision-");
    const dateKey = "2026-03-25";
    await seedReadyCandidate(dateKey);

    const tool = createFinancePromotionDecisionTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-decision-invalid-transition", {
      dateKey,
      candidateKey: "conviction_looks:too_high",
      decision: "rejected_after_promotion_review",
      decisionNotes: "still too generic to become a doctrine proposal",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "candidate_not_ready_for_manual_promotion",
      dateKey,
      candidateKey: "conviction_looks:too_high",
      currentReviewState: "deferred",
      action:
        "Only candidates already marked ready_for_manual_promotion can record a bounded manual promotion decision.",
    });
    await expect(
      fs.access(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey),
        ),
      ),
    ).rejects.toThrow();
  });
});
