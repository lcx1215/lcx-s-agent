import { randomUUID } from "node:crypto";
import {
  apiSourceErrorText,
  runApiSourceCall,
  type ApiSourceGovernanceRegistry,
  type ApiCallReceipt,
  type ApiTransportOptions,
} from "./api-call-contract.js";
import { financeReuseTimestamp } from "./finance-cache-provenance.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import type {
  FinanceDataDelayStatus,
  FinanceDataProviderRole,
  FinanceDataSourceFamily,
} from "./finance-data-gateway.js";
import {
  createBinancePublicEodHistoryCollectionAdapter,
  createFredPublicIndexHistoryCollectionAdapter,
  createFmpFreeBasicEodCollectionAdapter,
  createFmpFreeBasicProfileCollectionAdapter,
  createGoogleNewsRssCollectionAdapter,
  createGdeltPublicNewsCollectionAdapter,
  createYahooPublicEodHistoryCollectionAdapter,
  createYahooFinanceRssCollectionAdapter,
} from "./finance-free-market-collection-adapters.js";
import { createGdeltNewsTitlesAdapter } from "./finance-gdelt-news-titles.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import { mapFinanceSourceLanes } from "./finance-source-scheduler.js";

export {
  createBinancePublicEodHistoryCollectionAdapter,
  createFredPublicIndexHistoryCollectionAdapter,
  createFmpFreeBasicEodCollectionAdapter,
  createFmpFreeBasicProfileCollectionAdapter,
  createGoogleNewsRssCollectionAdapter,
  createGdeltPublicNewsCollectionAdapter,
  createYahooPublicEodHistoryCollectionAdapter,
  createYahooFinanceRssCollectionAdapter,
} from "./finance-free-market-collection-adapters.js";

import { createRegisteredCapabilityAdapters } from "./finance-registered-capability-adapters.js";

const SEC_USER_AGENT = "LCX Agent research-only contact=local";

export const FINANCE_MARKET_COLLECTION_SCHEMA_VERSION = "lcx_finance_market_collection_v1" as const;

export const FINANCE_MARKET_COLLECTION_KINDS = [
  "news",
  "options_chain",
  "dividends",
  "splits",
  "macro_series",
  "sec_filings",
  "company_profile",
  "eod_history",
  "financial_statements",
  "earnings",
  "analyst_estimates",
  "ownership",
  "etf_holdings",
  "market_reference",
  "valuation",
  "technical_indicators",
  "event_calendar",
  "transcripts",
  "bulk_dataset",
] as const;
export type FinanceMarketCollectionKind = (typeof FINANCE_MARKET_COLLECTION_KINDS)[number];

export type FinanceMarketCollectionRequest = Readonly<{
  instrument: string;
  assetClass: string;
  collection: FinanceMarketCollectionKind;
  asOf: string;
  seriesId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}>;

export type FinanceMarketCollectionItem = Readonly<{
  itemId: string;
  collection: FinanceMarketCollectionKind;
  providerName: string;
  providerRole: FinanceDataProviderRole;
  sourceFamily: FinanceDataSourceFamily;
  sourceTimestamp: string;
  observedAt: string;
  delayStatus: FinanceDataDelayStatus;
  sourceUrlOrArtifact: string;
  data: Readonly<Record<string, unknown>>;
}>;

export type FinanceMarketCollectionAdapter = Readonly<{
  id: string;
  providerName: string;
  providerRole: FinanceDataProviderRole;
  priority: number;
  /** Representative discovery request; does not override a user request. */
  sampleRequest?: Pick<
    FinanceMarketCollectionRequest,
    "instrument" | "assetClass" | "collection" | "seriesId"
  >;
  supports: (request: FinanceMarketCollectionRequest) => boolean;
  collect: (
    request: FinanceMarketCollectionRequest,
    signal: AbortSignal,
  ) => Promise<readonly FinanceMarketCollectionItem[]>;
}>;

export type FinanceMarketCollectionAttempt = Readonly<{
  adapterId: string;
  providerName: string;
  providerRole: FinanceDataProviderRole;
  priority: number;
  status: "succeeded" | "failed";
  recordCount: number;
  latencyMs: number;
  error?: string;
  apiCalls?: readonly ApiCallReceipt[];
}>;

export type FinanceMarketCollectionReceipt = Readonly<{
  schemaVersion: typeof FINANCE_MARKET_COLLECTION_SCHEMA_VERSION;
  refreshId: string;
  boundary: "finance_market_collection_research_only";
  request: FinanceMarketCollectionRequest;
  status: "ready" | "needs_review" | "blocked";
  records: readonly FinanceMarketCollectionItem[];
  sourceAttempts: readonly FinanceMarketCollectionAttempt[];
  selectedSourceIds: readonly string[];
  missingEvidence: readonly string[];
  requiredNextSteps: readonly string[];
  adaptersCalled: boolean;
  notTouched: readonly string[];
}>;

