import fs from "node:fs/promises";
import path from "node:path";
import { evaluateLarkRoutingCandidateCorpus } from "../../../extensions/feishu/src/lark-routing-candidate-corpus.js";
import type { FeishuConfig } from "../../../extensions/feishu/src/types.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { planFinanceBrainOrchestration } from "../../agents/finance-brain-orchestration.js";
import { loadConfig } from "../../config/config.js";
import { formatValidationErrors, validateAgentParams } from "../../gateway/protocol/index.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { runLanguageBrainLoopSmoke } from "./language-brain-loop-smoke.js";

export type LarkLoopDiagnoseCommandOptions = {
  agent?: string;
  workspaceDir?: string;
  fixtureDir?: string;
  json?: boolean;
};

type ReceiptStats = {
  agentId: string | null;
  workspaceDir: string;
  count: number;
  latestPath: string | null;
  latestGeneratedAt: string | null;
  financeOrchestrationCount: number;
  latestFinanceOrchestration: FinanceOrchestrationReceiptSummary | null;
  latestReceiptFinanceReplay: FinanceOrchestrationReceiptSummary | null;
};

type AggregateReceiptStats = {
  workspaceDir: string;
  count: number;
  latestPath: string | null;
  latestGeneratedAt: string | null;
  financeOrchestrationCount: number;
  latestFinanceOrchestration: FinanceOrchestrationReceiptSummary | null;
  latestReceiptFinanceReplay: FinanceOrchestrationReceiptSummary | null;
  workspaces: ReceiptStats[];
};

type ReceiptWorkspace = {
  agentId: string | null;
  workspaceDir: string;
};

type GatewayModelParamSchemaCheck = {
  ok: boolean;
  error: string | null;
};

type LanguageCandidateCaptureStats = {
  workspaceDir: string;
  candidateArtifactCount: number;
  candidateCount: number;
  acceptedCaseCount: number;
  rejectedCount: number;
  discardedCount: number;
  reasonCounts: Record<string, number>;
  semanticFamilyCounts: Record<string, number>;
  rejectedReasonCounts: Record<string, number>;
  rejectedSemanticFamilyCounts: Record<string, number>;
  rejectedExamples: LanguageRejectedCandidateExample[];
  currentReplay: {
    candidateCount: number;
    acceptedCaseCount: number;
    rejectedCount: number;
    discardedCount: number;
    reasonCounts: Record<string, number>;
    semanticFamilyCounts: Record<string, number>;
    rejectedReasonCounts: Record<string, number>;
    rejectedSemanticFamilyCounts: Record<string, number>;
    rejectedExamples: LanguageRejectedCandidateExample[];
  };
  latestCandidatePath: string | null;
  latestCandidateGeneratedAt: string | null;
  reviewArtifactCount: number;
  promotedCaseCount: number;
  latestReviewPath: string | null;
  latestReviewGeneratedAt: string | null;
  autodataLoop: LanguageAutodataLoopReadiness;
};

type LanguageRejectedCandidateExample = {
  reason: string;
  semanticFamily: string;
  source: string | null;
  utterance: string;
  candidateId: string | null;
  artifactPath: string | null;
};

type LanguageAutodataLoopReadiness = {
  pattern: "autodata_inspired_language_data_loop";
  status:
    | "needs_candidate_capture"
    | "needs_route_family_hardening"
    | "needs_review_promotion"
    | "ready_for_reviewed_batch_absorption";
  currentReplayAcceptanceRate: number;
  currentReplayRejectedRate: number;
  topRejectedReason: string | null;
  topRejectedSemanticFamily: string | null;
  nextBatchFocus: string[];
  guardrails: string[];
};

