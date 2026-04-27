import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance framework core registration", () => {
  it("includes finance framework core tools", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "finance_framework_core_record")).toBe(true);
    expect(tools.some((tool) => tool.name === "finance_framework_core_inspect")).toBe(true);
  });
});
