import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_GUARD_LOG_PATH, DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";
import { buildLocalBrainTrainingPlan } from "./local-brain-training-plan.ts";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const EXEC_MAX_BUFFER = 24 * 1024 * 1024;

type Severity = "P1" | "P2" | "P3" | "info";
type ClusterActionability = "repair_now" | "blocked_by_owner_gate" | "watch";

type OwnerSnapshot = {
  ok: boolean;
  owner: string;
  command: string;
  payload?: Record<string, unknown>;
  error?: string;
};

type ProblemSignal = {
  id: string;
  severity: Severity;
  summary: string;
  evidence?: unknown;
};

type ProblemCluster = {
  id: string;
  family: string;
  severity: Severity;
  actionability: ClusterActionability;
  blockingReasons: string[];
  ownerEntrypoint: string;
  sourceOwners: string[];
  signals: ProblemSignal[];
  nextAction: string;
  boundary: "dev_problem_cluster_radar_only";
};

type RadarInputs = {
  trainingPlan?: OwnerSnapshot;
  moduleAbsorption?: OwnerSnapshot;
  mindModel?: OwnerSnapshot;
  flowGraph?: OwnerSnapshot;
  contextRecovery?: OwnerSnapshot;
  learningSedimentationAudit?: OwnerSnapshot;
  learningSedimentationMap?: OwnerSnapshot;
  systemMemoryGate?: OwnerSnapshot;
  changeImpact?: OwnerSnapshot;
};

type CliOptions = {
  json: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-problem-cluster-radar.ts [--json]",
      "",
      "Aggregates existing LCX owner outputs into problem clusters.",
      "It does not become a new truth owner and does not touch live/provider/protected memory.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).filter((item): item is string => typeof item === "string");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function severityValue(value: unknown): Severity {
  return value === "P1" || value === "P2" || value === "P3" || value === "info" ? value : "P3";
}

function severityRank(severity: Severity): number {
  if (severity === "P1") {
    return 3;
  }
  if (severity === "P2") {
    return 2;
  }
  if (severity === "P3") {
    return 1;
  }
  return 0;
}

function maxSeverity(signals: readonly ProblemSignal[]): Severity {
  return signals.reduce<Severity>(
    (highest, signal) =>
      severityRank(signal.severity) > severityRank(highest) ? signal.severity : highest,
    "info",
  );
}

function problemCluster(params: {
  id: string;
  family: string;
  ownerEntrypoint: string;
  sourceOwners: string[];
  signals: ProblemSignal[];
  nextAction: string;
  actionability?: ClusterActionability;
  blockingReasons?: string[];
}): ProblemCluster | undefined {
  if (params.signals.length === 0) {
    return undefined;
  }
  const severity = maxSeverity(params.signals);
  return {
    id: params.id,
    family: params.family,
    severity,
    actionability: params.actionability ?? (severityRank(severity) >= 2 ? "repair_now" : "watch"),
    blockingReasons: params.blockingReasons ?? [],
    ownerEntrypoint: params.ownerEntrypoint,
    sourceOwners: [...new Set(params.sourceOwners)].toSorted(),
    signals: params.signals,
    nextAction: params.nextAction,
    boundary: "dev_problem_cluster_radar_only",
  };
}

function hasActiveHeavyLocalBrainProcess(
  trainingPlan: Record<string, unknown> | undefined,
): boolean {
  return arrayValue(trainingPlan?.activeProcesses).length > 0;
}

function ownerDecisionRepairBlocked(
  trainingPlan: Record<string, unknown> | undefined,
  decisionId: string,
): boolean {
  return arrayValue(trainingPlan?.decisions)
    .map(recordValue)
    .some(
      (decision) =>
        decision?.id === decisionId && booleanValue(decision.codexRepairEligible) === false,
    );
}

function commandFailureSignal(snapshot: OwnerSnapshot | undefined): ProblemSignal | undefined {
  if (!snapshot || snapshot.ok) {
    return undefined;
  }
  return {
    id: `${snapshot.owner}_owner_unavailable`,
    severity: "P1",
    summary: `${snapshot.owner} did not return usable JSON`,
    evidence: {
      command: snapshot.command,
      error: snapshot.error,
    },
  };
}

