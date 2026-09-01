import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  readGlobalEvidenceProjectionForAdapter,
  type GlobalEvidenceProjectionRead,
} from "../../src/shared/global-evidence-projection-read.ts";
import {
  buildLocalFailureTraceReceipt,
  summarizeTraceForHandoff,
  type LocalFailureTraceReceipt,
  writeLocalFailureTraceReceipt,
} from "./lcx-local-failure-trace.ts";
import {
  CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
  DEFAULT_WORKSPACE_DIR,
  EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
  GOVERNANCE_AUTOPILOT_LATEST_PATH,
  LOCAL_FAILURE_TRACE_JSONL_PATH,
  LOCAL_FAILURE_TRACE_LATEST_PATH,
  MONOTONIC_DATA_LEDGER_JSONL_PATH,
  MONOTONIC_DATA_LEDGER_LATEST_PATH,
  MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
  OWNER_BRIEF_LATEST_JSON_PATH,
  OWNER_BRIEF_LATEST_MARKDOWN_PATH,
  OWNER_CONTROL_MAP_LATEST_JSON_PATH,
  OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH,
  SELF_REPAIR_HANDS_JSONL_PATH,
  SELF_REPAIR_HANDS_LATEST_PATH,
  SELF_REPAIR_HANDS_MARKDOWN_PATH,
  UNIVERSE_INDEX_LATEST_PATH,
} from "./lcx-local-paths.ts";
import { buildOwnerBrief, writeOwnerBrief } from "./lcx-owner-brief.ts";
import { buildOwnerControlMap, writeOwnerControlMap } from "./lcx-owner-control-map.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const EXEC_MAX_BUFFER = 48 * 1024 * 1024;

type OwnerId =
  | "problemRadar"
  | "commercialAcceptance"
  | "changeImpact"
  | "projectionReaderAudit"
  | "universeIndex"
  | "externalAgentUpgrade"
  | "liveFadeoutAudit"
  | "externalChannelStatus"
  | "trainingPlan"
  | "skillOptLite"
  | "selfRepairHands"
  | "monotonicDataLedger"
  | "providerCouncilAcceleration"
  | "externalChannelBinding"
  | "mindModel"
  | "flowGraph"
  | "headTail"
  | "contextRecovery";

type OwnerCommand = {
  id: OwnerId;
  script: string;
  args?: string[];
  required: boolean;
};

type OwnerRun = {
  id: OwnerId;
  command: string;
  exitCode: number;
  parsed: boolean;
  ok: boolean | undefined;
  boundary: string | undefined;
  summary: unknown;
  compact: Record<string, unknown>;
  projection?: unknown;
  error?: string;
};

type SelfRepairAutoSignal = {
  policyTriggerId: string;
  signalKey: string;
  issue: string;
  observedFailure: string;
  replacementRule: string;
  domain: string;
};

const SELF_REPAIR_HANDS_OWNER_WRITE_POLICY = {
  owner: "lcx-governance-autopilot",
  targetOwner: "selfRepairHands",
  command: "node --import tsx scripts/operator/lcx-self-repair-hands.ts --write --json",
  whenAutoWrite: [
    {
      id: "candidate_eval_dirty_cases",
      sourceOwner: "trainingPlan",
      condition:
        "latestCandidateEval has failedCaseIds, parseErrorCaseIds, or parseRecoveredCaseIds",
      signalKeyPrefix: "candidate_eval_dirty_cases:",
    },
    {
      id: "module_learning_incomplete_evidence",
      sourceOwner: "trainingPlan",
      condition: "decisionIds includes module_learning_incomplete_evidence",
      signalKeyPrefix: "module_learning_incomplete_evidence:",
    },
    {
      id: "skillopt_static_or_parse_gap",
      sourceOwner: "skillOptLite",
      condition: "staticGateOk is false or parseRecoveredCount is greater than 0",
      signalKeyPrefix: "skillopt_static_or_parse_gap:",
    },
  ],
  dedupeKey: "signalKey",
  writeOncePerSignalKey: true,
  allowedWriteRoots: [
    "workspace/memory/self-repair",
    "workspace/state/lcx-self-repair-hands-*",
    "workspace/logs/lcx-self-repair-hands.jsonl",
  ],
  deniedAuthorities: [
    "repo_source",
    "external_channel_sender",
    "provider_config",
    "protected_memory",
    "formal_language_corpus",
    "training_processes",
    "train_slice_direct_write",
    "model_weight_absorption_claim",
  ],
  afterWriteGate:
    "owner_review_then_owner_approved_eval_or_train_slice_only_after_training_plan_idle_safe",
} as const;

const OWNER_COMMANDS: OwnerCommand[] = [
  {
    id: "problemRadar",
    script: "scripts/operator/lcx-problem-cluster-radar.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "commercialAcceptance",
    script: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "changeImpact",
    script: "scripts/operator/lcx-change-impact-plan.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "projectionReaderAudit",
    script: "scripts/operator/lcx-projection-reader-audit.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "universeIndex",
    script: "scripts/operator/lcx-universe-index.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "externalAgentUpgrade",
    script: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "liveFadeoutAudit",
    script: "scripts/operator/lcx-live-fadeout-audit.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "externalChannelStatus",
    script: "scripts/operator/lcx-external-channel-status.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "trainingPlan",
    script: "scripts/operator/local-brain-training-plan.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "skillOptLite",
    script: "scripts/operator/lcx-skillopt-lite.ts",
    args: ["--phase", "candidate-edit", "--no-write", "--json"],
    required: true,
  },
  {
    id: "selfRepairHands",
    script: "scripts/operator/lcx-self-repair-hands.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "monotonicDataLedger",
    script: "scripts/operator/lcx-monotonic-data-ledger.ts",
    args: ["--write", "--json"],
    required: true,
  },
  {
    id: "providerCouncilAcceleration",
    script: "scripts/operator/lcx-provider-council-acceleration.ts",
    args: ["--profile", "aggressive", "--no-write", "--json"],
    required: true,
  },
  {
    id: "externalChannelBinding",
    script: "scripts/operator/lcx-external-channel-binding.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "mindModel",
    script: "scripts/operator/lcx-mind-model.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "flowGraph",
    script: "scripts/operator/lcx-flow-graph.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "headTail",
    script: "scripts/operator/lcx-head-tail-consistency.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "contextRecovery",
    script: "scripts/operator/lcx-context-recovery-exam.ts",
    args: ["--json"],
    required: true,
  },
];

type ActivePidSummary = {
  guard: string[];
  eval: string[];
  mlx: string[];
  teacher: string[];
  quota: string[];
};

type HandoffReceipt = {
  ok: boolean;
  checkedAt: string;
  summary: {
    activeTrainingOrEval: boolean;
    fastestSafeNextAction: unknown;
    activeNonIdleProgress?: unknown;
    structuralOwnerFailures: string[];
    blockedClusters: unknown;
    blockedGates: unknown;
    externalChannelBindingStatus?: unknown;
    externalChannelStatusModel?: unknown;
    externalChannelBound?: unknown;
    userVisibleObserved?: unknown;
  };
  liveTouched: boolean;
  providerConfigTouched: boolean;
  protectedMemoryTouched: boolean;
};