type FinanceOrchestrationReceiptSummary = {
  receiptPath: string;
  generatedAt: string | null;
  family: string | null;
  source: string | null;
  primaryModules: string[];
  supportingModules: string[];
  requiredTools: string[];
  reviewTools: string[];
  boundaries: string[];
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function summarizeFinanceOrchestrationReceipt(params: {
  workspaceDir: string;
  filePath: string;
  parsed: Record<string, unknown>;
}): FinanceOrchestrationReceiptSummary | null {
  const orchestration = params.parsed.financeBrainOrchestration;
  if (!orchestration || typeof orchestration !== "object" || Array.isArray(orchestration)) {
    return null;
  }
  const handoff = params.parsed.handoff;
  const handoffRecord =
    handoff && typeof handoff === "object" && !Array.isArray(handoff)
      ? (handoff as Record<string, unknown>)
      : {};
  const orchestrationRecord = orchestration as Record<string, unknown>;
  return {
    receiptPath: path.relative(params.workspaceDir, params.filePath).replaceAll(path.sep, "/"),
    generatedAt:
      typeof params.parsed.generatedAt === "string" && params.parsed.generatedAt.trim()
        ? params.parsed.generatedAt
        : null,
    family: typeof handoffRecord.family === "string" ? handoffRecord.family : null,
    source: typeof handoffRecord.source === "string" ? handoffRecord.source : null,
    primaryModules: stringArray(orchestrationRecord.primaryModules),
    supportingModules: stringArray(orchestrationRecord.supportingModules),
    requiredTools: stringArray(orchestrationRecord.requiredTools),
    reviewTools: stringArray(orchestrationRecord.reviewTools),
    boundaries: stringArray(orchestrationRecord.boundaries),
  };
}

function hasLocalMathInputs(text: string): boolean {
  return /数学|计算|math|calculate|beta|volatility|covariance|回撤|夏普/iu.test(text);
}

function summarizeFinanceOrchestrationReplay(params: {
  workspaceDir: string;
  filePath: string;
  parsed: Record<string, unknown>;
}): FinanceOrchestrationReceiptSummary | null {
  const userMessage =
    typeof params.parsed.userMessage === "string" ? params.parsed.userMessage.trim() : "";
  if (!userMessage) {
    return null;
  }
  const handoff = params.parsed.handoff;
  const handoffRecord =
    handoff && typeof handoff === "object" && !Array.isArray(handoff)
      ? (handoff as Record<string, unknown>)
      : {};
  const family = typeof handoffRecord.family === "string" ? handoffRecord.family : null;
  const plan = planFinanceBrainOrchestration({
    text: userMessage,
    hasHoldingsOrPortfolioContext:
      family === "position_risk_adjustment" || family === "bracket_exit_plan",
    hasLocalMathInputs: hasLocalMathInputs(userMessage),
    highStakesConclusion:
      family === "position_risk_adjustment" ||
      family === "trading_execution_boundary" ||
      family === "trading_execution_order",
  });
  if (plan.primaryModules.length === 0 && plan.supportingModules.length === 0) {
    return null;
  }
  return {
    receiptPath: path.relative(params.workspaceDir, params.filePath).replaceAll(path.sep, "/"),
    generatedAt:
      typeof params.parsed.generatedAt === "string" && params.parsed.generatedAt.trim()
        ? params.parsed.generatedAt
        : null,
    family,
    source: typeof handoffRecord.source === "string" ? handoffRecord.source : null,
    primaryModules: plan.primaryModules,
    supportingModules: plan.supportingModules,
    requiredTools: plan.requiredTools,
    reviewTools: plan.reviewTools,
    boundaries: plan.boundaries,
  };
}

async function walkJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function incrementCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function divideOrZero(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function topCountKey(counts: Record<string, number>): string | null {
  let top: string | null = null;
  let topCount = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (count > topCount) {
      top = key;
      topCount = count;
    }
  }
  return top;
}

function isRejectedLanguageReason(reason: string): boolean {
  return (
    reason !== "accepted_language_case" &&
    reason !== "discarded_by_distillation" &&
    reason !== "api_route_label_reference"
  );
}

function extractCandidateUtterance(candidate: Record<string, unknown>): string | null {
  if (typeof candidate.utterance === "string" && candidate.utterance.trim()) {
    return candidate.utterance.trim().slice(0, 240);
  }
  const sample =
    candidate.sample && typeof candidate.sample === "object" && !Array.isArray(candidate.sample)
      ? (candidate.sample as Record<string, unknown>)
      : {};
  return typeof sample.distillableText === "string" && sample.distillableText.trim()
    ? sample.distillableText.trim().slice(0, 240)
    : null;
}

function accumulateLanguageEvaluationStats(params: {
  evaluation: Record<string, unknown>;
  reasonCounts: Record<string, number>;
  semanticFamilyCounts: Record<string, number>;
  rejectedReasonCounts: Record<string, number>;
  rejectedSemanticFamilyCounts: Record<string, number>;
  rejectedExamples?: LanguageRejectedCandidateExample[];
  artifactPath?: string | null;
}) {
  const evaluations = Array.isArray(params.evaluation.evaluations)
    ? params.evaluation.evaluations
    : [];
  for (const entry of evaluations) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const evaluationEntry = entry as Record<string, unknown>;
    const reason =
      typeof evaluationEntry.reason === "string" && evaluationEntry.reason.trim()
        ? evaluationEntry.reason
        : "unknown";
    const candidate =
      evaluationEntry.candidate &&
      typeof evaluationEntry.candidate === "object" &&
      !Array.isArray(evaluationEntry.candidate)
        ? (evaluationEntry.candidate as Record<string, unknown>)
        : {};
    const semantic =
      candidate.semantic &&
      typeof candidate.semantic === "object" &&
      !Array.isArray(candidate.semantic)
        ? (candidate.semantic as Record<string, unknown>)
        : {};
    const family =
      typeof semantic.family === "string" && semantic.family.trim() ? semantic.family : "unknown";
    incrementCount(params.reasonCounts, reason);
    incrementCount(params.semanticFamilyCounts, family);
    if (isRejectedLanguageReason(reason)) {
      incrementCount(params.rejectedReasonCounts, reason);
      incrementCount(params.rejectedSemanticFamilyCounts, family);
      const utterance = extractCandidateUtterance(candidate);
      if (utterance && params.rejectedExamples && params.rejectedExamples.length < 8) {
        params.rejectedExamples.push({
          reason,
          semanticFamily: family,
          source: typeof candidate.source === "string" ? candidate.source : null,
          utterance,
          candidateId: typeof candidate.id === "string" ? candidate.id : null,
          artifactPath: params.artifactPath ?? null,
        });
      }
    }
  }
}

