import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createModuleLearningPipelinePlanTool } from "../../src/agents/tools/module-learning-pipeline-plan-tool.ts";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.ts";
import { DEFAULT_GUARD_LOG_PATH, DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

type CliOptions = {
  workspaceDir: string;
  dateKey?: string;
  guardLogPath?: string;
  evalSummaryPath?: string;
  writeAbsorbedPlanReceipts: boolean;
  absorptionDecision: "keep" | "downrank" | "discard";
  json: boolean;
};

type JsonRecord = Record<string, unknown>;

type EvalSnapshot = {
  at?: string;
  event?: string;
  name?: string;
  adapterPath?: string;
  passed: number;
  total: number;
  passRate: number;
  promotionReady: boolean;
  failedCaseIds: string[];
  parseErrorCaseIds: string[];
  parseRecoveredCaseIds: string[];
};

const REVIEW_DIR = path.join("memory", "module-learning-pipeline-reviews");
const ABSORPTION_EVIDENCE_DIR = path.join("memory", "module-learning-absorption-evidence");
const EVAL_EVENT_NAMES = new Set([
  "stable_hardened_eval",
  "training_seed_hardened_eval",
  "candidate_hardened_eval",
]);
const REQUIRED_CASE_IDS = [
  "all_module_knowledge_internalization_chain",
  "paper_learning_internalization_absorption",
  "portfolio_mixed_q_t_nvda",
  "technical_timing_not_standalone_alpha",
  "event_gap_options_hedge_research_boundary",
  "senior_trader_risk_packet_no_execution",
];
const REQUIRED_EVIDENCE_FIELDS = new Set([
  "training_or_eval_absorption_evidence",
  "fresh_adjacent_application_task",
  "keep_downrank_or_discard_decision",
]);

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-module-learning-absorption-gate.ts [--workspace DIR] [--date YYYY-MM-DD] [--guard-log PATH] [--eval-summary PATH] [--json]",
      "",
      "Reads module-learning review receipts and hardened eval evidence, then decides whether module-learning may be called eval_absorbed.",
      "Default is read-only. --write-absorbed-plan-receipts writes dev/local evidence and superseding eval_absorbed plan receipts only when hardened eval is clean.",
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
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    writeAbsorbedPlanReceipts: false,
    absorptionDecision: "keep",
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace" || arg === "--worktree") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--date" || arg === "--date-key") {
      options.dateKey = readValue(args, index);
      index += 1;
    } else if (arg === "--guard-log") {
      options.guardLogPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--eval-summary") {
      options.evalSummaryPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--write-absorbed-plan-receipts") {
      options.writeAbsorbedPlanReceipts = true;
    } else if (arg === "--absorption-decision") {
      const value = readValue(args, index);
      if (value !== "keep" && value !== "downrank" && value !== "discard") {
        usage();
      }
      options.absorptionDecision = value;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (options.dateKey && !/^\d{4}-\d{2}-\d{2}$/u.test(options.dateKey)) {
    usage();
  }
  return options;
}

function normalizeDateKey(value?: string): string {
  return value ?? new Date().toISOString().slice(0, 10);
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function normalizeEvalSnapshot(payload: JsonRecord | undefined): EvalSnapshot | undefined {
  if (!payload) {
    return undefined;
  }
  const result = recordValue(payload.result) ?? payload;
  const summary = recordValue(result.summary) ?? result;
  const passed = numberValue(summary.passed);
  const total = numberValue(summary.total);
  if (total <= 0) {
    return undefined;
  }
  return {
    at: stringValue(payload.at),
    event: stringValue(payload.event),
    name: stringValue(payload.name),
    adapterPath: stringValue(result.adapterPath) ?? stringValue(payload.adapterPath),
    passed,
    total,
    passRate: numberValue(summary.passRate) || passed / total,
    promotionReady:
      summary.promotionReady === true &&
      (payload.event === undefined || payload.event === "step_ok"),
    failedCaseIds: stringArrayValue(summary.failedCaseIds),
    parseErrorCaseIds: stringArrayValue(summary.parseErrorCaseIds),
    parseRecoveredCaseIds: stringArrayValue(summary.parseRecoveredCaseIds),
  };
}

async function readEvalSummary(evalSummaryPath: string): Promise<EvalSnapshot | undefined> {
  const parsed = JSON.parse(await fs.readFile(evalSummaryPath, "utf8")) as JsonRecord;
  return normalizeEvalSnapshot(parsed);
}

async function latestEvalFromGuardLog(guardLogPath: string): Promise<EvalSnapshot | undefined> {
  let text = "";
  try {
    text = await fs.readFile(guardLogPath, "utf8");
  } catch {
    return undefined;
  }
  const snapshots: EvalSnapshot[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("hardened_eval")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as JsonRecord;
      if (!EVAL_EVENT_NAMES.has(stringValue(event.name) ?? "")) {
        continue;
      }
      const snapshot = normalizeEvalSnapshot(event);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    } catch {
      // Ignore malformed historical log lines; absence of a clean eval remains visible.
    }
  }
  return snapshots.toSorted((left, right) => (right.at ?? "").localeCompare(left.at ?? ""))[0];
}

