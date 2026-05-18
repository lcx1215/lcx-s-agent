import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildProblemClusterRadar } from "../scripts/dev/lcx-problem-cluster-radar.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 24 * 1024 * 1024;

function owner(owner: string, payload: Record<string, unknown>) {
  return {
    ok: true,
    owner,
    command: `${owner} --json`,
    payload,
  };
}

async function runJsonScript(script: string) {
  try {
    return await execFileAsync(process.execPath, ["--import", "tsx", script, "--json"], {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [
        details.message ?? String(error),
        `stdout=${details.stdout ?? ""}`,
        `stderr=${details.stderr ?? ""}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

describe("lcx-problem-cluster-radar", () => {
  it("aggregates owner outputs into actionable problem clusters without owning truth", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        latestEval: {
          at: "2026-05-18T10:00:00.000Z",
          passed: 77,
          total: 77,
          promotionReady: false,
          parseRecoveredCaseIds: ["data_provenance_quality_gate"],
        },
        latestEvalTimeout: {
          at: "2026-05-18T11:00:00.000Z",
          name: "stable_hardened_eval",
          timeoutReason: "total_timeout",
        },
        stableEvalTimeoutCountAfterLatestStart: 4,
        qwenCapabilityConsolidation: {
          consolidationState: "candidate_capabilities_not_yet_consolidated",
          selectedCleanAdapter: "/tmp/r2",
        },
        decisions: [
          {
            id: "eval_pending_after_latest_start",
            action: "wait_for_current_hardened_eval_before_repairing",
            reason: "Latest eval is older than latest guard_start.",
          },
          {
            id: "stable_eval_timeout_after_latest_start",
            action: "hold_promotion_and_repair_eval_runtime_or_scope",
            reason: "stable_hardened_eval timeouts this guard=4.",
            codexRepairEligible: false,
          },
          {
            id: "module_learning_incomplete_evidence",
            action: "complete_module_learning_evidence_before_claiming_absorption",
            reason: "8 module-learning receipt(s) are not eval_absorbed yet.",
          },
        ],
      }),
      moduleAbsorption: owner("lcx-module-learning-absorption-gate", {
        absorptionReady: false,
        gateDecision: "hold_at_application_ready",
        counts: { evalAbsorbed: 0, missingAbsorptionEvidenceReceipts: 8 },
        blockers: [
          "latest_hardened_eval_timeout_newer_than_absorption_evidence",
          "module_receipts_not_eval_absorbed",
        ],
      }),
      mindModel: owner("lcx-mind-model", { actionableFailures: [] }),
      flowGraph: owner("lcx-flow-graph", { actionableFailures: [] }),
      contextRecovery: owner("lcx-context-recovery-exam", { actionableFailures: [] }),
      learningSedimentationAudit: owner("lcx-learning-sedimentation-audit", {
        sufficientForCurrentUse: true,
        gaps: [],
      }),
      learningSedimentationMap: owner("lcx-learning-sedimentation-map", {
        riskyConflations: [],
      }),
      systemMemoryGate: owner("lcx-system-memory-sedimentation-gate", {
        recallClaimReady: true,
        blockers: [],
      }),
      changeImpact: owner("lcx-change-impact-plan", {
        changedFiles: [],
        unmatchedFiles: [],
      }),
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_problem_cluster_radar_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(result.actionableClusters).toEqual(
      expect.arrayContaining(["training_eval_runtime_cluster", "adapter_promotion_truth_cluster"]),
    );
    expect(result.actionableClusters).not.toContain("module_learning_absorption_cluster");
    expect(result.blockedClusters).toContain("module_learning_absorption_cluster");
    expect(result.clusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "training_eval_runtime_cluster",
          ownerEntrypoint: "scripts/dev/local-brain-training-plan.ts",
          severity: "P2",
          actionability: "repair_now",
          sourceOwners: ["local-brain-training-plan"],
        }),
        expect.objectContaining({
          id: "module_learning_absorption_cluster",
          ownerEntrypoint: "scripts/dev/lcx-module-learning-absorption-gate.ts",
          severity: "P2",
          actionability: "blocked_by_owner_gate",
          blockingReasons: expect.arrayContaining([
            "latest_hardened_eval_timeout_newer_than_absorption_evidence",
          ]),
        }),
      ]),
    );
    const trainingCluster = result.clusters.find(
      (cluster) => cluster.id === "training_eval_runtime_cluster",
    );
    expect(trainingCluster?.signals.map((signal) => signal.id)).toEqual(
      expect.arrayContaining([
        "stable_eval_timeout_after_latest_start",
        "latest_eval_timeout_visible",
        "repeated_stable_eval_timeout",
      ]),
    );
  });

  it("treats sedimentation map conflation rules as guardrails, not active incidents", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        latestEval: { passed: 77, total: 77, promotionReady: true, parseRecoveredCaseIds: [] },
        decisions: [],
      }),
      moduleAbsorption: owner("lcx-module-learning-absorption-gate", {
        absorptionReady: true,
        blockers: [],
      }),
      mindModel: owner("lcx-mind-model", { actionableFailures: [] }),
      flowGraph: owner("lcx-flow-graph", { actionableFailures: [] }),
      contextRecovery: owner("lcx-context-recovery-exam", { actionableFailures: [] }),
      learningSedimentationAudit: owner("lcx-learning-sedimentation-audit", {
        sufficientForCurrentUse: true,
        gaps: [],
      }),
      learningSedimentationMap: owner("lcx-learning-sedimentation-map", {
        summary: { languageCorpusSeparated: true },
        riskyConflations: [
          {
            from: "language_routing_corpus_boundary",
            to: "brain_distillation_training_material",
            rule: "language_corpus_must_not_be_mixed_with_brain_distillation_artifacts",
          },
        ],
      }),
      systemMemoryGate: owner("lcx-system-memory-sedimentation-gate", {
        recallClaimReady: true,
        blockers: [],
      }),
      changeImpact: owner("lcx-change-impact-plan", {
        changedFiles: [],
        unmatchedFiles: [],
      }),
    });

    expect(result.clusters.map((cluster) => cluster.id)).not.toContain(
      "learning_sedimentation_cluster",
    );
    expect(result.actionableClusters).not.toContain("learning_sedimentation_cluster");
  });

  it("surfaces real sedimentation audit gap objects with their severity", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        latestEval: { passed: 77, total: 77, promotionReady: true, parseRecoveredCaseIds: [] },
        decisions: [],
      }),
      moduleAbsorption: owner("lcx-module-learning-absorption-gate", {
        absorptionReady: true,
        blockers: [],
      }),
      mindModel: owner("lcx-mind-model", { actionableFailures: [] }),
      flowGraph: owner("lcx-flow-graph", { actionableFailures: [] }),
      contextRecovery: owner("lcx-context-recovery-exam", { actionableFailures: [] }),
      learningSedimentationAudit: owner("lcx-learning-sedimentation-audit", {
        sufficientForCurrentUse: true,
        gaps: [
          {
            id: "module_learning_review_has_weak_receipts",
            severity: "P2",
            meaning: "Some module-learning receipts are still weak.",
          },
        ],
      }),
      learningSedimentationMap: owner("lcx-learning-sedimentation-map", {
        summary: { languageCorpusSeparated: true },
        riskyConflations: [],
      }),
      systemMemoryGate: owner("lcx-system-memory-sedimentation-gate", {
        recallClaimReady: true,
        blockers: [],
      }),
      changeImpact: owner("lcx-change-impact-plan", {
        changedFiles: [],
        unmatchedFiles: [],
      }),
    });

    const cluster = result.clusters.find((entry) => entry.id === "learning_sedimentation_cluster");
    expect(cluster).toEqual(
      expect.objectContaining({
        severity: "P2",
      }),
    );
    expect(cluster?.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "module_learning_review_has_weak_receipts",
          severity: "P2",
          summary: "Some module-learning receipts are still weak.",
        }),
      ]),
    );
  });

  it("is registered in durable architecture surfaces and can run against current owners", async () => {
    const { stdout } = await runJsonScript("scripts/dev/lcx-problem-cluster-radar.ts");
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      summary: { sourceOwners: string[]; clusters: number };
      clusters: Array<{ id: string; ownerEntrypoint: string; sourceOwners: string[] }>;
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
    };

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_problem_cluster_radar_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary.sourceOwners).toEqual(
      expect.arrayContaining([
        "local-brain-training-plan",
        "lcx-module-learning-absorption-gate",
        "lcx-mind-model",
        "lcx-flow-graph",
      ]),
    );
    expect(payload.clusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerEntrypoint: expect.stringContaining("scripts/dev/"),
          sourceOwners: expect.any(Array),
        }),
      ]),
    );
  }, 240_000);
});
