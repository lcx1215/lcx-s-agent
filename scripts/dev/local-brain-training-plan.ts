import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.ts";
import {
  DEFAULT_GUARD_LOG_PATH,
  DEFAULT_WORKSPACE_DIR,
  DEFAULT_WORKSPACE_LOG_DIR,
} from "./lcx-local-paths.ts";

type CliOptions = {
  guardLogPath: string;
  quotaLogPath?: string;
  worktree?: string;
  workspaceDir?: string;
  json: boolean;
  processCheck: boolean;
};

type JsonRecord = Record<string, unknown>;

type EvalSnapshot = {
  at: string;
  event: string;
  name: string;
  adapterPath?: string;
  passed: number;
  total: number;
  passRate: number;
  promotionReady: boolean;
  failedCaseIds: string[];
  parseErrorCaseIds: string[];
  parseRecoveredCaseIds: string[];
  parseErrorSamples: string[];
};

type TeacherSnapshot = {
  at: string;
  event: string;
  round?: number;
  acceptedCandidates: number;
  failures: number;
  failureErrors: string[];
  providerSkippedPromptIds: string[];
  failureFocusPrompts?: number;
};

type QuotaStatusSnapshot = {
  at: string;
  event: string;
  active: boolean;
  stopReason?: string;
  targetCalls?: number;
  attempted?: number;
  completedRounds?: number;
  finalBatchLimit?: number;
  finalConcurrency?: number;
};

type ActiveTrainingProcess = {
  pid?: number;
  ppid?: number;
  elapsed?: string;
  command: string;
  role: "guard" | "saturator" | "teacher_batch" | "local_brain_eval" | "mlx" | "other";
};

type ModuleLearningReviewSnapshot = {
  ok?: unknown;
  boundary?: unknown;
  updated?: unknown;
  counts?: Record<string, unknown>;
  weakModuleLearning?: unknown[];
  invalidReceipts?: unknown[];
  separationContract?: unknown;
};

type TrainingDecision = {
  id: string;
  lane: string;
  severity: "info" | "P3" | "P2" | "P1" | "P0";
  action: string;
  reason: string;
  codexRepairEligible: boolean;
  nextCommand?: string;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_REPO_CWD = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_WORKTREE = process.env.LCX_REPO_WORKTREE ?? SCRIPT_REPO_CWD;
const quoteShellArg = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
const normalizeWorktree = (value?: string): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? path.resolve(trimmed) : SCRIPT_REPO_CWD;
};
const normalizeWorkspaceDir = (value?: string): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? path.resolve(trimmed) : DEFAULT_WORKSPACE_DIR;
};
const buildRepairLockCommand = (worktree: string): string =>
  `node --import tsx scripts/dev/lcx-automation-repair-lock.ts --mode acquire --lane local-brain-training-plan --worktree ${quoteShellArg(worktree)} --json`;
const buildMediumTrainingCommand = (logPath: string): string =>
  `node --import tsx scripts/dev/minimax-brain-training-guard.ts --duration-minutes 285 --batch-limit 20 --teacher-profile minimax-plus-brain --teacher-duration-minutes 12 --teacher-concurrency 6 --teacher-sidecar --teacher-sidecar-max-calls 900 --teacher-sidecar-batch-limit 36 --teacher-sidecar-concurrency 8 --train-every 2 --eval-every 1 --train-iters 40 --load-max 100 --train-load-max 12 --log ${quoteShellArg(logPath)}`;

