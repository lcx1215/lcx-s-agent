import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("LCX system doctor train slice observability", () => {
  it("surfaces the latest balanced Qwen train slice in the guard summary", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"),
      "utf8",
    );

    const trainingPlanSource = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-training-plan.ts"),
      "utf8",
    );

    expect(source).toContain('owner: "local-brain-training-plan"');
    expect(source).toContain("latestTrainSlice: plan.latestTrainSlice");
    expect(trainingPlanSource).toContain('event.name === "train_slice"');
    expect(trainingPlanSource).toContain("sourceDataDir: record.sourceDataDir");
    expect(trainingPlanSource).toContain("policy: record.policy");
  });

  it("surfaces MiniMax quota sidecar status separately from teacher quality", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"),
      "utf8",
    );
    const trainingPlanSource = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-training-plan.ts"),
      "utf8",
    );

    expect(source).toContain("latestQuotaStatus: plan.latestQuotaStatus");
    expect(trainingPlanSource).toContain('event.event === "quota_saturator_start"');
    expect(trainingPlanSource).toContain('event.event === "quota_saturator_complete"');
    expect(trainingPlanSource).toContain("stopReason: typeof event.stopReason");
    expect(trainingPlanSource).toContain("targetCalls: typeof plan.targetCalls");
  });

  it("delegates local-brain runtime truth to local-brain-training-plan", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("buildLocalBrainTrainingPlan");
    expect(source).toContain("planBoundary: plan.boundary");
    expect(source).toContain("decisionIds");
    expect(source).not.toContain("readJsonlTail(MINIMAX_GUARD_LOG");
  });

  it("classifies the MiniMax saturator before matching its guard-log argument", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-training-plan.ts"),
      "utf8",
    );
    const roleMap = source.slice(source.indexOf("function activeTrainingRole"));
    const saturatorIndex = roleMap.indexOf('command.includes("minimax-quota-brain-saturator")');
    const guardIndex = roleMap.indexOf('command.includes("minimax-brain-training-guard")');

    expect(saturatorIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(saturatorIndex).toBeLessThan(guardIndex);
  });

  it("does not count resolver-only adapter checks as active training guards", async () => {
    const doctorSource = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"),
      "utf8",
    );
    const trainingPlanSource = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-training-plan.ts"),
      "utf8",
    );

    expect(doctorSource).toContain("buildLocalBrainTrainingPlan");
    expect(doctorSource).toContain("localBrainCurrentAdapterFromTrainingPlan");
    expect(doctorSource).toContain('selectionMode: "training-plan-latest-passing"');
    expect(doctorSource).toContain("selectedCleanAdapter");
    expect(doctorSource).not.toContain('"--resolve-current-adapter"');
    expect(doctorSource).not.toContain('command.includes("--resolve-current-adapter")');
    expect(trainingPlanSource).toContain('!line.includes("--resolve-current-adapter")');
  });

  it("bounds live External probes so a stuck channel check cannot look successful", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("LIVE_CHANNEL_PROBE_TIMEOUT_MS");
    expect(source).toContain("DEFAULT_LIVE_CHANNEL_PROBE_TIMEOUT_MS = 90_000");
    expect(source).toContain("LIVE_CHANNEL_STATUS_STEP_TIMEOUT_MS");
    expect(source).toContain("async function liveOpenClawInvocation");
    expect(source).toContain("LIVE_SIDECAR_DIST_ENTRY");
    expect(source).toContain('source: "external-channel-runtime-dist"');
    expect(source).toContain("String(LIVE_CHANNEL_STATUS_STEP_TIMEOUT_MS)");
    expect(source).toContain("error: `${params.name} timed out after ${params.timeoutMs}ms`");
    expect(source).toMatch(
      /name: "channels-status-probe"[\s\S]*timeoutMs: LIVE_CHANNEL_PROBE_TIMEOUT_MS/u,
    );
    expect(source).toMatch(
      /name: "external-channel-status"[\s\S]*timeoutMs: EXTERNAL_CHANNEL_BINDING_TIMEOUT_MS/u,
    );
  });

  it("includes module-learning receipt review without writing review files by default", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("createModuleLearningPipelineReviewTool");
    expect(source).toContain("async function moduleLearningPipelineReviewCheck");
    expect(source).toContain('name: "module-learning-pipeline-review"');
    expect(source).toContain('name: "problem-cluster-radar"');
    expect(source).toContain('name: "live-fadeout-audit"');
    expect(source).toContain("scripts/operator/lcx-problem-cluster-radar.ts");
    expect(source).toContain("scripts/operator/lcx-live-fadeout-audit.ts");
    expect(source).toContain("scripts/operator/local-brain-promotion-audit.ts");
    expect(source).toContain("scripts/operator/lcx-agent-exam.ts");
    expect(source).toContain("scripts/operator/module-learning-pipeline-review.ts");
    expect(source).toContain("writeReview: false");
    expect(source).toContain("boundaryViolations === 0");
  });
});