function summarizeLanguageAutodataLoop(
  stats: Omit<LanguageCandidateCaptureStats, "autodataLoop">,
): LanguageAutodataLoopReadiness {
  const currentReplayAcceptanceRate = divideOrZero(
    stats.currentReplay.acceptedCaseCount,
    stats.currentReplay.candidateCount,
  );
  const currentReplayRejectedRate = divideOrZero(
    stats.currentReplay.rejectedCount,
    stats.currentReplay.candidateCount,
  );
  const topRejectedReason = topCountKey(stats.currentReplay.rejectedReasonCounts);
  const topRejectedSemanticFamily = topCountKey(stats.currentReplay.rejectedSemanticFamilyCounts);
  const nextBatchFocus: string[] = [];
  if (stats.candidateCount < 10) {
    nextBatchFocus.push("capture_more_real_lark_dialogue_candidates");
  }
  if (topRejectedReason === "semantic_family_unknown") {
    nextBatchFocus.push("triage_unknown_semantic_family_examples");
  }
  if (topRejectedReason === "deterministic_route_failed") {
    nextBatchFocus.push("compare_api_family_label_against_deterministic_surface");
  }
  if (topRejectedReason === "missing_distillable_text") {
    nextBatchFocus.push("inspect_candidate_distillation_shape");
  }
  if (stats.currentReplay.acceptedCaseCount > stats.promotedCaseCount) {
    nextBatchFocus.push("review_accepted_cases_before_corpus_promotion");
  }
  if (nextBatchFocus.length === 0) {
    nextBatchFocus.push("continue_small_batch_capture_and_replay");
  }

  const status =
    stats.candidateCount < 10
      ? "needs_candidate_capture"
      : stats.currentReplay.acceptedCaseCount === 0 ||
          topRejectedReason === "semantic_family_unknown"
        ? "needs_route_family_hardening"
        : stats.currentReplay.acceptedCaseCount > stats.promotedCaseCount
          ? "needs_review_promotion"
          : "ready_for_reviewed_batch_absorption";

  return {
    pattern: "autodata_inspired_language_data_loop",
    status,
    currentReplayAcceptanceRate,
    currentReplayRejectedRate,
    topRejectedReason,
    topRejectedSemanticFamily,
    nextBatchFocus,
    guardrails: [
      "language_routing_only",
      "no_finance_learning_artifact_promotion",
      "no_live_sender_change",
      "accepted_cases_still_require_review_before_formal_corpus",
    ],
  };
}

