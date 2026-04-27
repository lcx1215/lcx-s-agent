import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance learning pipeline orchestrator registration", () => {
  it("includes the finance learning pipeline orchestrator tool", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "finance_learning_pipeline_orchestrator")).toBe(true);
  });
});
