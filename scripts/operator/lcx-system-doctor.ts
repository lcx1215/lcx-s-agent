import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.ts";
import { DEFAULT_GUARD_LOG_PATH, DEFAULT_WORKSPACE_DIR, LCX_USER_HOME } from "./lcx-local-paths.ts";
import { buildLocalBrainTrainingPlan } from "./local-brain-training-plan.ts";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

type CliOptions = {
  json: boolean;
  deep: boolean;
  live: boolean;
  brainPlan: boolean;
};

type CheckResult = {
  name: string;
  ok: boolean;
  skipped?: boolean;
  durationMs: number;
  summary: Record<string, unknown>;
  error?: string;
};

const WORKSPACE_DIR = DEFAULT_WORKSPACE_DIR;
const MINIMAX_GUARD_LOG = DEFAULT_GUARD_LOG_PATH;
const LEARNING_COUNCIL_DIR = path.join(WORKSPACE_DIR, "bank", "knowledge", "learning-councils");
const REVIEW_PANEL_RECEIPT_DIR = path.join(WORKSPACE_DIR, "memory", "review-panel-receipts");
const MODEL_COUNCIL_AUDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_LARK_DIAGNOSE_TIMEOUT_MS = 30_000;
const DEFAULT_LIVE_CHANNEL_PROBE_TIMEOUT_MS = 90_000;
const LIVE_CHANNEL_PROBE_TIMEOUT_MS = resolvePositiveTimeout(
  process.env.LIVE_CHANNEL_PROBE_TIMEOUT_MS,
  DEFAULT_LIVE_CHANNEL_PROBE_TIMEOUT_MS,
);
const LIVE_CHANNEL_STATUS_STEP_TIMEOUT_MS = resolvePositiveTimeout(
  process.env.LIVE_CHANNEL_STATUS_STEP_TIMEOUT_MS,
  5_000,
);
const EXTERNAL_CHANNEL_BINDING_TIMEOUT_MS = resolvePositiveTimeout(
  process.env.EXTERNAL_CHANNEL_BINDING_TIMEOUT_MS,
  110_000,
);
const EXTERNAL_CHANNEL_RUNTIME_REPO =
  process.env.LCX_EXTERNAL_CHANNEL_RUNTIME ??
  path.join(LCX_USER_HOME, ".openclaw", "external-channel-runtime", "lcx-s-openclaw");
const EXTERNAL_CHANNEL_RUNTIME_DIST_ENTRY = path.join(
  EXTERNAL_CHANNEL_RUNTIME_REPO,
  "dist",
  "index.js",
);
// Kept as a source-compatible symbol for existing doctor assertions; it now
// points exclusively at the canonical external-channel runtime.
const LIVE_SIDECAR_DIST_ENTRY = EXTERNAL_CHANNEL_RUNTIME_DIST_ENTRY;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_CWD = path.resolve(SCRIPT_DIR, "..", "..");