function dedupeReceiptWorkspaces(workspaces: ReceiptWorkspace[]): ReceiptWorkspace[] {
  const seen = new Set<string>();
  const result: ReceiptWorkspace[] = [];
  for (const workspace of workspaces) {
    if (seen.has(workspace.workspaceDir)) {
      continue;
    }
    seen.add(workspace.workspaceDir);
    result.push(workspace);
  }
  return result;
}

async function readLanguageCandidateCaptureStats(
  workspaceDir: string,
  cfg: FeishuConfig,
): Promise<LanguageCandidateCaptureStats> {
  const candidateRoot = path.join(workspaceDir, "memory", "lark-language-routing-candidates");
  const reviewRoot = path.join(workspaceDir, "memory", "lark-language-routing-reviews");
  const candidateFiles = await walkJsonFiles(candidateRoot);
  const reviewFiles = await walkJsonFiles(reviewRoot);
  let candidateArtifactCount = 0;
  let candidateCount = 0;
  let acceptedCaseCount = 0;
  let rejectedCount = 0;
  let discardedCount = 0;
  const reasonCounts: Record<string, number> = {};
  const semanticFamilyCounts: Record<string, number> = {};
  const rejectedReasonCounts: Record<string, number> = {};
  const rejectedSemanticFamilyCounts: Record<string, number> = {};
  const rejectedExamples: LanguageRejectedCandidateExample[] = [];
  const currentReplay = {
    candidateCount: 0,
    acceptedCaseCount: 0,
    rejectedCount: 0,
    discardedCount: 0,
    reasonCounts: {} as Record<string, number>,
    semanticFamilyCounts: {} as Record<string, number>,
    rejectedReasonCounts: {} as Record<string, number>,
    rejectedSemanticFamilyCounts: {} as Record<string, number>,
    rejectedExamples: [] as LanguageRejectedCandidateExample[],
  };
  let latestCandidatePath: string | null = null;
  let latestCandidateGeneratedAt: string | null = null;
  for (const filePath of candidateFiles) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      if (parsed.boundary !== "language_routing_only") {
        continue;
      }
      candidateArtifactCount += 1;
      const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      candidateCount += candidates.length;
      const evaluation =
        parsed.evaluation &&
        typeof parsed.evaluation === "object" &&
        !Array.isArray(parsed.evaluation)
          ? (parsed.evaluation as Record<string, unknown>)
          : {};
      const counts =
        evaluation.counts &&
        typeof evaluation.counts === "object" &&
        !Array.isArray(evaluation.counts)
          ? (evaluation.counts as Record<string, unknown>)
          : {};
      acceptedCaseCount += numberValue(counts.accepted);
      rejectedCount += numberValue(counts.rejected);
      discardedCount += numberValue(counts.discarded);
      accumulateLanguageEvaluationStats({
        evaluation,
        reasonCounts,
        semanticFamilyCounts,
        rejectedReasonCounts,
        rejectedSemanticFamilyCounts,
        rejectedExamples,
        artifactPath: path.relative(workspaceDir, filePath).replaceAll(path.sep, "/"),
      });
      if (candidates.length > 0) {
        const replay = evaluateLarkRoutingCandidateCorpus({
          cfg,
          corpus: {
            schemaVersion: 1,
            boundary: "language_routing_only",
            generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
            candidates: candidates as never,
          },
          evaluatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : undefined,
        });
        currentReplay.candidateCount += candidates.length;
        currentReplay.acceptedCaseCount += replay.counts.accepted;
        currentReplay.rejectedCount += replay.counts.rejected;
        currentReplay.discardedCount += replay.counts.discarded;
        accumulateLanguageEvaluationStats({
          evaluation: replay as unknown as Record<string, unknown>,
          reasonCounts: currentReplay.reasonCounts,
          semanticFamilyCounts: currentReplay.semanticFamilyCounts,
          rejectedReasonCounts: currentReplay.rejectedReasonCounts,
          rejectedSemanticFamilyCounts: currentReplay.rejectedSemanticFamilyCounts,
          rejectedExamples: currentReplay.rejectedExamples,
          artifactPath: path.relative(workspaceDir, filePath).replaceAll(path.sep, "/"),
        });
      }
      const generatedAt =
        typeof parsed.generatedAt === "string" && parsed.generatedAt.trim()
          ? parsed.generatedAt
          : null;
      if ((generatedAt ?? "") >= (latestCandidateGeneratedAt ?? "")) {
        latestCandidateGeneratedAt = generatedAt;
        latestCandidatePath = path.relative(workspaceDir, filePath).replaceAll(path.sep, "/");
      }
    } catch {
      continue;
    }
  }

  let reviewArtifactCount = 0;
  let promotedCaseCount = 0;
  let latestReviewPath: string | null = null;
  let latestReviewGeneratedAt: string | null = null;
  for (const filePath of reviewFiles) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      if (parsed.boundary !== "language_routing_only") {
        continue;
      }
      reviewArtifactCount += 1;
      promotedCaseCount += Array.isArray(parsed.promotedCases) ? parsed.promotedCases.length : 0;
      const generatedAt =
        typeof parsed.generatedAt === "string" && parsed.generatedAt.trim()
          ? parsed.generatedAt
          : null;
      if ((generatedAt ?? "") >= (latestReviewGeneratedAt ?? "")) {
        latestReviewGeneratedAt = generatedAt;
        latestReviewPath = path.relative(workspaceDir, filePath).replaceAll(path.sep, "/");
      }
    } catch {
      continue;
    }
  }

  const stats = {
    workspaceDir,
    candidateArtifactCount,
    candidateCount,
    acceptedCaseCount,
    rejectedCount,
    discardedCount,
    reasonCounts,
    semanticFamilyCounts,
    rejectedReasonCounts,
    rejectedSemanticFamilyCounts,
    rejectedExamples,
    currentReplay,
    latestCandidatePath,
    latestCandidateGeneratedAt,
    reviewArtifactCount,
    promotedCaseCount,
    latestReviewPath,
    latestReviewGeneratedAt,
  };
  return {
    ...stats,
    autodataLoop: summarizeLanguageAutodataLoop(stats),
  };
}

