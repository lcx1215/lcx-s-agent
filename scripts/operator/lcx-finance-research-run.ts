import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  createApiSourceGovernanceRegistry,
  type ApiCallReceipt,
} from "../../src/agents/api-call-contract.ts";
import type { FinanceDecisionMode } from "../../src/agents/finance-decision-policy.ts";
import { resolveFinanceMarketCollectionRegistryOptionsFromEnv } from "../../src/agents/finance-market-collection-registry.ts";
import { createFinanceModelWorkflow } from "../../src/agents/finance-model-workflow.ts";
import {
  FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID,
  FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
  FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS,
  FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
  assertFinanceNightResearchAsOf,
  readFinanceActiveStrategyResearchScope,
  readFinanceNightReviewResearchScope,
  type FinanceNightResearchInstrument,
  type FinanceNightResearchScope,
} from "../../src/agents/finance-night-review-context.ts";
import { resolveFinanceRealtimeSourceRegistryOptionsFromEnv } from "../../src/agents/finance-realtime-source-registry.ts";
import {
  buildDefaultFinanceResearchTargets,
  financeResearchPortfolioContextSchema,
  runFinanceResearchRun,
  readFinanceResearchEquityUniverseSnapshot,
  type FinanceResearchRunInput,
  type FinanceResearchRunReceipt,
} from "../../src/agents/finance-research-runner.ts";
import {
  persistFinanceResearchThesisLearning,
  validateFinanceResearchThesisProposals,
  type FinanceResearchThesisLearningResult,
} from "../../src/agents/finance-research-thesis-learning.ts";
import { resolveFinanceStateDir } from "../../src/agents/finance-state-dir.ts";
import {
  createLocalQualityHarnessAdapter,
  type LocalTextModelRuntimeConfig,
} from "../../src/agents/local-text-model-adapter.ts";
import type { LogicalAgentModelRouting } from "../../src/agents/logical-agent-model-router.ts";
import { QUALITY_HARNESS_MAX_EVIDENCE_ITEMS } from "../../src/agents/quality-harness-contract.ts";
import { loadConfig } from "../../src/config/config.ts";
import {
  FinanceResearchRunFailure,
  runCheckpointedFinanceResearch,
} from "./lcx-finance-research-checkpoint-run.ts";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

const execFileAsync = promisify(execFile);
const WORKSPACE_DIR = () => process.env.OPENCLAW_WORKSPACE_DIR?.trim() || DEFAULT_WORKSPACE_DIR;

const DEFAULT_ASK =
  "分析过去六个月加密货币和美股的市场情绪、最近美股上涨的驱动，以及美国中期选举后可能发生什么。";
const DEFAULT_MODEL_ID = "Qwen/Qwen3-0.6B";
const MAX_HORIZON_MONTHS = 120;
const MAX_RESEARCH_ASK_BYTES = 32_768;
const MAX_MODEL_TOKENS = 16_384;
const MAX_MODEL_TIMEOUT_MS = 2_147_483_647;
// The local adapter compacts evidence and dependency output before prompting; allow the
// router to receive the contract's bounded 64-item quality packet before that compaction.
export const QUALITY_ROUTER_MAX_INPUT_BYTES = 1_000_000;

type Options = {
  ask: string;
  asOf?: string;
  horizonMonths: number;
  decisionMode: FinanceDecisionMode;
  live: boolean;
  workflowModels: boolean;
  executeModules: boolean;
  quality: boolean;
  write: boolean;
  persistTheses: boolean;
  financeStateDir?: string;
  adapterPath?: string;
  modelId: string;
  pythonPath?: string;
  maxTokens: number;
  timeoutMs: number;
  runTimeoutMs: number;
  maxModelCalls: number;
  maxModelConcurrency: 1 | 2;
  allowModelNetwork: boolean;
  maxApiCalls: number;
  maxConcurrency: number;
  maxSourcesPerJob: number;
  sourceTimeoutMs: number;
  totalTimeoutMs: number;
  retryAttempts: number;
  includeYahooPublicSources: boolean;
  portfolioContextPath?: string;
  portfolioPlanOut?: string;
  controllerEvidencePath?: string;
  controllerResearchScope: boolean;
  json: boolean;
  schedulerSummary?: boolean;
};

class HelpRequestedError extends Error {
  constructor() {
    super("help requested");
    this.name = "HelpRequestedError";
  }
}

