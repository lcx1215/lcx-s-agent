import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance_doctrine_teacher_feedback_candidate_input registration", () => {
  it("includes finance_doctrine_teacher_feedback_candidate_input", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(
      tools.some((tool) => tool.name === "finance_doctrine_teacher_feedback_candidate_input"),
    ).toBe(true);
  });
});
