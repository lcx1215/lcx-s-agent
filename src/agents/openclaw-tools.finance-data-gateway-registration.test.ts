import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance data gateway registration", () => {
  it("includes the finance data gateway snapshot tool", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "finance_data_gateway_snapshot")).toBe(true);
  });
});
