import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { LOCAL_OPERATOR_LATEST_PATH } from "./lcx-local-paths.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const LOCAL_OPERATOR_LATEST = LOCAL_OPERATOR_LATEST_PATH;
const MAX_OPERATOR_STATE_AGE_MS = 3 * 60 * 60 * 1000;

type RecoveryCheck = {
  id: string;
  ok: boolean;
  summary: string;
  evidence?: unknown;
};

type RecoveryWarning = {
  id: string;
  summary: string;
  evidence?: unknown;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-context-recovery-exam.ts [--json]",
      "",
      "Read-only compressed-context recovery exam. It verifies a future Codex or Claude",
      "window can recover LCX Agent state from durable files instead of chat memory.",
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

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8").catch(() => "");
}

async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function includesAll(text: string, terms: readonly string[]): boolean {
  const normalized = text.replace(/\s+/gu, " ").toLowerCase();
  return terms.every((term) => normalized.includes(term.toLowerCase()));
}

function nestedBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record[key] === "number" ? record[key] : undefined;
}

function decisionIds(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const decisions = (value as Record<string, unknown>).decisions;
  if (!Array.isArray(decisions)) {
    return [];
  }
  return decisions
    .map((decision) => {
      if (!decision || typeof decision !== "object") {
        return undefined;
      }
      const id = (decision as Record<string, unknown>).id;
      return typeof id === "string" ? id : undefined;
    })
    .filter((id): id is string => id !== undefined)
    .toSorted();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compactTrainingPlan(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const latestEval = record.latestEval as Record<string, unknown> | undefined;
  const moduleLearningReview = record.moduleLearningReview as Record<string, unknown> | undefined;
  return {
    ok: record.ok,
    boundary: record.boundary,
    workspaceDir: record.workspaceDir,
    latestGuardStartAt: record.latestGuardStartAt,
    activeProcessCount: Array.isArray(record.activeProcesses) ? record.activeProcesses.length : 0,
    decisionIds: decisionIds(record),
    latestEval: latestEval
      ? {
          name: latestEval.name,
          passed: latestEval.passed,
          total: latestEval.total,
          promotionReady: latestEval.promotionReady,
          parseRecoveredCaseIds: latestEval.parseRecoveredCaseIds,
        }
      : undefined,
    moduleLearningCounts: moduleLearningReview?.counts,
  };
}

function compactOperatorTraining(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const latestStableEval = record.latestStableEval as Record<string, unknown> | undefined;
  const latestCandidateEval = record.latestCandidateEval as Record<string, unknown> | undefined;
  return {
    active: record.active,
    activeProcessCount: Array.isArray(record.activeProcesses) ? record.activeProcesses.length : 0,
    overlappingHeavyEval: record.overlappingHeavyEval,
    latestGuardStart: record.latestGuardStart,
    latestStableEval: latestStableEval
      ? {
          passed: latestStableEval.passed,
          total: latestStableEval.total,
          promotionReady: latestStableEval.promotionReady,
          adapterPath: latestStableEval.adapterPath,
        }
      : undefined,
    latestCandidateEval: latestCandidateEval
      ? {
          passed: latestCandidateEval.passed,
          total: latestCandidateEval.total,
          promotionReady: latestCandidateEval.promotionReady,
          adapterPath: latestCandidateEval.adapterPath,
        }
      : undefined,
    datasetCounts: record.datasetCounts,
  };
}

function compactCurrentTrainingVolatile(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const latestEval = record.latestEval as Record<string, unknown> | undefined;
  return {
    activeProcessCount: Array.isArray(record.activeProcesses) ? record.activeProcesses.length : 0,
    latestGuardStart: record.latestGuardStartAt,
    latestEval: latestEval
      ? {
          passed: latestEval.passed,
          total: latestEval.total,
          promotionReady: latestEval.promotionReady,
          adapterPath: latestEval.adapterPath,
        }
      : undefined,
    datasetCounts:
      record.latestDataset && typeof record.latestDataset === "object"
        ? (record.latestDataset as Record<string, unknown>).counts
        : undefined,
  };
}

function operatorTrainingVolatileMatches(
  operatorSnapshot: ReturnType<typeof compactOperatorTraining>,
  currentSnapshot: ReturnType<typeof compactCurrentTrainingVolatile>,
): boolean {
  if (!operatorSnapshot || !currentSnapshot) {
    return true;
  }
  const operatorActive = operatorSnapshot.active === true;
  const currentActive = (currentSnapshot.activeProcessCount ?? 0) > 0;
  return (
    operatorActive === currentActive &&
    operatorSnapshot.latestGuardStart === currentSnapshot.latestGuardStart &&
    JSON.stringify(operatorSnapshot.latestStableEval) ===
      JSON.stringify(currentSnapshot.latestEval) &&
    JSON.stringify(operatorSnapshot.datasetCounts) === JSON.stringify(currentSnapshot.datasetCounts)
  );
}

function isoAgeMs(value: unknown, nowMs = Date.now()): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return undefined;
  }
  return nowMs - time;
}

