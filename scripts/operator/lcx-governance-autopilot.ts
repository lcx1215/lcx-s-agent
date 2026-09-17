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
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunId,
  createLcxRunSnapshot,
  type LcxRunPhase,
  type LcxRunReceipt,
  type LcxRunSnapshot,
} from "../../src/shared/lcx-run-receipt.ts";
import {
  buildLocalFailureTraceReceipt,
  summarizeTraceForHandoff,
  type LocalFailureTraceReceipt,
  writeLocalFailureTraceReceipt,
} from "./lcx-local-failure-trace.ts";
import {
  CENTRAL_AGENT_LATEST_PATH,
  CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
  CONTROL_ROOM_LATEST_PATH,
  DEFAULT_WORKSPACE_DIR,
  EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
  GOVERNANCE_AUTOPILOT_LATEST_PATH,
  LOCAL_FAILURE_TRACE_JSONL_PATH,
  LOCAL_FAILURE_TRACE_LATEST_PATH,
  MONOTONIC_DATA_LEDGER_JSONL_PATH,
  MONOTONIC_DATA_LEDGER_LATEST_PATH,
  OWNER_BRIEF_LATEST_JSON_PATH,
  OWNER_BRIEF_LATEST_MARKDOWN_PATH,
  OWNER_CONTROL_MAP_LATEST_JSON_PATH,
  OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH,
  REAL_COST_LEDGER_LATEST_JSON_PATH,
  MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
  SELF_REPAIR_HANDS_JSONL_PATH,
  SELF_REPAIR_HANDS_LATEST_PATH,
  SELF_REPAIR_HANDS_MARKDOWN_PATH,
  UNIVERSE_INDEX_LATEST_PATH,
} from "./lcx-local-paths.ts";
import {
  readLatestShadowSnapshot,
  type ShadowLatestSnapshot,
} from "./lcx-multi-agent-pattern-shadow.ts";
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
  | "contextRecovery"
  | "centralAgent";

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
  runReceipt: LcxRunReceipt;
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
  {
    // The LLM decision layer, driven from the rule-driven loop instead of being
    // an orphaned script nobody schedules. It runs in full dispatch mode: it
    // perceives, the brain proposes, the TS gate approves or blocks, and the
    // approved read-only owners are actually spawned (bounded by maxSteps and
    // one cycle per pass). The registry's declared arg vector is the whole CLI
    // surface, so a proposal can choose WHICH owner runs but can never add an
    // authority flag. It never reaches provider config, external senders,
    // protected memory, or trading. `--plan-only` remains available for a
    // deliberate one-decision-wide pass; it is no longer the scheduled default.
    id: "centralAgent",
    script: "scripts/operator/lcx-central-agent.ts",
    args: ["--max-cycles", "1", "--json"],
    required: true,
  },
];