export type FinanceMarketCollectionRegistryInspection = Readonly<{
  schemaVersion: typeof FINANCE_MARKET_COLLECTION_SCHEMA_VERSION;
  boundary: "finance_market_collection_registry_local_only";
  request: FinanceMarketCollectionRequest;
  candidateAdapters: readonly Readonly<{
    id: string;
    providerName: string;
    providerRole: FinanceDataProviderRole;
    priority: number;
  }>[];
  noNetworkCalled: true;
}>;

export type FinanceMarketCollectionRegistryOptions = Readonly<{
  fetchImpl?: FetchImpl;
  /** Optional evidence sink; receives credential-redacted provider bodies. */
  captureRawResponse?: (
    response: Readonly<{
      adapterId: string;
      sourceUrlOrArtifact: string;
      observedAt: string;
      httpStatus: number;
      body: string;
    }>,
  ) => Promise<string>;
  massiveApiKey?: string;
  finnhubApiKey?: string;
  fredApiKey?: string;
  fmpApiKey?: string;
  alphaVantageApiKey?: string;
  coinGeckoApiKey?: string;
  twelveDataApiKey?: string;
  alpacaApiKeyId?: string;
  alpacaApiSecretKey?: string;
  alpacaDataFeed?: string;
  /** Yahoo public endpoints are opt-in because automated traffic may be rejected. */
  includeYahooPublicSources?: boolean;
  additionalAdapters?: readonly FinanceMarketCollectionAdapter[];
}>;

class FinanceMarketCollectionAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceMarketCollectionAdapterError";
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} required`);
  }
  return normalized;
}

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function assertIsoTimestamp(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function assertIsoDate(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = requiredText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return normalized;
}

function normalizeRequest(request: FinanceMarketCollectionRequest): FinanceMarketCollectionRequest {
  const limit = request.limit ?? 20;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 250) {
    throw new Error("limit must be an integer between 1 and 250");
  }
  return {
    instrument: requiredText(request.instrument, "instrument"),
    assetClass: requiredText(request.assetClass, "assetClass"),
    collection: request.collection,
    asOf: assertIsoTimestamp(request.asOf, "asOf"),
    seriesId: request.seriesId?.trim() || undefined,
    fromDate: assertIsoDate(request.fromDate, "fromDate"),
    toDate: assertIsoDate(request.toDate, "toDate"),
    limit,
  };
}

function errorText(error: unknown): string {
  return apiSourceErrorText(error);
}

function isUsEquity(assetClass: string): boolean {
  return ["common_stock", "equity", "stock", "us_equity"].includes(assetClass.trim().toLowerCase());
}

function isMacroSeries(request: FinanceMarketCollectionRequest): boolean {
  return request.collection === "macro_series";
}

function parseFiniteNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new FinanceMarketCollectionAdapterError(`${label} must be a finite number`);
  }
  return parsed;
}

function isoEpoch(value: unknown, label: string): string {
  const parsed = parseFiniteNumber(value, label);
  const milliseconds =
    parsed > 100_000_000_000_000
      ? parsed / 1_000_000
      : parsed > 10_000_000_000
        ? parsed
        : parsed * 1_000;
  const timestamp = new Date(milliseconds).toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new FinanceMarketCollectionAdapterError(`${label} must be a valid epoch`);
  }
  return timestamp;
}

function isoDate(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed)) {
    throw new FinanceMarketCollectionAdapterError(`${label} must be a date`);
  }
  return new Date(parsed).toISOString();
}

function sourceTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return isoEpoch(value, "source timestamp");
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return isoEpoch(numeric, "source timestamp");
    }
  }
  return fallback;
}

async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let response: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new FinanceMarketCollectionAdapterError(
      `source request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new FinanceMarketCollectionAdapterError(`source http status ${response.status}`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new FinanceMarketCollectionAdapterError("source returned an empty body");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new FinanceMarketCollectionAdapterError("source returned invalid JSON");
  }
}

function resultsFromPayload(payload: unknown, label: string): Readonly<Record<string, unknown>>[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) {
    throw new FinanceMarketCollectionAdapterError(`${label} response has no results array`);
  }
  return results.filter(
    (result): result is Readonly<Record<string, unknown>> =>
      typeof result === "object" && result !== null && !Array.isArray(result),
  );
}

function apiUrl(baseUrl: string, params: Record<string, string | number>): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function safeMassiveUrl(baseUrl: string, params: Record<string, string | number>): string {
  return apiUrl(baseUrl, params);
}

function massiveUrlWithKey(
  baseUrl: string,
  params: Record<string, string | number>,
  apiKey: string,
): string {
  return apiUrl(baseUrl, { ...params, apiKey });
}

function buildItem(
  request: FinanceMarketCollectionRequest,
  params: {
    itemId: string;
    providerName: string;
    providerRole: FinanceDataProviderRole;
    sourceFamily: FinanceDataSourceFamily;
    sourceTimestamp: string;
    delayStatus: FinanceDataDelayStatus;
    sourceUrlOrArtifact: string;
    data: Readonly<Record<string, unknown>>;
  },
): FinanceMarketCollectionItem {
  return {
    itemId: params.itemId,
    collection: request.collection,
    providerName: params.providerName,
    providerRole: params.providerRole,
    sourceFamily: params.sourceFamily,
    sourceTimestamp: params.sourceTimestamp,
    observedAt: request.asOf,
    delayStatus: params.delayStatus,
    sourceUrlOrArtifact: params.sourceUrlOrArtifact,
    data: params.data,
  };
}

