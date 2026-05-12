import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("LCX system doctor train slice observability", () => {
  it("surfaces the latest balanced Qwen train slice in the guard summary", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("function summarizeTrainSliceEvent");
    expect(source).toContain('event.name === "train_slice"');
    expect(source).toContain("latestTrainSlice: summarizeTrainSliceEvent(latestTrainSlice)");
    expect(source).toContain("sourceDataDir: result.sourceDataDir");
    expect(source).toContain("policy: result.policy");
  });

  it("reads enough guard history to keep latestGuardStart visible during long runs", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("MINIMAX_GUARD_LOG_TAIL_LINES = 5_000");
    expect(source).toContain("readJsonlTail(MINIMAX_GUARD_LOG, MINIMAX_GUARD_LOG_TAIL_LINES)");
  });

  it("classifies the MiniMax saturator before matching its guard-log argument", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );
    const roleMap = source.slice(source.indexOf(".map((entry) => ({"));
    const saturatorIndex = roleMap.indexOf(
      'entry.command.includes("minimax-quota-brain-saturator")',
    );
    const guardIndex = roleMap.indexOf('entry.command.includes("minimax-brain-training-guard")');

    expect(saturatorIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(saturatorIndex).toBeLessThan(guardIndex);
  });

  it("does not count resolver-only adapter checks as active training guards", async () => {
    const doctorSource = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );
    const trainingPlanSource = await fs.readFile(
      path.join(repoRoot, "scripts/dev/local-brain-training-plan.ts"),
      "utf8",
    );

    expect(doctorSource).toContain('command.includes("--resolve-current-adapter")');
    expect(doctorSource).toContain("return false");
    expect(trainingPlanSource).toContain('!line.includes("--resolve-current-adapter")');
  });

  it("bounds live Lark probes so a stuck channel check cannot look successful", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("LIVE_LARK_DIAGNOSE_TIMEOUT_MS");
    expect(source).toContain("LIVE_CHANNEL_PROBE_TIMEOUT_MS");
    expect(source).toContain("DEFAULT_LIVE_CHANNEL_PROBE_TIMEOUT_MS = 90_000");
    expect(source).toContain("LIVE_CHANNEL_STATUS_STEP_TIMEOUT_MS");
    expect(source).toContain("async function liveOpenClawInvocation");
    expect(source).toContain("LIVE_SIDECAR_DIST_ENTRY");
    expect(source).toContain('source: "live-sidecar-dist"');
    expect(source).toContain("String(LIVE_CHANNEL_STATUS_STEP_TIMEOUT_MS)");
    expect(source).toContain("error: `${params.name} timed out after ${params.timeoutMs}ms`");
    expect(source).toMatch(
      /name: "channels-status-probe"[\s\S]*timeoutMs: LIVE_CHANNEL_PROBE_TIMEOUT_MS/u,
    );
    expect(source).toMatch(
      /name: "lark-loop-diagnose"[\s\S]*timeoutMs: LIVE_LARK_DIAGNOSE_TIMEOUT_MS/u,
    );
  });

  it("includes module-learning receipt review without writing review files by default", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("createModuleLearningPipelineReviewTool");
    expect(source).toContain("async function moduleLearningPipelineReviewCheck");
    expect(source).toContain('name: "module-learning-pipeline-review"');
    expect(source).toContain("scripts/dev/local-brain-promotion-audit.ts");
    expect(source).toContain("scripts/dev/lcx-agent-exam.ts");
    expect(source).toContain("scripts/dev/module-learning-pipeline-review.ts");
    expect(source).toContain("writeReview: false");
    expect(source).toContain("boundaryViolations === 0");
  });
});