function decisionSignals(
  trainingPlan: Record<string, unknown> | undefined,
  ids: Record<string, { severity: Severity; summary: string }>,
): ProblemSignal[] {
  return arrayValue(trainingPlan?.decisions)
    .map(recordValue)
    .filter((decision): decision is Record<string, unknown> => Boolean(decision))
    .flatMap((decision) => {
      const id = stringValue(decision.id);
      if (!id || !ids[id]) {
        return [];
      }
      return [
        {
          id,
          severity: ids[id].severity,
          summary: ids[id].summary,
          evidence: {
            action: decision.action,
            reason: decision.reason,
            codexRepairEligible: decision.codexRepairEligible,
          },
        },
      ];
    });
}

function trainingEvalRuntimeCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const payload = inputs.trainingPlan?.payload;
  const signals: ProblemSignal[] = [];
  const ownerDecisionSignals = decisionSignals(payload, {
    stable_eval_timeout_after_latest_start: {
      severity: "P2",
      summary: "stable hardened eval timed out after the current guard start",
    },
    eval_pending_after_latest_start: {
      severity: "P3",
      summary: "latest eval evidence is older than the current guard start",
    },
    guard_failed_after_latest_start: {
      severity: "P1",
      summary: "guard reported a failure after the latest start",
    },
    overlapping_heavy_eval_detected: {
      severity: "P1",
      summary: "overlapping heavy eval or training process detected",
    },
  });
  signals.push(...ownerDecisionSignals);
  const timeoutAfterCurrentStart = ownerDecisionSignals.some(
    (signal) => signal.id === "stable_eval_timeout_after_latest_start",
  );
  const latestEval = recordValue(payload?.latestEval);
  const latestTimeout = recordValue(payload?.latestEvalTimeout);
  const latestEvalAt = stringValue(latestEval?.at);
  const latestTimeoutAt = stringValue(latestTimeout?.at);
  const timeoutIsNewerThanLatestEval =
    latestTimeoutAt !== undefined &&
    (!latestEvalAt || latestTimeoutAt.localeCompare(latestEvalAt) >= 0);
  if (latestTimeout && (timeoutAfterCurrentStart || timeoutIsNewerThanLatestEval)) {
    signals.push({
      id: timeoutAfterCurrentStart
        ? "latest_eval_timeout_visible"
        : "latest_eval_timeout_historical",
      severity: timeoutAfterCurrentStart ? "P2" : "P3",
      summary: timeoutAfterCurrentStart
        ? "latest hardened eval timeout is visible to the radar"
        : "latest hardened eval timeout is older than the current timeout decision window",
      evidence: latestTimeout,
    });
  }
  const timeoutCount = numberValue(payload?.stableEvalTimeoutCountAfterLatestStart);
  if (timeoutCount !== undefined && timeoutCount >= 2) {
    signals.push({
      id: "repeated_stable_eval_timeout",
      severity: "P2",
      summary: `stable hardened eval timed out ${timeoutCount} time(s) after latest guard start`,
      evidence: { stableEvalTimeoutCountAfterLatestStart: timeoutCount },
    });
  }
  return problemCluster({
    id: "training_eval_runtime_cluster",
    family: "qwen_training_eval_runtime",
    ownerEntrypoint: "scripts/dev/local-brain-training-plan.ts",
    sourceOwners: ["local-brain-training-plan"],
    signals,
    nextAction:
      "Hold promotion and repair eval runtime, timeout budget, or eval scope through local-brain-training-plan before judging the candidate.",
  });
}

function adapterPromotionTruthCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const payload = inputs.trainingPlan?.payload;
  const latestEval = recordValue(payload?.latestEval);
  const latestPassingEval = recordValue(payload?.latestPassingEval);
  const qwen = recordValue(payload?.qwenCapabilityConsolidation);
  const activeGuardAdapterTruth = recordValue(payload?.activeGuardAdapterTruth);
  const signals: ProblemSignal[] = [];
  signals.push(
    ...decisionSignals(payload, {
      guard_adapter_mismatch: {
        severity: "P2",
        summary: "active guard adapter does not match the selected clean adapter truth",
      },
      latest_promoted_adapter_not_selected_clean: {
        severity: "P3",
        summary: "latest promoted adapter is no longer the selected clean runtime adapter",
      },
    }),
  );
  const mismatchReasons = stringArray(activeGuardAdapterTruth?.mismatchReasons);
  if (mismatchReasons.length > 0) {
    signals.push({
      id: "active_guard_adapter_truth_mismatch",
      severity: "P2",
      summary: "active guard is running from a different adapter than selected clean truth",
      evidence: {
        guardCurrentAdapter: activeGuardAdapterTruth?.guardCurrentAdapter,
        selectedCleanAdapter: activeGuardAdapterTruth?.selectedCleanAdapter,
        latestPromotedAdapter: activeGuardAdapterTruth?.latestPromotedAdapter,
        mismatchReasons,
      },
    });
  }
  const stalePromotionReasons = stringArray(activeGuardAdapterTruth?.stalePromotionReasons);
  if (stalePromotionReasons.length > 0) {
    signals.push({
      id: "latest_promoted_adapter_stale",
      severity: "P3",
      summary:
        "latest promoted adapter is stale but active guard may still be using the selected clean adapter",
      evidence: {
        guardCurrentAdapter: activeGuardAdapterTruth?.guardCurrentAdapter,
        selectedCleanAdapter: activeGuardAdapterTruth?.selectedCleanAdapter,
        latestPromotedAdapter: activeGuardAdapterTruth?.latestPromotedAdapter,
        stalePromotionReasons,
      },
    });
  }
  if (latestEval && booleanValue(latestEval.promotionReady) === false) {
    signals.push({
      id: "latest_eval_not_promotion_ready",
      severity: "P2",
      summary: "latest eval is not promotion-ready even if pass counts look green",
      evidence: {
        at: latestEval.at,
        name: latestEval.name,
        passed: latestEval.passed,
        total: latestEval.total,
        parseRecoveredCaseIds: latestEval.parseRecoveredCaseIds,
      },
    });
  }
  const parseRecoveredCaseIds = stringArray(latestEval?.parseRecoveredCaseIds);
  if (parseRecoveredCaseIds.length > 0) {
    signals.push({
      id: "parse_recovered_blocks_promotion",
      severity: "P2",
      summary: "parseRecovered exists, so 77/77 is not a clean promotion proof",
      evidence: { parseRecoveredCaseIds },
    });
  }
  if (qwen && qwen.consolidationState === "candidate_capabilities_not_yet_consolidated") {
    signals.push({
      id: "challenger_capability_not_consolidated",
      severity: "P3",
      summary: "newer challenger capability is training evidence, not runtime capability yet",
      evidence: {
        selectedCleanAdapter: qwen.selectedCleanAdapter,
        selectedCleanEval: qwen.selectedCleanEval,
        latestPassingEval,
      },
    });
  }
  return problemCluster({
    id: "adapter_promotion_truth_cluster",
    family: "adapter_promotion_and_runtime_truth",
    ownerEntrypoint: "scripts/dev/local-brain-training-plan.ts",
    sourceOwners: ["local-brain-training-plan"],
    signals,
    nextAction:
      "Keep runtime on one clean latest-passing adapter and feed blocked challenger cases back through teacher/data/eval/promotion.",
    actionability:
      hasActiveHeavyLocalBrainProcess(payload) ||
      ownerDecisionRepairBlocked(payload, "guard_adapter_mismatch") ||
      ownerDecisionRepairBlocked(payload, "eval_not_promotion_ready")
        ? "blocked_by_owner_gate"
        : undefined,
    blockingReasons: [
      ...(hasActiveHeavyLocalBrainProcess(payload) ? ["active_local_brain_guard_or_eval"] : []),
      ...(ownerDecisionRepairBlocked(payload, "guard_adapter_mismatch")
        ? ["guard_adapter_mismatch_not_repairable_while_guard_active"]
        : []),
      ...(ownerDecisionRepairBlocked(payload, "eval_not_promotion_ready")
        ? ["training_plan_codex_repair_not_eligible"]
        : []),
    ],
  });
}

function moduleLearningAbsorptionCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const trainingPlan = inputs.trainingPlan?.payload;
  const moduleGate = inputs.moduleAbsorption?.payload;
  const gateBlockers = stringArray(moduleGate?.blockers);
  const writeAvailable = booleanValue(moduleGate?.writeAvailable);
  const signals: ProblemSignal[] = [
    ...decisionSignals(trainingPlan, {
      module_learning_incomplete_evidence: {
        severity: "P2",
        summary: "module-learning receipts are not fully eval_absorbed",
      },
    }),
  ];
  if (moduleGate && booleanValue(moduleGate.absorptionReady) === false) {
    signals.push({
      id: "module_absorption_not_ready",
      severity: "P2",
      summary: "module-learning absorption gate is not ready",
      evidence: {
        gateDecision: moduleGate.gateDecision,
        counts: moduleGate.counts,
        blockers: moduleGate.blockers,
      },
    });
  }
  for (const blocker of gateBlockers) {
    signals.push({
      id: `module_blocker_${blocker}`,
      severity:
        blocker === "latest_hardened_eval_timeout_newer_than_absorption_evidence" ? "P2" : "P3",
      summary: blocker,
    });
  }
  return problemCluster({
    id: "module_learning_absorption_cluster",
    family: "module_learning_internalization",
    ownerEntrypoint: "scripts/dev/lcx-module-learning-absorption-gate.ts",
    sourceOwners: ["local-brain-training-plan", "lcx-module-learning-absorption-gate"],
    signals,
    nextAction:
      "Complete per-receipt eval/training absorption evidence and rerun the gate before claiming module learning is internalized.",
    actionability:
      writeAvailable === false ||
      gateBlockers.some((blocker) =>
        [
          "latest_hardened_eval_not_clean",
          "latest_hardened_eval_timeout_newer_than_absorption_evidence",
        ].includes(blocker),
      ) ||
      ownerDecisionRepairBlocked(trainingPlan, "module_learning_incomplete_evidence")
        ? "blocked_by_owner_gate"
        : undefined,
    blockingReasons: [
      ...(writeAvailable === false ? ["module_absorption_write_not_available"] : []),
      ...gateBlockers.filter((blocker) =>
        [
          "latest_hardened_eval_not_clean",
          "latest_hardened_eval_timeout_newer_than_absorption_evidence",
        ].includes(blocker),
      ),
      ...(ownerDecisionRepairBlocked(trainingPlan, "module_learning_incomplete_evidence")
        ? ["training_plan_codex_repair_not_eligible"]
        : []),
    ],
  });
}

function architectureSupervisionCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const signals: ProblemSignal[] = [];
  for (const snapshot of [inputs.mindModel, inputs.flowGraph]) {
    const failure = commandFailureSignal(snapshot);
    if (failure) {
      signals.push(failure);
      continue;
    }
    const failures = stringArray(snapshot?.payload?.actionableFailures);
    if (failures.length > 0) {
      signals.push({
        id: `${snapshot!.owner}_actionable_failures`,
        severity: "P2",
        summary: `${snapshot!.owner} reported actionable architecture failures`,
        evidence: failures,
      });
    }
  }
  return problemCluster({
    id: "architecture_supervision_cluster",
    family: "god_view_workflow_supervision",
    ownerEntrypoint: "scripts/dev/lcx-mind-model.ts + scripts/dev/lcx-flow-graph.ts",
    sourceOwners: ["lcx-mind-model", "lcx-flow-graph"],
    signals,
    nextAction:
      "Repair the failing head/workflow/proof/boundary surface before expanding the architecture.",
  });
}

function contextRecoveryCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const snapshot = inputs.contextRecovery;
  const signals: ProblemSignal[] = [];
  const failure = commandFailureSignal(snapshot);
  if (failure) {
    signals.push(failure);
  }
  const payload = snapshot?.payload;
  const failures = stringArray(payload?.actionableFailures);
  if (failures.length > 0) {
    signals.push({
      id: "context_recovery_actionable_failures",
      severity: "P2",
      summary: "compressed-context recovery has actionable failures",
      evidence: failures,
    });
  }
  const warnings = stringArray(payload?.actionableWarnings);
  if (warnings.length > 0) {
    signals.push({
      id: "context_recovery_actionable_warnings",
      severity: "P3",
      summary: "compressed-context recovery has actionable warnings",
      evidence: warnings,
    });
  }
  return problemCluster({
    id: "context_recovery_cluster",
    family: "future_window_state_recovery",
    ownerEntrypoint: "scripts/dev/lcx-context-recovery-exam.ts",
    sourceOwners: ["lcx-context-recovery-exam"],
    signals,
    nextAction:
      "Refresh or repair durable recovery surfaces before asking a future Codex window to continue.",
  });
}

function learningSedimentationCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const audit = inputs.learningSedimentationAudit?.payload;
  const map = inputs.learningSedimentationMap?.payload;
  const moduleGate = inputs.moduleAbsorption?.payload;
  const gateBlockers = stringArray(moduleGate?.blockers);
  const signals: ProblemSignal[] = [];
  if (audit && booleanValue(audit.sufficientForCurrentUse) === false) {
    signals.push({
      id: "learning_sedimentation_not_sufficient",
      severity: "P3",
      summary: "learning sedimentation audit is not sufficient for current use",
      evidence: {
        assessment: audit.assessment,
        gaps: audit.gaps,
      },
    });
  }
  const gaps = arrayValue(audit?.gaps).map(recordValue).filter(Boolean);
  if (gaps.length > 0) {
    for (const gap of gaps) {
      const id = stringValue(gap.id) ?? "learning_sedimentation_gap";
      signals.push({
        id,
        severity: severityValue(gap.severity),
        summary: stringValue(gap.meaning) ?? "learning sedimentation has an explicit gap",
        evidence: gap,
      });
    }
  }
  const mapSummary = recordValue(map?.summary);
  if (mapSummary && booleanValue(mapSummary.languageCorpusSeparated) === false) {
    signals.push({
      id: "language_corpus_not_separated",
      severity: "P2",
      summary: "learning sedimentation map says language corpus is not separated",
      evidence: {
        summary: mapSummary,
        riskyConflations: map?.riskyConflations,
      },
    });
  }
  return problemCluster({
    id: "learning_sedimentation_cluster",
    family: "learning_memory_lane_separation",
    ownerEntrypoint:
      "scripts/dev/lcx-learning-sedimentation-audit.ts + scripts/dev/lcx-learning-sedimentation-map.ts",
    sourceOwners: ["lcx-learning-sedimentation-audit", "lcx-learning-sedimentation-map"],
    signals,
    nextAction:
      "Keep source learning, module absorption, system memory, training data, and language corpus separated until their own gates are clean.",
    actionability:
      booleanValue(moduleGate?.absorptionReady) === false ? "blocked_by_owner_gate" : undefined,
    blockingReasons:
      booleanValue(moduleGate?.absorptionReady) === false
        ? ["module_absorption_gate_not_ready", ...gateBlockers]
        : [],
  });
}

function systemMemoryCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const payload = inputs.systemMemoryGate?.payload;
  const signals: ProblemSignal[] = [];
  if (payload && booleanValue(payload.recallClaimReady) === false) {
    signals.push({
      id: "system_memory_recall_claim_not_ready",
      severity: "P3",
      summary: "system memory recall claim is not ready",
      evidence: {
        blockers: payload.blockers,
        warnings: payload.warnings,
        protectedMemoryClean: payload.protectedMemoryClean,
      },
    });
  }
  const blockers = stringArray(payload?.blockers);
  if (blockers.length > 0) {
    signals.push({
      id: "system_memory_blockers",
      severity: blockers.some((blocker) => blocker.includes("protected")) ? "P2" : "P3",
      summary: "system memory gate has blockers",
      evidence: blockers,
    });
  }
  return problemCluster({
    id: "system_memory_sedimentation_cluster",
    family: "system_memory_recall_and_downrank",
    ownerEntrypoint: "scripts/dev/lcx-system-memory-sedimentation-gate.ts",
    sourceOwners: ["lcx-system-memory-sedimentation-gate"],
    signals,
    nextAction:
      "Resolve system-memory blockers before turning recall into durable module-learning or live claims.",
  });
}

function dirtyWorktreeCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const payload = inputs.changeImpact?.payload;
  const changedFiles = stringArray(payload?.changedFiles);
  const unmatchedFiles = stringArray(payload?.unmatchedFiles);
  const signals: ProblemSignal[] = [];
  if (changedFiles.length > 0) {
    signals.push({
      id: "dirty_worktree_requires_lane_plan",
      severity: unmatchedFiles.length > 0 ? "P2" : "P3",
      summary: "worktree has changed files that need lane-scoped verification before handoff",
      evidence: {
        changedFiles,
        affectedLanes: payload?.affectedLanes,
        unmatchedFiles,
        recommendedFastCommands: payload?.recommendedFastCommands,
      },
    });
  }
  return problemCluster({
    id: "dirty_worktree_cluster",
    family: "handoff_and_change_scope",
    ownerEntrypoint: "scripts/dev/lcx-change-impact-plan.ts",
    sourceOwners: ["lcx-change-impact-plan"],
    signals,
    nextAction:
      "Finish, verify, or explicitly defer dirty files before the next window mixes unrelated lanes.",
  });
}

function ownerAvailabilityCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const signals = [
    inputs.trainingPlan,
    inputs.moduleAbsorption,
    inputs.mindModel,
    inputs.flowGraph,
    inputs.contextRecovery,
    inputs.learningSedimentationAudit,
    inputs.learningSedimentationMap,
    inputs.systemMemoryGate,
    inputs.changeImpact,
  ]
    .map(commandFailureSignal)
    .filter((signal): signal is ProblemSignal => Boolean(signal));
  return problemCluster({
    id: "owner_output_availability_cluster",
    family: "problem_radar_input_health",
    ownerEntrypoint: "scripts/dev/lcx-problem-cluster-radar.ts",
    sourceOwners: ["lcx-problem-cluster-radar"],
    signals,
    nextAction:
      "Repair the unavailable owner command first; the radar cannot classify a lane whose owner output is missing.",
  });
}

