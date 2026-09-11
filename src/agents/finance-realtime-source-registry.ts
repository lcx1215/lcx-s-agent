import { createHash, randomUUID } from "node:crypto";
import {
  apiSourceErrorText,
  runApiSourceCall,
  type ApiSourceGovernanceRegistry,
  type ApiCallReceipt,
  type ApiTransportOptions,
} from "./api-call-contract.js";
import {
  createAlphaVantageMarketAdapter,
  createInvescoIssuerReferenceAdapter,
  createNasdaqExchangeMarketAdapter,
  createSecOfficialReferenceAdapter,
  createStooqDelayedMarketAdapter,
} from "./finance-additional-source-adapters.js";
import { financeReuseTimestamp } from "./finance-cache-provenance.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import {
  createBitstampCryptoTickerAdapter,
  createBybitCryptoTickerAdapter,
  createOkxCryptoTickerAdapter,
} from "./finance-crypto-fast-source-adapters.js";
import {
  createBinanceCryptoTickerAdapter,
  createCoinbaseCryptoTickerAdapter,
  createCoinCapCryptoAssetAdapter,
  createCoinGeckoCryptoPriceAdapter,
  createKrakenCryptoTickerAdapter,
} from "./finance-crypto-source-adapters.js";
import {
  buildFinanceDataGatewaySnapshot,
  type FinanceDataGatewayInput,
  type FinanceDataGatewayObservationInput,
  type FinanceDataGatewaySnapshot,
} from "./finance-data-gateway.js";
import {
  fetchYahooQuote,
  quoteToObservation,
  type FetchImpl,
} from "./finance-live-market-source.js";
import { mapFinanceSourceLanes } from "./finance-source-scheduler.js";
import {
  createAlpacaUsEquityQuoteAdapter,
  createFinnhubUsEquityQuoteAdapter,
  createMassiveUsEquitySnapshotAdapter,
  createSecCompanyFactsAdapter,
  createTwelveDataUsEquityQuoteAdapter,
} from "./finance-us-equity-source-adapters.js";

export const FINANCE_REALTIME_REFRESH_SCHEMA_VERSION = "lcx_finance_realtime_refresh_v1" as const;

export type FinanceRealtimeSourceRequest = Readonly<{
  instrument: string;
  assetClass: string;
  useCase: string;
  asOf: string;
  freshnessMaxMinutes?: number;
  crossSourceSkewMaxMinutes?: number;
  requireOfficialReference?: boolean;
}>;

export type FinanceRealtimeSourceAdapter = Readonly<{
  id: string;
  providerName: string;
  providerRole: FinanceDataGatewayObservationInput["providerRole"];
  priority: number;
  supports: (request: FinanceRealtimeSourceRequest) => boolean;
  collect: (
    request: FinanceRealtimeSourceRequest,
    signal: AbortSignal,
  ) => Promise<FinanceDataGatewayObservationInput>;
}>;

export type FinanceRealtimeSourceAttempt = Readonly<{
  adapterId: string;
  providerName: string;
  providerRole: FinanceRealtimeSourceAdapter["providerRole"];
  priority: number;
  status: "succeeded" | "failed";
  latencyMs: number;
  error?: string;
  apiCalls?: readonly ApiCallReceipt[];
}>;

export type FinanceRealtimeRefreshReceipt = Readonly<{
  schemaVersion: typeof FINANCE_REALTIME_REFRESH_SCHEMA_VERSION;
  refreshId: string;
  boundary: "finance_realtime_refresh_research_only";
  request: FinanceRealtimeSourceRequest;
  status: "ready" | "needs_review" | "blocked";
  snapshot?: FinanceDataGatewaySnapshot;
  sourceAttempts: readonly FinanceRealtimeSourceAttempt[];
  selectedSourceIds: readonly string[];
  missingEvidence: readonly string[];
  requiredNextSteps: readonly string[];
  adaptersCalled: boolean;
  notTouched: readonly string[];
}>;

