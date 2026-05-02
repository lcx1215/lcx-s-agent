import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools github project capability intake registration", () => {
  it("includes the github project capability intake tool", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    const tool = tools.find((candidate) => candidate.name === "github_project_capability_intake");
    expect(tool).toBeDefined();
    expect(tool?.parameters).toEqual(
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          repoName: expect.objectContaining({ type: "string" }),
          selectedFeature: expect.objectContaining({ type: "string" }),
          projectSummary: expect.objectContaining({ type: "string" }),
        }),
      }),
    );
  });
});