export function buildProblemClusterRadar(inputs: RadarInputs) {
  const clusters = [
    ownerAvailabilityCluster(inputs),
    trainingEvalRuntimeCluster(inputs),
    adapterPromotionTruthCluster(inputs),
    moduleLearningAbsorptionCluster(inputs),
    architectureSupervisionCluster(inputs),
    contextRecoveryCluster(inputs),
    learningSedimentationCluster(inputs),
    systemMemoryCluster(inputs),
    dirtyWorktreeCluster(inputs),
  ].filter((cluster): cluster is ProblemCluster => Boolean(cluster));
  const repairableClusters = clusters.filter((cluster) => cluster.actionability === "repair_now");
  const blockedClusters = clusters.filter(
    (cluster) => cluster.actionability === "blocked_by_owner_gate",
  );
  const watchClusters = clusters.filter((cluster) => cluster.severity === "P3");
  return {
    ok: true,
    boundary: "dev_problem_cluster_radar_only",
    checkedAt: new Date().toISOString(),
    summary: {
      clusters: clusters.length,
      actionableClusters: repairableClusters.length,
      repairableClusters: repairableClusters.length,
      blockedClusters: blockedClusters.length,
      watchClusters: watchClusters.length,
      highestSeverity: maxSeverity(clusters.flatMap((cluster) => cluster.signals)),
      sourceOwners: [
        "local-brain-training-plan",
        "lcx-module-learning-absorption-gate",
        "lcx-mind-model",
        "lcx-flow-graph",
        "lcx-context-recovery-exam",
        "lcx-learning-sedimentation-audit",
        "lcx-learning-sedimentation-map",
        "lcx-system-memory-sedimentation-gate",
        "lcx-change-impact-plan",
      ],
    },
    clusters,
    actionableClusters: repairableClusters.map((cluster) => cluster.id),
    repairableClusters: repairableClusters.map((cluster) => cluster.id),
    blockedClusters: blockedClusters.map((cluster) => cluster.id),
    nextActions: repairableClusters.map((cluster) => `${cluster.id}: ${cluster.nextAction}`),
    blockedActions: blockedClusters.map(
      (cluster) =>
        `${cluster.id}: ${cluster.nextAction} blocked_by=${cluster.blockingReasons.join(",")}`,
    ),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

async function runJsonOwner(owner: string, script: string): Promise<OwnerSnapshot> {
  const command = `node --import tsx ${script} --json`;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", script, "--json"],
      {
        cwd: repoRoot,
        env: process.env,
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
    return {
      ok: true,
      owner,
      command,
      payload: parseJsonObjectFromOutput(stdout),
    };
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      owner,
      command,
      error: [details.message ?? String(error), details.stderr, details.stdout]
        .filter(Boolean)
        .join("\n")
        .slice(-1200),
    };
  }
}

async function collectOwnerSnapshots(): Promise<RadarInputs> {
  const trainingPlanPromise = buildLocalBrainTrainingPlan({
    guardLogPath: DEFAULT_GUARD_LOG_PATH,
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    json: true,
    processCheck: true,
  })
    .then((payload) => ({
      ok: true,
      owner: "local-brain-training-plan",
      command: "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      payload: payload as Record<string, unknown>,
    }))
    .catch((error) => ({
      ok: false,
      owner: "local-brain-training-plan",
      command: "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      error: error instanceof Error ? error.message : String(error),
    }));
  const [
    trainingPlan,
    moduleAbsorption,
    mindModel,
    flowGraph,
    contextRecovery,
    learningSedimentationAudit,
    learningSedimentationMap,
    systemMemoryGate,
    changeImpact,
  ] = await Promise.all([
    trainingPlanPromise,
    runJsonOwner(
      "lcx-module-learning-absorption-gate",
      "scripts/dev/lcx-module-learning-absorption-gate.ts",
    ),
    runJsonOwner("lcx-mind-model", "scripts/dev/lcx-mind-model.ts"),
    runJsonOwner("lcx-flow-graph", "scripts/dev/lcx-flow-graph.ts"),
    runJsonOwner("lcx-context-recovery-exam", "scripts/dev/lcx-context-recovery-exam.ts"),
    runJsonOwner(
      "lcx-learning-sedimentation-audit",
      "scripts/dev/lcx-learning-sedimentation-audit.ts",
    ),
    runJsonOwner("lcx-learning-sedimentation-map", "scripts/dev/lcx-learning-sedimentation-map.ts"),
    runJsonOwner(
      "lcx-system-memory-sedimentation-gate",
      "scripts/dev/lcx-system-memory-sedimentation-gate.ts",
    ),
    runJsonOwner("lcx-change-impact-plan", "scripts/dev/lcx-change-impact-plan.ts"),
  ]);
  return {
    trainingPlan,
    moduleAbsorption,
    mindModel,
    flowGraph,
    contextRecovery,
    learningSedimentationAudit,
    learningSedimentationMap,
    systemMemoryGate,
    changeImpact,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = buildProblemClusterRadar(await collectOwnerSnapshots());
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `lcx problem cluster radar clusters=${result.summary.clusters} actionable=${result.summary.actionableClusters} highest=${result.summary.highestSeverity}`,
          ...result.clusters.map(
            (cluster) =>
              `- ${cluster.severity} ${cluster.id}: ${cluster.signals.map((signal) => signal.id).join(",")}`,
          ),
        ].join("\n") + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