const execFileAsync = promisify(execFile);

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/local-brain-training-plan.ts [--json]",
      "",
      "Reads LCX local-brain guard/quota logs and emits one unified training",
      "plan for automations: continue training, feed failure-focus curriculum,",
      "run promotion audit, or enter Codex auto-repair mode.",
      "",
      "Options:",
      "  --guard-log PATH  default ~/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl",
      "  --quota-log PATH  default latest minimax-quota-brain-saturator-*.jsonl",
      "  --no-process-check  skip ps-based active process detection",
      "  --worktree PATH  default script directory's repo root",
      "  --workspace PATH  default ~/.openclaw/workspace for local learning receipts",
      "  --json            print JSON, default true",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    guardLogPath: DEFAULT_GUARD_LOG_PATH,
    worktree: DEFAULT_WORKTREE,
    json: true,
    processCheck: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--guard-log") {
      options.guardLogPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--quota-log") {
      options.quotaLogPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--worktree") {
      options.worktree = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--workspace" || arg === "--workspace-dir") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--no-process-check") {
      options.processCheck = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function parseJsonLine(line: string): JsonRecord | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonl(logPath: string | undefined): Promise<JsonRecord[]> {
  if (!logPath) {
    return [];
  }
  const raw = await fs.readFile(logPath, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((entry): entry is JsonRecord => Boolean(entry));
}

function eventTime(event: JsonRecord | undefined): string {
  return typeof event?.at === "string" ? event.at : "";
}

function latestEvent(
  events: JsonRecord[],
  predicate: (event: JsonRecord) => boolean,
): JsonRecord | undefined {
  return events
    .filter(predicate)
    .toSorted((left, right) => eventTime(right).localeCompare(eventTime(left)))[0];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function eventName(event: JsonRecord): string {
  return typeof event.name === "string" ? event.name : "";
}

function isEvalEvent(event: JsonRecord): boolean {
  return (
    (event.event === "step_ok" || event.event === "step_non_passing") &&
    ["stable_hardened_eval", "training_seed_hardened_eval", "candidate_hardened_eval"].includes(
      eventName(event),
    )
  );
}

function evalSnapshotFromEvent(event: JsonRecord): EvalSnapshot | undefined {
  if (!isEvalEvent(event)) {
    return undefined;
  }
  const result = event.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const resultRecord = result as JsonRecord;
  const summary = resultRecord.summary;
  if (!summary || typeof summary !== "object") {
    return undefined;
  }
  const summaryRecord = summary as JsonRecord;
  const passed = typeof summaryRecord.passed === "number" ? summaryRecord.passed : 0;
  const total = typeof summaryRecord.total === "number" ? summaryRecord.total : 0;
  const failedCaseIds = asStringArray(summaryRecord.failedCaseIds);
  const parseErrorCaseIds = asStringArray(summaryRecord.parseErrorCaseIds);
  const parseRecoveredCaseIds = asStringArray(summaryRecord.parseRecoveredCaseIds);
  const parseErrorSamples = Array.isArray(resultRecord.cases)
    ? resultRecord.cases
        .map((entry) =>
          entry && typeof entry === "object"
            ? (entry as { parseError?: unknown }).parseError
            : undefined,
        )
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 5)
    : [];
  return {
    at: eventTime(event),
    event: String(event.event),
    name: eventName(event),
    adapterPath:
      typeof resultRecord.adapterPath === "string" ? resultRecord.adapterPath : undefined,
    passed,
    total,
    passRate:
      typeof summaryRecord.passRate === "number"
        ? summaryRecord.passRate
        : total > 0
          ? passed / total
          : 0,
    promotionReady: summaryRecord.promotionReady === true && event.event === "step_ok",
    failedCaseIds,
    parseErrorCaseIds,
    parseRecoveredCaseIds,
    parseErrorSamples,
  };
}

function latestEvalSnapshot(events: JsonRecord[]): EvalSnapshot | undefined {
  return events
    .map(evalSnapshotFromEvent)
    .filter((entry): entry is EvalSnapshot => Boolean(entry))
    .toSorted((left, right) => right.at.localeCompare(left.at))[0];
}

function latestPassingEvalSnapshot(events: JsonRecord[]): EvalSnapshot | undefined {
  return events
    .map(evalSnapshotFromEvent)
    .filter((entry): entry is EvalSnapshot => Boolean(entry?.promotionReady))
    .toSorted((left, right) => right.at.localeCompare(left.at))[0];
}

function datasetSummary(event: JsonRecord | undefined): JsonRecord | undefined {
  const result = event?.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  return result as JsonRecord;
}

function trainSliceSummary(event: JsonRecord | undefined): JsonRecord | undefined {
  const result = event?.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as JsonRecord;
  return {
    at: eventTime(event),
    sourceDataDir: record.sourceDataDir,
    outDir: record.outDir,
    policy: record.policy,
    counts: record.counts,
    notTouched: record.notTouched,
  };
}

async function latestQuotaLogPath(): Promise<string | undefined> {
  const entries = await fs.readdir(DEFAULT_WORKSPACE_LOG_DIR).catch(() => []);
  return entries
    .filter((entry) => /^minimax-quota-brain-saturator-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry))
    .map((entry) => path.join(DEFAULT_WORKSPACE_LOG_DIR, entry))
    .toSorted()
    .at(-1);
}

function teacherSnapshotFromEvent(event: JsonRecord): TeacherSnapshot | undefined {
  if (
    event.name !== "minimax_teacher_batch" &&
    event.event !== "failure_curriculum_prompts_selected"
  ) {
    return undefined;
  }
  if (event.event === "failure_curriculum_prompts_selected") {
    return {
      at: eventTime(event),
      event: String(event.event),
      round: typeof event.round === "number" ? event.round : undefined,
      acceptedCandidates: 0,
      failures: 0,
      failureErrors: [],
      providerSkippedPromptIds: [],
      failureFocusPrompts:
        typeof event.failureFocusPrompts === "number" ? event.failureFocusPrompts : undefined,
    };
  }
  const result = event.result;
  const resultRecord = result && typeof result === "object" ? (result as JsonRecord) : {};
  const failures = Array.isArray(resultRecord.failures) ? resultRecord.failures : [];
  return {
    at: eventTime(event),
    event: String(event.event),
    round: typeof event.round === "number" ? event.round : undefined,
    acceptedCandidates:
      typeof resultRecord.acceptedCandidates === "number" ? resultRecord.acceptedCandidates : 0,
    failures: failures.length,
    failureErrors: failures
      .map((failure) =>
        failure && typeof failure === "object" ? (failure as { error?: unknown }).error : undefined,
      )
      .filter((entry): entry is string => typeof entry === "string"),
    providerSkippedPromptIds: asStringArray(resultRecord.providerSkippedPromptIds),
  };
}

function latestTeacherSnapshot(events: JsonRecord[]): TeacherSnapshot | undefined {
  return events
    .map(teacherSnapshotFromEvent)
    .filter((entry): entry is TeacherSnapshot => Boolean(entry))
    .toSorted((left, right) => right.at.localeCompare(left.at))[0];
}

function quotaStatusSnapshotFromEvent(event: JsonRecord): QuotaStatusSnapshot | undefined {
  if (event.event === "quota_saturator_start") {
    const plan = event.plan && typeof event.plan === "object" ? (event.plan as JsonRecord) : {};
    return {
      at: eventTime(event),
      event: String(event.event),
      active: true,
      targetCalls: typeof plan.targetCalls === "number" ? plan.targetCalls : undefined,
    };
  }
  if (event.event === "quota_saturator_complete") {
    return {
      at: eventTime(event),
      event: String(event.event),
      active: false,
      stopReason: typeof event.stopReason === "string" ? event.stopReason : undefined,
      attempted: typeof event.attempted === "number" ? event.attempted : undefined,
      completedRounds:
        typeof event.completedRounds === "number" ? event.completedRounds : undefined,
      finalBatchLimit:
        typeof event.finalBatchLimit === "number" ? event.finalBatchLimit : undefined,
      finalConcurrency:
        typeof event.finalConcurrency === "number" ? event.finalConcurrency : undefined,
    };
  }
  return undefined;
}

function latestQuotaStatusSnapshot(events: JsonRecord[]): QuotaStatusSnapshot | undefined {
  return events
    .map(quotaStatusSnapshotFromEvent)
    .filter((entry): entry is QuotaStatusSnapshot => Boolean(entry))
    .toSorted((left, right) => right.at.localeCompare(left.at))[0];
}

function activeTrainingRole(command: string): ActiveTrainingProcess["role"] {
  if (command.includes("minimax-quota-brain-saturator")) {
    return "saturator";
  }
  if (command.includes("minimax-brain-teacher-batch")) {
    return "teacher_batch";
  }
  if (command.includes("minimax-brain-training-guard")) {
    return "guard";
  }
  if (command.includes("local-brain-distill-eval")) {
    return "local_brain_eval";
  }
  if (command.includes("mlx_lm")) {
    return "mlx";
  }
  return "other";
}

async function activeTrainingProcesses(enabled: boolean): Promise<ActiveTrainingProcess[]> {
  if (!enabled) {
    return [];
  }
  const result = await execFileAsync("ps", ["-ax", "-o", "pid=,ppid=,etime=,command="], {
    maxBuffer: 1024 * 1024,
  }).catch(() => ({ stdout: "" }));
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) =>
      /minimax-brain-training-guard|local-brain-distill-eval|minimax-quota-brain-saturator|minimax-brain-teacher-batch|mlx_lm generate/u.test(
        line,
      ),
    )
    .filter((line) => !line.includes("--resolve-current-adapter"))
    .filter((line) => !line.includes("rg "))
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
      if (match) {
        const command = match[4];
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          elapsed: match[3],
          command,
          role: activeTrainingRole(command),
        };
      }
      const command = line.trim();
      return { command, role: activeTrainingRole(command) };
    });
}

