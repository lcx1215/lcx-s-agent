import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildExternalFinanceDoctrinePromotionCandidatesFilename,
  buildExternalFinanceDoctrinePromotionDecisionsFilename,
  buildExternalFinanceDoctrinePromotionReviewFilename,
  parseExternalFinanceDoctrinePromotionCandidateArtifact,
  parseExternalFinanceDoctrinePromotionDecisionArtifact,
  parseExternalFinanceDoctrinePromotionReviewArtifact,
  renderExternalFinanceDoctrinePromotionCandidateArtifact,
} from "../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

type RuntimeToolResult = {
  details?: unknown;
};

type RuntimeTool = {
  name: string;
  execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<RuntimeToolResult>;
};

function createExternalMainRuntimeTools(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  groupId?: string;
}) {
  const groupId = params.groupId ?? "lobster-finance-control-room";
  return createOpenClawCodingTools({
    config: params.config,
    workspaceDir: params.workspaceDir,
    agentDir: "/tmp/openclaw-agent",
    sessionKey: `agent:main:external:group:${groupId}`,
    messageProvider: "external",
    groupId,
    modelProvider: "openai",
    modelId: "gpt-5.2",
  });
}

function getRuntimeTool(tools: { name: string }[], name: string): RuntimeTool {
  const tool = tools.find((entry) => entry.name === name);
  expect(tool, `expected runtime tool ${name}`).toBeDefined();
  return tool as RuntimeTool;
}

