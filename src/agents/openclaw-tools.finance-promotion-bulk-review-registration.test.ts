import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance_promotion_bulk_review registration", () => {
  it("includes finance_promotion_bulk_review", () => {
    const tools = createOpenClawTools();
    expect(tools.some((tool) => tool.name === "finance_promotion_bulk_review")).toBe(true);
  });
});