function resolveReceiptWorkspaces(opts: LarkLoopDiagnoseCommandOptions): ReceiptWorkspace[] {
  if (opts.workspaceDir?.trim()) {
    return [
      {
        agentId: opts.agent?.trim() || null,
        workspaceDir: path.resolve(resolveUserPath(opts.workspaceDir.trim())),
      },
    ];
  }
  const cfg = loadConfig();
  const agentIds = opts.agent?.trim() ? [opts.agent.trim()] : listAgentIds(cfg);
  if (agentIds.length === 0) {
    const agentId = resolveDefaultAgentId(cfg);
    return [{ agentId, workspaceDir: resolveAgentWorkspaceDir(cfg, agentId) }];
  }
  return dedupeReceiptWorkspaces(
    agentIds.map((agentId) => ({
      agentId,
      workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    })),
  );
}

async function readSingleReceiptStats(workspace: ReceiptWorkspace): Promise<ReceiptStats> {
  const workspaceDir = workspace.workspaceDir;
  const root = path.join(workspaceDir, "memory", "lark-language-handoff-receipts");
  const files = await walkJsonFiles(root);
  let latestPath: string | null = null;
  let latestGeneratedAt: string | null = null;
  let latestParsed: Record<string, unknown> | null = null;
  let latestFilePath: string | null = null;
  let financeOrchestrationCount = 0;
  let latestFinanceOrchestration: FinanceOrchestrationReceiptSummary | null = null;
  for (const filePath of files) {
    let generatedAt: string | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      generatedAt =
        typeof parsed.generatedAt === "string" && parsed.generatedAt.trim()
          ? parsed.generatedAt
          : null;
      const financeSummary = summarizeFinanceOrchestrationReceipt({
        workspaceDir,
        filePath,
        parsed,
      });
      if (financeSummary) {
        financeOrchestrationCount += 1;
        if ((financeSummary.generatedAt ?? "") >= (latestFinanceOrchestration?.generatedAt ?? "")) {
          latestFinanceOrchestration = financeSummary;
        }
      }
    } catch {
      generatedAt = null;
    }
    if ((generatedAt ?? "") >= (latestGeneratedAt ?? "")) {
      latestGeneratedAt = generatedAt;
      latestPath = path.relative(workspaceDir, filePath).replaceAll(path.sep, "/");
      try {
        latestParsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
        latestFilePath = filePath;
      } catch {
        latestParsed = null;
        latestFilePath = null;
      }
    }
  }
  const latestReceiptFinanceReplay =
    latestParsed && latestFilePath
      ? summarizeFinanceOrchestrationReplay({
          workspaceDir,
          filePath: latestFilePath,
          parsed: latestParsed,
        })
      : null;
  return {
    agentId: workspace.agentId,
    workspaceDir,
    count: files.length,
    latestPath,
    latestGeneratedAt,
    financeOrchestrationCount,
    latestFinanceOrchestration,
    latestReceiptFinanceReplay,
  };
}

