import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.ts";
import { buildLearningSedimentationBridge } from "./lcx-learning-sedimentation-bridge.ts";
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

type EvalTimeoutSnapshot = {
  at: string;
  name: string;
  adapterPath?: string;
  timeoutReason?: string;
  timeoutMs?: number;
  durationMs?: number;
  failedCaseIds: string[];
};

type QwenCapabilityConsolidationSnapshot = {
  boundary: "dev_qwen_capability_consolidation_only";
  runtimeAdapterPolicy: "single_clean_adapter_only_no_dirty_ensemble";
  adapterLadderPolicy: "champion_challenger_harvest_into_next_single_adapter";
  capabilityIntegrationMode: "teacher_dataset_eval_promotion_into_one_clean_adapter";
  consolidationState:
    | "selected_clean_adapter"
    | "candidate_capabilities_not_yet_consolidated"
    | "awaiting_clean_adapter";
  selectedCleanAdapter?: string;
  selectedCleanEval?: Pick<
    EvalSnapshot,
    "at" | "name" | "adapterPath" | "passed" | "total" | "promotionReady"
  >;
  cleanCandidateAdapterCount: number;
  blockedCandidateAdapterCount: number;
  latestCleanCandidate?: EvalSnapshot;
  latestBlockedCandidate?: EvalSnapshot;
  blockedCapabilityFamilies: { caseId: string; count: number }[];
  adapterLadder: {
    champion?: {
      adapterPath?: string;
      eval?: Pick<
        EvalSnapshot,
        "at" | "name" | "adapterPath" | "passed" | "total" | "promotionReady"
      >;
      runtimeEligible: boolean;
    };
    latestCleanChallenger?: {
      adapterPath?: string;
      eval?: Pick<
        EvalSnapshot,
        "at" | "name" | "adapterPath" | "passed" | "total" | "promotionReady"
      >;
      promotionAuditRequired: boolean;
    };
    latestBlockedChallenger?: {
      adapterPath?: string;
      eval?: Pick<
        EvalSnapshot,
        "at" | "name" | "adapterPath" | "passed" | "total" | "promotionReady"
      >;
      runtimeEligible: false;
    };
  };
  capabilityHarvest: {
    boundary: "dev_blocked_challenger_harvest_only";
    harvestMode: "failed_or_parse_recovered_cases_to_teacher_curriculum";
    sourceBlockedAdapter?: string;
    harvestCaseIds: string[];
    nextTeacherFocusCaseIds: string[];
    notPromotionProof: true;
    requiredNextStep: string;
  };
  requiredAction:
    | "run_promotion_audit_for_latest_clean_candidate"
    | "continue_failure_focus_until_next_clean_unified_adapter"
    | "keep_selected_clean_adapter_and_continue_consolidation"
    | "wait_for_hardened_eval";
  notes: string[];
};

type ActiveGuardAdapterTruthSnapshot = {
  boundary: "dev_active_guard_adapter_truth_only";
  latestGuardStartAt?: string;
  guardCurrentAdapter?: string;
  guardTrainingSeedAdapter?: string;
  guardTrainingResumeAdapter?: string;
  selectedCleanAdapter?: string;
  latestPromotedAdapter?: string;
  latestPromotedAt?: string;
  latestPromotedAdapterStillClean: boolean | null;
  guardStartedAfterLatestPromotion: boolean;
  guardUsesSelectedCleanAdapter: boolean | null;
  guardUsesLatestPromotedAdapter: boolean | null;
  mismatchReasons: string[];
  action:
    | "guard_adapter_matches_selected_clean_adapter"
    | "wait_for_active_guard_then_restart_with_selected_clean_adapter"
    | "no_active_guard_adapter_to_compare";
};

