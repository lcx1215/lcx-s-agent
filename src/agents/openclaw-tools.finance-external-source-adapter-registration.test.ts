import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance external source adapter registration", () => {
  it("includes the finance external source adapter tool", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "finance_external_source_adapter")).toBe(true);
  });
});
