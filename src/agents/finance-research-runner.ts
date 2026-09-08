import { createHash, randomUUID } from "node:crypto";
import type { ApiSourceGovernanceRegistry } from "./api-call-contract.js";
import {
  buildFinanceCommitteeContext,
  runFinanceCommittee,
  type FinanceCommitteeInput,
} from "./finance-agent-committee.js";
import {
  planFinanceBrainOrchestration,
  type FinanceBrainOrchestrationPlan,
} from "./finance-brain-orchestration.js";
import {
  evaluateFinanceDecisionPolicy,
  type FinanceDecisionMode,
} from "./finance-decision-policy.js";
import {
  createFinanceMarketCollectionRegistry,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
  inspectFinanceMarketCollectionRegistry,
  type FinanceMarketCollectionAdapter,
  type FinanceMarketCollectionRequest,
} from "./finance-market-collection-registry.js";
import {
  openFinanceModelCheckpoints,
  financeModelRoutingIdentity,
  FinanceModelStageUncertainError,
  type FinanceModelCheckpointOptions,
} from "./finance-model-checkpoints.js";
import {
  createFinanceRealtimeSourceRegistry,
  resolveFinanceRealtimeSourceRegistryOptionsFromEnv,
  inspectFinanceRealtimeSourceRegistry,
  type FinanceRealtimeSourceAdapter,
  type FinanceRealtimeSourceRequest,
} from "./finance-realtime-source-registry.js";
import {
  requiresFinanceResearchAssessment,
  verifyFinanceResearchAssessment,
} from "./finance-research-assessment.js";
import {
  runFinanceResearchBatch,
  type FinanceResearchBatchCollection,
  type FinanceResearchBatchEvidencePacket,
  type FinanceResearchBatchOptions,
  type FinanceResearchBatchTarget,
} from "./finance-research-batch-runner.js";
import {
  type LogicalAgentExecutionContext,
  type LogicalAgentModelInvoker,
  type LogicalAgentModelRouting,
  type LogicalAgentRequest,
  type LogicalAgentTaskResult,
  type LogicalAgentExecutor,
} from "./logical-agent-pool.js";
import {
  runQualityHarness,
  type QualityHarnessArtifact,
  type QualityHarnessReceipt,
  type QualityHarnessVerifier,
} from "./quality-harness.js";

export const FINANCE_RESEARCH_RUN_SCHEMA_VERSION = "lcx_finance_research_run_v1" as const;

export type FinanceResearchRunInput = Readonly<{
  ask: string;
  asOf: string;
  horizonMonths?: number;
  decisionMode?: FinanceDecisionMode;
  targets?: readonly FinanceResearchBatchTarget[];
  sourcePolicy?: "prioritized" | "all_registered";
}>;

export type FinanceResearchRunOptions = Readonly<{
  input: FinanceResearchRunInput;
  modelCheckpoint?: FinanceModelCheckpointOptions;
  liveFetch?: boolean;
  qualityEnabled?: boolean;
  modelId?: string;
  modelRouting?: LogicalAgentModelRouting;
  modelInvoker?: LogicalAgentModelInvoker;
  qualityModelRouting?: LogicalAgentModelRouting;
  qualityModelInvoker?: LogicalAgentModelInvoker;
  sourceGovernance?: ApiSourceGovernanceRegistry;
  batchOptions?: Omit<FinanceResearchBatchOptions, "targets" | "asOf" | "useCase">;
}>;

export type FinanceResearchSourceInspection = Readonly<{
  targetId: string;
  kind: "realtime" | "collection";
  request: FinanceRealtimeSourceRequest | FinanceMarketCollectionRequest;
  candidateAdapterIds: readonly string[];
}>;

export type FinanceResearchPlan = Readonly<{
  ask: string;
  asOf: string;
  horizonMonths: number;
  decisionMode: FinanceDecisionMode;
  orchestration: FinanceBrainOrchestrationPlan;
  targets: readonly FinanceResearchBatchTarget[];
  expectedJobCount: number;
  sourceInventory?: {
    registeredAdapterIds: readonly string[];
    unplannedAdapterIds: readonly string[];
    unavailableProviders: readonly { provider: string; requiredEnvironment: readonly string[] }[];
  };
  sourceInspections: readonly FinanceResearchSourceInspection[];
  boundaries: readonly string[];
}>;

export type FinanceResearchGate = Readonly<{
  id: "source" | "committee" | "quality" | "quarterly_output";
  passed: boolean;
  reason: string;
}>;

export type FinanceQuarterlyCheckpoint = Readonly<{
  id: string;
  window: string;
  focus: readonly string[];
  requiredEvidenceIds: readonly string[];
}>;

export type FinanceQuarterlyOutput = Readonly<{
  status: "candidate" | "needs_review";
  horizonMonths: number;
  checkpoints: readonly FinanceQuarterlyCheckpoint[];
  candidateAnalysis?: string;
  candidateClaims?: QualityHarnessArtifact["claims"];
  adopted: boolean;
}>;

export type FinanceResearchModelExecution = Readonly<{
  status: "completed" | "failed" | "not_configured";
  modelId: string;
  roleCount: number;
  completedRoleCount: number;
  modelCallCount: number;
  realModelInferenceObserved: boolean;
  allModelCallsAttested: boolean;
  evidenceMode: "adapter-attested" | "adapter-unattested" | "injected" | "none";
  roleStatuses: readonly Readonly<{
    taskId: string;
    agentId: string;
    status: string;
    output?: unknown;
    error?: string;
  }>[];
}>;

