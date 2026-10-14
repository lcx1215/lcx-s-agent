import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectEvidenceFile } from "../../src/agents/tools/module-learning-pipeline-plan-tool.ts";
import {
  createModuleLearningPipelineReviewTool,
  listModuleLearningReceiptPaths,
} from "../../src/agents/tools/module-learning-pipeline-review-tool.ts";
import { DEFAULT_GUARD_LOG_PATH, DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

type CliOptions = {
  workspaceDir: string;
  dateKey?: string;
  guardLogPath?: string;
  evalSummaryPath?: string;
  source?: string;
  targetModule?: string;
  hostRunId?: string;
  expectedReceiptSha256?: string;
  expectedSourceSha256?: string;
  contentReviewReceiptPath?: string;
  contentReviewReceiptSha256?: string;
  reviewAccountId?: string;
  reviewRunId?: string;
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

type EvalTimeoutSnapshot = {
  at?: string;
  name?: string;
  adapterPath?: string;
  timeoutReason?: string;
  timeoutMs?: number;
  durationMs?: number;
  failedCaseIds: string[];
};

const REVIEW_DIR = path.join("memory", "module-learning-pipeline-reviews");
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
      "Usage: node --import tsx scripts/operator/lcx-module-learning-absorption-gate.ts [--workspace DIR] [--date YYYY-MM-DD] [--guard-log PATH] [--eval-summary PATH] [--source SOURCE --target-module MODULE --host-run-id ID] [--receipt-sha256 HASH] [--source-sha256 HASH] [--json]",
      "",
      "Reads module-learning review receipts and hardened eval evidence, then decides whether module-learning may be called eval_absorbed.",
      "Optional --content-review-receipt FILE --content-review-sha256 HASH --review-account-id ID --review-run-id ID reads a pinned content diagnosis through the original review owner. It does not rerun models or grant absorption authority.",
      "Audits all dated batches by default. The legacy write flag cannot synthesize training or adjacent-task evidence.",
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
    } else if (
      [
        "--source",
        "--target-module",
        "--host-run-id",
        "--receipt-sha256",
        "--source-sha256",
      ].includes(arg)
    ) {
      const value = readValue(args, index);
      if (arg === "--source") {
        options.source = value;
      } else if (arg === "--target-module") {
        options.targetModule = value;
      } else if (arg === "--host-run-id") {
        options.hostRunId = value;
      } else if (arg === "--receipt-sha256") {
        options.expectedReceiptSha256 = value;
      } else {
        options.expectedSourceSha256 = value;
      }
      index += 1;
    } else if (
      [
        "--content-review-receipt",
        "--content-review-sha256",
        "--review-account-id",
        "--review-run-id",
      ].includes(arg)
    ) {
      const value = readValue(args, index);
      if (arg === "--content-review-receipt") {
        options.contentReviewReceiptPath = value;
      } else if (arg === "--content-review-sha256") {
        options.contentReviewReceiptSha256 = value;
      } else if (arg === "--review-account-id") {
        options.reviewAccountId = value;
      } else {
        options.reviewRunId = value;
      }
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
  if (
    options.dateKey &&
    options.dateKey !== "all" &&
    !/^\d{4}-\d{2}-\d{2}$/u.test(options.dateKey)
  ) {
    usage();
  }
  return options;
}

function normalizeDateKey(value?: string): string {
  return value ?? "all";
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

function isTerminalNonAbsorbedDecision(row: JsonRecord): boolean {
  return (
    row.terminalNonAbsorbedDecision === true ||
    row.keepDownrankDiscardDecision === "downrank" ||
    row.keepDownrankDiscardDecision === "discard"
  );
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

function normalizeEvalTimeoutSnapshot(
  payload: JsonRecord | undefined,
): EvalTimeoutSnapshot | undefined {
  if (!payload || payload.event !== "step_timeout") {
    return undefined;
  }
  const name = stringValue(payload.name);
  if (!name || !EVAL_EVENT_NAMES.has(name)) {
    return undefined;
  }
  const result = recordValue(payload.result) ?? {};
  const summary = recordValue(result.summary) ?? {};
  return {
    at: stringValue(payload.at),
    name,
    adapterPath: stringValue(result.adapterPath) ?? stringValue(payload.adapterPath),
    timeoutReason: stringValue(result.timeoutReason) ?? stringValue(payload.timeoutReason),
    timeoutMs: numberValue(result.timeoutMs) || numberValue(payload.durationMs) || undefined,
    durationMs: numberValue(result.durationMs) || numberValue(payload.durationMs) || undefined,
    failedCaseIds: stringArrayValue(summary.failedCaseIds),
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

async function latestEvalTimeoutFromGuardLog(
  guardLogPath: string,
): Promise<EvalTimeoutSnapshot | undefined> {
  let text = "";
  try {
    text = await fs.readFile(guardLogPath, "utf8");
  } catch {
    return undefined;
  }
  const snapshots: EvalTimeoutSnapshot[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("hardened_eval")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as JsonRecord;
      const snapshot = normalizeEvalTimeoutSnapshot(event);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    } catch {
      // Ignore malformed historical log lines; timeout absence remains visible through blockers.
    }
  }
  return snapshots.toSorted((left, right) => (right.at ?? "").localeCompare(left.at ?? ""))[0];
}

async function readReview(params: {
  workspaceDir: string;
  dateKey: string;
  contentReviewReceipt?: { path: string; sha256: string };
  reviewScope?: { accountId: string; runId: string };
}) {
  const reviewRelativePath = path
    .join(REVIEW_DIR, `${params.dateKey}.json`)
    .split(path.sep)
    .join("/");
  // Read current receipts through the same owner; a saved review can predate intake.
  const result = await createModuleLearningPipelineReviewTool({
    workspaceDir: params.workspaceDir,
    scope: params.reviewScope,
  }).execute("module-learning-absorption-gate-review", {
    dateKey: params.dateKey,
    writeReview: false,
    ...(params.contentReviewReceipt ? { contentReviewReceipt: params.contentReviewReceipt } : {}),
  });
  return {
    review: {
      ...(result.details as JsonRecord),
      ...(params.contentReviewReceipt
        ? { requestedContentReviewReceipt: params.contentReviewReceipt }
        : {}),
    },
    reviewRelativePath,
  };
}

async function countPlanReceiptFiles(params: {
  workspaceDir: string;
  dateKey: string;
}): Promise<{ count: number; unreadable: string[] }> {
  const { files, issues } = await listModuleLearningReceiptPaths(
    params.workspaceDir,
    params.dateKey,
  );
  // A receipt directory that could not be read yields the same count as a day with no receipts.
  // Carry the failures alongside the count so the gate never mistakes one for the other.
  return {
    count: files.length,
    unreadable: issues.map((issue) => `${issue.status}/${issue.code}`),
  };
}

function missingRowEvidence(row: JsonRecord): string[] {
  const exactMissingProof = stringArrayValue(row.exactMissingProof);
  if (exactMissingProof.length > 0) {
    return exactMissingProof;
  }
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
  planReceiptFiles: number;
  latestEval: EvalSnapshot | undefined;
  latestEvalTimeout: EvalTimeoutSnapshot | undefined;
  evalEvidenceSource: string;
}) {
  const blockers: string[] = [];
  const nextActions: string[] = [];
  const counts = recordValue(params.review?.counts) ?? {};
  const rows = Array.isArray(params.review?.rows)
    ? params.review.rows.filter((entry): entry is JsonRecord => Boolean(recordValue(entry)))
    : [];
  const contentReviewReadback = recordValue(params.review?.contentReviewReadback);
  const contentReviewByReceipt = rows.flatMap((row) => {
    const content = recordValue(row.contentReview);
    if (!content) {
      return [];
    }
    return [
      {
        receiptPath: stringValue(row.receiptPath) ?? "unknown",
        receiptSha256: stringValue(row.receiptSha256) ?? null,
        sourceUrlOrPath: stringValue(row.sourceUrlOrPath) ?? null,
        targetModule: stringValue(row.targetModule) ?? "unknown",
        attemptScope: recordValue(row.contentReviewAttemptScope) ?? null,
        upstreamScope: stringValue(row.upstreamScope) ?? "not_observed",
        status: stringValue(content.status) ?? "failed",
        gaps: stringArrayValue(content.gaps),
        findings: stringArrayValue(content.findings),
        answer: stringValue(content.answer) ?? null,
        boundary: "content_diagnosis_only_not_application_acceptance",
      },
    ];
  });
  for (const content of contentReviewByReceipt) {
    const findings = content.findings.join("; ");
    const findingPreview = findings.slice(0, 4096);
    const remainingFindings =
      findings.length > findingPreview.length
        ? " [Preview truncated; read this receipt's contentReviewByReceipt.findings for all findings.]"
        : "";
    nextActions.push(
      content.status === "failed"
        ? `Restore the content review handoff: ${content.receiptPath}: ${content.gaps.join(",")}. Keep the existing absorption hold.`
        : `Review ${content.receiptPath}: ${content.answer ?? content.gaps.join(",")}.${findingPreview ? ` Findings: ${findingPreview}.${remainingFindings}` : ""} Content remains provisional; preserve permission and application acceptance holds.`,
    );
  }
  if (contentReviewReadback && contentReviewByReceipt.length === 0) {
    nextActions.push(
      `Restore the content review handoff: ${stringArrayValue(contentReviewReadback.gaps).join(",")}. Keep the existing absorption hold.`,
    );
  }
  const claimableRows = rows.filter((row) => !isTerminalNonAbsorbedDecision(row));
  const terminalNonAbsorbedRows = rows.filter((row) => isTerminalNonAbsorbedDecision(row));
  const weakRows = claimableRows.filter(
    (row) => row.weak === true || row.status !== "eval_absorbed",
  );
  const missingEvidenceByReceipt = rows
    .filter((row) => !isTerminalNonAbsorbedDecision(row))
    .map((row) => ({
      receiptPath: stringValue(row.receiptPath) ?? "unknown",
      targetModule: stringValue(row.targetModule) ?? "unknown",
      status: stringValue(row.status) ?? "unknown",
      missingEvidence: missingRowEvidence(row),
      nextProofOwner: stringValue(row.nextProofOwner) ?? "unknown",
    }))
    .filter((entry) => entry.missingEvidence.length > 0);
  const boundaryViolations = numberValue(counts.boundaryViolations);
  const globalEvalClean =
    Boolean(params.latestEval?.promotionReady) &&
    params.latestEval?.failedCaseIds.length === 0 &&
    params.latestEval?.parseErrorCaseIds.length === 0 &&
    params.latestEval?.parseRecoveredCaseIds.length === 0;
  const perReceiptAbsorbed =
    claimableRows.length > 0 &&
    weakRows.length === 0 &&
    missingEvidenceByReceipt.length === 0 &&
    numberValue(counts.evalAbsorbed) >= claimableRows.length &&
    boundaryViolations === 0;
  const reviewStaleOrEmpty =
    Boolean(params.review) && rows.length === 0 && params.planReceiptFiles > 0;
  const evalTimeoutNewerThanEval =
    Boolean(params.latestEvalTimeout?.at) &&
    (!params.latestEval?.at || params.latestEvalTimeout!.at! > params.latestEval.at);

  if (params.planReceiptFiles === 0) {
    blockers.push("module_learning_plan_receipts_missing");
    nextActions.push("create source-bound application receipts before claiming absorption");
  }
  if (!params.review) {
    blockers.push("module_learning_review_missing");
    nextActions.push(
      "run module-learning-pipeline-review for the current date before claiming absorption",
    );
  }
  if (reviewStaleOrEmpty) {
    blockers.push("module_learning_review_stale_or_empty");
    nextActions.push(
      "rerun module-learning-pipeline-review so absorption gate sees the current plan receipts",
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
  if (evalTimeoutNewerThanEval) {
    blockers.push("latest_hardened_eval_timeout_newer_than_absorption_evidence");
    nextActions.push(
      "repair or rerun the timed-out hardened eval before using older clean eval evidence for module absorption",
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

  const sourceCoverage = recordValue(params.review?.sourceCoverage);
  const sourceCoverageReady =
    Boolean(sourceCoverage) && numberValue(sourceCoverage?.unresolvedSources) === 0;
  if (!sourceCoverageReady) {
    blockers.push("registered_sources_missing_application_or_eval_evidence");
    nextActions.push(
      "Resolve each registered source through the existing module-learning owner; code mappings and historical unrelated evaluations do not satisfy source-specific evidence.",
    );
  }
  const absorptionReady =
    perReceiptAbsorbed && globalEvalClean && !evalTimeoutNewerThanEval && sourceCoverageReady;
  return {
    ok: true,
    boundary: "local_module_learning_absorption_gate_only",
    dateKey: params.dateKey,
    reviewPath: params.reviewPath,
    evalEvidenceSource: params.evalEvidenceSource,
    reviewReadMode: "fresh_read_only",
    sourceCoverage,
    absorptionReady,
    gateDecision: absorptionReady ? "ready_for_eval_absorbed_review" : "hold_at_application_ready",
    counts: {
      planReceiptFiles: params.planReceiptFiles,
      reviewRows: rows.length,
      claimableRows: claimableRows.length,
      terminalNonAbsorbedRows: terminalNonAbsorbedRows.length,
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
    latestEvalTimeout: params.latestEvalTimeout
      ? {
          at: params.latestEvalTimeout.at,
          name: params.latestEvalTimeout.name,
          adapterPath: params.latestEvalTimeout.adapterPath,
          timeoutReason: params.latestEvalTimeout.timeoutReason,
          timeoutMs: params.latestEvalTimeout.timeoutMs,
          durationMs: params.latestEvalTimeout.durationMs,
          failedCaseIds: params.latestEvalTimeout.failedCaseIds,
          newerThanLatestEval: evalTimeoutNewerThanEval,
        }
      : null,
    requiredCaseIds: REQUIRED_CASE_IDS,
    missingEvidenceByReceipt: missingEvidenceByReceipt.slice(0, 20),
    ...(contentReviewReadback ? { contentReviewReadback } : {}),
    ...(recordValue(params.review?.requestedContentReviewReceipt)
      ? { requestedContentReviewReceipt: params.review?.requestedContentReviewReceipt }
      : {}),
    ...(contentReviewByReceipt.length > 0 ? { contentReviewByReceipt } : {}),
    proofGapSummary: recordValue(params.review?.proofGapSummary) ?? {},
    nextProofQueue: Array.isArray(params.review?.nextProofQueue)
      ? params.review.nextProofQueue
          .filter((entry) => {
            const row = recordValue(entry);
            return !row || !isTerminalNonAbsorbedDecision(row);
          })
          .slice(0, 20)
      : [],
    terminalNonAbsorbedRows: terminalNonAbsorbedRows.slice(0, 20).map((row) => ({
      receiptPath: stringValue(row.receiptPath) ?? "unknown",
      targetModule: stringValue(row.targetModule) ?? "unknown",
      status: stringValue(row.status) ?? "unknown",
      keepDownrankDiscardDecision: stringValue(row.keepDownrankDiscardDecision) ?? "unknown",
    })),
    blockers: [...new Set(blockers)],
    nextActions: [...new Set(nextActions)],
    notPromoted: true,
    // Auditing a global eval must never invent per-source training or transfer evidence.
    writeAvailable: false,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
    languageCorpusTouched: false,
  };
}

async function consumedReviewEvidence(options: CliOptions, review: JsonRecord | undefined) {
  const selected = Boolean(
    options.source ||
    options.targetModule ||
    options.expectedReceiptSha256 ||
    options.expectedSourceSha256,
  );
  const rows = Array.isArray(review?.rows)
    ? review.rows.filter((row): row is JsonRecord => Boolean(recordValue(row)))
    : [];
  const selectedRows = rows.filter(
    (row) => row.sourceUrlOrPath === options.source && row.targetModule === options.targetModule,
  );
  const gaps: string[] = [];
  if (selected && (!options.source || !options.targetModule)) {
    gaps.push("selected_source_module_scope_incomplete");
  }
  if (selected && selectedRows.length === 0) {
    gaps.push("selected_source_module_receipt_missing");
  }
  const receipts = await Promise.all(
    selectedRows.map(async (row) => {
      const artifactFields = [
        "sourceRegistryRecordPath",
        "retrievalReceiptPath",
        "applicationValidationReceiptPath",
        "trainingOrEvalAbsorptionEvidencePath",
      ];
      const artifacts = await Promise.all(
        artifactFields.map(async (field) => {
          const relativePath = stringValue(row[field]);
          const artifact = await inspectEvidenceFile(options.workspaceDir, relativePath ?? null);
          if (relativePath && !artifact) {
            gaps.push(`selected_evidence_unreadable:${relativePath}`);
          }
          return { field, path: relativePath ?? null, sha256: artifact?.sha256 ?? null };
        }),
      );
      if (options.expectedReceiptSha256 && row.receiptSha256 !== options.expectedReceiptSha256) {
        gaps.push("selected_receipt_hash_conflict");
      }
      if (options.expectedSourceSha256 && artifacts[0]?.sha256 !== options.expectedSourceSha256) {
        gaps.push("selected_source_hash_conflict");
      }
      return {
        receiptPath: row.receiptPath,
        receiptSha256: row.receiptSha256,
        sourceUrlOrPath: row.sourceUrlOrPath,
        targetModule: row.targetModule,
        status: row.status,
        declaredStatus: row.declaredStatus,
        evaluationVerified: row.evaluationVerified,
        keepDownrankDiscardDecision: row.keepDownrankDiscardDecision,
        missingEvidence: row.missingEvidence,
        ...(recordValue(row.contentReview)
          ? {
              contentReview: row.contentReview,
              contentReviewAttemptScope: row.contentReviewAttemptScope,
              upstreamScope: row.upstreamScope,
            }
          : {}),
        artifacts,
      };
    }),
  );
  return {
    readMode: "fresh_original_review",
    reviewResultSha256: review
      ? createHash("sha256").update(JSON.stringify(review)).digest("hex")
      : null,
    hostScope: {
      workspaceId: createHash("sha256").update(path.resolve(options.workspaceDir)).digest("hex"),
      runId: options.hostRunId ?? null,
    },
    selection: selected
      ? { sourceUrlOrPath: options.source ?? null, targetModule: options.targetModule ?? null }
      : null,
    receiptSource: recordValue(review?.receiptSource) ?? null,
    selectedReceipts: receipts,
    ...(recordValue(review?.contentReviewReadback)
      ? { contentReviewReadback: review?.contentReviewReadback }
      : {}),
    ...(recordValue(review?.requestedContentReviewReceipt)
      ? { requestedContentReviewReceipt: review?.requestedContentReviewReceipt }
      : {}),
    gaps: [...new Set(gaps)],
    boundary:
      "Original evidence readback only; selection does not narrow global source coverage, grant training or trading authority",
  };
}

function renderText(result: ReturnType<typeof buildGate>): string {
  const latestEval = result.latestEval;
  const latestEvalText = latestEval
    ? `latest_eval=${latestEval.name ?? "unknown"} ${latestEval.passed}/${latestEval.total} promotionReady=${latestEval.promotionReady} parseRecovered=${latestEval.parseRecoveredCaseIds.length}`
    : "latest_eval=missing";
  const lines = [
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
  ];
  if (result.contentReviewReadback) {
    lines.push(`content_review=${stringValue(result.contentReviewReadback.status) ?? "failed"}`);
    const requestedReceipt = recordValue(result.requestedContentReviewReceipt);
    if (requestedReceipt) {
      lines.push(
        `content_review_requested_receipt=${stringValue(requestedReceipt.path) ?? "missing"}`,
      );
    }
    for (const gap of stringArrayValue(result.contentReviewReadback.gaps)) {
      lines.push(`content_review_gap=${gap}`);
    }
    const answer = stringValue(result.contentReviewReadback.answer);
    if (answer) {
      lines.push(`content_review_answer=${answer}`);
    }
    for (const finding of stringArrayValue(result.contentReviewReadback.findings).slice(0, 8)) {
      lines.push(`content_review_finding=${finding}`);
    }
  }
  for (const nextAction of result.nextActions) {
    lines.push(`next_action=${nextAction}`);
  }
  return `${lines.join("\n")}\n`;
}

const options = parseArgs(process.argv.slice(2));
const dateKey = normalizeDateKey(options.dateKey);
const { review, reviewRelativePath } = await readReview({
  workspaceDir: options.workspaceDir,
  dateKey,
  contentReviewReceipt:
    options.contentReviewReceiptPath || options.contentReviewReceiptSha256
      ? {
          path: options.contentReviewReceiptPath ?? "",
          sha256: options.contentReviewReceiptSha256 ?? "",
        }
      : undefined,
  reviewScope:
    options.reviewAccountId && options.reviewRunId
      ? { accountId: options.reviewAccountId, runId: options.reviewRunId }
      : undefined,
});
const planReceipts = await countPlanReceiptFiles({
  workspaceDir: options.workspaceDir,
  dateKey,
});
const evalEvidenceSource = options.evalSummaryPath
  ? options.evalSummaryPath
  : (options.guardLogPath ?? DEFAULT_GUARD_LOG_PATH);
const latestEval = options.evalSummaryPath
  ? await readEvalSummary(options.evalSummaryPath)
  : await latestEvalFromGuardLog(options.guardLogPath ?? DEFAULT_GUARD_LOG_PATH);
const latestEvalTimeout = options.evalSummaryPath
  ? undefined
  : await latestEvalTimeoutFromGuardLog(options.guardLogPath ?? DEFAULT_GUARD_LOG_PATH);
const result = buildGate({
  dateKey,
  review,
  reviewPath: reviewRelativePath,
  planReceiptFiles: planReceipts.count,
  latestEval,
  latestEvalTimeout,
  evalEvidenceSource,
});
const consumedReview = await consumedReviewEvidence(options, review);
const finalResult = {
  ...result,
  consumedReview,
  absorptionReady: result.absorptionReady && consumedReview.gaps.length === 0,
  gateDecision: consumedReview.gaps.length ? "hold_at_application_ready" : result.gateDecision,
  blockers: [...new Set([...result.blockers, ...consumedReview.gaps])],
  preWriteGateDecision: null,
  postWriteReviewRefreshed: false,
  planReceiptSourceUnreadable: planReceipts.unreadable,
  writeRequested: options.writeAbsorbedPlanReceipts,
  absorptionDecision: options.absorptionDecision,
  writtenAbsorptionReceipts: [],
  writeSkippedReason: options.writeAbsorbedPlanReceipts
    ? "absorption_requires_executed_per_receipt_training_and_adjacent_task_evidence"
    : null,
};

if (options.json) {
  console.log(JSON.stringify(finalResult, null, 2));
} else {
  process.stdout.write(renderText(finalResult));
}