async function seedPromotionCandidates(workspaceDir: string, dateKey: string) {
  const receiptsDir = path.join(workspaceDir, "memory", "external-work-receipts");
  await fs.mkdir(receiptsDir, { recursive: true });
  await fs.writeFile(
    path.join(receiptsDir, buildExternalFinanceDoctrinePromotionCandidatesFilename(dateKey)),
    renderExternalFinanceDoctrinePromotionCandidateArtifact({
      generatedAt: `${dateKey}T15:00:00.000Z`,
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
}

describe("External finance governance runtime-equivalent path", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("keeps same-day inspection plus review and manual promotion decision reachable in the External main runtime path", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-runtime-");
    const dateKey = "2026-03-25";
    await seedPromotionCandidates(workspaceDir, dateKey);

    const tools = createExternalMainRuntimeTools({ workspaceDir });
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("finance_promotion_candidates");
    expect(toolNames).toContain("finance_promotion_review");
    expect(toolNames).toContain("finance_promotion_bulk_review");
    expect(toolNames).toContain("finance_promotion_decision");

    const candidatesTool = getRuntimeTool(tools, "finance_promotion_candidates");
    const reviewTool = getRuntimeTool(tools, "finance_promotion_review");
    const bulkReviewTool = getRuntimeTool(tools, "finance_promotion_bulk_review");
    const decisionTool = getRuntimeTool(tools, "finance_promotion_decision");

    const initialList = (await candidatesTool.execute("external-finance-list-initial", { dateKey }))
      .details as {
      ok: boolean;
      stateSource: string;
      candidateCount: number;
      candidates: Array<{ candidateKey: string; reviewState: string }>;
    };
    expect(initialList.ok).toBe(true);
    expect(initialList.stateSource).toBe("candidate_artifact_only");
    expect(initialList.candidateCount).toBe(2);
    expect(initialList.candidates.map((candidate) => candidate.reviewState)).toEqual([
      "unreviewed",
      "unreviewed",
    ]);

    const singleReview = await reviewTool.execute("external-finance-review-single", {
      dateKey,
      candidateKey: "closest_scenario:base_case",
      action: "deferred",
      reviewNotes: "need one more posterior cycle before manual promotion",
    });
    expect(singleReview.details).toEqual(
      expect.objectContaining({
        ok: true,
        updated: true,
        candidateKey: "closest_scenario:base_case",
        reviewState: "deferred",
        action: expect.stringContaining("does not promote"),
      }),
    );

    const bulkReview = await bulkReviewTool.execute("external-finance-review-bulk", {
      dateKey,
      reviews: [
        {
          candidateKey: "conviction_looks:too_high",
          action: "ready_for_manual_promotion",
          reviewNotes: "repeat pattern is stable enough for manual doctrine review",
        },
      ],
    });
    expect(bulkReview.details).toEqual(
      expect.objectContaining({
        ok: true,
        updated: true,
        mode: "all_or_nothing",
        appliedCount: 1,
        action: expect.stringContaining("does not promote any candidate"),
      }),
    );

    const promotionDecision = await decisionTool.execute("external-finance-promotion-decision", {
      dateKey,
      candidateKey: "conviction_looks:too_high",
      decision: "proposal_created",
      decisionNotes: "create a manual doctrine proposal draft for operator review",
    });
    expect(promotionDecision.details).toEqual(
      expect.objectContaining({
        ok: true,
        updated: true,
        candidateKey: "conviction_looks:too_high",
        currentReviewState: "ready_for_manual_promotion",
        decisionOutcome: "proposal_created",
        action: expect.stringContaining("does not promote doctrine"),
      }),
    );

    const reviewedList = await candidatesTool.execute("external-finance-list-reviewed", {
      dateKey,
    });
    expect(reviewedList.details).toEqual(
      expect.objectContaining({
        ok: true,
        stateSource: "candidate_review_and_decision_artifacts",
        reviewPath:
          "memory/external-work-receipts/2026-03-25-external-finance-doctrine-promotion-review.md",
        decisionPath:
          "memory/external-work-receipts/2026-03-25-external-finance-doctrine-promotion-decisions.md",
      }),
    );
    expect(
      (
        reviewedList.details as {
          candidates: Array<{
            candidateKey: string;
            reviewState: string;
            reviewNotes: string | null;
          }>;
        }
      ).candidates,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "closest_scenario:base_case",
          candidateText: "closest_scenario repeated base_case in 2/3 recent calibration notes",
          signal: "closest_scenario",
          observedValue: "base_case",
          occurrences: 2,
          reviewState: "deferred",
          reviewNotes: "need one more posterior cycle before manual promotion",
          promotionDecision: null,
          actionTarget: {
            tool: "finance_promotion_review",
            dateKey,
            candidateKey: "closest_scenario:base_case",
            allowedActions: ["deferred", "rejected", "ready_for_manual_promotion"],
          },
          promotionDecisionTarget: null,
        }),
        expect.objectContaining({
          candidateKey: "conviction_looks:too_high",
          candidateText: "conviction_looks repeated too_high in 2/3 recent calibration notes",
          signal: "conviction_looks",
          observedValue: "too_high",
          occurrences: 2,
          reviewState: "ready_for_manual_promotion",
          reviewNotes: "repeat pattern is stable enough for manual doctrine review",
          promotionDecision: {
            decisionOutcome: "proposal_created",
            reviewStateAtDecision: "ready_for_manual_promotion",
            decisionNotes: "create a manual doctrine proposal draft for operator review",
          },
          actionTarget: {
            tool: "finance_promotion_review",
            dateKey,
            candidateKey: "conviction_looks:too_high",
            allowedActions: ["deferred", "rejected", "ready_for_manual_promotion"],
          },
          promotionDecisionTarget: {
            tool: "finance_promotion_decision",
            dateKey,
            candidateKey: "conviction_looks:too_high",
            allowedDecisions: [
              "proposal_created",
              "deferred_after_promotion_review",
              "rejected_after_promotion_review",
            ],
          },
        }),
      ]),
    );

    const candidateArtifactPath = path.join(
      workspaceDir,
      "memory",
      "external-work-receipts",
      buildExternalFinanceDoctrinePromotionCandidatesFilename(dateKey),
    );
    const reviewArtifactPath = path.join(
      workspaceDir,
      "memory",
      "external-work-receipts",
      buildExternalFinanceDoctrinePromotionReviewFilename(dateKey),
    );
    const parsedCandidateArtifact = parseExternalFinanceDoctrinePromotionCandidateArtifact(
      await fs.readFile(candidateArtifactPath, "utf8"),
    );
    const parsedReviewArtifact = parseExternalFinanceDoctrinePromotionReviewArtifact(
      await fs.readFile(reviewArtifactPath, "utf8"),
    );
    const parsedDecisionArtifact = parseExternalFinanceDoctrinePromotionDecisionArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "external-work-receipts",
          buildExternalFinanceDoctrinePromotionDecisionsFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsedCandidateArtifact?.candidates.map((candidate) => candidate.reviewState)).toEqual([
      "deferred",
      "ready_for_manual_promotion",
    ]);
    expect(parsedReviewArtifact?.reviews.map((review) => review.reviewState)).toEqual([
      "deferred",
      "ready_for_manual_promotion",
    ]);
    expect(parsedDecisionArtifact?.decisions).toEqual([
      {
        candidateKey: "conviction_looks:too_high",
        decisionOutcome: "proposal_created",
        reviewStateAtDecision: "ready_for_manual_promotion",
        decisionNotes: "create a manual doctrine proposal draft for operator review",
      },
    ]);
    await expect(
      fs.access(path.join(workspaceDir, "memory", "local-memory")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed in the External main runtime path when same-day promotion candidates are missing", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-runtime-");
    const tools = createExternalMainRuntimeTools({ workspaceDir });
    const candidatesTool = getRuntimeTool(tools, "finance_promotion_candidates");

    const result = await candidatesTool.execute("external-finance-list-missing", {
      dateKey: "2026-03-25",
    });

    expect(result.details).toEqual({
      ok: false,
      reason: "candidate_artifact_missing",
      dateKey: "2026-03-25",
      candidatePath:
        "memory/external-work-receipts/2026-03-25-external-finance-doctrine-promotion-candidates.md",
      action:
        "No same-day finance promotion candidate artifact exists yet. Generate it first before trying to inspect candidate keys.",
    });
  });

  it("respects External group tool policy boundaries in the runtime assembly", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-runtime-");
    const cfg: OpenClawConfig = {
      channels: {
        external: {
          groups: {
            "locked-finance-room": {
              tools: { allow: ["read"] },
            },
          },
        },
      },
    };

    const tools = createExternalMainRuntimeTools({
      workspaceDir,
      config: cfg,
      groupId: "locked-finance-room",
    });
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).not.toContain("finance_promotion_candidates");
    expect(toolNames).not.toContain("finance_promotion_review");
    expect(toolNames).not.toContain("finance_promotion_bulk_review");
    expect(toolNames).not.toContain("finance_promotion_decision");
  });
});
