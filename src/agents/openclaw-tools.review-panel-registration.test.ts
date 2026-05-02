import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools review_panel registration", () => {
  it("includes the bounded review panel tool", async () => {
    const tools = createOpenClawTools();
    const tool = tools.find((candidate) => candidate.name === "review_panel");

    expect(tool).toBeTruthy();
    expect(tool?.description).toContain("review-panel work order");
    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        outputText: expect.objectContaining({ type: "string" }),
        writeReceipt: expect.objectContaining({ type: "boolean" }),
      }),
    });

    const result = await tool?.execute("registration-panel", {
      taskKind: "research_conclusion",
      outputText: "Candidate output with high-risk portfolio conclusion.",
      involvesPortfolioRisk: true,
    });

    expect(result?.details).toMatchObject({
      status: "three_model_panel_ready",
      tier: "three_model_review",
      providerCallsMade: false,
    });
  });
});