function massMarketRequest(request: FinanceMarketCollectionRequest): boolean {
  return isUsEquity(request.assetClass) && !isMacroSeries(request);
}

export function createMassiveNewsCollectionAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceMarketCollectionAdapter {
  const apiKey = requiredText(options.apiKey, "Massive apiKey");
  return {
    id: "massive_us_equity_news",
    providerName: "massive-us-equity-news",
    providerRole: "primary_market_data",
    priority: 10,
    supports: (request) => massMarketRequest(request) && request.collection === "news",
    collect: async (request) => {
      const baseUrl = "https://api.massive.com/v2/reference/news";
      const params = {
        ticker: request.instrument.toUpperCase(),
        limit: request.limit ?? 20,
        order: "desc",
        sort: "published_utc",
      };
      const payload = await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        massiveUrlWithKey(baseUrl, params, apiKey),
      );
      const sourceUrlOrArtifact = safeMassiveUrl(baseUrl, params);
      const records = resultsFromPayload(payload, "Massive news");
      return records.slice(0, request.limit).map((record, index) =>
        buildItem(request, {
          itemId: textValue(record.id) || `${request.instrument.toUpperCase()}-news-${index}`,
          providerName: "massive-us-equity-news",
          providerRole: "primary_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: sourceTimestamp(record.published_utc, request.asOf),
          delayStatus: "delayed",
          sourceUrlOrArtifact,
          data: record,
        }),
      );
    },
  };
}

export function createFinnhubNewsCollectionAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceMarketCollectionAdapter {
  const apiKey = requiredText(options.apiKey, "Finnhub apiKey");
  return {
    id: "finnhub_us_equity_news",
    providerName: "finnhub-us-equity-news",
    providerRole: "cross_check_market_data",
    priority: 20,
    supports: (request) => massMarketRequest(request) && request.collection === "news",
    collect: async (request) => {
      const fromDate = request.fromDate ?? request.asOf.slice(0, 10);
      const toDate = request.toDate ?? fromDate;
      const baseUrl = "https://finnhub.io/api/v1/company-news";
      const params = {
        symbol: request.instrument.toUpperCase(),
        from: fromDate,
        to: toDate,
      };
      const payload = await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        apiUrl(baseUrl, { ...params, token: apiKey }),
      );
      if (!Array.isArray(payload)) {
        throw new FinanceMarketCollectionAdapterError("Finnhub news response has no array");
      }
      const sourceUrlOrArtifact = apiUrl(baseUrl, params);
      return payload
        .filter(
          (record): record is Readonly<Record<string, unknown>> =>
            typeof record === "object" && record !== null && !Array.isArray(record),
        )
        .slice(0, request.limit)
        .map((record, index) =>
          buildItem(request, {
            itemId:
              textValue(record.id) || `${request.instrument.toUpperCase()}-finnhub-news-${index}`,
            providerName: "finnhub-us-equity-news",
            providerRole: "cross_check_market_data",
            sourceFamily: "market_data_api",
            sourceTimestamp: sourceTimestamp(record.datetime, request.asOf),
            delayStatus: "delayed",
            sourceUrlOrArtifact,
            data: record,
          }),
        );
    },
  };
}

type MassiveOptionRecord = Readonly<Record<string, unknown>>;

export function createMassiveOptionsChainCollectionAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceMarketCollectionAdapter {
  const apiKey = requiredText(options.apiKey, "Massive apiKey");
  return {
    id: "massive_us_equity_options_chain",
    providerName: "massive-us-equity-options-chain",
    providerRole: "primary_market_data",
    priority: 10,
    supports: (request) => massMarketRequest(request) && request.collection === "options_chain",
    collect: async (request) => {
      const baseUrl = `https://api.massive.com/v3/snapshot/options/${encodeURIComponent(request.instrument.toUpperCase())}`;
      const params: Record<string, string | number> = {
        limit: request.limit ?? 20,
        order: "asc",
        sort: "ticker",
      };
      if (request.toDate) {
        params.expiration_date = request.toDate;
      }
      const payload = await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        massiveUrlWithKey(baseUrl, params, apiKey),
      );
      const sourceUrlOrArtifact = safeMassiveUrl(baseUrl, params);
      const records = resultsFromPayload(payload, "Massive options chain") as MassiveOptionRecord[];
      return records.slice(0, request.limit).map((record, index) => {
        const details = (record.details ?? {}) as Record<string, unknown>;
        const quote = (record.last_quote ?? {}) as Record<string, unknown>;
        const trade = (record.last_trade ?? {}) as Record<string, unknown>;
        const day = (record.day ?? {}) as Record<string, unknown>;
        return buildItem(request, {
          itemId:
            textValue(details.ticker) || `${request.instrument.toUpperCase()}-option-${index}`,
          providerName: "massive-us-equity-options-chain",
          providerRole: "primary_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: sourceTimestamp(
            quote.last_updated ??
              trade.sip_timestamp ??
              day.last_updated ??
              record.fmv_last_updated,
            request.asOf,
          ),
          delayStatus: "delayed",
          sourceUrlOrArtifact,
          data: record,
        });
      });
    },
  };
}

function createMassiveCorporateActionAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
  kind: "dividends" | "splits";
}): FinanceMarketCollectionAdapter {
  const apiKey = requiredText(options.apiKey, "Massive apiKey");
  const isDividend = options.kind === "dividends";
  return {
    id: `massive_us_equity_${options.kind}`,
    providerName: `massive-us-equity-${options.kind}`,
    providerRole: "official_or_issuer_reference",
    priority: 10,
    supports: (request) => massMarketRequest(request) && request.collection === options.kind,
    collect: async (request) => {
      const baseUrl = isDividend
        ? "https://api.massive.com/v3/reference/dividends"
        : "https://api.massive.com/stocks/v1/splits";
      const dateKey = isDividend ? "ex_dividend_date" : "execution_date";
      const params = {
        ticker: request.instrument.toUpperCase(),
        limit: request.limit ?? 20,
        order: "desc",
        sort: dateKey,
      };
      const payload = await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        massiveUrlWithKey(baseUrl, params, apiKey),
      );
      const sourceUrlOrArtifact = safeMassiveUrl(baseUrl, params);
      const records = resultsFromPayload(payload, `Massive ${options.kind}`);
      return records.slice(0, request.limit).map((record, index) =>
        buildItem(request, {
          itemId:
            textValue(record.id) || `${request.instrument.toUpperCase()}-${options.kind}-${index}`,
          providerName: `massive-us-equity-${options.kind}`,
          providerRole: "official_or_issuer_reference",
          sourceFamily: "official_filing",
          sourceTimestamp: sourceTimestamp(record[dateKey], request.asOf),
          delayStatus: "official_lagged",
          sourceUrlOrArtifact,
          data: record,
        }),
      );
    },
  };
}

export function createMassiveDividendsCollectionAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceMarketCollectionAdapter {
  return createMassiveCorporateActionAdapter({ ...options, kind: "dividends" });
}

export function createMassiveSplitsCollectionAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceMarketCollectionAdapter {
  return createMassiveCorporateActionAdapter({ ...options, kind: "splits" });
}

function macroItem(
  request: FinanceMarketCollectionRequest,
  params: Omit<Parameters<typeof buildItem>[1], "itemId"> & { itemId: string },
): FinanceMarketCollectionItem {
  return buildItem(request, params);
}

function blsObservationDate(year: unknown, period: unknown): string {
  const yearText = textValue(year);
  const periodText = textValue(period);
  if (/^M\d{2}$/u.test(periodText)) {
    return isoDate(`${yearText}-${periodText.slice(1)}-01`, "BLS observation date");
  }
  if (
    periodText === "Q01" ||
    periodText === "Q02" ||
    periodText === "Q03" ||
    periodText === "Q04"
  ) {
    const month = (Number(periodText.slice(2)) - 1) * 3 + 1;
    return isoDate(`${yearText}-${String(month).padStart(2, "0")}-01`, "BLS observation date");
  }
  return isoDate(`${yearText}-01-01`, "BLS observation date");
}

export function createBlsMacroSeriesCollectionAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceMarketCollectionAdapter {
  return {
    id: "bls_public_macro_series",
    providerName: "bls-public-macro-series",
    providerRole: "official_or_issuer_reference",
    priority: 10,
    supports: (request) =>
      isMacroSeries(request) &&
      Boolean(request.seriesId ?? request.instrument) &&
      !["debt_to_penny", "avg_interest_rates"].includes(request.seriesId ?? request.instrument),
    collect: async (request) => {
      const seriesId = requiredText(request.seriesId ?? request.instrument, "BLS seriesId");
      const baseUrl = `https://api.bls.gov/publicAPI/v2/timeseries/data/${encodeURIComponent(seriesId)}`;
      const sourceUrlOrArtifact = baseUrl;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
      )) as {
        status?: string;
        Results?: { series?: Array<{ seriesID?: string; data?: Array<Record<string, unknown>> }> };
      };
      if (payload.status && payload.status !== "REQUEST_SUCCEEDED") {
        throw new FinanceMarketCollectionAdapterError(`BLS request status ${payload.status}`);
      }
      const series = payload.Results?.series?.[0];
      const data = series?.data ?? [];
      if (data.length === 0) {
        throw new FinanceMarketCollectionAdapterError(
          `BLS returned no observations for ${seriesId}`,
        );
      }
      return data.slice(0, request.limit).map((record, index) =>
        macroItem(request, {
          itemId: `${series?.seriesID ?? seriesId}-${textValue(record.year) || "unknown"}-${textValue(record.period) || index}`,
          providerName: "bls-public-macro-series",
          providerRole: "official_or_issuer_reference",
          sourceFamily: "official_macro_data",
          sourceTimestamp: blsObservationDate(record.year, record.period),
          delayStatus: "official_lagged",
          sourceUrlOrArtifact,
          data: { seriesId: series?.seriesID ?? seriesId, ...record },
        }),
      );
    },
  };
}

export function createTreasuryDebtCollectionAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceMarketCollectionAdapter {
  return {
    id: "treasury_fiscal_debt_to_penny",
    providerName: "treasury-fiscal-debt-to-penny",
    providerRole: "official_or_issuer_reference",
    priority: 20,
    supports: (request) =>
      isMacroSeries(request) && (request.seriesId ?? request.instrument) === "debt_to_penny",
    collect: async (request) => {
      const baseUrl =
        "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny";
      const params = { "page[size]": request.limit ?? 20, sort: "-record_date" };
      const sourceUrlOrArtifact = safeMassiveUrl(baseUrl, params);
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
      )) as {
        data?: Array<Record<string, unknown>>;
      };
      const data = payload.data ?? [];
      if (data.length === 0) {
        throw new FinanceMarketCollectionAdapterError(
          "Treasury debt_to_penny returned no observations",
        );
      }
      return data.slice(0, request.limit).map((record, index) =>
        macroItem(request, {
          itemId: `debt_to_penny-${textValue(record.record_date) || index}`,
          providerName: "treasury-fiscal-debt-to-penny",
          providerRole: "official_or_issuer_reference",
          sourceFamily: "official_macro_data",
          sourceTimestamp: isoDate(record.record_date, "Treasury record date"),
          delayStatus: "official_lagged",
          sourceUrlOrArtifact,
          data: record,
        }),
      );
    },
  };
}

export function createTreasuryAverageInterestRatesCollectionAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceMarketCollectionAdapter {
  return {
    id: "treasury_fiscal_average_interest_rates",
    providerName: "treasury-fiscal-average-interest-rates",
    providerRole: "official_or_issuer_reference",
    priority: 21,
    supports: (request) =>
      isMacroSeries(request) && (request.seriesId ?? request.instrument) === "avg_interest_rates",
    collect: async (request) => {
      const baseUrl =
        "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates";
      const params = { "page[size]": request.limit ?? 20, sort: "-record_date" };
      const sourceUrlOrArtifact = safeMassiveUrl(baseUrl, params);
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
      )) as {
        data?: Array<Record<string, unknown>>;
      };
      const data = payload.data ?? [];
      if (data.length === 0) {
        throw new FinanceMarketCollectionAdapterError(
          "Treasury avg_interest_rates returned no observations",
        );
      }
      return data.slice(0, request.limit).map((record, index) =>
        macroItem(request, {
          itemId: `avg_interest_rates-${textValue(record.record_date) || index}-${textValue(record.security_desc) || "unknown"}`,
          providerName: "treasury-fiscal-average-interest-rates",
          providerRole: "official_or_issuer_reference",
          sourceFamily: "official_macro_data",
          sourceTimestamp: isoDate(record.record_date, "Treasury interest-rate record date"),
          delayStatus: "official_lagged",
          sourceUrlOrArtifact,
          data: record,
        }),
      );
    },
  };
}

type SecRecentFilings = Readonly<{
  accessionNumber?: unknown[];
  filingDate?: unknown[];
  reportDate?: unknown[];
  acceptanceDateTime?: unknown[];
  form?: unknown[];
  primaryDocument?: unknown[];
  primaryDocDescription?: unknown[];
  act?: unknown[];
  fileNumber?: unknown[];
  filmNumber?: unknown[];
}>;

type SecSubmissionsPayload = Readonly<{
  cik?: unknown;
  name?: unknown;
  tickers?: unknown[];
  filings?: { recent?: SecRecentFilings };
}>;

type SecTickerRecord = Readonly<{
  cik_str?: unknown;
  ticker?: unknown;
}>;

