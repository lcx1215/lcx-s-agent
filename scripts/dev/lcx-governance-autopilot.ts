import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
  DEFAULT_WORKSPACE_DIR,
  EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
  GOVERNANCE_AUTOPILOT_LATEST_PATH,
} from "./lcx-local-paths.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const EXEC_MAX_BUFFER = 48 * 1024 * 1024;

type OwnerId =
  | "problemRadar"
  | "commercialAcceptance"
  | "changeImpact"
  | "trainingPlan"
  | "liveLarkBrainBinding"
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
  error?: string;
};

const OWNER_COMMANDS: OwnerCommand[] = [
  {
    id: "problemRadar",
    script: "scripts/dev/lcx-problem-cluster-radar.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "commercialAcceptance",
    script: "scripts/dev/lcx-commercial-acceptance-harness.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "changeImpact",
    script: "scripts/dev/lcx-change-impact-plan.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "trainingPlan",
    script: "scripts/dev/local-brain-training-plan.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "liveLarkBrainBinding",
    script: "scripts/dev/lcx-live-lark-brain-binding.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "mindModel",
    script: "scripts/dev/lcx-mind-model.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "flowGraph",
    script: "scripts/dev/lcx-flow-graph.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "headTail",
    script: "scripts/dev/lcx-head-tail-consistency.ts",
    args: ["--json"],
    required: true,
  },
  {
    id: "contextRecovery",
    script: "scripts/dev/lcx-context-recovery-exam.ts",
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
    structuralOwnerFailures: string[];
    blockedClusters: unknown;
    blockedGates: unknown;
  };
  liveTouched: boolean;
  providerConfigTouched: boolean;
  protectedMemoryTouched: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-governance-autopilot.ts [--json]",
      "",
      "Runs the read-only LCX governance owner stack, writes the latest compact",
      "autopilot snapshot, and never starts training, live apply, provider config",
      "changes, protected-memory writes, or live sender changes.",
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

  if (id === "trainingPlan") {
    const liveLarkBrainBinding = recordValue(payload.liveLarkBrainBinding);
    const accelerationQueue = recordValue(payload.evolutionAccelerationQueue);
    const latestCandidateEval = recordValue(payload.latestCandidateEval);
    const activeGuardAdapterTruth = recordValue(payload.activeGuardAdapterTruth);
    return {
      activeProcessCount: arrayValue(payload.activeProcesses).length,
      activeHeavyEvalCounts: payload.activeHeavyEvalCounts,
      selectedCleanAdapter:
        payload.selectedCleanAdapter ?? liveLarkBrainBinding?.selectedCleanAdapter,
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
            fastestSafeNextAction: accelerationQueue.fastestSafeNextAction,
            readyNowCount: accelerationQueue.readyNowCount,
            idleOnlyCount: accelerationQueue.idleOnlyCount,
            blockedCount: accelerationQueue.blockedCount,
          }
        : undefined,
    };
  }

  if (id === "liveLarkBrainBinding") {
    const decision = recordValue(payload.decision);
    return {
      status: decision?.status,
      action: decision?.action,
      selectedCleanAdapter: decision?.selectedCleanAdapter,
      missingProof: decision?.missingProof,
      heavyActive: decision?.heavyActive,
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
        line.includes("scripts/dev/minimax-brain-training-guard.ts") ||
        line.includes("scripts/dev/minimax-quota-brain-saturator.ts") ||
        line.includes("scripts/dev/minimax-brain-teacher-batch.ts") ||
        line.includes("scripts/dev/local-brain-distill-eval.ts") ||
        /mlx_lm (generate|lora)/.test(line)
      );
    });
  return {
    guard: lines.filter((line) => line.includes("scripts/dev/minimax-brain-training-guard.ts")),
    eval: lines.filter((line) => line.includes("scripts/dev/local-brain-distill-eval.ts")),
    mlx: lines.filter((line) => /mlx_lm (generate|lora)/.test(line)),
    teacher: lines.filter((line) => line.includes("scripts/dev/minimax-brain-teacher-batch.ts")),
    quota: lines.filter((line) => line.includes("scripts/dev/minimax-quota-brain-saturator.ts")),
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
  trainingCompact,
  liveBindingCompact,
}: {
  receipt: HandoffReceipt;
  gitStatusLines: string[];
  activePids: ActivePidSummary;
  digestMaterial: Record<string, unknown>;
  trainingCompact: Record<string, unknown> | undefined;
  liveBindingCompact: Record<string, unknown> | undefined;
}) {
  const latestCandidateEval = recordValue(trainingCompact?.latestCandidateEval);
  const evolutionAcceleration = recordValue(trainingCompact?.evolutionAcceleration);
  return [
    "# LCX Context Recovery Handoff",
    "",
    `generatedAt: ${receipt.checkedAt}`,
    "boundary: dev_context_recovery_handoff_only",
    "owner: lcx-governance-autopilot",
    `repo: ${repoRoot}`,
    `branch: ${gitStatusLines[0] ?? "unknown"}`,
    `dirtyCount: ${Math.max(0, gitStatusLines.length - 1)}`,
    "",
    "## Active PIDs",
    ...activePidHandoffLines(activePids),
    "",
    "## Training Truth",
    `- activeTrainingOrEval: ${inlineValue(receipt.summary.activeTrainingOrEval)}`,
    `- fastestSafeNextAction: ${inlineValue(receipt.summary.fastestSafeNextAction)}`,
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
    "## Live Binding",
    `- status: ${inlineValue(liveBindingCompact?.status)}`,
    `- action: ${inlineValue(liveBindingCompact?.action)}`,
    `- selectedCleanAdapter: ${inlineValue(liveBindingCompact?.selectedCleanAdapter)}`,
    `- missingProof: ${inlineValue(liveBindingCompact?.missingProof)}`,
    `- liveUserSeen: ${inlineValue(liveBindingCompact?.liveUserSeen)}`,
    `- liveSidecarDriftBefore: ${inlineValue(liveBindingCompact?.liveSidecarDriftBefore)}`,
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
    "## Next Safe Action",
    activePids.eval.length > 0 || activePids.mlx.length > 0
      ? "- wait: active eval or MLX generate is running; do not mutate repo, promote, live-apply, or start training."
      : `- ${inlineValue(receipt.summary.fastestSafeNextAction)}`,
    "",
    "## Missing Proof",
    markdownList(liveBindingCompact?.missingProof),
    "",
    "## Boundaries",
    `- liveTouched: ${inlineValue(receipt.liveTouched)}`,
    `- providerConfigTouched: ${inlineValue(receipt.providerConfigTouched)}`,
    `- protectedMemoryTouched: ${inlineValue(receipt.protectedMemoryTouched)}`,
    "- no live-visible-fixed from this handoff",
    "- use fresh local-brain-training-plan before acting on volatile runtime truth",
    "- receipts and stored sources are not model-weight absorption proof",
  ].join("\n");
}