function activeHeavyEvalSummary(activeProcesses: ActiveTrainingProcess[]) {
  const guardPids = new Set(
    activeProcesses
      .filter((process) => process.role === "guard" && typeof process.pid === "number")
      .map((process) => process.pid as number),
  );
  const localBrainEvalCount = activeProcesses.filter(
    (process) => process.role === "local_brain_eval",
  ).length;
  const externalLocalBrainEvalCount = activeProcesses.filter(
    (process) =>
      process.role === "local_brain_eval" &&
      (typeof process.ppid !== "number" || !guardPids.has(process.ppid)),
  ).length;
  const mlxCount = activeProcesses.filter((process) => process.role === "mlx").length;
  const guardActive = guardPids.size > 0;
  return {
    counts: {
      localBrainEval: localBrainEvalCount,
      externalLocalBrainEval: externalLocalBrainEvalCount,
      mlx: mlxCount,
    },
    overlappingHeavyEval:
      guardActive && (localBrainEvalCount > 1 || mlxCount > 1 || externalLocalBrainEvalCount > 0),
  };
}

function hasOutputContractSignals(
  snapshot: EvalSnapshot | undefined,
  guardFailure?: JsonRecord,
): boolean {
  if ((snapshot?.parseErrorCaseIds.length ?? 0) > 0) {
    return true;
  }
  const haystack = [
    ...(snapshot?.parseErrorCaseIds ?? []),
    ...(snapshot?.parseErrorSamples ?? []),
    typeof guardFailure?.error === "string" ? guardFailure.error : "",
  ].join("\n");
  return /parseError|no JSON object|Unexpected|<think>|finance_framework_|missing .*JSON|JSON at position/iu.test(
    haystack,
  );
}