async function readReview(params: { workspaceDir: string; dateKey: string }) {
  const reviewRelativePath = path
    .join(REVIEW_DIR, `${params.dateKey}.json`)
    .split(path.sep)
    .join("/");
  const reviewPath = path.join(params.workspaceDir, reviewRelativePath);
  try {
    const review = JSON.parse(await fs.readFile(reviewPath, "utf8")) as JsonRecord;
    return { review, reviewRelativePath };
  } catch {
    return { review: undefined, reviewRelativePath };
  }
}

function adjacentTaskForModule(targetModule: string): string {
  const tasks: Record<string, string> = {
    portfolio_risk_gates:
      "Apply this portfolio risk lesson to a fresh QQQ/TLT/NVDA-style risk question and refuse sizing without weights, limits, and return-series evidence.",
    event_driven:
      "Apply this event-driven lesson to a fresh earnings, policy, or ETF catalyst triage and separate catalyst evidence from trade advice.",
    technical_timing:
      "Apply this timing lesson to a fresh ETF or large-cap timing question and keep technicals as timing context, not standalone alpha.",
    options_volatility:
      "Apply this options-volatility lesson to a fresh event gap-risk question and return research-only IV/skew/liquidity framing, not a contract recommendation.",
    factor_research:
      "Apply this factor lesson to a fresh ETF or index research task and require formula, lag, costs, and sample-out evidence before reuse.",
    macro_rates_inflation:
      "Apply this macro lesson to a fresh rates/liquidity portfolio question and separate timestamped data gaps from reusable regime logic.",
    global_index_regime:
      "Apply this index-regime lesson to a fresh index concentration or breadth question and name missing methodology or constituent evidence.",
  };
  return (
    tasks[targetModule] ??
    `Apply this ${targetModule} lesson to a fresh adjacent research-only task with source, risk boundary, and review evidence.`
  );
}

function evidenceReceiptPath(params: {
  dateKey: string;
  targetModule: string;
  receiptPath: string;
}): string {
  const hash = createHash("sha256")
    .update(`${params.dateKey}\n${params.targetModule}\n${params.receiptPath}`)
    .digest("hex")
    .slice(0, 12);
  return path
    .join(ABSORPTION_EVIDENCE_DIR, params.dateKey, `${params.targetModule}__${hash}.json`)
    .split(path.sep)
    .join("/");
}