function usage(): string {
  return [
    "Usage: node --import tsx scripts/operator/lcx-finance-research-run.ts [options]",
    "",
    "Runs the bounded finance research waterflow: source batch -> committee -> quality -> quarterly output.",
    "Dry plan is the default and never fetches sources or resolves a model adapter.",
    "",
    "Options:",
    `  --ask TEXT                         natural-language research question (max ${MAX_RESEARCH_ASK_BYTES} UTF-8 bytes)`,
    "  --as-of ISO                        observation cutoff (default: now)",
    `  --horizon-months N                 horizon for the research plan (default: 6, max: ${MAX_HORIZON_MONTHS})`,
    "  --decision-mode MODE               research_only|strategy_candidate|conditional_trade_candidate",
    "  --live                              fetch bounded public/provider sources and run the model DAG",
    "  --workflow-models                  authorize configured workflow models for research and review",
    "  --execute-modules                  execute the selected finance-module DAG with producer receipts",
    "  --skip-quality                     do not run the quality harness (live only)",
    "  --adapter DIR                      retired local override (not valid with workflow models)",
    "  --model MODEL                      retired local model override",
    "  --python PATH                      retired local Python override",
    `  --max-tokens N                     bounded workflow output tokens (default: 8192, max: ${MAX_MODEL_TOKENS})`,
    `  --timeout-ms N                     bounded workflow model timeout (max: ${MAX_MODEL_TIMEOUT_MS})`,
    "  --run-timeout-ms N                 source + model cancellation deadline (default: 840000)",
    "  --max-model-concurrency N          model DAG slots, 1 or 2 (default: 2)",
    "  --max-model-calls N                whole-run model attempt budget (default: 48)",
    "  --allow-model-network              retired local network override",
    "  --max-api-calls N                  hard source-attempt budget (default: 48, max: 10000)",
    "  --max-concurrency N                batch concurrency (default: 3)",
    "  --max-sources-per-job N            source adapters per job (default: 2)",
    `  --source-timeout-ms N              per-source timeout (default: 30000, max: ${MAX_MODEL_TIMEOUT_MS})`,
    `  --total-timeout-ms N               whole batch timeout (default: 180000, max: ${MAX_MODEL_TIMEOUT_MS})`,
    "  --retry-attempts N                 attempts per adapter (default: 1)",
    "  --include-yahoo-public-sources     explicitly opt in to Yahoo public adapters",
    "  --portfolio-context FILE           controller-owned active-strategy/account envelope",
    "  --portfolio-plan-out FILE          atomically write a verified portfolio plan",
    "  --controller-evidence FILE         timestamped controller-owned local evidence packet",
    "  --controller-research-scope        target only the unique typed night scope in controller evidence (research_only)",
    "  --persist-theses                   store only fully gated, source-linked research thesis candidates",
    "  --finance-state-dir DIR            exact existing finance state root (required with --persist-theses)",
    "  --write                            write the full receipt to workspace state",
    "  --json                             emit a JSON summary",
    "  --scheduler-summary                emit compact status and persisted receipt paths",
  ].join("\n");
}

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInteger(value: string, flag: string, max?: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (max !== undefined && parsed > max)) {
    throw new Error(`${flag} must be a positive integer${max === undefined ? "" : ` <= ${max}`}`);
  }
  return parsed;
}

function decisionMode(value: string): FinanceDecisionMode {
  if (
    value === "research_only" ||
    value === "strategy_candidate" ||
    value === "conditional_trade_candidate"
  ) {
    return value;
  }
  throw new Error(
    "--decision-mode must be research_only, strategy_candidate, or conditional_trade_candidate",
  );
}