async function resolveSecCikForFilings(instrument: string, fetchImpl: FetchImpl): Promise<string> {
  const symbol = instrument.trim().toUpperCase();
  if (/^\d{1,10}$/u.test(symbol)) {
    return symbol.padStart(10, "0");
  }
  try {
    const payload = (await fetchJson(fetchImpl, "https://www.sec.gov/files/company_tickers.json", {
      "User-Agent": SEC_USER_AGENT,
    })) as Record<string, SecTickerRecord>;
    const match = Object.values(payload).find(
      (record) => textValue(record.ticker).toUpperCase() === symbol,
    );
    const cik = match?.cik_str;
    if (cik !== undefined && /^\d{1,10}$/u.test(textValue(cik))) {
      return textValue(cik).padStart(10, "0");
    }
  } catch {
    // The SEC www host can reject automated requests while the official EDGAR
    // search index and data.sec.gov remain available. Fall through below.
  }
  const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(symbol)}&forms=10-K&from=0&size=100`;
  const searchPayload = (await fetchJson(fetchImpl, searchUrl, {
    "User-Agent": SEC_USER_AGENT,
  })) as {
    hits?: { hits?: Array<{ _source?: { ciks?: unknown; display_names?: unknown } }> };
  };
  const marker = `(${symbol})`;
  const hit = searchPayload.hits?.hits?.find((candidate) =>
    (Array.isArray(candidate._source?.display_names) ? candidate._source.display_names : []).some(
      (name) => typeof name === "string" && name.toUpperCase().includes(marker),
    ),
  );
  const ciks = hit && Array.isArray(hit._source?.ciks) ? hit._source.ciks : [];
  const cik = ciks.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && /^\d{1,10}$/u.test(candidate),
  );
  if (!cik) {
    throw new FinanceMarketCollectionAdapterError(
      `SEC EDGAR search index has no CIK for ${symbol}`,
    );
  }
  return cik.padStart(10, "0");
}

function filingArchiveUrl(cik: string, accessionNumber: string, primaryDocument: string): string {
  const accessionPath = accessionNumber.replace(/-/gu, "");
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/${encodeURIComponent(primaryDocument)}`;
}

export function createSecFilingsCollectionAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceMarketCollectionAdapter {
  return {
    id: "sec_edgar_filings",
    providerName: "sec-edgar-filings",
    providerRole: "official_or_issuer_reference",
    priority: 12,
    supports: (request) => isUsEquity(request.assetClass) && request.collection === "sec_filings",
    collect: async (request) => {
      const fetchImpl = resolveFinanceFetch(options.fetchImpl);
      const cik = await resolveSecCikForFilings(request.instrument, fetchImpl);
      const submissionsUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
      const payload = (await fetchJson(fetchImpl, submissionsUrl, {
        "User-Agent": SEC_USER_AGENT,
      })) as SecSubmissionsPayload;
      const recent = payload.filings?.recent;
      if (!recent) {
        throw new FinanceMarketCollectionAdapterError(
          `SEC submissions has no recent filings for ${request.instrument.toUpperCase()}`,
        );
      }
      const rowCount = Math.max(
        recent.accessionNumber?.length ?? 0,
        recent.filingDate?.length ?? 0,
        recent.form?.length ?? 0,
      );
      const sourceUrlOrArtifact = submissionsUrl;
      const limit = request.limit ?? 20;
      return Array.from({ length: Math.min(rowCount, limit) }, (_, index) => {
        const accessionNumber = textValue(recent.accessionNumber?.[index]);
        const primaryDocument = textValue(recent.primaryDocument?.[index]);
        const filingDate = textValue(recent.filingDate?.[index]);
        const form = textValue(recent.form?.[index]);
        const data = {
          cik,
          issuerName: textValue(payload.name),
          form,
          filingDate,
          reportDate: textValue(recent.reportDate?.[index]),
          acceptanceDateTime: textValue(recent.acceptanceDateTime?.[index]),
          accessionNumber,
          primaryDocument,
          primaryDocDescription: textValue(recent.primaryDocDescription?.[index]),
          act: textValue(recent.act?.[index]),
          fileNumber: textValue(recent.fileNumber?.[index]),
          filmNumber: textValue(recent.filmNumber?.[index]),
        };
        return buildItem(request, {
          itemId: `${cik}-${accessionNumber || filingDate || index}`,
          providerName: "sec-edgar-filings",
          providerRole: "official_or_issuer_reference",
          sourceFamily: "official_filing",
          sourceTimestamp: isoDate(data.acceptanceDateTime || filingDate, "SEC filing date"),
          delayStatus: "official_lagged",
          sourceUrlOrArtifact:
            accessionNumber && primaryDocument
              ? filingArchiveUrl(cik, accessionNumber, primaryDocument)
              : sourceUrlOrArtifact,
          data,
        });
      });
    },
  };
}

export function createFredMacroSeriesCollectionAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceMarketCollectionAdapter {
  const apiKey = requiredText(options.apiKey, "FRED apiKey");
  return {
    id: "fred_macro_series",
    providerName: "fred-macro-series",
    providerRole: "official_or_issuer_reference",
    priority: 30,
    supports: (request) =>
      isMacroSeries(request) && Boolean(request.seriesId ?? request.instrument),
    collect: async (request) => {
      const seriesId = requiredText(request.seriesId ?? request.instrument, "FRED seriesId");
      const baseUrl = "https://api.stlouisfed.org/fred/series/observations";
      const params = {
        series_id: seriesId,
        file_type: "json",
        sort_order: "desc",
        limit: request.limit ?? 20,
      };
      const sourceUrlOrArtifact = safeMassiveUrl(baseUrl, params);
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        apiUrl(baseUrl, { ...params, api_key: apiKey }),
      )) as {
        observations?: Array<Record<string, unknown>>;
        error_code?: string;
        error_message?: string;
      };
      if (payload.error_code) {
        throw new FinanceMarketCollectionAdapterError(
          `FRED ${payload.error_code}: ${payload.error_message ?? "request failed"}`,
        );
      }
      const data = payload.observations ?? [];
      if (data.length === 0) {
        throw new FinanceMarketCollectionAdapterError(
          `FRED returned no observations for ${seriesId}`,
        );
      }
      return data.slice(0, request.limit).map((record, index) =>
        macroItem(request, {
          itemId: `${seriesId}-${textValue(record.date) || index}`,
          providerName: "fred-macro-series",
          providerRole: "official_or_issuer_reference",
          sourceFamily: "official_macro_data",
          sourceTimestamp: isoDate(record.date, "FRED observation date"),
          delayStatus: "official_lagged",
          sourceUrlOrArtifact,
          data: { seriesId, ...record },
        }),
      );
    },
  };
}