export async function readReceiptStats(
  opts: LarkLoopDiagnoseCommandOptions,
): Promise<AggregateReceiptStats> {
  const workspaces = await Promise.all(resolveReceiptWorkspaces(opts).map(readSingleReceiptStats));
  let latestPath: string | null = null;
  let latestGeneratedAt: string | null = null;
  let latestWorkspaceDir: string | null = null;
  let financeOrchestrationCount = 0;
  let latestFinanceOrchestration: FinanceOrchestrationReceiptSummary | null = null;
  let latestReceiptFinanceReplay: FinanceOrchestrationReceiptSummary | null = null;
  let count = 0;
  for (const workspace of workspaces) {
    count += workspace.count;
    financeOrchestrationCount += workspace.financeOrchestrationCount;
    if ((workspace.latestGeneratedAt ?? "") >= (latestGeneratedAt ?? "") && workspace.latestPath) {
      latestGeneratedAt = workspace.latestGeneratedAt;
      latestPath = workspace.latestPath;
      latestWorkspaceDir = workspace.workspaceDir;
      latestReceiptFinanceReplay = workspace.latestReceiptFinanceReplay;
    }
    if (
      (workspace.latestFinanceOrchestration?.generatedAt ?? "") >=
        (latestFinanceOrchestration?.generatedAt ?? "") &&
      workspace.latestFinanceOrchestration
    ) {
      latestFinanceOrchestration = workspace.latestFinanceOrchestration;
    }
  }
  return {
    workspaceDir:
      workspaces.length === 1
        ? (workspaces[0]?.workspaceDir ?? "")
        : (latestWorkspaceDir ?? "multiple"),
    count,
    latestPath,
    latestGeneratedAt,
    financeOrchestrationCount,
    latestFinanceOrchestration,
    latestReceiptFinanceReplay,
    workspaces,
  };
}

