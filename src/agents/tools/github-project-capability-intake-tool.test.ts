import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createGitHubProjectCapabilityIntakeTool } from "./github-project-capability-intake-tool.js";

function detailsOf(result: { details: unknown }) {
  return result.details as Record<string, unknown> & {
    capabilityFamily: string;
    adoptionDecision: { status: string; target: string; reason: string };
    existingEmbryos: Array<{ surface: string; path: string; fit: string }>;
    safetyBlockers: string[];
    receiptPath?: string;
  };
}

describe("github_project_capability_intake tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("maps a GitHub skills-runtime feature to existing LCX embryos without fetching or executing", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-github-capability-intake-");
    const tool = createGitHubProjectCapabilityIntakeTool({ workspaceDir });

    const result = await tool.execute("skills-intake", {
      repoName: "example/agent-skills",
      repoUrl: "https://github.com/example/agent-skills",
      selectedFeature: "portable skill packs and hook recipes",
      projectSummary:
        "The README describes skill packs, plugin hooks, and reusable workflow recipes for agent capability loading.",
      evidenceSnippets: ["Skills are disabled by default and loaded explicitly by name."],
    });

    const details = detailsOf(result);
    expect(details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "github_capability_intake_only",
        capabilityFamily: "skills_runtime",
        noRemoteFetchOccurred: true,
        noCodeExecutionOccurred: true,
        notInstalled: true,
        liveTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(details.adoptionDecision).toEqual(
      expect.objectContaining({
        status: "candidate_ready",
        target: "skill_candidate",
      }),
    );
    expect(details.existingEmbryos.map((entry) => entry.path)).toContain(
      "docs/concepts/system-prompt.md",
    );
  });

  it("does not classify skills marketplace wording as finance market research", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-github-capability-intake-");
    const tool = createGitHubProjectCapabilityIntakeTool({ workspaceDir });

    const result = await tool.execute("skills-marketplace-intake", {
      repoName: "example/skills-marketplace",
      selectedFeature: "skills marketplace",
      projectSummary:
        "The README describes reusable agent skills and installable packs for agent workflows.",
      evidenceSnippets: ["Skills are packaged as folders."],
    });

    const details = detailsOf(result);
    expect(details.capabilityFamily).toBe("skills_runtime");
    expect(details.adoptionDecision.target).toBe("skill_candidate");
  });

  it("requires manual review when a request asks to clone and run untrusted code", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-github-capability-intake-");
    const tool = createGitHubProjectCapabilityIntakeTool({ workspaceDir });

    const result = await tool.execute("unsafe-intake", {
      repoName: "example/agent-runner",
      selectedFeature: "auto install and clone-run plugin launcher",
      projectSummary:
        "The project asks the operator to auto install globally, clone and run untrusted repo scripts, then paste API key credentials.",
    });

    const details = detailsOf(result);
    expect(details.adoptionDecision).toEqual(
      expect.objectContaining({
        status: "manual_review_required",
        target: "blocked_until_safety_review",
      }),
    );
    expect(details.safetyBlockers).toEqual(
      expect.arrayContaining([
        "automatic_dependency_install_or_code_execution",
        "secret_or_private_data_risk",
      ]),
    );
    expect(details.nextPatch).toContain("Do not install");
  });

  it("writes a bounded receipt when requested", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-github-capability-intake-");
    const tool = createGitHubProjectCapabilityIntakeTool({ workspaceDir });

    const result = await tool.execute("eval-intake", {
      repoName: "example/agent-eval",
      selectedFeature: "trace eval smoke harness",
      projectSummary:
        "The repo documents benchmark eval traces and regression smoke scoring for agent workflow quality.",
      requestedAdoptionMode: "eval",
      writeReceipt: true,
      tags: ["eval", "trace"],
    });

    const details = detailsOf(result);
    expect(details.capabilityFamily).toBe("eval_trace");
    expect(details.adoptionDecision.target).toBe("eval_candidate");
    expect(details.receiptPath).toMatch(
      /^memory\/github-capability-intake\/\d{4}-\d{2}-\d{2}\/example-agent-eval-trace-eval-smoke-harness\.md$/u,
    );
    const receipt = await fs.readFile(path.join(workspaceDir, details.receiptPath ?? ""), "utf8");
    expect(receipt).toContain("# GitHub Project Capability Intake");
    expect(receipt).toContain("- noRemoteFetchOccurred: true");
    expect(receipt).toContain("eval_candidate");
  });
});
