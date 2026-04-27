import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  parseFeishuFinanceDoctrinePromotionCandidateArtifact,
  parseFeishuFinanceDoctrinePromotionReviewArtifact,
  renderFeishuFinanceDoctrinePromotionCandidateArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinancePromotionReviewTool } from "./finance-promotion-review-tool.js";

describe("finance_promotion_review tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("records a bounded review action and mirrors it into the candidate artifact", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-review-");
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

    const tool = createFinancePromotionReviewTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-review", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
      action: "deferred",
      reviewNotes: "wait for one more cycle before considering manual promotion",
    });
    const details = result.details as {
      ok: boolean;
      updated: boolean;
      reviewState: string;
      previousReviewState: string;
      candidatePath: string;
      reviewPath: string;
      reviewNotes: string | null;
    };

    expect(details.ok).toBe(true);
    expect(details.updated).toBe(true);
    expect(details.reviewState).toBe("deferred");
    expect(details.previousReviewState).toBe("unreviewed");
    expect(details.reviewNotes).toBe("wait for one more cycle before considering manual promotion");
    expect(details.candidatePath).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
    );
    expect(details.reviewPath).toBe(
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
    );

    const parsedCandidates = parseFeishuFinanceDoctrinePromotionCandidateArtifact(
      await fs.readFile(path.join(workspaceDir, details.candidatePath), "utf8"),
    );
    expect(parsedCandidates?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "closest_scenario:base_case",
          reviewState: "deferred",
          reviewNotes: "wait for one more cycle before considering manual promotion",
        }),
        expect.objectContaining({
          candidateKey: "conviction_looks:too_high",
          reviewState: "unreviewed",
        }),
      ]),
    );

    const parsedReview = parseFeishuFinanceDoctrinePromotionReviewArtifact(
      await fs.readFile(
        path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey)),
        "utf8",
      ),
    );
    expect(parsedReview?.consumer).toBe("holdings_thesis_revalidation");
    expect(parsedReview?.linkedCandidateArtifact).toBe(details.candidatePath);
    expect(parsedReview?.reviews).toEqual([
      {
        candidateKey: "closest_scenario:base_case",
        reviewState: "deferred",
        reviewNotes: "wait for one more cycle before considering manual promotion",
      },
    ]);
  });

  it("fails closed when the candidate key does not exist in the same-day candidate artifact", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-review-");
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

    const tool = createFinancePromotionReviewTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-review-missing", {
      dateKey,
      candidateKey: "conviction_looks:too_high",
      action: "rejected",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "candidate_not_found",
      candidateKey: "conviction_looks:too_high",
      dateKey,
      candidatePath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      availableCandidateKeys: ["closest_scenario:base_case"],
      action:
        "Use finance_promotion_candidates with this dateKey to discover the current candidateKey values before retrying finance_promotion_review.",
    });
  });
});
