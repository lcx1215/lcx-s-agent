import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools quant_math registration", () => {
  it("includes the deterministic quant_math tool for finance calculations", () => {
    const tools = createOpenClawTools();
    const tool = tools.find((candidate) => candidate.name === "quant_math");

    expect(tool).toBeTruthy();
    expect(tool?.description).toContain("Black-Scholes");
    expect(tool?.description).toContain("information ratio");
    expect(tool?.description).toContain("risk-budget deviation");
    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        action: expect.objectContaining({ type: "string" }),
        seriesMatrix: expect.objectContaining({ type: "array" }),
        weights: expect.objectContaining({ type: "array" }),
        targetRiskBudgets: expect.objectContaining({ type: "array" }),
        covarianceMatrix: expect.objectContaining({ type: "array" }),
        window: expect.objectContaining({ type: "number" }),
        confidenceLevel: expect.objectContaining({ type: "number" }),
        spot: expect.objectContaining({ type: "number" }),
        volatility: expect.objectContaining({ type: "number" }),
        yieldShockBp: expect.objectContaining({ type: "number" }),
      }),
    });
  });
});
