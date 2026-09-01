import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildDirectedDailyResearchBrief } from "./lcx-directed-daily-research-brief.ts";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

type Severity = "P1" | "P2" | "P3" | "info";
type GateStatus = "passed" | "failed" | "blocked" | "watch";

type OwnerSnapshot = {
  ok: boolean;
  owner: string;
  command: string;
  payload?: Record<string, unknown>;
  error?: string;
};

type AcceptanceGate = {
  id: string;
  status: GateStatus;
  severity: Severity;
  owner: string;
  evidence: Record<string, unknown>;
  nextAction: string;
};

type HarnessInputs = {
  commercialAnswerPipeline?: OwnerSnapshot;
  shortIntentFuzzer?: OwnerSnapshot;
  visibleAnswerQualityFuzzer?: OwnerSnapshot;
  directedDailyResearchBrief?: OwnerSnapshot;
  problemRadar?: OwnerSnapshot;
  flowGraph?: OwnerSnapshot;
  mindModel?: OwnerSnapshot;
  externalChannelStatus?: OwnerSnapshot;
  externalChannelBindingStatus?: OwnerSnapshot;
  trainingPlan?: OwnerSnapshot;
  systemDoctor?: OwnerSnapshot;
  providerCouncilAcceleration?: OwnerSnapshot;
  moduleLearningAbsorptionGate?: OwnerSnapshot;
  financeDataGatewaySmoke?: OwnerSnapshot;
  financeDataGatewayConflictSmoke?: OwnerSnapshot;
};