async function currentTrainingPlanSnapshot(): Promise<{
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/local-brain-training-plan.ts", "--json"],
      { cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    return { ok: true, payload: JSON.parse(stdout) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function mindModelCheck(): Promise<RecoveryCheck> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-mind-model.ts", "--json"],
      { cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown> | undefined;
    return {
      id: "mind_model_recovers_macro_workflow",
      ok: payload.ok === true,
      summary: "lcx-mind-model must pass without chat context",
      evidence: {
        boundary: payload.boundary,
        passed: summary?.passed,
        failed: summary?.failed,
        missingSurfaceFiles: payload.missingSurfaceFiles,
        actionableFailures: payload.actionableFailures,
      },
    };
  } catch (error) {
    return {
      id: "mind_model_recovers_macro_workflow",
      ok: false,
      summary: "lcx-mind-model must pass without chat context",
      evidence: String(error),
    };
  }
}

async function flowGraphCheck(): Promise<RecoveryCheck> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-flow-graph.ts", "--json"],
      { cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown> | undefined;
    return {
      id: "flow_graph_recovers_task_waterflows",
      ok: payload.ok === true,
      summary: "lcx-flow-graph must pass without chat context",
      evidence: {
        boundary: payload.boundary,
        passed: summary?.passed,
        failed: summary?.failed,
        scenarios: summary?.scenarios,
        nodes: summary?.nodes,
        filters: summary?.filters,
        actionableFailures: payload.actionableFailures,
      },
    };
  } catch (error) {
    return {
      id: "flow_graph_recovers_task_waterflows",
      ok: false,
      summary: "lcx-flow-graph must pass without chat context",
      evidence: String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [agents, runbook, changeImpact, latestState, mindModel, flowGraph, currentTrainingPlan] =
    await Promise.all([
      readText(path.join(repoRoot, "AGENTS.md")),
      readText(path.join(repoRoot, "ops/local-brain/README.md")),
      readText(path.join(repoRoot, "scripts/dev/lcx-change-impact-plan.ts")),
      readJson(LOCAL_OPERATOR_LATEST),
      mindModelCheck(),
      flowGraphCheck(),
      currentTrainingPlanSnapshot(),
    ]);

  const latestMindModel = latestState?.mindModel as Record<string, unknown> | undefined;
  const latestFlowGraph = latestState?.flowGraph as Record<string, unknown> | undefined;
  const latestContextRecovery = latestState?.contextRecovery as Record<string, unknown> | undefined;
  const latestTraining = latestState?.training as Record<string, unknown> | undefined;
  const latestTrainingPlan = latestState?.trainingPlan as Record<string, unknown> | undefined;
  const latestOperatorAgeMs = isoAgeMs(latestState?.checkedAt);
  const currentFlowEvidence = flowGraph.evidence as Record<string, unknown> | undefined;
  const operatorFlowMatchesCurrent =
    latestState !== undefined &&
    latestFlowGraph?.boundary === "dev_flow_graph_only" &&
    numberField(latestFlowGraph, "nodes") === numberField(currentFlowEvidence, "nodes") &&
    numberField(latestFlowGraph, "filters") === numberField(currentFlowEvidence, "filters") &&
    numberField(latestFlowGraph, "scenarios") === numberField(currentFlowEvidence, "scenarios");
  const currentTrainingDecisionIds = decisionIds(currentTrainingPlan.payload);
  const latestTrainingDecisionIds = decisionIds(latestTrainingPlan);
  const operatorTrainingPlanMatchesCurrent =
    latestTrainingPlan === undefined ||
    sameStringSet(latestTrainingDecisionIds, currentTrainingDecisionIds);
  const operatorTrainingSnapshot = compactOperatorTraining(latestTraining);
  const currentTrainingVolatileSnapshot = compactCurrentTrainingVolatile(
    currentTrainingPlan.payload,
  );
  const operatorTrainingVolatileMatchesCurrent =
    latestTraining === undefined ||
    operatorTrainingVolatileMatches(operatorTrainingSnapshot, currentTrainingVolatileSnapshot);

  const checks: RecoveryCheck[] = [
    {
      id: "fixed_evidence_recovery_commands_present",
      ok: includesAll(agents + "\n" + runbook, [
        "ops/local-brain/README.md",
        "lcx-system-doctor",
        "local-brain-training-plan",
        "lcx-local-operator-latest.json",
        "lcx-mind-model",
        "lcx-flow-graph",
      ]),
      summary: "AGENTS and runbook must tell a new window how to recover state",
    },
    {
      id: "micro_change_planner_keeps_master_lane",
      ok: includesAll(changeImpact, [
        "PATH_RULES",
        "recommendedFastCommands",
        "headTailRequired",
        "lcx-mind-model",
      ]),
      summary: "micro changes must still map into a master lane and proof set",
    },
    mindModel,
    flowGraph,
    {
      id: "local_operator_latest_is_readable",
      ok:
        latestState !== undefined &&
        latestState.boundary === "dev_local_observability_only" &&
        nestedBoolean(latestState, "liveTouched") === false &&
        nestedBoolean(latestState, "providerConfigTouched") === false &&
        nestedBoolean(latestState, "protectedMemoryTouched") === false,
      summary: "local operator latest state must be readable and boundary-clean",
      evidence: latestState
        ? {
            checkedAt: latestState.checkedAt,
            ok: latestState.ok,
            boundary: latestState.boundary,
            hasMindModel: latestMindModel !== undefined,
            hasFlowGraph: latestFlowGraph !== undefined,
            hasContextRecovery: latestContextRecovery !== undefined,
          }
        : { path: LOCAL_OPERATOR_LATEST, missing: true },
    },
    {
      id: "local_operator_latest_is_fresh",
      ok:
        latestState !== undefined &&
        latestOperatorAgeMs !== undefined &&
        latestOperatorAgeMs >= 0 &&
        latestOperatorAgeMs <= MAX_OPERATOR_STATE_AGE_MS,
      summary: "local operator latest state must be fresh enough for compressed recovery",
      evidence: latestState
        ? {
            checkedAt: latestState.checkedAt,
            operatorStateAgeMs: latestOperatorAgeMs,
            maxOperatorStateAgeMs: MAX_OPERATOR_STATE_AGE_MS,
          }
        : { path: LOCAL_OPERATOR_LATEST, missing: true },
    },
    {
      id: "local_operator_latest_matches_current_workflow_surface",
      ok: latestState === undefined || operatorFlowMatchesCurrent,
      summary:
        "local operator latest flow graph must match the current worktree flow graph, not only be fresh by timestamp",
      evidence: latestState
        ? {
            checkedAt: latestState.checkedAt,
            latestFlowGraph: {
              scenarios: latestFlowGraph?.scenarios,
              nodes: latestFlowGraph?.nodes,
              filters: latestFlowGraph?.filters,
            },
            currentFlowGraph: {
              scenarios: currentFlowEvidence?.scenarios,
              nodes: currentFlowEvidence?.nodes,
              filters: currentFlowEvidence?.filters,
            },
          }
        : { path: LOCAL_OPERATOR_LATEST, missing: true },
    },
    {
      id: "local_operator_digest_contains_mind_model",
      ok:
        latestState === undefined ||
        (latestMindModel?.boundary === "dev_mind_model_only" &&
          typeof latestMindModel.passed === "number" &&
          typeof latestMindModel.failed === "number" &&
          ((latestFlowGraph?.boundary === "dev_flow_graph_only" &&
            typeof latestFlowGraph.passed === "number" &&
            typeof latestFlowGraph.failed === "number") ||
            flowGraph.ok) &&
          latestContextRecovery?.boundary === "dev_context_recovery_exam_only"),
      summary: "operator digest should expose mind-model, flow-graph, and context-recovery status",
      evidence: {
        mindModel: latestMindModel,
        flowGraph: latestFlowGraph,
        contextRecovery: latestContextRecovery,
      },
    },
    {
      id: "fresh_training_plan_decision_visible_after_recovery",
      ok:
        currentTrainingPlan.ok &&
        currentTrainingPlan.payload?.boundary === "dev_local_brain_training_plan_only" &&
        currentTrainingDecisionIds.length > 0,
      summary:
        "compressed recovery must use fresh local-brain-training-plan for volatile training decisions, not only operator latest",
      evidence: {
        currentTrainingPlan: compactTrainingPlan(currentTrainingPlan.payload),
        operatorTrainingPlanSnapshot: compactTrainingPlan(latestTrainingPlan),
        operatorDecisionIdsMatchCurrent: operatorTrainingPlanMatchesCurrent,
        error: currentTrainingPlan.error,
      },
    },
  ];

  const warnings: RecoveryWarning[] = [];
  if (!operatorTrainingPlanMatchesCurrent) {
    warnings.push({
      id: "operator_training_plan_snapshot_differs_from_current",
      summary:
        "local operator latest training-plan snapshot is not authoritative for volatile decisions; use fresh local-brain-training-plan",
      evidence: {
        operatorTrainingPlanSnapshot: compactTrainingPlan(latestTrainingPlan),
        currentTrainingPlan: compactTrainingPlan(currentTrainingPlan.payload),
      },
    });
  }
  if (!operatorTrainingVolatileMatchesCurrent) {
    warnings.push({
      id: "operator_training_state_snapshot_differs_from_current",
      summary:
        "local operator latest training runtime snapshot differs from fresh process/eval truth; use fresh local-brain-training-plan before acting",
      evidence: {
        operatorTrainingSnapshot,
        currentTrainingVolatileSnapshot,
      },
    });
  }

  const failed = checks.filter((check) => !check.ok);
  const result = {
    ok: failed.length === 0,
    boundary: "dev_context_recovery_exam_only",
    checkedAt: new Date().toISOString(),
    compressedContextRecovered: failed.length === 0,
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      total: checks.length,
    },
    requiredRecoveryCommands: [
      "sed -n '1,220p' ops/local-brain/README.md",
      "node --import tsx scripts/dev/lcx-mind-model.ts --json",
      "node --import tsx scripts/dev/lcx-flow-graph.ts --json",
      "node --import tsx scripts/dev/lcx-system-doctor.ts --json",
      "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      "test -f /Users/liuchengxu/.openclaw/workspace/state/lcx-local-operator-latest.json && sed -n '1,220p' /Users/liuchengxu/.openclaw/workspace/state/lcx-local-operator-latest.json",
    ],
    checks,
    actionableFailures: failed.map((check) => `${check.id}: ${check.summary}`),
    actionableWarnings: warnings.map((warning) => `${warning.id}: ${warning.summary}`),
    warnings,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `lcx context recovery ${result.ok ? "ok" : "failed"}`,
          `passed=${result.summary.passed} failed=${result.summary.failed} total=${result.summary.total}`,
          ...failed.map((check) => `- ${check.id}: ${check.summary}`),
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