export type QwenBaseModelMigrationSnapshot = {
  boundary: "dev_qwen_base_model_migration_plan_only";
  currentModel: "Qwen/Qwen3-0.6B";
  candidateModel: "Qwen/Qwen3-1.7B";
  candidateCachePath: string;
  candidateCached: boolean;
  candidateCacheBytes?: number;
  machineMemoryBytes?: number;
  activeTrainingProcessCount: number;
  activeHeavyEvalCounts: {
    localBrainEval: number;
    externalLocalBrainEval: number;
    mlx: number;
  };
  decision:
    | "blocked_training_active"
    | "candidate_not_cached"
    | "memory_too_small_for_candidate"
    | "ready_for_no_adapter_smoke";
  action: string;
  allowedNextCommand?: string;
  forbiddenWhileActive: string[];
  notes: string[];
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

export type ActiveTrainingProcess = {
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

type LearningSedimentationBridgeSnapshot = {
  ok?: unknown;
  boundary?: unknown;
  candidateCount?: unknown;
  sourceApplyReceiptFiles?: unknown;
  candidates?: unknown[];
  nextAction?: unknown;
  notPromoted?: unknown;
  liveTouched?: unknown;
  providerConfigTouched?: unknown;
  protectedMemoryTouched?: unknown;
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
const QWEN_MIGRATION_CURRENT_MODEL = "Qwen/Qwen3-0.6B" as const;
const QWEN_MIGRATION_CANDIDATE_MODEL = "Qwen/Qwen3-1.7B" as const;
const MIN_QWEN_1_7B_SMOKE_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;

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

function stringField(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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

function isEvalTimeoutEvent(event: JsonRecord): boolean {
  return (
    event.event === "step_timeout" &&
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

function evalTimeoutSnapshotFromEvent(event: JsonRecord): EvalTimeoutSnapshot | undefined {
  if (!isEvalTimeoutEvent(event)) {
    return undefined;
  }
  const result = event.result;
  const resultRecord = result && typeof result === "object" ? (result as JsonRecord) : {};
  const summary = resultRecord.summary;
  const summaryRecord = summary && typeof summary === "object" ? (summary as JsonRecord) : {};
  return {
    at: eventTime(event),
    name: eventName(event),
    adapterPath:
      typeof resultRecord.adapterPath === "string" ? resultRecord.adapterPath : undefined,
    timeoutReason:
      typeof resultRecord.timeoutReason === "string"
        ? resultRecord.timeoutReason
        : typeof event.timeoutReason === "string"
          ? event.timeoutReason
          : undefined,
    timeoutMs:
      typeof resultRecord.timeoutMs === "number"
        ? resultRecord.timeoutMs
        : typeof event.durationMs === "number"
          ? event.durationMs
          : undefined,
    durationMs:
      typeof resultRecord.durationMs === "number"
        ? resultRecord.durationMs
        : typeof event.durationMs === "number"
          ? event.durationMs
          : undefined,
    failedCaseIds: asStringArray(summaryRecord.failedCaseIds),
  };
}

function latestEvalSnapshot(events: JsonRecord[]): EvalSnapshot | undefined {
  return events
    .map(evalSnapshotFromEvent)
    .filter((entry): entry is EvalSnapshot => Boolean(entry))
    .toSorted((left, right) => right.at.localeCompare(left.at))[0];
}

function latestEvalTimeoutSnapshot(events: JsonRecord[]): EvalTimeoutSnapshot | undefined {
  return events
    .map(evalTimeoutSnapshotFromEvent)
    .filter((entry): entry is EvalTimeoutSnapshot => Boolean(entry))
    .toSorted((left, right) => right.at.localeCompare(left.at))[0];
}

function countEvalTimeoutsAfter(
  events: JsonRecord[],
  guardStartAt: string | undefined,
  name: string,
): number {
  return events
    .map(evalTimeoutSnapshotFromEvent)
    .filter((entry): entry is EvalTimeoutSnapshot => Boolean(entry))
    .filter((entry) => entry.name === name && (!guardStartAt || entry.at > guardStartAt)).length;
}

function latestPassingEvalSnapshot(events: JsonRecord[]): EvalSnapshot | undefined {
  return latestAdapterVerdictSnapshots(events)
    .filter((entry) => entry.promotionReady)
    .toSorted((left, right) => right.at.localeCompare(left.at))[0];
}

function latestAdapterVerdictSnapshots(events: JsonRecord[]): EvalSnapshot[] {
  return uniqueLatestEvalSnapshots(
    events
      .flatMap((event) => [evalSnapshotFromEvent(event), evalSnapshotFromTimeoutEvent(event)])
      .filter((entry): entry is EvalSnapshot => Boolean(entry?.adapterPath)),
  );
}

function evalSnapshotFromTimeoutEvent(event: JsonRecord): EvalSnapshot | undefined {
  const timeout = evalTimeoutSnapshotFromEvent(event);
  if (!timeout) {
    return undefined;
  }
  return {
    at: timeout.at,
    event: "step_timeout",
    name: timeout.name,
    adapterPath: timeout.adapterPath,
    passed: 0,
    total: 0,
    passRate: 0,
    promotionReady: false,
    failedCaseIds:
      timeout.failedCaseIds.length > 0
        ? timeout.failedCaseIds
        : [`${timeout.name || "eval"}_total_timeout`],
    parseErrorCaseIds: [],
    parseRecoveredCaseIds: [],
    parseErrorSamples: [],
  };
}

function uniqueLatestEvalSnapshots(snapshots: EvalSnapshot[]): EvalSnapshot[] {
  const latestByAdapter = new Map<string, EvalSnapshot>();
  for (const snapshot of snapshots.toSorted((left, right) => left.at.localeCompare(right.at))) {
    const key = snapshot.adapterPath ?? `${snapshot.name}:${snapshot.at}`;
    latestByAdapter.set(key, snapshot);
  }
  return [...latestByAdapter.values()].toSorted((left, right) => right.at.localeCompare(left.at));
}

function compactEvalSnapshot(
  snapshot: EvalSnapshot | undefined,
):
  | Pick<EvalSnapshot, "at" | "name" | "adapterPath" | "passed" | "total" | "promotionReady">
  | undefined {
  if (!snapshot) {
    return undefined;
  }
  return {
    at: snapshot.at,
    name: snapshot.name,
    adapterPath: snapshot.adapterPath,
    passed: snapshot.passed,
    total: snapshot.total,
    promotionReady: snapshot.promotionReady,
  };
}

function qwenCapabilityConsolidationSnapshot(params: {
  events: JsonRecord[];
  latestPassingEval?: EvalSnapshot;
  latestCandidateEval?: EvalSnapshot;
}): QwenCapabilityConsolidationSnapshot {
  const latestVerdictByAdapter = new Map(
    latestAdapterVerdictSnapshots(params.events)
      .filter((snapshot): snapshot is EvalSnapshot & { adapterPath: string } =>
        Boolean(snapshot.adapterPath),
      )
      .map((snapshot) => [snapshot.adapterPath, snapshot]),
  );
  const candidateSnapshots = uniqueLatestEvalSnapshots(
    params.events
      .filter((event) => event.name === "candidate_hardened_eval")
      .map(evalSnapshotFromEvent)
      .filter((entry): entry is EvalSnapshot => Boolean(entry)),
  );
  const candidateVerdicts = uniqueLatestEvalSnapshots(
    candidateSnapshots.map((snapshot) => {
      const latestVerdict = snapshot.adapterPath
        ? latestVerdictByAdapter.get(snapshot.adapterPath)
        : undefined;
      return latestVerdict && latestVerdict.at.localeCompare(snapshot.at) > 0
        ? latestVerdict
        : snapshot;
    }),
  );
  const cleanCandidates = candidateVerdicts.filter((snapshot) => snapshot.promotionReady);
  const blockedCandidates = candidateVerdicts.filter((snapshot) => !snapshot.promotionReady);
  const blockedCaseCounts = new Map<string, number>();
  const latestBlockedHarvestCaseIds: string[] = [];
  for (const snapshot of blockedCandidates) {
    for (const caseId of [
      ...snapshot.failedCaseIds,
      ...snapshot.parseErrorCaseIds,
      ...snapshot.parseRecoveredCaseIds,
    ]) {
      blockedCaseCounts.set(caseId, (blockedCaseCounts.get(caseId) ?? 0) + 1);
    }
  }
  const latestCleanCandidate = cleanCandidates[0];
  const latestBlockedCandidate = blockedCandidates[0];
  if (latestBlockedCandidate) {
    latestBlockedHarvestCaseIds.push(
      ...new Set([
        ...latestBlockedCandidate.failedCaseIds,
        ...latestBlockedCandidate.parseErrorCaseIds,
        ...latestBlockedCandidate.parseRecoveredCaseIds,
      ]),
    );
  }
  const blockedCapabilityFamilies = [...blockedCaseCounts.entries()]
    .map(([caseId, count]) => ({ caseId, count }))
    .toSorted((left, right) => right.count - left.count || left.caseId.localeCompare(right.caseId))
    .slice(0, 12);
  const latestCandidateIsBlocked = Boolean(
    params.latestCandidateEval && !params.latestCandidateEval.promotionReady,
  );
  const consolidationState = params.latestPassingEval
    ? latestCandidateIsBlocked
      ? "candidate_capabilities_not_yet_consolidated"
      : "selected_clean_adapter"
    : "awaiting_clean_adapter";
  const requiredAction =
    latestCandidateIsBlocked || latestBlockedCandidate
      ? "continue_failure_focus_until_next_clean_unified_adapter"
      : latestCleanCandidate &&
          latestCleanCandidate.adapterPath !== params.latestPassingEval?.adapterPath
        ? "run_promotion_audit_for_latest_clean_candidate"
        : params.latestPassingEval
          ? "keep_selected_clean_adapter_and_continue_consolidation"
          : "wait_for_hardened_eval";
  return {
    boundary: "dev_qwen_capability_consolidation_only",
    runtimeAdapterPolicy: "single_clean_adapter_only_no_dirty_ensemble",
    adapterLadderPolicy: "champion_challenger_harvest_into_next_single_adapter",
    capabilityIntegrationMode: "teacher_dataset_eval_promotion_into_one_clean_adapter",
    consolidationState,
    selectedCleanAdapter: params.latestPassingEval?.adapterPath,
    selectedCleanEval: compactEvalSnapshot(params.latestPassingEval),
    cleanCandidateAdapterCount: cleanCandidates.length,
    blockedCandidateAdapterCount: blockedCandidates.length,
    latestCleanCandidate,
    latestBlockedCandidate,
    blockedCapabilityFamilies,
    adapterLadder: {
      champion: params.latestPassingEval
        ? {
            adapterPath: params.latestPassingEval.adapterPath,
            eval: compactEvalSnapshot(params.latestPassingEval),
            runtimeEligible: true,
          }
        : undefined,
      latestCleanChallenger: latestCleanCandidate
        ? {
            adapterPath: latestCleanCandidate.adapterPath,
            eval: compactEvalSnapshot(latestCleanCandidate),
            promotionAuditRequired:
              latestCleanCandidate.adapterPath !== params.latestPassingEval?.adapterPath,
          }
        : undefined,
      latestBlockedChallenger: latestBlockedCandidate
        ? {
            adapterPath: latestBlockedCandidate.adapterPath,
            eval: compactEvalSnapshot(latestBlockedCandidate),
            runtimeEligible: false,
          }
        : undefined,
    },
    capabilityHarvest: {
      boundary: "dev_blocked_challenger_harvest_only",
      harvestMode: "failed_or_parse_recovered_cases_to_teacher_curriculum",
      sourceBlockedAdapter: latestBlockedCandidate?.adapterPath,
      harvestCaseIds: latestBlockedHarvestCaseIds,
      nextTeacherFocusCaseIds:
        latestBlockedHarvestCaseIds.length > 0
          ? latestBlockedHarvestCaseIds.slice(0, 8)
          : blockedCapabilityFamilies.map((entry) => entry.caseId).slice(0, 8),
      notPromotionProof: true,
      requiredNextStep:
        latestBlockedHarvestCaseIds.length > 0 || blockedCapabilityFamilies.length > 0
          ? "feed_harvested_cases_to_failure_focus_teacher_then_retrain_unified_adapter"
          : "wait_for_named_failed_or_parse_recovered_cases_before_harvest",
    },
    requiredAction,
    notes: [
      "Do not serve multiple LoRA adapters together just because several r values trained.",
      "Use champion/challenger selection for evaluation, but runtime still has one champion adapter.",
      "Blocked challenger capability is harvested into teacher curriculum and the next unified adapter, not served directly.",
      "All useful Qwen capability must be distilled back through teacher data, hardened eval, and promotion audit into one clean selected adapter.",
      "A newer 77/77 candidate with parseRecovered is useful training evidence, not a runtime replacement for the selected clean adapter.",
    ],
  };
}

function activeGuardAdapterTruthSnapshot(params: {
  latestGuardStart?: JsonRecord;
  selectedCleanAdapter?: string;
  latestPromotedAdapter?: string;
  latestPromotedAt?: string;
}): ActiveGuardAdapterTruthSnapshot {
  const latestGuardStartAt = eventTime(params.latestGuardStart) || undefined;
  const options =
    params.latestGuardStart?.options &&
    typeof params.latestGuardStart.options === "object" &&
    !Array.isArray(params.latestGuardStart.options)
      ? (params.latestGuardStart.options as JsonRecord)
      : undefined;
  const guardCurrentAdapter = stringField(options, "currentAdapter");
  const guardTrainingSeedAdapter = stringField(options, "trainingSeedAdapter");
  const guardTrainingResumeAdapter = stringField(options, "trainingResumeAdapter");
  const guardStartedAfterLatestPromotion = Boolean(
    latestGuardStartAt && params.latestPromotedAt && params.latestPromotedAt <= latestGuardStartAt,
  );
  const latestPromotedAdapterStillClean =
    params.latestPromotedAdapter && params.selectedCleanAdapter
      ? params.latestPromotedAdapter === params.selectedCleanAdapter
      : null;
  const guardUsesSelectedCleanAdapter =
    guardCurrentAdapter && params.selectedCleanAdapter
      ? guardCurrentAdapter === params.selectedCleanAdapter
      : null;
  const guardUsesLatestPromotedAdapter =
    guardCurrentAdapter &&
    params.latestPromotedAdapter &&
    guardStartedAfterLatestPromotion &&
    latestPromotedAdapterStillClean !== false
      ? guardCurrentAdapter === params.latestPromotedAdapter
      : null;
  const mismatchReasons = [
    latestPromotedAdapterStillClean === false
      ? "latest_promoted_adapter_no_longer_selected_clean"
      : undefined,
    guardUsesSelectedCleanAdapter === false
      ? "guard_current_adapter_not_selected_clean"
      : undefined,
    guardUsesLatestPromotedAdapter === false
      ? "guard_current_adapter_not_latest_promoted_after_promotion"
      : undefined,
    guardTrainingSeedAdapter &&
    params.selectedCleanAdapter &&
    guardTrainingSeedAdapter !== params.selectedCleanAdapter
      ? "guard_training_seed_adapter_not_selected_clean"
      : undefined,
    guardTrainingResumeAdapter &&
    params.selectedCleanAdapter &&
    guardTrainingResumeAdapter !== params.selectedCleanAdapter
      ? "guard_training_resume_adapter_not_selected_clean"
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return {
    boundary: "dev_active_guard_adapter_truth_only",
    latestGuardStartAt,
    guardCurrentAdapter,
    guardTrainingSeedAdapter,
    guardTrainingResumeAdapter,
    selectedCleanAdapter: params.selectedCleanAdapter,
    latestPromotedAdapter: params.latestPromotedAdapter,
    latestPromotedAt: params.latestPromotedAt,
    latestPromotedAdapterStillClean,
    guardStartedAfterLatestPromotion,
    guardUsesSelectedCleanAdapter,
    guardUsesLatestPromotedAdapter,
    mismatchReasons,
    action:
      mismatchReasons.length > 0
        ? "wait_for_active_guard_then_restart_with_selected_clean_adapter"
        : guardCurrentAdapter
          ? "guard_adapter_matches_selected_clean_adapter"
          : "no_active_guard_adapter_to_compare",
  };
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

function qwenMigrationCandidateCachePath(homeDir = process.env.HOME ?? os.homedir()): string {
  const hfHome = process.env.HF_HOME;
  const hubDir = hfHome
    ? path.join(hfHome, "hub")
    : path.join(homeDir, ".cache", "huggingface", "hub");
  return path.join(hubDir, "models--Qwen--Qwen3-1.7B");
}

async function directorySizeBytes(dirPath: string): Promise<number | undefined> {
  const stats = await fs.stat(dirPath).catch(() => undefined);
  if (!stats?.isDirectory()) {
    return undefined;
  }
  const result = await execFileAsync("du", ["-sk", dirPath]).catch(() => undefined);
  const rawSize = result?.stdout.trim().split(/\s+/u)[0];
  const sizeKb = rawSize ? Number(rawSize) : NaN;
  return Number.isFinite(sizeKb) ? sizeKb * 1024 : undefined;
}

async function machineMemoryBytes(): Promise<number | undefined> {
  const result = await execFileAsync("sysctl", ["-n", "hw.memsize"]).catch(() => undefined);
  const parsed = result ? Number(result.stdout.trim()) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function buildQwenBaseModelMigrationPlan(params: {
  activeProcesses: ActiveTrainingProcess[];
  activeHeavyEvalCounts: QwenBaseModelMigrationSnapshot["activeHeavyEvalCounts"];
  homeDir?: string;
  machineMemoryBytes?: number;
}): Promise<QwenBaseModelMigrationSnapshot> {
  const candidateCachePath = qwenMigrationCandidateCachePath(params.homeDir);
  const candidateCacheBytes = await directorySizeBytes(candidateCachePath);
  const candidateCached = candidateCacheBytes !== undefined;
  const memoryBytes = params.machineMemoryBytes ?? (await machineMemoryBytes());
  const activeTrainingProcessCount = params.activeProcesses.length;
  const active = activeTrainingProcessCount > 0;
  const memoryTooSmall =
    typeof memoryBytes === "number" && memoryBytes < MIN_QWEN_1_7B_SMOKE_MEMORY_BYTES;
  const decision = active
    ? "blocked_training_active"
    : !candidateCached
      ? "candidate_not_cached"
      : memoryTooSmall
        ? "memory_too_small_for_candidate"
        : "ready_for_no_adapter_smoke";
  const allowedNextCommand =
    decision === "ready_for_no_adapter_smoke"
      ? "node --import tsx scripts/dev/local-brain-distill-eval.ts --no-adapter --model Qwen/Qwen3-1.7B --case-id portfolio_mixed_q_t_nvda --summary-only --json --timeout-ms 180000"
      : undefined;
  const action =
    decision === "blocked_training_active"
      ? "wait_for_current_guard_eval_and_teacher_to_finish"
      : decision === "candidate_not_cached"
        ? "download_or_preload_candidate_before_any_smoke"
        : decision === "memory_too_small_for_candidate"
          ? "keep_qwen3_0_6b_and_do_not_attempt_candidate"
          : "run_no_adapter_smoke_before_any_lora_training";
  return {
    boundary: "dev_qwen_base_model_migration_plan_only",
    currentModel: QWEN_MIGRATION_CURRENT_MODEL,
    candidateModel: QWEN_MIGRATION_CANDIDATE_MODEL,
    candidateCachePath,
    candidateCached,
    candidateCacheBytes,
    machineMemoryBytes: memoryBytes,
    activeTrainingProcessCount,
    activeHeavyEvalCounts: params.activeHeavyEvalCounts,
    decision,
    action,
    allowedNextCommand,
    forbiddenWhileActive: [
      "do_not_start_qwen_1_7b_smoke_while_guard_active",
      "do_not_start_lora_training_while_eval_or_mlx_active",
      "do_not_replace_runtime_adapter_without_promotion_audit",
      "do_not_treat_no_adapter_smoke_as_migration_success",
    ],
    notes: [
      "Qwen3-0.6B adapters cannot be directly reused on Qwen3-1.7B; migrate data, curriculum, evals, and gates, then train a new adapter.",
      "The first safe step is a no-adapter load/inference smoke, not LoRA training.",
      "A successful smoke is dev evidence only; runtime stays on the latest-passing clean adapter until a new adapter passes hardened eval and promotion audit.",
    ],
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
  latestEvalTimeout?: EvalTimeoutSnapshot;
  stableEvalTimeoutCountAfterLatestStart?: number;
  latestTeacher?: TeacherSnapshot;
  latestQuotaStatus?: QuotaStatusSnapshot;
  qwenBaseModelMigration?: QwenBaseModelMigrationSnapshot;
  activeGuardAdapterTruth?: ActiveGuardAdapterTruthSnapshot;
  moduleLearningReview?: ModuleLearningReviewSnapshot;
  learningSedimentationBridge?: LearningSedimentationBridgeSnapshot;
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

  if ((params.activeGuardAdapterTruth?.mismatchReasons ?? []).length > 0) {
    decisions.push({
      id: "guard_adapter_mismatch",
      lane: "training",
      severity: "P2",
      action: "wait_for_active_guard_then_restart_with_selected_clean_adapter",
      reason: [
        `Active guard currentAdapter=${params.activeGuardAdapterTruth?.guardCurrentAdapter ?? "unknown"}`,
        `selectedCleanAdapter=${params.activeGuardAdapterTruth?.selectedCleanAdapter ?? "unknown"}`,
        `latestPromotedAdapter=${params.activeGuardAdapterTruth?.latestPromotedAdapter ?? "unknown"}`,
        `mismatch=${params.activeGuardAdapterTruth?.mismatchReasons.join(",")}`,
      ].join("; "),
      codexRepairEligible: false,
    });
  }

  if (params.qwenBaseModelMigration?.decision === "blocked_training_active") {
    decisions.push({
      id: "qwen_base_model_migration_blocked_active_training",
      lane: "qwen_migration",
      severity: "info",
      action: "wait_for_idle_before_qwen_1_7b_smoke",
      reason:
        "Qwen3-1.7B migration probe is blocked because guard/eval/teacher/MLX work is active.",
      codexRepairEligible: false,
    });
  } else if (params.qwenBaseModelMigration?.decision === "ready_for_no_adapter_smoke") {
    decisions.push({
      id: "qwen_base_model_migration_smoke_ready",
      lane: "qwen_migration",
      severity: "info",
      action: "run_no_adapter_smoke_before_any_lora_training",
      reason:
        "Qwen3-1.7B candidate is cached and no active local-brain process was detected; run one no-adapter smoke before training.",
      codexRepairEligible: false,
      nextCommand: params.qwenBaseModelMigration.allowedNextCommand,
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

  const latestTimeoutAfterStart =
    Boolean(params.latestEvalTimeout?.at) &&
    (!guardStartAt || params.latestEvalTimeout!.at > guardStartAt);
  if (latestTimeoutAfterStart) {
    const count = params.stableEvalTimeoutCountAfterLatestStart ?? 0;
    decisions.push({
      id: "stable_eval_timeout_after_latest_start",
      lane: "training",
      severity: count >= 2 ? "P2" : "P3",
      action: "hold_promotion_and_repair_eval_runtime_or_scope",
      reason: `Latest ${params.latestEvalTimeout!.name} timed out at ${
        params.latestEvalTimeout!.at
      } after latest guard_start${
        count > 0 ? `; stable_hardened_eval timeouts this guard=${count}` : ""
      }.`,
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
  if (weakModuleLearning > 0 || boundaryViolations > 0) {
    decisions.push({
      id: "module_learning_incomplete_evidence",
      lane: "module_learning",
      severity: "P2",
      action: "complete_module_learning_evidence_before_claiming_absorption",
      reason:
        boundaryViolations > 0
          ? `${boundaryViolations} module-learning receipt(s) violate boundary rules; ${weakModuleLearning} receipt(s) are not eval_absorbed yet.`
          : `${weakModuleLearning} module-learning receipt(s) are not eval_absorbed yet.`,
      codexRepairEligible: boundaryViolations > 0,
      nextCommand: boundaryViolations > 0 ? buildRepairLockCommand(params.worktree) : undefined,
    });
  }
  const bridgeCandidateCount =
    typeof params.learningSedimentationBridge?.candidateCount === "number"
      ? params.learningSedimentationBridge.candidateCount
      : 0;
  const reviewReceiptFiles =
    typeof moduleLearningCounts.receiptFiles === "number" ? moduleLearningCounts.receiptFiles : 0;
  if (reviewReceiptFiles === 0 && bridgeCandidateCount > 0) {
    decisions.push({
      id: "module_learning_bridge_candidates_pending",
      lane: "module_learning",
      severity: "P2",
      action: "write_module_learning_plan_receipts_then_review_absorption_gate",
      reason: `${bridgeCandidateCount} finance-learning apply receipt candidate(s) can enter the module-learning review chain; review is currently empty for today.`,
      codexRepairEligible: false,
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

async function learningSedimentationBridgeSnapshot(
  workspaceDir: string,
): Promise<LearningSedimentationBridgeSnapshot> {
  const result = await buildLearningSedimentationBridge({
    workspaceDir,
    maxCandidates: 8,
    writePlanReceipts: false,
    json: true,
  });
  return {
    ok: result.ok,
    boundary: result.boundary,
    candidateCount: result.candidateCount,
    sourceApplyReceiptFiles: result.sourceApplyReceiptFiles,
    candidates: result.candidates.slice(0, 5),
    nextAction: result.nextAction,
    notPromoted: result.notPromoted,
    liveTouched: result.liveTouched,
    providerConfigTouched: result.providerConfigTouched,
    protectedMemoryTouched: result.protectedMemoryTouched,
  };
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
  const latestEvalTimeout = latestEvalTimeoutSnapshot(guardEvents);
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
  const qwenCapabilityConsolidation = qwenCapabilityConsolidationSnapshot({
    events: guardEvents,
    latestPassingEval,
    latestCandidateEval,
  });
  const latestPromotion = latestEvent(
    guardEvents,
    (event) => event.event === "adapter_promoted_for_guard_session",
  );
  const latestPromotedAt = eventTime(latestPromotion) || undefined;
  const latestPromotedAdapter =
    typeof latestPromotion?.adapterPath === "string" ? latestPromotion.adapterPath : undefined;
  const activeGuardAdapterTruth = activeGuardAdapterTruthSnapshot({
    latestGuardStart,
    selectedCleanAdapter: qwenCapabilityConsolidation.selectedCleanAdapter,
    latestPromotedAdapter,
    latestPromotedAt,
  });
  const activeHeavyEval = activeHeavyEvalSummary(activeProcesses);
  const latestTeacher = latestTeacherSnapshot(quotaEvents);
  const latestQuotaStatus = latestQuotaStatusSnapshot(quotaEvents);
  const latestGuardStartAt = eventTime(latestGuardStart);
  const stableEvalTimeoutCountAfterLatestStart = countEvalTimeoutsAfter(
    guardEvents,
    latestGuardStartAt,
    "stable_hardened_eval",
  );
  const moduleLearningReview = await moduleLearningReviewSnapshot(workspaceDir);
  const learningSedimentationBridge = await learningSedimentationBridgeSnapshot(workspaceDir);
  const qwenBaseModelMigration = await buildQwenBaseModelMigrationPlan({
    activeProcesses,
    activeHeavyEvalCounts: activeHeavyEval.counts,
  });
  const decisions = buildDecisions({
    activeProcesses,
    overlappingHeavyEval: activeHeavyEval.overlappingHeavyEval,
    latestGuardStart,
    latestGuardFailure,
    latestEval,
    latestEvalTimeout,
    stableEvalTimeoutCountAfterLatestStart,
    latestTeacher,
    latestQuotaStatus,
    qwenBaseModelMigration,
    activeGuardAdapterTruth,
    moduleLearningReview,
    learningSedimentationBridge,
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
    latestGuardStartAt,
    latestDataset: datasetSummary(latestDataset),
    latestTrainSlice: trainSliceSummary(latestTrainSlice),
    latestSmokeAt: eventTime(latestSmoke),
    latestEval,
    latestEvalTimeout,
    stableEvalTimeoutCountAfterLatestStart,
    latestPassingEval,
    latestStableEval,
    latestTrainingSeedEval,
    latestCandidateEval,
    qwenCapabilityConsolidation,
    activeGuardAdapterTruth,
    latestPromotionAt: latestPromotedAt,
    latestPromotedAdapter,
    latestEvalIsCurrentForGuardStart:
      Boolean(latestEval?.at) &&
      (!eventTime(latestGuardStart) || latestEval!.at >= eventTime(latestGuardStart)),
    latestTeacher,
    latestQuotaStatus,
    qwenBaseModelMigration,
    moduleLearningReview,
    learningSedimentationBridge,
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
