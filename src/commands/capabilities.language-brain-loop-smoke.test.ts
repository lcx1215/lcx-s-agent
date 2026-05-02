import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { languageBrainLoopSmokeCommand } from "./capabilities.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();

describe("languageBrainLoopSmokeCommand", () => {
  beforeEach(() => {
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("runs the local language-brain-analysis-memory loop and writes a receipt", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-loop-smoke-test-"));
    await languageBrainLoopSmokeCommand({ workspaceDir, json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      ok: boolean;
      workspaceDir: string;
      language: { family: string; backendTool: string };
      brain: { candidateCount: number; synthesisMode: string };
      analysis: { eventReviewStatus: string; noActionBoundary: boolean };
      math: {
        localTool: string;
        checks: string[];
        rollingBetaWindows: number;
        noModelMathGuessing: boolean;
      };
      review: {
        tier: string;
        reviewers: string[];
        tokenPolicy: string;
        reasons: string[];
      };
      reviewPanel: {
        status: string;
        tier: string;
        providerCallsMade: boolean;
        reviewerTasks: unknown[];
      };
      memory: { loopReceiptPath: string };
      protectedMemoryUntouched: boolean;
      languageCorpusUntouched: boolean;
      noRemoteFetchOccurred: boolean;
      noExecutionAuthority: boolean;
    };

    expect(payload.ok).toBe(true);
    expect(payload.workspaceDir).toBe(workspaceDir);
    expect(payload.language.family).toBe("market_capability_learning_intake");
    expect(payload.language.backendTool).toBe("finance_learning_pipeline_orchestrator");
    expect(payload.brain.candidateCount).toBe(6);
    expect(payload.brain.synthesisMode).toBe("multi_capability_synthesis");
    expect(payload.analysis.eventReviewStatus).toBe("research_review_ready");
    expect(payload.analysis.noActionBoundary).toBe(true);
    expect(payload.math.localTool).toBe("quant_math");
    expect(payload.math.checks).toEqual([
      "risk_budget_deviation",
      "rolling_beta",
      "drawdown_duration",
      "calmar_ratio",
    ]);
    expect(payload.math.rollingBetaWindows).toBe(4);
    expect(payload.math.noModelMathGuessing).toBe(true);
    expect(payload.review.tier).toBe("single_model_review");
    expect(payload.review.reviewers).toEqual(["primary_model_editor"]);
    expect(payload.review.tokenPolicy).toBe("use_primary_model");
    expect(payload.review.reasons).toContain("has_quant_math_results");
    expect(payload.reviewPanel.status).toBe("single_model_review_required");
    expect(payload.reviewPanel.tier).toBe("single_model_review");
    expect(payload.reviewPanel.providerCallsMade).toBe(false);
    expect(payload.reviewPanel.reviewerTasks).toEqual([]);
    expect(payload.protectedMemoryUntouched).toBe(true);
    expect(payload.languageCorpusUntouched).toBe(true);
    expect(payload.noRemoteFetchOccurred).toBe(true);
    expect(payload.noExecutionAuthority).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, payload.memory.loopReceiptPath))).toBe(true);
  });
});
