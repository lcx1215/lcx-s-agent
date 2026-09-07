import type {
  FinanceDataDelayStatus,
  FinanceDataProviderRole,
  FinanceDataSourceFamily,
} from "./finance-data-gateway.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";

export const FINANCE_MARKET_COLLECTION_SCHEMA_VERSION = "lcx_finance_market_collection_v1" as const;

export const FINANCE_MARKET_COLLECTION_KINDS = [
  "news",
  "options_chain",
  "dividends",
  "splits",
  "macro_series",
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
  massiveApiKey?: string;
  finnhubApiKey?: string;
  fredApiKey?: string;
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
  return error instanceof Error ? error.message : String(error);
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
      (request.seriesId ?? request.instrument) !== "debt_to_penny",
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
        massiveUrlWithKey(baseUrl, params, apiKey),
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
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<readonly FinanceMarketCollectionItem[]> {
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
      new Promise<readonly FinanceMarketCollectionItem[]>((_, reject) => {
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

export async function runFinanceMarketCollectionRefresh(options: {
  request: FinanceMarketCollectionRequest;
  adapters: readonly FinanceMarketCollectionAdapter[];
  maxSources?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
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
  for (const adapter of selected) {
    const startedAt = Date.now();
    try {
      const collected = await collectWithTimeout(adapter, request, timeoutMs, options.signal);
      records.push(...collected);
      sourceAttempts.push({
        adapterId: adapter.id,
        providerName: adapter.providerName,
        providerRole: adapter.providerRole,
        priority: adapter.priority,
        status: "succeeded",
        recordCount: collected.length,
        latencyMs: Math.max(0, Date.now() - startedAt),
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
        error: errorText(error),
      });
    }
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
    adaptersCalled: selected.length > 0,
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
  return {
    massiveApiKey: env.MASSIVE_API_KEY?.trim() || undefined,
    finnhubApiKey: env.FINNHUB_API_KEY?.trim() || undefined,
    fredApiKey: env.FRED_API_KEY?.trim() || undefined,
  };
}

export function createFinanceMarketCollectionRegistry(
  options: FinanceMarketCollectionRegistryOptions = {},
): readonly FinanceMarketCollectionAdapter[] {
  const adapters: FinanceMarketCollectionAdapter[] = [
    createBlsMacroSeriesCollectionAdapter(),
    createTreasuryDebtCollectionAdapter(),
  ];
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
  adapters.push(...(options.additionalAdapters ?? []));
  return adapters;
}