function checkGatewayModelParamSchema(): GatewayModelParamSchemaCheck {
  const ok = validateAgentParams({
    message: "schema smoke",
    agentId: "main",
    sessionKey: "agent:main:lark-loop-diagnose-schema-smoke",
    model: "moonshot/kimi-k2.5",
    idempotencyKey: "lark-loop-diagnose-schema-smoke",
  });
  return {
    ok,
    error: ok ? null : formatValidationErrors(validateAgentParams.errors),
  };
}

function formatDiagnosisText(payload: Record<string, unknown>): string {
  const localLoop = payload.localLoop as Record<string, unknown>;
  const receipts = payload.liveHandoffReceipts as AggregateReceiptStats;
  const languageCandidates = payload.languageCandidates as LanguageCandidateCaptureStats;
  const gatewaySchema = payload.gatewayAgentModelParamSchema as GatewayModelParamSchemaCheck;
  const scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "unknown";
  const lines = [
    "LCX Lark loop diagnosis",
    "",
    `localLoop: ${localLoop.ok ? "ok" : "failed"}`,
    `localFamily: ${scalar(localLoop.family)}`,
    `localBackendTool: ${scalar(localLoop.backendTool)}`,
    `localAnalysis: ${scalar(localLoop.analysisStatus)}`,
    `gatewayAgentModelParamSchema: ${gatewaySchema.ok ? "ok" : "failed"}`,
    `liveHandoffReceipts: ${receipts.count}`,
    `receiptWorkspaces: ${receipts.workspaces.length}`,
    `languageCandidateArtifacts: ${languageCandidates.candidateArtifactCount}`,
    `languageCandidates: ${languageCandidates.candidateCount}`,
    `languageAcceptedCases: ${languageCandidates.acceptedCaseCount}`,
    `languageRejectedByReason: ${JSON.stringify(languageCandidates.rejectedReasonCounts)}`,
    `languageRejectedBySemanticFamily: ${JSON.stringify(languageCandidates.rejectedSemanticFamilyCounts)}`,
    `languageRejectedExamples: ${languageCandidates.rejectedExamples.length}`,
    `languageCurrentReplayAcceptedCases: ${languageCandidates.currentReplay.acceptedCaseCount}`,
    `languageCurrentReplayRejectedByReason: ${JSON.stringify(languageCandidates.currentReplay.rejectedReasonCounts)}`,
    `languageCurrentReplayRejectedBySemanticFamily: ${JSON.stringify(languageCandidates.currentReplay.rejectedSemanticFamilyCounts)}`,
    `languageCurrentReplayRejectedExamples: ${languageCandidates.currentReplay.rejectedExamples.length}`,
    `languageAutodataLoopStatus: ${languageCandidates.autodataLoop.status}`,
    `languageAutodataLoopAcceptanceRate: ${languageCandidates.autodataLoop.currentReplayAcceptanceRate}`,
    `languageAutodataLoopNextBatchFocus: ${languageCandidates.autodataLoop.nextBatchFocus.join(", ")}`,
    `languageReviews: ${languageCandidates.reviewArtifactCount}`,
    `languagePromotedCases: ${languageCandidates.promotedCaseCount}`,
  ];
  for (const workspace of receipts.workspaces) {
    lines.push(
      `  - ${workspace.agentId ?? "workspace"}: ${workspace.count} (${workspace.workspaceDir})`,
    );
  }
  if (receipts.latestPath) {
    lines.push(`latestReceipt: ${receipts.latestPath}`);
  }
  if (languageCandidates.latestCandidatePath) {
    lines.push(`latestLanguageCandidate: ${languageCandidates.latestCandidatePath}`);
  }
  if (languageCandidates.latestReviewPath) {
    lines.push(`latestLanguageReview: ${languageCandidates.latestReviewPath}`);
  }
  const rejectedExamplesForText =
    languageCandidates.currentReplay.rejectedExamples.length > 0
      ? languageCandidates.currentReplay.rejectedExamples
      : languageCandidates.rejectedExamples;
  for (const example of rejectedExamplesForText.slice(0, 5)) {
    const artifactSuffix = example.artifactPath ? ` · ${example.artifactPath}` : "";
    lines.push(
      `  rejectedExample[${example.reason}/${example.semanticFamily}]: ${example.utterance}${artifactSuffix}`,
    );
  }
  lines.push(`financeOrchestrationReceipts: ${receipts.financeOrchestrationCount}`);
  if (receipts.latestFinanceOrchestration) {
    lines.push(`latestFinanceOrchestration: ${receipts.latestFinanceOrchestration.receiptPath}`);
    lines.push(
      `latestFinanceModules: ${receipts.latestFinanceOrchestration.primaryModules.join(", ")}`,
    );
    lines.push(
      `latestFinanceTools: ${receipts.latestFinanceOrchestration.requiredTools.join(", ")}`,
    );
  }
  if (receipts.latestReceiptFinanceReplay) {
    lines.push(`latestReceiptFinanceReplay: ${receipts.latestReceiptFinanceReplay.receiptPath}`);
    lines.push(
      `latestReceiptReplayModules: ${receipts.latestReceiptFinanceReplay.primaryModules.join(", ")}`,
    );
    lines.push(
      `latestReceiptReplayTools: ${receipts.latestReceiptFinanceReplay.requiredTools.join(", ")}`,
    );
  }
  if (gatewaySchema.error) {
    lines.push(`gatewayAgentModelParamSchemaError: ${gatewaySchema.error}`);
  }
  lines.push("");
  lines.push(`nextBlocker: ${String(payload.nextBlocker)}`);
  return lines.join("\n");
}

