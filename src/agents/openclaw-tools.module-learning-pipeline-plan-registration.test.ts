import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools module learning pipeline plan registration", () => {
  it("includes the module learning pipeline plan and review tools", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "module_learning_pipeline_plan")).toBe(true);
    expect(tools.some((tool) => tool.name === "module_learning_pipeline_review")).toBe(true);
  });
});
