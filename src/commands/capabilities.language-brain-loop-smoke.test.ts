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
    expect(payload.brain.candidateCount).toBe(4);
    expect(payload.brain.synthesisMode).toBe("multi_capability_synthesis");
    expect(payload.analysis.eventReviewStatus).toBe("research_review_ready");
    expect(payload.analysis.noActionBoundary).toBe(true);
    expect(payload.protectedMemoryUntouched).toBe(true);
    expect(payload.languageCorpusUntouched).toBe(true);
    expect(payload.noRemoteFetchOccurred).toBe(true);
    expect(payload.noExecutionAuthority).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, payload.memory.loopReceiptPath))).toBe(true);
  });
});