type ActivePidSummary = {
  available: boolean;
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
    const governanceCoverage = recordValue(ownerCoverage?.governanceCoverage);
    const governanceSummary = recordValue(governanceCoverage?.summary);
    const routeOwnerValidation = recordValue(governanceCoverage?.routeOwnerValidation);
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
      governanceScope: governanceCoverage?.scope,
      governanceStatus: governanceCoverage?.status,
      governanceTotalComponents: governanceSummary?.totalComponents,
      governanceGovernedComponents: governanceSummary?.governedComponents,
      governanceInventoryOnlyComponents: governanceSummary?.inventoryOnlyComponents,
      governanceReviewRequiredComponents: governanceSummary?.reviewRequiredComponents,
      governanceCoverageRate: governanceSummary?.coverageRate,
      governanceUnknownComponents: governanceCoverage?.unknownComponents,
      governanceMissingRouteOwners: routeOwnerValidation?.missing,
      governanceInventoryAreaCount: governanceSummary?.inventoryAreaCount,
      governanceInventoryAreaComponentCount: governanceSummary?.inventoryAreaComponentCount,
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
    const liveExternalBrainBinding = recordValue(payload.liveExternalBrainBinding);
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
        liveExternalBrainBinding?.selectedCleanAdapter,
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
      liveExternalBrainBinding: liveExternalBrainBinding
        ? {
            status: liveExternalBrainBinding.status,
            action: liveExternalBrainBinding.action,
            missingProof: liveExternalBrainBinding.missingProof,
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

  if (id === "centralAgent") {
    const coverage = recordValue(payload.coverage);
    return {
      summary: payload.summary,
      runs: payload.runs,
      planOnly: payload.planOnly,
      dispatchMode: payload.dispatchMode,
      brainOutcome: payload.brainOutcome,
      brainAvailable: payload.brainAvailable,
      registryTools: payload.registryTools,
      coverageGovernanceOwners: coverage?.governanceOwners,
      coverageCapabilities: coverage?.capabilities,
      coverageExcludedWriteOwners: coverage?.excludedWriteOwners,
      actionsProposed: payload.actionsProposed,
      actionsApproved: payload.actionsApproved,
      actionsBlockedByGate: payload.actionsBlockedByGate,
      approvedOwners: payload.approvedOwners,
      // A red light the owner reported itself is not the same signal as "the
      // harness could not run it"; both are projected so the control room and
      // the next central cycle can tell them apart.
      ownersReportingNotOk: payload.ownersReportingNotOk,
      failedSteps: payload.failedSteps,
      nextAction: payload.nextAction,
      // The owner's stdout carries the rationale directly; the on-disk snapshot
      // holds the full receipt, but the compact must only use the payload.
      brainNote: payload.brainNote,
      // Context budget + evidence health: a bounded injection and a degraded
      // evidence write are both facts a reader has to be able to see, so they are
      // projected here rather than left inside the receipt on disk.
      contextBudget: payload.contextBudget,
      evidenceComplete: payload.evidenceComplete,
      evidenceWriteFailures: payload.evidenceWriteFailures,
      latestPath: payload.latestPath,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }

  return {
    summary: payload.summary,
    actionableFailures: payload.actionableFailures,
    actionableWarnings: payload.actionableWarnings,
    compressedContextRecovered: payload.compressedContextRecovered,
  };
}

function buildOwnerRunReceipt(params: {
  command: OwnerCommand;
  parsed: boolean;
  exitCode: number;
  ok?: boolean;
  payload?: Record<string, unknown>;
  parentRunId?: string;
  snapshot: LcxRunSnapshot;
  phase: LcxRunPhase;
  error?: string;
}): LcxRunReceipt {
  const checkedAt = params.snapshot.observedAt;
  return buildLcxRunReceipt({
    runId: createLcxRunId({
      checkedAt,
      owner: params.command.id,
      key: `${params.command.script}|${params.exitCode}|${params.error ?? ""}`,
    }),
    parentRunId: params.parentRunId,
    owner: params.command.id,
    phase: params.phase,
    status: ownerRunStatus(params),
    checkedAt,
    snapshot: params.snapshot,
    boundary: ownerBoundary(params.payload),
    evidence: ownerEvidence({
      id: params.command.id,
      command: params.command.script,
      parsed: params.parsed,
      exitCode: params.exitCode,
      ok: params.ok,
    }),
    nextAction: ownerNextAction(params.payload, params.command.id),
  });
}

async function runOwner(
  command: OwnerCommand,
  params: { parentRunId?: string; phase?: LcxRunPhase; snapshot: LcxRunSnapshot },
): Promise<OwnerRun> {
  const args = ["--import", "tsx", command.script, ...(command.args ?? [])];
  const renderedCommand = `node ${args.join(" ")}`;
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    const ok = typeof payload.ok === "boolean" ? payload.ok : undefined;
    return {
      id: command.id,
      command: renderedCommand,
      exitCode: 0,
      parsed: true,
      ok,
      boundary: typeof payload.boundary === "string" ? payload.boundary : undefined,
      summary: payload.summary,
      compact: compactOwner(command.id, payload),
      projection: payload.globalEvidenceProjection,
      runReceipt: buildOwnerRunReceipt({
        command,
        parsed: true,
        exitCode: 0,
        ok,
        payload,
        parentRunId: params.parentRunId,
        snapshot: params.snapshot,
        phase: params.phase ?? "observe",
      }),
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
      const ok = typeof payload.ok === "boolean" ? payload.ok : undefined;
      return {
        id: command.id,
        command: renderedCommand,
        exitCode: typeof details.code === "number" ? details.code : 1,
        parsed: true,
        ok,
        boundary: typeof payload.boundary === "string" ? payload.boundary : undefined,
        summary: payload.summary,
        compact: compactOwner(command.id, payload),
        projection: payload.globalEvidenceProjection,
        runReceipt: buildOwnerRunReceipt({
          command,
          parsed: true,
          exitCode: typeof details.code === "number" ? details.code : 1,
          ok,
          payload,
          parentRunId: params.parentRunId,
          snapshot: params.snapshot,
          phase: params.phase ?? "observe",
          error: details.stderr?.trim() || details.message,
        }),
        error: details.stderr?.trim() || details.message,
      };
    } catch {
      const exitCode = typeof details.code === "number" ? details.code : 1;
      return {
        id: command.id,
        command: renderedCommand,
        exitCode,
        parsed: false,
        ok: false,
        boundary: undefined,
        summary: undefined,
        compact: {},
        runReceipt: buildOwnerRunReceipt({
          command,
          parsed: false,
          exitCode,
          parentRunId: params.parentRunId,
          snapshot: params.snapshot,
          phase: params.phase ?? "observe",
          error: [details.message, details.stderr].filter(Boolean).join("\n"),
        }),
        error: [details.message, details.stderr].filter(Boolean).join("\n"),
      };
    }
  }
}

async function runSelfRepairAutoWrite(
  signal: SelfRepairAutoSignal,
  parentRunId: string,
  snapshot: LcxRunSnapshot,
): Promise<OwnerRun> {
  return runOwner(
    {
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
    },
    { parentRunId, phase: "repair", snapshot },
  );
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

function ownerRunStatus(params: { parsed: boolean; exitCode: number; ok?: boolean }) {
  if (!params.parsed) {
    return "failed" as const;
  }
  if (params.ok === false) {
    return "blocked" as const;
  }
  return params.exitCode !== 0 ? ("failed" as const) : ("passed" as const);
}

function ownerNextAction(payload: Record<string, unknown> | undefined, id: string): string {
  for (const key of ["nextAction", "nextSafeAction", "fastestSafeNextAction", "nextIdleAction"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return payload ? `review_${id}_owner_output` : `repair_${id}_owner_execution`;
}

function ownerBoundary(payload: Record<string, unknown> | undefined) {
  return boundaryFromFlags({
    scope: typeof payload?.boundary === "string" ? payload.boundary : "local_owner_only",
    externalSenderTouched:
      payload?.externalSenderTouched === true ||
      payload?.externalChannelTouched === true ||
      payload?.liveTouched === true,
    trainingTouched: payload?.trainingTouched === true,
    providerConfigTouched: payload?.providerConfigTouched === true,
    protectedMemoryTouched: payload?.protectedMemoryTouched === true,
  });
}

function ownerEvidence(params: {
  id: string;
  command: string;
  parsed: boolean;
  exitCode: number;
  ok?: boolean;
}) {
  return [
    {
      id: `owner:${params.id}`,
      kind: "proof" as const,
      status: params.parsed ? ("present" as const) : ("missing" as const),
      owner: "lcx-governance-autopilot",
      locator: params.command,
      detail: params.parsed
        ? `exitCode=${params.exitCode}; ok=${String(params.ok ?? "unknown")}`
        : "owner output was not parsed",
    },
  ];
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

async function gitSourceIdentity(): Promise<{ sourceCommit: string; sourceBranch: string }> {
  try {
    const [{ stdout: sourceCommit }, { stdout: sourceBranch }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        maxBuffer: EXEC_MAX_BUFFER,
      }),
      execFileAsync("git", ["branch", "--show-current"], {
        cwd: repoRoot,
        maxBuffer: EXEC_MAX_BUFFER,
      }),
    ]);
    return {
      sourceCommit: sourceCommit.trim() || "unknown",
      sourceBranch: sourceBranch.trim() || "detached",
    };
  } catch {
    return { sourceCommit: "unknown", sourceBranch: "unknown" };
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function activePidSummary(): Promise<ActivePidSummary> {
  let stdout = "";
  try {
    stdout =
      process.platform === "win32"
        ? (
            await execFileAsync(
              "powershell.exe",
              [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.CommandLine }',
              ],
              { maxBuffer: EXEC_MAX_BUFFER },
            )
          ).stdout
        : (
            await execFileAsync("ps", ["-axo", "pid,etime,command"], {
              maxBuffer: EXEC_MAX_BUFFER,
            })
          ).stdout;
  } catch {
    return { available: false, guard: [], eval: [], mlx: [], teacher: [], quota: [] };
  }
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
    available: true,
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
  return {
    guard: summary.guard.length,
    eval: summary.eval.length,
    mlx: summary.mlx.length,
    teacher: summary.teacher.length,
    quota: summary.quota.length,
  };
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
  const entries = [
    ["guard", activePids.guard],
    ["eval", activePids.eval],
    ["mlx", activePids.mlx],
    ["teacher", activePids.teacher],
    ["quota", activePids.quota],
  ] as const;
  return [
    `- processSnapshotAvailable: ${activePids.available}`,
    ...entries.map(([kind, lines]) => {
      const first = lines[0] ? `; first=${truncateLine(lines[0], 160)}` : "";
      return `- ${kind}: ${lines.length}${first}`;
    }),
  ];
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
  multiAgentPatternShadow,
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
  multiAgentPatternShadow: ShadowLatestSnapshot;
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
    `- governanceScope: ${inlineValue(universeIndexCompact?.governanceScope)}`,
    `- governanceStatus: ${inlineValue(universeIndexCompact?.governanceStatus)}`,
    `- governanceTotalComponents: ${inlineValue(universeIndexCompact?.governanceTotalComponents)}`,
    `- governanceGovernedComponents: ${inlineValue(universeIndexCompact?.governanceGovernedComponents)}`,
    `- governanceInventoryOnlyComponents: ${inlineValue(universeIndexCompact?.governanceInventoryOnlyComponents)}`,
    `- governanceReviewRequiredComponents: ${inlineValue(universeIndexCompact?.governanceReviewRequiredComponents)}`,
    `- governanceCoverageRate: ${inlineValue(universeIndexCompact?.governanceCoverageRate)}`,
    `- governanceUnknownComponents: ${inlineValue(universeIndexCompact?.governanceUnknownComponents)}`,
    `- governanceMissingRouteOwners: ${inlineValue(universeIndexCompact?.governanceMissingRouteOwners)}`,
    `- governanceInventoryAreaCount: ${inlineValue(universeIndexCompact?.governanceInventoryAreaCount)}`,
    `- governanceInventoryAreaComponentCount: ${inlineValue(universeIndexCompact?.governanceInventoryAreaComponentCount)}`,
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
    "## Multi-Agent Pattern Shadow",
    `- status: ${inlineValue(multiAgentPatternShadow.status)}`,
    `- latestStatePath: ${inlineValue(multiAgentPatternShadow.latestStatePath)}`,
    `- experimentId: ${inlineValue(multiAgentPatternShadow.experimentId)}`,
    `- completedAt: ${inlineValue(multiAgentPatternShadow.completedAt)}`,
    `- trialDecision: ${inlineValue(multiAgentPatternShadow.trialDecision)}`,
    `- reason: ${inlineValue(multiAgentPatternShadow.reason)}`,
    "- boundary: governance reads the latest shadow summary only; it never triggers isolated executor or live shadow",
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
const governanceStartedAt = new Date().toISOString();
const sourceIdentity = await gitSourceIdentity();
const governanceSnapshot = createLcxRunSnapshot({
  observedAt: governanceStartedAt,
  sourceCommit: sourceIdentity.sourceCommit,
  sourceBranch: sourceIdentity.sourceBranch,
  authorityOwner: "lcx-governance-autopilot",
});
const governanceRunId = createLcxRunId({
  checkedAt: governanceStartedAt,
  owner: "lcx-governance-autopilot",
});
let owners = await Promise.all(
  OWNER_COMMANDS.map((command) =>
    runOwner(command, { parentRunId: governanceRunId, snapshot: governanceSnapshot }),
  ),
);
let byOwner = ownerMap(owners);
const multiAgentPatternShadow = await readLatestShadowSnapshot();
const selfRepairAutoSignal = buildSelfRepairAutoSignal(byOwner);
const selfRepairAutoWriteNeeded =
  selfRepairAutoSignal !== undefined &&
  selfRepairLatestSignalKey(byOwner.selfRepairHands?.compact) !== selfRepairAutoSignal.signalKey;
let selfRepairAutoWriteRun: OwnerRun | undefined;
if (selfRepairAutoWriteNeeded && selfRepairAutoSignal) {
  selfRepairAutoWriteRun = await runSelfRepairAutoWrite(
    selfRepairAutoSignal,
    governanceRunId,
    governanceSnapshot,
  );
  owners = owners.map((owner) =>
    owner.id === "selfRepairHands" ? selfRepairAutoWriteRun! : owner,
  );
  byOwner = ownerMap(owners);
}
const requiredParseFailures = owners.filter(
  (owner) => OWNER_COMMANDS.find((command) => command.id === owner.id)?.required && !owner.parsed,
);
const activeTrainingOrEval = trainingActive(byOwner.trainingPlan, byOwner.externalChannelBinding);
const structuralOwnerFailures = owners.filter(
  (owner) => owner.runReceipt.status === "failed" || owner.runReceipt.status === "blocked",
);
const structuralOwnerExecutionFailures = owners.some(
  (owner) => owner.runReceipt.status === "failed",
);
const universeIndexGovernanceIncomplete =
  byOwner.universeIndex?.compact.governanceStatus !== "complete";
const releaseBlocked =
  byOwner.commercialAcceptance?.compact.readyForCommercialRelease === false ||
  stringArray(byOwner.problemRadar?.compact.actionableClusters).length > 0 ||
  stringArray(byOwner.problemRadar?.compact.blockedClusters).length > 0 ||
  universeIndexGovernanceIncomplete ||
  structuralOwnerFailures.length > 0;
const governanceCheckedAt = governanceSnapshot.observedAt;
const globalEvidenceProjectionReader = readGlobalEvidenceProjectionForAdapter(
  byOwner.mindModel?.projection,
  governanceCheckedAt,
  { adapterId: "governance-autopilot", sourceOwner: "mindModel" },
);
const globalEvidenceProjection: GlobalEvidenceProjectionRead = globalEvidenceProjectionReader.read;
const governanceRunStatus =
  requiredParseFailures.length > 0 || structuralOwnerExecutionFailures
    ? ("failed" as const)
    : releaseBlocked
      ? ("blocked" as const)
      : ("passed" as const);
const governanceNextAction =
  (activeTrainingOrEval
    ? "wait_for_active_training_or_eval_before_mutating_work"
    : stringArray(byOwner.problemRadar?.compact.nextActions)[0]) ??
  stringArray(byOwner.trainingPlan?.compact.nextActions)[0] ??
  "review_owner_evidence_and_select_one_safe_lane";
const governanceRunReceipt = buildLcxRunReceipt({
  runId: governanceRunId,
  owner: "lcx-governance-autopilot",
  phase: "observe",
  status: governanceRunStatus,
  checkedAt: governanceCheckedAt,
  snapshot: governanceSnapshot,
  boundary: boundaryFromFlags({
    scope: "local_governance_autopilot_only",
    externalSenderTouched: hasBoundaryTouch(owners, "liveTouched"),
    trainingTouched: hasBoundaryTouch(owners, "trainingTouched"),
    providerConfigTouched: hasBoundaryTouch(owners, "providerConfigTouched"),
    protectedMemoryTouched: hasBoundaryTouch(owners, "protectedMemoryTouched"),
  }),
  evidence: owners.map((owner) => ({
    id: `owner:${owner.id}`,
    kind: "proof" as const,
    status: owner.parsed ? "present" : "missing",
    owner: "lcx-governance-autopilot",
    locator: owner.command,
    detail: `childRunId=${owner.runReceipt.runId}; status=${owner.runReceipt.status}`,
  })),
  nextAction: governanceNextAction,
});

const receipt = {
  ok: requiredParseFailures.length === 0,
  boundary: "local_governance_autopilot_only",
  checkedAt: governanceCheckedAt,
  snapshot: governanceSnapshot,
  runId: governanceRunId,
  runReceipt: governanceRunReceipt,
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
  controlRoomLatestPath: CONTROL_ROOM_LATEST_PATH,
  centralAgentLatestPath: CENTRAL_AGENT_LATEST_PATH,
  handoffLatestPath: CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
  multiAgentPatternShadowLatestPath: MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
  multiAgentPatternShadow,
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
    runReceipt: owner.runReceipt,
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
      "central_agent_latest_via_owner",
      "central_agent_log_jsonl_via_owner",
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
    universeIndexGovernanceScope: byOwner.universeIndex?.compact.governanceScope,
    universeIndexGovernanceStatus: byOwner.universeIndex?.compact.governanceStatus,
    universeIndexGovernanceTotalComponents:
      byOwner.universeIndex?.compact.governanceTotalComponents,
    universeIndexGovernanceGovernedComponents:
      byOwner.universeIndex?.compact.governanceGovernedComponents,
    universeIndexGovernanceInventoryOnlyComponents:
      byOwner.universeIndex?.compact.governanceInventoryOnlyComponents,
    universeIndexGovernanceReviewRequiredComponents:
      byOwner.universeIndex?.compact.governanceReviewRequiredComponents,
    universeIndexGovernanceCoverageRate: byOwner.universeIndex?.compact.governanceCoverageRate,
    universeIndexGovernanceUnknownComponents:
      byOwner.universeIndex?.compact.governanceUnknownComponents,
    universeIndexGovernanceMissingRouteOwners:
      byOwner.universeIndex?.compact.governanceMissingRouteOwners,
    universeIndexGovernanceInventoryAreaCount:
      byOwner.universeIndex?.compact.governanceInventoryAreaCount,
    universeIndexGovernanceInventoryAreaComponentCount:
      byOwner.universeIndex?.compact.governanceInventoryAreaComponentCount,
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
    multiAgentPatternShadowStatus: multiAgentPatternShadow.status,
    multiAgentPatternShadowTrialDecision: multiAgentPatternShadow.trialDecision,
    multiAgentPatternShadowCompletedAt: multiAgentPatternShadow.completedAt,
    multiAgentPatternShadowReason: multiAgentPatternShadow.reason,
    fastestSafeNextAction: recordValue(byOwner.trainingPlan?.compact.evolutionAcceleration)
      ?.fastestSafeNextAction,
    activeNonIdleProgress: recordValue(byOwner.trainingPlan?.compact.evolutionAcceleration)
      ?.activeNonIdleProgress,
    // Central agent harness: the LLM decision layer's own gated plan for this pass.
    // Surfaced in the governance summary so the dashboard shows what the agent
    // decided, which owners it selected, and whether its brain was reachable.
    centralAgentRuns: byOwner.centralAgent?.compact.runs,
    centralAgentDispatchMode: byOwner.centralAgent?.compact.dispatchMode,
    centralAgentBrainOutcome: byOwner.centralAgent?.compact.brainOutcome,
    centralAgentBrainAvailable: byOwner.centralAgent?.compact.brainAvailable,
    centralAgentRegistryTools: byOwner.centralAgent?.compact.registryTools,
    centralAgentGovernanceOwners: byOwner.centralAgent?.compact.coverageGovernanceOwners,
    centralAgentCapabilities: byOwner.centralAgent?.compact.coverageCapabilities,
    centralAgentExcludedWriteOwners: byOwner.centralAgent?.compact.coverageExcludedWriteOwners,
    centralAgentActionsProposed: byOwner.centralAgent?.compact.actionsProposed,
    centralAgentActionsApproved: byOwner.centralAgent?.compact.actionsApproved,
    centralAgentActionsBlockedByGate: byOwner.centralAgent?.compact.actionsBlockedByGate,
    centralAgentApprovedOwners: byOwner.centralAgent?.compact.approvedOwners,
    centralAgentOwnersReportingNotOk: byOwner.centralAgent?.compact.ownersReportingNotOk,
    centralAgentFailedSteps: byOwner.centralAgent?.compact.failedSteps,
    centralAgentNextAction: byOwner.centralAgent?.compact.nextAction,
    centralAgentBrainNote: byOwner.centralAgent?.compact.brainNote,
    centralAgentContextBudget: byOwner.centralAgent?.compact.contextBudget,
    centralAgentEvidenceComplete: byOwner.centralAgent?.compact.evidenceComplete,
    centralAgentEvidenceWriteFailures: byOwner.centralAgent?.compact.evidenceWriteFailures,
  },
  owners: Object.fromEntries(owners.map((owner) => [owner.id, owner.compact])),
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
const centralAgentCompact = recordValue(receipt.owners.centralAgent);
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
  multiAgentPatternShadowStatus: multiAgentPatternShadow.status,
  multiAgentPatternShadowTrialDecision: multiAgentPatternShadow.trialDecision,
  multiAgentPatternShadowCompletedAt: multiAgentPatternShadow.completedAt,
  multiAgentPatternShadowReason: multiAgentPatternShadow.reason,
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
  universeIndexGovernanceScope: universeIndexCompact?.governanceScope,
  universeIndexGovernanceStatus: universeIndexCompact?.governanceStatus,
  universeIndexGovernanceTotalComponents: universeIndexCompact?.governanceTotalComponents,
  universeIndexGovernanceGovernedComponents: universeIndexCompact?.governanceGovernedComponents,
  universeIndexGovernanceInventoryOnlyComponents:
    universeIndexCompact?.governanceInventoryOnlyComponents,
  universeIndexGovernanceReviewRequiredComponents:
    universeIndexCompact?.governanceReviewRequiredComponents,
  universeIndexGovernanceCoverageRate: universeIndexCompact?.governanceCoverageRate,
  universeIndexGovernanceUnknownComponents: universeIndexCompact?.governanceUnknownComponents,
  universeIndexGovernanceMissingRouteOwners: universeIndexCompact?.governanceMissingRouteOwners,
  universeIndexGovernanceInventoryAreaCount: universeIndexCompact?.governanceInventoryAreaCount,
  universeIndexGovernanceInventoryAreaComponentCount:
    universeIndexCompact?.governanceInventoryAreaComponentCount,
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
  // Central agent harness: the LLM decision layer's own gated plan for this pass.
  centralAgentRuns: centralAgentCompact?.runs,
  centralAgentDispatchMode: centralAgentCompact?.dispatchMode,
  centralAgentBrainOutcome: centralAgentCompact?.brainOutcome,
  centralAgentBrainAvailable: centralAgentCompact?.brainAvailable,
  centralAgentRegistryTools: centralAgentCompact?.registryTools,
  centralAgentGovernanceOwners: centralAgentCompact?.coverageGovernanceOwners,
  centralAgentCapabilities: centralAgentCompact?.coverageCapabilities,
  centralAgentExcludedWriteOwners: centralAgentCompact?.coverageExcludedWriteOwners,
  centralAgentActionsProposed: centralAgentCompact?.actionsProposed,
  centralAgentActionsApproved: centralAgentCompact?.actionsApproved,
  centralAgentActionsBlockedByGate: centralAgentCompact?.actionsBlockedByGate,
  centralAgentApprovedOwners: centralAgentCompact?.approvedOwners,
  centralAgentOwnersReportingNotOk: centralAgentCompact?.ownersReportingNotOk,
  centralAgentFailedSteps: centralAgentCompact?.failedSteps,
  centralAgentNextAction: centralAgentCompact?.nextAction,
  centralAgentBrainNote: centralAgentCompact?.brainNote,
  centralAgentContextBudget: centralAgentCompact?.contextBudget,
  centralAgentEvidenceComplete: centralAgentCompact?.evidenceComplete,
  centralAgentEvidenceWriteFailures: centralAgentCompact?.evidenceWriteFailures,
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
  snapshot: governanceSnapshot,
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
    CENTRAL_AGENT_LATEST_PATH,
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
    CONTROL_ROOM_LATEST_PATH,
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
  snapshot: governanceSnapshot,
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
      MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
    ],
  },
});
const ownerBrief = buildOwnerBrief({
  checkedAt: receipt.checkedAt,
  snapshot: governanceSnapshot,
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
      MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH,
    ],
  },
});
const realCostLedger = await readJsonRecord(REAL_COST_LEDGER_LATEST_JSON_PATH);
const monotonicDataLedger = await readJsonRecord(MONOTONIC_DATA_LEDGER_LATEST_PATH);
const controlRoom = {
  schemaVersion: "lcx_control_room_v1",
  kind: "lcx-control-room",
  boundary: "local_control_room_projection_only",
  generatedAt: governanceSnapshot.observedAt,
  snapshot: governanceSnapshot,
  sourceAuthority: {
    owner: "lcx-governance-autopilot",
    sourcePath: GOVERNANCE_AUTOPILOT_LATEST_PATH,
    rule: "governance snapshot is the only current-cycle fact; all other surfaces are projections",
  },
  governance: receipt,
  evolutionPromotionDigest,
  localFailureTrace,
  monotonicDataLedger,
  ownerBrief,
  ownerControlMap,
  realCostLedger,
  views: {
    ownerBrief: {
      role: "text_projection",
      path: OWNER_BRIEF_LATEST_JSON_PATH,
    },
    ownerControlMap: {
      role: "control_projection",
      path: OWNER_CONTROL_MAP_LATEST_JSON_PATH,
    },
    webDashboard: {
      role: "canonical_lcx_control_room_view",
      endpoint: "/api/farm-snapshot",
      source: CONTROL_ROOM_LATEST_PATH,
    },
  },
  externalSchedulerBoundary: {
    codexDesktopHourlyAutomation: "external_trigger_only",
    greenFixMarkers: "not_lcx_agent_evidence",
    schedulerSuccessDoesNotProve: [
      "agent_receipt",
      "dashboard_currentness",
      "model_learning",
      "commit_or_pull_request",
      "user_visible_delivery",
    ],
  },
};

await fs.mkdir(path.dirname(GOVERNANCE_AUTOPILOT_LATEST_PATH), { recursive: true });
await fs.writeFile(GOVERNANCE_AUTOPILOT_LATEST_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
await fs.mkdir(path.dirname(EVOLUTION_PROMOTION_DIGEST_LATEST_PATH), { recursive: true });
await fs.writeFile(
  EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
  `${JSON.stringify(evolutionPromotionDigest, null, 2)}\n`,
);
const controlRoomTempPath = `${CONTROL_ROOM_LATEST_PATH}.${process.pid}.tmp`;
await fs.writeFile(controlRoomTempPath, `${JSON.stringify(controlRoom, null, 2)}\n`);
await fs.rename(controlRoomTempPath, CONTROL_ROOM_LATEST_PATH);
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
    multiAgentPatternShadow,
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
