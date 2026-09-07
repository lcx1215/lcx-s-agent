import type {
  FinanceDataDelayStatus,
  FinanceDataProviderRole,
  FinanceDataSourceFamily,
} from "./finance-data-gateway.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import type {
  FinanceMarketCollectionAdapter,
  FinanceMarketCollectionItem,
  FinanceMarketCollectionRequest,
} from "./finance-market-collection-registry.js";

class FreeMarketCollectionAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreeMarketCollectionAdapterError";
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

function sourceTimestamp(value: unknown, fallback: string): string {
  const raw = textValue(value).trim();
  if (!raw) {
    return fallback;
  }
  const gdeltCompact = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u);
  const normalized = gdeltCompact
    ? `${gdeltCompact[1]}-${gdeltCompact[2]}-${gdeltCompact[3]}T${gdeltCompact[4]}:${gdeltCompact[5]}:${gdeltCompact[6]}Z`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function isoDate(value: unknown, label: string): string {
  const normalized = textValue(value).trim();
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed)) {
    throw new FreeMarketCollectionAdapterError(`${label} must be a date`);
  }
  return new Date(parsed).toISOString();
}

function apiUrl(baseUrl: string, params: Record<string, string | number>): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
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
    throw new FreeMarketCollectionAdapterError(
      `source request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new FreeMarketCollectionAdapterError(`source http status ${response.status}`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new FreeMarketCollectionAdapterError("source returned an empty body");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new FreeMarketCollectionAdapterError("source returned invalid JSON");
  }
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

function isUsEquity(assetClass: string): boolean {
  return ["common_stock", "equity", "stock", "us_equity"].includes(assetClass.trim().toLowerCase());
}

/**
 * GDELT DOC is a public, keyless news-search source. It is deliberately a
 * cross-check, not a quote or issuer authority. GDELT may rate-limit high
 * traffic, so a failed attempt stays visible in the collection receipt.
 */
export function createGdeltPublicNewsCollectionAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceMarketCollectionAdapter {
  return {
    id: "gdelt_public_news",
    providerName: "gdelt-public-news",
    providerRole: "cross_check_market_data",
    priority: 30,
    supports: (request) => isUsEquity(request.assetClass) && request.collection === "news",
    collect: async (request) => {
      const baseUrl = "https://api.gdeltproject.org/api/v2/doc/doc";
      const params = {
        query: request.instrument.toUpperCase(),
        mode: "artlist",
        maxrecords: request.limit ?? 20,
        sort: "datedesc",
        format: "json",
        timespan: "1d",
      };
      const sourceUrlOrArtifact = apiUrl(baseUrl, params);
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
        { "User-Agent": "LCX Agent research-only" },
      )) as { articles?: unknown };
      if (!Array.isArray(payload.articles)) {
        throw new FreeMarketCollectionAdapterError("GDELT response has no articles array");
      }
      const articles = payload.articles.filter(
        (article): article is Readonly<Record<string, unknown>> =>
          typeof article === "object" && article !== null && !Array.isArray(article),
      );
      if (articles.length === 0) {
        throw new FreeMarketCollectionAdapterError(
          `GDELT returned no articles for ${request.instrument.toUpperCase()}`,
        );
      }
      return articles.slice(0, request.limit).map((article, index) => {
        const url = textValue(article.url);
        return buildItem(request, {
          itemId: url || `${request.instrument.toUpperCase()}-gdelt-news-${index}`,
          providerName: "gdelt-public-news",
          providerRole: "cross_check_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: sourceTimestamp(article.seendate, request.asOf),
          delayStatus: "delayed",
          sourceUrlOrArtifact,
          data: article,
        });
      });
    },
  };
}

function fmpUrlWithoutKey(baseUrl: string, params: Record<string, string | number>): string {
  return apiUrl(baseUrl, params);
}

/**
 * FMP's free Basic tier is intentionally limited here to profile/reference
 * data. Paid news, fundamentals, calendars, insider, and intraday endpoints
 * are not silently treated as free capabilities.
 */
export function createFmpFreeBasicProfileCollectionAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceMarketCollectionAdapter {
  const apiKey = requiredText(options.apiKey, "FMP apiKey");
  return {
    id: "fmp_free_basic_company_profile",
    providerName: "fmp-free-basic-company-profile",
    providerRole: "cross_check_market_data",
    priority: 40,
    supports: (request) =>
      isUsEquity(request.assetClass) && request.collection === "company_profile",
    collect: async (request) => {
      const baseUrl = "https://financialmodelingprep.com/api/v3/profile";
      const params = { symbol: request.instrument.toUpperCase() };
      const sourceUrlOrArtifact = fmpUrlWithoutKey(
        `${baseUrl}/${encodeURIComponent(params.symbol)}`,
        {},
      );
      const payload = await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        apiUrl(`${baseUrl}/${encodeURIComponent(params.symbol)}`, { apikey: apiKey }),
      );
      if (!Array.isArray(payload)) {
        throw new FreeMarketCollectionAdapterError("FMP profile response has no array");
      }
      const profile = payload.find(
        (record): record is Readonly<Record<string, unknown>> =>
          typeof record === "object" && record !== null && !Array.isArray(record),
      );
      if (!profile) {
        throw new FreeMarketCollectionAdapterError(
          `FMP profile returned no record for ${params.symbol}`,
        );
      }
      return [
        buildItem(request, {
          itemId: `${params.symbol}-profile`,
          providerName: "fmp-free-basic-company-profile",
          providerRole: "cross_check_market_data",
          sourceFamily: "fundamentals_api",
          sourceTimestamp: request.asOf,
          delayStatus: "manual_or_unknown",
          sourceUrlOrArtifact,
          data: profile,
        }),
      ];
    },
  };
}

/** FMP free Basic historical EOD only; no realtime or paid research routes. */
export function createFmpFreeBasicEodCollectionAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceMarketCollectionAdapter {
  const apiKey = requiredText(options.apiKey, "FMP apiKey");
  return {
    id: "fmp_free_basic_eod_history",
    providerName: "fmp-free-basic-eod-history",
    providerRole: "cross_check_market_data",
    priority: 40,
    supports: (request) => isUsEquity(request.assetClass) && request.collection === "eod_history",
    collect: async (request) => {
      const symbol = request.instrument.toUpperCase();
      const baseUrl = `https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(symbol)}`;
      const params: Record<string, string | number> = { limit: request.limit ?? 20 };
      if (request.fromDate) {
        params.from = request.fromDate;
      }
      if (request.toDate) {
        params.to = request.toDate;
      }
      const sourceUrlOrArtifact = fmpUrlWithoutKey(baseUrl, params);
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        apiUrl(baseUrl, { ...params, apikey: apiKey }),
      )) as { historical?: unknown };
      if (!Array.isArray(payload.historical)) {
        throw new FreeMarketCollectionAdapterError("FMP EOD response has no historical array");
      }
      const records = payload.historical.filter(
        (record): record is Readonly<Record<string, unknown>> =>
          typeof record === "object" && record !== null && !Array.isArray(record),
      );
      if (records.length === 0) {
        throw new FreeMarketCollectionAdapterError(`FMP EOD returned no records for ${symbol}`);
      }
      return records.slice(0, request.limit).map((record, index) =>
        buildItem(request, {
          itemId: `${symbol}-eod-${textValue(record.date) || index}`,
          providerName: "fmp-free-basic-eod-history",
          providerRole: "cross_check_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: isoDate(record.date, "FMP EOD date"),
          delayStatus: "end_of_day",
          sourceUrlOrArtifact,
          data: record,
        }),
      );
    },
  };
}
