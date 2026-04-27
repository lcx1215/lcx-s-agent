import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance_promotion_doctrine_edit_handoff registration", () => {
  it("includes finance_promotion_doctrine_edit_handoff", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "finance_promotion_doctrine_edit_handoff")).toBe(
      true,
    );
  });
});
