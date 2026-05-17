import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildWorkspaceSkillSnapshot } from "../../src/agents/skills.ts";
import { resolveSkillAutoCue } from "../../src/auto-reply/reply/skill-autocue.ts";
import { loadConfig } from "../../src/config/config.ts";
import { LOCAL_OPERATOR_LATEST_PATH } from "./lcx-local-paths.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const LOCAL_OPERATOR_LATEST = LOCAL_OPERATOR_LATEST_PATH;
const MAX_OPERATOR_STATE_AGE_MS = 3 * 60 * 60 * 1000;
const REQUIRED_RUNTIME_SKILLS = [
  "agent-brain-eval",
  "cli-anything-harvester",
  "lcx-qwen-training-operator",
  "lcx-workflow-waterflow-auditor",
  "finance-learning-researcher",
  "lark-live-loop-debugger",
  "lark-post-migration-probe",
  "agent-runtime-drift-auditor",
  "lcx-baseline-hardening",
  "lcx-evolution-loop",
  "l5-regression-batterer",
  "skill-harvester",
] as const;

const REQUIRED_AUTOCUE_PROBES = [
  {
    body: "香港大学 CLI-Anything 可以把本地软件 CLI 化吗，演示一下",
    expectedSkill: "cli-anything-harvester",
  },
  {
    body: "本地智能体真的会用这些skills吗，确保它能用会用真的用了",
    expectedSkill: "agent-brain-eval",
  },
  {
    body: "检查 qwen 训练 guard PID 和最新 adapter promotion truth",
    expectedSkill: "lcx-qwen-training-operator",
  },
  {
    body: "全系统水路和记忆沉淀一起审一遍",
    expectedSkill: "lcx-workflow-waterflow-auditor",
  },
] as const;

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
      "Usage: node --import tsx scripts/dev/lcx-context-recovery-exam.ts [--json] [--handoff]",
      "",
      "Read-only compressed-context recovery exam. It verifies a future Codex or Claude",
      "window can recover LCX Agent state from durable files instead of chat memory.",
      "",
      "--handoff prints or returns a compact new-window handoff snapshot using the same",
      "context-recovery owner; it is not a separate memory lane.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]) {
  const options = { json: false, handoff: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--handoff") {
      options.handoff = true;
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

function currentRuntimeSkillSnapshot() {
  try {
    const snapshot = buildWorkspaceSkillSnapshot(repoRoot, {
      config: loadConfig(),
    });
    const availableSkillNames = snapshot.skills.map((entry) => entry.name);
    const missing = REQUIRED_RUNTIME_SKILLS.filter(
      (skillName) => !availableSkillNames.includes(skillName),
    );
    const cueResults = REQUIRED_AUTOCUE_PROBES.map((probe) => {
      const cue = resolveSkillAutoCue({
        body: probe.body,
        availableSkillNames,
      });
      return {
        expectedSkill: probe.expectedSkill,
        selectedSkill: cue?.skillName,
        ok: cue?.skillName === probe.expectedSkill,
      };
    });
    return {
      ok: missing.length === 0 && cueResults.every((entry) => entry.ok),
      skillCount: availableSkillNames.length,
      missing,
      cueResults,
    };
  } catch (error) {
    return {
      ok: false,
      skillCount: 0,
      missing: [...REQUIRED_RUNTIME_SKILLS],
      cueResults: [],
      error: String(error),
    };
  }
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
  // The operator digest is a compressed recovery artifact, not the owner for volatile
  // eval progress. Treat training-plan as the realtime owner and only warn here when
  // stable operational fields drift.
  return (
    operatorActive === currentActive &&
    operatorSnapshot.latestGuardStart === currentSnapshot.latestGuardStart &&
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

async function currentChangeImpactSnapshot(): Promise<{
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-change-impact-plan.ts", "--json"],
      { cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    return { ok: true, payload: JSON.parse(stdout) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function currentModuleAbsorptionGateSnapshot(): Promise<{
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-module-learning-absorption-gate.ts", "--json"],
      { cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    return { ok: true, payload: JSON.parse(stdout) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function compactChangeImpact(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    ok: record.ok,
    boundary: record.boundary,
    changedFiles: record.changedFiles,
    affectedLanes: record.affectedLanes,
    unmatchedFiles: record.unmatchedFiles,
    recommendedFastCommands: record.recommendedFastCommands,
    escalation: record.escalation,
    liveTouched: record.liveTouched,
    providerConfigTouched: record.providerConfigTouched,
    protectedMemoryTouched: record.protectedMemoryTouched,
  };
}

function compactModuleAbsorptionGate(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const latestEval = record.latestEval as Record<string, unknown> | undefined;
  return {
    ok: record.ok,
    boundary: record.boundary,
    dateKey: record.dateKey,
    absorptionReady: record.absorptionReady,
    gateDecision: record.gateDecision,
    counts: record.counts,
    latestEval: latestEval
      ? {
          passed: latestEval.passed,
          total: latestEval.total,
          promotionReady: latestEval.promotionReady,
          failedCaseIds: latestEval.failedCaseIds,
          parseErrorCaseIds: latestEval.parseErrorCaseIds,
          parseRecoveredCaseIds: latestEval.parseRecoveredCaseIds,
        }
      : undefined,
    blockers: record.blockers,
    nextActions: record.nextActions,
    liveTouched: record.liveTouched,
    providerConfigTouched: record.providerConfigTouched,
    protectedMemoryTouched: record.protectedMemoryTouched,
    languageCorpusTouched: record.languageCorpusTouched,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function scalarText(value: unknown, fallback = "unknown"): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function buildNewWindowHandoffText(params: {
  result: {
    ok: boolean;
    checkedAt: string;
    compressedContextRecovered: boolean;
    summary: { passed: number; failed: number; total: number };
    actionableFailures: string[];
    actionableWarnings: string[];
    requiredRecoveryCommands: string[];
  };
  changeImpact?: ReturnType<typeof compactChangeImpact>;
  trainingPlan?: ReturnType<typeof compactTrainingPlan>;
  moduleAbsorption?: ReturnType<typeof compactModuleAbsorptionGate>;
  flowGraphEvidence?: Record<string, unknown>;
}): string {
  const changedFiles = stringArray(params.changeImpact?.changedFiles);
  const affectedLanes = stringArray(params.changeImpact?.affectedLanes);
  const unmatchedFiles = stringArray(params.changeImpact?.unmatchedFiles);
  const blockers = stringArray(params.moduleAbsorption?.blockers);
  const nextActions = stringArray(params.moduleAbsorption?.nextActions);
  const trainingDecisionIds = stringArray(
    (params.trainingPlan as Record<string, unknown> | undefined)?.decisionIds,
  );
  const latestEval = params.trainingPlan?.latestEval;
  const moduleLatestEval = params.moduleAbsorption?.latestEval;
  const lines = [
    "# LCX New-Window Handoff",
    "",
    `checkedAt=${params.result.checkedAt}`,
    `cwd=${repoRoot}`,
    `compressedContextRecovered=${params.result.compressedContextRecovered}`,
    `recoveryChecks=${params.result.summary.passed}/${params.result.summary.total}`,
    "",
    "## Boundaries",
    "- dev/local handoff only; not live-runtime-updated and not live-user-seen",
    "- liveTouched=false; providerConfigTouched=false; protectedMemoryTouched=false",
    "- do not start overlapping Qwen/MiniMax/MLX training; trust fresh local-brain-training-plan",
    "- do not touch memory/current-research-line.md or memory/unified-risk-view.md",
    "",
    "## Dirty Worktree",
    `changedFiles=${changedFiles.length}`,
    ...changedFiles.map((file) => `- ${file}`),
    `affectedLanes=${affectedLanes.join(",") || "none"}`,
    `unmatchedFiles=${unmatchedFiles.join(",") || "none"}`,
    "",
    "## Training Truth",
    "volatileOwner=local-brain-training-plan",
    "operatorLatestRole=compressed_digest_not_realtime_training_authority",
    `activeProcessCount=${scalarText(params.trainingPlan?.activeProcessCount)}`,
    `latestEval=${scalarText(latestEval?.passed)}/${scalarText(latestEval?.total)} promotionReady=${scalarText(latestEval?.promotionReady)}`,
    `latestEvalParseRecovered=${stringArray(latestEval?.parseRecoveredCaseIds).join(",") || "none"}`,
    `decisionIds=${trainingDecisionIds.join(",") || "none"}`,
    "",
    "## Module Learning Truth",
    `absorptionReady=${scalarText(params.moduleAbsorption?.absorptionReady)}`,
    `gateDecision=${scalarText(params.moduleAbsorption?.gateDecision)}`,
    `moduleGateLatestEval=${scalarText(moduleLatestEval?.passed)}/${scalarText(moduleLatestEval?.total)} promotionReady=${scalarText(moduleLatestEval?.promotionReady)}`,
    `blockers=${blockers.join(",") || "none"}`,
    `nextActions=${nextActions.join(" | ") || "none"}`,
    "",
    "## Architecture Truth",
    `flowGraphScenarios=${scalarText(params.flowGraphEvidence?.scenarios)}`,
    `flowGraphNodes=${scalarText(params.flowGraphEvidence?.nodes)}`,
    `flowGraphFilters=${scalarText(params.flowGraphEvidence?.filters)}`,
    `actionableFailures=${params.result.actionableFailures.join(" | ") || "none"}`,
    `actionableWarnings=${params.result.actionableWarnings.join(" | ") || "none"}`,
    "",
    "## Recovery Commands",
    ...params.result.requiredRecoveryCommands.map((command) => `- ${command}`),
  ];
  return `${lines.join("\n")}\n`;
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
  const [
    agents,
    runbook,
    changeImpactSource,
    latestState,
    mindModel,
    flowGraph,
    currentTrainingPlan,
  ] = await Promise.all([
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
  const runtimeSkillSnapshot = currentRuntimeSkillSnapshot();
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
      ok: includesAll(changeImpactSource, [
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
    {
      id: "runtime_lcx_operator_skills_available_and_autocued",
      ok: runtimeSkillSnapshot.ok,
      summary:
        "local runtime skill snapshot must include core LCX operator skills and deterministic natural-language autocues",
      evidence: runtimeSkillSnapshot,
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
  const informationalWarnings = warnings.filter((warning) =>
    warning.id.startsWith("operator_training_"),
  );
  const actionableWarnings = warnings.filter(
    (warning) => !warning.id.startsWith("operator_training_"),
  );
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
    actionableWarnings: actionableWarnings.map((warning) => `${warning.id}: ${warning.summary}`),
    informationalWarnings: informationalWarnings.map(
      (warning) => `${warning.id}: ${warning.summary}`,
    ),
    warnings,
    volatileTruthOwner: {
      training: "local-brain-training-plan",
      operatorLatestRole: "compressed_digest_not_realtime_training_authority",
      currentTrainingPlanUsed: currentTrainingPlan.ok,
    },
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
  const handoffSources = options.handoff
    ? await Promise.all([currentChangeImpactSnapshot(), currentModuleAbsorptionGateSnapshot()])
    : undefined;
  const handoffChangeImpact = handoffSources
    ? compactChangeImpact(handoffSources[0].payload)
    : undefined;
  const moduleAbsorption = handoffSources
    ? compactModuleAbsorptionGate(handoffSources[1].payload)
    : undefined;
  const handoffForNewWindow = options.handoff
    ? {
        boundary: "dev_context_recovery_handoff_only",
        owner: "lcx-context-recovery-exam",
        purpose:
          "compact current-state snapshot for future Codex windows; reuses context recovery instead of creating a parallel memory lane",
        changeImpact: handoffChangeImpact,
        trainingPlan: compactTrainingPlan(currentTrainingPlan.payload),
        moduleAbsorption,
        text: buildNewWindowHandoffText({
          result,
          changeImpact: handoffChangeImpact,
          trainingPlan: compactTrainingPlan(currentTrainingPlan.payload),
          moduleAbsorption,
          flowGraphEvidence: currentFlowEvidence,
        }),
        errors: {
          changeImpact: handoffSources?.[0].error,
          moduleAbsorption: handoffSources?.[1].error,
        },
      }
    : undefined;
  const outputResult = options.handoff ? { ...result, handoffForNewWindow } : result;

  process.stdout.write(
    options.json
      ? `${JSON.stringify(outputResult, null, 2)}\n`
      : options.handoff
        ? (handoffForNewWindow?.text ?? "")
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