type CliOptions = {
  json: boolean;
  withChannelProbe: boolean;
  skipDoctor: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-commercial-acceptance-harness.ts [--json] [--with-channel-probe] [--skip-doctor]",
      "",
      "Runs the local-only commercial acceptance harness.",
      "It consumes existing owner outputs and never sends External messages, starts training, edits provider config, or touches protected memory.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false, withChannelProbe: false, skipDoctor: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--with-channel-probe" || arg === "--with-live-probe") {
      options.withChannelProbe = true;
    } else if (arg === "--skip-doctor") {
      options.skipDoctor = true;
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

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function statusRank(status: GateStatus): number {
  if (status === "failed") {
    return 3;
  }
  if (status === "blocked") {
    return 2;
  }
  if (status === "watch") {
    return 1;
  }
  return 0;
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

function highestSeverity(gates: readonly AcceptanceGate[]): Severity {
  return gates.reduce<Severity>(
    (highest, gate) =>
      severityRank(gate.severity) > severityRank(highest) ? gate.severity : highest,
    "info",
  );
}

function severityValue(value: unknown, fallback: Severity): Severity {
  return value === "P1" || value === "P2" || value === "P3" || value === "info" ? value : fallback;
}

function ownerUnavailableGate(owner: string, snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  return {
    id: `${owner}_owner_unavailable`,
    status: "failed",
    severity: "P1",
    owner,
    evidence: {
      command: snapshot?.command ?? "not_collected",
      error: snapshot?.error ?? "missing_owner_snapshot",
    },
    nextAction: "Repair the owner command before trusting commercial acceptance.",
  };
}

function ownerOk(snapshot: OwnerSnapshot | undefined): boolean {
  return Boolean(snapshot?.ok && snapshot.payload && booleanValue(snapshot.payload.ok) !== false);
}

function commercialAnswerGate(snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  if (!ownerOk(snapshot)) {
    return ownerUnavailableGate("lcx-commercial-answer-pipeline", snapshot);
  }
  const summary = recordValue(snapshot!.payload!.summary);
  const failed = numberValue(summary?.failed) ?? 0;
  const total = numberValue(summary?.total) ?? 0;
  const filters = stringArray(snapshot!.payload!.contractFilters);
  const productGovernor = recordValue(snapshot!.payload!.productGovernor);
  const productGovernorCoverage = recordValue(productGovernor?.coverage);
  const productGovernorOk = booleanValue(productGovernor?.ok) === true;
  const unownedFilters = stringArray(productGovernorCoverage?.unownedFilters);
  const requiredFilters = [
    "real_external_short_canary_suite_required",
    "short_intent_family_fuzzer_required",
    "unknown_short_intent_clean_failure_required",
    "provider_council_evidence_required",
    "provider_outputs_not_faked",
    "async_task_receipt_required_for_deferred_work",
    "stored_only_is_not_learning",
    "retrieval_apply_eval_review_required",
    "finance_data_gateway_snapshot_required_for_numbers",
    "finance_data_conflicts_route_to_provenance_review",
    "positive_visible_answer_acceptance_required",
    "direct_answer_not_overconservative_required",
    "visible_answer_quality_fuzzer_required",
  ];
  const missingFilters = requiredFilters.filter((filter) => !filters.includes(filter));
  if (failed > 0 || total < 5 || missingFilters.length > 0 || !productGovernorOk) {
    return {
      id: "commercial_answer_pipeline_regression",
      status: "failed",
      severity: "P1",
      owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
      evidence: {
        failed,
        total,
        missingFilters,
        productGovernorOk,
        unownedFilters,
        actionableFailures: snapshot!.payload!.actionableFailures,
      },
      nextAction:
        "Fix the macro product governor and answer pipeline owner before judging external-channel or Qwen behavior.",
    };
  }
  return {
    id: "commercial_answer_pipeline_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
    evidence: { total, filters, productGovernor },
    nextAction:
      "Keep this as the macro owner for answer adoption rules; micro canaries must remain attached to product contracts.",
  };
}

function shortIntentFuzzerGate(snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  if (!ownerOk(snapshot)) {
    return ownerUnavailableGate("lcx-external-short-intent-fuzzer", snapshot);
  }
  const summary = recordValue(snapshot!.payload!.summary);
  const macroContract = recordValue(snapshot!.payload!.macroContract);
  const generated = numberValue(summary?.generated) ?? 0;
  const families = numberValue(summary?.families) ?? 0;
  const failed = numberValue(summary?.failed) ?? 0;
  const notWhitelist = booleanValue(macroContract?.notWhitelist) === true;
  if (failed > 0 || generated < 40 || families < 8 || !notWhitelist) {
    return {
      id: "short_intent_family_fuzzer_regression",
      status: "failed",
      severity: "P1",
      owner: "scripts/operator/lcx-external-short-intent-fuzzer.ts",
      evidence: {
        summary,
        notWhitelist,
        failedCases: snapshot!.payload!.failedCases,
      },
      nextAction:
        "Fix shared short-intent routing/audit rules before adding more hand-written External canaries.",
    };
  }
  return {
    id: "short_intent_family_fuzzer_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/lcx-external-short-intent-fuzzer.ts",
    evidence: {
      summary,
      macroContract,
      generatedEvalSeeds: snapshot!.payload!.generatedEvalSeeds,
    },
    nextAction:
      "Keep the 34 fixed canaries as samples only; this owner expands future terse asks by family.",
  };
}

function visibleAnswerQualityFuzzerGate(snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  if (!ownerOk(snapshot)) {
    return ownerUnavailableGate("lcx-visible-answer-quality-fuzzer", snapshot);
  }
  const summary = recordValue(snapshot!.payload!.summary);
  const macroContract = recordValue(snapshot!.payload!.macroContract);
  const families = numberValue(summary?.families) ?? 0;
  const positive = numberValue(summary?.positive) ?? 0;
  const negative = numberValue(summary?.negative) ?? 0;
  const failed = numberValue(summary?.failed) ?? 0;
  const positiveFailures = numberValue(summary?.positiveFailures) ?? 0;
  const positiveAcceptance =
    booleanValue(macroContract?.positiveAcceptanceNotOnlyRejection) === true;
  const directAnswerRequired = booleanValue(macroContract?.conciseDirectAnswerRequired) === true;
  if (
    failed > 0 ||
    positiveFailures > 0 ||
    families < 8 ||
    positive < 8 ||
    negative < 10 ||
    !positiveAcceptance ||
    !directAnswerRequired
  ) {
    return {
      id: "visible_answer_quality_fuzzer_regression",
      status: "failed",
      severity: "P1",
      owner: "scripts/operator/lcx-visible-answer-quality-fuzzer.ts",
      evidence: {
        summary,
        macroContract,
        failedCases: snapshot!.payload!.failedCases,
      },
      nextAction:
        "Fix the visible answer contract so good direct answers are adopted and vague, generic, or over-conservative answers are rejected.",
    };
  }
  return {
    id: "visible_answer_quality_fuzzer_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/lcx-visible-answer-quality-fuzzer.ts",
    evidence: {
      summary,
      macroContract,
      perFamily: snapshot!.payload!.perFamily,
    },
    nextAction:
      "Keep product answer quality as a positive acceptance gate, not only a bad-answer rejection gate.",
  };
}

function directedDailyResearchBriefGate(snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  if (!ownerOk(snapshot)) {
    return ownerUnavailableGate("lcx-directed-daily-research-brief", snapshot);
  }
  const focus = recordValue(snapshot!.payload!.focus);
  const universe = recordValue(snapshot!.payload!.universe);
  const outputContract = recordValue(snapshot!.payload!.outputContract);
  const learningContract = recordValue(snapshot!.payload!.learningContract);
  const tasks = arrayValue(snapshot!.payload!.tasks).map(recordValue);
  const indexOptions = stringArray(universe?.indexOptions);
  const semiconductorAiCompute = stringArray(universe?.semiconductorAiCompute);
  const requiredEvidence = stringArray(outputContract?.requiredEvidence);
  const forbiddenVisibleOutputs = stringArray(outputContract?.forbiddenVisibleOutputs);
  const hasFocusedMode =
    stringValue(snapshot!.payload!.productMode) ===
    "focused_daily_research_product_not_open_ended_chat";
  const hasCoreUniverse =
    ["SPX", "NDX", "QQQ", "VIX"].every((symbol) => indexOptions.includes(symbol)) &&
    ["NVDA", "AMD", "AVGO", "TSM", "ASML"].every((symbol) =>
      semiconductorAiCompute.includes(symbol),
    );
  const hasEvidenceContract = [
    "source_timestamp",
    "field_definition",
    "provider_role",
    "conflict_or_missing_data_status",
  ].every((field) => requiredEvidence.includes(field));
  const hasRiskBoundary = [
    "buy_sell_add_reduce_instruction",
    "position_percentage",
    "options_bet_instruction",
  ].every((field) => forbiddenVisibleOutputs.includes(field));
  const hasLearningTerminal =
    booleanValue(learningContract?.sourceNameAndPathRequired) === true &&
    stringValue(learningContract?.terminalDecision) === "application_ready_or_failedReason";
  if (
    !hasFocusedMode ||
    !hasCoreUniverse ||
    tasks.length < 4 ||
    !hasEvidenceContract ||
    !hasRiskBoundary ||
    !hasLearningTerminal
  ) {
    return {
      id: "directed_daily_research_brief_regression",
      status: "failed",
      severity: "P1",
      owner: "scripts/operator/lcx-directed-daily-research-brief.ts",
      evidence: {
        hasFocusedMode,
        hasCoreUniverse,
        taskCount: tasks.length,
        hasEvidenceContract,
        hasRiskBoundary,
        hasLearningTerminal,
        focus,
        universe,
      },
      nextAction:
        "Fix the focused daily research owner before relying on it as the main product surface.",
    };
  }
  return {
    id: "directed_daily_research_brief_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/lcx-directed-daily-research-brief.ts",
    evidence: {
      focus,
      universe,
      taskCount: tasks.length,
      outputContract,
      learningContract,
    },
    nextAction:
      "Use this as the dependable daily product surface while open Q&A remains a guarded follow-up path.",
  };
}

function architectureGate(
  flowGraph: OwnerSnapshot | undefined,
  mindModel: OwnerSnapshot | undefined,
): AcceptanceGate {
  if (!ownerOk(flowGraph)) {
    return ownerUnavailableGate("lcx-flow-graph", flowGraph);
  }
  if (!ownerOk(mindModel)) {
    return ownerUnavailableGate("lcx-mind-model", mindModel);
  }
  const failures = [
    ...stringArray(flowGraph!.payload!.actionableFailures),
    ...stringArray(mindModel!.payload!.actionableFailures),
  ];
  if (failures.length > 0) {
    return {
      id: "architecture_governance_failures",
      status: "failed",
      severity: "P1",
      owner: "scripts/operator/lcx-flow-graph.ts + scripts/operator/lcx-mind-model.ts",
      evidence: { failures },
      nextAction: "Repair head/workflow/proof/boundary drift before commercial release.",
    };
  }
  return {
    id: "architecture_governance_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/lcx-flow-graph.ts + scripts/operator/lcx-mind-model.ts",
    evidence: {
      flowGraphSummary: flowGraph!.payload!.summary,
      mindModelSummary: mindModel!.payload!.summary,
    },
    nextAction: "Keep commercial acceptance registered in the governance stack.",
  };
}

function radarGate(snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  if (!ownerOk(snapshot)) {
    return ownerUnavailableGate("lcx-problem-cluster-radar", snapshot);
  }
  const summary = recordValue(snapshot!.payload!.summary);
  const actionable = numberValue(summary?.actionableClusters) ?? 0;
  const repairable = numberValue(summary?.repairableClusters) ?? 0;
  const blocked = numberValue(summary?.blockedClusters) ?? 0;
  const watch = numberValue(summary?.watchClusters) ?? 0;
  if (actionable > 0 || repairable > 0) {
    return {
      id: "radar_actionable_problem_clusters",
      status: "failed",
      severity: "P2",
      owner: "scripts/operator/lcx-problem-cluster-radar.ts",
      evidence: {
        summary,
        actionableClusters: snapshot!.payload!.actionableClusters,
        repairableClusters: snapshot!.payload!.repairableClusters,
        nextActions: snapshot!.payload!.nextActions,
      },
      nextAction: "Follow each cluster owner entrypoint and close repairable P2/P3 clusters.",
    };
  }
  if (blocked > 0) {
    const radarSeverity = severityValue(summary?.highestSeverity, "P2");
    const watchOnly = severityRank(radarSeverity) <= severityRank("P3");
    return {
      id: "radar_blocked_problem_clusters",
      status: watchOnly ? "watch" : "blocked",
      severity: radarSeverity,
      owner: "scripts/operator/lcx-problem-cluster-radar.ts",
      evidence: {
        summary,
        blockedClusters: snapshot!.payload!.blockedClusters,
        blockedActions: snapshot!.payload!.blockedActions,
      },
      nextAction: watchOnly
        ? "Watch owner-blocked P3 clusters and avoid starting overlapping repairs."
        : "Do not paper over blocked owner gates; wait for training/eval/module gates or satisfy their prerequisites.",
    };
  }
  if (watch > 0) {
    return {
      id: "radar_watch_problem_clusters",
      status: "watch",
      severity: "P3",
      owner: "scripts/operator/lcx-problem-cluster-radar.ts",
      evidence: { summary, clusters: snapshot!.payload!.clusters },
      nextAction: "Watch non-blocking clusters and avoid starting overlapping repairs.",
    };
  }
  return {
    id: "radar_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/lcx-problem-cluster-radar.ts",
    evidence: { summary },
    nextAction: "Use radar first on the next broad problem hunt.",
  };
}

function externalChannelStatusGate(
  snapshot: OwnerSnapshot | undefined,
  bindingSnapshot: OwnerSnapshot | undefined,
): AcceptanceGate {
  const binding = recordValue(bindingSnapshot?.payload?.externalChannelBinding);
  const bindingStatus = stringValue(binding?.status);
  const bindingChannelBound =
    bindingStatus === "channel_runtime_probe_ok_user_visible_pending" ||
    bindingStatus === "channel_runtime_probe_ok_user_visible_observed";
  const bindingUserVisibleObserved = booleanValue(binding?.userVisibleObserved) === true;
  if (!snapshot?.payload && !bindingChannelBound) {
    return ownerUnavailableGate("lcx-external-channel-status", snapshot);
  }
  const operatorStatus = recordValue(snapshot?.payload?.operatorStatus);
  const externalChannelStatus = recordValue(snapshot?.payload?.externalChannelStatus);
  const visibleProof = recordValue(snapshot?.payload?.visibleProof);
  const devLiveDrift = recordValue(snapshot?.payload?.devLiveDrift);
  const legacyLiveRuntimeUpdated = booleanValue(operatorStatus?.liveRuntimeUpdated) === true;
  const legacyLiveUserSeen = booleanValue(operatorStatus?.liveUserSeen) === true;
  const externalChannelBound =
    bindingChannelBound ||
    booleanValue(externalChannelStatus?.externalChannelBound) === true ||
    legacyLiveRuntimeUpdated;
  const userVisibleObserved =
    bindingUserVisibleObserved ||
    booleanValue(externalChannelStatus?.userVisibleObserved) === true ||
    legacyLiveUserSeen;
  const externalChannelEvidence = {
    channel: "external",
    role: "owner_agent_communication_medium",
    desiredPath: "selected_clean_answer_path_to_external_transport_to_user_visible_observed",
    externalChannelBound,
    userVisibleObserved,
    bindingStatus: binding?.status,
    bindingMissingProof: binding?.missingProof,
    legacyGateIds: {
      externalChannelNotBound: "live_runtime_not_updated",
      userVisibleObserved: "live_user_seen",
    },
    legacyLiveRuntimeUpdated,
    legacyLiveUserSeen,
  };
  if (!externalChannelBound) {
    return {
      id: "external_channel_not_bound",
      status: "blocked",
      severity: "P1",
      owner:
        "scripts/operator/lcx-external-channel-binding.ts + scripts/operator/lcx-external-channel-status.ts",
      evidence: {
        externalChannel: externalChannelEvidence,
        externalChannelBinding: binding,
        externalChannelStatus,
        operatorStatus,
        devLiveDrift,
      },
      nextAction:
        "Route the selected clean LCX answer path through the External transport before claiming user-visible parity; legacy live-runtime wording is compatibility only.",
    };
  }
  if (!userVisibleObserved) {
    return {
      id: "post_migration_external_canary_missing",
      status: "blocked",
      severity: "P2",
      owner:
        "scripts/operator/lcx-external-channel-binding.ts + scripts/operator/lcx-external-channel-status.ts",
      evidence: {
        externalChannel: externalChannelEvidence,
        externalChannelBinding: binding,
        externalChannelStatus,
        operatorStatus,
        liveVisibleStatus: visibleProof?.status,
        freshInboundCount: visibleProof?.freshInboundCount,
        freshOutboundResultCount: visibleProof?.freshOutboundResultCount,
        acceptanceMatched: visibleProof?.acceptanceMatched,
      },
      nextAction:
        "Send one real External natural canary through the external channel, then verify fresh inbound and outbound user-visible evidence.",
    };
  }
  return {
    id: "user_visible_observed",
    status: "passed",
    severity: "info",
    owner:
      "scripts/operator/lcx-external-channel-binding.ts + scripts/operator/lcx-external-channel-status.ts",
    evidence: {
      externalChannel: externalChannelEvidence,
      externalChannelBinding: binding,
      externalChannelStatus,
      operatorStatus,
      liveVisibleStatus: visibleProof?.status,
      freshInboundCount: visibleProof?.freshInboundCount,
      freshOutboundResultCount: visibleProof?.freshOutboundResultCount,
      acceptanceMatched: visibleProof?.acceptanceMatched,
    },
    nextAction:
      "Keep core-ready, external-channel-bound, and user-visible-observed separate; legacy live terms remain compatibility labels.",
  };
}

function trainingGuardGate(snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  if (!snapshot?.payload) {
    return ownerUnavailableGate("local-brain-training-plan", snapshot);
  }
  const activeProcesses = arrayValue(snapshot.payload.activeProcesses);
  const overlappingHeavyEval = booleanValue(snapshot.payload.overlappingHeavyEval) === true;
  if (overlappingHeavyEval) {
    return {
      id: "overlapping_training_or_eval_visible",
      status: "blocked",
      severity: "P1",
      owner: "scripts/operator/local-brain-training-plan.ts",
      evidence: {
        activeProcesses,
        activeHeavyEvalCounts: snapshot.payload.activeHeavyEvalCounts,
      },
      nextAction:
        "Stop starting new heavy work and let the owner training plan classify the active overlap.",
    };
  }
  if (activeProcesses.length > 0) {
    return {
      id: "training_active_watch_only",
      status: "watch",
      severity: "P3",
      owner: "scripts/operator/local-brain-training-plan.ts",
      evidence: {
        activeProcesses: activeProcesses.map((entry) => {
          const record = recordValue(entry);
          return {
            pid: record?.pid,
            role: record?.role,
            elapsed: record?.elapsed,
          };
        }),
        decisions: snapshot.payload.decisions,
      },
      nextAction:
        "Do not start overlapping training; let the current guard finish or report its owner decision.",
    };
  }
  return {
    id: "training_idle",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/local-brain-training-plan.ts",
    evidence: { decisions: snapshot.payload.decisions },
    nextAction:
      "Training is idle; promotion or migration probes can be considered if other gates allow it.",
  };
}

function providerCouncilGate(snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  if (!snapshot?.payload) {
    return {
      id: "provider_council_not_checked",
      status: "watch",
      severity: "P3",
      owner: "scripts/operator/lcx-system-doctor.ts",
      evidence: { reason: snapshot?.error ?? "doctor skipped" },
      nextAction: "Run system doctor when provider council freshness matters.",
    };
  }
  const checks = arrayValue(snapshot.payload.checks).map(recordValue);
  const council = checks.find((check) => check?.name === "model-council-provider-evidence");
  if (!council) {
    return {
      id: "provider_council_not_reported",
      status: "watch",
      severity: "P3",
      owner: "scripts/operator/lcx-system-doctor.ts",
      evidence: { checked: checks.map((check) => check?.name).filter(Boolean) },
      nextAction:
        "Keep provider evidence visible in doctor before claiming all model APIs are healthy.",
    };
  }
  if (booleanValue(council.ok) === false) {
    return {
      id: "provider_council_degraded",
      status: "blocked",
      severity: "P2",
      owner: "scripts/operator/lcx-system-doctor.ts",
      evidence: {
        error: council.error,
        summary: council.summary,
      },
      nextAction: "Report provider degradation honestly; do not claim all model APIs are stable.",
    };
  }
  return {
    id: "provider_council_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/lcx-system-doctor.ts",
    evidence: { summary: council.summary },
    nextAction: "Provider evidence is currently clean in doctor.",
  };
}

function providerCouncilAccelerationGate(snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  if (!snapshot?.payload) {
    return {
      id: "provider_council_acceleration_not_checked",
      status: "watch",
      severity: "P3",
      owner: "scripts/operator/lcx-provider-council-acceleration.ts",
      evidence: { reason: snapshot?.error ?? "provider council acceleration owner not collected" },
      nextAction:
        "Collect the provider-council acceleration owner before claiming Kimi/MiniMax/DeepSeek evidence freshness.",
    };
  }
  const dailyUse = recordValue(snapshot.payload.dailyUse);
  const missingSuccessfulRoles = stringArray(dailyUse?.missingSuccessfulRoles);
  const completeCouncilInWindow = booleanValue(dailyUse?.completeCouncilInWindow) === true;
  const dueNow = booleanValue(dailyUse?.dueNow) === true;
  const hardBlocks = stringArray(snapshot.payload.hardBlocks);
  const status = stringValue(snapshot.payload.status);
  const action = stringValue(snapshot.payload.action);
  const freshCompleteCouncil = booleanValue(snapshot.payload.freshCompleteCouncil) === true;
  const runCompleted =
    status === "provider_council_acceleration_receipt_written" ||
    action === "provider_council_run_completed";
  if (
    runCompleted ||
    freshCompleteCouncil ||
    (completeCouncilInWindow && missingSuccessfulRoles.length === 0)
  ) {
    return {
      id: "provider_council_three_role_evidence_present",
      status: "passed",
      severity: "info",
      owner: "scripts/operator/lcx-provider-council-acceleration.ts",
      evidence: {
        status,
        action,
        dailyUse,
        latestCouncil: snapshot.payload.latestCouncil,
        outputsFeed: snapshot.payload.outputsFeed,
      },
      nextAction:
        "Keep Kimi, MiniMax, and DeepSeek as separately attributable evidence inputs; never treat one model as final authority.",
    };
  }
  if (hardBlocks.length > 0) {
    return {
      id: "provider_council_blocked_by_owner_gate",
      status: "watch",
      severity: "P3",
      owner: "scripts/operator/lcx-provider-council-acceleration.ts",
      evidence: { status, action, hardBlocks, dailyUse },
      nextAction:
        "Do not force provider calls while git, eval/MLX, or freshness gates block the owner command.",
    };
  }
  return {
    id: "provider_council_due_without_complete_three_role_evidence",
    status: dueNow ? "blocked" : "watch",
    severity: dueNow ? "P2" : "P3",
    owner: "scripts/operator/lcx-provider-council-acceleration.ts",
    evidence: { status, action, dailyUse, missingSuccessfulRoles },
    nextAction:
      "Run the bounded provider council --write owner once, then consume the receipt through commercial acceptance.",
  };
}

function moduleLearningClosedLoopGate(snapshot: OwnerSnapshot | undefined): AcceptanceGate {
  if (!ownerOk(snapshot)) {
    return ownerUnavailableGate("lcx-module-learning-absorption-gate", snapshot);
  }
  const counts = recordValue(snapshot!.payload!.counts);
  const blockers = stringArray(snapshot!.payload!.blockers);
  const weakReceiptCount = numberValue(counts?.weakReceiptCount) ?? 0;
  const boundaryViolations = numberValue(counts?.boundaryViolations) ?? 0;
  const missingAbsorptionEvidenceReceipts =
    numberValue(counts?.missingAbsorptionEvidenceReceipts) ?? 0;
  const absorptionReady = booleanValue(snapshot!.payload!.absorptionReady) === true;
  if (
    !absorptionReady ||
    blockers.length > 0 ||
    weakReceiptCount > 0 ||
    boundaryViolations > 0 ||
    missingAbsorptionEvidenceReceipts > 0
  ) {
    return {
      id: "module_learning_closed_loop_incomplete",
      status: "failed",
      severity: "P2",
      owner: "scripts/operator/lcx-module-learning-absorption-gate.ts",
      evidence: {
        absorptionReady,
        gateDecision: snapshot!.payload!.gateDecision,
        counts,
        blockers,
        nextActions: snapshot!.payload!.nextActions,
      },
      nextAction:
        "Close source registry, retrieval/apply, eval/training evidence, fresh adjacent task, and keep/downrank/discard proof before claiming learning absorption.",
    };
  }
  return {
    id: "module_learning_closed_loop_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/lcx-module-learning-absorption-gate.ts",
    evidence: {
      gateDecision: snapshot!.payload!.gateDecision,
      absorptionDecision: snapshot!.payload!.absorptionDecision,
      counts,
      terminalNonAbsorbedRows: snapshot!.payload!.terminalNonAbsorbedRows,
    },
    nextAction:
      "Learning sedimentation can be called eval-absorbed only for claimable rows; terminal discard rows remain audit evidence, not learned capability.",
  };
}

function financeDataGatewayGate(
  cleanSnapshot: OwnerSnapshot | undefined,
  conflictSnapshot: OwnerSnapshot | undefined,
): AcceptanceGate {
  if (!ownerOk(cleanSnapshot)) {
    return ownerUnavailableGate("finance-data-gateway-smoke-clean", cleanSnapshot);
  }
  if (!ownerOk(conflictSnapshot)) {
    return ownerUnavailableGate("finance-data-gateway-smoke-conflict", conflictSnapshot);
  }
  const cleanQuality = stringValue(cleanSnapshot!.payload!.qualityStatus);
  const conflictQuality = stringValue(conflictSnapshot!.payload!.qualityStatus);
  const cleanRoles = stringArray(cleanSnapshot!.payload!.providerRolesPresent);
  const conflictNextSteps = stringArray(conflictSnapshot!.payload!.requiredNextSteps);
  const conflictCount = arrayValue(conflictSnapshot!.payload!.conflicts).length;
  const cleanReady =
    cleanQuality === "ready" &&
    ["primary_market_data", "cross_check_market_data", "official_or_issuer_reference"].every(
      (role) => cleanRoles.includes(role),
    );
  const conflictRouted =
    conflictQuality === "needs_review" &&
    conflictCount > 0 &&
    conflictNextSteps.includes("run_data_provenance_quality_review");
  if (!cleanReady || !conflictRouted) {
    return {
      id: "finance_data_gateway_contract_regression",
      status: "failed",
      severity: "P1",
      owner: "scripts/operator/finance-data-gateway-smoke.ts",
      evidence: {
        cleanQuality,
        cleanRoles,
        conflictQuality,
        conflictCount,
        conflictNextSteps,
      },
      nextAction:
        "Fix the finance data gateway before any visible answer can use current prices, counts, holdings, fundamentals, or conflicted values.",
    };
  }
  return {
    id: "finance_data_gateway_contract_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/operator/finance-data-gateway-smoke.ts",
    evidence: {
      cleanQuality,
      cleanRoles,
      conflictQuality,
      conflictCount,
      conflictNextSteps,
    },
    nextAction:
      "Use finance_data_gateway_snapshot before current numeric finance answers; route conflicts to data provenance review.",
  };
}

export function buildCommercialAcceptanceHarness(inputs: HarnessInputs) {
  const gates = [
    commercialAnswerGate(inputs.commercialAnswerPipeline),
    shortIntentFuzzerGate(inputs.shortIntentFuzzer),
    visibleAnswerQualityFuzzerGate(inputs.visibleAnswerQualityFuzzer),
    directedDailyResearchBriefGate(inputs.directedDailyResearchBrief),
    architectureGate(inputs.flowGraph, inputs.mindModel),
    radarGate(inputs.problemRadar),
    externalChannelStatusGate(inputs.externalChannelStatus, inputs.externalChannelBindingStatus),
    trainingGuardGate(inputs.trainingPlan),
    providerCouncilGate(inputs.systemDoctor),
    providerCouncilAccelerationGate(inputs.providerCouncilAcceleration),
    moduleLearningClosedLoopGate(inputs.moduleLearningAbsorptionGate),
    financeDataGatewayGate(inputs.financeDataGatewaySmoke, inputs.financeDataGatewayConflictSmoke),
  ];
  const failed = gates.filter((gate) => gate.status === "failed");
  const blocked = gates.filter((gate) => gate.status === "blocked");
  const watch = gates.filter((gate) => gate.status === "watch");
  const passed = gates.filter((gate) => gate.status === "passed");
  return {
    ok: failed.length === 0 && blocked.length === 0,
    readyForCommercialRelease: failed.length === 0 && blocked.length === 0,
    boundary: "local_commercial_acceptance_harness_only",
    summary: {
      passed: passed.length,
      failed: failed.length,
      blocked: blocked.length,
      watch: watch.length,
      total: gates.length,
      highestSeverity: highestSeverity(gates),
      worstStatus: gates.toSorted((a, b) => statusRank(b.status) - statusRank(a.status))[0]?.status,
    },
    gates,
    failedGates: failed.map((gate) => gate.id),
    blockedGates: blocked.map((gate) => gate.id),
    watchGates: watch.map((gate) => gate.id),
    canaryPlan: [
      {
        id: "natural_plain_probe",
        purpose:
          "prove ordinary owner-to-agent UX and inspect inbound, answer-audit, and outbound result evidence for the internal route",
        owner: "scripts/operator/lcx-external-channel-status.ts + extensions/external/src/monitor.ts",
        requiredFor: "user_visible_observed",
      },
      {
        id: "external_message_channel_contract",
        purpose:
          "prove the vendor-neutral JSON webhook and HTTP sender contract before binding a real external software endpoint",
        owner: "extensions/external/src/protocol.ts + extensions/external/src/monitor.ts + extensions/external/src/send.ts",
        requiredFor: "external_channel_bound",
      },
      {
        id: "optional_fixed_receipt_anchor",
        purpose: "optional exact-match receipt anchor only when deterministic matching is needed",
        owner: "scripts/operator/lcx-external-channel-status.ts",
        requiredFor: "optional_receipt_anchor",
      },
      {
        id: "finance_research_prompt",
        purpose: "prove core research-only finance path with source and risk gates",
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts + lcx-flow-graph",
        requiredFor: "core_product_value",
      },
      {
        id: "directed_daily_research_brief",
        purpose:
          "prove the main product can produce a daily index-options plus semiconductor/AI compute-chain research packet without relying on open-ended chat",
        owner: "scripts/operator/lcx-directed-daily-research-brief.ts",
        requiredFor: "focused_daily_research_product",
      },
      {
        id: "real_short_external_canary_suite",
        purpose:
          "probe short natural asks like 能买吗, 加不加仓, 学一下这个链接, 到哪了 without allowing silent, generic, or wrong-route replies",
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        requiredFor: "entry_exit_quality",
      },
      {
        id: "short_intent_family_fuzzer",
        purpose:
          "generate short External variants by failure family beyond the fixed canary list, proving unknown terse asks fail cleanly instead of falling through to generic or silent answers",
        owner: "scripts/operator/lcx-external-short-intent-fuzzer.ts",
        requiredFor: "unknown_short_intent_clean_failure",
      },
      {
        id: "visible_answer_quality_fuzzer",
        purpose:
          "prove concise useful answers are adopted for status, missing data, portfolio risk, learning, model disagreement, async work, entry/exit, and user-supplied arithmetic while vague or over-conservative replies are rejected",
        owner: "scripts/operator/lcx-visible-answer-quality-fuzzer.ts",
        requiredFor: "direct_answer_quality",
      },
      {
        id: "three_provider_council_receipt",
        purpose:
          "prove Kimi/MiniMax/DeepSeek were called as separately attributable roles before citing council evidence",
        owner: "scripts/operator/lcx-provider-council-acceleration.ts",
        requiredFor: "provider_council_evidence",
      },
      {
        id: "learning_sedimentation_closed_loop",
        purpose:
          "prove source registry, retrieval/apply, eval absorption, fresh adjacent task, and keep/downrank/discard decision before learned claims",
        owner: "scripts/operator/lcx-module-learning-absorption-gate.ts",
        requiredFor: "learning_absorption_truth",
      },
      {
        id: "finance_gateway_async_receipt_experience",
        purpose:
          "prove finance numbers use gateway provenance and deferred work exposes queued/completion/failure receipt boundaries",
        owner:
          "scripts/operator/finance-data-gateway-smoke.ts + scripts/operator/lcx-commercial-answer-pipeline.ts",
        requiredFor: "numeric_answer_and_async_reply_quality",
      },
    ],
    ownerCommands: [
      "node --import tsx scripts/operator/lcx-commercial-answer-pipeline.ts --json",
      "node --import tsx scripts/operator/lcx-external-short-intent-fuzzer.ts --json",
      "node --import tsx scripts/operator/lcx-visible-answer-quality-fuzzer.ts --json",
      "node --import tsx scripts/operator/lcx-directed-daily-research-brief.ts --json",
      "node --import tsx scripts/operator/lcx-problem-cluster-radar.ts --json",
      "node --import tsx scripts/operator/lcx-flow-graph.ts --json",
      "node --import tsx scripts/operator/lcx-mind-model.ts --json",
      "node --import tsx scripts/operator/local-brain-training-plan.ts --json",
      "node --import tsx scripts/operator/lcx-external-channel-status.ts --json",
      "node --import tsx scripts/operator/lcx-system-doctor.ts --json",
      "node --import tsx scripts/operator/lcx-provider-council-acceleration.ts --json --profile aggressive",
      "node --import tsx scripts/operator/lcx-module-learning-absorption-gate.ts --json",
      "node --import tsx scripts/operator/finance-data-gateway-smoke.ts --json",
      "node --import tsx scripts/operator/finance-data-gateway-smoke.ts --conflict --json",
    ],
    nextActions: gates
      .filter((gate) => gate.status !== "passed")
      .map((gate) => `${gate.id}: ${gate.nextAction}`),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

async function runJsonOwner(owner: string, script: string, args: readonly string[] = []) {
  const command = `node --import tsx ${script} ${args.join(" ")}`.trim();
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
      timeout: 120_000,
    });
    const payload = parseJsonObjectFromOutput(result.stdout);
    return { ok: booleanValue(payload.ok) !== false, owner, command, payload };
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    if (details.stdout) {
      try {
        const payload = parseJsonObjectFromOutput(details.stdout);
        return {
          ok: false,
          owner,
          command,
          payload,
          error: details.message ?? "owner command returned nonzero",
        };
      } catch {
        // Fall through to the raw error snapshot.
      }
    }
    return {
      ok: false,
      owner,
      command,
      error: [details.message, details.stderr?.slice(-500)].filter(Boolean).join("\n"),
    };
  }
}

async function runPnpmJsonOwner(owner: string, args: readonly string[]) {
  const command = `pnpm --silent ${args.join(" ")}`;
  try {
    const result = await execFileAsync("pnpm", ["--silent", ...args], {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
      timeout: 120_000,
    });
    const payload = parseJsonObjectFromOutput(result.stdout);
    return { ok: booleanValue(payload.ok) !== false, owner, command, payload };
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    if (details.stdout) {
      try {
        const payload = parseJsonObjectFromOutput(details.stdout);
        return {
          ok: false,
          owner,
          command,
          payload,
          error: details.message ?? "owner command returned nonzero",
        };
      } catch {
        // Fall through to the raw error snapshot.
      }
    }
    return {
      ok: false,
      owner,
      command,
      error: [details.message, details.stderr?.slice(-500)].filter(Boolean).join("\n"),
    };
  }
}

async function collectOwnerSnapshots(options: CliOptions): Promise<HarnessInputs> {
  const [
    commercialAnswerPipeline,
    shortIntentFuzzer,
    visibleAnswerQualityFuzzer,
    directedDailyResearchBrief,
    problemRadar,
    flowGraph,
    mindModel,
    externalChannelStatus,
    externalChannelBindingStatus,
    trainingPlan,
    systemDoctor,
    providerCouncilAcceleration,
    moduleLearningAbsorptionGate,
    financeDataGatewaySmoke,
    financeDataGatewayConflictSmoke,
  ] = await Promise.all([
    runJsonOwner(
      "lcx-commercial-answer-pipeline",
      "scripts/operator/lcx-commercial-answer-pipeline.ts",
      ["--json"],
    ),
    runJsonOwner(
      "lcx-external-short-intent-fuzzer",
      "scripts/operator/lcx-external-short-intent-fuzzer.ts",
      ["--json"],
    ),
    runJsonOwner(
      "lcx-visible-answer-quality-fuzzer",
      "scripts/operator/lcx-visible-answer-quality-fuzzer.ts",
      ["--json"],
    ),
    Promise.resolve({
      ok: true,
      owner: "lcx-directed-daily-research-brief",
      command: "node --import tsx scripts/operator/lcx-directed-daily-research-brief.ts --json",
      payload: buildDirectedDailyResearchBrief() as unknown as Record<string, unknown>,
    }),
    runJsonOwner("lcx-problem-cluster-radar", "scripts/operator/lcx-problem-cluster-radar.ts", [
      "--json",
    ]),
    runJsonOwner("lcx-flow-graph", "scripts/operator/lcx-flow-graph.ts", ["--json"]),
    runJsonOwner("lcx-mind-model", "scripts/operator/lcx-mind-model.ts", ["--json"]),
    runJsonOwner(
      "lcx-external-channel-status",
      "scripts/operator/lcx-external-channel-status.ts",
      options.withChannelProbe ? ["--json", "--with-probe"] : ["--json"],
    ),
    runJsonOwner(
      "lcx-external-channel-binding",
      "scripts/operator/lcx-external-channel-binding.ts",
      ["--json"],
    ),
    runJsonOwner("local-brain-training-plan", "scripts/operator/local-brain-training-plan.ts", [
      "--json",
    ]),
    options.skipDoctor
      ? Promise.resolve({
          ok: false,
          owner: "lcx-system-doctor",
          command: "skipped",
          error: "doctor skipped by --skip-doctor",
        })
      : runJsonOwner("lcx-system-doctor", "scripts/operator/lcx-system-doctor.ts", ["--json"]),
    runJsonOwner(
      "lcx-provider-council-acceleration",
      "scripts/operator/lcx-provider-council-acceleration.ts",
      ["--json", "--profile", "aggressive"],
    ),
    runJsonOwner(
      "lcx-module-learning-absorption-gate",
      "scripts/operator/lcx-module-learning-absorption-gate.ts",
      ["--json"],
    ),
    runJsonOwner(
      "finance-data-gateway-smoke-clean",
      "scripts/operator/finance-data-gateway-smoke.ts",
      ["--json"],
    ),
    runJsonOwner(
      "finance-data-gateway-smoke-conflict",
      "scripts/operator/finance-data-gateway-smoke.ts",
      ["--conflict", "--json"],
    ),
  ]);
  return {
    commercialAnswerPipeline,
    shortIntentFuzzer,
    visibleAnswerQualityFuzzer,
    directedDailyResearchBrief,
    problemRadar,
    flowGraph,
    mindModel,
    externalChannelStatus,
    externalChannelBindingStatus,
    trainingPlan,
    systemDoctor,
    providerCouncilAcceleration,
    moduleLearningAbsorptionGate,
    financeDataGatewaySmoke,
    financeDataGatewayConflictSmoke,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = buildCommercialAcceptanceHarness(await collectOwnerSnapshots(options));
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `lcx commercial acceptance ok=${result.ok} ready=${result.readyForCommercialRelease} failed=${result.summary.failed} blocked=${result.summary.blocked} watch=${result.summary.watch} highest=${result.summary.highestSeverity}`,
          ...result.gates.map(
            (gate) => `- ${gate.status} ${gate.severity} ${gate.id}: ${gate.nextAction}`,
          ),
        ].join("\n") + "\n",
  );
  process.exitCode = result.summary.failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