export type FinanceResearchRunReceipt = Readonly<{
  schemaVersion: typeof FINANCE_RESEARCH_RUN_SCHEMA_VERSION;
  boundary: "finance_research_run_research_only";
  status: "planned" | "candidate" | "needs_review" | "blocked";
  answerDecision: "candidate_for_review" | "return_failed_reason";
  plan: FinanceResearchPlan;
  batch?: FinanceResearchBatchEvidencePacket;
  committee?: Readonly<{
    coverage: Readonly<Record<string, unknown>>;
    model: FinanceResearchModelExecution;
  }>;
  quality?: QualityHarnessReceipt;
  modelCheckpoint?: ReturnType<ReturnType<typeof openFinanceModelCheckpoints>["summary"]>;
  quarterlyOutput: FinanceQuarterlyOutput;
  gates: readonly FinanceResearchGate[];
  missingEvidence: readonly string[];
  notTouched: readonly string[];
}>;

const NOT_TOUCHED = Object.freeze([
  "provider_config",
  "external_channel_sender",
  "protected_memory",
  "trading_execution",
  "wallet_or_order_authority",
] as const);

const DEFAULT_HORIZON_MONTHS = 6;
const DEFAULT_MODEL_ID = "Qwen/Qwen3-0.6B";

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} required`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertIsoTimestamp(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 16);
}

function dateOnly(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function subtractMonths(value: string, months: number): string {
  const date = new Date(value);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

function normalizeHorizon(value: number | undefined): number {
  return positiveInteger(value ?? DEFAULT_HORIZON_MONTHS, "horizonMonths");
}

function isCryptoAsk(text: string): boolean {
  return /加密|比特币|BTC|ETH|crypto|bitcoin|ethereum/iu.test(text);
}

function isUsEquityAsk(text: string): boolean {
  return /美股|股票|指数|SPY|QQQ|US equities|US stocks|equity|stock/iu.test(text);
}

function buildHistoryCollection(
  horizonMonths: number,
  asOf?: string,
): FinanceResearchBatchCollection {
  return {
    collection: "eod_history",
    ...(asOf === undefined
      ? {}
      : {
          fromDate: subtractMonths(asOf, horizonMonths),
          toDate: dateOnly(new Date(Date.parse(asOf) - 86_400_000).toISOString()),
        }),
    limit: Math.min(1000, Math.max(40, horizonMonths * 31)),
    freshnessMaxMinutes: horizonMonths * 31 * 24 * 60 + 24 * 60,
  };
}

function buildNewsCollection(): FinanceResearchBatchCollection {
  return {
    collection: "news",
    limit: 20,
    freshnessMaxMinutes: 24 * 60,
  };
}

function buildMacroCollection(seriesId: string, limit = 20): FinanceResearchBatchCollection {
  return {
    collection: "macro_series",
    seriesId,
    limit,
    freshnessMaxMinutes: 31 * 24 * 60,
  };
}

/** The default universe is deliberately small enough for a live canary but broad enough to cross-check the ask. */
export function buildDefaultFinanceResearchTargets(
  ask: string,
  horizonMonths = DEFAULT_HORIZON_MONTHS,
  asOf?: string,
): readonly FinanceResearchBatchTarget[] {
  const normalizedAsk = ask.trim();
  const crypto = isCryptoAsk(normalizedAsk);
  const equity = isUsEquityAsk(normalizedAsk);
  const history = buildHistoryCollection(horizonMonths, asOf);
  const targets: FinanceResearchBatchTarget[] = [];
  if (crypto || (!crypto && !equity)) {
    targets.push({
      id: "crypto-btc",
      instrument: "BTCUSDT",
      assetClass: "crypto",
      realtime: {
        freshnessMaxMinutes: 30,
        crossSourceSkewMaxMinutes: 5,
        requireOfficialReference: false,
      },
      collections: [history],
    });
  }
  if (equity || (!crypto && !equity)) {
    for (const symbol of ["SPY", "QQQ"] as const) {
      targets.push({
        id: `us-equity-${symbol.toLowerCase()}`,
        instrument: symbol,
        assetClass: "us_equity",
        realtime: {
          freshnessMaxMinutes: 24 * 60,
          crossSourceSkewMaxMinutes: 60,
          requireOfficialReference: false,
        },
        collections: [history, buildNewsCollection()],
      });
    }
  }
  targets.push({
    id: "cross-asset-sentiment-news",
    instrument: "US equities crypto market sentiment risk appetite US midterm elections",
    assetClass: "us_equity",
    realtime: false,
    collections: [buildNewsCollection()],
  });
  targets.push(
    {
      id: "macro-debt-to-penny",
      instrument: "debt_to_penny",
      assetClass: "macro_series",
      realtime: false,
      collections: [buildMacroCollection("debt_to_penny", 12)],
    },
    {
      id: "macro-average-interest-rates",
      instrument: "avg_interest_rates",
      assetClass: "macro_series",
      realtime: false,
      collections: [buildMacroCollection("avg_interest_rates", 12)],
    },
    {
      id: "macro-cpi",
      instrument: "CUUR0000SA0",
      assetClass: "macro_series",
      realtime: false,
      collections: [buildMacroCollection("CUUR0000SA0", 12)],
    },
  );
  return Object.freeze(targets);
}

/** All-source mode assigns each adapter its own evidence job; priority cannot starve a source. */
export function buildAllRegisteredFinanceResearchTargets(
  asOf: string,
  horizonMonths: number,
  realtimeAdapters: readonly FinanceRealtimeSourceAdapter[],
  collectionAdapters: readonly FinanceMarketCollectionAdapter[],
): readonly FinanceResearchBatchTarget[] {
  const history = buildHistoryCollection(horizonMonths, asOf);
  const result: FinanceResearchBatchTarget[] = [];
  for (const adapter of realtimeAdapters) {
    const symbol =
      adapter.id.startsWith("invesco_") || adapter.id === "sec_edgar_official_reference"
        ? "QQQ"
        : adapter.supports({
              instrument: "BTCUSDT",
              assetClass: "crypto",
              asOf,
              useCase: "finance_research_run",
              freshnessMaxMinutes: 30,
              crossSourceSkewMaxMinutes: 5,
            })
          ? "BTCUSDT"
          : "AAPL";
    const request = {
      instrument: symbol,
      assetClass: symbol === "BTCUSDT" ? "crypto" : "us_equity",
      asOf,
      useCase: "finance_research_run",
      freshnessMaxMinutes: 24 * 60,
      crossSourceSkewMaxMinutes: 60,
    };
    if (adapter.supports(request)) {
      result.push({
        id: `source-${adapter.id}`,
        sourceAdapterIds: [adapter.id],
        instrument: request.instrument,
        assetClass: request.assetClass,
        realtime: { freshnessMaxMinutes: 24 * 60, requireOfficialReference: false },
      });
    }
  }
  for (const adapter of collectionAdapters) {
    if (adapter.sampleRequest) {
      const sample = adapter.sampleRequest;
      result.push({
        id: `source-${adapter.id}`,
        sourceAdapterIds: [adapter.id],
        instrument: sample.instrument,
        assetClass: sample.assetClass,
        realtime: false,
        collections: [
          {
            collection: sample.collection,
            seriesId: sample.seriesId,
            limit: 100,
            freshnessMaxMinutes: 366 * 24 * 60,
          },
        ],
      });
      continue;
    }
    const macroSeries =
      adapter.id === "fred_macro_series"
        ? "FEDFUNDS"
        : adapter.id === "bls_public_macro_series"
          ? "CUUR0000SA0"
          : adapter.id === "treasury_fiscal_debt_to_penny"
            ? "debt_to_penny"
            : adapter.id === "treasury_fiscal_average_interest_rates"
              ? "avg_interest_rates"
              : undefined;
    const symbol =
      macroSeries ??
      (adapter.id === "binance_public_eod_history" || adapter.id === "coingecko_daily_history"
        ? "BTCUSDT"
        : adapter.id === "fred_public_index_history"
          ? "SP500"
          : "AAPL");
    const assetClass = macroSeries ? "macro_series" : symbol === "BTCUSDT" ? "crypto" : "us_equity";
    const candidates: FinanceResearchBatchCollection[] = macroSeries
      ? [buildMacroCollection(macroSeries)]
      : [
          history,
          {
            ...buildNewsCollection(),
            fromDate: dateOnly(new Date(Date.parse(asOf) - 7 * 86_400_000).toISOString()),
            toDate: dateOnly(asOf),
            freshnessMaxMinutes: 7 * 24 * 60,
          },
          ...(
            [
              "sec_filings",
              "company_profile",
              "financial_statements",
              "earnings",
              "options_chain",
              "dividends",
              "splits",
            ] as const
          ).map((collection) => ({ collection, limit: 20, freshnessMaxMinutes: 366 * 24 * 60 })),
        ];
    const collection = candidates.find((candidate) =>
      adapter.supports({ ...candidate, instrument: symbol, assetClass, asOf }),
    );
    if (collection) {
      result.push({
        id: `source-${adapter.id}`,
        sourceAdapterIds: [adapter.id],
        instrument: symbol,
        assetClass,
        realtime: false,
        collections: [collection],
      });
    }
  }
  return result;
}

const OPTIONAL_SOURCE_PROVIDERS = [
  {
    provider: "Alpha Vantage",
    adapter: "alpha_vantage_global_quote",
    requiredEnvironment: ["ALPHA_VANTAGE_API_KEY"],
  },
  {
    provider: "CoinGecko",
    adapter: "coingecko_public_crypto_price",
    requiredEnvironment: ["COINGECKO_API_KEY"],
  },
  {
    provider: "Massive",
    adapter: "massive_us_equity_snapshot",
    requiredEnvironment: ["MASSIVE_API_KEY"],
  },
  {
    provider: "Alpaca",
    adapter: "alpaca_us_equity_latest_quote",
    requiredEnvironment: ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"],
  },
  {
    provider: "Finnhub",
    adapter: "finnhub_us_equity_quote",
    requiredEnvironment: ["FINNHUB_API_KEY"],
  },
  {
    provider: "Twelve Data",
    adapter: "twelve_data_us_equity_quote",
    requiredEnvironment: ["TWELVE_DATA_API_KEY"],
  },
  {
    provider: "FRED macro API",
    adapter: "fred_macro_series",
    requiredEnvironment: ["FRED_API_KEY"],
  },
  {
    provider: "FMP",
    adapter: "fmp_free_basic_company_profile",
    requiredEnvironment: ["FMP_API_KEY"],
  },
] as const;

function sourceInspections(
  targets: readonly FinanceResearchBatchTarget[],
  asOf: string,
  useCase: string,
  realtimeAdapters: readonly FinanceRealtimeSourceAdapter[],
  collectionAdapters: readonly FinanceMarketCollectionAdapter[],
): readonly FinanceResearchSourceInspection[] {
  const inspections: FinanceResearchSourceInspection[] = [];
  for (const target of targets) {
    const common = {
      instrument: requiredText(target.instrument, "instrument"),
      assetClass: requiredText(target.assetClass, "assetClass"),
      asOf,
    };
    if (target.realtime !== false) {
      const policy = target.realtime ?? {};
      const request: FinanceRealtimeSourceRequest = {
        ...common,
        useCase,
        freshnessMaxMinutes: policy.freshnessMaxMinutes ?? 15,
        crossSourceSkewMaxMinutes: policy.crossSourceSkewMaxMinutes ?? 5,
        requireOfficialReference: policy.requireOfficialReference,
      };
      const inspection = inspectFinanceRealtimeSourceRegistry(
        request,
        realtimeAdapters.filter(
          (adapter) => !target.sourceAdapterIds || target.sourceAdapterIds.includes(adapter.id),
        ),
      );
      inspections.push({
        targetId: target.id,
        kind: "realtime",
        request: inspection.request,
        candidateAdapterIds: inspection.candidateAdapters.map((adapter) => adapter.id),
      });
    }
    for (const collection of target.collections ?? []) {
      const { freshnessMaxMinutes: _freshnessMaxMinutes, ...fields } = collection;
      const request = {
        ...fields,
        ...common,
        collection: collection.collection,
      } as FinanceMarketCollectionRequest;
      const inspection = inspectFinanceMarketCollectionRegistry(
        request,
        collectionAdapters.filter(
          (adapter) => !target.sourceAdapterIds || target.sourceAdapterIds.includes(adapter.id),
        ),
      );
      inspections.push({
        targetId: target.id,
        kind: "collection",
        request: inspection.request,
        candidateAdapterIds: inspection.candidateAdapters.map((adapter) => adapter.id),
      });
    }
  }
  return Object.freeze(inspections);
}

function buildPlan(
  input: FinanceResearchRunInput,
  targets: readonly FinanceResearchBatchTarget[],
  horizonMonths: number,
  realtimeAdapters: readonly FinanceRealtimeSourceAdapter[],
  collectionAdapters: readonly FinanceMarketCollectionAdapter[],
): FinanceResearchPlan {
  const ask = requiredText(input.ask, "ask");
  const asOf = assertIsoTimestamp(input.asOf, "asOf");
  const decisionMode = input.decisionMode ?? "research_only";
  const orchestration = planFinanceBrainOrchestration({
    text: ask,
    highStakesConclusion: true,
    decisionMode,
  });
  const expectedJobCount = targets.reduce(
    (count, target) =>
      count + (target.realtime === false ? 0 : 1) + (target.collections?.length ?? 0),
    0,
  );
  const inspections = sourceInspections(
    targets,
    asOf,
    "finance_research_run",
    realtimeAdapters,
    collectionAdapters,
  );
  const registeredAdapterIds = [...realtimeAdapters, ...collectionAdapters].map(
    (adapter) => adapter.id,
  );
  const plannedIds = new Set(inspections.flatMap((inspection) => inspection.candidateAdapterIds));
  return Object.freeze({
    ask,
    asOf,
    horizonMonths,
    decisionMode,
    orchestration,
    targets: Object.freeze([...targets]),
    expectedJobCount,
    sourceInspections: inspections,
    ...(input.sourcePolicy === "all_registered"
      ? {
          sourceInventory: {
            registeredAdapterIds,
            unplannedAdapterIds: registeredAdapterIds.filter((id) => !plannedIds.has(id)),
            unavailableProviders: OPTIONAL_SOURCE_PROVIDERS.filter(
              (provider) => !registeredAdapterIds.includes(provider.adapter),
            ).map(({ provider, requiredEnvironment }) => ({ provider, requiredEnvironment })),
          },
        }
      : {}),
    boundaries: Object.freeze([
      "research_only",
      "no_execution_authority",
      "current_data_requires_source_and_timestamp",
      "stale_or_conflicting_data_blocks_visible_adoption",
      "quality_gate_before_visible_answer",
    ]),
  });
}

function dependencyOutputs<TResult>(
  values: Readonly<Record<string, LogicalAgentTaskResult<TResult>>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(values).map(([taskId, result]) => [
      taskId,
      { status: result.status, output: result.output, error: result.error },
    ]),
  );
}

export function createFinanceCommitteeExecutor(): LogicalAgentExecutor<
  LogicalAgentRequest,
  Record<string, unknown>
> {
  return async (
    context: LogicalAgentExecutionContext<LogicalAgentRequest, Record<string, unknown>>,
  ) => {
    const payload = {
      schemaVersion: "lcx_local_role_shadow_v1" as const,
      runId: context.sharedContext.runId ?? context.task.id,
      taskId: context.task.id,
      role: context.agent.id,
      purpose: context.agent.purpose,
      ask: context.input.ask,
      evidence: context.input.evidence ?? [],
      dependencyOutputs: dependencyOutputs(context.dependencyResults),
    };
    const output = await context.modelSlot.invoke(payload, context.signal);
    if (typeof output !== "object" || output === null || Array.isArray(output)) {
      throw new Error("finance committee model returned a non-object role result");
    }
    return { output: output as Record<string, unknown>, sideEffects: [] };
  };
}

function callSummary(
  modelCalls: readonly Readonly<{
    evidence: string;
    realModelInferenceObserved: boolean;
    mode: string;
  }>[],
): Pick<
  FinanceResearchModelExecution,
  "modelCallCount" | "realModelInferenceObserved" | "allModelCallsAttested" | "evidenceMode"
> {
  const real = modelCalls.some((call) => call.realModelInferenceObserved);
  const attested =
    modelCalls.length > 0 && modelCalls.every((call) => call.evidence === "adapter-attested");
  return {
    modelCallCount: modelCalls.length,
    realModelInferenceObserved: real,
    allModelCallsAttested: attested,
    evidenceMode:
      modelCalls.length === 0
        ? "none"
        : attested
          ? "adapter-attested"
          : modelCalls.some((call) => call.mode === "injected")
            ? "injected"
            : "adapter-unattested",
  };
}

function compactOutput(value: unknown, maxLength = 2_000): unknown {
  if (typeof value === "string") {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxLength) {
      return value;
    }
    return serialized.slice(0, maxLength) + "…";
  } catch {
    return "[unserializable]";
  }
}

function buildModelExecution(
  result: Awaited<ReturnType<typeof runFinanceCommittee<Record<string, unknown>>>>,
  modelId: string,
): FinanceResearchModelExecution {
  const modelCalls = result.execution.tasks.flatMap((task) => task.modelCalls ?? []);
  const summary = callSummary(modelCalls);
  return Object.freeze({
    status: result.execution.status === "completed" ? "completed" : "failed",
    modelId,
    roleCount: result.execution.tasks.length,
    completedRoleCount: result.execution.tasks.filter((task) => task.status === "completed").length,
    ...summary,
    roleStatuses: Object.freeze(
      result.execution.tasks.map((task) => ({
        taskId: task.taskId,
        agentId: task.agentId,
        status: task.status,
        ...(task.output === undefined ? {} : { output: compactOutput(task.output) }),
        ...(task.error === undefined ? {} : { error: task.error }),
      })),
    ),
  });
}

function qualityVerifier(decisionMode: FinanceDecisionMode): QualityHarnessVerifier {
  return ({ request, artifact }) => {
    const evidenceIds = new Set(request.evidence.map((entry) => entry.id));
    const invalidClaims = artifact.claims.filter(
      (claim) =>
        claim.status === "supported" &&
        (claim.evidenceIds.length === 0 || claim.evidenceIds.some((id) => !evidenceIds.has(id))),
    );
    if (invalidClaims.length > 0) {
      return {
        status: "failed",
        summary: "supported claims must cite supplied evidence ids",
        details: [`invalid_supported_claims=${invalidClaims.length}`],
      };
    }
    if (requiresFinanceResearchAssessment(request.task)) {
      const assessment = verifyFinanceResearchAssessment(artifact.supportingAnalysis, evidenceIds);
      if (!assessment.passed) {
        return {
          status: "failed",
          summary: assessment.reason,
          details: ["causal attribution and scenarios require a structured, reviewable assessment"],
        };
      }
    }
    const policy = evaluateFinanceDecisionPolicy({
      mode: decisionMode,
      ask: request.task,
      answer: artifact.answer,
    });
    if (!policy.allowed) {
      return {
        status: "failed",
        summary: "finance decision policy rejected the candidate answer",
        details: [...policy.failedReasons, ...policy.requiredEvidence],
      };
    }
    return {
      status: "passed",
      summary:
        "finance references and decision boundary verified; semantic support requires independent review",
      details: [
        `evidence_count=${request.evidence.length}`,
        `claim_count=${artifact.claims.length}`,
      ],
    };
  };
}

function qualityEvidence(batch: FinanceResearchBatchEvidencePacket): readonly {
  id: string;
  text: string;
  source: string;
}[] {
  return batch.committeeEvidence.slice(0, 48).map((item) => ({
    id: item.id,
    text: item.text.length <= 5_000 ? item.text : `${item.text.slice(0, 5_000)}…`,
    source: item.source,
  }));
}

function buildQuarterlyOutput(params: {
  horizonMonths: number;
  plan: FinanceResearchPlan;
  evidenceIds: readonly string[];
  quality?: QualityHarnessReceipt;
  committee?: FinanceResearchModelExecution;
  adopted: boolean;
  missingEvidence: readonly string[];
}): FinanceQuarterlyOutput {
  const quarterCount = Math.max(1, Math.ceil(params.horizonMonths / 3));
  const hasEvent = params.plan.orchestration.primaryModules.includes("event_driven");
  const hasCrossAsset = params.plan.orchestration.primaryModules.includes("cross_asset_liquidity");
  const hasCrypto = params.plan.orchestration.primaryModules.includes("crypto_market_structure");
  const hasEquity = params.plan.orchestration.primaryModules.includes("us_equity_market_structure");
  const focus = [
    ...(hasEquity ? ["US equity breadth, concentration, and rally persistence"] : []),
    ...(hasCrypto ? ["crypto liquidity, cross-exchange confirmation, and spillover"] : []),
    ...(hasCrossAsset ? ["cross-asset risk appetite and liquidity transmission"] : []),
    ...(hasEvent ? ["midterm-election and policy-event catalysts with invalidation checks"] : []),
  ];
  const candidateArtifact = params.quality?.finalArtifact;
  return Object.freeze({
    status: params.adopted ? "candidate" : "needs_review",
    horizonMonths: params.horizonMonths,
    checkpoints: Object.freeze(
      Array.from({ length: quarterCount }, (_, index) => ({
        id: `quarter_${index + 1}`,
        window: `${index * 3 + 1}-${Math.min(params.horizonMonths, (index + 1) * 3)} months`,
        focus: Object.freeze(focus),
        requiredEvidenceIds: Object.freeze(params.evidenceIds.slice(0, 24)),
      })),
    ),
    ...(candidateArtifact?.answer
      ? { candidateAnalysis: candidateArtifact.answer }
      : params.committee
        ? {
            candidateAnalysis:
              "Committee roles executed, but the quality gate did not adopt a visible analysis. Inspect role receipts and missing evidence before use.",
          }
        : {}),
    ...(candidateArtifact?.claims ? { candidateClaims: candidateArtifact.claims } : {}),
    adopted: params.adopted,
  });
}

function sourceGate(
  batch: FinanceResearchBatchEvidencePacket,
  plan: FinanceResearchPlan,
): FinanceResearchGate {
  const inventory = plan.sourceInventory;
  const coverageMissing =
    (inventory?.unplannedAdapterIds.length ?? 0) + (inventory?.unavailableProviders.length ?? 0);
  const passed =
    batch.status === "completed" &&
    batch.jobs.every((job) => job.status === "ready") &&
    coverageMissing === 0;
  return {
    id: "source",
    passed,
    reason: passed
      ? "all bounded source jobs are ready"
      : `source evidence is ${batch.status}; ready=${batch.budget.readyJobs}/${batch.budget.requestedJobs}; review=${batch.budget.reviewJobs}; blocked=${batch.budget.blockedJobs}; unregistered_or_unplanned=${coverageMissing}`,
  };
}

function missingEvidence(batch: FinanceResearchBatchEvidencePacket): string[] {
  const values = new Set<string>();
  for (const job of batch.jobs) {
    for (const value of job.missingEvidence) {
      values.add(`${job.targetId}:${value}`);
    }
    for (const value of job.freshnessWarnings) {
      values.add(`${job.targetId}:${value}`);
    }
    for (const value of job.conflicts) {
      values.add(`${job.targetId}:conflict:${value}`);
    }
  }
  return [...values].toSorted();
}

function committeeGate(
  committee: Awaited<ReturnType<typeof runFinanceCommittee<Record<string, unknown>>>>,
): FinanceResearchGate {
  const passed =
    committee.execution.status === "completed" &&
    committee.coverage.equivalenceStatus === "committee_candidate";
  return {
    id: "committee",
    passed,
    reason: passed
      ? "all required logical-agent committee lanes completed"
      : `committee status=${committee.execution.status}; missing=${committee.coverage.missingLanes.join(",") || "none"}`,
  };
}

function qualityGate(quality: QualityHarnessReceipt | undefined): FinanceResearchGate {
  const passed = quality?.status === "verified" && quality.quality.passed;
  return {
    id: "quality",
    passed,
    reason: quality
      ? `quality status=${quality.status}; passed=${quality.quality.passed}`
      : "quality harness was not configured or did not run",
  };
}

export async function runFinanceResearchRun(
  options: FinanceResearchRunOptions,
): Promise<FinanceResearchRunReceipt> {
  if (options.modelCheckpoint) {
    positiveInteger(options.modelCheckpoint.maxModelCalls, "maxModelCalls");
    requiredText(options.modelCheckpoint.path, "model checkpoint path");
    requiredText(options.modelCheckpoint.runId, "model checkpoint runId");
    requiredText(options.modelCheckpoint.executionFingerprint, "model checkpoint fingerprint");
  }
  const ask = requiredText(options.input.ask, "ask");
  const asOf = assertIsoTimestamp(options.input.asOf, "asOf");
  const horizonMonths = normalizeHorizon(options.input.horizonMonths);
  const decisionMode = options.input.decisionMode ?? "research_only";
  const realtimeAdapters =
    options.batchOptions?.realtimeAdapters ??
    createFinanceRealtimeSourceRegistry({
      ...resolveFinanceRealtimeSourceRegistryOptionsFromEnv(),
      ...(options.input.sourcePolicy === "all_registered"
        ? { includeYahooPublicSource: true }
        : {}),
      ...options.batchOptions?.realtimeRegistryOptions,
    });
  const collectionAdapters =
    options.batchOptions?.collectionAdapters ??
    createFinanceMarketCollectionRegistry({
      ...resolveFinanceMarketCollectionRegistryOptionsFromEnv(),
      ...(options.input.sourcePolicy === "all_registered"
        ? { includeYahooPublicSources: true }
        : {}),
      ...options.batchOptions?.collectionRegistryOptions,
    });
  const targets =
    options.input.targets ??
    (options.input.sourcePolicy === "all_registered"
      ? buildAllRegisteredFinanceResearchTargets(
          asOf,
          horizonMonths,
          realtimeAdapters,
          collectionAdapters,
        )
      : buildDefaultFinanceResearchTargets(ask, horizonMonths, asOf));
  const plan = buildPlan(
    { ...options.input, ask, asOf, decisionMode },
    targets,
    horizonMonths,
    realtimeAdapters,
    collectionAdapters,
  );
  const liveFetch = options.liveFetch === true;
  if (!liveFetch) {
    const quarterlyOutput = buildQuarterlyOutput({
      horizonMonths,
      plan,
      evidenceIds: [],
      adopted: false,
      missingEvidence: ["live_fetch_not_requested", "model_analysis_not_requested"],
    });
    const dryGates: FinanceResearchGate[] = [
      { id: "source", passed: false, reason: "dry plan; no network fetch" },
      { id: "committee", passed: false, reason: "dry plan; model DAG not executed" },
      { id: "quality", passed: false, reason: "dry plan; quality harness not executed" },
      { id: "quarterly_output", passed: false, reason: "dry plan is not a visible answer" },
    ];
    return Object.freeze({
      schemaVersion: FINANCE_RESEARCH_RUN_SCHEMA_VERSION,
      boundary: "finance_research_run_research_only",
      status: "planned",
      answerDecision: "return_failed_reason",
      plan,
      quarterlyOutput,
      gates: Object.freeze(dryGates),
      missingEvidence: Object.freeze(["live_fetch_not_requested", "model_analysis_not_requested"]),
      notTouched: NOT_TOUCHED,
    });
  }

  let batch = await runFinanceResearchBatch({
    ...(options.input.sourcePolicy === "all_registered"
      ? { maxSourcesPerJob: 1, maxHttpCallsPerSource: 3, includeReviewEvidence: true }
      : {}),
    ...options.batchOptions,
    ...(options.modelCheckpoint
      ? { correlationId: `finance-research:${shortHash(options.modelCheckpoint.runId)}` }
      : {}),
    targets,
    asOf,
    useCase: "finance_research_run",
    ...(options.sourceGovernance === undefined
      ? {}
      : { sourceGovernance: options.sourceGovernance }),
    realtimeAdapters,
    collectionAdapters,
  });
  let evidence = batch.committeeEvidence;
  const baseMissing = [
    ...missingEvidence(batch),
    ...(plan.sourceInventory?.unplannedAdapterIds.map((id) => `source_not_planned:${id}`) ?? []),
    ...(plan.sourceInventory?.unavailableProviders.map(
      (item) => `source_not_registered:${item.provider}`,
    ) ?? []),
  ];
  const hasModel = options.modelRouting !== undefined || options.modelInvoker !== undefined;
  if (!hasModel) {
    const source = sourceGate(batch, plan);
    const quality = qualityGate(undefined);
    const quarterlyOutput = buildQuarterlyOutput({
      horizonMonths,
      plan,
      evidenceIds: evidence.map((item) => item.id),
      adopted: false,
      missingEvidence: [...baseMissing, "model_not_configured"],
    });
    const blockedGates: FinanceResearchGate[] = [
      source,
      { id: "committee", passed: false, reason: "model routing or invoker not configured" },
      quality,
      { id: "quarterly_output", passed: false, reason: "upstream model gate failed" },
    ];
    return Object.freeze({
      schemaVersion: FINANCE_RESEARCH_RUN_SCHEMA_VERSION,
      boundary: "finance_research_run_research_only",
      status: "blocked",
      answerDecision: "return_failed_reason",
      plan,
      batch,
      quarterlyOutput,
      gates: Object.freeze(blockedGates),
      missingEvidence: Object.freeze([...baseMissing, "model_not_configured"]),
      notTouched: NOT_TOUCHED,
    });
  }

  const modelCheckpoint = options.modelCheckpoint
    ? openFinanceModelCheckpoints(options.modelCheckpoint, {
        ask,
        asOf,
        horizonMonths,
        decisionMode,
        jobs: batch.jobs,
        modelId: options.modelId ?? DEFAULT_MODEL_ID,
        routing: [options.modelRouting, options.qualityModelRouting].map(
          financeModelRoutingIdentity,
        ),
        qualityEnabled: options.qualityEnabled ?? true,
        committeeConfigured: hasModel,
        qualityConfigured:
          options.qualityModelRouting !== undefined || options.qualityModelInvoker !== undefined,
      })
    : undefined;
  try {
    const committeeInput: FinanceCommitteeInput = {
      ask,
      asOf,
      decisionMode,
      evidence,
      userConstraints: {
        horizonMonths,
        sourceStatus: batch.status,
        researchOnly: true,
      },
    };
    // Validate before starting the DAG so malformed evidence cannot become a partial model run.
    buildFinanceCommitteeContext(committeeInput);
    const executeCommittee = () =>
      runFinanceCommittee<Record<string, unknown>>({
        input: committeeInput,
        executor: createFinanceCommitteeExecutor(),
        ...(options.modelRouting === undefined
          ? {}
          : {
              modelRouting: modelCheckpoint?.routing(options.modelRouting) ?? options.modelRouting,
            }),
        ...(options.modelInvoker === undefined
          ? {}
          : {
              modelInvoker: modelCheckpoint?.invoker(options.modelInvoker) ?? options.modelInvoker,
            }),
        runId: `finance-research:${shortHash({ ask, asOf, horizonMonths })}:${randomUUID().slice(0, 8)}`,
      });
    const committee = modelCheckpoint
      ? await modelCheckpoint.stage("committee", executeCommittee)
      : await executeCommittee();
    // Keep cached model conclusions bound to their original evidence context.
    evidence = committee.context.evidence;
    batch = { ...batch, committeeEvidence: evidence };
    const modelId =
      options.modelRouting?.adapters[0]?.modelId ?? options.modelId ?? DEFAULT_MODEL_ID;
    const model = buildModelExecution(committee, modelId);
    const committeeGateResult = committeeGate(committee);

    const qualityRequested = options.qualityEnabled !== false;
    let quality: QualityHarnessReceipt | undefined;
    if (
      qualityRequested &&
      (options.qualityModelRouting !== undefined || options.qualityModelInvoker !== undefined)
    ) {
      const qualityRequest = {
        task: `${ask}\nProduce a research-only ${horizonMonths}-month outlook with explicit quarter checkpoints, supporting evidence IDs, counter-thesis, and invalidation conditions. Do not provide execution instructions.`,
        evidence: qualityEvidence(batch),
        sharedContext: {
          asOf,
          horizonMonths,
          decisionMode,
          sourceStatus: batch.status,
          sourceGatePassed: sourceGate(batch, plan).passed,
          committeeGatePassed: committeeGateResult.passed,
          noExecutionAuthority: true,
          ...(requiresFinanceResearchAssessment(ask)
            ? {
                supportingAnalysisContract: {
                  causalHypotheses:
                    "At least two objects: id,cause,effect,mechanism,evidenceIds,alternativeExplanations (nonempty array),disconfirmingTest,status= hypothesis. Do not present correlation as established causality.",
                  scenarios:
                    "At least three distinct objects: id,probability (0..1; sum=1),condition,expectedEffect,invalidation,evidenceIds. These are conditional hypotheses, not calibrated probabilities.",
                  placement: "artifact.supportingAnalysis, retained by draft and format stages",
                },
              }
            : {}),
        },
      };
      const executeQuality = () =>
        runQualityHarness({
          request: qualityRequest,
          modelId,
          ...(options.qualityModelRouting === undefined
            ? {}
            : {
                modelRouting:
                  modelCheckpoint?.routing(options.qualityModelRouting) ??
                  options.qualityModelRouting,
              }),
          ...(options.qualityModelInvoker === undefined
            ? {}
            : {
                modelInvoker:
                  modelCheckpoint?.invoker(options.qualityModelInvoker) ??
                  options.qualityModelInvoker,
              }),
          maxConcurrency: 1,
          memoryBudgetMb: 3_072,
          taskTimeoutMs: 180_000,
          verifierTimeoutMs: 10_000,
          maxAttempts: 2,
          verify: qualityVerifier(decisionMode),
        });
      quality = modelCheckpoint
        ? await modelCheckpoint.stage("quality", executeQuality)
        : await executeQuality();
    }
    const source = sourceGate(batch, plan);
    const qualityGateResult = qualityGate(quality);
    const allGatesPassed = source.passed && committeeGateResult.passed && qualityGateResult.passed;
    const quarterlyOutput = buildQuarterlyOutput({
      horizonMonths,
      plan,
      evidenceIds: evidence.map((item) => item.id),
      quality,
      committee: model,
      adopted: allGatesPassed,
      missingEvidence: baseMissing,
    });
    const gates: FinanceResearchGate[] = [
      source,
      committeeGateResult,
      qualityGateResult,
      {
        id: "quarterly_output" as const,
        passed: allGatesPassed,
        reason: allGatesPassed
          ? "quarterly candidate passed source, committee, and quality gates"
          : "quarterly output remains a non-adopted candidate because an upstream gate failed",
      },
    ];
    return Object.freeze({
      schemaVersion: FINANCE_RESEARCH_RUN_SCHEMA_VERSION,
      boundary: "finance_research_run_research_only",
      status: allGatesPassed
        ? "candidate"
        : batch.status === "blocked"
          ? "blocked"
          : "needs_review",
      answerDecision: allGatesPassed ? "candidate_for_review" : "return_failed_reason",
      plan,
      batch,
      committee: {
        coverage: committee.coverage,
        model,
      },
      ...(quality === undefined ? {} : { quality }),
      ...(modelCheckpoint ? { modelCheckpoint: modelCheckpoint.summary() } : {}),
      quarterlyOutput,
      gates: Object.freeze(gates),
      missingEvidence: Object.freeze(baseMissing),
      notTouched: NOT_TOUCHED,
    });
  } catch (error) {
    if (!(error instanceof FinanceModelStageUncertainError)) {
      throw error;
    }
    return {
      schemaVersion: FINANCE_RESEARCH_RUN_SCHEMA_VERSION,
      boundary: "finance_research_run_research_only",
      status: "needs_review",
      answerDecision: "return_failed_reason",
      plan,
      batch,
      modelCheckpoint: modelCheckpoint?.summary(),
      quarterlyOutput: buildQuarterlyOutput({
        horizonMonths,
        plan,
        evidenceIds: evidence.map((item) => item.id),
        adopted: false,
        missingEvidence: [error.message],
      }),
      gates: [
        sourceGate(batch, plan),
        ...(["committee", "quality", "quarterly_output"] as const).map((id) => ({
          id,
          passed: false,
          reason: error.message,
        })),
      ],
      missingEvidence: [...baseMissing, error.message],
      notTouched: NOT_TOUCHED,
    };
  } finally {
    modelCheckpoint?.close();
  }
}