export type FinanceRealtimeRegistryInspection = Readonly<{
  schemaVersion: typeof FINANCE_REALTIME_REFRESH_SCHEMA_VERSION;
  boundary: "finance_realtime_source_registry_local_only";
  request: FinanceRealtimeSourceRequest;
  candidateAdapters: readonly Readonly<{
    id: string;
    providerName: string;
    providerRole: FinanceRealtimeSourceAdapter["providerRole"];
    priority: number;
  }>[];
  noNetworkCalled: true;
}>;

export type FinanceRealtimeSourceRegistryOptions = Readonly<{
  fetchImpl?: FetchImpl;
  alphaVantageApiKey?: string;
  coinGeckoApiKey?: string;
  coinCapApiKey?: string;
  massiveApiKey?: string;
  alpacaApiKeyId?: string;
  alpacaApiSecretKey?: string;
  alpacaFeed?: string;
  finnhubApiKey?: string;
  twelveDataApiKey?: string;
  /** Yahoo's public chart endpoint is opt-in because it can reject automated traffic. */
  includeYahooPublicSource?: boolean;
  additionalAdapters?: readonly FinanceRealtimeSourceAdapter[];
}>;

export function resolveFinanceRealtimeSourceRegistryOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FinanceRealtimeSourceRegistryOptions {
  if (env === process.env) {
    env = resolveFinanceCredentialEnv(env);
  }
  return {
    alphaVantageApiKey: env.ALPHA_VANTAGE_API_KEY?.trim() || undefined,
    coinGeckoApiKey: env.COINGECKO_API_KEY?.trim() || undefined,
    coinCapApiKey: env.COINCAP_API_KEY?.trim() || undefined,
    massiveApiKey: env.MASSIVE_API_KEY?.trim() || undefined,
    alpacaApiKeyId: env.ALPACA_API_KEY_ID?.trim() || undefined,
    alpacaApiSecretKey: env.ALPACA_API_SECRET_KEY?.trim() || undefined,
    alpacaFeed: env.ALPACA_DATA_FEED?.trim() || undefined,
    finnhubApiKey: env.FINNHUB_API_KEY?.trim() || undefined,
    twelveDataApiKey: env.TWELVE_DATA_API_KEY?.trim() || undefined,
    includeYahooPublicSource: env.LCX_ENABLE_YAHOO_PUBLIC_SOURCE === "1",
  };
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} required`);
  }
  return normalized;
}

function assertIsoTimestamp(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function normalizeRequest(request: FinanceRealtimeSourceRequest): FinanceRealtimeSourceRequest {
  return {
    instrument: requiredText(request.instrument, "instrument"),
    assetClass: requiredText(request.assetClass, "assetClass"),
    useCase: requiredText(request.useCase, "useCase"),
    asOf: assertIsoTimestamp(request.asOf, "asOf"),
    freshnessMaxMinutes: request.freshnessMaxMinutes,
    crossSourceSkewMaxMinutes: request.crossSourceSkewMaxMinutes,
    requireOfficialReference: request.requireOfficialReference,
  };
}

function roleRank(role: FinanceRealtimeSourceAdapter["providerRole"]): number {
  return role === "primary_market_data" ? 0 : role === "cross_check_market_data" ? 1 : 2;
}

function orderedAdapters(
  request: FinanceRealtimeSourceRequest,
  adapters: readonly FinanceRealtimeSourceAdapter[],
): FinanceRealtimeSourceAdapter[] {
  return adapters
    .filter((adapter) => adapter.supports(request))
    .toSorted(
      (left, right) =>
        roleRank(left.providerRole) - roleRank(right.providerRole) ||
        left.priority - right.priority ||
        left.id.localeCompare(right.id),
    );
}

function selectAdapters(
  candidates: readonly FinanceRealtimeSourceAdapter[],
  maxSources: number,
  requireOfficialReference: boolean | undefined,
): FinanceRealtimeSourceAdapter[] {
  const selected = candidates.slice(0, maxSources);
  if (
    !requireOfficialReference ||
    selected.some((adapter) => adapter.providerRole === "official_or_issuer_reference")
  ) {
    return selected;
  }
  const official = candidates.find(
    (adapter) => adapter.providerRole === "official_or_issuer_reference",
  );
  if (!official) {
    return selected;
  }
  return [...selected.slice(0, Math.max(0, maxSources - 1)), official];
}

function errorText(error: unknown): string {
  return apiSourceErrorText(error);
}

function refreshId(request: FinanceRealtimeSourceRequest, adapterIds: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ request, adapterIds }), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function validateObservationTimestamps(
  observation: FinanceDataGatewayObservationInput,
  asOf: string,
): FinanceDataGatewayObservationInput {
  const cutoff = Date.parse(asOf);
  const fields = observation.fields.filter((field) => {
    const sourceTimestamp =
      typeof field.sourceTimestamp === "string" ? Date.parse(field.sourceTimestamp) : Number.NaN;
    return Number.isFinite(sourceTimestamp) && sourceTimestamp <= cutoff;
  });
  if (fields.length === 0) {
    throw new Error("finance source returned no timestamped field at or before requested asOf");
  }
  return fields.length === observation.fields.length ? observation : { ...observation, fields };
}

function validateAdapters(adapters: readonly FinanceRealtimeSourceAdapter[]): void {
  const ids = new Set<string>();
  for (const [index, adapter] of adapters.entries()) {
    requiredText(adapter.id, `adapters[${index}].id`);
    requiredText(adapter.providerName, `adapters[${index}].providerName`);
    if (ids.has(adapter.id)) {
      throw new Error(`duplicate finance realtime adapter id: ${adapter.id}`);
    }
    ids.add(adapter.id);
    if (!Number.isFinite(adapter.priority) || adapter.priority < 0) {
      throw new Error(`adapters[${index}].priority must be a non-negative number`);
    }
  }
}

export function inspectFinanceRealtimeSourceRegistry(
  request: FinanceRealtimeSourceRequest,
  adapters: readonly FinanceRealtimeSourceAdapter[],
): FinanceRealtimeRegistryInspection {
  const normalizedRequest = normalizeRequest(request);
  validateAdapters(adapters);
  return {
    schemaVersion: FINANCE_REALTIME_REFRESH_SCHEMA_VERSION,
    boundary: "finance_realtime_source_registry_local_only",
    request: normalizedRequest,
    candidateAdapters: orderedAdapters(normalizedRequest, adapters).map((adapter) => ({
      id: adapter.id,
      providerName: adapter.providerName,
      providerRole: adapter.providerRole,
      priority: adapter.priority,
    })),
    noNetworkCalled: true,
  };
}

async function collectWithTimeout(
  adapter: FinanceRealtimeSourceAdapter,
  request: FinanceRealtimeSourceRequest,
  options: ApiTransportOptions,
  onCollect: () => void,
): Promise<FinanceDataGatewayObservationInput> {
  return runApiSourceCall(
    {
      ...options,
      provider: adapter.providerName,
      source: adapter.id,
      operation: "collect",
    },
    (signal) => {
      onCollect();
      return adapter.collect(request, signal);
    },
  );
}

export async function runFinanceRealtimeRefresh(options: {
  request: FinanceRealtimeSourceRequest;
  adapters: readonly FinanceRealtimeSourceAdapter[];
  maxSources?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  correlationId?: string;
  retry?: ApiTransportOptions["retry"];
  sourceGovernance?: ApiSourceGovernanceRegistry;
  beforeHttpDispatch?: ApiTransportOptions["beforeHttpDispatch"];
  cacheMaxAgeMs?: number;
  maxSourceConcurrency?: number;
}): Promise<FinanceRealtimeRefreshReceipt> {
  const request = normalizeRequest(options.request);
  validateAdapters(options.adapters);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  const candidates = orderedAdapters(request, options.adapters);
  const maxSources = options.maxSources ?? candidates.length;
  if (!Number.isInteger(maxSources) || maxSources <= 0) {
    throw new Error("maxSources must be a positive integer");
  }
  const selected = selectAdapters(candidates, maxSources, request.requireOfficialReference);
  const sourceAttempts: FinanceRealtimeSourceAttempt[] = [];
  const observations: FinanceDataGatewayObservationInput[] = [];

  let adaptersCalled = false;
  const correlationId = options.correlationId ?? randomUUID();
  const results = await mapFinanceSourceLanes(
    selected,
    async (adapter) => {
      const sourceAttempts: FinanceRealtimeSourceAttempt[] = [];
      const observations: FinanceDataGatewayObservationInput[] = [];
      const apiCalls: ApiCallReceipt[] = [];
      const startedAt = Date.now();
      try {
        const observation = await collectWithTimeout(
          adapter,
          request,
          {
            timeoutMs,
            cacheMaxAgeMs: Math.min(
              options.cacheMaxAgeMs ?? Infinity,
              (request.freshnessMaxMinutes ?? 15) * 60_000,
            ),
            signal: options.signal,
            correlationId,
            retry: options.retry,
            beforeHttpDispatch: options.beforeHttpDispatch,
            ...(() => {
              const governance = options.sourceGovernance?.forSource(adapter.id);
              return governance
                ? {
                    rateLimiter: governance.rateLimiter,
                    circuitBreaker: governance.circuitBreaker,
                  }
                : {};
            })(),
            onReceipt: (receipt) => apiCalls.push(receipt),
          },
          () => {
            adaptersCalled = true;
          },
        );
        const reusedAt = financeReuseTimestamp(apiCalls, request.asOf);
        const timestampedObservation = validateObservationTimestamps(observation, request.asOf);
        observations.push(
          reusedAt
            ? {
                ...timestampedObservation,
                observedAt: reusedAt,
                fields: timestampedObservation.fields.map((field) => ({
                  ...field,
                  sourceTimestamp:
                    field.sourceTimestamp === request.asOf ? reusedAt : field.sourceTimestamp,
                })),
              }
            : timestampedObservation,
        );
        sourceAttempts.push({
          adapterId: adapter.id,
          providerName: adapter.providerName,
          providerRole: adapter.providerRole,
          priority: adapter.priority,
          status: "succeeded",
          latencyMs: Math.max(0, Date.now() - startedAt),
          apiCalls: [...apiCalls],
        });
      } catch (error) {
        sourceAttempts.push({
          adapterId: adapter.id,
          providerName: adapter.providerName,
          providerRole: adapter.providerRole,
          priority: adapter.priority,
          status: "failed",
          latencyMs: Math.max(0, Date.now() - startedAt),
          apiCalls: [...apiCalls],
          error: errorText(error),
        });
      }
      return { sourceAttempts, observations };
    },
    options.maxSourceConcurrency,
  );
  for (const result of results) {
    sourceAttempts.push(...result.sourceAttempts);
    observations.push(...result.observations);
  }

  const baseReceipt = {
    schemaVersion: FINANCE_REALTIME_REFRESH_SCHEMA_VERSION,
    refreshId: refreshId(
      request,
      selected.map((adapter) => adapter.id),
    ),
    boundary: "finance_realtime_refresh_research_only" as const,
    request,
    sourceAttempts,
    selectedSourceIds: selected.map((adapter) => adapter.id),
    adaptersCalled,
    notTouched: [
      "provider_config",
      "external_channel_sender",
      "protected_memory",
      "trading_execution",
      "wallet_or_order_authority",
    ],
  };

  if (observations.length === 0) {
    return {
      ...baseReceipt,
      status: "blocked",
      missingEvidence: ["successful_finance_source_observation"],
      requiredNextSteps: ["inspect_source_attempt_failures", "retry_with_healthy_adapter"],
    };
  }

  let snapshot: FinanceDataGatewaySnapshot;
  try {
    const input: FinanceDataGatewayInput = {
      ...request,
      observations,
    };
    snapshot = buildFinanceDataGatewaySnapshot(input);
  } catch (error) {
    return {
      ...baseReceipt,
      status: "blocked",
      missingEvidence: ["valid_normalized_finance_observations"],
      requiredNextSteps: ["repair_source_adapter_contract"],
      sourceAttempts: [
        ...sourceAttempts,
        {
          adapterId: "finance-data-gateway",
          providerName: "canonical-gateway",
          providerRole: "primary_market_data",
          priority: Number.MAX_SAFE_INTEGER,
          status: "failed",
          latencyMs: 0,
          error: errorText(error),
        },
      ],
    };
  }

  return {
    ...baseReceipt,
    status:
      snapshot.qualityStatus === "ready"
        ? "ready"
        : snapshot.qualityStatus === "needs_review"
          ? "needs_review"
          : "blocked",
    snapshot,
    missingEvidence: snapshot.missingEvidence,
    requiredNextSteps: snapshot.requiredNextSteps,
  };
}

export function createYahooDelayedMarketAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "yahoo_public_chart",
    providerName: "yahoo-public-chart",
    providerRole: "primary_market_data",
    priority: 10,
    supports: (request) => request.assetClass.trim().toLowerCase() !== "crypto",
    collect: async (request, signal) => {
      if (signal.aborted) {
        throw new Error("yahoo adapter cancelled before fetch");
      }
      const quote = await fetchYahooQuote(request.instrument, {
        fetchImpl: options.fetchImpl,
        signal,
      });
      if (signal.aborted) {
        throw new Error("yahoo adapter cancelled after fetch");
      }
      return quoteToObservation(quote, {
        providerName: "yahoo-public-chart",
        providerRole: "primary_market_data",
        observedAt: request.asOf,
      });
    },
  };
}

export function createFinanceRealtimeSourceRegistry(
  options: FinanceRealtimeSourceRegistryOptions = {},
): readonly FinanceRealtimeSourceAdapter[] {
  const adapters: FinanceRealtimeSourceAdapter[] = [
    createBinanceCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createKrakenCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createCoinbaseCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createBybitCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createOkxCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createBitstampCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    ...(options.coinCapApiKey?.trim()
      ? [
          createCoinCapCryptoAssetAdapter({
            apiKey: options.coinCapApiKey,
            fetchImpl: options.fetchImpl,
          }),
        ]
      : []),
    createNasdaqExchangeMarketAdapter({ fetchImpl: options.fetchImpl }),
    createStooqDelayedMarketAdapter({ fetchImpl: options.fetchImpl }),
    createSecOfficialReferenceAdapter({ fetchImpl: options.fetchImpl }),
    createSecCompanyFactsAdapter({ fetchImpl: options.fetchImpl }),
    createInvescoIssuerReferenceAdapter({ fetchImpl: options.fetchImpl }),
  ];
  if (options.includeYahooPublicSource) {
    adapters.unshift(createYahooDelayedMarketAdapter(options));
  }
  if (options.alphaVantageApiKey?.trim()) {
    adapters.push(
      createAlphaVantageMarketAdapter({
        apiKey: options.alphaVantageApiKey,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  if (options.coinGeckoApiKey?.trim()) {
    adapters.push(
      createCoinGeckoCryptoPriceAdapter({
        apiKey: options.coinGeckoApiKey,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  if (options.massiveApiKey?.trim()) {
    adapters.push(
      createMassiveUsEquitySnapshotAdapter({
        apiKey: options.massiveApiKey,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  if (options.alpacaApiKeyId?.trim() && options.alpacaApiSecretKey?.trim()) {
    adapters.push(
      createAlpacaUsEquityQuoteAdapter({
        apiKeyId: options.alpacaApiKeyId,
        apiSecretKey: options.alpacaApiSecretKey,
        feed: options.alpacaFeed,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  if (options.finnhubApiKey?.trim()) {
    adapters.push(
      createFinnhubUsEquityQuoteAdapter({
        apiKey: options.finnhubApiKey,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  if (options.twelveDataApiKey?.trim()) {
    adapters.push(
      createTwelveDataUsEquityQuoteAdapter({
        apiKey: options.twelveDataApiKey,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  adapters.push(...(options.additionalAdapters ?? []));
  return adapters;
}