export function parseArgs(args: readonly string[]): Options {
  const options: Options = {
    ask: DEFAULT_ASK,
    horizonMonths: 6,
    decisionMode: "research_only",
    live: false,
    workflowModels: false,
    executeModules: false,
    quality: true,
    write: false,
    persistTheses: false,
    controllerResearchScope: false,
    modelId: DEFAULT_MODEL_ID,
    maxTokens: 8_192,
    timeoutMs: 120_000,
    runTimeoutMs: 840_000,
    maxModelCalls: 48,
    maxModelConcurrency: 2,
    allowModelNetwork: false,
    maxApiCalls: 48,
    maxConcurrency: 3,
    maxSourcesPerJob: 2,
    sourceTimeoutMs: 30_000,
    totalTimeoutMs: 180_000,
    retryAttempts: 1,
    includeYahooPublicSources: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ask") {
      options.ask = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--as-of") {
      options.asOf = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--horizon-months") {
      options.horizonMonths = positiveInteger(readValue(args, index, arg), arg, MAX_HORIZON_MONTHS);
      index += 1;
    } else if (arg === "--decision-mode") {
      options.decisionMode = decisionMode(readValue(args, index, arg));
      index += 1;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--workflow-models") {
      options.workflowModels = true;
    } else if (arg === "--execute-modules") {
      options.executeModules = true;
    } else if (arg === "--skip-quality") {
      options.quality = false;
    } else if (arg === "--adapter") {
      options.adapterPath = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--model") {
      options.modelId = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--python") {
      options.pythonPath = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-tokens") {
      options.maxTokens = positiveInteger(readValue(args, index, arg), arg, MAX_MODEL_TOKENS);
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInteger(readValue(args, index, arg), arg, MAX_MODEL_TIMEOUT_MS);
      index += 1;
    } else if (arg === "--run-timeout-ms") {
      options.runTimeoutMs = positiveInteger(
        readValue(args, index, arg),
        arg,
        MAX_MODEL_TIMEOUT_MS,
      );
      index += 1;
    } else if (arg === "--max-model-concurrency") {
      options.maxModelConcurrency = positiveInteger(readValue(args, index, arg), arg, 2) as 1 | 2;
      index += 1;
    } else if (arg === "--max-model-calls") {
      options.maxModelCalls = positiveInteger(readValue(args, index, arg), arg, 10_000);
      index += 1;
    } else if (arg === "--allow-model-network") {
      options.allowModelNetwork = true;
    } else if (arg === "--max-api-calls") {
      options.maxApiCalls = positiveInteger(readValue(args, index, arg), arg, 10_000);
      index += 1;
    } else if (arg === "--max-concurrency") {
      options.maxConcurrency = positiveInteger(readValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--max-sources-per-job") {
      options.maxSourcesPerJob = positiveInteger(readValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--source-timeout-ms") {
      options.sourceTimeoutMs = positiveInteger(
        readValue(args, index, arg),
        arg,
        MAX_MODEL_TIMEOUT_MS,
      );
      index += 1;
    } else if (arg === "--total-timeout-ms") {
      options.totalTimeoutMs = positiveInteger(
        readValue(args, index, arg),
        arg,
        MAX_MODEL_TIMEOUT_MS,
      );
      index += 1;
    } else if (arg === "--retry-attempts") {
      options.retryAttempts = positiveInteger(readValue(args, index, arg), arg, 3);
      index += 1;
    } else if (arg === "--include-yahoo-public-sources") {
      options.includeYahooPublicSources = true;
    } else if (arg === "--portfolio-context") {
      options.portfolioContextPath = path.resolve(readValue(args, index, arg));
      index += 1;
    } else if (arg === "--portfolio-plan-out") {
      options.portfolioPlanOut = path.resolve(readValue(args, index, arg));
      index += 1;
    } else if (arg === "--controller-evidence") {
      options.controllerEvidencePath = path.resolve(readValue(args, index, arg));
      index += 1;
    } else if (arg === "--controller-research-scope") {
      options.controllerResearchScope = true;
    } else if (arg === "--persist-theses") {
      options.persistTheses = true;
    } else if (arg === "--finance-state-dir") {
      options.financeStateDir = path.resolve(readValue(args, index, arg));
      index += 1;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--scheduler-summary") {
      options.schedulerSummary = true;
      options.json = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new HelpRequestedError();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (
    options.workflowModels &&
    args.some((arg) => ["--adapter", "--model", "--python", "--allow-model-network"].includes(arg))
  ) {
    throw new Error("--workflow-models cannot combine local model overrides");
  }
  if (options.portfolioPlanOut && !options.portfolioContextPath) {
    throw new Error("--portfolio-plan-out requires --portfolio-context");
  }
  if (
    options.portfolioContextPath &&
    (!options.live || !options.workflowModels || !options.write)
  ) {
    throw new Error(
      "--portfolio-context requires --live --workflow-models --write so an allocation proposal has source, model and quality receipts",
    );
  }
  if (options.portfolioContextPath && options.decisionMode !== "strategy_candidate") {
    throw new Error("--portfolio-context requires --decision-mode strategy_candidate");
  }
  if (options.executeModules && (!options.live || !options.workflowModels || !options.write)) {
    throw new Error("--execute-modules requires --live --workflow-models --write");
  }
  if (
    options.controllerEvidencePath &&
    (!options.live || !options.workflowModels || !options.write)
  ) {
    throw new Error("--controller-evidence requires --live --workflow-models --write");
  }
  if (options.controllerResearchScope && !options.controllerEvidencePath) {
    throw new Error("--controller-research-scope requires --controller-evidence");
  }
  if (options.controllerResearchScope && !options.financeStateDir) {
    throw new Error("--controller-research-scope requires --finance-state-dir");
  }
  if (options.controllerResearchScope && options.decisionMode !== "research_only") {
    throw new Error("--controller-research-scope requires --decision-mode research_only");
  }
  if (options.controllerResearchScope && options.portfolioContextPath) {
    throw new Error("--controller-research-scope cannot be combined with --portfolio-context");
  }
  if (
    options.persistTheses &&
    (!options.live || !options.workflowModels || !options.write || !options.quality)
  ) {
    throw new Error(
      "--persist-theses requires --live --workflow-models --write with quality enabled",
    );
  }
  if (options.persistTheses && !options.financeStateDir) {
    throw new Error("--persist-theses requires an exact --finance-state-dir");
  }
  return options;
}

export function assertResearchAsk(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("--ask is required");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_RESEARCH_ASK_BYTES) {
    throw new Error(`--ask must be <= ${MAX_RESEARCH_ASK_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

export function parseControllerResearchScope(
  evidence: NonNullable<FinanceResearchRunInput["controllerEvidence"]>,
  asOf: string,
): FinanceNightResearchScope {
  assertFinanceNightResearchAsOf(asOf);
  const matching = evidence.filter(
    (item) =>
      item.id === FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID ||
      item.source === FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
  );
  if (
    matching.length !== 1 ||
    matching[0]?.id !== FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID ||
    matching[0]?.source !== FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE
  ) {
    throw new Error("--controller-research-scope requires exactly one canonical night scope item");
  }
  if (matching[0].timestamp !== asOf) {
    throw new Error("controller night research scope evidence timestamp does not match --as-of");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(matching[0].text);
  } catch {
    throw new Error("controller night research scope is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("controller night research scope must be an object");
  }
  const scope = raw as Record<string, unknown>;
  if (
    scope.schemaVersion !== FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION ||
    scope.asOf !== asOf ||
    !Array.isArray(scope.activeStrategyIds) ||
    scope.activeStrategyIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(scope.activeStrategyIds).size !== scope.activeStrategyIds.length ||
    !Array.isArray(scope.instruments) ||
    scope.instruments.length === 0 ||
    scope.instruments.length > FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS
  ) {
    throw new Error("controller night research scope is invalid or does not match --as-of");
  }
  const seen = new Set<string>();
  const isSupportedIdentity = (instrument: string, assetClass: unknown) =>
    assetClass === "crypto"
      ? /^[A-Z0-9]{2,12}\/USD$/u.test(instrument)
      : assetClass === "us_equity"
        ? /^[A-Z]{1,5}(?:\.[A-Z])?$/u.test(instrument)
        : false;
  const instruments = scope.instruments.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`controller night research scope instrument ${index} must be an object`);
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.instrument !== "string" ||
      typeof item.assetClass !== "string" ||
      (item.assetClass !== "us_equity" && item.assetClass !== "crypto") ||
      !Array.isArray(item.reasons) ||
      item.reasons.length === 0 ||
      item.reasons.some((reason) => reason !== "held_position" && reason !== "active_strategy")
    ) {
      throw new Error(`controller night research scope instrument ${index} is malformed`);
    }
    const instrument = item.instrument.trim().toUpperCase();
    if (!isSupportedIdentity(instrument, item.assetClass)) {
      throw new Error(
        `controller night research scope has unsupported instrument identity: ${instrument}`,
      );
    }
    const key = `${item.assetClass}:${instrument}`;
    if (!instrument || seen.has(key)) {
      throw new Error(
        `controller night research scope has empty or duplicate instrument: ${instrument}`,
      );
    }
    seen.add(key);
    return Object.freeze({
      instrument,
      assetClass: item.assetClass,
      reasons: Object.freeze(
        [...item.reasons].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      ) as FinanceNightResearchInstrument["reasons"],
    }) as FinanceNightResearchInstrument;
  });
  let coverage: FinanceNightResearchScope["coverage"];
  if (scope.coverage !== undefined) {
    if (
      typeof scope.coverage !== "object" ||
      scope.coverage === null ||
      Array.isArray(scope.coverage)
    ) {
      throw new Error("controller night research scope coverage is malformed");
    }
    const rawCoverage = scope.coverage as Record<string, unknown>;
    if (
      !Number.isSafeInteger(rawCoverage.totalInstrumentCount) ||
      (rawCoverage.totalInstrumentCount as number) <= instruments.length ||
      rawCoverage.selectionMethod !== "held_priority_et_date_rotation_v1" ||
      !Array.isArray(rawCoverage.deferredInstruments) ||
      rawCoverage.deferredInstruments.length === 0 ||
      (rawCoverage.totalInstrumentCount as number) !==
        instruments.length + rawCoverage.deferredInstruments.length
    ) {
      throw new Error("controller night research scope coverage is invalid");
    }
    const deferredInstruments = rawCoverage.deferredInstruments.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(
          `controller night research scope deferred instrument ${index} is malformed`,
        );
      }
      const item = value as Record<string, unknown>;
      if (
        typeof item.instrument !== "string" ||
        typeof item.assetClass !== "string" ||
        (item.assetClass !== "us_equity" && item.assetClass !== "crypto") ||
        !Array.isArray(item.reasons) ||
        item.reasons.length === 0 ||
        item.reasons.some((reason) => reason !== "held_position" && reason !== "active_strategy") ||
        new Set(item.reasons).size !== item.reasons.length
      ) {
        throw new Error(
          `controller night research scope deferred instrument ${index} is malformed`,
        );
      }
      const instrument = item.instrument.trim().toUpperCase();
      if (!isSupportedIdentity(instrument, item.assetClass)) {
        throw new Error(
          `controller night research scope has unsupported instrument identity: ${instrument}`,
        );
      }
      const key = `${item.assetClass}:${instrument}`;
      if (!instrument || seen.has(key)) {
        throw new Error(
          `controller night research scope has empty or duplicate instrument: ${instrument}`,
        );
      }
      seen.add(key);
      return Object.freeze({
        instrument,
        assetClass: item.assetClass,
        reasons: Object.freeze(
          [...item.reasons].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
        ) as FinanceNightResearchInstrument["reasons"],
      }) as FinanceNightResearchInstrument;
    });
    coverage = Object.freeze({
      totalInstrumentCount: rawCoverage.totalInstrumentCount as number,
      deferredInstruments: Object.freeze(deferredInstruments),
      selectionMethod: "held_priority_et_date_rotation_v1",
    });
  }
  return Object.freeze({
    schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
    asOf,
    activeStrategyIds: Object.freeze([...(scope.activeStrategyIds as string[])]),
    instruments: Object.freeze(instruments),
    ...(coverage ? { coverage } : {}),
  });
}

export function buildControllerNightResearchTargets(params: {
  ask: string;
  asOf: string;
  horizonMonths: number;
  instruments: readonly FinanceNightResearchInstrument[];
}) {
  return buildDefaultFinanceResearchTargets(
    params.ask,
    params.horizonMonths,
    params.asOf,
    undefined,
    undefined,
    params.instruments,
  );
}

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/u;

export function assertIsoTimestamp(value: string): string {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  const year = match ? Number(match[1]) : Number.NaN;
  const month = match ? Number(match[2]) : Number.NaN;
  const day = match ? Number(match[3]) : Number.NaN;
  const daysInMonth =
    month === 2
      ? 28 + Number(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (
    !match ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("--as-of must be an ISO timestamp");
  }
  return new Date(value).toISOString();
}

function routingRevision(prefix: string, runtime: LocalTextModelRuntimeConfig): string {
  return `${prefix}-${createHash("sha256")
    .update(`${runtime.adapterPath}:${runtime.modelId}`)
    .digest("hex")
    .slice(0, 12)}`;
}

export function buildFinanceResearchCommitteeRouting(
  runtime: LocalTextModelRuntimeConfig,
): LogicalAgentModelRouting {
  const adapter = createLocalQualityHarnessAdapter(runtime);
  return {
    revision: routingRevision("finance-local-committee-v1", runtime),
    adapters: [adapter],
    defaultPolicy: {
      primary: adapter.id,
      requiredCapabilities: ["quality_harness"],
      maxInputBytes: QUALITY_ROUTER_MAX_INPUT_BYTES,
      timeoutMs: runtime.timeoutMs,
    },
  };
}

function compactApiCall(call: ApiCallReceipt) {
  return {
    provider: call.provider,
    source: call.source,
    operation: call.operation,
    status: call.status,
    httpStatus: call.httpStatus,
    transportError: call.transportError,
    attempt: call.attempt,
    latencyMs: call.latencyMs,
    circuitState: call.circuitState,
    authScopeLabel: call.authScopeLabel,
    idempotencyKeyPresent: call.idempotencyKey !== undefined,
  };
}

function summarizeReceipt(receipt: FinanceResearchRunReceipt, options: Options) {
  const batch = receipt.batch;
  return {
    schemaVersion: "lcx_finance_research_operator_v1",
    boundary: "local_finance_research_run_only",
    request: {
      ask: receipt.plan.ask,
      asOf: receipt.plan.asOf,
      horizonMonths: receipt.plan.horizonMonths,
      decisionMode: receipt.plan.decisionMode,
      liveFetch: options.live,
      qualityRequested: options.quality,
      persistTheses: options.persistTheses,
    },
    status: receipt.status,
    answerDecision: receipt.answerDecision,
    ...(receipt.portfolioAbstention ? { portfolioAbstention: receipt.portfolioAbstention } : {}),
    plan: {
      asOf: receipt.plan.asOf,
      expectedJobCount: receipt.plan.expectedJobCount,
      targetIds: receipt.plan.targets.map((target) => target.id),
      orchestration: receipt.plan.orchestration,
      sourceInspectionCount: receipt.plan.sourceInspections.length,
      sourceInspections: receipt.plan.sourceInspections,
      boundaries: receipt.plan.boundaries,
    },
    batch: batch
      ? {
          schemaVersion: batch.schemaVersion,
          status: batch.status,
          correlationId: batch.correlationId,
          budget: batch.budget,
          jobs: batch.jobs.map((job) => ({
            jobId: job.jobId,
            targetId: job.targetId,
            kind: job.kind,
            request: job.request,
            status: job.status,
            missingEvidence: job.missingEvidence,
            freshnessWarnings: job.freshnessWarnings,
            conflicts: job.conflicts,
            error: job.error,
            sourceAttempts: job.receipt?.sourceAttempts?.map((attempt) => ({
              adapterId: attempt.adapterId,
              providerName: attempt.providerName,
              status: attempt.status,
              // Only the market-collection attempt carries a record count; a realtime refresh
              // attempt has none. Reading it off that branch is `undefined` either way, and
              // `JSON.stringify` drops undefined, so the emitted summary is unchanged.
              recordCount: "recordCount" in attempt ? attempt.recordCount : undefined,
              latencyMs: attempt.latencyMs,
              error: attempt.error,
              apiCalls: attempt.apiCalls?.map(compactApiCall),
            })),
            apiCalls: job.apiCalls.map(compactApiCall),
          })),
          committeeEvidenceCount: batch.committeeEvidence.length,
        }
      : undefined,
    committee: receipt.committee
      ? {
          coverage: receipt.committee.coverage,
          model: {
            ...receipt.committee.model,
            roleStatuses: receipt.committee.model.roleStatuses.map((role) => ({
              taskId: role.taskId,
              agentId: role.agentId,
              status: role.status,
              error: role.error,
            })),
          },
        }
      : undefined,
    quality: receipt.quality
      ? {
          status: receipt.quality.status,
          quality: receipt.quality.quality,
          verification: receipt.quality.verification,
          execution: {
            backend: receipt.quality.execution.backend,
            evidenceMode: receipt.quality.execution.evidenceMode,
            modelId: receipt.quality.execution.modelId,
            modelCallCount: receipt.quality.execution.modelCalls.length,
            realModelInferenceObserved: receipt.quality.execution.realModelInferenceObserved,
            allModelCallsAttested: receipt.quality.execution.allModelCallsAttested,
            providerCallsMade: receipt.quality.execution.providerCallsMade,
          },
          attempts: receipt.quality.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            status: attempt.status,
            planStatus: attempt.planStatus,
            gates: attempt.gates,
            verification: attempt.verification,
            stages: attempt.stages.map((stage) => ({
              taskId: stage.taskId,
              agentId: stage.agentId,
              status: stage.status,
              outputKind: stage.outputKind,
              error: stage.error,
              modelCalls: stage.modelCalls?.map((call) => ({
                outcome: call.outcome,
                reason: call.reason,
                evidence: call.evidence,
                realModelInferenceObserved: call.realModelInferenceObserved,
              })),
            })),
          })),
          repair: receipt.quality.repair,
          finalArtifact: receipt.quality.finalArtifact,
        }
      : undefined,
    quarterlyOutput: receipt.quarterlyOutput,
    gates: receipt.gates,
    missingEvidence: receipt.missingEvidence,
    notTouched: receipt.notTouched,
  };
}

async function writePrivateReceipt(filePath: string, serialized: string): Promise<void> {
  await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

async function probePrivateReceiptPath(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile("");
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, 0o600);
}

export async function preflightFinanceResearchReceiptDestination(
  asOf: string,
  root = WORKSPACE_DIR(),
): Promise<void> {
  const normalizedAsOf = assertIsoTimestamp(asOf);
  const stateDir = path.join(root, "state");
  const runDir = path.join(root, "state", "finance-research-runs", normalizedAsOf.slice(0, 10));
  const latestPath = path.join(stateDir, "lcx-finance-research-run-latest.json");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  try {
    const handle = await fs.open(latestPath, "r+");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const probes = [
    path.join(runDir, `.lcx-finance-research-${randomUUID()}.tmp`),
    path.join(stateDir, `.lcx-finance-research-${randomUUID()}.tmp`),
  ];
  try {
    for (const probe of probes) {
      await probePrivateReceiptPath(probe);
    }
  } finally {
    await Promise.all(probes.map((probe) => fs.rm(probe, { force: true })));
  }
}

export async function preflightLocalModelPythonRuntime(pythonPath: string): Promise<void> {
  const normalized = pythonPath.trim();
  if (!normalized) {
    throw new Error("retired local Python override is required");
  }
  try {
    await execFileAsync(normalized, ["-c", "import mlx.core, mlx_lm"], {
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
  } catch {
    throw new Error(`local model Python runtime cannot import mlx_lm: ${normalized}`);
  }
}

async function writeReceipt(receipt: FinanceResearchRunReceipt, asOf: string) {
  const root = WORKSPACE_DIR();
  const stateDir = path.join(root, "state");
  // `state/` is git-ignored and is where the agent-side research tool writes its own runs;
  // `memory/` is tracked, so a run archive dropped there becomes repository content.
  const runDir = path.join(root, "state", "finance-research-runs", asOf.slice(0, 10));
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const datedPath = path.join(runDir, `${stamp}__finance-research-run.json`);
  const latestPath = path.join(stateDir, "lcx-finance-research-run-latest.json");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  await writePrivateReceipt(datedPath, serialized);
  await writePrivateReceipt(latestPath, serialized);
  return { datedPath, latestPath };
}

export function buildFinanceResearchRegistryOptions(
  includeYahooPublicSources: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const realtimeRegistryOptions = resolveFinanceRealtimeSourceRegistryOptionsFromEnv(env);
  const collectionRegistryOptions = resolveFinanceMarketCollectionRegistryOptionsFromEnv(env);
  return {
    realtimeRegistryOptions: {
      ...realtimeRegistryOptions,
      ...(includeYahooPublicSources ? { includeYahooPublicSource: true } : {}),
    },
    collectionRegistryOptions: {
      ...collectionRegistryOptions,
      ...(includeYahooPublicSources ? { includeYahooPublicSources: true } : {}),
    },
  } as const;
}

async function writeVerifiedPortfolioPlan(filePath: string, plan: unknown): Promise<string> {
  const { financePortfolioPlanSchema } =
    await import("../../src/agents/finance-portfolio-composition.ts");
  const parsed = financePortfolioPlanSchema.parse(plan);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writePrivateReceipt(temporary, `${JSON.stringify(parsed, null, 2)}\n`);
  await fs.rename(temporary, filePath);
  return filePath;
}

export async function run(options: Options): Promise<{
  receipt: FinanceResearchRunReceipt;
  written?: unknown;
  portfolioPlanWritten?: string;
  thesisLearning?: FinanceResearchThesisLearningResult;
}> {
  const ask = assertResearchAsk(options.ask);
  const asOf = assertIsoTimestamp(options.asOf ?? new Date().toISOString());
  const asOfMode = options.live && options.asOf === undefined ? ("live_now" as const) : undefined;
  if (options.live && !options.write) {
    throw new Error("--write is required with --live to persist the full research receipt");
  }
  if (options.live && !options.workflowModels) {
    throw new Error(
      "local research/review roles retired: use --live --workflow-models --write to authorize the configured finance workflow; omit --live for a plan",
    );
  }
  if (
    options.workflowModels &&
    (options.adapterPath ||
      options.pythonPath ||
      options.modelId !== DEFAULT_MODEL_ID ||
      options.allowModelNetwork)
  ) {
    throw new Error("--workflow-models cannot combine local model overrides");
  }
  if (options.live) {
    await preflightFinanceResearchReceiptDestination(asOf);
  }
  if (options.financeStateDir) {
    const stateDirectory = await fs.stat(options.financeStateDir).catch(() => undefined);
    if (!stateDirectory?.isDirectory()) {
      throw new Error("--finance-state-dir must name an existing finance state directory");
    }
  }
  const suppliedControllerEvidence: NonNullable<FinanceResearchRunInput["controllerEvidence"]> =
    options.controllerEvidencePath
      ? JSON.parse(await fs.readFile(options.controllerEvidencePath, "utf8"))
      : [];
  const controllerResearchScope = options.controllerResearchScope
    ? parseControllerResearchScope(suppliedControllerEvidence, asOf)
    : undefined;
  if (controllerResearchScope) {
    const ledgerScope = await readFinanceNightReviewResearchScope({
      directory: resolveFinanceStateDir({ directory: options.financeStateDir }).directory,
      asOf,
    });
    if (JSON.stringify(ledgerScope) !== JSON.stringify(controllerResearchScope)) {
      throw new Error(
        "controller night research scope does not match the finance ledgers at --as-of",
      );
    }
  }
  const portfolioContext = options.portfolioContextPath
    ? financeResearchPortfolioContextSchema.parse(
        JSON.parse(await fs.readFile(options.portfolioContextPath, "utf8")),
      )
    : undefined;
  const strategyScope =
    options.portfolioContextPath && portfolioContext
      ? await readFinanceActiveStrategyResearchScope({
          directory: resolveFinanceStateDir({ directory: options.financeStateDir }).directory,
          asOf,
          strategyIds: portfolioContext.activeStrategyIds,
        })
      : undefined;
  const controllerPortfolioContext =
    portfolioContext && strategyScope
      ? financeResearchPortfolioContextSchema.parse({
          ...portfolioContext,
          requiredInstruments: strategyScope.instruments,
        })
      : portfolioContext;
  let equityUniverseSnapshot: FinanceResearchRunInput["equityUniverseSnapshot"];
  if (options.financeStateDir) {
    try {
      equityUniverseSnapshot = readFinanceResearchEquityUniverseSnapshot(
        options.financeStateDir,
        asOf,
      );
    } catch {
      // Preserve the planner's explicit missing-universe limitation; never substitute tickers.
      process.stderr.write(
        "controller equity universe unavailable or invalid; broad research remains scope-limited\n",
      );
    }
  }
  const input: FinanceResearchRunInput = {
    ask,
    asOf,
    horizonMonths: options.horizonMonths,
    decisionMode: options.decisionMode,
    ...(options.executeModules ? { executeModules: true } : {}),
    controllerEvidence: [...(strategyScope?.evidence ?? []), ...suppliedControllerEvidence],
    ...(strategyScope
      ? {
          targets: buildDefaultFinanceResearchTargets(
            ask,
            options.horizonMonths,
            asOf,
            equityUniverseSnapshot,
            strategyScope.instruments,
            undefined,
            strategyScope.intradayInstruments,
            strategyScope.historyMonths,
          ),
        }
      : {}),
    ...(controllerResearchScope
      ? {
          targets: buildControllerNightResearchTargets({
            ask,
            horizonMonths: options.horizonMonths,
            asOf,
            instruments: controllerResearchScope.instruments,
          }),
        }
      : {}),
    ...(equityUniverseSnapshot ? { equityUniverseSnapshot } : {}),
    ...(asOfMode === undefined ? {} : { asOfMode }),
    ...(controllerPortfolioContext
      ? {
          portfolioContext: controllerPortfolioContext,
          strategyStage: "research_candidate" as const,
        }
      : {}),
  };
  const { realtimeRegistryOptions, collectionRegistryOptions } =
    buildFinanceResearchRegistryOptions(options.includeYahooPublicSources);
  const batchOptions = {
    maxApiCalls: options.maxApiCalls,
    maxConcurrency: options.maxConcurrency,
    maxSourcesPerJob: options.maxSourcesPerJob,
    sourceTimeoutMs: options.sourceTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    retry: { attempts: options.retryAttempts },
    realtimeRegistryOptions,
    collectionRegistryOptions,
    ...(options.live && options.write && options.financeStateDir
      ? {
          macroSnapshotDirectory: resolveFinanceStateDir({
            directory: options.financeStateDir,
          }).directory,
        }
      : {}),
  } as const;
  if (!options.live) {
    const receipt = await runFinanceResearchRun({
      input,
      workspaceDir: WORKSPACE_DIR(),
      ...(options.financeStateDir
        ? {
            financeStateDir: resolveFinanceStateDir({ directory: options.financeStateDir })
              .directory,
          }
        : {}),
      liveFetch: false,
      batchOptions,
    });
    const written = options.write ? await writeReceipt(receipt, asOf) : undefined;
    return { receipt, ...(written === undefined ? {} : { written }) };
  }
  const workflow = createFinanceModelWorkflow(loadConfig(), {
    maxCalls: options.maxModelCalls,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
  });
  const governance = createApiSourceGovernanceRegistry({
    minIntervalMs: 250,
    maxConcurrent: 1,
    maxQueue: 64,
    failureThreshold: 3,
    resetAfterMs: 30_000,
  });
  const receipt = await runCheckpointedFinanceResearch(
    {
      input,
      workspaceDir: WORKSPACE_DIR(),
      ...(options.financeStateDir
        ? {
            financeStateDir: resolveFinanceStateDir({ directory: options.financeStateDir })
              .directory,
          }
        : {}),
      liveFetch: true,
      qualityEnabled: options.quality,
      allowProviderCalls: true,
      maxModelConcurrency: options.maxModelConcurrency,
      modelRouting: workflow.routing,
      ...(options.quality ? { qualityModelRouting: workflow.routing } : {}),
      sourceGovernance: governance,
      batchOptions,
    },
    {
      directory: path.join(WORKSPACE_DIR(), "state", "finance-research-checkpoints"),
      runTimeoutMs: options.runTimeoutMs,
      maxModelCalls: options.maxModelCalls,
    },
  );
  const written = options.write ? await writeReceipt(receipt, asOf) : undefined;
  let thesisLearning: FinanceResearchThesisLearningResult | undefined;
  if (options.persistTheses && written && options.financeStateDir) {
    const state = resolveFinanceStateDir({ directory: options.financeStateDir });
    const artifact = receipt.quality?.finalArtifact;
    try {
      const proposals = validateFinanceResearchThesisProposals({
        value: artifact?.supportingAnalysis?.financeThesisProposals,
        claims: artifact?.claims ?? [],
        evidence: (receipt.batch?.committeeEvidence ?? []).slice(
          0,
          QUALITY_HARNESS_MAX_EVIDENCE_ITEMS,
        ),
        instruments: receipt.plan.targets.map((target) => target.instrument),
        asOf,
        receiptReference: written.datedPath,
        runId: receipt.quality?.runId ?? "",
      });
      thesisLearning = await persistFinanceResearchThesisLearning({
        directory: state.directory,
        eligible:
          receipt.status === "candidate" &&
          receipt.gates.every((gate) => gate.passed) &&
          receipt.quality?.status === "verified" &&
          receipt.quality.quality.passed,
        proposals,
        observedAt: new Date().toISOString(),
      });
    } catch (error) {
      thesisLearning = Object.freeze({
        status: "refused",
        reason: error instanceof Error ? error.message : String(error),
        results: Object.freeze([]),
      });
    }
  }
  const portfolioPlanWritten =
    options.portfolioPlanOut && receipt.portfolioPlan
      ? await writeVerifiedPortfolioPlan(options.portfolioPlanOut, receipt.portfolioPlan)
      : undefined;
  return {
    receipt,
    ...(written === undefined ? {} : { written }),
    ...(portfolioPlanWritten === undefined ? {} : { portfolioPlanWritten }),
    ...(thesisLearning === undefined ? {} : { thesisLearning }),
  };
}

/** Machine protocol stays small; full evidence remains in the written receipt. */
export function compactFinanceResearchSummary(
  summary: Pick<
    ReturnType<typeof summarizeReceipt>,
    "schemaVersion" | "boundary" | "status" | "answerDecision" | "gates"
  > & {
    plan: { asOf: string };
    written?: unknown;
    portfolioPlanWritten?: string;
    portfolioAbstention?: FinanceResearchRunReceipt["portfolioAbstention"];
  },
) {
  return {
    schemaVersion: summary.schemaVersion,
    boundary: summary.boundary,
    status: summary.status,
    answerDecision: summary.answerDecision,
    plan: { asOf: summary.plan.asOf },
    gates: summary.gates.map((gate) => ({ id: gate.id, passed: gate.passed })),
    written: summary.written,
    portfolioPlanWritten: summary.portfolioPlanWritten,
    ...(summary.portfolioAbstention ? { portfolioAbstention: summary.portfolioAbstention } : {}),
  };
}

export function compactFinanceResearchFailure(error: FinanceResearchRunFailure) {
  return {
    schemaVersion: "lcx_finance_research_operator_v1",
    boundary: "local_finance_research_run_only",
    status: "failed",
    answerDecision: "return_failed_reason",
    failure: {
      reason: error.reason,
      runId: error.runId,
      checkpointPath: error.checkpointPath,
      startedAt: error.startedAt,
    },
    gates: [],
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const result = await run(options);
  const summary = {
    ...summarizeReceipt(result.receipt, options),
    ...(result.written === undefined ? {} : { written: result.written }),
    ...(result.portfolioPlanWritten === undefined
      ? {}
      : { portfolioPlanWritten: result.portfolioPlanWritten }),
    ...(result.thesisLearning === undefined ? {} : { thesisLearning: result.thesisLearning }),
  };
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(options.schedulerSummary ? compactFinanceResearchSummary(summary) : summary, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      [
        `finance_research_run=${summary.status}`,
        `answer_decision=${summary.answerDecision}`,
        `expected_jobs=${summary.plan.expectedJobCount}`,
        `gates=${summary.gates.map((gate) => `${gate.id}:${gate.passed ? "pass" : "fail"}`).join(",")}`,
        ...(result.thesisLearning ? [`thesis_learning=${result.thesisLearning.status}`] : []),
        `not_touched=${summary.notTouched.join(",")}`,
      ].join("\n") + "\n",
    );
  }
  // A persistence failure stays visible in `thesisLearning`; it does not become a new trading
  // gate or suppress an otherwise valid research candidate.
  return summary.status === "candidate" || summary.status === "planned" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof HelpRequestedError) {
      process.stdout.write(`${usage()}\n`);
      process.exitCode = 0;
    } else {
      if (
        error instanceof FinanceResearchRunFailure &&
        (process.argv.includes("--scheduler-summary") || process.argv.includes("--json"))
      ) {
        process.stdout.write(`${JSON.stringify(compactFinanceResearchFailure(error))}\n`);
      }
      process.stderr.write(
        `lcx finance research run failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    }
  }
}
