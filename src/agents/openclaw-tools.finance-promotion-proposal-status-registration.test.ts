import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance_promotion_proposal_status registration", () => {
  it("includes finance_promotion_proposal_status", () => {
    const tools = createOpenClawTools();
    expect(tools.some((tool) => tool.name === "finance_promotion_proposal_status")).toBe(true);
  });
});
