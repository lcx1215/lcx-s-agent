import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
  problemRadar?: OwnerSnapshot;
  flowGraph?: OwnerSnapshot;
  mindModel?: OwnerSnapshot;
  externalChannelStatus?: OwnerSnapshot;
  /** Legacy compatibility alias; use externalChannelStatus for current owner input. */
  liveStatus?: OwnerSnapshot;
  /** Legacy compatibility alias; use externalChannelBindingStatus for current owner input. */
  liveBindingStatus?: OwnerSnapshot;
  externalChannelBindingStatus?: OwnerSnapshot;
  trainingPlan?: OwnerSnapshot;
  systemDoctor?: OwnerSnapshot;
};

type CliOptions = {
  json: boolean;
  withChannelProbe: boolean;
  skipDoctor: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-commercial-acceptance-harness.ts [--json] [--with-channel-probe] [--skip-doctor]",
      "",
      "Runs the dev-only commercial acceptance harness.",
      "It consumes existing owner outputs and never sends Lark messages, starts training, edits provider config, or touches protected memory.",
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
  if (failed > 0 || total < 5) {
    return {
      id: "commercial_answer_pipeline_regression",
      status: "failed",
      severity: "P1",
      owner: "scripts/dev/lcx-commercial-answer-pipeline.ts",
      evidence: {
        failed,
        total,
        actionableFailures: snapshot!.payload!.actionableFailures,
      },
      nextAction: "Fix the answer pipeline owner before judging live or Qwen behavior.",
    };
  }
  return {
    id: "commercial_answer_pipeline_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/dev/lcx-commercial-answer-pipeline.ts",
    evidence: { total, filters: snapshot!.payload!.contractFilters },
    nextAction: "Keep this as the owner for answer adoption rules.",
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
      owner: "scripts/dev/lcx-flow-graph.ts + scripts/dev/lcx-mind-model.ts",
      evidence: { failures },
      nextAction: "Repair head/workflow/proof/boundary drift before commercial release.",
    };
  }
  return {
    id: "architecture_governance_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/dev/lcx-flow-graph.ts + scripts/dev/lcx-mind-model.ts",
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
      owner: "scripts/dev/lcx-problem-cluster-radar.ts",
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
      owner: "scripts/dev/lcx-problem-cluster-radar.ts",
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
      owner: "scripts/dev/lcx-problem-cluster-radar.ts",
      evidence: { summary, clusters: snapshot!.payload!.clusters },
      nextAction: "Watch non-blocking clusters and avoid starting overlapping repairs.",
    };
  }
  return {
    id: "radar_clean",
    status: "passed",
    severity: "info",
    owner: "scripts/dev/lcx-problem-cluster-radar.ts",
    evidence: { summary },
    nextAction: "Use radar first on the next broad problem hunt.",
  };
}

function externalChannelStatusGate(
  snapshot: OwnerSnapshot | undefined,
  bindingSnapshot: OwnerSnapshot | undefined,
): AcceptanceGate {
  if (!snapshot?.payload) {
    return ownerUnavailableGate("lcx-external-channel-status", snapshot);
  }
  const operatorStatus = recordValue(snapshot.payload.operatorStatus);
  const externalChannelStatus = recordValue(snapshot.payload.externalChannelStatus);
  const binding = recordValue(bindingSnapshot?.payload?.externalChannelBinding);
  const visibleProof = recordValue(snapshot.payload.visibleProof);
  const devLiveDrift = recordValue(snapshot.payload.devLiveDrift);
  const legacyLiveRuntimeUpdated = booleanValue(operatorStatus?.liveRuntimeUpdated) === true;
  const legacyLiveUserSeen = booleanValue(operatorStatus?.liveUserSeen) === true;
  const bindingChannelBound =
    stringValue(binding?.status) === "channel_runtime_probe_ok_user_visible_pending";
  const bindingUserVisibleObserved = booleanValue(binding?.userVisibleObserved) === true;
  const externalChannelBound =
    bindingChannelBound ||
    booleanValue(externalChannelStatus?.externalChannelBound) === true ||
    legacyLiveRuntimeUpdated;
  const userVisibleObserved =
    bindingUserVisibleObserved ||
    booleanValue(externalChannelStatus?.userVisibleObserved) === true ||
    legacyLiveUserSeen;
  const externalChannelEvidence = {
    channel: "lark",
    role: "owner_agent_communication_medium",
    desiredPath: "selected_clean_brain_to_lark_external_channel_to_user_visible_observed",
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
        "scripts/dev/lcx-external-channel-binding.ts + scripts/dev/lcx-external-channel-status.ts",
      evidence: {
        externalChannel: externalChannelEvidence,
        externalChannelBinding: binding,
        externalChannelStatus,
        operatorStatus,
        devLiveDrift,
      },
      nextAction:
        "Bind the selected clean brain to the Lark external channel before claiming user-visible parity; legacy live-runtime wording is compatibility only.",
    };
  }
  if (!userVisibleObserved) {
    return {
      id: "post_migration_lark_canary_missing",
      status: "blocked",
      severity: "P2",
      owner:
        "scripts/dev/lcx-external-channel-binding.ts + scripts/dev/lcx-external-channel-status.ts",
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
        "Send one real Lark natural canary through the external channel, then verify fresh inbound and outbound user-visible evidence.",
    };
  }
  return {
    id: "user_visible_observed",
    status: "passed",
    severity: "info",
    owner:
      "scripts/dev/lcx-external-channel-binding.ts + scripts/dev/lcx-external-channel-status.ts",
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
      "Keep dev-ready, external-channel-bound, and user-visible-observed separate; legacy live terms remain compatibility labels.",
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
      owner: "scripts/dev/local-brain-training-plan.ts",
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
      owner: "scripts/dev/local-brain-training-plan.ts",
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
    owner: "scripts/dev/local-brain-training-plan.ts",
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
      owner: "scripts/dev/lcx-system-doctor.ts",
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
      owner: "scripts/dev/lcx-system-doctor.ts",
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
      owner: "scripts/dev/lcx-system-doctor.ts",
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
    owner: "scripts/dev/lcx-system-doctor.ts",
    evidence: { summary: council.summary },
    nextAction: "Provider evidence is currently clean in doctor.",
  };
}

