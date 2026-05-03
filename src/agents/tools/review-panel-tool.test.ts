import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReviewPanelTool } from "./review-panel-tool.js";

type ReviewPanelDetails = {
  status: string;
  tier: string;
  tokenPolicy: string;
  reviewerTasks: unknown[];
  receiptPath: string | null;
  providerCallsMade: boolean;
  localArbitration: null | {
    status: string;
    providerCallsMade: boolean;
    reviewerFindings: unknown[];
  };
};

function reviewPanelDetails(details: unknown): ReviewPanelDetails {
  expect(details).toBeTypeOf("object");
  expect(details).not.toBeNull();
  return details as ReviewPanelDetails;
}

describe("createReviewPanelTool", () => {
  it("does not create panel tasks for local-only work", async () => {
    const tool = createReviewPanelTool();
    const result = await tool.execute("panel-1", {
      taskKind: "local_tool_result",
      outputText: "Local math result: beta = 1.2",
      hasLocalToolResults: true,
    });
    const details = reviewPanelDetails(result.details);

    expect(details).toMatchObject({
      status: "not_required",
      tier: "local_only",
      tokenPolicy: "avoid_model_review",
      providerCallsMade: false,
    });
    expect(details.reviewerTasks).toEqual([]);
  });

  it("creates three reviewer work orders for strict portfolio-risk output", async () => {
    const tool = createReviewPanelTool();
    const result = await tool.execute("panel-2", {
      taskKind: "research_conclusion",
      outputText: "Candidate output with portfolio risk, local math, and durable lesson.",
      hasLocalToolResults: true,
      hasQuantMathResults: true,
      writesDurableMemory: true,
      involvesPortfolioRisk: true,
    });
    const details = reviewPanelDetails(result.details);

    expect(details).toMatchObject({
      status: "three_model_panel_ready",
      tier: "three_model_review",
      tokenPolicy: "use_three_model_panel",
      providerCallsMade: false,
    });
    expect(details.reviewerTasks).toHaveLength(3);
    expect(JSON.stringify(details.reviewerTasks)).toContain("math and evidence consistency");
    expect(details.localArbitration).toBeNull();
  });

  it("can run local deterministic arbitration without provider calls", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-review-panel-arb-test-"));
    const tool = createReviewPanelTool({ workspaceDir });
    const result = await tool.execute("panel-local-arb", {
      taskKind: "research_conclusion",
      outputText: JSON.stringify({
        boundaries: ["research_only", "no_execution_authority", "no_model_math_guessing"],
        math: {
          localTool: "quant_math",
          checks: ["risk_budget_deviation", "rolling_beta", "drawdown_duration"],
        },
      }),
      hasLocalToolResults: true,
      hasQuantMathResults: true,
      writesDurableMemory: false,
      involvesPortfolioRisk: true,
      explicitlyRequestedStrictReview: true,
      runLocalArbitration: true,
      writeReceipt: true,
    });
    const details = reviewPanelDetails(result.details);

    expect(details).toMatchObject({
      status: "three_model_panel_arbitrated",
      tier: "three_model_review",
      tokenPolicy: "use_three_model_panel",
      providerCallsMade: false,
    });
    expect(details.reviewerTasks).toHaveLength(3);
    expect(details.localArbitration).toMatchObject({
      status: "passed",
      providerCallsMade: false,
    });
    expect(details.localArbitration?.reviewerFindings).toHaveLength(3);
    expect(details.receiptPath).toMatch(/^memory\/review-panel-receipts\/\d{4}-\d{2}-\d{2}\//u);
    expect(fs.existsSync(path.join(workspaceDir, String(details.receiptPath)))).toBe(true);
  });

  it("writes a bounded receipt when requested", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-review-panel-test-"));
    const tool = createReviewPanelTool({ workspaceDir });
    const result = await tool.execute("panel-3", {
      taskKind: "research_conclusion",
      outputText: "Candidate output.",
      affectsDoctrineOrPromotion: true,
      writeReceipt: true,
    });
    const details = reviewPanelDetails(result.details);

    expect(details.receiptPath).toMatch(/^memory\/review-panel-receipts\/\d{4}-\d{2}-\d{2}\//u);
    expect(fs.existsSync(path.join(workspaceDir, String(details.receiptPath)))).toBe(true);
  });
});
