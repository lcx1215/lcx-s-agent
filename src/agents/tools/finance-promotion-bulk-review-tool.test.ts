import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  parseFeishuFinanceDoctrinePromotionCandidateArtifact,
  parseFeishuFinanceDoctrinePromotionReviewArtifact,
  renderFeishuFinanceDoctrinePromotionCandidateArtifact,
  renderFeishuFinanceDoctrinePromotionReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinancePromotionBulkReviewTool } from "./finance-promotion-bulk-review-tool.js";

describe("finance_promotion_bulk_review tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("applies multiple same-day review actions in one bounded all-or-nothing call", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-bulk-review-");
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
        totalCalibrationNotes: 4,
        candidates: [
          {
            candidateKey: "closest_scenario:base_case",
            signal: "closest_scenario",
            observedValue: "base_case",
            occurrences: 3,
            reviewState: "unreviewed",
            candidateText: "closest_scenario repeated base_case in 3/4 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
          },
          {
            candidateKey: "change_my_mind_triggered:no",
            signal: "change_my_mind_triggered",
            observedValue: "no",
            occurrences: 3,
            reviewState: "unreviewed",
            candidateText: "change_my_mind_triggered repeated no in 3/4 recent calibration notes",
            notEnoughForPromotion:
              "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet",
          },
          {
            candidateKey: "conviction_looks:too_high",
            signal: "conviction_looks",
            observedValue: "too_high",
            occurrences: 2,
            reviewState: "deferred",
            reviewNotes: "needs one more cycle",
            candidateText: "conviction_looks repeated too_high in 2/4 recent calibration notes",
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
            candidateKey: "conviction_looks:too_high",
            reviewState: "deferred",
            reviewNotes: "needs one more cycle",
          },
        ],
      }),
      "utf8",
    );

    const tool = createFinancePromotionBulkReviewTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-bulk-review", {
      dateKey,
      reviews: [
        {
          candidateKey: "closest_scenario:base_case",
          action: "ready_for_manual_promotion",
          reviewNotes: "repeat pattern is stable enough for manual promotion review",
        },
        {
          candidateKey: "conviction_looks:too_high",
          action: "rejected",
          reviewNotes: "too generic to promote",
        },
      ],
    });
    const details = result.details as {
      ok: boolean;
      updated: boolean;
      mode: string;
      appliedCount: number;
      appliedReviews: Array<{
        candidateKey: string;
        previousReviewState: string;
        reviewState: string;
        reviewNotes: string | null;
      }>;
    };

    expect(details.ok).toBe(true);
    expect(details.updated).toBe(true);
    expect(details.mode).toBe("all_or_nothing");
    expect(details.appliedCount).toBe(2);
    expect(details.appliedReviews).toEqual([
      {
        candidateKey: "closest_scenario:base_case",
        previousReviewState: "unreviewed",
        reviewState: "ready_for_manual_promotion",
        reviewNotes: "repeat pattern is stable enough for manual promotion review",
      },
      {
        candidateKey: "conviction_looks:too_high",
        previousReviewState: "deferred",
        reviewState: "rejected",
        reviewNotes: "too generic to promote",
      },
    ]);

    const parsedCandidates = parseFeishuFinanceDoctrinePromotionCandidateArtifact(
      await fs.readFile(
        path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey)),
        "utf8",
      ),
    );
    expect(parsedCandidates?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "closest_scenario:base_case",
          reviewState: "ready_for_manual_promotion",
          reviewNotes: "repeat pattern is stable enough for manual promotion review",
        }),
        expect.objectContaining({
          candidateKey: "conviction_looks:too_high",
          reviewState: "rejected",
          reviewNotes: "too generic to promote",
        }),
        expect.objectContaining({
          candidateKey: "change_my_mind_triggered:no",
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
    expect(parsedReview?.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "closest_scenario:base_case",
          reviewState: "ready_for_manual_promotion",
        }),
        expect.objectContaining({
          candidateKey: "conviction_looks:too_high",
          reviewState: "rejected",
        }),
      ]),
    );
    await expect(fs.access(path.join(workspaceDir, "memory", "local-memory"))).rejects.toThrow();
  });

  it("fails closed without writing anything when one candidate key is unknown", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-bulk-review-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-03-25";
    const candidateFilename = buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey);
    const seedContent = renderFeishuFinanceDoctrinePromotionCandidateArtifact({
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
    });
    await fs.writeFile(path.join(receiptsDir, candidateFilename), seedContent, "utf8");

    const tool = createFinancePromotionBulkReviewTool({ workspaceDir });
    const result = await tool.execute("finance-promotion-bulk-review-missing", {
      dateKey,
      reviews: [
        {
          candidateKey: "closest_scenario:base_case",
          action: "deferred",
        },
        {
          candidateKey: "conviction_looks:too_high",
          action: "rejected",
        },
      ],
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "candidate_not_found",
      dateKey,
      unknownCandidateKeys: ["conviction_looks:too_high"],
      availableCandidateKeys: ["closest_scenario:base_case"],
      action:
        "Use finance_promotion_candidates with this dateKey to discover valid same-day candidateKey values before retrying finance_promotion_bulk_review.",
    });
    expect(await fs.readFile(path.join(receiptsDir, candidateFilename), "utf8")).toBe(seedContent);
    await expect(
      fs.access(path.join(receiptsDir, buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey))),
    ).rejects.toThrow();
  });

  it("fails closed when the same candidate key appears twice in one request", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-promotion-bulk-review-");
    const tool = createFinancePromotionBulkReviewTool({ workspaceDir });

    const result = await tool.execute("finance-promotion-bulk-review-duplicate", {
      dateKey: "2026-03-25",
      reviews: [
        {
          candidateKey: "closest_scenario:base_case",
          action: "deferred",
        },
        {
          candidateKey: "closest_scenario:base_case",
          action: "rejected",
        },
      ],
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "duplicate_candidate_keys",
      dateKey: "2026-03-25",
      duplicateCandidateKeys: ["closest_scenario:base_case"],
      action:
        "Each same-day finance promotion candidate may appear at most once per bulk review call.",
    });
  });
});