export function buildCommercialAcceptanceHarness(inputs: HarnessInputs) {
  const gates = [
    commercialAnswerGate(inputs.commercialAnswerPipeline),
    architectureGate(inputs.flowGraph, inputs.mindModel),
    radarGate(inputs.problemRadar),
    externalChannelStatusGate(
      inputs.externalChannelStatus ?? inputs.liveStatus,
      inputs.externalChannelBindingStatus ?? inputs.liveBindingStatus,
    ),
    trainingGuardGate(inputs.trainingPlan),
    providerCouncilGate(inputs.systemDoctor),
  ];
  const failed = gates.filter((gate) => gate.status === "failed");
  const blocked = gates.filter((gate) => gate.status === "blocked");
  const watch = gates.filter((gate) => gate.status === "watch");
  const passed = gates.filter((gate) => gate.status === "passed");
  return {
    ok: failed.length === 0 && blocked.length === 0,
    readyForCommercialRelease: failed.length === 0 && blocked.length === 0,
    boundary: "dev_commercial_acceptance_harness_only",
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
        id: "fixed_acceptance_phrase",
        purpose: "prove exact Lark external-channel loop after migration",
        owner: "scripts/dev/lcx-external-channel-status.ts",
        requiredFor: "external_channel_bound",
      },
      {
        id: "natural_learning_prompt",
        purpose: "prove real product learning UX without weird acceptance text",
        owner: "scripts/dev/lcx-external-channel-status.ts + feishu-reply-flow",
        requiredFor: "user_visible_observed",
      },
      {
        id: "finance_research_prompt",
        purpose: "prove core research-only finance path with source and risk gates",
        owner: "scripts/dev/lcx-commercial-answer-pipeline.ts + lcx-flow-graph",
        requiredFor: "core_product_value",
      },
    ],
    ownerCommands: [
      "node --import tsx scripts/dev/lcx-commercial-answer-pipeline.ts --json",
      "node --import tsx scripts/dev/lcx-problem-cluster-radar.ts --json",
      "node --import tsx scripts/dev/lcx-flow-graph.ts --json",
      "node --import tsx scripts/dev/lcx-mind-model.ts --json",
      "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      "node --import tsx scripts/dev/lcx-external-channel-status.ts --json",
      "node --import tsx scripts/dev/lcx-system-doctor.ts --json",
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

async function collectOwnerSnapshots(options: CliOptions): Promise<HarnessInputs> {
  const [
    commercialAnswerPipeline,
    problemRadar,
    flowGraph,
    mindModel,
    externalChannelStatus,
    externalChannelBindingStatus,
    trainingPlan,
    systemDoctor,
  ] = await Promise.all([
    runJsonOwner(
      "lcx-commercial-answer-pipeline",
      "scripts/dev/lcx-commercial-answer-pipeline.ts",
      ["--json"],
    ),
    runJsonOwner("lcx-problem-cluster-radar", "scripts/dev/lcx-problem-cluster-radar.ts", [
      "--json",
    ]),
    runJsonOwner("lcx-flow-graph", "scripts/dev/lcx-flow-graph.ts", ["--json"]),
    runJsonOwner("lcx-mind-model", "scripts/dev/lcx-mind-model.ts", ["--json"]),
    runJsonOwner(
      "lcx-external-channel-status",
      "scripts/dev/lcx-external-channel-status.ts",
      options.withChannelProbe ? ["--json", "--with-probe"] : ["--json"],
    ),
    runJsonOwner("lcx-external-channel-binding", "scripts/dev/lcx-external-channel-binding.ts", [
      "--json",
    ]),
    runJsonOwner("local-brain-training-plan", "scripts/dev/local-brain-training-plan.ts", [
      "--json",
    ]),
    options.skipDoctor
      ? Promise.resolve({
          ok: false,
          owner: "lcx-system-doctor",
          command: "skipped",
          error: "doctor skipped by --skip-doctor",
        })
      : runJsonOwner("lcx-system-doctor", "scripts/dev/lcx-system-doctor.ts", ["--json"]),
  ]);
  return {
    commercialAnswerPipeline,
    problemRadar,
    flowGraph,
    mindModel,
    externalChannelStatus,
    liveStatus: externalChannelStatus,
    externalChannelBindingStatus,
    trainingPlan,
    systemDoctor,
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
