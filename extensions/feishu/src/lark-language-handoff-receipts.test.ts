import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../../src/test-helpers/workspace.js";
import { writeLarkLanguageHandoffReceipt } from "./lark-language-handoff-receipts.js";

describe("lark language handoff receipts", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("writes a language-only handoff receipt with backend proof requirements", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-lark-handoff-receipt-");

    const result = await writeLarkLanguageHandoffReceipt({
      workspaceDir,
      generatedAt: "2026-04-30T12:00:00.000Z",
      agentId: "main",
      targetSurface: "learning_command",
      effectiveSurface: "learning_command",
      chatId: "oc-control",
      sessionKey: "session-1",
      messageId: "om_123",
      userMessage: "看看 GitHub 热榜项目哪些功能能加进来，我们内部有没有雏形",
      handoff: {
        family: "learning_external_source",
        source: "api",
        confidence: 0.91,
        targetSurface: "learning_command",
        deterministicSurface: "learning_command",
        backendToolContract: {
          toolName: "github_project_capability_intake",
          learningIntent: "看看 GitHub 热榜项目哪些功能能加进来，我们内部有没有雏形",
          sourceRequirement: "repo_url_or_readme_summary_required",
          expectedProof: ["capabilityFamily", "existingEmbryos", "adoptionDecision"],
        },
        notice: "handoff",
      },
    });

    expect(result.relativePath).toBe(
      "memory/lark-language-handoff-receipts/2026-04-30/om_123.json",
    );
    expect(result.artifact).toMatchObject({
      boundary: "language_handoff_only",
      noFinanceLearningArtifact: true,
      noExecutionApproval: true,
      noLiveProbeProof: true,
      handoff: {
        family: "learning_external_source",
        source: "api",
        backendToolContract: {
          toolName: "github_project_capability_intake",
        },
        expectedProof: ["capabilityFamily", "existingEmbryos", "adoptionDecision"],
        missingBeforeExecution: ["repo URL, README/docs summary, or selected feature summary"],
      },
    });

    const written = await fs.readFile(path.join(workspaceDir, result.relativePath), "utf8");
    expect(written).toContain('"boundary": "language_handoff_only"');
    expect(written).toContain('"github_project_capability_intake"');
  });
});