function resolvePositiveTimeout(raw: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-system-doctor.ts [--json] [--deep] [--live] [--brain-plan]",
      "",
      "Summarizes LCX Agent dev observability without touching live surfaces by default.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    deep: false,
    live: false,
    brainPlan: false,
  };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--deep") {
      options.deep = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--brain-plan") {
      options.brainPlan = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function runCommand(params: {
  name: string;
  command: string;
  args: string[];
  parseJson?: boolean;
  cwd?: string;
  timeoutMs?: number;
}): Promise<CheckResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(params.command, params.args, {
      cwd: params.cwd ?? WORKTREE_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout =
      params.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            child.kill("SIGTERM");
            resolve({
              name: params.name,
              ok: false,
              durationMs: Date.now() - startedAt,
              summary: {
                stdoutTail: stdout.slice(-500),
                stderrTail: stderr.slice(-500),
                timeoutMs: params.timeoutMs,
              },
              error: `${params.name} timed out after ${params.timeoutMs}ms`,
            });
          }, params.timeoutMs);
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        name: params.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        summary: {},
        error: error.message,
      });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        resolve({
          name: params.name,
          ok: false,
          durationMs,
          summary: {
            stdoutTail: stdout.slice(-500),
            stderrTail: stderr.slice(-500),
            exitCode: code,
          },
          error: `${params.name} exited ${code}`,
        });
        return;
      }
      try {
        const payload = params.parseJson ? parseJsonObjectFromOutput(stdout) : undefined;
        resolve({
          name: params.name,
          ok: true,
          durationMs,
          summary: payload
            ? summarizeJson(params.name, payload)
            : summarizeText(params.name, stdout),
        });
      } catch (error) {
        resolve({
          name: params.name,
          ok: false,
          durationMs,
          summary: {
            stdoutTail: stdout.slice(-500),
            stderrTail: stderr.slice(-500),
          },
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
}

function runQuietCommand(command: string, args: string[]): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: WORKTREE_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      resolve({ command, args, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

async function gitStatusCheck(): Promise<CheckResult> {
  const startedAt = Date.now();
  const cwd = WORKTREE_CWD;
  try {
    const cwdReal = await fs.realpath(cwd);
    const root = await runQuietCommand("git", ["rev-parse", "--show-toplevel"]);
    const gitRoot = root.stdout.trim();
    const gitRootReal = gitRoot ? await fs.realpath(gitRoot) : "";
    if (!gitRootReal || gitRootReal !== cwdReal) {
      return {
        name: "git-status",
        ok: true,
        skipped: true,
        durationMs: Date.now() - startedAt,
        summary: {
          reason: "cwd is not the git toplevel; refusing to report parent git state",
          cwd,
          gitRoot: gitRoot || null,
        },
      };
    }
  } catch (error) {
    return {
      name: "git-status",
      ok: true,
      skipped: true,
      durationMs: Date.now() - startedAt,
      summary: {
        reason: "cwd is not a git worktree",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return runCommand({
    name: "git-status",
    command: "git",
    args: ["status", "--short", "--branch"],
  });
}

function summarizeText(name: string, stdout: string): Record<string, unknown> {
  if (name === "git-status") {
    return summarizeGitStatus(stdout);
  }
  return {
    stdoutTail: stdout.trim().slice(-500),
  };
}

function summarizeGitStatus(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const branch = lines.find((line) => line.startsWith("##")) ?? "";
  const entries = lines.filter((line) => !line.startsWith("##"));
  const modified = entries.filter((line) => line.startsWith(" M") || line.startsWith("M "));
  const added = entries.filter((line) => line.startsWith("A "));
  const deleted = entries.filter((line) => line.startsWith(" D") || line.startsWith("D "));
  const untracked = entries.filter((line) => line.startsWith("??"));
  const renamed = entries.filter((line) => line.startsWith("R "));
  const conflicted = entries.filter((line) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line));
  return {
    branch,
    dirty: entries.length > 0,
    counts: {
      modified: modified.length,
      added: added.length,
      deleted: deleted.length,
      renamed: renamed.length,
      untracked: untracked.length,
      conflicted: conflicted.length,
      total: entries.length,
    },
    modified: modified.map((line) => line.slice(3)).slice(0, 12),
    untracked: untracked.map((line) => line.slice(3)).slice(0, 12),
    conflicted: conflicted.map((line) => line.slice(3)).slice(0, 12),
  };
}

function summarizeJson(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (name === "local-brain-dataset") {
    return {
      ok: payload.ok,
      counts: payload.counts,
      sourceKinds: payload.sourceKinds,
      notTouched: payload.notTouched,
    };
  }
  if (name === "local-brain-smoke") {
    return {
      ok: payload.ok,
      counts: payload.counts,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
    };
  }
  if (name === "local-brain-eval") {
    return {
      ok: payload.ok,
      summary: payload.summary,
      adapterPath: payload.adapterPath,
    };
  }
  if (name === "local-brain-current-adapter") {
    return {
      ok: payload.ok,
      owner: payload.owner,
      planBoundary: payload.planBoundary,
      selectedAdapter: payload.selectedAdapter,
      selectedCleanEval: payload.selectedCleanEval,
      latestPassingEval: payload.latestPassingEval,
      latestPromotedAdapter: payload.latestPromotedAdapter,
      runtimeAdapterPolicy: payload.runtimeAdapterPolicy,
      consolidationState: payload.consolidationState,
      selectionMode: payload.selectionMode,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
    };
  }
  if (name === "external-channel-binding") {
    const decision =
      payload.decision && typeof payload.decision === "object" && !Array.isArray(payload.decision)
        ? (payload.decision as Record<string, unknown>)
        : {};
    const liveBinding =
      payload.liveLarkBrainBinding &&
      typeof payload.liveLarkBrainBinding === "object" &&
      !Array.isArray(payload.liveLarkBrainBinding)
        ? (payload.liveLarkBrainBinding as Record<string, unknown>)
        : {};
    const externalChannelBinding =
      payload.externalChannelBinding &&
      typeof payload.externalChannelBinding === "object" &&
      !Array.isArray(payload.externalChannelBinding)
        ? (payload.externalChannelBinding as Record<string, unknown>)
        : {};
    return {
      ok: payload.ok,
      boundary: payload.boundary,
      externalChannelBinding: {
        status: externalChannelBinding.status,
        action: externalChannelBinding.action,
        selectedCleanAdapter: externalChannelBinding.selectedCleanAdapter,
        missingProof: externalChannelBinding.missingProof,
        userVisibleObserved: externalChannelBinding.userVisibleObserved,
      },
      decision: {
        status: decision.status,
        action: decision.action,
        selectedCleanAdapter: decision.selectedCleanAdapter,
        heavyActive: decision.heavyActive,
        missingProof: decision.missingProof,
        userVisibleObserved: decision.userVisibleObserved ?? decision.liveUserSeen,
        legacyLiveUserSeen: decision.liveUserSeen,
      },
      trainingPlanStatus: externalChannelBinding.status ?? liveBinding.status,
      liveSidecarDriftBefore: payload.liveSidecarDriftBefore,
      nextCommand: payload.nextCommand,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }
  if (name === "doctrine-consistency") {
    return {
      ok: payload.ok,
      summary: payload.summary,
      actionableFailures: payload.actionableFailures,
    };
  }
  if (name === "live-fadeout-audit") {
    const summary =
      payload.summary && typeof payload.summary === "object" && !Array.isArray(payload.summary)
        ? (payload.summary as Record<string, unknown>)
        : {};
    return {
      ok: payload.ok,
      boundary: payload.boundary,
      statusModel: payload.statusModel,
      summary,
      liveReferenceNeedsReview: summary.liveReferenceNeedsReview,
      actionableFailures: payload.actionableFailures,
      advisoryWarnings: payload.advisoryWarnings,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }
  if (name === "learning-sedimentation-audit") {
    return {
      ok: payload.ok,
      assessment: payload.assessment,
      sufficientForCurrentUse: payload.sufficientForCurrentUse,
      chains: payload.chains,
      gaps: payload.gaps,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }
  if (name === "learning-sedimentation-map") {
    return {
      ok: payload.ok,
      summary: payload.summary,
      lanes: Array.isArray(payload.lanes)
        ? payload.lanes.map((lane) => {
            const record =
              lane && typeof lane === "object" && !Array.isArray(lane)
                ? (lane as Record<string, unknown>)
                : {};
            return {
              id: record.id,
              category: record.category,
              status: record.status,
              counts: record.counts,
              nextGate: record.nextGate,
            };
          })
        : [],
      riskyConflations: payload.riskyConflations,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
      languageCorpusTouched: payload.languageCorpusTouched,
    };
  }
  if (name === "learning-sedimentation-bridge") {
    return {
      ok: payload.ok,
      candidateCount: payload.candidateCount,
      writePlanReceipts: payload.writePlanReceipts,
      nextAction: payload.nextAction,
      notPromoted: payload.notPromoted,
      candidates: Array.isArray(payload.candidates) ? payload.candidates.slice(0, 5) : [],
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }
  if (name === "module-learning-absorption-gate") {
    return {
      ok: payload.ok,
      absorptionReady: payload.absorptionReady,
      gateDecision: payload.gateDecision,
      counts: payload.counts,
      latestEval: payload.latestEval,
      blockers: payload.blockers,
      proofGapSummary: payload.proofGapSummary,
      nextProofQueue: Array.isArray(payload.nextProofQueue)
        ? payload.nextProofQueue.slice(0, 5)
        : [],
      missingEvidenceByReceipt: Array.isArray(payload.missingEvidenceByReceipt)
        ? payload.missingEvidenceByReceipt.slice(0, 5)
        : [],
      notPromoted: payload.notPromoted,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }
  if (name === "problem-cluster-radar") {
    return {
      ok: payload.ok,
      boundary: payload.boundary,
      summary: payload.summary,
      actionableClusters: payload.actionableClusters,
      nextActions: payload.nextActions,
      clusters: Array.isArray(payload.clusters)
        ? payload.clusters.map((cluster) => {
            const record =
              cluster && typeof cluster === "object" && !Array.isArray(cluster)
                ? (cluster as Record<string, unknown>)
                : {};
            return {
              id: record.id,
              family: record.family,
              severity: record.severity,
              ownerEntrypoint: record.ownerEntrypoint,
              sourceOwners: record.sourceOwners,
              signalIds: Array.isArray(record.signals)
                ? record.signals
                    .map((signal) =>
                      signal && typeof signal === "object" && !Array.isArray(signal)
                        ? (signal as Record<string, unknown>).id
                        : undefined,
                    )
                    .filter((id): id is string => typeof id === "string")
                : [],
            };
          })
        : [],
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
    };
  }
  if (name === "system-memory-sedimentation-gate") {
    return {
      ok: payload.ok,
      recallReady: payload.recallReady,
      recallClaimReady: payload.recallClaimReady,
      freshEnoughForRecallClaim: payload.freshEnoughForRecallClaim,
      moduleLearningClaimAllowed: payload.moduleLearningClaimAllowed,
      protectedMemoryClean: payload.protectedMemoryClean,
      counts: payload.counts,
      latestSystemMemory: payload.latestSystemMemory,
      claimBoundaries: payload.claimBoundaries,
      blockers: payload.blockers,
      warnings: payload.warnings,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      protectedMemoryTouched: payload.protectedMemoryTouched,
      languageCorpusTouched: payload.languageCorpusTouched,
    };
  }
  if (name === "local-brain-plan") {
    const plan =
      payload.plan && typeof payload.plan === "object"
        ? (payload.plan as Record<string, unknown>)
        : {};
    return {
      ok: payload.ok,
      primaryModules: plan.primary_modules,
      missingData: plan.missing_data,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      durableMemoryTouched: payload.durableMemoryTouched,
      adapterPath: payload.adapterPath,
      adapterSelectionStatus: payload.adapterSelectionStatus,
    };
  }
  if (name === "lark-loop-diagnose" || name === "channels-status-probe") {
    return payload;
  }
  return payload;
}

async function listRecentFiles(params: {
  root: string;
  suffix: string;
  maxAgeMs: number;
  maxFiles: number;
}): Promise<Array<{ filePath: string; mtimeMs: number }>> {
  const startedAfterMs = Date.now() - params.maxAgeMs;
  const collected: Array<{ filePath: string; mtimeMs: number }> = [];

  async function visit(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(filePath);
          return;
        }
        if (!entry.isFile() || !entry.name.endsWith(params.suffix)) {
          return;
        }
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtimeMs >= startedAfterMs) {
            collected.push({ filePath, mtimeMs: stats.mtimeMs });
          }
        } catch {
          // Runtime artifacts can rotate while the doctor is scanning.
        }
      }),
    );
  }

  await visit(params.root);
  return collected
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath))
    .slice(0, params.maxFiles);
}

async function readJsonFileObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function relativeRuntimePath(filePath: string): string {
  return path.relative(WORKSPACE_DIR, filePath) || filePath;
}

async function minimaxTrainingGuardStatusCheck(): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath: MINIMAX_GUARD_LOG,
      worktree: WORKTREE_CWD,
      workspaceDir: WORKSPACE_DIR,
      json: true,
      processCheck: true,
    });
    const decisions = Array.isArray(plan.decisions) ? plan.decisions : [];
    const errorReasons = decisions
      .filter((decision): decision is Record<string, unknown> =>
        Boolean(
          decision &&
          typeof decision === "object" &&
          (decision.id === "guard_failed_after_latest_start" ||
            decision.id === "overlapping_heavy_eval_detected"),
        ),
      )
      .map((decision) => {
        if (typeof decision.reason === "string") {
          return decision.reason;
        }
        return typeof decision.id === "string" ? decision.id : "unknown_training_decision";
      });
    return {
      name: "minimax-brain-training-guard",
      ok: errorReasons.length === 0,
      durationMs: Date.now() - startedAt,
      summary: {
        owner: "local-brain-training-plan",
        planBoundary: plan.boundary,
        active: Array.isArray(plan.activeProcesses) && plan.activeProcesses.length > 0,
        activeProcesses: plan.activeProcesses,
        activeHeavyEvalCounts: plan.activeHeavyEvalCounts,
        overlappingHeavyEval: plan.overlappingHeavyEval,
        latestGuardStart: plan.latestGuardStartAt,
        latestDataset: plan.latestDataset,
        latestTrainSlice: plan.latestTrainSlice,
        latestSmokeAt: plan.latestSmokeAt,
        latestEval: plan.latestEval,
        latestPassingEval: plan.latestPassingEval,
        latestStableEval: plan.latestStableEval,
        latestTrainingSeedEval: plan.latestTrainingSeedEval,
        latestCandidateEval: plan.latestCandidateEval,
        qwenCapabilityConsolidation: plan.qwenCapabilityConsolidation,
        externalChannelBinding: plan.externalChannelBinding,
        legacyLiveLarkBrainBinding: plan.liveLarkBrainBinding,
        liveLarkBrainBinding: plan.liveLarkBrainBinding,
        evolutionAccelerationQueue: plan.evolutionAccelerationQueue,
        latestPromotionAt: plan.latestPromotionAt,
        latestPromotedAdapter: plan.latestPromotedAdapter,
        latestTeacher: plan.latestTeacher,
        latestQuotaStatus: plan.latestQuotaStatus,
        decisionIds: decisions
          .map((decision) =>
            decision && typeof decision === "object"
              ? (decision as Record<string, unknown>).id
              : undefined,
          )
          .filter((id): id is string => typeof id === "string"),
        logPaths: {
          guard: plan.guardLogPath,
          quota: plan.quotaLogPath,
        },
        liveTouched: false,
        providerConfigTouched: false,
      },
      error: errorReasons.length > 0 ? errorReasons.join("; ") : undefined,
    };
  } catch (error) {
    return {
      name: "minimax-brain-training-guard",
      ok: false,
      durationMs: Date.now() - startedAt,
      summary: {
        logPaths: {
          guard: MINIMAX_GUARD_LOG,
          quota: quotaLogPath,
        },
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function localBrainCurrentAdapterFromTrainingPlan(trainingPlanCheck: CheckResult): CheckResult {
  const startedAt = Date.now();
  const qwenCapability =
    trainingPlanCheck.summary.qwenCapabilityConsolidation &&
    typeof trainingPlanCheck.summary.qwenCapabilityConsolidation === "object" &&
    !Array.isArray(trainingPlanCheck.summary.qwenCapabilityConsolidation)
      ? (trainingPlanCheck.summary.qwenCapabilityConsolidation as Record<string, unknown>)
      : {};
  const latestPassingEval =
    trainingPlanCheck.summary.latestPassingEval &&
    typeof trainingPlanCheck.summary.latestPassingEval === "object" &&
    !Array.isArray(trainingPlanCheck.summary.latestPassingEval)
      ? (trainingPlanCheck.summary.latestPassingEval as Record<string, unknown>)
      : {};
  const selectedAdapter =
    typeof qwenCapability.selectedCleanAdapter === "string"
      ? qwenCapability.selectedCleanAdapter
      : typeof latestPassingEval.adapterPath === "string"
        ? latestPassingEval.adapterPath
        : typeof trainingPlanCheck.summary.latestPromotedAdapter === "string"
          ? trainingPlanCheck.summary.latestPromotedAdapter
          : undefined;
  return {
    name: "local-brain-current-adapter",
    ok: trainingPlanCheck.ok && typeof selectedAdapter === "string",
    durationMs: Date.now() - startedAt,
    summary: {
      owner: "local-brain-training-plan",
      planBoundary: trainingPlanCheck.summary.planBoundary,
      selectedAdapter,
      selectedCleanEval: qwenCapability.selectedCleanEval,
      runtimeAdapterPolicy: qwenCapability.runtimeAdapterPolicy,
      consolidationState: qwenCapability.consolidationState,
      latestPassingEval,
      latestPromotedAdapter: trainingPlanCheck.summary.latestPromotedAdapter,
      externalChannelBinding: trainingPlanCheck.summary.externalChannelBinding,
      legacyLiveLarkBrainBinding: trainingPlanCheck.summary.legacyLiveLarkBrainBinding,
      liveLarkBrainBinding: trainingPlanCheck.summary.liveLarkBrainBinding,
      selectionMode: "training-plan-latest-passing",
      liveTouched: false,
      providerConfigTouched: false,
    },
    error:
      trainingPlanCheck.ok && typeof selectedAdapter === "string"
        ? undefined
        : "local-brain-training-plan did not expose a selected clean adapter",
  };
}

type CouncilRoleSummary = {
  role: string;
  model: string;
  providerFamily: string;
  success: boolean;
  error?: string;
};

function summarizeCouncilRoles(payload: Record<string, unknown>): CouncilRoleSummary[] {
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  return roles
    .map((role): CouncilRoleSummary | undefined => {
      if (!role || typeof role !== "object") {
        return undefined;
      }
      const record = role as Record<string, unknown>;
      const roleName = typeof record.role === "string" ? record.role : "";
      if (!roleName) {
        return undefined;
      }
      return {
        role: roleName,
        model: typeof record.model === "string" ? record.model : "",
        providerFamily:
          typeof record.providerFamily === "string" ? record.providerFamily : "unknown",
        success: record.success === true,
        error: typeof record.error === "string" ? record.error : undefined,
      };
    })
    .filter((role): role is CouncilRoleSummary => Boolean(role));
}

function incrementCounter(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

async function modelCouncilProviderEvidenceCheck(): Promise<CheckResult> {
  const startedAt = Date.now();
  const [learningCouncilFiles, reviewPanelFiles] = await Promise.all([
    listRecentFiles({
      root: LEARNING_COUNCIL_DIR,
      suffix: ".json",
      maxAgeMs: MODEL_COUNCIL_AUDIT_WINDOW_MS,
      maxFiles: 30,
    }),
    listRecentFiles({
      root: REVIEW_PANEL_RECEIPT_DIR,
      suffix: ".json",
      maxAgeMs: MODEL_COUNCIL_AUDIT_WINDOW_MS,
      maxFiles: 80,
    }),
  ]);

  const learningCouncilArtifacts = (
    await Promise.all(
      learningCouncilFiles.map(async (entry) => {
        const payload = await readJsonFileObject(entry.filePath);
        if (!payload) {
          return undefined;
        }
        return {
          path: relativeRuntimePath(entry.filePath),
          generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : "",
          userMessage: typeof payload.userMessage === "string" ? payload.userMessage : "",
          status: typeof payload.status === "string" ? payload.status : "unknown",
          roles: summarizeCouncilRoles(payload),
        };
      }),
    )
  ).filter(
    (
      entry,
    ): entry is {
      path: string;
      generatedAt: string;
      userMessage: string;
      status: string;
      roles: CouncilRoleSummary[];
    } => Boolean(entry),
  );

  const roleSuccesses: Record<string, number> = {};
  const roleFailures: Record<string, number> = {};
  for (const artifact of learningCouncilArtifacts) {
    for (const role of artifact.roles) {
      incrementCounter(role.success ? roleSuccesses : roleFailures, role.role);
    }
  }

  const reviewPanelReceipts = await Promise.all(
    reviewPanelFiles.map(async (entry) => {
      const payload = await readJsonFileObject(entry.filePath);
      const result =
        payload?.result && typeof payload.result === "object"
          ? (payload.result as Record<string, unknown>)
          : {};
      const localArbitration =
        result.localArbitration && typeof result.localArbitration === "object"
          ? (result.localArbitration as Record<string, unknown>)
          : {};
      return {
        path: relativeRuntimePath(entry.filePath),
        providerCallsMade: localArbitration.providerCallsMade === true,
      };
    }),
  );

  const latestLearningCouncil = learningCouncilArtifacts[0];
  const latestRoleFailures =
    latestLearningCouncil?.roles.filter((role) => !role.success).map((role) => role.role) ?? [];
  const latestLearningCouncilDegraded =
    latestLearningCouncil?.status === "degraded" || latestRoleFailures.length > 0;
  const reviewPanelProviderBacked = reviewPanelReceipts.filter(
    (receipt) => receipt.providerCallsMade,
  ).length;
  const reviewPanelLocalOnly = reviewPanelReceipts.length - reviewPanelProviderBacked;

  return {
    name: "model-council-provider-evidence",
    ok: !latestLearningCouncilDegraded,
    durationMs: Date.now() - startedAt,
    summary: {
      windowDays: MODEL_COUNCIL_AUDIT_WINDOW_MS / (24 * 60 * 60 * 1000),
      learningCouncilArtifacts: learningCouncilArtifacts.length,
      latestLearningCouncil,
      roleSuccesses,
      roleFailures,
      recentProviderEvidence: {
        kimi: (roleSuccesses.kimi ?? 0) > 0,
        minimax: (roleSuccesses.minimax ?? 0) > 0,
        deepseek: (roleSuccesses.deepseek ?? 0) > 0,
        deepseekAttemptedButFailed: (roleFailures.deepseek ?? 0) > 0,
      },
      reviewPanelReceipts: reviewPanelReceipts.length,
      reviewPanelProviderBacked,
      reviewPanelLocalOnly,
      reviewPanelBoundary:
        "providerCallsMade=false means local deterministic arbitration only, not external Kimi/DeepSeek/MiniMax review.",
      liveTouched: false,
      providerConfigTouched: false,
    },
    error: latestLearningCouncilDegraded
      ? `latest learning council degraded: status=${latestLearningCouncil?.status}, failedRoles=${latestRoleFailures.join(",") || "unknown"}`
      : undefined,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function liveOpenClawInvocation(args: string[]): Promise<{
  command: string;
  args: string[];
  cwd: string;
  source: "live-sidecar-dist" | "dev-pnpm-fallback";
}> {
  if (await fileExists(LIVE_SIDECAR_DIST_ENTRY)) {
    return {
      command: process.execPath,
      args: [LIVE_SIDECAR_DIST_ENTRY, ...args],
      source: "live-sidecar-dist",
      cwd: EXTERNAL_CHANNEL_RUNTIME_REPO,
    };
  }
  return {
    command: "pnpm",
    args: ["--silent", "openclaw", ...args],
    cwd: WORKTREE_CWD,
    source: "dev-pnpm-fallback",
  };
}

async function moduleLearningPipelineReviewCheck(): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir: WORKSPACE_DIR });
    const result = await tool.execute("lcx-system-doctor-module-learning-review", {
      writeReview: false,
    });
    const details = result.details as Record<string, unknown>;
    const counts =
      details.counts && typeof details.counts === "object"
        ? (details.counts as Record<string, unknown>)
        : {};
    const boundaryViolations =
      typeof counts.boundaryViolations === "number" ? counts.boundaryViolations : 0;
    return {
      name: "module-learning-pipeline-review",
      ok: boundaryViolations === 0,
      durationMs: Date.now() - startedAt,
      summary: {
        ok: details.ok,
        boundary: details.boundary,
        updated: details.updated,
        reviewPath: details.reviewPath,
        targetModule: details.targetModule,
        counts,
        weakModuleLearning: Array.isArray(details.weakModuleLearning)
          ? details.weakModuleLearning.slice(0, 5)
          : [],
        proofGapSummary: details.proofGapSummary,
        nextProofQueue: Array.isArray(details.nextProofQueue)
          ? details.nextProofQueue.slice(0, 5)
          : [],
        invalidReceipts: Array.isArray(details.invalidReceipts)
          ? details.invalidReceipts.slice(0, 5)
          : [],
        separationContract: details.separationContract,
      },
      error:
        boundaryViolations > 0
          ? "module learning receipt claims touched live/provider/protected-memory boundary"
          : undefined,
    };
  } catch (error) {
    return {
      name: "module-learning-pipeline-review",
      ok: false,
      durationMs: Date.now() - startedAt,
      summary: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function entrypointCheck(): Promise<CheckResult> {
  const startedAt = Date.now();
  const entries = [
    "scripts/operator/agent-system-loop-smoke.ts",
    "scripts/operator/lark-brain-language-loop-smoke.ts",
    "scripts/operator/lark-brain-distillation-candidate-smoke.ts",
    "scripts/operator/lark-brain-distillation-review.ts",
    "scripts/operator/finance-learning-pipeline-smoke.ts",
    "scripts/operator/local-brain-distill-dataset.ts",
    "scripts/operator/local-brain-distill-train-slice.ts",
    "scripts/operator/local-brain-distill-smoke.ts",
    "scripts/operator/local-brain-distill-eval.ts",
    "scripts/operator/local-brain-training-contract.ts",
    "scripts/operator/local-brain-training-sample-audit.ts",
    "scripts/operator/local-brain-plan.ts",
    "scripts/operator/local-brain-promotion-audit.ts",
    "scripts/operator/lcx-external-channel-binding.ts",
    "scripts/operator/lcx-agent-exam.ts",
    "scripts/operator/lcx-change-impact-plan.ts",
    "scripts/operator/lcx-local-paths.ts",
    "scripts/operator/lcx-context-recovery-exam.ts",
    "scripts/operator/lcx-flow-graph.ts",
    "scripts/operator/lcx-governance-autopilot.ts",
    "scripts/operator/lcx-head-tail-consistency.ts",
    "scripts/operator/lcx-live-fadeout-audit.ts",
    "scripts/operator/lcx-learning-sedimentation-bridge.ts",
    "scripts/operator/lcx-learning-sedimentation-audit.ts",
    "scripts/operator/lcx-learning-sedimentation-map.ts",
    "scripts/operator/lcx-module-learning-absorption-gate.ts",
    "scripts/operator/lcx-system-memory-sedimentation-gate.ts",
    "scripts/operator/lcx-mind-model.ts",
    "scripts/operator/module-learning-pipeline-review.ts",
    "src/agents/tools/module-learning-pipeline-review-tool.ts",
    "src/commands/capabilities/lark-loop-diagnose.ts",
  ];
  const missing = [];
  for (const entry of entries) {
    if (!(await fileExists(path.join(WORKTREE_CWD, entry)))) {
      missing.push(entry);
    }
  }
  return {
    name: "observability-entrypoints",
    ok: missing.length === 0,
    durationMs: Date.now() - startedAt,
    summary: {
      checked: entries.length,
      missing,
    },
    error: missing.length > 0 ? "missing observability entrypoints" : undefined,
  };
}

function skipped(name: string, reason: string): CheckResult {
  return {
    name,
    ok: true,
    skipped: true,
    durationMs: 0,
    summary: { reason },
  };
}

function actionableFailures(checks: CheckResult[]): string[] {
  return checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name}: ${check.error ?? "failed"}`);
}

const options = parseArgs(process.argv.slice(2));
const checks: CheckResult[] = [];

checks.push(await gitStatusCheck());
checks.push(await entrypointCheck());
checks.push(
  await runCommand({
    name: "doctrine-consistency",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-doctrine-consistency.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "live-fadeout-audit",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-live-fadeout-audit.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "head-tail-consistency",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-head-tail-consistency.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "mind-model-consistency",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-mind-model.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "flow-graph-exam",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-flow-graph.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "context-recovery-exam",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-context-recovery-exam.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(await moduleLearningPipelineReviewCheck());
checks.push(
  await runCommand({
    name: "learning-sedimentation-audit",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-learning-sedimentation-audit.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "learning-sedimentation-map",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-learning-sedimentation-map.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "learning-sedimentation-bridge",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-learning-sedimentation-bridge.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "module-learning-absorption-gate",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-module-learning-absorption-gate.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "system-memory-sedimentation-gate",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-system-memory-sedimentation-gate.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "problem-cluster-radar",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-problem-cluster-radar.ts", "--json"],
    parseJson: true,
  }),
);
const trainingGuardCheck = await minimaxTrainingGuardStatusCheck();
checks.push(trainingGuardCheck);
checks.push(await modelCouncilProviderEvidenceCheck());
checks.push(
  await runCommand({
    name: "brain-distillation-candidate-smoke",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lark-brain-distillation-candidate-smoke.ts"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "brain-distillation-review-dry-run",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lark-brain-distillation-review.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "local-brain-dataset",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/local-brain-distill-dataset.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "local-brain-smoke",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/local-brain-distill-smoke.ts", "--json"],
    parseJson: true,
  }),
);
const currentAdapterCheck = localBrainCurrentAdapterFromTrainingPlan(trainingGuardCheck);
checks.push(currentAdapterCheck);
checks.push(
  await runCommand({
    name: "external-channel-binding",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/operator/lcx-external-channel-binding.ts", "--json"],
    parseJson: true,
    timeoutMs: EXTERNAL_CHANNEL_BINDING_TIMEOUT_MS,
  }),
);
checks.push(
  options.brainPlan || options.deep
    ? await runCommand({
        name: "local-brain-plan",
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "scripts/operator/local-brain-plan.ts",
          "--ask",
          "我想研究QQQ和TLT的风险切换，先拆内部模块，不要给交易建议。",
          "--json",
        ],
        parseJson: true,
      })
    : skipped("local-brain-plan", "use --brain-plan or --deep; MLX generation is slower"),
);

if (options.deep) {
  const currentAdapterPath =
    typeof currentAdapterCheck.summary.selectedAdapter === "string"
      ? currentAdapterCheck.summary.selectedAdapter
      : typeof currentAdapterCheck.summary.trainingSeedAdapter === "string"
        ? currentAdapterCheck.summary.trainingSeedAdapter
        : undefined;
  checks.push(
    currentAdapterPath
      ? await runCommand({
          name: "local-brain-eval",
          command: process.execPath,
          args: [
            "--import",
            "tsx",
            "scripts/operator/local-brain-distill-eval.ts",
            "--model",
            "Qwen/Qwen3-0.6B",
            "--adapter",
            currentAdapterPath,
            "--json",
          ],
          parseJson: true,
        })
      : skipped("local-brain-eval", "current adapter resolver returned no usable adapter"),
  );
  checks.push(
    await runCommand({
      name: "build",
      command: "pnpm",
      args: ["build"],
    }),
  );
} else {
  checks.push(skipped("local-brain-eval", "use --deep; MLX generation is intentionally slower"));
  checks.push(skipped("build", "use --deep for full TypeScript/build verification"));
}

if (options.live) {
  const liveLarkDiagnose = await liveOpenClawInvocation([
    "capabilities",
    "lark-loop-diagnose",
    "--json",
  ]);
  const liveChannelProbe = await liveOpenClawInvocation([
    "channels",
    "status",
    "--probe",
    "--json",
    "--timeout",
    String(LIVE_CHANNEL_STATUS_STEP_TIMEOUT_MS),
  ]);
  checks.push(
    await runCommand({
      name: "lark-loop-diagnose",
      command: liveLarkDiagnose.command,
      args: liveLarkDiagnose.args,
      cwd: liveLarkDiagnose.cwd,
      parseJson: true,
      timeoutMs: LIVE_LARK_DIAGNOSE_TIMEOUT_MS,
    }),
  );
  checks.push(
    await runCommand({
      name: "channels-status-probe",
      command: liveChannelProbe.command,
      args: liveChannelProbe.args,
      cwd: liveChannelProbe.cwd,
      parseJson: true,
      timeoutMs: LIVE_CHANNEL_PROBE_TIMEOUT_MS,
    }),
  );
} else {
  checks.push(skipped("lark-loop-diagnose", "use --live; default doctor does not touch live Lark"));
  checks.push(
    skipped("channels-status-probe", "use --live; default doctor does not probe live channels"),
  );
}

checks.push(
  await runCommand({
    name: "diff-check",
    command: "git",
    args: ["diff", "--check"],
  }),
);

const failures = actionableFailures(checks);
const result = {
  ok: failures.length === 0,
  boundary: "local_observability_only",
  deep: options.deep,
  live: options.live,
  brainPlan: options.brainPlan,
  liveTouched: options.live,
  checkedAt: new Date().toISOString(),
  summary: {
    passed: checks.filter((check) => check.ok && !check.skipped).length,
    skipped: checks.filter((check) => check.skipped).length,
    failed: checks.filter((check) => !check.ok).length,
    total: checks.length,
  },
  checks,
  actionableFailures: failures,
};

const gitSummary = checks.find((check) => check.name === "git-status")?.summary;
const gitCounts = gitSummary && typeof gitSummary === "object" ? gitSummary.counts : undefined;
const skippedChecks = checks.filter((check) => check.skipped).map((check) => check.name);

process.stdout.write(
  options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : [
        `lcx system doctor ${result.ok ? "ok" : "failed"}`,
        `passed=${result.summary.passed} skipped=${result.summary.skipped} failed=${result.summary.failed}`,
        gitCounts && typeof gitCounts === "object"
          ? `git dirty=${String((gitSummary as Record<string, unknown>).dirty)} counts=${JSON.stringify(gitCounts)}`
          : undefined,
        skippedChecks.length > 0 ? `skipped=${skippedChecks.join(",")}` : undefined,
        ...failures.map((failure) => `- ${failure}`),
      ]
        .filter(Boolean)
        .join("\n") + "\n",
);

process.exitCode = result.ok ? 0 : 1;
