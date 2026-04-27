import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";
import { FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS } from "./tools/finance-framework-domain-producer-tools.js";

describe("createOpenClawTools finance framework domain producer registration", () => {
  it("includes all finance framework domain producer tools", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "finance_framework_core_record")).toBe(true);
    expect(tools.some((tool) => tool.name === "finance_framework_core_inspect")).toBe(true);
    for (const spec of FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS) {
      expect(tools.some((tool) => tool.name === spec.toolName)).toBe(true);
    }
  });
});