const options = parseArgs(process.argv.slice(2));
const owners = await Promise.all(OWNER_COMMANDS.map((command) => runOwner(command)));
const byOwner = ownerMap(owners);
const requiredParseFailures = owners.filter(
  (owner) => OWNER_COMMANDS.find((command) => command.id === owner.id)?.required && !owner.parsed,
);
const activeTrainingOrEval = trainingActive(byOwner.trainingPlan, byOwner.liveLarkBrainBinding);
const structuralOwnerFailures = owners.filter((owner) => owner.parsed && owner.ok === false);
const releaseBlocked =
  byOwner.commercialAcceptance?.compact.readyForCommercialRelease === false ||
  stringArray(byOwner.problemRadar?.compact.actionableClusters).length > 0 ||
  stringArray(byOwner.problemRadar?.compact.blockedClusters).length > 0;

const receipt = {
  ok: requiredParseFailures.length === 0,
  boundary: "dev_governance_autopilot_only",
  checkedAt: new Date().toISOString(),
  workspaceDir: DEFAULT_WORKSPACE_DIR,
  latestStatePath: GOVERNANCE_AUTOPILOT_LATEST_PATH,
  evolutionPromotionDigestPath: EVOLUTION_PROMOTION_DIGEST_LATEST_PATH,
  handoffLatestPath: CONTEXT_RECOVERY_HANDOFF_LATEST_PATH,
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
    readOnly: true,
    autoUpdateLatestState: true,
    activeTrainingOrEval,
    heavyWorkDeferred: activeTrainingOrEval,
    idleOnlyWorkDeferred: activeTrainingOrEval,
    liveApplyDeferred: activeTrainingOrEval,
    evolutionPromotionDigestUpdated: true,
    contextRecoveryHandoffUpdated: true,
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
    liveLarkBrainBindingStatus: byOwner.liveLarkBrainBinding?.compact.status,
    fastestSafeNextAction: recordValue(byOwner.trainingPlan?.compact.evolutionAcceleration)
      ?.fastestSafeNextAction,
  },
  owners: Object.fromEntries(owners.map((owner) => [owner.id, owner.compact])),
  notTouched: [
    "live_sender",
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
const liveBindingCompact = recordValue(receipt.owners.liveLarkBrainBinding);
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
  liveLarkBrainBindingStatus: receipt.summary.liveLarkBrainBindingStatus,
  fastestSafeNextAction: receipt.summary.fastestSafeNextAction,
  selectedCleanAdapter: trainingCompact?.selectedCleanAdapter,
  decisionIds: trainingCompact?.decisionIds ?? [],
  latestCandidateEval: trainingCompact?.latestCandidateEval,
  guardUsesSelectedCleanAdapter: trainingCompact?.guardUsesSelectedCleanAdapter,
  liveBindingMissingProof: liveBindingCompact?.missingProof ?? [],
  mindModelFailed: recordValue(mindModelCompact?.summary)?.failed,
  flowGraphFailed: recordValue(flowGraphCompact?.summary)?.failed,
  headTailFailed: recordValue(headTailCompact?.summary)?.failed,
  contextRecoveryOk: contextRecoveryCompact?.compressedContextRecovered,
  liveTouched: receipt.liveTouched,
  providerConfigTouched: receipt.providerConfigTouched,
  protectedMemoryTouched: receipt.protectedMemoryTouched,
};
const evolutionPromotionDigest = {
  kind: "lcx-evolution-promotion-digest",
  boundary: "dev_evolution_promotion_digest_only",
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
  liveLarkBrainBinding: liveBindingCompact,
  material: digestMaterial,
  quietReason:
    activePids.eval.length > 0 || activePids.mlx.length > 0
      ? "active_eval_or_mlx_generate_defer_mutating_work"
      : "autopilot_idle_owner_outputs_current",
  liveTouched: receipt.liveTouched,
  providerConfigTouched: receipt.providerConfigTouched,
  protectedMemoryTouched: receipt.protectedMemoryTouched,
};

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
    trainingCompact,
    liveBindingCompact,
  })}\n`,
);

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
