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
