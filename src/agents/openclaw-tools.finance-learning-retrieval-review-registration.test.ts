import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance learning retrieval review registration", () => {
  it("includes the finance learning retrieval review tool", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "finance_learning_retrieval_review")).toBe(true);
  });
});