function roleRank(role: FinanceDataProviderRole): number {
  return role === "primary_market_data" ? 0 : role === "cross_check_market_data" ? 1 : 2;
}

function orderedAdapters(
  request: FinanceMarketCollectionRequest,
  adapters: readonly FinanceMarketCollectionAdapter[],
): FinanceMarketCollectionAdapter[] {
  return adapters
    .filter((adapter) => adapter.supports(request))
    .toSorted(
      (left, right) =>
        roleRank(left.providerRole) - roleRank(right.providerRole) ||
        left.priority - right.priority ||
        left.id.localeCompare(right.id),
    );
}

function validateAdapters(adapters: readonly FinanceMarketCollectionAdapter[]): void {
  const ids = new Set<string>();
  for (const [index, adapter] of adapters.entries()) {
    requiredText(adapter.id, `adapters[${index}].id`);
    requiredText(adapter.providerName, `adapters[${index}].providerName`);
    if (ids.has(adapter.id)) {
      throw new Error(`duplicate finance market collection adapter id: ${adapter.id}`);
    }
    ids.add(adapter.id);
  }
}

export function inspectFinanceMarketCollectionRegistry(
  request: FinanceMarketCollectionRequest,
  adapters: readonly FinanceMarketCollectionAdapter[],
): FinanceMarketCollectionRegistryInspection {
  const normalizedRequest = normalizeRequest(request);
  validateAdapters(adapters);
  return {
    schemaVersion: FINANCE_MARKET_COLLECTION_SCHEMA_VERSION,
    boundary: "finance_market_collection_registry_local_only",
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
  adapter: FinanceMarketCollectionAdapter,
  request: FinanceMarketCollectionRequest,
  options: ApiTransportOptions,
  onCollect: () => void,
): Promise<readonly FinanceMarketCollectionItem[]> {
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

export async function runFinanceMarketCollectionRefresh(options: {
  request: FinanceMarketCollectionRequest;
  adapters: readonly FinanceMarketCollectionAdapter[];
  maxSources?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  correlationId?: string;
  retry?: ApiTransportOptions["retry"];
  sourceGovernance?: ApiSourceGovernanceRegistry;
  beforeHttpDispatch?: ApiTransportOptions["beforeHttpDispatch"];
  cacheMaxAgeMs?: number;
  maxSourceConcurrency?: number;
}): Promise<FinanceMarketCollectionReceipt> {
  const request = normalizeRequest(options.request);
  validateAdapters(options.adapters);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  const candidates = orderedAdapters(request, options.adapters);
  if (
    options.maxSources !== undefined &&
    (!Number.isInteger(options.maxSources) || options.maxSources <= 0)
  ) {
    throw new Error("maxSources must be a positive integer");
  }
  const selected =
    options.maxSources === undefined ? candidates : candidates.slice(0, options.maxSources);
  const sourceAttempts: FinanceMarketCollectionAttempt[] = [];
  const records: FinanceMarketCollectionItem[] = [];
  let adaptersCalled = false;
  const correlationId = options.correlationId ?? randomUUID();
  const results = await mapFinanceSourceLanes(
    selected,
    async (adapter) => {
      const sourceAttempts: FinanceMarketCollectionAttempt[] = [];
      const records: FinanceMarketCollectionItem[] = [];
      const apiCalls: ApiCallReceipt[] = [];
      const startedAt = Date.now();
      try {
        const collected = await collectWithTimeout(
          adapter,
          request,
          {
            timeoutMs,
            cacheMaxAgeMs: options.cacheMaxAgeMs,
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
        records.push(
          ...collected.map((item) =>
            reusedAt
              ? {
                  ...item,
                  observedAt: reusedAt,
                  sourceTimestamp:
                    item.sourceTimestamp === request.asOf ? reusedAt : item.sourceTimestamp,
                }
              : item,
          ),
        );
        sourceAttempts.push({
          adapterId: adapter.id,
          providerName: adapter.providerName,
          providerRole: adapter.providerRole,
          priority: adapter.priority,
          status: "succeeded",
          recordCount: collected.length,
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
          recordCount: 0,
          latencyMs: Math.max(0, Date.now() - startedAt),
          apiCalls: [...apiCalls],
          error: errorText(error),
        });
      }
      return { sourceAttempts, records };
    },
    options.maxSourceConcurrency,
  );
  for (const result of results) {
    sourceAttempts.push(...result.sourceAttempts);
    records.push(...result.records);
  }
  const failedAttempts = sourceAttempts.filter((attempt) => attempt.status === "failed");
  const baseReceipt = {
    schemaVersion: FINANCE_MARKET_COLLECTION_SCHEMA_VERSION,
    refreshId: `${request.collection}:${request.instrument}:${request.asOf}`,
    boundary: "finance_market_collection_research_only" as const,
    request,
    records,
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
  if (records.length === 0) {
    return {
      ...baseReceipt,
      status: "blocked",
      missingEvidence: ["successful_finance_market_collection"],
      requiredNextSteps: ["inspect_source_attempt_failures", "retry_with_healthy_adapter"],
    };
  }
  return {
    ...baseReceipt,
    status: failedAttempts.length > 0 ? "needs_review" : "ready",
    missingEvidence: [],
    requiredNextSteps: failedAttempts.length > 0 ? ["inspect_source_attempt_failures"] : [],
  };
}

export function resolveFinanceMarketCollectionRegistryOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FinanceMarketCollectionRegistryOptions {
  if (env === process.env) {
    env = resolveFinanceCredentialEnv(env);
  }
  return {
    alphaVantageApiKey: env.ALPHA_VANTAGE_API_KEY?.trim() || undefined,
    coinGeckoApiKey: env.COINGECKO_API_KEY?.trim() || undefined,
    massiveApiKey: env.MASSIVE_API_KEY?.trim() || undefined,
    finnhubApiKey: env.FINNHUB_API_KEY?.trim() || undefined,
    fredApiKey: env.FRED_API_KEY?.trim() || undefined,
    fmpApiKey: env.FMP_API_KEY?.trim() || undefined,
    twelveDataApiKey: env.TWELVE_DATA_API_KEY?.trim() || undefined,
    alpacaApiKeyId: env.ALPACA_API_KEY_ID?.trim() || undefined,
    alpacaApiSecretKey: env.ALPACA_API_SECRET_KEY?.trim() || undefined,
    alpacaDataFeed: env.ALPACA_DATA_FEED?.trim() || "iex",
    includeYahooPublicSources: env.LCX_ENABLE_YAHOO_PUBLIC_SOURCES === "1",
  };
}

export function createFinanceMarketCollectionRegistry(
  options: FinanceMarketCollectionRegistryOptions = {},
): readonly FinanceMarketCollectionAdapter[] {
  const adapters: FinanceMarketCollectionAdapter[] = [
    ...createRegisteredCapabilityAdapters(options),
    createBinancePublicEodHistoryCollectionAdapter({ fetchImpl: options.fetchImpl }),
    createFredPublicIndexHistoryCollectionAdapter({ fetchImpl: options.fetchImpl }),
    createBlsMacroSeriesCollectionAdapter({ fetchImpl: options.fetchImpl }),
    createTreasuryDebtCollectionAdapter({ fetchImpl: options.fetchImpl }),
    createTreasuryAverageInterestRatesCollectionAdapter({ fetchImpl: options.fetchImpl }),
    createSecFilingsCollectionAdapter({ fetchImpl: options.fetchImpl }),
    createGdeltPublicNewsCollectionAdapter({ fetchImpl: options.fetchImpl }),
    createGdeltNewsTitlesAdapter({ fetchImpl: options.fetchImpl }),
    createGoogleNewsRssCollectionAdapter({ fetchImpl: options.fetchImpl }),
  ];
  if (options.includeYahooPublicSources) {
    adapters.push(
      createYahooPublicEodHistoryCollectionAdapter({ fetchImpl: options.fetchImpl }),
      createYahooFinanceRssCollectionAdapter({ fetchImpl: options.fetchImpl }),
    );
  }
  if (options.massiveApiKey?.trim()) {
    adapters.push(
      createMassiveNewsCollectionAdapter({
        apiKey: options.massiveApiKey,
        fetchImpl: options.fetchImpl,
      }),
      createMassiveOptionsChainCollectionAdapter({
        apiKey: options.massiveApiKey,
        fetchImpl: options.fetchImpl,
      }),
      createMassiveDividendsCollectionAdapter({
        apiKey: options.massiveApiKey,
        fetchImpl: options.fetchImpl,
      }),
      createMassiveSplitsCollectionAdapter({
        apiKey: options.massiveApiKey,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  if (options.finnhubApiKey?.trim()) {
    adapters.push(
      createFinnhubNewsCollectionAdapter({
        apiKey: options.finnhubApiKey,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  if (options.fredApiKey?.trim()) {
    adapters.push(
      createFredMacroSeriesCollectionAdapter({
        apiKey: options.fredApiKey,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  if (options.fmpApiKey?.trim()) {
    adapters.push(
      createFmpFreeBasicProfileCollectionAdapter({
        apiKey: options.fmpApiKey,
        fetchImpl: options.fetchImpl,
      }),
      createFmpFreeBasicEodCollectionAdapter({
        apiKey: options.fmpApiKey,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  adapters.push(...(options.additionalAdapters ?? []));
  return adapters;
}
