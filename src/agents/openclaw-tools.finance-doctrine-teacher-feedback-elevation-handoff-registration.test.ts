import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance_doctrine_teacher_feedback_elevation_handoff registration", () => {
  it("includes finance_doctrine_teacher_feedback_elevation_handoff", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(
      tools.some((tool) => tool.name === "finance_doctrine_teacher_feedback_elevation_handoff"),
    ).toBe(true);
  });
});
