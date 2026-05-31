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
  externalAgentUpgrade?: OwnerSnapshot;
  repairVerification?: Record<string, RepairVerificationEvidence>;
};

type CliOptions = {
  json: boolean;
};

type RepairVerificationEvidence = {
  status: "pending_owner_verification";
  repairedAt: string;
  commit: string;
  files: string[];
  reason: string;
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

export function isIsoTimeSameOrAfter(candidate: string, baseline: string): boolean {
  const candidateMs = Date.parse(candidate);
  const baselineMs = Date.parse(baseline);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(baselineMs)) {
    return false;
  }
  return candidateMs >= baselineMs;
}

function evalPassLabel(evalRecord: Record<string, unknown> | undefined): string {
  const passed = evalRecord?.passed;
  const total = evalRecord?.total;
  if (typeof passed === "number" && typeof total === "number") {
    return `${passed}/${total}`;
  }
  return "green pass count";
}

function externalChannelBindingPlan(
  trainingPlan: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return (
    recordValue(trainingPlan?.externalChannelBinding) ??
    recordValue(trainingPlan?.liveLarkBrainBinding)
  );
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

function repairableSignalEntries(
  clusters: readonly ProblemCluster[],
  repairVerification: Record<string, RepairVerificationEvidence> | undefined,
) {
  return clusters.flatMap((cluster) =>
    cluster.signals.flatMap((signal) => {
      const evidence = recordValue(signal.evidence);
      if (evidence?.codexRepairEligible !== true) {
        return [];
      }
      const key = `${cluster.id}/${signal.id}`;
      const pendingVerification = repairVerification?.[key] ?? repairVerification?.[signal.id];
      if (pendingVerification) {
        return [];
      }
      return [
        {
          clusterId: cluster.id,
          signalId: signal.id,
          severity: signal.severity,
          summary: signal.summary,
          ownerEntrypoint: cluster.ownerEntrypoint,
          sourceOwners: cluster.sourceOwners,
          action: stringValue(evidence.action) ?? "owner_marked_codex_repair_eligible",
          reason: stringValue(evidence.reason),
        },
      ];
    }),
  );
}

function pendingVerificationSignalEntries(
  clusters: readonly ProblemCluster[],
  repairVerification: Record<string, RepairVerificationEvidence> | undefined,
) {
  if (!repairVerification) {
    return [];
  }
  return clusters.flatMap((cluster) =>
    cluster.signals.flatMap((signal) => {
      const evidence = recordValue(signal.evidence);
      if (evidence?.codexRepairEligible !== true) {
        return [];
      }
      const key = `${cluster.id}/${signal.id}`;
      const pendingVerification = repairVerification[key] ?? repairVerification[signal.id];
      if (!pendingVerification) {
        return [];
      }
      return [
        {
          clusterId: cluster.id,
          signalId: signal.id,
          severity: signal.severity,
          summary: signal.summary,
          ownerEntrypoint: cluster.ownerEntrypoint,
          sourceOwners: cluster.sourceOwners,
          status: pendingVerification.status,
          repairedAt: pendingVerification.repairedAt,
          commit: pendingVerification.commit,
          files: pendingVerification.files,
          reason: pendingVerification.reason,
          ownerVerificationRequired: true,
        },
      ];
    }),
  );
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

function ownerDecisionRepairBlockedAny(
  trainingPlan: Record<string, unknown> | undefined,
  decisionIds: readonly string[],
): boolean {
  return decisionIds.some((decisionId) => ownerDecisionRepairBlocked(trainingPlan, decisionId));
}

function hasDecision(
  trainingPlan: Record<string, unknown> | undefined,
  decisionId: string,
): boolean {
  return arrayValue(trainingPlan?.decisions)
    .map(recordValue)
    .some((decision) => decision?.id === decisionId);
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
    active_guard_missing_evolution_cooldown_flag: {
      severity: "P3",
      summary: "active guard was launched without the work-then-evolve cooldown flag",
    },
    output_contract_or_parser_failure: {
      severity: "P2",
      summary: "eval or guard evidence has output-contract/parser failures that need repair",
    },
    teacher_sample_quality_failure: {
      severity: "P2",
      summary: "teacher batch output has JSON or sample-quality failures that need repair",
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
    (!latestEvalAt || isIsoTimeSameOrAfter(latestTimeoutAt, latestEvalAt));
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
  const activeOwnerBlockedRepair =
    hasActiveHeavyLocalBrainProcess(payload) &&
    ownerDecisionSignals.some(
      (signal) =>
        ["stable_eval_timeout_after_latest_start", "eval_pending_after_latest_start"].includes(
          signal.id,
        ) && recordValue(signal.evidence)?.codexRepairEligible === false,
    );
  return problemCluster({
    id: "training_eval_runtime_cluster",
    family: "qwen_training_eval_runtime",
    ownerEntrypoint: "scripts/dev/local-brain-training-plan.ts",
    sourceOwners: ["local-brain-training-plan"],
    signals,
    nextAction:
      "Hold promotion and repair eval runtime, output contract, teacher sample quality, timeout budget, or eval scope through local-brain-training-plan before judging the candidate.",
    actionability: activeOwnerBlockedRepair ? "blocked_by_owner_gate" : undefined,
    blockingReasons: activeOwnerBlockedRepair ? ["active_local_brain_guard_or_eval"] : [],
  });
}

function evolutionAccelerationCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const payload = inputs.trainingPlan?.payload;
  const queue = recordValue(payload?.evolutionAccelerationQueue);
  if (!queue) {
    return undefined;
  }
  const latestEvolutionCooldown = recordValue(payload?.latestEvolutionCooldown);
  const evolutionCooldownActive = booleanValue(payload?.evolutionCooldownActive) === true;
  const steps = arrayValue(queue.steps)
    .map(recordValue)
    .filter((step): step is Record<string, unknown> => Boolean(step));
  const readyNowCount = numberValue(queue.readyNowCount) ?? 0;
  const idleOnlyCount = numberValue(queue.idleOnlyCount) ?? 0;
  const blockedCount = numberValue(queue.blockedCount) ?? 0;
  const signals: ProblemSignal[] = [];
  if (evolutionCooldownActive) {
    signals.push({
      id: "work_then_evolve_cooldown_active",
      severity: "P3",
      summary: "local-brain guard is in the deliberate evolution cooldown between heavy rounds",
      evidence: {
        latestEvolutionCooldown,
        fastestSafeNextAction: queue.fastestSafeNextAction,
        activeTrainingOrEval: queue.activeTrainingOrEval,
      },
    });
  }
  if (readyNowCount > 0) {
    signals.push({
      id: "evolution_acceleration_ready_now",
      severity: "P3",
      summary: "safe evolution acceleration work is ready now",
      evidence: {
        fastestSafeNextAction: queue.fastestSafeNextAction,
        readyNowCount,
        steps: steps
          .filter((step) => step.status === "ready_now")
          .map((step) => ({ id: step.id, lane: step.lane, command: step.command }))
          .slice(0, 5),
      },
    });
  }
  if (idleOnlyCount > 0 || blockedCount > 0) {
    signals.push({
      id: "evolution_acceleration_idle_queue",
      severity: "P3",
      summary: "idle-only Qwen/agent acceleration queue is waiting on owner gates",
      evidence: {
        activeTrainingOrEval: queue.activeTrainingOrEval,
        canStartHeavyWorkNow: queue.canStartHeavyWorkNow,
        fastestSafeNextAction: queue.fastestSafeNextAction,
        idleOnlyCount,
        blockedCount,
        steps: steps
          .filter((step) =>
            ["ready_when_idle", "blocked_by_active_training", "blocked_by_missing_proof"].includes(
              stringValue(step.status) ?? "",
            ),
          )
          .map((step) => ({
            id: step.id,
            lane: step.lane,
            status: step.status,
            executionClass: step.executionClass,
            blockedByDecisionIds: step.blockedByDecisionIds,
          }))
          .slice(0, 8),
      },
    });
  }
  return problemCluster({
    id: "evolution_acceleration_cluster",
    family: "qwen_agent_evolution_acceleration",
    ownerEntrypoint: "scripts/dev/local-brain-training-plan.ts",
    sourceOwners: ["local-brain-training-plan"],
    signals,
    nextAction:
      "Follow evolutionAccelerationQueue before launching broad work: honor work-then-evolve cooldown windows, run ready_now receipt/review steps immediately, and run idle-only heavy steps only after local-brain-training-plan shows no active guard/eval/MLX.",
    actionability:
      readyNowCount > 0
        ? "repair_now"
        : evolutionCooldownActive
          ? undefined
          : "blocked_by_owner_gate",
    blockingReasons:
      readyNowCount > 0 || evolutionCooldownActive
        ? []
        : blockedCount > 0
          ? ["active_local_brain_guard_or_eval_or_missing_absorption_proof"]
          : [],
  });
}

function adapterPromotionTruthCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const payload = inputs.trainingPlan?.payload;
  const latestEval = recordValue(payload?.latestEval);
  const latestPassingEval = recordValue(payload?.latestPassingEval);
  const qwen = recordValue(payload?.qwenCapabilityConsolidation);
  const activeGuardAdapterTruth = recordValue(payload?.activeGuardAdapterTruth);
  const externalChannelBinding = externalChannelBindingPlan(payload);
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
      lark_external_channel_binding_ready: {
        severity: "P3",
        summary: "external Lark channel binding is ready but still needs explicit apply/proof",
      },
      live_lark_brain_binding_deferred: {
        severity: "P3",
        summary: "legacy live Lark binding alias is deferred; use external-channel binding truth",
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
      summary: `parseRecovered exists, so ${evalPassLabel(latestEval)} is not a clean promotion proof`,
      evidence: {
        passed: latestEval?.passed,
        total: latestEval?.total,
        parseRecoveredCaseIds,
      },
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
  const channelBindingStatus =
    typeof externalChannelBinding?.status === "string" ? externalChannelBinding.status : undefined;
  if (
    channelBindingStatus &&
    !["ready_for_apply", "ready_for_live_runtime_binding"].includes(channelBindingStatus)
  ) {
    signals.push({
      id: "external_channel_binding_not_ready",
      severity: "P3",
      summary: "external Lark channel must wait before consuming the selected clean adapter",
      evidence: {
        legacySignalId: "live_lark_brain_binding_not_ready",
        status: externalChannelBinding?.status,
        action: externalChannelBinding?.action,
        selectedCleanAdapter: externalChannelBinding?.selectedCleanAdapter,
        missingProof: externalChannelBinding?.missingProof,
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
      "Keep runtime on one clean latest-passing adapter; bind the external Lark channel to that selected clean adapter only after eval/MLX is idle, sidecar drift is zero, runtime is restarted, and real user-visible Lark proof is collected.",
    actionability:
      hasActiveHeavyLocalBrainProcess(payload) ||
      ownerDecisionRepairBlocked(payload, "guard_adapter_mismatch") ||
      ownerDecisionRepairBlocked(payload, "eval_not_promotion_ready") ||
      ownerDecisionRepairBlockedAny(payload, [
        "lark_external_channel_binding_ready",
        "live_lark_brain_binding_deferred",
      ])
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
      ...(ownerDecisionRepairBlockedAny(payload, [
        "lark_external_channel_binding_ready",
        "live_lark_brain_binding_deferred",
      ])
        ? ["external_channel_binding_waiting_for_owner_proof"]
        : []),
    ],
  });
}

function moduleLearningAbsorptionCluster(inputs: RadarInputs): ProblemCluster | undefined {
  const trainingPlan = inputs.trainingPlan?.payload;
  const moduleGate = inputs.moduleAbsorption?.payload;
  const gateCounts = recordValue(moduleGate?.counts);
  const audit = inputs.learningSedimentationAudit?.payload;
  const auditChains = recordValue(audit?.chains);
  const auditModuleLearning = recordValue(auditChains?.moduleLearningPipeline);
  const auditLatestReview = recordValue(auditModuleLearning?.latestReview);
  const noSameDayModuleReceipts =
    (numberValue(gateCounts?.planReceiptFiles) ?? 0) === 0 &&
    (numberValue(gateCounts?.reviewRows) ?? 0) === 0;
  const cumulativeModuleLearningClean =
    booleanValue(audit?.sufficientForCurrentUse) === true &&
    booleanValue(auditModuleLearning?.ok) === true &&
    (numberValue(auditModuleLearning?.cumulativeEvalAbsorbed) ?? 0) > 0 &&
    (numberValue(auditModuleLearning?.cumulativeBoundaryViolations) ?? 0) === 0 &&
    (numberValue(auditLatestReview?.evalAbsorbed) ?? 0) > 0 &&
    (numberValue(auditLatestReview?.weakModuleLearning) ?? 0) === 0 &&
    (numberValue(auditLatestReview?.boundaryViolations) ?? 0) === 0;
  const sameDayEmptyButCumulativeClean = noSameDayModuleReceipts && cumulativeModuleLearningClean;
  const gateProofGapSummary = recordValue(moduleGate?.proofGapSummary);
  const auditProofGapSummary = recordValue(auditModuleLearning?.proofGapSummary);
  const exactMissingProofReceipts =
    (numberValue(gateCounts?.missingAbsorptionEvidenceReceipts) ?? 0) ||
    (numberValue(auditModuleLearning?.exactMissingProofReceipts) ?? 0);
  const gateBlockers = sameDayEmptyButCumulativeClean
    ? stringArray(moduleGate?.blockers).filter(
        (blocker) => blocker !== "module_learning_review_missing",
      )
    : stringArray(moduleGate?.blockers);
  const writeAvailable = booleanValue(moduleGate?.writeAvailable);
  const signals: ProblemSignal[] = [
    ...decisionSignals(trainingPlan, {
      module_learning_incomplete_evidence: {
        severity: "P2",
        summary: "module-learning receipts are not fully eval_absorbed",
      },
    }),
  ];
  if (
    moduleGate &&
    booleanValue(moduleGate.absorptionReady) === false &&
    !sameDayEmptyButCumulativeClean
  ) {
    signals.push({
      id: "module_absorption_not_ready",
      severity: "P2",
      summary: "module-learning absorption gate is not ready",
      evidence: {
        gateDecision: moduleGate.gateDecision,
        counts: moduleGate.counts,
        blockers: moduleGate.blockers,
        proofGapSummary: gateProofGapSummary ?? auditProofGapSummary,
        nextProofQueue: Array.isArray(moduleGate.nextProofQueue)
          ? moduleGate.nextProofQueue.slice(0, 5)
          : Array.isArray(auditModuleLearning?.nextProofQueue)
            ? auditModuleLearning.nextProofQueue.slice(0, 5)
            : [],
      },
    });
  }
  if (exactMissingProofReceipts > 0) {
    signals.push({
      id: "module_absorption_exact_missing_proof",
      severity: "P2",
      summary: "module-learning review exposes exact per-receipt missing proof",
      evidence: {
        exactMissingProofReceipts,
        proofGapSummary: gateProofGapSummary ?? auditProofGapSummary,
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
      (writeAvailable === false && !sameDayEmptyButCumulativeClean) ||
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
      ...(writeAvailable === false && !sameDayEmptyButCumulativeClean
        ? ["module_absorption_write_not_available"]
        : []),
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

function externalAgentUpgradeCluster(inputs: RadarInputs): ProblemCluster | undefined {
  if (!inputs.externalAgentUpgrade) {
    return undefined;
  }
  const payload = inputs.externalAgentUpgrade?.payload;
  const summary = recordValue(payload?.summary);
  const candidateIds = arrayValue(payload?.candidates)
    .map((candidate) => recordValue(candidate)?.id)
    .filter((id): id is string => typeof id === "string");
  const blacktechMechanismIds = arrayValue(payload?.blacktechMechanisms)
    .map((mechanism) => recordValue(mechanism)?.id)
    .filter((id): id is string => typeof id === "string");
  const registeredCandidateCount = numberValue(summary?.registeredCandidateCount);
  const architectureIntegratedCount = numberValue(summary?.architectureIntegratedCount);
  const blacktechMechanismCount = numberValue(summary?.blacktechMechanismCount);
  const blacktechAutopilotRoutedCount = numberValue(summary?.blacktechAutopilotRoutedCount);
  const signals: ProblemSignal[] = [];
  if (payload && payload.ok !== true) {
    signals.push({
      id: "external_agent_upgrade_radar_failed",
      severity: "P2",
      summary: "external agent upgrade radar is not green",
      evidence: {
        boundary: payload.boundary,
        summary,
        actionableFailures: payload.actionableFailures,
      },
    });
  }
  if (registeredCandidateCount === undefined || registeredCandidateCount < 13) {
    signals.push({
      id: "external_agent_candidate_count_drift",
      severity: "P2",
      summary:
        "the expected external agent, blacktech, and prediction-market upgrade candidates are not all registered",
      evidence: summary,
    });
  }
  if (
    architectureIntegratedCount === undefined ||
    registeredCandidateCount === undefined ||
    architectureIntegratedCount !== registeredCandidateCount
  ) {
    signals.push({
      id: "external_agent_owner_mapping_drift",
      severity: "P2",
      summary: "one or more external agent projects is no longer mapped to an existing owner",
      evidence: summary,
    });
  }
  if (!candidateIds.includes("github_cli_agentic_workflow_control")) {
    signals.push({
      id: "external_agent_github_cli_candidate_missing",
      severity: "P2",
      summary:
        "GitHub CLI / GitHub Agentic Workflows is not recovered as a gated external upgrade candidate",
      evidence: { candidateIds },
    });
  }
  if (numberValue(summary?.runtimeAuthorityGrantedCount) !== 0) {
    signals.push({
      id: "external_agent_runtime_authority_granted",
      severity: "P1",
      summary: "an external agent project received runtime authority without the required gates",
      evidence: summary,
    });
  }
  if (blacktechMechanismCount === undefined || blacktechMechanismCount < 7) {
    signals.push({
      id: "external_agent_blacktech_mechanism_count_drift",
      severity: "P2",
      summary: "the expected blacktech mechanisms are not all tracked by the radar",
      evidence: summary,
    });
  }
  if (!blacktechMechanismIds.includes("github_cli_agentic_control_plane")) {
    signals.push({
      id: "external_agent_github_cli_control_plane_missing",
      severity: "P2",
      summary: "GitHub CLI control plane is not recovered as a gated blacktech mechanism",
      evidence: { blacktechMechanismIds },
    });
  }
  if (numberValue(summary?.blacktechRuntimeAuthorityGrantedCount) !== 0) {
    signals.push({
      id: "external_agent_blacktech_runtime_authority_granted",
      severity: "P1",
      summary: "a blacktech mechanism received runtime authority without the required gates",
      evidence: summary,
    });
  }
  if (
    blacktechAutopilotRoutedCount === undefined ||
    blacktechMechanismCount === undefined ||
    blacktechAutopilotRoutedCount !== blacktechMechanismCount
  ) {
    signals.push({
      id: "external_agent_blacktech_autopilot_contract_drift",
      severity: "P2",
      summary:
        "the blacktech mechanisms are not all wired with automatic trigger, owner gate, autopilot surface, and next action",
      evidence: summary,
    });
  }
  if (booleanValue(summary?.perfectIntegrationClaim) !== false) {
    signals.push({
      id: "external_agent_perfect_integration_overclaim",
      severity: "P2",
      summary: "external agent integration is being overclaimed as perfect",
      evidence: summary,
    });
  }
  return problemCluster({
    id: "external_agent_upgrade_cluster",
    family: "external_agent_upgrade_distillation",
    ownerEntrypoint: "scripts/dev/lcx-external-agent-upgrade-radar.ts",
    sourceOwners: ["lcx-external-agent-upgrade-radar"],
    signals,
    nextAction:
      "Repair external-agent radar, autocue, owner mapping, or runtime-authority boundary before absorbing more external projects.",
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
    inputs.externalAgentUpgrade,
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
    evolutionAccelerationCluster(inputs),
    adapterPromotionTruthCluster(inputs),
    moduleLearningAbsorptionCluster(inputs),
    architectureSupervisionCluster(inputs),
    contextRecoveryCluster(inputs),
    learningSedimentationCluster(inputs),
    systemMemoryCluster(inputs),
    externalAgentUpgradeCluster(inputs),
    dirtyWorktreeCluster(inputs),
  ].filter((cluster): cluster is ProblemCluster => Boolean(cluster));
  const repairableClusters = clusters.filter((cluster) => cluster.actionability === "repair_now");
  const blockedClusters = clusters.filter(
    (cluster) => cluster.actionability === "blocked_by_owner_gate",
  );
  const repairableSignals = repairableSignalEntries(clusters, inputs.repairVerification);
  const pendingVerificationSignals = pendingVerificationSignalEntries(
    clusters,
    inputs.repairVerification,
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
      repairableSignals: repairableSignals.length,
      pendingVerificationSignals: pendingVerificationSignals.length,
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
        "lcx-external-agent-upgrade-radar",
      ],
      evolutionCooldownActive:
        booleanValue(inputs.trainingPlan?.payload?.evolutionCooldownActive) === true,
      latestEvolutionCooldown: inputs.trainingPlan?.payload?.latestEvolutionCooldown,
    },
    clusters,
    actionableClusters: repairableClusters.map((cluster) => cluster.id),
    repairableClusters: repairableClusters.map((cluster) => cluster.id),
    repairableSignals,
    pendingVerificationSignals,
    blockedClusters: blockedClusters.map((cluster) => cluster.id),
    nextActions: repairableClusters.map((cluster) => `${cluster.id}: ${cluster.nextAction}`),
    repairableActions: repairableSignals.map(
      (signal) => `${signal.clusterId}/${signal.signalId}: ${signal.action}`,
    ),
    pendingVerificationActions: pendingVerificationSignals.map(
      (signal) =>
        `${signal.clusterId}/${signal.signalId}: wait_for_owner_verification commit=${signal.commit}`,
    ),
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
    if (details.stdout) {
      try {
        return {
          ok: true,
          owner,
          command,
          payload: parseJsonObjectFromOutput(details.stdout),
        };
      } catch {
        // Fall through to owner-unavailable. Some owners fail before writing JSON.
      }
    }
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

async function latestCommitTouchingPaths(
  paths: string[],
): Promise<{ commit: string; committedAt: string } | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%H%x00%cI", "--", ...paths],
      {
        cwd: repoRoot,
        env: process.env,
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
    const [commit, committedAt] = stdout.trim().split("\0");
    if (!commit || !committedAt) {
      return undefined;
    }
    return { commit, committedAt };
  } catch {
    return undefined;
  }
}

async function buildRepairVerification(
  trainingPlan: Record<string, unknown> | undefined,
): Promise<Record<string, RepairVerificationEvidence>> {
  const repairVerification: Record<string, RepairVerificationEvidence> = {};
  const latestTeacher = recordValue(trainingPlan?.latestTeacher);
  const latestTeacherAt = stringValue(latestTeacher?.at);
  const teacherRepairFiles = [
    "scripts/dev/minimax-brain-teacher-batch.ts",
    "test/minimax-brain-teacher-batch.test.ts",
  ];
  if (latestTeacherAt && hasDecision(trainingPlan, "teacher_sample_quality_failure")) {
    const commit = await latestCommitTouchingPaths(teacherRepairFiles);
    if (
      commit &&
      isIsoTimeSameOrAfter(commit.committedAt, latestTeacherAt) &&
      commit.committedAt !== latestTeacherAt
    ) {
      repairVerification["training_eval_runtime_cluster/teacher_sample_quality_failure"] = {
        status: "pending_owner_verification",
        repairedAt: commit.committedAt,
        commit: commit.commit.slice(0, 10),
        files: teacherRepairFiles,
        reason:
          "repo has a newer teacher parser repair commit than the latest logged teacher failure; wait for the next teacher owner run before opening another repair",
      };
    }
  }
  return repairVerification;
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
    externalAgentUpgrade,
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
    runJsonOwner(
      "lcx-external-agent-upgrade-radar",
      "scripts/dev/lcx-external-agent-upgrade-radar.ts",
    ),
  ]);
  const repairVerification = await buildRepairVerification(trainingPlan.payload);
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
    externalAgentUpgrade,
    repairVerification,
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
