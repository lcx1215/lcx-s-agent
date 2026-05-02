import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools review_tier registration", () => {
  it("includes the bounded review tier tool", async () => {
    const tools = createOpenClawTools();
    const tool = tools.find((candidate) => candidate.name === "review_tier");

    expect(tool).toBeTruthy();
    expect(tool?.description).toContain("lowest sufficient review tier");
    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        taskKind: expect.objectContaining({ type: "string" }),
        hasQuantMathResults: expect.objectContaining({ type: "boolean" }),
        explicitlyRequestedStrictReview: expect.objectContaining({ type: "boolean" }),
      }),
    });

    const result = await tool?.execute("registration-smoke", {
      taskKind: "finance_learning",
      hasLocalToolResults: true,
      hasQuantMathResults: true,
    });

    expect(result?.details).toMatchObject({
      tier: "single_model_review",
      tokenPolicy: "use_primary_model",
    });
  });
});
