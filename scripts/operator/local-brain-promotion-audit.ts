import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildLocalBrainTrainingPlan } from "./local-brain-training-plan.ts";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

type CliOptions = {
  guardLogPath: string;
  quotaLogPath?: string;
  worktree: string;
  model: string;
  json: boolean;
  processCheck: boolean;
};

type JsonRecord = Record<string, unknown>;
type PromotionDecision = "safe" | "hold" | "ambiguous" | "rejected";

const PROMOTION_BLOCKING_DECISION_IDS = new Set([
  "overlapping_heavy_eval_detected",
  "guard_failed_after_latest_start",
  "eval_pending_after_latest_start",
  "stable_eval_timeout_after_latest_start",
  "eval_not_promotion_ready",
  "promotion_candidate_blocked_by_runtime_truth",
  "output_contract_or_parser_failure",
  "train_slice_stale_after_dataset_update",
  "guard_adapter_mismatch",
  "latest_promoted_adapter_not_selected_clean",
  "module_learning_incomplete_evidence",
]);

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME ?? os.homedir();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_GUARD_LOG = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "logs",
  "minimax-brain-training-guard-medium.jsonl",
);

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/local-brain-promotion-audit.ts [--json]",
      "",
      "Read-only promotion audit for the current Qwen local-brain adapter.",
      "Does not start training, does not move/delete/promote adapters, and does not touch live/provider/protected-memory state.",
      "",
      "Options:",
      "  --guard-log PATH  default ~/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl",
      "  --quota-log PATH  optional quota log passed through to local-brain-training-plan",
      "  --worktree PATH   default current repo",
      "  --model NAME      default Qwen/Qwen3-0.6B",
      "  --no-process-check",
      "  --json",
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
    guardLogPath: DEFAULT_GUARD_LOG,
    worktree: WORKTREE_DIR,
    model: "Qwen/Qwen3-0.6B",
    json: false,
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
    } else if (arg === "--model") {
      options.model = readValue(args, index);
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

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function resolveCurrentAdapter(params: {
  worktree: string;
  guardLogPath: string;
  model: string;
}): Promise<{ ok: true; details: JsonRecord } | { ok: false; error: string }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/minimax-brain-training-guard.ts",
        "--resolve-current-adapter",
        "--model",
        params.model,
        "--log",
        params.guardLogPath,
      ],
      {
        cwd: params.worktree,
        maxBuffer: 1024 * 1024 * 4,
      },
    );
    return { ok: true, details: parseJsonObjectFromOutput(result.stdout) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildPromotionAudit(params: {
  plan: JsonRecord;
  resolver: { ok: true; details: JsonRecord } | { ok: false; error: string };
}): JsonRecord {
  const latestEval = asRecord(params.plan.latestEval);
  const latestPassingEval = asRecord(params.plan.latestPassingEval);
  const latestTeacher = asRecord(params.plan.latestTeacher);
  const moduleLearningReview = asRecord(params.plan.moduleLearningReview);
  const moduleLearningCounts = asRecord(moduleLearningReview.counts);
  const resolverDetails = params.resolver.ok ? params.resolver.details : {};
  const datasetPromotionRisk = asRecord(resolverDetails.datasetPromotionRisk);
  const datasetPromotionRiskStatus = stringValue(datasetPromotionRisk.status);
  const selectedAdapter =
    stringValue(resolverDetails.selectedAdapter) ??
    stringValue(resolverDetails.trainingSeedAdapter) ??
    stringValue(resolverDetails.trainingResumeAdapter);
  const resolverTrainingSeed = asRecord(resolverDetails.trainingSeed);
  const latestPassingEvalAdapter = stringValue(latestPassingEval.adapterPath);
  const selectedEval =
    Boolean(selectedAdapter) &&
    Boolean(latestPassingEvalAdapter) &&
    selectedAdapter === latestPassingEvalAdapter
      ? latestPassingEval
      : latestEval;
  const latestEvalAdapter = stringValue(latestEval.adapterPath);
  const selectedEvalAdapter = stringValue(selectedEval.adapterPath);
  const selectedEvalPromotionReady = selectedEval.promotionReady === true;
  const selectedEvalPassed = numberValue(selectedEval.passed);
  const selectedEvalTotal = numberValue(selectedEval.total);
  const failedCaseIds = stringArray(selectedEval.failedCaseIds);
  const parseErrorCaseIds = stringArray(selectedEval.parseErrorCaseIds);
  const parseRecoveredCaseIds = stringArray(selectedEval.parseRecoveredCaseIds);
  const parseErrorSamples = stringArray(selectedEval.parseErrorSamples);
  const resolverMatchesLatestEval =
    Boolean(selectedAdapter) && Boolean(latestEvalAdapter) && selectedAdapter === latestEvalAdapter;
  const resolverMatchesLatestPassingEval =
    Boolean(selectedAdapter) &&
    Boolean(latestPassingEvalAdapter) &&
    selectedAdapter === latestPassingEvalAdapter;
  const trainingPlanDecisions = Array.isArray(params.plan.decisions)
    ? params.plan.decisions.filter(
        (decision): decision is JsonRecord =>
          Boolean(decision) && typeof decision === "object" && !Array.isArray(decision),
      )
    : [];
  const promotionBlockingDecisions = trainingPlanDecisions.filter(
    (decision) =>
      typeof decision.id === "string" && PROMOTION_BLOCKING_DECISION_IDS.has(decision.id),
  );
  const promotionBlockingDecisionIds = promotionBlockingDecisions.flatMap((decision) =>
    typeof decision.id === "string" ? [decision.id] : [],
  );
  const teacherFailures = numberValue(latestTeacher.failures) ?? 0;
  const boundaryViolations = numberValue(moduleLearningCounts.boundaryViolations) ?? 0;
  const activeProcesses = Array.isArray(params.plan.activeProcesses)
    ? params.plan.activeProcesses
    : [];

  let promotionDecision: PromotionDecision;
  const realBugsFound: string[] = [];
  if (!params.resolver.ok) {
    promotionDecision = "rejected";
    realBugsFound.push("resolver_failed");
  } else if (!selectedAdapter) {
    promotionDecision = "rejected";
    realBugsFound.push("no_selected_latest_passing_adapter");
  } else if (boundaryViolations > 0) {
    promotionDecision = "ambiguous";
    realBugsFound.push("module_learning_boundary_violation");
  } else if (datasetPromotionRiskStatus === "source_stable_dataset_shrink") {
    promotionDecision = "hold";
  } else if (promotionBlockingDecisions.length > 0) {
    promotionDecision = "hold";
  } else if (
    !selectedEvalPromotionReady ||
    failedCaseIds.length > 0 ||
    parseErrorCaseIds.length > 0
  ) {
    promotionDecision = "hold";
  } else if (!resolverMatchesLatestEval && !resolverMatchesLatestPassingEval) {
    promotionDecision = "ambiguous";
    realBugsFound.push("resolver_adapter_differs_from_latest_passing_eval_adapter");
  } else {
    promotionDecision = "safe";
  }

  const qualityLaneConcernsConsidered = [
    ...(teacherFailures > 0 ? ["latest_teacher_batch_has_failures"] : []),
    ...(latestEval.promotionReady === false
      ? ["latest_chronological_eval_not_promotion_ready"]
      : []),
    ...(stringArray(latestEval.parseRecoveredCaseIds).length > 0
      ? ["latest_chronological_eval_parse_recovered_present"]
      : []),
    ...(parseRecoveredCaseIds.length > 0 ? ["selected_eval_parse_recovered_present"] : []),
    ...(parseErrorSamples.length > 0 ? ["latest_eval_parse_error_samples_present"] : []),
    ...(datasetPromotionRiskStatus === "source_stable_dataset_shrink"
      ? ["dataset_promotion_risk_source_stable_shrink"]
      : []),
  ];

  return {
    ok: true,
    boundary: "local_brain_promotion_audit_only",
    lane: "promotion_audit",
    promotionDecision,
    latestPassingAdapter: selectedAdapter,
    resolverStatus: params.resolver.ok ? "ok" : "failed",
    resolverError: params.resolver.ok ? undefined : params.resolver.error,
    resolverSelectionMode: stringValue(resolverDetails.selectionMode),
    datasetPromotionRisk: {
      status: datasetPromotionRiskStatus,
      at: stringValue(datasetPromotionRisk.at),
      sourceFiles: numberValue(datasetPromotionRisk.sourceFiles),
      examples: numberValue(datasetPromotionRisk.examples),
      train: numberValue(datasetPromotionRisk.train),
      valid: numberValue(datasetPromotionRisk.valid),
      test: numberValue(datasetPromotionRisk.test),
      previousMaxExamples: numberValue(datasetPromotionRisk.previousMaxExamples),
      previousMaxTrain: numberValue(datasetPromotionRisk.previousMaxTrain),
      ignoredIncompatibleHistory: numberValue(datasetPromotionRisk.ignoredIncompatibleHistory),
      datasetSignature: stringValue(datasetPromotionRisk.datasetSignature),
      reason: stringValue(datasetPromotionRisk.reason),
    },
    resolverTrainingSeed: {
      adapterPath: stringValue(resolverTrainingSeed.adapterPath),
      at: stringValue(resolverTrainingSeed.at),
      passed: numberValue(resolverTrainingSeed.passed),
      total: numberValue(resolverTrainingSeed.total),
      passRate: numberValue(resolverTrainingSeed.passRate),
      parseRecoveredCount: numberValue(resolverTrainingSeed.parseRecoveredCount),
      source: stringValue(resolverTrainingSeed.source),
    },
    latestEval: {
      at: stringValue(latestEval.at),
      name: stringValue(latestEval.name),
      adapterPath: latestEvalAdapter,
      passed: numberValue(latestEval.passed),
      total: numberValue(latestEval.total),
      passRate: numberValue(latestEval.passRate),
      promotionReady: latestEval.promotionReady === true,
      failedCaseIds: stringArray(latestEval.failedCaseIds),
      parseErrorCaseIds: stringArray(latestEval.parseErrorCaseIds),
      parseRecoveredCaseIds: stringArray(latestEval.parseRecoveredCaseIds),
    },
    selectedEval: {
      at: stringValue(selectedEval.at),
      name: stringValue(selectedEval.name),
      adapterPath: selectedEvalAdapter,
      passed: selectedEvalPassed,
      total: selectedEvalTotal,
      passRate: numberValue(selectedEval.passRate),
      promotionReady: selectedEvalPromotionReady,
      failedCaseIds,
      parseErrorCaseIds,
      parseRecoveredCaseIds,
    },
    latestPassingEval: {
      at: stringValue(latestPassingEval.at),
      name: stringValue(latestPassingEval.name),
      adapterPath: latestPassingEvalAdapter,
      passed: numberValue(latestPassingEval.passed),
      total: numberValue(latestPassingEval.total),
      passRate: numberValue(latestPassingEval.passRate),
      promotionReady: latestPassingEval.promotionReady === true,
      parseRecoveredCaseIds: stringArray(latestPassingEval.parseRecoveredCaseIds),
    },
    resolverMatchesLatestEval,
    resolverMatchesLatestPassingEval,
    promotionBlockingDecisionIds,
    promotionBlockingDecisions,
    activeTraining: activeProcesses.length > 0,
    activeProcesses,
    latestTeacher,
    moduleLearningReview: {
      ok: moduleLearningReview.ok,
      boundary: moduleLearningReview.boundary,
      updated: moduleLearningReview.updated,
      counts: moduleLearningCounts,
    },
    qualityLaneConcernsConsidered: [
      ...qualityLaneConcernsConsidered,
      ...promotionBlockingDecisionIds.map((id) => `training_plan_${id}`),
    ],
    realBugsFound,
    suggestedNewEvalCase:
      promotionDecision === "safe"
        ? "keep a lightweight adapter-backed regression for module-learning-review and strict JSON parser stability"
        : promotionDecision === "hold"
          ? "keep the current training seed for resume only; continue failure-focus teacher and rerun hardened eval before any strict promotion"
          : "rerun hardened eval after the named blocker is repaired; do not promote from ambiguous or rejected audit state",
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
    adaptersMovedOrDeleted: false,
    promotionApplied: false,
  };
}

function renderText(audit: JsonRecord): string {
  const latestEval = asRecord(audit.latestEval);
  const lines = [
    `Local brain promotion audit | decision=${stringValue(audit.promotionDecision, "unknown")}`,
    `latest_passing_adapter=${stringValue(audit.latestPassingAdapter, "none")}`,
    `latest_eval=${stringValue(latestEval.name, "unknown")} ${numberValue(latestEval.passed) ?? 0}/${numberValue(latestEval.total) ?? 0} promotionReady=${latestEval.promotionReady === true}`,
    `resolver_matches_latest_eval=${audit.resolverMatchesLatestEval === true}`,
    `promotion_blocking_decisions=${stringArray(audit.promotionBlockingDecisionIds).join(",") || "none"}`,
    `active_training=${audit.activeTraining === true}`,
    `real_bugs_found=${stringArray(audit.realBugsFound).join(",") || "none"}`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function runPromotionAudit(options: CliOptions): Promise<JsonRecord> {
  const plan = await buildLocalBrainTrainingPlan({
    guardLogPath: options.guardLogPath,
    quotaLogPath: options.quotaLogPath,
    worktree: options.worktree,
    json: true,
    processCheck: options.processCheck,
  });
  const resolver = await resolveCurrentAdapter({
    worktree: options.worktree,
    guardLogPath: options.guardLogPath,
    model: options.model,
  });
  return buildPromotionAudit({ plan, resolver });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const audit = await runPromotionAudit(options);
  process.stdout.write(options.json ? `${JSON.stringify(audit, null, 2)}\n` : renderText(audit));
}
