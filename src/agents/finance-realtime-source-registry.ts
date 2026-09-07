import { createHash } from "node:crypto";
import {
  createAlphaVantageMarketAdapter,
  createInvescoIssuerReferenceAdapter,
  createNasdaqExchangeMarketAdapter,
  createSecOfficialReferenceAdapter,
  createStooqDelayedMarketAdapter,
} from "./finance-additional-source-adapters.js";
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
  additionalAdapters?: readonly FinanceRealtimeSourceAdapter[];
}>;

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refreshId(request: FinanceRealtimeSourceRequest, adapterIds: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ request, adapterIds }), "utf8")
    .digest("hex")
    .slice(0, 24);
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
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<FinanceDataGatewayObservationInput> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      adapter.collect(request, controller.signal),
      new Promise<FinanceDataGatewayObservationInput>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(`adapter ${adapter.id} timed out or was cancelled`)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

export async function runFinanceRealtimeRefresh(options: {
  request: FinanceRealtimeSourceRequest;
  adapters: readonly FinanceRealtimeSourceAdapter[];
  maxSources?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
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
  const selected = candidates.slice(0, maxSources);
  const sourceAttempts: FinanceRealtimeSourceAttempt[] = [];
  const observations: FinanceDataGatewayObservationInput[] = [];

  for (const adapter of selected) {
    const startedAt = Date.now();
    try {
      const observation = await collectWithTimeout(adapter, request, timeoutMs, options.signal);
      observations.push(observation);
      sourceAttempts.push({
        adapterId: adapter.id,
        providerName: adapter.providerName,
        providerRole: adapter.providerRole,
        priority: adapter.priority,
        status: "succeeded",
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      sourceAttempts.push({
        adapterId: adapter.id,
        providerName: adapter.providerName,
        providerRole: adapter.providerRole,
        priority: adapter.priority,
        status: "failed",
        latencyMs: Math.max(0, Date.now() - startedAt),
        error: errorText(error),
      });
    }
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
    adaptersCalled: selected.length > 0,
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
      const quote = await fetchYahooQuote(request.instrument, { fetchImpl: options.fetchImpl });
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
    createYahooDelayedMarketAdapter(options),
    createBinanceCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createKrakenCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createCoinbaseCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createBybitCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createOkxCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createBitstampCryptoTickerAdapter({ fetchImpl: options.fetchImpl }),
    createCoinCapCryptoAssetAdapter({
      apiKey: options.coinCapApiKey,
      fetchImpl: options.fetchImpl,
    }),
    createNasdaqExchangeMarketAdapter({ fetchImpl: options.fetchImpl }),
    createStooqDelayedMarketAdapter({ fetchImpl: options.fetchImpl }),
    createSecOfficialReferenceAdapter({ fetchImpl: options.fetchImpl }),
    createInvescoIssuerReferenceAdapter({ fetchImpl: options.fetchImpl }),
  ];
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
  adapters.push(...(options.additionalAdapters ?? []));
  return adapters;
}
