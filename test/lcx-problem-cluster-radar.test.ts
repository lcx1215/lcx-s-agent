import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildProblemClusterRadar,
  isIsoTimeSameOrAfter,
} from "../scripts/dev/lcx-problem-cluster-radar.js";

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
  it("compares ISO timestamps by instant instead of local string shape", () => {
    expect(isIsoTimeSameOrAfter("2026-05-19T13:20:46-04:00", "2026-05-19T14:35:30.371Z")).toBe(
      true,
    );
    expect(isIsoTimeSameOrAfter("2026-05-19T10:20:46-04:00", "2026-05-19T14:35:30.371Z")).toBe(
      false,
    );
  });

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

  it("does not treat an empty same-day module gate as a blocker when cumulative absorption is clean", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        latestEval: { passed: 201, total: 201, promotionReady: true, parseRecoveredCaseIds: [] },
        decisions: [],
      }),
      moduleAbsorption: owner("lcx-module-learning-absorption-gate", {
        absorptionReady: false,
        gateDecision: "hold_at_application_ready",
        counts: {
          planReceiptFiles: 0,
          reviewRows: 0,
          evalAbsorbed: 0,
          boundaryViolations: 0,
        },
        blockers: ["module_learning_review_missing"],
        writeAvailable: false,
      }),
      mindModel: owner("lcx-mind-model", { actionableFailures: [] }),
      flowGraph: owner("lcx-flow-graph", { actionableFailures: [] }),
      contextRecovery: owner("lcx-context-recovery-exam", { actionableFailures: [] }),
      learningSedimentationAudit: owner("lcx-learning-sedimentation-audit", {
        sufficientForCurrentUse: true,
        gaps: [],
        chains: {
          moduleLearningPipeline: {
            ok: true,
            cumulativeEvalAbsorbed: 24,
            cumulativeBoundaryViolations: 0,
            latestReview: {
              evalAbsorbed: 8,
              weakModuleLearning: 0,
              boundaryViolations: 0,
            },
          },
        },
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

    expect(result.clusters.map((cluster) => cluster.id)).not.toContain(
      "module_learning_absorption_cluster",
    );
    expect(result.blockedClusters).not.toContain("module_learning_absorption_cluster");
  });

  it("folds guard adapter mismatch into adapter promotion truth", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        activeProcesses: [{ pid: 101, role: "guard" }],
        latestEval: { passed: 200, total: 200, promotionReady: true, parseRecoveredCaseIds: [] },
        activeGuardAdapterTruth: {
          boundary: "dev_active_guard_adapter_truth_only",
          guardCurrentAdapter: "/tmp/adapter-stale-r1",
          selectedCleanAdapter: "/tmp/adapter-clean-r2",
          latestPromotedAdapter: "/tmp/adapter-clean-r2",
          mismatchReasons: ["guard_current_adapter_not_selected_clean"],
        },
        decisions: [
          {
            id: "guard_adapter_mismatch",
            action: "wait_for_active_guard_then_restart_with_selected_clean_adapter",
            reason: "Active guard currentAdapter differs from selectedCleanAdapter.",
            codexRepairEligible: false,
          },
        ],
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

    const cluster = result.clusters.find((entry) => entry.id === "adapter_promotion_truth_cluster");
    expect(cluster).toEqual(
      expect.objectContaining({
        severity: "P2",
        actionability: "blocked_by_owner_gate",
        blockingReasons: expect.arrayContaining([
          "guard_adapter_mismatch_not_repairable_while_guard_active",
        ]),
      }),
    );
    expect(cluster?.signals.map((signal) => signal.id)).toEqual(
      expect.arrayContaining(["guard_adapter_mismatch", "active_guard_adapter_truth_mismatch"]),
    );
  });

  it("folds live Lark brain binding proof gaps into adapter promotion truth", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        activeProcesses: [{ pid: 101, role: "local_brain_eval" }],
        latestEval: { passed: 200, total: 200, promotionReady: true, parseRecoveredCaseIds: [] },
        qwenCapabilityConsolidation: {
          consolidationState: "selected_clean_adapter",
          selectedCleanAdapter: "/tmp/adapter-clean-r2",
        },
        liveLarkBrainBinding: {
          boundary: "dev_live_lark_brain_binding_plan_only",
          selectedCleanAdapter: "/tmp/adapter-clean-r2",
          status: "deferred_active_training_or_eval",
          action: "wait_for_current_eval_then_bind_live_to_selected_clean_adapter",
          missingProof: [
            "current_training_eval_or_mlx_finished",
            "fresh_real_lark_inbound_and_outbound_seen",
          ],
        },
        decisions: [
          {
            id: "live_lark_brain_binding_deferred",
            action: "wait_for_current_eval_then_bind_live_to_selected_clean_adapter",
            reason: "active eval still running",
            codexRepairEligible: false,
          },
        ],
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

    const cluster = result.clusters.find((entry) => entry.id === "adapter_promotion_truth_cluster");
    expect(cluster).toEqual(
      expect.objectContaining({
        severity: "P3",
        actionability: "blocked_by_owner_gate",
        blockingReasons: expect.arrayContaining([
          "active_local_brain_guard_or_eval",
          "live_lark_brain_binding_waiting_for_owner_proof",
        ]),
      }),
    );
    expect(cluster?.signals.map((signal) => signal.id)).toEqual(
      expect.arrayContaining([
        "live_lark_brain_binding_deferred",
        "live_lark_brain_binding_not_ready",
      ]),
    );
  });

  it("does not call stale latest-promoted truth an active guard adapter mismatch", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        activeProcesses: [{ pid: 101, role: "guard" }],
        latestEval: { passed: 200, total: 200, promotionReady: true, parseRecoveredCaseIds: [] },
        activeGuardAdapterTruth: {
          boundary: "dev_active_guard_adapter_truth_only",
          guardCurrentAdapter: "/tmp/adapter-clean-r2",
          selectedCleanAdapter: "/tmp/adapter-clean-r2",
          latestPromotedAdapter: "/tmp/adapter-stale-promoted-r1",
          mismatchReasons: [],
          stalePromotionReasons: ["latest_promoted_adapter_no_longer_selected_clean"],
        },
        decisions: [
          {
            id: "latest_promoted_adapter_not_selected_clean",
            action: "keep_selected_clean_adapter_and_wait_for_promotion_audit",
            reason: "latestPromotedAdapter is no longer selected clean.",
            codexRepairEligible: false,
          },
        ],
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

    const cluster = result.clusters.find((entry) => entry.id === "adapter_promotion_truth_cluster");
    expect(cluster?.signals.map((signal) => signal.id)).toEqual(
      expect.arrayContaining([
        "latest_promoted_adapter_not_selected_clean",
        "latest_promoted_adapter_stale",
      ]),
    );
    expect(cluster?.signals.map((signal) => signal.id)).not.toContain(
      "active_guard_adapter_truth_mismatch",
    );
    expect(cluster?.blockingReasons).not.toContain(
      "guard_adapter_mismatch_not_repairable_while_guard_active",
    );
  });

  it("reports parseRecovered promotion blocks with the current eval pass count", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        latestEval: {
          at: "2026-05-18T21:05:19.003Z",
          passed: 200,
          total: 200,
          promotionReady: false,
          parseRecoveredCaseIds: ["core_options_event_boundary_02"],
        },
        qwenCapabilityConsolidation: {
          consolidationState: "candidate_capabilities_not_yet_consolidated",
          selectedCleanAdapter: "/tmp/r4",
        },
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

    const cluster = result.clusters.find((entry) => entry.id === "adapter_promotion_truth_cluster");
    const signal = cluster?.signals.find(
      (entry) => entry.id === "parse_recovered_blocks_promotion",
    );
    expect(signal).toEqual(
      expect.objectContaining({
        summary: "parseRecovered exists, so 200/200 is not a clean promotion proof",
        evidence: expect.objectContaining({
          passed: 200,
          total: 200,
          parseRecoveredCaseIds: ["core_options_event_boundary_02"],
        }),
      }),
    );
  });

  it("does not keep stale eval timeouts as watch clusters after a newer eval verdict", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        latestEval: {
          at: "2026-05-18T12:00:00.000Z",
          passed: 77,
          total: 77,
          promotionReady: true,
          parseRecoveredCaseIds: [],
        },
        latestEvalTimeout: {
          at: "2026-05-18T11:00:00.000Z",
          name: "stable_hardened_eval",
          timeoutReason: "total_timeout",
        },
        stableEvalTimeoutCountAfterLatestStart: 0,
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

    expect(result.clusters.map((cluster) => cluster.id)).not.toContain(
      "training_eval_runtime_cluster",
    );
  });

  it("blocks active eval-timeout repair when the training owner says Codex cannot repair yet", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        activeProcesses: [{ pid: 101, role: "guard" }],
        latestEval: { passed: 200, total: 200, promotionReady: true, parseRecoveredCaseIds: [] },
        latestEvalTimeout: {
          at: "2026-05-19T05:03:22.610Z",
          timeoutReason: "total_timeout",
        },
        stableEvalTimeoutCountAfterLatestStart: 1,
        decisions: [
          {
            id: "stable_eval_timeout_after_latest_start",
            action: "hold_promotion_and_repair_eval_runtime_or_scope",
            reason: "Latest stable_hardened_eval timed out after latest guard_start.",
            codexRepairEligible: false,
          },
        ],
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

    const cluster = result.clusters.find((entry) => entry.id === "training_eval_runtime_cluster");
    expect(cluster).toEqual(
      expect.objectContaining({
        severity: "P2",
        actionability: "blocked_by_owner_gate",
        blockingReasons: ["active_local_brain_guard_or_eval"],
      }),
    );
    expect(result.actionableClusters).not.toContain("training_eval_runtime_cluster");
    expect(result.blockedClusters).toContain("training_eval_runtime_cluster");
  });

  it("preserves repairable sub-signals when a mixed training cluster is owner-blocked", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        activeProcesses: [{ pid: 101, role: "guard" }],
        latestEval: { passed: 201, total: 201, promotionReady: false, parseRecoveredCaseIds: [] },
        latestEvalTimeout: {
          at: "2026-05-19T05:03:22.610Z",
          timeoutReason: "total_timeout",
        },
        stableEvalTimeoutCountAfterLatestStart: 1,
        decisions: [
          {
            id: "stable_eval_timeout_after_latest_start",
            action: "hold_promotion_and_repair_eval_runtime_or_scope",
            reason: "Latest stable_hardened_eval timed out after latest guard_start.",
            codexRepairEligible: false,
          },
          {
            id: "teacher_sample_quality_failure",
            action: "repair_teacher_filter_or_prompt_if_pattern_repeats",
            reason: "SyntaxError: Expected double-quoted property name in JSON.",
            codexRepairEligible: true,
          },
        ],
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

    expect(result.actionableClusters).not.toContain("training_eval_runtime_cluster");
    expect(result.blockedClusters).toContain("training_eval_runtime_cluster");
    expect(result.summary.repairableSignals).toBe(1);
    expect(result.repairableSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clusterId: "training_eval_runtime_cluster",
          signalId: "teacher_sample_quality_failure",
          ownerEntrypoint: "scripts/dev/local-brain-training-plan.ts",
        }),
      ]),
    );
    expect(result.repairableActions).toEqual(
      expect.arrayContaining([
        "training_eval_runtime_cluster/teacher_sample_quality_failure: repair_teacher_filter_or_prompt_if_pattern_repeats",
      ]),
    );
  });

  it("moves already-repaired sub-signals into pending owner verification", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        activeProcesses: [{ pid: 101, role: "guard" }],
        latestTeacher: {
          at: "2026-05-19T14:35:30.371Z",
          failures: 1,
        },
        latestEval: { passed: 201, total: 201, promotionReady: false, parseRecoveredCaseIds: [] },
        decisions: [
          {
            id: "teacher_sample_quality_failure",
            action: "repair_teacher_filter_or_prompt_if_pattern_repeats",
            reason: "SyntaxError: Expected double-quoted property name in JSON.",
            codexRepairEligible: true,
          },
        ],
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
      repairVerification: {
        "training_eval_runtime_cluster/teacher_sample_quality_failure": {
          status: "pending_owner_verification",
          repairedAt: "2026-05-19T17:18:00.000Z",
          commit: "6a0091c73e",
          files: [
            "scripts/dev/minimax-brain-teacher-batch.ts",
            "test/minimax-brain-teacher-batch.test.ts",
          ],
          reason: "newer teacher parser repair commit",
        },
      },
    });

    expect(result.summary.repairableSignals).toBe(0);
    expect(result.summary.pendingVerificationSignals).toBe(1);
    expect(result.repairableActions).toEqual([]);
    expect(result.pendingVerificationSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clusterId: "training_eval_runtime_cluster",
          signalId: "teacher_sample_quality_failure",
          status: "pending_owner_verification",
          commit: "6a0091c73e",
          ownerVerificationRequired: true,
        }),
      ]),
    );
    expect(result.pendingVerificationActions).toEqual(
      expect.arrayContaining([
        "training_eval_runtime_cluster/teacher_sample_quality_failure: wait_for_owner_verification commit=6a0091c73e",
      ]),
    );
  });

  it("keeps Codex-repairable teacher and output-contract decisions actionable during active training", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        activeProcesses: [{ pid: 101, role: "guard" }],
        latestEval: { passed: 201, total: 201, promotionReady: false, parseRecoveredCaseIds: [] },
        decisions: [
          {
            id: "output_contract_or_parser_failure",
            action: "enter_codex_auto_repair_if_repeated",
            reason: "Eval evidence contains JSON/parser output-contract signals.",
            codexRepairEligible: true,
          },
          {
            id: "teacher_sample_quality_failure",
            action: "repair_teacher_filter_or_prompt_if_pattern_repeats",
            reason: "SyntaxError: Expected double-quoted property name in JSON.",
            codexRepairEligible: true,
          },
        ],
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

    const cluster = result.clusters.find((entry) => entry.id === "training_eval_runtime_cluster");
    expect(cluster).toEqual(
      expect.objectContaining({
        severity: "P2",
        actionability: "repair_now",
      }),
    );
    expect(cluster?.signals.map((signal) => signal.id)).toEqual(
      expect.arrayContaining([
        "output_contract_or_parser_failure",
        "teacher_sample_quality_failure",
      ]),
    );
    expect(result.actionableClusters).toContain("training_eval_runtime_cluster");
    expect(result.blockedClusters).not.toContain("training_eval_runtime_cluster");
  });

  it("surfaces the Qwen and agent evolution acceleration queue from the training owner", () => {
    const result = buildProblemClusterRadar({
      trainingPlan: owner("local-brain-training-plan", {
        boundary: "dev_local_brain_training_plan_only",
        activeProcesses: [{ pid: 101, role: "guard" }],
        latestEval: { passed: 205, total: 205, promotionReady: true, parseRecoveredCaseIds: [] },
        decisions: [{ id: "training_already_active", codexRepairEligible: false }],
        evolutionAccelerationQueue: {
          boundary: "dev_evolution_acceleration_queue_only",
          activeTrainingOrEval: true,
          canStartHeavyWorkNow: false,
          readyNowCount: 0,
          idleOnlyCount: 0,
          blockedCount: 2,
          fastestSafeNextAction: "wait_for_current_training_eval_then_run_idle_queue",
          steps: [
            {
              id: "targeted_challenger_eval_first",
              lane: "adapter_promotion",
              status: "blocked_by_active_training",
              executionClass: "idle_only_heavy_eval",
              blockedByDecisionIds: ["training_already_active"],
            },
            {
              id: "close_module_learning_exact_proof_gaps",
              lane: "module_learning",
              status: "blocked_by_missing_proof",
              executionClass: "read_only",
              blockedByDecisionIds: ["module_learning_incomplete_evidence"],
            },
          ],
        },
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

    const cluster = result.clusters.find((entry) => entry.id === "evolution_acceleration_cluster");
    expect(cluster).toEqual(
      expect.objectContaining({
        severity: "P3",
        actionability: "blocked_by_owner_gate",
        blockingReasons: ["active_local_brain_guard_or_eval_or_missing_absorption_proof"],
      }),
    );
    expect(cluster?.signals.map((signal) => signal.id)).toContain(
      "evolution_acceleration_idle_queue",
    );
    expect(result.blockedClusters).toContain("evolution_acceleration_cluster");
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

  it("surfaces external agent upgrade drift instead of letting new projects become parallel systems", () => {
    const result = buildProblemClusterRadar({
      externalAgentUpgrade: owner("lcx-external-agent-upgrade-radar", {
        ok: true,
        boundary: "dev_external_agent_upgrade_radar_only",
        summary: {
          registeredCandidateCount: 4,
          architectureIntegratedCount: 4,
          runtimeAuthorityGrantedCount: 1,
          perfectIntegrationClaim: true,
        },
      }),
    });

    expect(result.actionableClusters).toContain("external_agent_upgrade_cluster");
    const cluster = result.clusters.find((entry) => entry.id === "external_agent_upgrade_cluster");
    expect(cluster).toEqual(
      expect.objectContaining({
        family: "external_agent_upgrade_distillation",
        severity: "P1",
        ownerEntrypoint: "scripts/dev/lcx-external-agent-upgrade-radar.ts",
      }),
    );
    expect(cluster?.signals.map((signal) => signal.id)).toEqual(
      expect.arrayContaining([
        "external_agent_candidate_count_drift",
        "external_agent_owner_mapping_drift",
        "external_agent_runtime_authority_granted",
        "external_agent_perfect_integration_overclaim",
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
    expect(payload.clusters.map((cluster) => cluster.id)).not.toContain(
      "owner_output_availability_cluster",
    );
  }, 240_000);
});
