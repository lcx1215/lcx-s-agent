import { createHash, randomUUID } from "node:crypto";
import type { ApiSourceGovernanceRegistry } from "./api-call-contract.js";
import {
  buildFinanceCommitteeContext,
  runFinanceCommittee,
  type FinanceCommitteeEvidence,
  type FinanceCommitteeInput,
  type FinanceCommitteeSharedContext,
} from "./finance-agent-committee.js";
import {
  planFinanceBrainOrchestration,
  parseFinanceModuleSelection,
  type FinanceModuleSelection,
  type FinanceBrainOrchestrationPlan,
} from "./finance-brain-orchestration.js";
import type { FinanceAsOfMode } from "./finance-data-gateway.js";
import {
  evaluateFinanceDecisionPolicy,
  type FinanceDecisionMode,
  type FinanceStrategyStage,
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
  createUnrequestedFinanceModuleExecutionReceipt,
  executeFinanceModuleComposition,
  type FinanceModuleExecutionReceipt,
} from "./finance-module-execution.js";
import {
  financeProducerInputContract,
  parseFinanceDomainProducerInputs,
  type FinanceDomainProducerInputs,
} from "./finance-module-producer-input.js";
import type { FinancePortfolioPlan } from "./finance-portfolio-composition.js";
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
  buildFinanceResearchModelEvidence,
  findUncitedFinanceInstruments,
} from "./finance-research-evidence.js";
import {
  buildFinanceResearchPortfolioPlan,
  financeResearchPortfolioContextSchema,
  parseFinanceResearchAllocationProposal,
  type FinanceResearchPortfolioContext,
} from "./finance-research-portfolio-plan.js";
import { validateFinanceResearchThesisProposals } from "./finance-research-thesis-learning.js";
import { buildFinanceSourceRecoveryPlan } from "./finance-source-recovery.js";
import {
  buildFinanceStrategyMethodKit,
  toFinanceStrategyMethodKitModelContext,
} from "./finance-strategy-method-kit.js";
import { modelRoutingTaskTimeoutMs } from "./logical-agent-model-router.js";
import {
  type LogicalAgentExecutionContext,
  type LogicalAgentModelInvoker,
  type LogicalAgentModelRouting,
  type LogicalAgentRequest,
  type LogicalAgentTaskResult,
  type LogicalAgentExecutor,
} from "./logical-agent-pool.js";
import {
  parseStageOutput,
  stageInstructions,
  STAGE_BY_AGENT_ID,
  type QualityHarnessModelRequest,
} from "./quality-harness-contract.js";
import {
  runQualityHarness,
  type QualityHarnessArtifact,
  type QualityHarnessReceipt,
  type QualityHarnessVerifier,
} from "./quality-harness.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export const FINANCE_RESEARCH_RUN_SCHEMA_VERSION = "lcx_finance_research_run_v1" as const;

export type FinanceResearchRunInput = Readonly<{
  ask: string;
  asOf: string;
  asOfMode?: FinanceAsOfMode;
  horizonMonths?: number;
  decisionMode?: FinanceDecisionMode;
  /** Declared research maturity stage; binds which `decisionMode` the run may use. */
  strategyStage?: FinanceStrategyStage;
  targets?: readonly FinanceResearchBatchTarget[];
  sourcePolicy?: "prioritized" | "all_registered";
  moduleSelection?: FinanceModuleSelection;
  /** Explicitly dispatch bounded module tools and attach their receipts to model evidence. */
  executeModules?: boolean;
  /** Controller-owned, timestamped local-state evidence (for example the night projection). */
  controllerEvidence?: readonly FinanceCommitteeEvidence[];
  /** Controller-owned plan envelope. The model may propose allocations only inside this set. */
  portfolioContext?: FinanceResearchPortfolioContext;
}>;

export type FinanceResearchRunOptions = Readonly<{
  signal?: AbortSignal;
  allowProviderCalls?: boolean;
  input: FinanceResearchRunInput;
  modelCheckpoint?: FinanceModelCheckpointOptions;
  liveFetch?: boolean;
  qualityEnabled?: boolean;
  modelId?: string;
  modelRouting?: LogicalAgentModelRouting;
  modelInvoker?: LogicalAgentModelInvoker;
  qualityModelRouting?: LogicalAgentModelRouting;
  qualityModelInvoker?: LogicalAgentModelInvoker;
  /** Test/embedding seam; production uses the canonical module executor. */
  moduleExecutor?: typeof executeFinanceModuleComposition;
  workspaceDir?: string;
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
  asOfMode?: FinanceAsOfMode;
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
  portfolioContext?: FinanceResearchPortfolioContext;
  boundaries: readonly string[];
}>;

