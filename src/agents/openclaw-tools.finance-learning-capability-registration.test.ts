import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance learning capability registration", () => {
  it("includes finance learning capability attachment tools", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "finance_learning_capability_attach")).toBe(true);
    expect(tools.some((tool) => tool.name === "finance_learning_capability_inspect")).toBe(true);
    expect(tools.some((tool) => tool.name === "finance_learning_capability_apply")).toBe(true);
  });
});