async function writeJson(params: {
  workspaceDir: string;
  relativePath: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const absolutePath = path.join(params.workspaceDir, params.relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(params.payload, null, 2)}\n`, "utf8");
}

function missingRowEvidence(row: JsonRecord): string[] {
  const missing = new Set(stringArrayValue(row.missingEvidence));
  if (!stringValue(row.trainingOrEvalAbsorptionEvidencePath)) {
    missing.add("training_or_eval_absorption_evidence");
  }
  if (!stringValue(row.freshAdjacentApplicationTask)) {
    missing.add("fresh_adjacent_application_task");
  }
  if (
    !stringValue(row.keepDownrankDiscardDecision) ||
    row.keepDownrankDiscardDecision === "not_decided"
  ) {
    missing.add("keep_downrank_or_discard_decision");
  }
  return [...missing].filter((entry) => REQUIRED_EVIDENCE_FIELDS.has(entry));
}

function buildGate(params: {
  dateKey: string;
  review: JsonRecord | undefined;
  reviewPath: string;
  latestEval: EvalSnapshot | undefined;
  evalEvidenceSource: string;
}) {
  const blockers: string[] = [];
  const nextActions: string[] = [];
  const counts = recordValue(params.review?.counts) ?? {};
  const rows = Array.isArray(params.review?.rows)
    ? params.review.rows.filter((entry): entry is JsonRecord => Boolean(recordValue(entry)))
    : [];
  const weakRows = rows.filter((row) => row.weak === true || row.status !== "eval_absorbed");
  const missingEvidenceByReceipt = rows
    .map((row) => ({
      receiptPath: stringValue(row.receiptPath) ?? "unknown",
      targetModule: stringValue(row.targetModule) ?? "unknown",
      status: stringValue(row.status) ?? "unknown",
      missingEvidence: missingRowEvidence(row),
    }))
    .filter((entry) => entry.missingEvidence.length > 0);
  const boundaryViolations = numberValue(counts.boundaryViolations);
  const globalEvalClean =
    Boolean(params.latestEval?.promotionReady) &&
    params.latestEval?.failedCaseIds.length === 0 &&
    params.latestEval?.parseErrorCaseIds.length === 0 &&
    params.latestEval?.parseRecoveredCaseIds.length === 0;
  const perReceiptAbsorbed =
    rows.length > 0 &&
    weakRows.length === 0 &&
    missingEvidenceByReceipt.length === 0 &&
    numberValue(counts.evalAbsorbed) === rows.length &&
    boundaryViolations === 0;

  if (!params.review) {
    blockers.push("module_learning_review_missing");
    nextActions.push(
      "run module-learning-pipeline-review for the current date before claiming absorption",
    );
  }
  if (!params.latestEval) {
    blockers.push("hardened_eval_evidence_missing");
    nextActions.push(
      "wait for or run a bounded hardened eval; do not infer absorption from stored receipts",
    );
  } else if (!globalEvalClean) {
    blockers.push("latest_hardened_eval_not_clean");
    nextActions.push(
      "repair failed or parse-recovered eval cases before using eval evidence for absorption",
    );
  }
  if (boundaryViolations > 0) {
    blockers.push("module_learning_receipt_boundary_violation");
  }
  if (weakRows.length > 0) {
    blockers.push("module_receipts_not_eval_absorbed");
  }
  if (missingEvidenceByReceipt.length > 0) {
    blockers.push("module_receipts_missing_absorption_decision_evidence");
    nextActions.push(
      "add per-receipt eval/training evidence, a fresh adjacent application task, and a keep/downrank/discard decision before moving status to eval_absorbed",
    );
  }

  const absorptionReady = perReceiptAbsorbed && globalEvalClean;
  return {
    ok: true,
    boundary: "dev_module_learning_absorption_gate_only",
    dateKey: params.dateKey,
    reviewPath: params.reviewPath,
    evalEvidenceSource: params.evalEvidenceSource,
    absorptionReady,
    gateDecision: absorptionReady ? "ready_for_eval_absorbed_review" : "hold_at_application_ready",
    counts: {
      reviewRows: rows.length,
      weakReceiptCount: weakRows.length,
      evalAbsorbed: numberValue(counts.evalAbsorbed),
      applicationReady: numberValue(counts.applicationReady),
      boundaryViolations,
      missingAbsorptionEvidenceReceipts: missingEvidenceByReceipt.length,
    },
    latestEval: params.latestEval
      ? {
          at: params.latestEval.at,
          name: params.latestEval.name,
          adapterPath: params.latestEval.adapterPath,
          passed: params.latestEval.passed,
          total: params.latestEval.total,
          passRate: params.latestEval.passRate,
          promotionReady: params.latestEval.promotionReady,
          failedCaseIds: params.latestEval.failedCaseIds,
          parseErrorCaseIds: params.latestEval.parseErrorCaseIds,
          parseRecoveredCaseIds: params.latestEval.parseRecoveredCaseIds,
          globalEvalClean,
        }
      : null,
    requiredCaseIds: REQUIRED_CASE_IDS,
    missingEvidenceByReceipt: missingEvidenceByReceipt.slice(0, 20),
    blockers: [...new Set(blockers)],
    nextActions: [...new Set(nextActions)],
    notPromoted: true,
    writeAvailable:
      !params.review ||
      !globalEvalClean ||
      boundaryViolations > 0 ||
      rows.length === 0 ||
      missingEvidenceByReceipt.length === 0
        ? false
        : missingEvidenceByReceipt.every((entry) =>
            entry.missingEvidence.every((field) => REQUIRED_EVIDENCE_FIELDS.has(field)),
          ),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
    languageCorpusTouched: false,
  };
}

async function writeAbsorbedPlanReceipts(params: {
  workspaceDir: string;
  dateKey: string;
  review: JsonRecord | undefined;
  gate: ReturnType<typeof buildGate>;
  latestEval: EvalSnapshot;
  absorptionDecision: "keep" | "downrank" | "discard";
}) {
  const rows = Array.isArray(params.review?.rows)
    ? params.review.rows.filter((entry): entry is JsonRecord => Boolean(recordValue(entry)))
    : [];
  const eligibleRows = rows.filter(
    (row) =>
      row.status === "application_ready" &&
      !boolValue(row.boundaryViolation) &&
      !boolValue(row.superseded),
  );
  const planTool = createModuleLearningPipelinePlanTool({ workspaceDir: params.workspaceDir });
  const written = [];
  for (const [index, row] of eligibleRows.entries()) {
    const targetModule = stringValue(row.targetModule) ?? "unknown";
    const receiptPath = stringValue(row.receiptPath) ?? "unknown";
    const evidencePath = evidenceReceiptPath({
      dateKey: params.dateKey,
      targetModule,
      receiptPath,
    });
    const freshAdjacentApplicationTask =
      stringValue(row.freshAdjacentApplicationTask) ?? adjacentTaskForModule(targetModule);
    await writeJson({
      workspaceDir: params.workspaceDir,
      relativePath: evidencePath,
      payload: {
        ok: true,
        boundary: "dev_module_learning_absorption_evidence",
        dateKey: params.dateKey,
        targetModule,
        sourceReceiptPath: receiptPath,
        evalEvidenceSource: params.gate.evalEvidenceSource,
        latestEval: params.gate.latestEval,
        requiredCaseIds: params.gate.requiredCaseIds,
        freshAdjacentApplicationTask,
        keepDownrankDiscardDecision: params.absorptionDecision,
        claimBoundary:
          "This proves dev eval absorption evidence for module-learning review; it does not prove live-visible-fixed or protected-memory update.",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
        languageCorpusTouched: false,
      },
    });
    const planResult = await planTool.execute(`module-learning-absorption-${index}`, {
      targetModule,
      receiptDateKey: params.dateKey,
      sourceUrlOrPath: stringValue(row.sourceUrlOrPath),
      learningIntent: stringValue(row.learningIntent),
      actualReadingScope: stringValue(row.actualReadingScope),
      applicationValidationTask:
        stringValue(row.freshAdjacentApplicationTask) ??
        stringValue(row.applicationValidationTask) ??
        freshAdjacentApplicationTask,
      existingArtifactPaths: [
        stringValue(row.sourceUrlOrPath),
        stringValue(row.retrievalReceiptPath),
        stringValue(row.applicationValidationReceiptPath),
        evidencePath,
      ].filter((entry): entry is string => Boolean(entry)),
      sourceRegistryRecordPath: stringValue(row.sourceRegistryRecordPath),
      retrievalReceiptPath: stringValue(row.retrievalReceiptPath),
      applicationValidationReceiptPath: stringValue(row.applicationValidationReceiptPath),
      trainingOrEvalAbsorptionEvidencePath: evidencePath,
      freshAdjacentApplicationTask,
      keepDownrankDiscardDecision: params.absorptionDecision,
      supersedesReceiptPath: receiptPath,
      writeReceipt: true,
    });
    const details = planResult.details as Record<string, unknown>;
    written.push({
      targetModule,
      supersedesReceiptPath: receiptPath,
      absorptionEvidencePath: evidencePath,
      newReceiptPath: details.receiptPath,
      status: details.status,
    });
  }
  return written;
}

async function refreshReviewAfterWrite(params: {
  workspaceDir: string;
  dateKey: string;
}): Promise<{ review: JsonRecord; reviewPath: string }> {
  const reviewTool = createModuleLearningPipelineReviewTool({ workspaceDir: params.workspaceDir });
  const reviewResult = await reviewTool.execute("module-learning-absorption-gate-refresh", {
    dateKey: params.dateKey,
    writeReview: true,
  });
  const review = reviewResult.details as JsonRecord;
  return {
    review,
    reviewPath: stringValue(review.reviewPath) ?? path.join(REVIEW_DIR, `${params.dateKey}.json`),
  };
}

function renderText(result: ReturnType<typeof buildGate>): string {
  const latestEval = result.latestEval;
  const latestEvalText = latestEval
    ? `latest_eval=${latestEval.name ?? "unknown"} ${latestEval.passed}/${latestEval.total} promotionReady=${latestEval.promotionReady} parseRecovered=${latestEval.parseRecoveredCaseIds.length}`
    : "latest_eval=missing";
  return (
    [
      `Module learning absorption gate | decision=${result.gateDecision}`,
      `boundary=${result.boundary}`,
      `date=${result.dateKey}`,
      `review_path=${result.reviewPath}`,
      `absorption_ready=${result.absorptionReady}`,
      `review_rows=${result.counts.reviewRows}`,
      `weak_receipts=${result.counts.weakReceiptCount}`,
      `eval_absorbed=${result.counts.evalAbsorbed}`,
      latestEvalText,
      `blockers=${result.blockers.join(",") || "none"}`,
    ].join("\n") + "\n"
  );
}

const options = parseArgs(process.argv.slice(2));
const dateKey = normalizeDateKey(options.dateKey);
const { review, reviewRelativePath } = await readReview({
  workspaceDir: options.workspaceDir,
  dateKey,
});
const evalEvidenceSource = options.evalSummaryPath
  ? options.evalSummaryPath
  : (options.guardLogPath ?? DEFAULT_GUARD_LOG_PATH);
const latestEval = options.evalSummaryPath
  ? await readEvalSummary(options.evalSummaryPath)
  : await latestEvalFromGuardLog(options.guardLogPath ?? DEFAULT_GUARD_LOG_PATH);
const result = buildGate({
  dateKey,
  review,
  reviewPath: reviewRelativePath,
  latestEval,
  evalEvidenceSource,
});
const writtenAbsorptionReceipts =
  options.writeAbsorbedPlanReceipts && latestEval && result.writeAvailable
    ? await writeAbsorbedPlanReceipts({
        workspaceDir: options.workspaceDir,
        dateKey,
        review,
        gate: result,
        latestEval,
        absorptionDecision: options.absorptionDecision,
      })
    : [];
const refreshedReview =
  writtenAbsorptionReceipts.length > 0
    ? await refreshReviewAfterWrite({
        workspaceDir: options.workspaceDir,
        dateKey,
      })
    : undefined;
const refreshedGate =
  refreshedReview && latestEval
    ? buildGate({
        dateKey,
        review: refreshedReview.review,
        reviewPath: refreshedReview.reviewPath,
        latestEval,
        evalEvidenceSource,
      })
    : undefined;
const finalResult = {
  ...(refreshedGate ?? result),
  preWriteGateDecision: writtenAbsorptionReceipts.length > 0 ? result.gateDecision : null,
  postWriteReviewRefreshed: Boolean(refreshedGate),
  writeRequested: options.writeAbsorbedPlanReceipts,
  absorptionDecision: options.absorptionDecision,
  writtenAbsorptionReceipts,
  writeSkippedReason:
    options.writeAbsorbedPlanReceipts && writtenAbsorptionReceipts.length === 0
      ? result.writeAvailable
        ? "no_eligible_application_ready_rows"
        : "gate_not_write_available"
      : null,
};

if (options.json) {
  console.log(JSON.stringify(finalResult, null, 2));
} else {
  process.stdout.write(renderText(finalResult));
}