export type FinanceResearchGate = Readonly<{
  id: "source" | "committee" | "quality" | "module_execution" | "quarterly_output";
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
  moduleExecution?: FinanceModuleExecutionReceipt;
  sourceRecovery?: ReturnType<typeof buildFinanceSourceRecoveryPlan>;
  modelCheckpoint?: ReturnType<ReturnType<typeof openFinanceModelCheckpoints>["summary"]>;
  quarterlyOutput: FinanceQuarterlyOutput;
  portfolioPlan?: FinancePortfolioPlan;
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

function normalizeControllerEvidence(
  value: readonly FinanceCommitteeEvidence[] | undefined,
  asOf: string,
): readonly FinanceCommitteeEvidence[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (value.length > 16) {
    throw new Error("controllerEvidence must contain at most 16 items");
  }
  let totalBytes = 0;
  const normalized = value.map((item, index) => {
    const timestamp = assertIsoTimestamp(item.timestamp, `controllerEvidence[${index}].timestamp`);
    if (Date.parse(timestamp) > Date.parse(asOf)) {
      throw new Error(`controllerEvidence[${index}] is newer than asOf`);
    }
    const text = requiredText(item.text, `controllerEvidence[${index}].text`);
    totalBytes += Buffer.byteLength(text, "utf8");
    return Object.freeze({
      id: requiredText(item.id, `controllerEvidence[${index}].id`),
      source: requiredText(item.source, `controllerEvidence[${index}].source`),
      timestamp,
      text,
    });
  });
  if (totalBytes > 256_000) {
    throw new Error("controllerEvidence text must be <= 256000 UTF-8 bytes");
  }
  return Object.freeze(normalized);
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
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
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

const FINANCE_EQUITY_ALIASES = Object.freeze({
  apple: "AAPL",
  amazon: "AMZN",
  alphabet: "GOOGL",
  google: "GOOGL",
  meta: "META",
  microsoft: "MSFT",
  nvidia: "NVDA",
  tesla: "TSLA",
} as const);

/**
 * Upper-case words that are *not* tickers.
 *
 * `requestedEquitySymbols` treats any run of 1-5 capitals as a ticker unless it is listed here, so
 * this is a blocklist and it is never complete: every unlisted abbreviation is read as a request to
 * fetch that instrument. Measured, these all became research targets before the list was widened —
 * RSI, MACD, EPS, IPO, FED, FOMC, YTD, TTM, NAV, AUM, NYSE — each of which then had history and news
 * collected against a symbol that does not exist.
 *
 * Two rules when adding here:
 * 1. **Do not add a real ticker.** Several financial abbreviations are listed companies — PEG
 *    (Public Service Enterprise), ATR (AptarGroup) — and blocking those would break real requests.
 * 2. A blocklist only shrinks the hole. The durable fix is to require a code context (a `$` prefix,
 *    or a ticker-shaped token in a position where prose abbreviations do not appear) rather than to
 *    keep guessing which abbreviations somebody might type.
 */
const NON_EQUITY_SYMBOL_TOKENS = new Set([
  "ADR",
  "AI",
  "API",
  "ATH",
  "ATL",
  "AUM",
  "BLS",
  "BOLL",
  "CAGR",
  "CEO",
  "CFO",
  "CPI",
  "DAG",
  "DCF",
  "DEFI",
  "DJIA",
  "EMA",
  "EOD",
  "EPS",
  "ESG",
  "ETF",
  "FED",
  "FOMC",
  "FTSE",
  "FOMO",
  "GAAP",
  "GDP",
  "HODL",
  "HTTP",
  "HTTPS",
  "ICO",
  "IFRS",
  "IPO",
  "JSON",
  "KDJ",
  "MACD",
  "ML",
  "MOM",
  "MSCI",
  "NASDAQ",
  "NAV",
  "NFT",
  "NYSE",
  "PPI",
  "PMI",
  "QOQ",
  "QTD",
  "ROA",
  "ROE",
  "ROI",
  "RSI",
  "SEC",
  "SMA",
  "TTM",
  "US",
  "USA",
  "USD",
  "UTC",
  "WACC",
  "YOY",
  "YTD",
]);

/** Extract only bounded, caller-supplied equity symbols; prose falls back to the broad canary universe. */
function requestedEquitySymbols(text: string): readonly string[] {
  const symbols = new Set<string>();
  for (const match of text.matchAll(
    /(?:^|[^A-Za-z0-9])\$?([A-Z]{1,5}(?:\.[A-Z])?)(?![A-Za-z0-9])/g,
  )) {
    const symbol = match[1];
    if (symbol && !NON_EQUITY_SYMBOL_TOKENS.has(symbol)) {
      symbols.add(symbol);
    }
  }
  for (const [alias, symbol] of Object.entries(FINANCE_EQUITY_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`, "iu").test(text)) {
      symbols.add(symbol);
    }
  }
  return Object.freeze([...symbols]);
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
    // Keep each request within the market registry's hard maximum; longer horizons
    // are represented by the date window and may be reported as incomplete coverage.
    limit: Math.min(250, Math.max(40, horizonMonths * 31)),
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
    const symbols = requestedEquitySymbols(normalizedAsk);
    for (const symbol of symbols.length > 0 ? symbols : ["SPY", "QQQ"]) {
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
    // The directed daily brief's index-options task declares implied volatility,
    // term structure, and skew as required fresh inputs and invalidates its
    // conclusion without them, but the prioritized default set collected no
    // options data at all: `options_chain` was reachable only through
    // all_registered. Reuse the already-registered collection instead of adding
    // a provider, a registry entry, or a parallel source owner.
    targets.push({
      id: "us-index-options-chain",
      instrument: "SPY",
      assetClass: "us_equity",
      realtime: false,
      collections: [
        {
          collection: "options_chain",
          limit: 20,
          // Three days tolerates a weekend or holiday close without accepting a
          // genuinely stale chain.
          freshnessMaxMinutes: 3 * 24 * 60,
        },
      ],
    });
  }
  targets.push({
    id: "cross-asset-sentiment-news",
    // Ticker-oriented providers need a bounded instrument, while GDELT uses
    // the explicit topic query instead of treating prose as a symbol.
    instrument: "SPY",
    assetClass: "us_equity",
    realtime: false,
    collections: [{ ...buildNewsCollection(), seriesId: "market sentiment" }],
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
  asOfMode: FinanceAsOfMode | undefined,
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
      ...(asOfMode === undefined ? {} : { asOfMode }),
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
  plannedOrchestration?: FinanceBrainOrchestrationPlan,
): FinanceResearchPlan {
  const ask = requiredText(input.ask, "ask");
  const asOf = assertIsoTimestamp(input.asOf, "asOf");
  const decisionMode = input.decisionMode ?? "research_only";
  const portfolioContext =
    input.portfolioContext === undefined
      ? undefined
      : financeResearchPortfolioContextSchema.parse(input.portfolioContext);
  const orchestration =
    plannedOrchestration ??
    planFinanceBrainOrchestration({
      text: ask,
      moduleSelection: input.moduleSelection,
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
    input.asOfMode,
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
    ...(input.asOfMode === undefined ? {} : { asOfMode: input.asOfMode }),
    horizonMonths,
    decisionMode,
    orchestration,
    targets: Object.freeze([...targets]),
    expectedJobCount,
    sourceInspections: inspections,
    ...(portfolioContext === undefined ? {} : { portfolioContext }),
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
      ...(portfolioContext === undefined
        ? []
        : ["model_allocation_requires_controller_strategy_set_and_grounded_evidence"]),
    ]),
  });
}

/**
 * Module execution may require collections that the small default canary does not fetch. Keep
 * this opt-in so planning and legacy research retain their existing request budget; explicit
 * module execution expands only the caller's existing targets and never invents a provider.
 */
export function augmentTargetsForFinanceModuleExecution(
  targets: readonly FinanceResearchBatchTarget[],
  orchestration: FinanceBrainOrchestrationPlan,
): readonly FinanceResearchBatchTarget[] {
  const moduleIds = new Set(orchestration.composition.nodes.map((node) => node.moduleId));
  const requestedCollections = new Set<string>();
  if (moduleIds.has("company_fundamentals_value")) {
    for (const collection of [
      "financial_statements",
      "company_profile",
      "sec_filings",
      "valuation",
    ] as const) {
      requestedCollections.add(collection);
    }
  }
  if (moduleIds.has("options_volatility")) {
    requestedCollections.add("options_chain");
  }
  if (moduleIds.has("event_driven")) {
    for (const collection of ["event_calendar", "earnings"] as const) {
      requestedCollections.add(collection);
    }
  }
  if (moduleIds.has("technical_timing")) {
    requestedCollections.add("technical_indicators");
  }
  if (requestedCollections.size === 0) {
    return targets;
  }
  return Object.freeze(
    targets.map((target) => {
      if (target.assetClass !== "us_equity") {
        return target;
      }
      const existing = new Set<string>(
        (target.collections ?? []).map((collection) => collection.collection),
      );
      const additions = [...requestedCollections]
        .filter((collection) => !existing.has(collection))
        .map((collection) => ({
          collection,
          limit: 20,
          freshnessMaxMinutes:
            collection === "event_calendar" || collection === "earnings"
              ? 7 * 24 * 60
              : 366 * 24 * 60,
        })) as FinanceResearchBatchCollection[];
      return additions.length === 0
        ? target
        : { ...target, collections: Object.freeze([...(target.collections ?? []), ...additions]) };
    }),
  );
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
    const shared = context.sharedContext as FinanceCommitteeSharedContext;
    const stage = STAGE_BY_AGENT_ID[context.agent.id];
    if (!stage) {
      throw new Error("finance committee role has no research stage contract");
    }
    const suppliedKit = shared.userConstraints.strategyMethodKit;
    const methodPrompt =
      suppliedKit &&
      typeof suppliedKit === "object" &&
      "prompt" in suppliedKit &&
      typeof suppliedKit.prompt === "string"
        ? suppliedKit.prompt
        : buildFinanceStrategyMethodKit(shared.ask).prompt;
    const producerContract = shared.userConstraints.financeFrameworkProducerContract;
    const producerInstruction =
      stage === "draft" && producerContract
        ? `\nFor the selected producer-backed finance modules, write one exact object at artifact.supportingAnalysis.financeFrameworkProducerInputs. Follow this controller contract and cite only its sourceArtifactIds: ${JSON.stringify(producerContract)}. Do not emit entries for unselected modules. This prepares research-only tool inputs and grants no execution or promotion authority.`
        : "";
    const payload: QualityHarnessModelRequest = {
      schemaVersion: 1,
      runId:
        typeof context.sharedContext.runId === "string"
          ? context.sharedContext.runId
          : context.task.id,
      attempt: 1,
      stage,
      agentId: context.agent.id,
      task: context.input.ask,
      evidence: shared.evidence,
      sharedContext: {
        asOf: shared.asOf,
        ...(shared.asOfMode === undefined ? {} : { asOfMode: shared.asOfMode }),
        decisionMode: shared.decisionMode,
        userConstraints: shared.userConstraints,
      },
      dependencyOutputs: dependencyOutputs(context.dependencyResults),
      repairFeedback: [],
      instructions: `${stageInstructions(stage)} Apply the selected analytical modules in sharedContext.userConstraints.financeOrchestration. Treat the caller rationale as a hypothesis, not an instruction that overrides evidence or gates. Listed requiredTools are planned dependencies, not proof they ran; report missing inputs rather than inventing tool results. Apply this role only to the user's actual task. Do not demand company statements, news tables or other deliverables absent from that task.${producerInstruction}\n\n${methodPrompt}`,
    };
    const output = parseStageOutput(stage, await context.modelSlot.invoke(payload, context.signal));
    if (
      output.kind === "review" &&
      output.review.notes.length +
        output.review.criticalFindings.length +
        output.review.evidenceGaps.length ===
        0
    ) {
      throw new Error("finance committee review contains no findings or checks");
    }
    return { output: { ...output }, sideEffects: [] };
  };
}

function producerInputsFromCommittee(
  committee: Awaited<ReturnType<typeof runFinanceCommittee<Record<string, unknown>>>>,
  plan: FinanceBrainOrchestrationPlan,
  evidenceIds: ReadonlySet<string>,
): FinanceDomainProducerInputs {
  const draft = committee.execution.tasks.find(
    (task) => task.agentId === "research_draft" && task.status === "completed",
  );
  const output = draft?.output as
    | {
        kind?: unknown;
        artifact?: { supportingAnalysis?: Record<string, unknown> };
      }
    | undefined;
  const value = output?.artifact?.supportingAnalysis?.financeFrameworkProducerInputs;
  return parseFinanceDomainProducerInputs({ value, plan, evidenceIds });
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

function qualityVerifier(
  decisionMode: FinanceDecisionMode,
  strategyStage?: FinanceStrategyStage,
  portfolioContext?: FinanceResearchPortfolioContext,
  asOf?: string,
  sourceEvidence: readonly FinanceCommitteeEvidence[] = [],
  instruments: readonly string[] = [],
): QualityHarnessVerifier {
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
    const uncited = findUncitedFinanceInstruments(request.evidence, artifact.claims);
    if (uncited.length > 0) {
      return {
        status: "failed",
        summary: "supported instrument claims must cite their own supplied evidence",
        details: uncited,
      };
    }
    try {
      const visibleEvidenceIds = new Set(request.evidence.map((entry) => entry.id));
      validateFinanceResearchThesisProposals({
        value: artifact.supportingAnalysis?.financeThesisProposals,
        claims: artifact.claims,
        evidence: sourceEvidence.filter((entry) => visibleEvidenceIds.has(entry.id)),
        instruments,
        asOf: asOf ?? "",
        receiptReference: "quality-verification-only",
        runId: "quality-verification-only",
      });
    } catch (error) {
      return {
        status: "failed",
        summary: "finance thesis proposal failed deterministic evidence validation",
        details: [error instanceof Error ? error.message : String(error)],
      };
    }
    if (requiresFinanceResearchAssessment(request.task)) {
      const assessment = verifyFinanceResearchAssessment(
        artifact.supportingAnalysis
          ? {
              causalHypotheses: artifact.supportingAnalysis.causalHypotheses,
              scenarios: artifact.supportingAnalysis.scenarios,
            }
          : undefined,
        evidenceIds,
      );
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
      candidateContext: {
        evidence: request.evidence,
        claims: artifact.claims,
        supportingAnalysis: artifact.supportingAnalysis,
      },
      ...(strategyStage === undefined ? {} : { stage: strategyStage }),
    });
    if (!policy.allowed) {
      return {
        status: "failed",
        summary: "finance decision policy rejected the candidate answer",
        details: [...policy.failedReasons, ...policy.requiredEvidence],
      };
    }
    if (portfolioContext !== undefined) {
      try {
        const proposal = parseFinanceResearchAllocationProposal(artifact.supportingAnalysis);
        const supportedEvidenceIds = new Set(
          artifact.claims
            .filter((claim) => claim.status === "supported")
            .flatMap((claim) => claim.evidenceIds),
        );
        buildFinanceResearchPortfolioPlan({
          asOf: asOf ?? "",
          context: portfolioContext,
          proposal,
          supportedEvidenceIds,
          researchReceiptId: "quality:verification",
        });
      } catch (error) {
        return {
          status: "failed",
          summary: "portfolio allocation proposal failed deterministic compilation",
          details: [error instanceof Error ? error.message : String(error)],
        };
      }
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

function moduleExecutionGate(execution: FinanceModuleExecutionReceipt): FinanceResearchGate {
  return {
    id: "module_execution",
    passed: execution.moduleToolsDispatched,
    reason: execution.moduleToolsDispatched
      ? `all ${execution.nodes.length} composed module nodes produced evidence`
      : execution.requested
        ? `module execution incomplete; succeeded=${execution.nodes.filter((node) => node.status === "succeeded").length}/${execution.nodes.length}`
        : "module execution was not requested",
  };
}

/**
 * Tool calls are evidence only after the final research conclusion still contains every module
 * receipt. A successful pre-model dispatch must not be reported as a completed module gate when
 * the committee or quality stage later blocks the visible answer.
 */
function finalizeModuleExecution(
  execution: FinanceModuleExecutionReceipt,
  evidence: readonly FinanceCommitteeEvidence[],
  finalConclusionReady: boolean,
): FinanceModuleExecutionReceipt {
  if (!execution.requested) {
    return execution;
  }
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  const evidenceIncluded =
    execution.outputEvidenceIds.length > 0 &&
    execution.outputEvidenceIds.every((id) => evidenceIds.has(id));
  return Object.freeze({
    ...execution,
    moduleToolsDispatched: finalConclusionReady && execution.allNodesSucceeded && evidenceIncluded,
  });
}

export async function runFinanceResearchRun(
  options: FinanceResearchRunOptions,
): Promise<FinanceResearchRunReceipt> {
  options.signal?.throwIfAborted();
  if (options.modelCheckpoint) {
    positiveInteger(options.modelCheckpoint.maxModelCalls, "maxModelCalls");
    requiredText(options.modelCheckpoint.path, "model checkpoint path");
    requiredText(options.modelCheckpoint.runId, "model checkpoint runId");
    requiredText(options.modelCheckpoint.executionFingerprint, "model checkpoint fingerprint");
  }
  const moduleSelection = parseFinanceModuleSelection(options.input.moduleSelection);
  const ask = requiredText(options.input.ask, "ask");
  const asOf = assertIsoTimestamp(options.input.asOf, "asOf");
  const controllerEvidence = normalizeControllerEvidence(options.input.controllerEvidence, asOf);
  const horizonMonths = normalizeHorizon(options.input.horizonMonths);
  const decisionMode = options.input.decisionMode ?? "research_only";
  const strategyStage = options.input.strategyStage;
  if (options.input.portfolioContext && decisionMode !== "strategy_candidate") {
    throw new Error("portfolio allocation research requires decisionMode strategy_candidate");
  }
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
  const baseTargets =
    options.input.targets ??
    (options.input.sourcePolicy === "all_registered"
      ? buildAllRegisteredFinanceResearchTargets(
          asOf,
          horizonMonths,
          realtimeAdapters,
          collectionAdapters,
        )
      : buildDefaultFinanceResearchTargets(ask, horizonMonths, asOf));
  const executionTargetPlan =
    options.input.executeModules === true
      ? planFinanceBrainOrchestration({
          text: ask,
          moduleSelection,
          highStakesConclusion: true,
          decisionMode,
        })
      : undefined;
  const targets =
    executionTargetPlan === undefined
      ? baseTargets
      : augmentTargetsForFinanceModuleExecution(baseTargets, executionTargetPlan);
  const plan = buildPlan(
    { ...options.input, ask, asOf, decisionMode, moduleSelection },
    targets,
    horizonMonths,
    realtimeAdapters,
    collectionAdapters,
    executionTargetPlan,
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
    ...(options.signal
      ? {
          signal: options.batchOptions?.signal
            ? AbortSignal.any([options.signal, options.batchOptions.signal])
            : options.signal,
        }
      : {}),
    ...(options.modelCheckpoint
      ? { correlationId: `finance-research:${shortHash(options.modelCheckpoint.runId)}` }
      : {}),
    targets,
    asOf,
    useCase: "finance_research_run",
    ...(options.input.asOfMode === undefined ? {} : { asOfMode: options.input.asOfMode }),
    ...(options.sourceGovernance === undefined
      ? {}
      : { sourceGovernance: options.sourceGovernance }),
    realtimeAdapters,
    collectionAdapters,
  });
  let evidence: readonly FinanceCommitteeEvidence[] = [
    ...controllerEvidence,
    ...buildFinanceResearchModelEvidence(batch, {
      includeReviewEvidence:
        options.input.sourcePolicy === "all_registered" ||
        options.batchOptions?.includeReviewEvidence,
    }),
  ];
  batch = { ...batch, committeeEvidence: evidence };
  let moduleExecution = createUnrequestedFinanceModuleExecutionReceipt(plan.orchestration);
  let moduleMissingEvidence: string[] = [];
  const producerInputIssues: string[] = [];
  const baseMissing = [
    ...missingEvidence(batch),
    ...(plan.sourceInventory?.unplannedAdapterIds.map((id) => `source_not_planned:${id}`) ?? []),
    ...(plan.sourceInventory?.unavailableProviders.map(
      (item) => `source_not_registered:${item.provider}`,
    ) ?? []),
  ];
  const sourceRecovery = buildFinanceSourceRecoveryPlan(batch, asOf);
  const hasModelEvidence = evidence.some((item) => item.id.startsWith("finance-model:"));
  const hasModel = options.modelRouting !== undefined || options.modelInvoker !== undefined;
  if (!hasModel || !hasModelEvidence) {
    const modelBlockReason = !hasModel ? "model_not_configured" : "source_evidence_unavailable";
    const source = sourceGate(batch, plan);
    const quality = qualityGate(undefined);
    moduleExecution = finalizeModuleExecution(moduleExecution, evidence, false);
    const quarterlyOutput = buildQuarterlyOutput({
      horizonMonths,
      plan,
      evidenceIds: evidence.map((item) => item.id),
      adopted: false,
      missingEvidence: [...baseMissing, ...moduleMissingEvidence, modelBlockReason],
    });
    const blockedGates: FinanceResearchGate[] = [
      source,
      { id: "committee", passed: false, reason: modelBlockReason },
      quality,
      ...(moduleExecution.requested ? [moduleExecutionGate(moduleExecution)] : []),
      { id: "quarterly_output", passed: false, reason: "upstream model gate failed" },
    ];
    return Object.freeze({
      schemaVersion: FINANCE_RESEARCH_RUN_SCHEMA_VERSION,
      boundary: "finance_research_run_research_only",
      status: hasModel && batch.status !== "blocked" ? "needs_review" : "blocked",
      answerDecision: "return_failed_reason",
      plan,
      batch,
      sourceRecovery,
      moduleExecution,
      quarterlyOutput,
      gates: Object.freeze(blockedGates),
      missingEvidence: Object.freeze([...baseMissing, ...moduleMissingEvidence, modelBlockReason]),
      notTouched: NOT_TOUCHED,
    });
  }

  const strategyMethodKit = buildFinanceStrategyMethodKit(ask);
  const strategyMethodKitModelContext = toFinanceStrategyMethodKitModelContext(strategyMethodKit);
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
        strategyMethodKit,
        financeOrchestration: plan.orchestration,
        qualityEnabled: options.qualityEnabled ?? true,
        allowProviderCalls: options.allowProviderCalls === true,
        committeeConfigured: hasModel,
        qualityConfigured:
          options.qualityModelRouting !== undefined || options.qualityModelInvoker !== undefined,
      })
    : undefined;
  try {
    options.signal?.throwIfAborted();
    const committeeInput: FinanceCommitteeInput = {
      ask,
      asOf,
      ...(options.input.asOfMode === undefined ? {} : { asOfMode: options.input.asOfMode }),
      decisionMode,
      evidence,
      userConstraints: {
        horizonMonths,
        sourceStatus: batch.status,
        researchOnly: true,
        strategyMethodKit: strategyMethodKitModelContext,
        financeOrchestration: plan.orchestration,
        financeModuleExecution: moduleExecution,
        ...(options.input.executeModules === true
          ? {
              financeFrameworkProducerContract: financeProducerInputContract(
                plan.orchestration,
                evidence.map((item) => item.id),
              ),
            }
          : {}),
      },
    };
    // Validate before starting the DAG so malformed evidence cannot become a partial model run.
    buildFinanceCommitteeContext(committeeInput);
    const executeCommittee = () =>
      runFinanceCommittee<Record<string, unknown>>({
        signal: options.signal,
        allowProviderCalls: options.allowProviderCalls,
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

    if (options.input.executeModules === true) {
      let domainProducerInputs: FinanceDomainProducerInputs | undefined;
      try {
        domainProducerInputs = producerInputsFromCommittee(
          committee,
          plan.orchestration,
          new Set(evidence.map((item) => item.id)),
        );
      } catch (error) {
        producerInputIssues.push(
          `module_producer_input:${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const executed = await (options.moduleExecutor ?? executeFinanceModuleComposition)({
        ask,
        asOf,
        plan: plan.orchestration,
        batch,
        workspaceDir: resolveWorkspaceRoot(options.workspaceDir),
        ...(domainProducerInputs === undefined ? {} : { domainProducerInputs }),
        signal: options.signal,
      });
      moduleExecution = executed.receipt;
      // Quality reviews the original packet and the real producer/inspect receipts together.
      // Keep module receipts first so the bounded quality window cannot clip them.
      evidence = [...executed.evidence, ...evidence];
      batch = { ...batch, committeeEvidence: evidence };
      moduleMissingEvidence = [
        ...producerInputIssues,
        ...moduleExecution.nodes.flatMap((node) =>
          node.missingEvidence.map((item) => `module:${node.moduleId}:${item}`),
        ),
      ];
    }

    const qualityRequested = options.qualityEnabled !== false;
    let quality: QualityHarnessReceipt | undefined;
    if (
      qualityRequested &&
      (options.qualityModelRouting !== undefined || options.qualityModelInvoker !== undefined)
    ) {
      const qualityRequest = {
        task:
          `${ask}\nApply the selected analytical modules in sharedContext.financeOrchestration and only the supplied method kit checks relevant to this task. A caller selection does not establish evidence or tool execution. Preserve the requested horizon and deliverable; do not add a forecast or backtest to a factual request. Cite supporting evidence IDs, distinguish inference, and state missing evidence. Keep research-only and do not provide execution instructions.` +
          (plan.portfolioContext
            ? "\nAlso propose budget fractions for every controller-listed active strategy in supportingAnalysis.portfolioAllocationProposal.allocations. Each allocation must contain only strategyId, budgetFraction, and evidenceIds; cite supplied evidence, keep the total at or below 1, and leave unused capital as cash. This is a reviewable proposal, not execution authority."
            : "") +
          "\nOptionally propose financeThesisProposals in artifact.supportingAnalysis for investment-relevant, evidence-supported claims only. Each proposal must have claimId (an id in artifact.claims with status supported), instrument (one declared research target), optional rationale, and nonempty invalidationConditions. Do not repeat evidenceIds in the proposal; the system derives them from the supported claim. Omit the field or use an empty array when no adequately supported thesis exists. This is an unadopted research candidate, not a trade instruction.",
        evidence: qualityEvidence(batch),
        sharedContext: {
          asOf,
          ...(options.input.asOfMode === undefined ? {} : { asOfMode: options.input.asOfMode }),
          horizonMonths,
          decisionMode,
          sourceStatus: batch.status,
          sourceGatePassed: sourceGate(batch, plan).passed,
          committeeGatePassed: committeeGateResult.passed,
          noExecutionAuthority: true,
          strategyMethodKit: strategyMethodKitModelContext,
          financeOrchestration: plan.orchestration,
          financeModuleExecution: moduleExecution,
          ...(plan.portfolioContext
            ? {
                portfolioAllocationContract: {
                  activeStrategyIds: plan.portfolioContext.activeStrategyIds,
                  accountId: plan.portfolioContext.accountId,
                  venue: plan.portfolioContext.venue,
                  validityMinutes: plan.portfolioContext.validityMinutes,
                  conflictPolicy: plan.portfolioContext.conflictPolicy,
                  outputPath: "supportingAnalysis.portfolioAllocationProposal.allocations",
                  executionAuthority: "none",
                },
              }
            : {}),
          financeThesisProposalContract: {
            outputPath: "artifact.supportingAnalysis.financeThesisProposals",
            declaredInstruments: plan.targets.map((target) => target.instrument),
            evidenceIdsDerivedFrom: "the referenced supported claim",
            executionAuthority: "none",
          },
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
          signal: options.signal,
          allowProviderCalls: options.allowProviderCalls,
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
          taskTimeoutMs: options.qualityModelRouting
            ? modelRoutingTaskTimeoutMs(options.qualityModelRouting)
            : 180_000,
          verifierTimeoutMs: 10_000,
          maxAttempts: 2,
          verify: qualityVerifier(
            decisionMode,
            strategyStage,
            plan.portfolioContext,
            asOf,
            evidence,
            plan.targets.map((target) => target.instrument),
          ),
        });
      quality = modelCheckpoint
        ? await modelCheckpoint.stage("quality", executeQuality)
        : await executeQuality();
    }
    const source = sourceGate(batch, plan);
    const qualityGateResult = qualityGate(quality);
    moduleExecution = finalizeModuleExecution(
      moduleExecution,
      evidence,
      committeeGateResult.passed && qualityGateResult.passed,
    );
    const moduleGateResult = moduleExecution.requested
      ? moduleExecutionGate(moduleExecution)
      : undefined;
    const allGatesPassed =
      source.passed &&
      committeeGateResult.passed &&
      qualityGateResult.passed &&
      (moduleGateResult === undefined || moduleGateResult.passed);
    const quarterlyOutput = buildQuarterlyOutput({
      horizonMonths,
      plan,
      evidenceIds: evidence.map((item) => item.id),
      quality,
      committee: model,
      adopted: allGatesPassed,
      missingEvidence: [...baseMissing, ...moduleMissingEvidence],
    });
    const gates: FinanceResearchGate[] = [
      source,
      committeeGateResult,
      qualityGateResult,
      ...(moduleGateResult === undefined ? [] : [moduleGateResult]),
      {
        id: "quarterly_output" as const,
        passed: allGatesPassed,
        reason: allGatesPassed
          ? "quarterly candidate passed source, committee, and quality gates"
          : "quarterly output remains a non-adopted candidate because an upstream gate failed",
      },
    ];
    const portfolioPlan =
      allGatesPassed && plan.portfolioContext && quality?.finalArtifact
        ? buildFinanceResearchPortfolioPlan({
            asOf,
            context: plan.portfolioContext,
            proposal: parseFinanceResearchAllocationProposal(
              quality.finalArtifact.supportingAnalysis,
            ),
            supportedEvidenceIds: new Set(
              quality.finalArtifact.claims
                .filter((claim) => claim.status === "supported")
                .flatMap((claim) => claim.evidenceIds),
            ),
            researchReceiptId: `quality:${quality.runId}`,
          })
        : undefined;
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
      sourceRecovery,
      committee: {
        coverage: committee.coverage,
        model,
      },
      ...(quality === undefined ? {} : { quality }),
      ...(modelCheckpoint ? { modelCheckpoint: modelCheckpoint.summary() } : {}),
      moduleExecution,
      quarterlyOutput,
      ...(portfolioPlan === undefined ? {} : { portfolioPlan }),
      gates: Object.freeze(gates),
      missingEvidence: Object.freeze([...baseMissing, ...moduleMissingEvidence]),
      notTouched: NOT_TOUCHED,
    });
  } catch (error) {
    if (!(error instanceof FinanceModelStageUncertainError)) {
      throw error;
    }
    moduleExecution = finalizeModuleExecution(moduleExecution, evidence, false);
    return {
      schemaVersion: FINANCE_RESEARCH_RUN_SCHEMA_VERSION,
      boundary: "finance_research_run_research_only",
      status: "needs_review",
      answerDecision: "return_failed_reason",
      plan,
      batch,
      sourceRecovery,
      modelCheckpoint: modelCheckpoint?.summary(),
      quarterlyOutput: buildQuarterlyOutput({
        horizonMonths,
        plan,
        evidenceIds: evidence.map((item) => item.id),
        adopted: false,
        missingEvidence: [...baseMissing, ...moduleMissingEvidence, error.message],
      }),
      gates: [
        sourceGate(batch, plan),
        ...(["committee", "quality"] as const).map((id) => ({
          id,
          passed: false,
          reason: error.message,
        })),
        ...(moduleExecution.requested ? [moduleExecutionGate(moduleExecution)] : []),
        {
          id: "quarterly_output" as const,
          passed: false,
          reason: error.message,
        },
      ],
      moduleExecution,
      missingEvidence: [...baseMissing, ...moduleMissingEvidence, error.message],
      notTouched: NOT_TOUCHED,
    };
  } finally {
    modelCheckpoint?.close();
  }
}