export async function larkLoopDiagnoseCommand(
  opts: LarkLoopDiagnoseCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = loadConfig();
  const feishuCfg = (cfg.channels?.feishu ?? {}) as FeishuConfig;
  const gatewayAgentModelParamSchema = checkGatewayModelParamSchema();
  const [localLoop, liveHandoffReceipts] = await Promise.all([
    runLanguageBrainLoopSmoke({ fixtureDir: opts.fixtureDir }),
    readReceiptStats(opts),
  ]);
  const languageCandidates = await readLanguageCandidateCaptureStats(
    liveHandoffReceipts.workspaceDir === "multiple"
      ? resolveReceiptWorkspaces(opts)[0]?.workspaceDir || process.cwd()
      : liveHandoffReceipts.workspaceDir,
    feishuCfg,
  );
  const payload = {
    ok: localLoop.ok && liveHandoffReceipts.count > 0 && gatewayAgentModelParamSchema.ok,
    gatewayAgentModelParamSchema,
    localLoop: {
      ok: localLoop.ok,
      family: localLoop.language.family,
      backendTool: localLoop.language.backendTool,
      analysisStatus: localLoop.analysis.eventReviewStatus,
      orchestration: localLoop.orchestration,
      noActionBoundary: localLoop.analysis.noActionBoundary,
      receiptPath: localLoop.memory.loopReceiptPath,
    },
    liveHandoffReceipts,
    languageCandidates,
    nextBlocker: !gatewayAgentModelParamSchema.ok
      ? "gateway_agent_model_param_schema_rejects_learning_council"
      : liveHandoffReceipts.count > 0
        ? "none"
        : "no_live_lark_user_inbound_handoff_receipt_yet",
    boundaries: {
      noRemoteFetchOccurred: localLoop.noRemoteFetchOccurred,
      noExecutionAuthority: localLoop.noExecutionAuthority,
      protectedMemoryUntouched: localLoop.protectedMemoryUntouched,
      localLoopDoesNotProveLiveIngress: true,
    },
  };
  runtime.log(opts.json ? JSON.stringify(payload, null, 2) : formatDiagnosisText(payload));
}