function reasonText(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function evalNonPromotionReason(snapshot: EvalSnapshot): string {
  const reasons = [
    snapshot.failedCaseIds.length > 0 ? `failed=${snapshot.failedCaseIds.join(",")}` : undefined,
    snapshot.parseErrorCaseIds.length > 0
      ? `parseErrors=${snapshot.parseErrorCaseIds.join(",")}`
      : undefined,
    snapshot.parseRecoveredCaseIds.length > 0
      ? `parseRecovered=${snapshot.parseRecoveredCaseIds.join(",")}`
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return `Latest ${snapshot.name} passed ${snapshot.passed}/${snapshot.total}; ${
    reasons.join("; ") || "promotionReady=false without named failed or parse-recovered cases"
  }.`;
}

function buildDecisions(params: {
  activeProcesses: ActiveTrainingProcess[];
  overlappingHeavyEval: boolean;
  latestGuardStart?: JsonRecord;
  latestGuardFailure?: JsonRecord;
  latestEval?: EvalSnapshot;
  latestTeacher?: TeacherSnapshot;
  latestQuotaStatus?: QuotaStatusSnapshot;
  moduleLearningReview?: ModuleLearningReviewSnapshot;
  guardLogPath: string;
  worktree: string;
}): TrainingDecision[] {
  const decisions: TrainingDecision[] = [];
  const active = params.activeProcesses.length > 0;
  decisions.push({
    id: active ? "training_already_active" : "training_not_active",
    lane: "training",
    severity: active ? "info" : "P2",
    action: active ? "do_not_start_overlapping_guard" : "start_medium_training_guard",
    reason: active
      ? "A local-brain guard or child process is already active."
      : "No active local-brain training process was detected.",
    codexRepairEligible: false,
    nextCommand: active ? undefined : buildMediumTrainingCommand(params.guardLogPath),
  });

  if (params.overlappingHeavyEval) {
    decisions.push({
      id: "overlapping_heavy_eval_detected",
      lane: "training_guard",
      severity: "P1",
      action: "hold_new_training_and_debug_overlap",
      reason:
        "local-brain-training-plan detected overlapping heavy local-brain eval while the guard is active.",
      codexRepairEligible: false,
    });
  }

  const guardStartAt = eventTime(params.latestGuardStart);
  const failedAfterStart =
    eventTime(params.latestGuardFailure) &&
    guardStartAt &&
    eventTime(params.latestGuardFailure) > guardStartAt;
  const latestEvalIsAfterStart =
    Boolean(params.latestEval?.at) && (!guardStartAt || params.latestEval!.at >= guardStartAt);
  if (failedAfterStart) {
    decisions.push({
      id: "guard_failed_after_latest_start",
      lane: "training_guard",
      severity: "P1",
      action: "enter_codex_auto_repair_if_lock_available",
      reason: reasonText(
        params.latestGuardFailure?.error,
        "latest guard_failed is newer than start",
      ),
      codexRepairEligible: true,
      nextCommand: buildRepairLockCommand(params.worktree),
    });
  }

  if (params.latestEval && !latestEvalIsAfterStart) {
    decisions.push({
      id: "eval_pending_after_latest_start",
      lane: "training",
      severity: "info",
      action: "wait_for_current_hardened_eval_before_repairing",
      reason: `Latest eval at ${params.latestEval.at} is older than latest guard_start at ${guardStartAt}.`,
      codexRepairEligible: false,
    });
  }

  if (params.latestEval && latestEvalIsAfterStart && !params.latestEval.promotionReady) {
    decisions.push({
      id: "eval_not_promotion_ready",
      lane: "training",
      severity: "P2",
      action: "continue_failure_focus_teacher_and_hold_promotion",
      reason: evalNonPromotionReason(params.latestEval),
      codexRepairEligible: false,
    });
  }

  if (
    hasOutputContractSignals(
      latestEvalIsAfterStart ? params.latestEval : undefined,
      failedAfterStart ? params.latestGuardFailure : undefined,
    )
  ) {
    decisions.push({
      id: "output_contract_or_parser_failure",
      lane: "dev_acceptance",
      severity: "P2",
      action: "enter_codex_auto_repair_if_repeated",
      reason:
        "Eval/guard evidence contains JSON, parser, think-block, or invalid module-id output-contract signals.",
      codexRepairEligible: true,
      nextCommand: buildRepairLockCommand(params.worktree),
    });
  }

  if (params.latestTeacher && params.latestTeacher.failures > 0) {
    decisions.push({
      id: "teacher_sample_quality_failure",
      lane: "teacher_quality",
      severity: "P2",
      action: "repair_teacher_filter_or_prompt_if_pattern_repeats",
      reason:
        params.latestTeacher.failureErrors.join("; ") || "Latest teacher batch reported failures.",
      codexRepairEligible: true,
      nextCommand: buildRepairLockCommand(params.worktree),
    });
  }

  if (
    params.latestQuotaStatus?.event === "quota_saturator_complete" &&
    params.latestQuotaStatus.stopReason === "target_calls_reached"
  ) {
    decisions.push({
      id: "teacher_quota_target_reached",
      lane: "teacher_quality",
      severity: "info",
      action: "do_not_treat_minimax_idle_as_provider_failure",
      reason: `MiniMax sidecar completed normally after ${params.latestQuotaStatus.attempted ?? "unknown"} attempted call(s).`,
      codexRepairEligible: false,
    });
  }

  const moduleLearningCounts = params.moduleLearningReview?.counts ?? {};
  const weakModuleLearning =
    typeof moduleLearningCounts.weakModuleLearning === "number"
      ? moduleLearningCounts.weakModuleLearning
      : 0;
  const boundaryViolations =
    typeof moduleLearningCounts.boundaryViolations === "number"
      ? moduleLearningCounts.boundaryViolations
      : 0;
  if (weakModuleLearning > 0) {
    decisions.push({
      id: "module_learning_incomplete_evidence",
      lane: "module_learning",
      severity: "P2",
      action: "complete_module_learning_evidence_before_claiming_absorption",
      reason: `${weakModuleLearning} module-learning receipt(s) are not eval_absorbed yet.`,
      codexRepairEligible: boundaryViolations > 0,
      nextCommand: boundaryViolations > 0 ? buildRepairLockCommand(params.worktree) : undefined,
    });
  }

  if (params.latestEval?.promotionReady && latestEvalIsAfterStart) {
    decisions.push({
      id: "promotion_candidate_ready",
      lane: "promotion_audit",
      severity: "info",
      action: "run_promotion_audit_before_claiming_stable",
      reason: `Latest ${params.latestEval.name} is promotionReady=true.`,
      codexRepairEligible: false,
    });
  }

  return decisions;
}

async function moduleLearningReviewSnapshot(
  workspaceDir: string,
): Promise<ModuleLearningReviewSnapshot> {
  const tool = createModuleLearningPipelineReviewTool({ workspaceDir });
  const result = await tool.execute("local-brain-training-plan-module-learning-review", {
    writeReview: false,
  });
  const details = result.details as ModuleLearningReviewSnapshot;
  return {
    ok: details.ok,
    boundary: details.boundary,
    updated: details.updated,
    counts: details.counts,
    weakModuleLearning: Array.isArray(details.weakModuleLearning)
      ? details.weakModuleLearning.slice(0, 5)
      : [],
    invalidReceipts: Array.isArray(details.invalidReceipts)
      ? details.invalidReceipts.slice(0, 5)
      : [],
    separationContract: details.separationContract,
  };
}

export async function buildLocalBrainTrainingPlan(options: CliOptions): Promise<JsonRecord> {
  const guardEvents = await readJsonl(options.guardLogPath);
  const quotaLogPath = options.quotaLogPath ?? (await latestQuotaLogPath());
  const quotaEvents = await readJsonl(quotaLogPath);
  const worktree = normalizeWorktree(options.worktree);
  const workspaceDir = normalizeWorkspaceDir(options.workspaceDir);
  const activeProcesses = await activeTrainingProcesses(options.processCheck);
  const latestGuardStart = latestEvent(guardEvents, (event) => event.event === "guard_start");
  const latestGuardFailure = latestEvent(guardEvents, (event) => event.event === "guard_failed");
  const latestDataset = latestEvent(
    guardEvents,
    (event) => event.name === "dataset" && event.event === "step_ok",
  );
  const latestSmoke = latestEvent(
    guardEvents,
    (event) => event.name === "smoke" && event.event === "step_ok",
  );
  const latestTrainSlice = latestEvent(
    guardEvents,
    (event) => event.name === "train_slice" && event.event === "step_ok",
  );
  const latestEval = latestEvalSnapshot(guardEvents);
  const latestPassingEval = latestPassingEvalSnapshot(guardEvents);
  const latestStableEval = latestEvalSnapshot(
    guardEvents.filter((event) => event.name === "stable_hardened_eval"),
  );
  const latestTrainingSeedEval = latestEvalSnapshot(
    guardEvents.filter((event) => event.name === "training_seed_hardened_eval"),
  );
  const latestCandidateEval = latestEvalSnapshot(
    guardEvents.filter((event) => event.name === "candidate_hardened_eval"),
  );
  const latestPromotion = latestEvent(
    guardEvents,
    (event) => event.event === "adapter_promoted_for_guard_session",
  );
  const activeHeavyEval = activeHeavyEvalSummary(activeProcesses);
  const latestTeacher = latestTeacherSnapshot(quotaEvents);
  const latestQuotaStatus = latestQuotaStatusSnapshot(quotaEvents);
  const moduleLearningReview = await moduleLearningReviewSnapshot(workspaceDir);
  const decisions = buildDecisions({
    activeProcesses,
    overlappingHeavyEval: activeHeavyEval.overlappingHeavyEval,
    latestGuardStart,
    latestGuardFailure,
    latestEval,
    latestTeacher,
    latestQuotaStatus,
    moduleLearningReview,
    guardLogPath: options.guardLogPath,
    worktree,
  });
  const repairDecisions = decisions.filter((decision) => decision.codexRepairEligible);
  return {
    ok: true,
    boundary: "dev_local_brain_training_plan_only",
    planVersion: "local_brain_training_plan_v1",
    cwd: worktree,
    workspaceDir,
    guardLogPath: options.guardLogPath,
    quotaLogPath: quotaLogPath ?? "",
    activeProcesses,
    activeHeavyEvalCounts: activeHeavyEval.counts,
    overlappingHeavyEval: activeHeavyEval.overlappingHeavyEval,
    latestGuardStartAt: eventTime(latestGuardStart),
    latestDataset: datasetSummary(latestDataset),
    latestTrainSlice: trainSliceSummary(latestTrainSlice),
    latestSmokeAt: eventTime(latestSmoke),
    latestEval,
    latestPassingEval,
    latestStableEval,
    latestTrainingSeedEval,
    latestCandidateEval,
    latestPromotionAt: eventTime(latestPromotion),
    latestPromotedAdapter:
      typeof latestPromotion?.adapterPath === "string" ? latestPromotion.adapterPath : undefined,
    latestEvalIsCurrentForGuardStart:
      Boolean(latestEval?.at) &&
      (!eventTime(latestGuardStart) || latestEval!.at >= eventTime(latestGuardStart)),
    latestTeacher,
    latestQuotaStatus,
    moduleLearningReview,
    decisions,
    codexAutoRepair: {
      eligible: repairDecisions.length > 0,
      repairDecisionIds: repairDecisions.map((decision) => decision.id),
      lockCommand: buildRepairLockCommand(worktree),
      allowedScope:
        "dev-only local-brain training/eval/teacher/doctor scripts, focused tests, and dev-only receipts",
      forbiddenScope:
        "live sender, provider config, protected memory, formal language corpus, finance doctrine, secrets, destructive git, broad architecture",
    },
    nextAutomationOrder: [
      "minimax-brain-training-guard",
      "teacher-quality-gate",
      "brain-health-digest",
      "module-learning-pipeline-review",
      "local-brain-promotion-audit",
      "dev-full-loop-acceptance",
      "paper-learning-upgrade-reminder",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const payload = await buildLocalBrainTrainingPlan(options);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