type MultiAgentPatternShadowGovernance = {
  status: "fresh" | "stale" | "missing" | "blocked";
  latestPath: string;
  checkedAt?: string;
  experimentId?: string;
  mode?: string;
  trialDecision?: string;
  normalPassRate?: number | null;
  p95CriticalPathLatencyMs?: number | null;
  usageBasis?: string;
  escapedPermissionViolations?: number;
  externalSideEffects?: number;
  recoveryPassByPattern?: unknown;
  reason: string;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-governance-autopilot.ts [--json]",
      "",
      "Runs the read-only LCX governance owner stack, writes the latest compact",
      "autopilot snapshot, and never starts training, external-channel apply, provider config",
      "changes, protected-memory writes, or external-channel sender changes.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]) {
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

async function readMultiAgentPatternShadowGovernance(): Promise<MultiAgentPatternShadowGovernance> {
  try {
    const source = await fs.readFile(MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH, "utf8");
    const payload = JSON.parse(source) as Record<string, unknown>;
    const summary = recordValue(payload.summary);
    if (
      payload.receiptSchemaVersion !== "lcx_multi_agent_pattern_shadow_v1" ||
      payload.boundary !== "local_multi_agent_pattern_shadow_only" ||
      !summary
    ) {
      return {
        status: "missing",
        latestPath: MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
        reason: "shadow latest summary has an incompatible receipt or missing summary",
      };
    }
    const checkedAt = typeof payload.completedAt === "string" ? payload.completedAt : undefined;
    const parsedCheckedAt = checkedAt ? Date.parse(checkedAt) : Number.NaN;
    const ageMs = Number.isFinite(parsedCheckedAt)
      ? Date.now() - parsedCheckedAt
      : Number.POSITIVE_INFINITY;
    const trialDecision =
      typeof summary?.trialDecision === "string" ? summary.trialDecision : undefined;
    const blocked =
      trialDecision === "discard" ||
      (typeof summary?.blockedRuns === "number" &&
        summary.blockedRuns > 0 &&
        summary.rootRuns === 0);
    return {
      status:
        blocked || payload.status === "blocked"
          ? "blocked"
          : ageMs > 24 * 60 * 60 * 1000
            ? "stale"
            : "fresh",
      latestPath: MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
      checkedAt,
      experimentId: typeof payload.experimentId === "string" ? payload.experimentId : undefined,
      mode: typeof payload.mode === "string" ? payload.mode : undefined,
      trialDecision,
      normalPassRate: typeof summary?.normalPassRate === "number" ? summary.normalPassRate : null,
      p95CriticalPathLatencyMs:
        typeof summary?.p95CriticalPathLatencyMs === "number"
          ? summary.p95CriticalPathLatencyMs
          : null,
      usageBasis: typeof summary?.usageBasis === "string" ? summary.usageBasis : undefined,
      escapedPermissionViolations:
        typeof summary?.escapedPermissionViolations === "number"
          ? summary.escapedPermissionViolations
          : undefined,
      externalSideEffects:
        typeof summary?.externalSideEffects === "number" ? summary.externalSideEffects : undefined,
      recoveryPassByPattern: summary?.recoveryPassByPattern,
      reason: blocked
        ? "shadow latest summary is blocked or discarded"
        : ageMs > 24 * 60 * 60 * 1000
          ? "shadow latest summary is older than 24 hours"
          : "shadow latest summary is fresh",
    };
  } catch {
    return {
      status: "missing",
      latestPath: MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
      reason: "shadow latest summary is missing or not valid JSON",
    };
  }
}

function decisionIds(value: unknown): string[] {
  const decisions = recordValue(value)?.decisions;
  return arrayValue(decisions)
    .map((decision) => recordValue(decision)?.id)
    .filter((id): id is string => typeof id === "string");
}

function compactOwner(id: OwnerId, payload: Record<string, unknown> | undefined) {
  if (!payload) {
    return {};
  }

  if (id === "problemRadar") {
    return {
      clusters: recordValue(payload.summary)?.clusters,
      actionableClusters: payload.actionableClusters,
      repairableSignals: payload.repairableSignals,
      blockedClusters: payload.blockedClusters,
      highestSeverity: recordValue(payload.summary)?.highestSeverity,
      nextActions: payload.nextActions,
      blockedActions: payload.blockedActions,
    };
  }

  if (id === "commercialAcceptance") {
    return {
      readyForCommercialRelease: payload.readyForCommercialRelease,
      summary: payload.summary,
      failedGates: payload.failedGates,
      blockedGates: payload.blockedGates,
      watchGates: payload.watchGates,
      nextActions: payload.nextActions,
    };
  }

  if (id === "changeImpact") {
    return {
      changedFiles: payload.changedFiles,
      affectedLanes: payload.affectedLanes,
      unmatchedFiles: payload.unmatchedFiles,
      recommendedFastCommands: payload.recommendedFastCommands,
      deferredCommands: payload.deferredCommands,
      safetyNotes: payload.safetyNotes,
    };
  }

  if (id === "projectionReaderAudit") {
    const summary = recordValue(payload.summary);
    return {
      contract: payload.contract,
      coverageStatus: summary?.coverageStatus,
      readerContractReadyForAllAdapters: summary?.readerContractReadyForAllAdapters,
      allKnownEntrypointsAudited: summary?.allKnownEntrypointsAudited,
      bound: summary?.bound,
      missingReaderContract: summary?.missingReaderContract,
      missingEntrypoints: summary?.missingEntrypoints,
      nextAction: payload.nextAction,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  if (id === "universeIndex") {
    const summary = recordValue(payload.summary);
    const repo = recordValue(payload.repo);
    const ownerCoverage = recordValue(payload.ownerCoverage);
    const garbageCandidates = recordValue(payload.garbageCandidates);
    return {
      summary: payload.summary,
      latestStatePath: payload.latestStatePath,
      trackedFiles: summary?.trackedFiles,
      visibleFiles: summary?.visibleFiles,
      dirtyFiles: summary?.dirtyFiles,
      untrackedFiles: summary?.untrackedFiles,
      workspaceArtifactFiles: summary?.workspaceArtifactFiles,
      liveSidecarFiles: summary?.liveSidecarFiles,
      unmatchedChangedFiles: summary?.unmatchedChangedFiles,
      staleRuntimeCandidates: summary?.staleRuntimeCandidates,
      largeRuntimeCandidates: summary?.largeRuntimeCandidates,
      staleSnapshots: summary?.staleSnapshots,
      repoBranch: repo?.branch,
      changedFiles: repo?.changedFiles,
      untrackedRepoFiles: garbageCandidates?.untrackedRepoFiles,
      unmatchedChangedFileList: garbageCandidates?.unmatchedChangedFiles,
      staleSnapshotsList: garbageCandidates?.staleSnapshots,
      governanceOwnerCount: ownerCoverage?.governanceOwnerCount,
      nextSafeCommands: payload.nextSafeCommands,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  if (id === "externalAgentUpgrade") {
    const summary = recordValue(payload.summary);
    return {
      summary: payload.summary,
      architectureFit: payload.architectureFit,
      perfectIntegrationClaim: summary?.perfectIntegrationClaim,
      registeredCandidateCount: summary?.registeredCandidateCount,
      architectureIntegratedCount: summary?.architectureIntegratedCount,
      runtimeAuthorityGrantedCount: summary?.runtimeAuthorityGrantedCount,
      blacktechMechanismCount: summary?.blacktechMechanismCount,
      blacktechReadyLocalOnlyCount: summary?.blacktechReadyLocalOnlyCount,
      blacktechPartialLocalOnlyCount: summary?.blacktechPartialLocalOnlyCount,
      blacktechRuntimeAuthorityGrantedCount: summary?.blacktechRuntimeAuthorityGrantedCount,
      blacktechAutopilotRoutedCount: summary?.blacktechAutopilotRoutedCount,
      blacktechMechanisms: payload.blacktechMechanisms,
      nextBlacktechProbes: payload.nextBlacktechProbes,
      nextLocalProbes: payload.nextLocalProbes,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  if (id === "externalChannelStatus") {
    const externalChannelStatus = recordValue(payload.externalChannelStatus);
    const legacyPromoteLiveStatus = recordValue(payload.legacyPromoteLiveStatus);
    return {
      boundary: payload.boundary,
      owner: payload.owner,
      conceptStatus: payload.conceptStatus,
      statusModel: externalChannelStatus?.statusModel,
      externalChannelBound: externalChannelStatus?.externalChannelBound,
      userVisibleObserved: externalChannelStatus?.userVisibleObserved,
      channelProbePassed: externalChannelStatus?.channelProbePassed,
      channelRestartCommandStatus: externalChannelStatus?.channelRestartCommandStatus,
      legacyPromoteLiveStatus: legacyPromoteLiveStatus
        ? {
            owner: legacyPromoteLiveStatus.owner,
            boundary: legacyPromoteLiveStatus.boundary,
            status: legacyPromoteLiveStatus.status,
          }
        : undefined,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  if (id === "trainingPlan") {
    const liveLarkBrainBinding = recordValue(payload.liveLarkBrainBinding);
    const externalChannelBinding = recordValue(payload.externalChannelBinding);
    const accelerationQueue = recordValue(payload.evolutionAccelerationQueue);
    const latestCandidateEval = recordValue(payload.latestCandidateEval);
    const activeGuardAdapterTruth = recordValue(payload.activeGuardAdapterTruth);
    return {
      activeProcessCount: arrayValue(payload.activeProcesses).length,
      activeHeavyEvalCounts: payload.activeHeavyEvalCounts,
      latestGuardEvent: payload.latestGuardEvent,
      latestEvolutionCooldown: payload.latestEvolutionCooldown,
      evolutionCooldownActive: payload.evolutionCooldownActive,
      activeGuardEvolutionCooldown: payload.activeGuardEvolutionCooldown,
      selectedCleanAdapter:
        payload.selectedCleanAdapter ??
        externalChannelBinding?.selectedCleanAdapter ??
        liveLarkBrainBinding?.selectedCleanAdapter,
      decisionIds: decisionIds(payload),
      latestCandidateEval: latestCandidateEval
        ? {
            adapterPath: latestCandidateEval.adapterPath,
            promotionReady: latestCandidateEval.promotionReady,
            failedCaseIds: latestCandidateEval.failedCaseIds,
            parseErrorCaseIds: latestCandidateEval.parseErrorCaseIds,
            parseRecoveredCaseIds: latestCandidateEval.parseRecoveredCaseIds,
          }
        : undefined,
      guardUsesSelectedCleanAdapter: activeGuardAdapterTruth?.guardUsesSelectedCleanAdapter,
      externalChannelBinding: externalChannelBinding
        ? {
            status: externalChannelBinding.status,
            action: externalChannelBinding.action,
            missingProof: externalChannelBinding.missingProof,
            userVisibleObserved: externalChannelBinding.userVisibleObserved,
          }
        : undefined,
      liveLarkBrainBinding: liveLarkBrainBinding
        ? {
            status: liveLarkBrainBinding.status,
            action: liveLarkBrainBinding.action,
            missingProof: liveLarkBrainBinding.missingProof,
          }
        : undefined,
      evolutionAcceleration: accelerationQueue
        ? {
            activeTrainingOrEval: accelerationQueue.activeTrainingOrEval,
            canStartHeavyWorkNow: accelerationQueue.canStartHeavyWorkNow,
            activeNonIdleProgress: accelerationQueue.activeNonIdleProgress,
            fastestSafeNextAction: accelerationQueue.fastestSafeNextAction,
            readyNowCount: accelerationQueue.readyNowCount,
            idleOnlyCount: accelerationQueue.idleOnlyCount,
            blockedCount: accelerationQueue.blockedCount,
          }
        : undefined,
    };
  }

  if (id === "skillOptLite") {
    return {
      phase: payload.phase,
      status: payload.status,
      accepted: payload.accepted,
      skillId: payload.skillId,
      requestedSkillId: payload.requestedSkillId,
      matchedSkillIds: payload.matchedSkillIds,
      skillFamilyCount: payload.skillFamilyCount,
      activeProcessCount: payload.activeProcessCount,
      latestCandidateAdapter: payload.latestCandidateAdapter,
      latestCandidatePromotionReady: payload.latestCandidatePromotionReady,
      parseRecoveredCount: payload.parseRecoveredCount,
      trainCaseCount: payload.trainCaseCount,
      validationCaseCount: payload.validationCaseCount,
      regressionCaseCount: payload.regressionCaseCount,
      staticGateOk: payload.staticGateOk,
      staticGateScore: payload.staticGateScore,
      staticGateMissingTokens: payload.staticGateMissingTokens,
      bestSkillPath: payload.bestSkillPath,
      candidatePath: payload.candidatePath,
      skillPackets: payload.skillPackets,
      instantPreflight: payload.instantPreflight,
      proofChain: payload.proofChain,
      absorptionPlan: payload.absorptionPlan,
      externalChannelProofPlan: payload.externalChannelProofPlan,
      nextIdleAction: payload.nextIdleAction,
      nextIdleCommand: payload.nextIdleCommand,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  if (id === "selfRepairHands") {
    const hands = recordValue(payload.hands);
    const memoryCleaner = recordValue(hands?.memoryCleaner);
    const trainingCaseBuilder = recordValue(hands?.trainingCaseBuilder);
    const patchCandidateBuilder = recordValue(hands?.patchCandidateBuilder);
    const supervision = recordValue(payload.supervision);
    return {
      status: payload.status,
      signalKey: payload.signalKey,
      issue: payload.issue,
      domain: payload.domain,
      allowlistedWriteRoots: payload.allowlistedWriteRoots,
      memoryCleaner: memoryCleaner
        ? {
            canWriteWithoutCodex: memoryCleaner.canWriteWithoutCodex,
            action: memoryCleaner.action,
            path: memoryCleaner.path,
          }
        : undefined,
      trainingCaseBuilder: trainingCaseBuilder
        ? {
            canWriteWithoutCodex: trainingCaseBuilder.canWriteWithoutCodex,
            action: trainingCaseBuilder.action,
            path: trainingCaseBuilder.path,
            absorptionStatus: trainingCaseBuilder.absorptionStatus,
          }
        : undefined,
      patchCandidateBuilder: patchCandidateBuilder
        ? {
            canWriteWithoutCodex: patchCandidateBuilder.canWriteWithoutCodex,
            action: patchCandidateBuilder.action,
            path: patchCandidateBuilder.path,
            absorptionStatus: patchCandidateBuilder.absorptionStatus,
          }
        : undefined,
      supervision,
      latestWrittenReceipt: payload.latestWrittenReceipt,
      writtenArtifacts: payload.writtenArtifacts,
      nextSafeAction: payload.nextSafeAction,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  if (id === "monotonicDataLedger") {
    const dataset = recordValue(payload.dataset);
    const datasetCounts = recordValue(dataset?.counts);
    const trainSlice = recordValue(payload.trainSlice);
    const trainSliceCounts = recordValue(trainSlice?.counts);
    const dispositions = recordValue(payload.dispositions);
    const promotion = recordValue(payload.promotion);
    const latestCandidateEval = recordValue(promotion?.latestCandidateEval);
    const deltaFromPrevious = recordValue(payload.deltaFromPrevious);
    return {
      appendDecision: payload.appendDecision,
      guaranteeLevel: payload.guaranteeLevel,
      entryKey: payload.entryKey,
      datasetExamples: datasetCounts?.examples,
      datasetTrain: datasetCounts?.train,
      datasetSourceFiles: datasetCounts?.sourceFiles,
      datasetSourceKindCount: dataset?.sourceKindCount,
      trainSliceWritten: trainSliceCounts?.trainWritten,
      trainSliceSourceTrain: trainSliceCounts?.sourceTrain,
      acceptedSkillOptPackets: dispositions?.acceptedSkillOptPackets,
      pendingSkillOptEvalPackets: dispositions?.pendingSkillOptEvalPackets,
      acceptedSkillIds: dispositions?.acceptedSkillIds,
      rejectedOrBlockedCurrentCandidateCases: dispositions?.rejectedOrBlockedCurrentCandidateCases,
      blockedAdapterCandidates: dispositions?.blockedAdapterCandidates,
      cleanAdapterCandidates: dispositions?.cleanAdapterCandidates,
      downrankedOrWeakModuleLearningCount: dispositions?.downrankedOrWeakModuleLearningCount,
      moduleLearningApplicationReady: dispositions?.moduleLearningApplicationReady,
      moduleLearningEvalAbsorbed: dispositions?.moduleLearningEvalAbsorbed,
      selectedCleanAdapter: promotion?.selectedCleanAdapter,
      latestCandidatePromotionReady: latestCandidateEval?.promotionReady,
      latestCandidateFailedCaseIds: latestCandidateEval?.failedCaseIds,
      latestCandidateParseRecoveredCaseIds: latestCandidateEval?.parseRecoveredCaseIds,
      deltaFromPrevious,
      proofBoundaries: payload.proofBoundaries,
      materialChangeSignalCount: payload.materialChangeSignalCount,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  if (id === "providerCouncilAcceleration") {
    return {
      status: payload.status,
      action: payload.action,
      profile: payload.profile,
      gitClean: payload.gitClean,
      activeEvalOrMlx: payload.activeEvalOrMlx,
      activePidCounts: payload.activePidCounts,
      latestCouncil: payload.latestCouncil,
      freshCompleteCouncil: payload.freshCompleteCouncil,
      dailyUse: payload.dailyUse,
      hardBlocks: payload.hardBlocks,
      canRunProviderCouncilNow: payload.canRunProviderCouncilNow,
      blockedCaseIds: payload.blockedCaseIds,
      outputsFeed: payload.outputsFeed,
      nextSafeCommand: payload.nextSafeCommand,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  if (id === "liveFadeoutAudit") {
    const summary = recordValue(payload.summary);
    const inventory = recordValue(payload.liveReferenceInventory);
    const inventoryCounts = recordValue(inventory?.counts);
    return {
      statusModel: payload.statusModel,
      summary,
      liveReferenceMatches: summary?.liveReferenceMatches,
      liveReferenceNeedsReview: summary?.liveReferenceNeedsReview,
      needsReviewSamples: inventory?.needsReviewSamples,
      canonicalOwnerReferences: inventoryCounts?.canonical_external_channel_owner,
      legacyCompatibilityReferences: inventoryCounts?.legacy_live_compatibility,
      openClawLiveTestReferences: inventoryCounts?.openclaw_live_test_or_platform_feature,
      historicalOpsReferences: inventoryCounts?.historical_ops_receipt,
      actionableFailures: payload.actionableFailures,
      advisoryWarnings: payload.advisoryWarnings,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  if (id === "externalChannelBinding") {
    const decision = recordValue(payload.decision);
    const externalChannelBinding = recordValue(payload.externalChannelBinding);
    return {
      status: decision?.status,
      action: decision?.action,
      selectedCleanAdapter: decision?.selectedCleanAdapter,
      missingProof: decision?.missingProof,
      heavyActive: decision?.heavyActive,
      externalChannelStatus: externalChannelBinding?.status,
      externalChannelAction: externalChannelBinding?.action,
      externalChannelMissingProof: externalChannelBinding?.missingProof,
      userVisibleObserved: externalChannelBinding?.userVisibleObserved,
      liveUserSeen: decision?.liveUserSeen,
      liveSidecarDriftBefore: payload.liveSidecarDriftBefore,
    };
  }

  if (id === "mindModel") {
    return {
      summary: payload.summary,
      actionableFailures: payload.actionableFailures,
      missingSurfaceFiles: payload.missingSurfaceFiles,
    };
  }

  if (id === "flowGraph") {
    return {
      summary: payload.summary,
      actionableFailures: payload.actionableFailures,
      diagnosticEntries: recordValue(payload.summary)?.diagnosticEntries,
    };
  }

  if (id === "headTail") {
    return {
      summary: payload.summary,
      moduleCounts: payload.moduleCounts,
      actionableFailures: payload.actionableFailures,
    };
  }

  return {
    summary: payload.summary,
    actionableFailures: payload.actionableFailures,
    actionableWarnings: payload.actionableWarnings,
    compressedContextRecovered: payload.compressedContextRecovered,
  };
}

async function runOwner(command: OwnerCommand): Promise<OwnerRun> {
  const args = ["--import", "tsx", command.script, ...(command.args ?? [])];
  const renderedCommand = `node ${args.join(" ")}`;
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    return {
      id: command.id,
      command: renderedCommand,
      exitCode: 0,
      parsed: true,
      ok: typeof payload.ok === "boolean" ? payload.ok : undefined,
      boundary: typeof payload.boundary === "string" ? payload.boundary : undefined,
      summary: payload.summary,
      compact: compactOwner(command.id, payload),
      projection: payload.globalEvidenceProjection,
    };
  } catch (error) {
    const details = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    try {
      const payload = JSON.parse(details.stdout ?? "") as Record<string, unknown>;
      return {
        id: command.id,
        command: renderedCommand,
        exitCode: typeof details.code === "number" ? details.code : 1,
        parsed: true,
        ok: typeof payload.ok === "boolean" ? payload.ok : undefined,
        boundary: typeof payload.boundary === "string" ? payload.boundary : undefined,
        summary: payload.summary,
        compact: compactOwner(command.id, payload),
        projection: payload.globalEvidenceProjection,
        error: details.stderr?.trim() || details.message,
      };
    } catch {
      return {
        id: command.id,
        command: renderedCommand,
        exitCode: typeof details.code === "number" ? details.code : 1,
        parsed: false,
        ok: false,
        boundary: undefined,
        summary: undefined,
        compact: {},
        error: [details.message, details.stderr].filter(Boolean).join("\n"),
      };
    }
  }
}

async function runSelfRepairAutoWrite(signal: SelfRepairAutoSignal): Promise<OwnerRun> {
  return runOwner({
    id: "selfRepairHands",
    script: "scripts/operator/lcx-self-repair-hands.ts",
    args: [
      "--write",
      "--json",
      "--signal-key",
      signal.signalKey,
      "--issue",
      signal.issue,
      "--observed-failure",
      signal.observedFailure,
      "--replacement-rule",
      signal.replacementRule,
      "--domain",
      signal.domain,
    ],
    required: true,
  });
}

function selfRepairLatestSignalKey(selfRepairCompact: Record<string, unknown> | undefined) {
  const latestWritten = recordValue(selfRepairCompact?.latestWrittenReceipt);
  return typeof latestWritten?.signalKey === "string" ? latestWritten.signalKey : undefined;
}

function buildSelfRepairAutoSignal(
  byOwner: Partial<Record<OwnerId, OwnerRun>>,
): SelfRepairAutoSignal | undefined {
  const trainingCompact = byOwner.trainingPlan?.compact ?? {};
  const skillOptCompact = byOwner.skillOptLite?.compact ?? {};
  const decisionIdList = stringArray(trainingCompact.decisionIds);
  const latestCandidateEval = recordValue(trainingCompact.latestCandidateEval);
  const failedCaseIds = stringArray(latestCandidateEval?.failedCaseIds);
  const parseErrorCaseIds = stringArray(latestCandidateEval?.parseErrorCaseIds);
  const parseRecoveredCaseIds = stringArray(latestCandidateEval?.parseRecoveredCaseIds);
  const dirtyCaseIds = [...failedCaseIds, ...parseErrorCaseIds, ...parseRecoveredCaseIds].filter(
    (caseId, index, array) => array.indexOf(caseId) === index,
  );

  if (dirtyCaseIds.length > 0) {
    const compactCases = dirtyCaseIds.slice(0, 8).join(",");
    return {
      policyTriggerId: "candidate_eval_dirty_cases",
      signalKey: `candidate_eval_dirty_cases:${compactCases}`,
      issue: "candidate_eval_dirty_cases_auto_self_repair",
      domain: "candidate_eval_memory_and_training_case_repair",
      observedFailure: `Candidate eval has dirty or recovered cases: ${compactCases}. These must become correction/downrank notes and training/eval candidate packets before any train-slice or promotion claim.`,
      replacementRule:
        "Preserve the selected clean adapter; write candidate-only self-repair material for dirty eval cases, require owner review, and absorb only through approved eval/train-slice paths after heavy work is idle.",
    };
  }

  if (decisionIdList.includes("module_learning_incomplete_evidence")) {
    return {
      policyTriggerId: "module_learning_incomplete_evidence",
      signalKey: "module_learning_incomplete_evidence:self_repair_candidate",
      issue: "module_learning_incomplete_evidence_auto_self_repair",
      domain: "module_learning_memory_and_training_candidate_repair",
      observedFailure:
        "Module-learning evidence is incomplete, so stored receipts or summaries must not be treated as model absorption or durable truth.",
      replacementRule:
        "Write a correction/downrank note and a training/eval candidate packet that require source registry, retrieval/apply evidence, adjacent application, review, and keep/downrank/discard before reuse.",
    };
  }

  if (
    skillOptCompact.staticGateOk === false ||
    Number(skillOptCompact.parseRecoveredCount ?? 0) > 0
  ) {
    return {
      policyTriggerId: "skillopt_static_or_parse_gap",
      signalKey: "skillopt_static_or_parse_gap:self_repair_candidate",
      issue: "skillopt_static_or_parse_gap_auto_self_repair",
      domain: "skillopt_training_candidate_repair",
      observedFailure:
        "SkillOpt-lite reports a static gate or parse-recovery gap, so the candidate rule must stay as supervised material instead of runtime or model-weight authority.",
      replacementRule:
        "Write candidate-only self-repair material for the SkillOpt gap, then wait for targeted eval and owner acceptance before training or external-channel use.",
    };
  }

  return undefined;
}

function ownerMap(owners: readonly OwnerRun[]) {
  return Object.fromEntries(owners.map((owner) => [owner.id, owner])) as Partial<
    Record<OwnerId, OwnerRun>
  >;
}

function hasBoundaryTouch(owners: readonly OwnerRun[], key: string): boolean {
  return owners.some((owner) => {
    const compact = owner.compact;
    return compact[key] === true;
  });
}

function trainingActive(trainingPlan: OwnerRun | undefined, liveBinding: OwnerRun | undefined) {
  const trainingCompact = trainingPlan?.compact ?? {};
  const liveCompact = liveBinding?.compact ?? {};
  const activeCounts = recordValue(trainingCompact.activeHeavyEvalCounts);
  const localBrainEval = Number(activeCounts?.localBrainEval ?? 0);
  const mlx = Number(activeCounts?.mlx ?? 0);
  return (
    Number(trainingCompact.activeProcessCount ?? 0) > 0 ||
    localBrainEval > 0 ||
    mlx > 0 ||
    liveCompact.heavyActive === true
  );
}

async function gitStatusShortBranch() {
  const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
    cwd: repoRoot,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

async function activePidSummary(): Promise<ActivePidSummary> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid,etime,command"], {
    maxBuffer: EXEC_MAX_BUFFER,
  });
  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      return (
        line.includes("scripts/operator/minimax-brain-training-guard.ts") ||
        line.includes("scripts/operator/minimax-quota-brain-saturator.ts") ||
        line.includes("scripts/operator/minimax-brain-teacher-batch.ts") ||
        line.includes("scripts/operator/local-brain-distill-eval.ts") ||
        /mlx_lm (generate|lora)/.test(line)
      );
    });
  return {
    guard: lines.filter((line) =>
      line.includes("scripts/operator/minimax-brain-training-guard.ts"),
    ),
    eval: lines.filter((line) => line.includes("scripts/operator/local-brain-distill-eval.ts")),
    mlx: lines.filter((line) => /mlx_lm (generate|lora)/.test(line)),
    teacher: lines.filter((line) =>
      line.includes("scripts/operator/minimax-brain-teacher-batch.ts"),
    ),
    quota: lines.filter((line) =>
      line.includes("scripts/operator/minimax-quota-brain-saturator.ts"),
    ),
  };
}

function activePidCounts(summary: ActivePidSummary) {
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, value.length]));
}

function truncateLine(value: string, maxLength = 220) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function inlineValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "unknown";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((item) => inlineValue(item)).join(", ") : "none";
  }
  if (typeof value === "object") {
    return truncateLine(JSON.stringify(value));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return truncateLine(String(value));
  }
  return "unknown";
}

function markdownList(value: unknown): string {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  if (items.length === 0) {
    return "- none";
  }
  return items.map((item) => `- ${inlineValue(item)}`).join("\n");
}

function activePidHandoffLines(activePids: ActivePidSummary): string[] {
  return Object.entries(activePids).map(([kind, lines]) => {
    const first = lines[0] ? `; first=${truncateLine(lines[0], 160)}` : "";
    return `- ${kind}: ${lines.length}${first}`;
  });
}

function buildContextRecoveryHandoff({
  receipt,
  gitStatusLines,
  activePids,
  digestMaterial,
  universeIndexCompact,
  trainingCompact,
  skillOptCompact,
  monotonicDataLedgerCompact,
  providerCouncilAccelerationCompact,
  externalChannelBindingCompact,
  externalAgentUpgradeCompact,
  projectionReaderAuditCompact,
  localFailureTrace,
}: {
  receipt: HandoffReceipt;
  gitStatusLines: string[];
  activePids: ActivePidSummary;
  digestMaterial: Record<string, unknown>;
  universeIndexCompact: Record<string, unknown> | undefined;
  trainingCompact: Record<string, unknown> | undefined;
  skillOptCompact: Record<string, unknown> | undefined;
  monotonicDataLedgerCompact: Record<string, unknown> | undefined;
  providerCouncilAccelerationCompact: Record<string, unknown> | undefined;
  externalChannelBindingCompact: Record<string, unknown> | undefined;
  externalAgentUpgradeCompact: Record<string, unknown> | undefined;
  projectionReaderAuditCompact: Record<string, unknown> | undefined;
  localFailureTrace: LocalFailureTraceReceipt;
}) {
  const latestCandidateEval = recordValue(trainingCompact?.latestCandidateEval);
  const evolutionAcceleration = recordValue(trainingCompact?.evolutionAcceleration);
  const activeNonIdleProgress = recordValue(evolutionAcceleration?.activeNonIdleProgress);
  return [
    "# LCX Context Recovery Handoff",
    "",
    `generatedAt: ${receipt.checkedAt}`,
    "boundary: local_context_recovery_handoff_only",
    "owner: lcx-governance-autopilot",
    `repo: ${repoRoot}`,
    `branch: ${gitStatusLines[0] ?? "unknown"}`,
    `dirtyCount: ${Math.max(0, gitStatusLines.length - 1)}`,
    "",
    "## Universe Index",
    `- latestStatePath: ${inlineValue(universeIndexCompact?.latestStatePath)}`,
    `- trackedFiles: ${inlineValue(universeIndexCompact?.trackedFiles)}`,
    `- visibleFiles: ${inlineValue(universeIndexCompact?.visibleFiles)}`,
    `- dirtyFiles: ${inlineValue(universeIndexCompact?.dirtyFiles)}`,
    `- untrackedFiles: ${inlineValue(universeIndexCompact?.untrackedFiles)}`,
    `- workspaceArtifactFiles: ${inlineValue(universeIndexCompact?.workspaceArtifactFiles)}`,
    `- liveSidecarFiles: ${inlineValue(universeIndexCompact?.liveSidecarFiles)}`,
    `- unmatchedChangedFiles: ${inlineValue(universeIndexCompact?.unmatchedChangedFiles)}`,
    `- staleRuntimeCandidates: ${inlineValue(universeIndexCompact?.staleRuntimeCandidates)}`,
    `- staleSnapshots: ${inlineValue(universeIndexCompact?.staleSnapshots)}`,
    "- boundary: local_universe_index_only; inventory and cleanup candidates only, no delete/migration/live authority",
    "",
    "## Active PIDs",
    ...activePidHandoffLines(activePids),
    "",
    "## Training Truth",
    `- activeTrainingOrEval: ${inlineValue(receipt.summary.activeTrainingOrEval)}`,
    `- fastestSafeNextAction: ${inlineValue(receipt.summary.fastestSafeNextAction)}`,
    `- activeNonIdleStatus: ${inlineValue(activeNonIdleProgress?.status)}`,
    `- activeNonIdleReason: ${inlineValue(activeNonIdleProgress?.reason)}`,
    `- activeEvalAdapters: ${inlineValue(activeNonIdleProgress?.activeEvalAdapters)}`,
    `- latestBlockedCaseIds: ${inlineValue(activeNonIdleProgress?.latestBlockedCaseIds)}`,
    `- nextIdleAction: ${inlineValue(activeNonIdleProgress?.nextIdleAction)}`,
    `- evolutionCooldownActive: ${inlineValue(trainingCompact?.evolutionCooldownActive)}`,
    `- latestEvolutionCooldown: ${inlineValue(trainingCompact?.latestEvolutionCooldown)}`,
    `- latestGuardEvent: ${inlineValue(trainingCompact?.latestGuardEvent)}`,
    `- activeGuardEvolutionCooldown: ${inlineValue(trainingCompact?.activeGuardEvolutionCooldown)}`,
    `- selectedCleanAdapter: ${inlineValue(trainingCompact?.selectedCleanAdapter)}`,
    `- latestCandidateAdapter: ${inlineValue(latestCandidateEval?.adapterPath)}`,
    `- promotionReady: ${inlineValue(latestCandidateEval?.promotionReady)}`,
    `- failedCaseIds: ${inlineValue(latestCandidateEval?.failedCaseIds)}`,
    `- parseErrorCaseIds: ${inlineValue(latestCandidateEval?.parseErrorCaseIds)}`,
    `- parseRecoveredCaseIds: ${inlineValue(latestCandidateEval?.parseRecoveredCaseIds)}`,
    `- guardUsesSelectedCleanAdapter: ${inlineValue(trainingCompact?.guardUsesSelectedCleanAdapter)}`,
    `- decisionIds: ${inlineValue(trainingCompact?.decisionIds)}`,
    `- canStartHeavyWorkNow: ${inlineValue(evolutionAcceleration?.canStartHeavyWorkNow)}`,
    "",
    "## SkillOpt-lite",
    `- status: ${inlineValue(skillOptCompact?.status)}`,
    `- skillId: ${inlineValue(skillOptCompact?.skillId)}`,
    `- matchedSkillIds: ${inlineValue(skillOptCompact?.matchedSkillIds)}`,
    `- skillFamilyCount: ${inlineValue(skillOptCompact?.skillFamilyCount)}`,
    `- accepted: ${inlineValue(skillOptCompact?.accepted)}`,
    `- phase: ${inlineValue(skillOptCompact?.phase)}`,
    `- staticGateOk: ${inlineValue(skillOptCompact?.staticGateOk)}`,
    `- parseRecoveredCount: ${inlineValue(skillOptCompact?.parseRecoveredCount)}`,
    `- trainCaseCount: ${inlineValue(skillOptCompact?.trainCaseCount)}`,
    `- validationCaseCount: ${inlineValue(skillOptCompact?.validationCaseCount)}`,
    `- regressionCaseCount: ${inlineValue(skillOptCompact?.regressionCaseCount)}`,
    `- bestSkillPath: ${inlineValue(skillOptCompact?.bestSkillPath)}`,
    `- candidatePath: ${inlineValue(skillOptCompact?.candidatePath)}`,
    `- nextIdleAction: ${inlineValue(skillOptCompact?.nextIdleAction)}`,
    `- nextIdleCommand: ${inlineValue(skillOptCompact?.nextIdleCommand)}`,
    `- instantPreflightStatus: ${inlineValue(recordValue(skillOptCompact?.instantPreflight)?.status)}`,
    `- modelAbsorptionStatus: ${inlineValue(recordValue(skillOptCompact?.absorptionPlan)?.status)}`,
    `- externalChannelProofStatus: ${inlineValue(recordValue(skillOptCompact?.externalChannelProofPlan)?.status)}`,
    "- boundary: local_skillopt_lite_only; immediate preflight is SOP context, not model-weight absorption or user-visible proof",
    "",
    "## Self-Repair Hands",
    `- latestPath: ${inlineValue(SELF_REPAIR_HANDS_LATEST_PATH)}`,
    `- markdownPath: ${inlineValue(SELF_REPAIR_HANDS_MARKDOWN_PATH)}`,
    `- jsonlPath: ${inlineValue(SELF_REPAIR_HANDS_JSONL_PATH)}`,
    `- autoWriteTriggered: ${inlineValue(selfRepairAutoWriteRun !== undefined)}`,
    `- autoSignal: ${inlineValue(selfRepairAutoSignal)}`,
    `- ownerPolicy.whenAutoWrite: ${inlineValue(
      SELF_REPAIR_HANDS_OWNER_WRITE_POLICY.whenAutoWrite.map((rule) => rule.id),
    )}`,
    `- ownerPolicy.dedupeKey: ${inlineValue(SELF_REPAIR_HANDS_OWNER_WRITE_POLICY.dedupeKey)}`,
    `- ownerPolicy.writeOncePerSignalKey: ${inlineValue(
      SELF_REPAIR_HANDS_OWNER_WRITE_POLICY.writeOncePerSignalKey,
    )}`,
    `- ownerPolicy.afterWriteGate: ${inlineValue(
      SELF_REPAIR_HANDS_OWNER_WRITE_POLICY.afterWriteGate,
    )}`,
    `- status: ${inlineValue(selfRepairHandsCompact?.status)}`,
    `- latestWrittenStatus: ${inlineValue(selfRepairLatestWritten?.status)}`,
    `- latestWrittenSignalKey: ${inlineValue(selfRepairLatestWritten?.signalKey)}`,
    `- memoryCleaner: ${inlineValue(recordValue(selfRepairHandsCompact?.memoryCleaner)?.action)}`,
    `- trainingCaseBuilder: ${inlineValue(
      recordValue(selfRepairHandsCompact?.trainingCaseBuilder)?.action,
    )}`,
    `- patchCandidateBuilder: ${inlineValue(
      recordValue(selfRepairHandsCompact?.patchCandidateBuilder)?.action,
    )}`,
    `- nextSafeAction: ${inlineValue(selfRepairHandsCompact?.nextSafeAction)}`,
    "- boundary: local_self_repair_hands_only; can auto-write allowed correction, training-candidate, and patch-candidate packets only when owner signals change, or with explicit --write",
    "",
    "## Monotonic Data Ledger",
    `- latestPath: ${inlineValue(MONOTONIC_DATA_LEDGER_LATEST_PATH)}`,
    `- jsonlPath: ${inlineValue(MONOTONIC_DATA_LEDGER_JSONL_PATH)}`,
    `- appendDecision: ${inlineValue(monotonicDataLedgerCompact?.appendDecision)}`,
    `- guaranteeLevel: ${inlineValue(monotonicDataLedgerCompact?.guaranteeLevel)}`,
    `- datasetExamples: ${inlineValue(monotonicDataLedgerCompact?.datasetExamples)}`,
    `- datasetTrain: ${inlineValue(monotonicDataLedgerCompact?.datasetTrain)}`,
    `- trainSliceWritten: ${inlineValue(monotonicDataLedgerCompact?.trainSliceWritten)}`,
    `- acceptedSkillOptPackets: ${inlineValue(monotonicDataLedgerCompact?.acceptedSkillOptPackets)}`,
    `- pendingSkillOptEvalPackets: ${inlineValue(monotonicDataLedgerCompact?.pendingSkillOptEvalPackets)}`,
    `- blockedAdapterCandidates: ${inlineValue(monotonicDataLedgerCompact?.blockedAdapterCandidates)}`,
    `- deltaFromPrevious: ${inlineValue(monotonicDataLedgerCompact?.deltaFromPrevious)}`,
    "- boundary: local_monotonic_data_ledger_only; data growth is not model absorption or user-visible proof",
    "",
    summarizeTraceForHandoff(localFailureTrace),
    "",
    "## Blacktech Upgrade Radar",
    `- architectureFit: ${inlineValue(externalAgentUpgradeCompact?.architectureFit)}`,
    `- registeredCandidateCount: ${inlineValue(externalAgentUpgradeCompact?.registeredCandidateCount)}`,
    `- blacktechMechanismCount: ${inlineValue(externalAgentUpgradeCompact?.blacktechMechanismCount)}`,
    `- blacktechReadyLocalOnlyCount: ${inlineValue(externalAgentUpgradeCompact?.blacktechReadyLocalOnlyCount)}`,
    `- blacktechPartialLocalOnlyCount: ${inlineValue(externalAgentUpgradeCompact?.blacktechPartialLocalOnlyCount)}`,
    `- blacktechAutopilotRoutedCount: ${inlineValue(externalAgentUpgradeCompact?.blacktechAutopilotRoutedCount)}`,
    `- runtimeAuthorityGrantedCount: ${inlineValue(externalAgentUpgradeCompact?.runtimeAuthorityGrantedCount)}`,
    `- blacktechRuntimeAuthorityGrantedCount: ${inlineValue(externalAgentUpgradeCompact?.blacktechRuntimeAuthorityGrantedCount)}`,
    `- perfectIntegrationClaim: ${inlineValue(externalAgentUpgradeCompact?.perfectIntegrationClaim)}`,
    `- nextBlacktechProbes: ${inlineValue(externalAgentUpgradeCompact?.nextBlacktechProbes)}`,
    "- boundary: local_external_agent_upgrade_radar_only; external blacktech is pattern intake, not runtime/live/provider/protected-memory authority",
    "",
    "## Provider Council Acceleration",
    `- status: ${inlineValue(providerCouncilAccelerationCompact?.status)}`,
    `- action: ${inlineValue(providerCouncilAccelerationCompact?.action)}`,
    `- profile: ${inlineValue(providerCouncilAccelerationCompact?.profile)}`,
    `- gitClean: ${inlineValue(providerCouncilAccelerationCompact?.gitClean)}`,
    `- activeEvalOrMlx: ${inlineValue(providerCouncilAccelerationCompact?.activeEvalOrMlx)}`,
    `- freshCompleteCouncil: ${inlineValue(providerCouncilAccelerationCompact?.freshCompleteCouncil)}`,
    `- hardBlocks: ${inlineValue(providerCouncilAccelerationCompact?.hardBlocks)}`,
    `- outputsFeed: ${inlineValue(providerCouncilAccelerationCompact?.outputsFeed)}`,
    `- nextSafeCommand: ${inlineValue(providerCouncilAccelerationCompact?.nextSafeCommand)}`,
    "- boundary: local_provider_council_acceleration_only; --write may call Kimi/MiniMax/DeepSeek once when gates are clean",
    "",
    "## Projection Reader Audit",
    `- contract: ${inlineValue(projectionReaderAuditCompact?.contract)}`,
    `- coverageStatus: ${inlineValue(projectionReaderAuditCompact?.coverageStatus)}`,
    `- bound: ${inlineValue(projectionReaderAuditCompact?.bound)}`,
    `- missingReaderContract: ${inlineValue(projectionReaderAuditCompact?.missingReaderContract)}`,
    `- readerContractReadyForAllAdapters: ${inlineValue(projectionReaderAuditCompact?.readerContractReadyForAllAdapters)}`,
    `- nextAction: ${inlineValue(projectionReaderAuditCompact?.nextAction)}`,
    "- boundary: local_projection_reader_audit_only; inventory does not grant sender or fact authority",
    "",
    "## Multi-agent Pattern Shadow",
    `- status: ${inlineValue(digestMaterial.multiAgentPatternShadowStatus)}`,
    `- decision: ${inlineValue(digestMaterial.multiAgentPatternShadowDecision)}`,
    `- normalPassRate: ${inlineValue(digestMaterial.multiAgentPatternShadowNormalPassRate)}`,
    `- p95CriticalPathLatencyMs: ${inlineValue(digestMaterial.multiAgentPatternShadowP95CriticalPathLatencyMs)}`,
    `- usageBasis: ${inlineValue(digestMaterial.multiAgentPatternShadowUsageBasis)}`,
    `- reason: ${inlineValue(digestMaterial.multiAgentPatternShadowReason)}`,
    "- boundary: local_multi_agent_pattern_shadow_only; governance reads latest summary and never triggers live shadow",
    "",
    "## External Channel Status",
    `- statusModel: ${inlineValue(externalChannelStatusCompact?.statusModel)}`,
    `- externalChannelBound: ${inlineValue(externalChannelStatusCompact?.externalChannelBound)}`,
    `- userVisibleObserved: ${inlineValue(externalChannelStatusCompact?.userVisibleObserved)}`,
    `- channelProbePassed: ${inlineValue(externalChannelStatusCompact?.channelProbePassed)}`,
    `- legacyPromoteLiveStatus: ${inlineValue(externalChannelStatusCompact?.legacyPromoteLiveStatus)}`,
    "- boundary: local_external_channel_status_only; read-only wrapper, no external-channel apply or sender authority",
    "",
    "## External Channel Binding",
    `- status: ${inlineValue(externalChannelBindingCompact?.status)}`,
    `- action: ${inlineValue(externalChannelBindingCompact?.action)}`,
    `- selectedCleanAdapter: ${inlineValue(externalChannelBindingCompact?.selectedCleanAdapter)}`,
    `- externalChannelStatus: ${inlineValue(externalChannelBindingCompact?.externalChannelStatus)}`,
    `- externalChannelAction: ${inlineValue(externalChannelBindingCompact?.externalChannelAction)}`,
    `- externalChannelMissingProof: ${inlineValue(externalChannelBindingCompact?.externalChannelMissingProof)}`,
    `- userVisibleObserved: ${inlineValue(externalChannelBindingCompact?.userVisibleObserved)}`,
    `- legacyMissingProof: ${inlineValue(externalChannelBindingCompact?.missingProof)}`,
    `- legacyLiveUserSeen: ${inlineValue(externalChannelBindingCompact?.liveUserSeen)}`,
    `- liveSidecarDriftBefore: ${inlineValue(externalChannelBindingCompact?.liveSidecarDriftBefore)}`,
    "",
    "## Governance",
    `- autopilotOk: ${inlineValue(receipt.ok)}`,
    `- structuralOwnerFailures: ${inlineValue(receipt.summary.structuralOwnerFailures)}`,
    `- blockedClusters: ${inlineValue(receipt.summary.blockedClusters)}`,
    `- blockedGates: ${inlineValue(receipt.summary.blockedGates)}`,
    `- mindModelFailed: ${inlineValue(digestMaterial.mindModelFailed)}`,
    `- flowGraphFailed: ${inlineValue(digestMaterial.flowGraphFailed)}`,
    `- headTailFailed: ${inlineValue(digestMaterial.headTailFailed)}`,
    `- contextRecoveryOk: ${inlineValue(digestMaterial.contextRecoveryOk)}`,
    "",
    "## Global Evidence Projection",
    `- readStatus: ${inlineValue(digestMaterial.globalEvidenceProjectionReadStatus)}`,
    `- blocked: ${inlineValue(digestMaterial.globalEvidenceProjectionBlocked)}`,
    `- generatedAt: ${inlineValue(digestMaterial.globalEvidenceProjectionGeneratedAt)}`,
    `- reason: ${inlineValue(digestMaterial.globalEvidenceProjectionReason)}`,
    "- stale, missing, or invalid projection blocks adapter actions; owner receipts remain authoritative",
    "",
    "## Next Safe Action",
    activePids.eval.length > 0 || activePids.mlx.length > 0
      ? `- non-empty wait: ${inlineValue(activeNonIdleProgress?.reason)}`
      : `- ${inlineValue(receipt.summary.fastestSafeNextAction)}`,
    "",
    "## Missing Proof",
    markdownList(externalChannelBindingCompact?.missingProof),
    "",
    "## Boundaries",
    `- liveTouched: ${inlineValue(receipt.liveTouched)}`,
    `- providerConfigTouched: ${inlineValue(receipt.providerConfigTouched)}`,
    `- protectedMemoryTouched: ${inlineValue(receipt.protectedMemoryTouched)}`,
    "- no user-visible-observed claim from this handoff",
    "- use fresh local-brain-training-plan before acting on volatile runtime truth",
    "- receipts and stored sources are not model-weight absorption proof",
  ].join("\n");
}

const options = parseArgs(process.argv.slice(2));
let owners = await Promise.all(OWNER_COMMANDS.map((command) => runOwner(command)));
let byOwner = ownerMap(owners);
const selfRepairAutoSignal = buildSelfRepairAutoSignal(byOwner);
const selfRepairAutoWriteNeeded =
  selfRepairAutoSignal !== undefined &&
  selfRepairLatestSignalKey(byOwner.selfRepairHands?.compact) !== selfRepairAutoSignal.signalKey;
let selfRepairAutoWriteRun: OwnerRun | undefined;
if (selfRepairAutoWriteNeeded && selfRepairAutoSignal) {
  selfRepairAutoWriteRun = await runSelfRepairAutoWrite(selfRepairAutoSignal);
  owners = owners.map((owner) =>
    owner.id === "selfRepairHands" ? selfRepairAutoWriteRun! : owner,
  );
  byOwner = ownerMap(owners);
}
const requiredParseFailures = owners.filter(
  (owner) => OWNER_COMMANDS.find((command) => command.id === owner.id)?.required && !owner.parsed,
);
const activeTrainingOrEval = trainingActive(byOwner.trainingPlan, byOwner.externalChannelBinding);
const structuralOwnerFailures = owners.filter((owner) => owner.parsed && owner.ok === false);
const releaseBlocked =
  byOwner.commercialAcceptance?.compact.readyForCommercialRelease === false ||
  stringArray(byOwner.problemRadar?.compact.actionableClusters).length > 0 ||
  stringArray(byOwner.problemRadar?.compact.blockedClusters).length > 0;
const governanceCheckedAt = new Date().toISOString();
const globalEvidenceProjectionReader = readGlobalEvidenceProjectionForAdapter(
  byOwner.mindModel?.projection,
  governanceCheckedAt,
  { adapterId: "governance-autopilot", sourceOwner: "mindModel" },
);
const globalEvidenceProjection: GlobalEvidenceProjectionRead = globalEvidenceProjectionReader.read;
const multiAgentPatternShadow = await readMultiAgentPatternShadowGovernance();

const receipt = {
  ok: requiredParseFailures.length === 0,
  boundary: "local_governance_autopilot_only",
  checkedAt: governanceCheckedAt,
  workspaceDir: DEFAULT_WORKSPACE_DIR,
  latestStatePath: GOVERNANCE_AUTOPILOT_LATEST_PATH,
  universeIndexLatestPath: UNIVERSE_INDEX_LATEST_PATH,
  evolutionPromotionDigestPath: EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
  monotonicDataLedgerLatestPath: MONOTONIC_DATA_LEDGER_LATEST_PATH,
  monotonicDataLedgerJsonlPath: MONOTONIC_DATA_LEDGER_JSONL_PATH,
  localFailureTraceLatestPath: LOCAL_FAILURE_TRACE_LATEST_PATH,
  localFailureTraceJsonlPath: LOCAL_FAILURE_TRACE_JSONL_PATH,
  selfRepairHandsLatestPath: SELF_REPAIR_HANDS_LATEST_PATH,
  selfRepairHandsMarkdownPath: SELF_REPAIR_HANDS_MARKDOWN_PATH,
  selfRepairHandsJsonlPath: SELF_REPAIR_HANDS_JSONL_PATH,
  ownerBriefLatestJsonPath: OWNER_BRIEF_LATEST_JSON_PATH,
  ownerBriefLatestMarkdownPath: OWNER_BRIEF_LATEST_MARKDOWN_PATH,
  ownerControlMapLatestJsonPath: OWNER_CONTROL_MAP_LATEST_JSON_PATH,
  ownerControlMapLatestMarkdownPath: OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH,
  multiAgentPatternShadowLatestPath: MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
  handoffLatestPath: CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
  globalEvidenceProjection,
  globalEvidenceProjectionReader: {
    contractVersion: globalEvidenceProjectionReader.contractVersion,
    adapterId: globalEvidenceProjectionReader.adapterId,
    readStatus: globalEvidenceProjectionReader.read.readStatus,
    blocked: globalEvidenceProjectionReader.read.blocked,
  },
  autoTriggeredOwnerCommands: OWNER_COMMANDS.map((command) => command.id),
  ownerCommands: owners.map((owner) => ({
    id: owner.id,
    command: owner.command,
    exitCode: owner.exitCode,
    parsed: owner.parsed,
    ok: owner.ok,
    boundary: owner.boundary,
  })),
  triggerPolicy: {
    readOnly: false,
    repoReadOnly: true,
    workspaceStateWrites: [
      "governance_autopilot_latest",
      "evolution_promotion_digest_latest",
      "context_recovery_handoff_latest",
      "monotonic_data_ledger_latest",
      "monotonic_data_ledger_jsonl",
      "local_failure_trace_latest",
      "local_failure_trace_jsonl",
      "self_repair_hands_latest_when_write_requested",
      "self_repair_hands_jsonl_when_write_requested",
      "self_repair_hands_markdown_when_write_requested",
      "self_repair_hands_auto_candidate_when_owner_signal_changes",
      "owner_brief_latest_json",
      "owner_brief_latest_markdown",
      "owner_control_map_latest_json",
      "owner_control_map_latest_markdown",
    ],
    autoUpdateLatestState: true,
    activeTrainingOrEval,
    heavyWorkDeferred: activeTrainingOrEval,
    idleOnlyWorkDeferred: activeTrainingOrEval,
    liveApplyDeferred: activeTrainingOrEval,
    evolutionPromotionDigestUpdated: true,
    contextRecoveryHandoffUpdated: true,
    monotonicDataLedgerWriteEnabled: true,
    localFailureTraceWriteEnabled: true,
    selfRepairHandsAutoWriteEnabled: true,
    selfRepairHandsWriteRequiresOwnerSignalOrExplicitWriteFlag: true,
    selfRepairHandsOwnerWritePolicy: SELF_REPAIR_HANDS_OWNER_WRITE_POLICY,
    selfRepairHandsAutoWriteTriggered: selfRepairAutoWriteRun !== undefined,
    selfRepairHandsAutoSignal: selfRepairAutoSignal,
    ownerBriefWriteEnabled: true,
    ownerControlMapWriteEnabled: true,
    noOverlappingTrainingStarted: true,
    noRepoMutationRequired: true,
    multiAgentPatternShadowReadOnly: true,
    multiAgentPatternShadowLiveNotTriggered: true,
  },
  summary: {
    parsedOwners: owners.filter((owner) => owner.parsed).length,
    ownerCount: owners.length,
    structuralOwnerFailures: structuralOwnerFailures.map((owner) => owner.id),
    releaseBlocked,
    activeTrainingOrEval,
    actionableClusters: byOwner.problemRadar?.compact.actionableClusters ?? [],
    blockedClusters: byOwner.problemRadar?.compact.blockedClusters ?? [],
    failedGates: byOwner.commercialAcceptance?.compact.failedGates ?? [],
    blockedGates: byOwner.commercialAcceptance?.compact.blockedGates ?? [],
    affectedLanes: byOwner.changeImpact?.compact.affectedLanes ?? [],
    unmatchedFiles: byOwner.changeImpact?.compact.unmatchedFiles ?? [],
    projectionReaderCoverageStatus: byOwner.projectionReaderAudit?.compact.coverageStatus,
    projectionReaderContractReadyForAllAdapters:
      byOwner.projectionReaderAudit?.compact.readerContractReadyForAllAdapters,
    projectionReaderMissingCount: byOwner.projectionReaderAudit?.compact.missingReaderContract,
    universeIndexDirtyFiles: byOwner.universeIndex?.compact.dirtyFiles,
    universeIndexUnmatchedChangedFiles: byOwner.universeIndex?.compact.unmatchedChangedFiles,
    universeIndexStaleRuntimeCandidates: byOwner.universeIndex?.compact.staleRuntimeCandidates,
    externalUpgradeBlacktechMechanismCount:
      byOwner.externalAgentUpgrade?.compact.blacktechMechanismCount,
    externalUpgradeRuntimeAuthorityGrantedCount:
      byOwner.externalAgentUpgrade?.compact.runtimeAuthorityGrantedCount,
    externalUpgradeBlacktechRuntimeAuthorityGrantedCount:
      byOwner.externalAgentUpgrade?.compact.blacktechRuntimeAuthorityGrantedCount,
    externalUpgradeBlacktechAutopilotRoutedCount:
      byOwner.externalAgentUpgrade?.compact.blacktechAutopilotRoutedCount,
    externalUpgradePerfectIntegrationClaim:
      byOwner.externalAgentUpgrade?.compact.perfectIntegrationClaim,
    liveFadeoutStatusModel: byOwner.liveFadeoutAudit?.compact.statusModel,
    liveFadeoutNeedsReview: byOwner.liveFadeoutAudit?.compact.liveReferenceNeedsReview,
    externalChannelStatusModel: byOwner.externalChannelStatus?.compact.statusModel,
    externalChannelBound: byOwner.externalChannelStatus?.compact.externalChannelBound,
    userVisibleObserved: byOwner.externalChannelStatus?.compact.userVisibleObserved,
    externalChannelBindingStatus:
      byOwner.externalChannelBinding?.compact.externalChannelStatus ??
      byOwner.trainingPlan?.compact.externalChannelBinding?.status ??
      byOwner.externalChannelBinding?.compact.status,
    skillOptLiteStatus: byOwner.skillOptLite?.compact.status,
    skillOptLiteNextIdleAction: byOwner.skillOptLite?.compact.nextIdleAction,
    selfRepairHandsAutoWriteTriggered: selfRepairAutoWriteRun !== undefined,
    selfRepairHandsAutoSignal: selfRepairAutoSignal,
    selfRepairHandsOwnerWritePolicy: SELF_REPAIR_HANDS_OWNER_WRITE_POLICY,
    selfRepairHandsStatus: byOwner.selfRepairHands?.compact.status,
    selfRepairHandsLatestWrittenStatus: recordValue(
      byOwner.selfRepairHands?.compact.latestWrittenReceipt,
    )?.status,
    selfRepairHandsLatestWrittenSignalKey: recordValue(
      byOwner.selfRepairHands?.compact.latestWrittenReceipt,
    )?.signalKey,
    selfRepairHandsNextSafeAction: byOwner.selfRepairHands?.compact.nextSafeAction,
    monotonicDataLedgerAppendDecision: byOwner.monotonicDataLedger?.compact.appendDecision,
    monotonicDataLedgerDatasetExamples: byOwner.monotonicDataLedger?.compact.datasetExamples,
    monotonicDataLedgerTrainSliceWritten: byOwner.monotonicDataLedger?.compact.trainSliceWritten,
    monotonicDataLedgerAcceptedSkillOptPackets:
      byOwner.monotonicDataLedger?.compact.acceptedSkillOptPackets,
    monotonicDataLedgerBlockedAdapterCandidates:
      byOwner.monotonicDataLedger?.compact.blockedAdapterCandidates,
    providerCouncilAccelerationStatus: byOwner.providerCouncilAcceleration?.compact.status,
    providerCouncilAccelerationAction: byOwner.providerCouncilAcceleration?.compact.action,
    evolutionCooldownActive: byOwner.trainingPlan?.compact.evolutionCooldownActive,
    latestEvolutionCooldown: byOwner.trainingPlan?.compact.latestEvolutionCooldown,
    latestGuardEvent: byOwner.trainingPlan?.compact.latestGuardEvent,
    fastestSafeNextAction: recordValue(byOwner.trainingPlan?.compact.evolutionAcceleration)
      ?.fastestSafeNextAction,
    activeNonIdleProgress: recordValue(byOwner.trainingPlan?.compact.evolutionAcceleration)
      ?.activeNonIdleProgress,
    multiAgentPatternShadowStatus: multiAgentPatternShadow.status,
    multiAgentPatternShadowDecision: multiAgentPatternShadow.trialDecision,
    multiAgentPatternShadowNormalPassRate: multiAgentPatternShadow.normalPassRate,
    multiAgentPatternShadowP95CriticalPathLatencyMs:
      multiAgentPatternShadow.p95CriticalPathLatencyMs,
    multiAgentPatternShadowUsageBasis: multiAgentPatternShadow.usageBasis,
    multiAgentPatternShadowReason: multiAgentPatternShadow.reason,
  },
  owners: {
    ...Object.fromEntries(owners.map((owner) => [owner.id, owner.compact])),
    multiAgentPatternShadow,
  },
  notTouched: [
    "external_channel_sender",
    "provider_config",
    "protected_memory",
    "formal_language_corpus",
    "training_processes",
  ],
  liveTouched: hasBoundaryTouch(owners, "liveTouched"),
  providerConfigTouched: hasBoundaryTouch(owners, "providerConfigTouched"),
  protectedMemoryTouched: hasBoundaryTouch(owners, "protectedMemoryTouched"),
};

const [gitStatusLines, activePids] = await Promise.all([
  gitStatusShortBranch(),
  activePidSummary(),
]);
const trainingCompact = recordValue(receipt.owners.trainingPlan);
const skillOptCompact = recordValue(receipt.owners.skillOptLite);
const selfRepairHandsCompact = recordValue(receipt.owners.selfRepairHands);
const selfRepairLatestWritten = recordValue(selfRepairHandsCompact?.latestWrittenReceipt);
const monotonicDataLedgerCompact = recordValue(receipt.owners.monotonicDataLedger);
const universeIndexCompact = recordValue(receipt.owners.universeIndex);
const externalAgentUpgradeCompact = recordValue(receipt.owners.externalAgentUpgrade);
const projectionReaderAuditCompact = recordValue(receipt.owners.projectionReaderAudit);
const externalChannelStatusCompact = recordValue(receipt.owners.externalChannelStatus);
const providerCouncilAccelerationCompact = recordValue(receipt.owners.providerCouncilAcceleration);
const externalChannelBindingCompact = recordValue(receipt.owners.externalChannelBinding);
const mindModelCompact = recordValue(receipt.owners.mindModel);
const flowGraphCompact = recordValue(receipt.owners.flowGraph);
const headTailCompact = recordValue(receipt.owners.headTail);
const contextRecoveryCompact = recordValue(receipt.owners.contextRecovery);
const activeCounts = activePidCounts(activePids);
const digestMaterial = {
  repoBranch: gitStatusLines[0] ?? "",
  repoDirtyCount: Math.max(0, gitStatusLines.length - 1),
  activeHeavy: activePids.eval.length > 0 || activePids.mlx.length > 0,
  activePidCounts: activeCounts,
  autopilotOk: receipt.ok,
  structuralOwnerFailures: receipt.summary.structuralOwnerFailures,
  blockedClusters: receipt.summary.blockedClusters,
  blockedGates: receipt.summary.blockedGates,
  projectionReaderCoverageStatus: receipt.summary.projectionReaderCoverageStatus,
  projectionReaderContractReadyForAllAdapters:
    receipt.summary.projectionReaderContractReadyForAllAdapters,
  projectionReaderMissingCount: receipt.summary.projectionReaderMissingCount,
  externalChannelBindingStatus: receipt.summary.externalChannelBindingStatus,
  externalChannelStatusModel: receipt.summary.externalChannelStatusModel,
  externalChannelBound: receipt.summary.externalChannelBound,
  userVisibleObserved: receipt.summary.userVisibleObserved,
  globalEvidenceProjectionReadStatus: globalEvidenceProjection.readStatus,
  globalEvidenceProjectionBlocked: globalEvidenceProjection.blocked,
  globalEvidenceProjectionGeneratedAt: globalEvidenceProjection.generatedAt,
  globalEvidenceProjectionReason: globalEvidenceProjection.reason,
  fastestSafeNextAction: receipt.summary.fastestSafeNextAction,
  evolutionCooldownActive: trainingCompact?.evolutionCooldownActive,
  latestEvolutionCooldown: trainingCompact?.latestEvolutionCooldown,
  latestGuardEvent: trainingCompact?.latestGuardEvent,
  selectedCleanAdapter: trainingCompact?.selectedCleanAdapter,
  decisionIds: trainingCompact?.decisionIds ?? [],
  latestCandidateEval: trainingCompact?.latestCandidateEval,
  guardUsesSelectedCleanAdapter: trainingCompact?.guardUsesSelectedCleanAdapter,
  skillOptLiteStatus: skillOptCompact?.status,
  skillOptLiteAccepted: skillOptCompact?.accepted,
  skillOptLiteMatchedSkillIds: skillOptCompact?.matchedSkillIds,
  skillOptLiteSkillFamilyCount: skillOptCompact?.skillFamilyCount,
  skillOptLiteStaticGateOk: skillOptCompact?.staticGateOk,
  skillOptLiteParseRecoveredCount: skillOptCompact?.parseRecoveredCount,
  skillOptLiteNextIdleAction: skillOptCompact?.nextIdleAction,
  selfRepairHandsAutoWriteTriggered: selfRepairAutoWriteRun !== undefined,
  selfRepairHandsAutoSignal: selfRepairAutoSignal,
  selfRepairHandsOwnerWritePolicy: SELF_REPAIR_HANDS_OWNER_WRITE_POLICY,
  selfRepairHandsStatus: selfRepairHandsCompact?.status,
  selfRepairHandsLatestWrittenStatus: selfRepairLatestWritten?.status,
  selfRepairHandsLatestWrittenSignalKey: selfRepairLatestWritten?.signalKey,
  selfRepairHandsNextSafeAction: selfRepairHandsCompact?.nextSafeAction,
  monotonicDataLedgerLatestPath: MONOTONIC_DATA_LEDGER_LATEST_PATH,
  monotonicDataLedgerJsonlPath: MONOTONIC_DATA_LEDGER_JSONL_PATH,
  monotonicDataLedgerAppendDecision: monotonicDataLedgerCompact?.appendDecision,
  monotonicDataLedgerGuaranteeLevel: monotonicDataLedgerCompact?.guaranteeLevel,
  monotonicDataLedgerDatasetExamples: monotonicDataLedgerCompact?.datasetExamples,
  monotonicDataLedgerDatasetTrain: monotonicDataLedgerCompact?.datasetTrain,
  monotonicDataLedgerTrainSliceWritten: monotonicDataLedgerCompact?.trainSliceWritten,
  monotonicDataLedgerAcceptedSkillOptPackets: monotonicDataLedgerCompact?.acceptedSkillOptPackets,
  monotonicDataLedgerPendingSkillOptEvalPackets:
    monotonicDataLedgerCompact?.pendingSkillOptEvalPackets,
  monotonicDataLedgerBlockedAdapterCandidates: monotonicDataLedgerCompact?.blockedAdapterCandidates,
  monotonicDataLedgerDeltaFromPrevious: monotonicDataLedgerCompact?.deltaFromPrevious,
  universeIndexDirtyFiles: universeIndexCompact?.dirtyFiles,
  universeIndexUnmatchedChangedFiles: universeIndexCompact?.unmatchedChangedFiles,
  universeIndexStaleRuntimeCandidates: universeIndexCompact?.staleRuntimeCandidates,
  universeIndexStaleSnapshots: universeIndexCompact?.staleSnapshots,
  externalUpgradeBlacktechMechanismCount: externalAgentUpgradeCompact?.blacktechMechanismCount,
  externalUpgradeBlacktechReadyLocalOnlyCount:
    externalAgentUpgradeCompact?.blacktechReadyLocalOnlyCount,
  externalUpgradeBlacktechPartialLocalOnlyCount:
    externalAgentUpgradeCompact?.blacktechPartialLocalOnlyCount,
  externalUpgradeBlacktechAutopilotRoutedCount:
    externalAgentUpgradeCompact?.blacktechAutopilotRoutedCount,
  externalUpgradeRuntimeAuthorityGrantedCount:
    externalAgentUpgradeCompact?.runtimeAuthorityGrantedCount,
  externalUpgradeBlacktechRuntimeAuthorityGrantedCount:
    externalAgentUpgradeCompact?.blacktechRuntimeAuthorityGrantedCount,
  externalUpgradePerfectIntegrationClaim: externalAgentUpgradeCompact?.perfectIntegrationClaim,
  providerCouncilAccelerationStatus: providerCouncilAccelerationCompact?.status,
  providerCouncilAccelerationAction: providerCouncilAccelerationCompact?.action,
  providerCouncilAccelerationHardBlocks: providerCouncilAccelerationCompact?.hardBlocks,
  providerCouncilAccelerationFreshCompleteCouncil:
    providerCouncilAccelerationCompact?.freshCompleteCouncil,
  providerCouncilAccelerationDailyUse: providerCouncilAccelerationCompact?.dailyUse,
  providerCouncilAccelerationNextSafeCommand: providerCouncilAccelerationCompact?.nextSafeCommand,
  externalChannelMissingProof: externalChannelBindingCompact?.missingProof ?? [],
  mindModelFailed: recordValue(mindModelCompact?.summary)?.failed,
  flowGraphFailed: recordValue(flowGraphCompact?.summary)?.failed,
  headTailFailed: recordValue(headTailCompact?.summary)?.failed,
  contextRecoveryOk: contextRecoveryCompact?.compressedContextRecovered,
  multiAgentPatternShadowStatus: multiAgentPatternShadow.status,
  multiAgentPatternShadowDecision: multiAgentPatternShadow.trialDecision,
  multiAgentPatternShadowNormalPassRate: multiAgentPatternShadow.normalPassRate,
  multiAgentPatternShadowP95CriticalPathLatencyMs: multiAgentPatternShadow.p95CriticalPathLatencyMs,
  multiAgentPatternShadowUsageBasis: multiAgentPatternShadow.usageBasis,
  multiAgentPatternShadowReason: multiAgentPatternShadow.reason,
  liveTouched: receipt.liveTouched,
  providerConfigTouched: receipt.providerConfigTouched,
  protectedMemoryTouched: receipt.protectedMemoryTouched,
};
const evolutionPromotionDigest = {
  kind: "lcx-evolution-promotion-digest",
  boundary: "local_evolution_promotion_digest_only",
  checkedAt: receipt.checkedAt,
  repo: {
    cwd: repoRoot,
    statusShortBranch: gitStatusLines[0] ?? "",
    dirtyCount: Math.max(0, gitStatusLines.length - 1),
  },
  activePidSummary: activePids,
  autopilot: {
    ok: receipt.ok,
    checkedAt: receipt.checkedAt,
    summary: receipt.summary,
    triggerPolicy: receipt.triggerPolicy,
  },
  externalChannelBinding: externalChannelBindingCompact,
  material: digestMaterial,
  quietReason:
    activePids.eval.length > 0 || activePids.mlx.length > 0
      ? "active_eval_or_mlx_generate_defer_mutating_work"
      : "autopilot_idle_owner_outputs_current",
  liveTouched: receipt.liveTouched,
  providerConfigTouched: receipt.providerConfigTouched,
  protectedMemoryTouched: receipt.protectedMemoryTouched,
};
const localFailureTrace = buildLocalFailureTraceReceipt({
  checkedAt: receipt.checkedAt,
  workspaceDir: DEFAULT_WORKSPACE_DIR,
  repo: {
    cwd: repoRoot,
    statusShortBranch: gitStatusLines[0] ?? "",
    dirtyCount: Math.max(0, gitStatusLines.length - 1),
  },
  activePidSummary: activePids,
  source: "governance_autopilot",
  sourceArtifacts: [
    GOVERNANCE_AUTOPILOT_LATEST_PATH,
    EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
    MONOTONIC_DATA_LEDGER_LATEST_PATH,
    MONOTONIC_DATA_LEDGER_JSONL_PATH,
    CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
    MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
  ],
  writtenArtifacts: [
    GOVERNANCE_AUTOPILOT_LATEST_PATH,
    EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
    MONOTONIC_DATA_LEDGER_LATEST_PATH,
    MONOTONIC_DATA_LEDGER_JSONL_PATH,
    CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
    LOCAL_FAILURE_TRACE_LATEST_PATH,
    LOCAL_FAILURE_TRACE_JSONL_PATH,
    OWNER_BRIEF_LATEST_JSON_PATH,
    OWNER_BRIEF_LATEST_MARKDOWN_PATH,
    OWNER_CONTROL_MAP_LATEST_JSON_PATH,
    OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH,
  ],
  ownerCommands: receipt.ownerCommands,
  summary: receipt.summary,
  boundaryFlags: {
    liveTouched: receipt.liveTouched,
    providerConfigTouched: receipt.providerConfigTouched,
    protectedMemoryTouched: receipt.protectedMemoryTouched,
  },
});
const ownerControlMap = buildOwnerControlMap({
  checkedAt: receipt.checkedAt,
  governance: receipt,
  localFailureTrace,
  paths: {
    latestMarkdownPath: OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH,
    latestJsonPath: OWNER_CONTROL_MAP_LATEST_JSON_PATH,
    sourcePaths: [
      GOVERNANCE_AUTOPILOT_LATEST_PATH,
      EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
      LOCAL_FAILURE_TRACE_LATEST_PATH,
      MONOTONIC_DATA_LEDGER_LATEST_PATH,
      CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
    ],
  },
});
const ownerBrief = buildOwnerBrief({
  checkedAt: receipt.checkedAt,
  governance: receipt,
  localFailureTrace,
  paths: {
    latestMarkdownPath: OWNER_BRIEF_LATEST_MARKDOWN_PATH,
    latestJsonPath: OWNER_BRIEF_LATEST_JSON_PATH,
    ownerControlMapMarkdownPath: OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH,
    sourcePaths: [
      GOVERNANCE_AUTOPILOT_LATEST_PATH,
      EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
      LOCAL_FAILURE_TRACE_LATEST_PATH,
      MONOTONIC_DATA_LEDGER_LATEST_PATH,
      CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
    ],
  },
});

await fs.mkdir(path.dirname(GOVERNANCE_AUTOPILOT_LATEST_PATH), { recursive: true });
await fs.writeFile(GOVERNANCE_AUTOPILOT_LATEST_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
await fs.mkdir(path.dirname(EVOLUTION_PROMOTION_DIGEST_LATEST_PATH), { recursive: true });
await fs.writeFile(
  EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
  `${JSON.stringify(evolutionPromotionDigest, null, 2)}\n`,
);
await fs.mkdir(path.dirname(CONTEXT_RECOVERY_HANDOFF_LATEST_PATH), { recursive: true });
await fs.writeFile(
  CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
  `${buildContextRecoveryHandoff({
    receipt,
    gitStatusLines,
    activePids,
    digestMaterial,
    universeIndexCompact,
    trainingCompact,
    skillOptCompact,
    monotonicDataLedgerCompact,
    providerCouncilAccelerationCompact,
    externalChannelBindingCompact,
    externalAgentUpgradeCompact,
    projectionReaderAuditCompact,
    localFailureTrace,
  })}\n`,
);
await writeLocalFailureTraceReceipt(localFailureTrace);
await writeOwnerControlMap(ownerControlMap);
await writeOwnerBrief(ownerBrief);

if (options.json) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log(
    [
      `LCX governance autopilot: ok=${receipt.ok}`,
      `releaseBlocked=${receipt.summary.releaseBlocked}`,
      `activeTrainingOrEval=${receipt.summary.activeTrainingOrEval}`,
      `latestStatePath=${receipt.latestStatePath}`,
    ].join("\n"),
  );
}

if (!receipt.ok) {
  process.exitCode = 1;
}
