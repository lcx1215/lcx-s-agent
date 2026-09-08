import { ApiCallError } from "./api-call-contract.js";
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
  const body = await fetchText(fetchImpl, url, headers);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new FreeMarketCollectionAdapterError("source returned invalid JSON");
  }
}

async function fetchText(
  fetchImpl: FetchImpl,
  url: string,
  headers: Record<string, string> = {},
): Promise<string> {
  let response: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    if (error instanceof ApiCallError) {
      throw error;
    }
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
  return body;
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

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&#x27;/giu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function rssTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "iu"));
  return match ? decodeXmlText(match[1] ?? "").trim() : "";
}

function rssItems(body: string, providerName: string): Readonly<Record<string, string>>[] {
  const items = [...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu)].map(
    (match) => match[1] ?? "",
  );
  const records = items.map((item) => ({
    title: rssTag(item, "title"),
    link: rssTag(item, "link"),
    description: rssTag(item, "description")
      .replace(/<[^>]+>/gu, " ")
      .trim()
      .slice(0, 2_000),
    pubDate: rssTag(item, "pubDate"),
    source: rssTag(item, "source"),
  }));
  const usable = records.filter((record) => record.title || record.link);
  if (usable.length === 0) {
    throw new FreeMarketCollectionAdapterError(`${providerName} RSS returned no usable items`);
  }
  return usable;
}

function createPublicRssNewsCollectionAdapter(options: {
  id: string;
  providerName: string;
  priority: number;
  buildUrl: (symbol: string) => string;
  fetchImpl?: FetchImpl;
}): FinanceMarketCollectionAdapter {
  return {
    id: options.id,
    providerName: options.providerName,
    providerRole: "cross_check_market_data",
    priority: options.priority,
    supports: (request) => isUsEquity(request.assetClass) && request.collection === "news",
    collect: async (request) => {
      const symbol = request.instrument.toUpperCase();
      const sourceUrlOrArtifact = options.buildUrl(symbol);
      const body = await fetchText(resolveFinanceFetch(options.fetchImpl), sourceUrlOrArtifact, {
        "User-Agent": "LCX Agent research-only",
      });
      const records = rssItems(body, options.providerName);
      return records.slice(0, request.limit).map((record, index) =>
        buildItem(request, {
          itemId: record.link || `${symbol}-${options.id}-${index}`,
          providerName: options.providerName,
          providerRole: "cross_check_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: sourceTimestamp(record.pubDate, request.asOf),
          delayStatus: "delayed",
          sourceUrlOrArtifact,
          data: record,
        }),
      );
    },
  };
}

type YahooChartHistoryResult = {
  timestamp?: unknown;
  indicators?: {
    quote?: Array<{
      open?: unknown[];
      high?: unknown[];
      low?: unknown[];
      close?: unknown[];
      volume?: unknown[];
    }>;
  };
};

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function yahooSourceTimestamp(value: unknown, fallback: string): string {
  const numeric = optionalFiniteNumber(value);
  if (numeric !== undefined) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    const timestamp = new Date(milliseconds);
    if (Number.isFinite(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }
  return sourceTimestamp(value, fallback);
}

function utcDayEpoch(value: string, label: string): number {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new FreeMarketCollectionAdapterError(`${label} must be YYYY-MM-DD`);
  }
  const epoch = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) {
    throw new FreeMarketCollectionAdapterError(`${label} must be a valid date`);
  }
  return epoch;
}

function yahooHistoryWindow(request: FinanceMarketCollectionRequest): {
  period1: number;
  period2: number;
} {
  const asOfDay = new Date(request.asOf);
  const asOfEpoch = Date.parse(`${asOfDay.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(asOfEpoch)) {
    throw new FreeMarketCollectionAdapterError("request asOf must be a valid timestamp");
  }
  const period2 = request.toDate
    ? utcDayEpoch(request.toDate, "toDate") + 24 * 60 * 60 * 1_000
    : asOfEpoch + 24 * 60 * 60 * 1_000;
  const period1 = request.fromDate
    ? utcDayEpoch(request.fromDate, "fromDate")
    : period2 - 365 * 24 * 60 * 60 * 1_000;
  if (period1 >= period2) {
    throw new FreeMarketCollectionAdapterError("fromDate must be before toDate");
  }
  return { period1: Math.floor(period1 / 1_000), period2: Math.floor(period2 / 1_000) };
}

function parseYahooHistory(body: string, symbol: string): YahooChartHistoryResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new FreeMarketCollectionAdapterError("Yahoo history response is not valid JSON");
  }
  const chart = (payload as { chart?: { error?: unknown; result?: unknown[] } }).chart;
  if (!chart || chart.error || !Array.isArray(chart.result) || chart.result.length === 0) {
    throw new FreeMarketCollectionAdapterError(`Yahoo history returned no result for ${symbol}`);
  }
  const result = chart.result[0];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new FreeMarketCollectionAdapterError(`Yahoo history result is invalid for ${symbol}`);
  }
  return result as YahooChartHistoryResult;
}

/**
 * Yahoo's public chart endpoint is keyless and delayed/end-of-day. It is the
 * default history source for chart analysis; optional keyed sources remain
 * cross-checks rather than being silently treated as the same fact.
 */
export function createYahooPublicEodHistoryCollectionAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceMarketCollectionAdapter {
  return {
    id: "yahoo_public_eod_history",
    providerName: "yahoo-public-eod-history",
    providerRole: "primary_market_data",
    priority: 20,
    supports: (request) => isUsEquity(request.assetClass) && request.collection === "eod_history",
    collect: async (request) => {
      const symbol = request.instrument.toUpperCase();
      const limit = request.limit ?? 20;
      const { period1, period2 } = yahooHistoryWindow(request);
      const fetchImpl = resolveFinanceFetch(options.fetchImpl);
      let lastError: unknown;
      let body = "";
      let sourceUrlOrArtifact = "";
      for (const host of ["query2", "query1"] as const) {
        const candidateUrl = apiUrl(
          `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
          {
            interval: "1d",
            period1,
            period2,
            events: "div,splits",
          },
        );
        try {
          body = await fetchText(fetchImpl, candidateUrl, {
            "User-Agent": "Mozilla/5.0 (LCX Agent research-only market history)",
          });
          sourceUrlOrArtifact = candidateUrl;
          break;
        } catch (error) {
          if (
            error instanceof ApiCallError &&
            ["forbidden", "budget_exhausted", "cancelled"].includes(error.kind)
          ) {
            throw error;
          }
          lastError = error;
        }
      }
      if (!body || !sourceUrlOrArtifact) {
        throw lastError ?? new FreeMarketCollectionAdapterError("Yahoo history request failed");
      }
      const result = parseYahooHistory(body, symbol);
      const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
      const quote = result.indicators?.quote?.[0];
      if (!quote || timestamps.length === 0) {
        throw new FreeMarketCollectionAdapterError(`Yahoo history has no OHLCV rows for ${symbol}`);
      }
      const rows = timestamps
        .map((timestamp, index) => {
          const rowTimestamp = yahooSourceTimestamp(timestamp, request.asOf);
          const date = rowTimestamp.slice(0, 10);
          const open = optionalFiniteNumber(quote.open?.[index]);
          const high = optionalFiniteNumber(quote.high?.[index]);
          const low = optionalFiniteNumber(quote.low?.[index]);
          const close = optionalFiniteNumber(quote.close?.[index]);
          if (
            date >= new Date(request.asOf).toISOString().slice(0, 10) ||
            open === undefined ||
            high === undefined ||
            low === undefined ||
            close === undefined ||
            Math.min(open, high, low, close) <= 0 ||
            low > Math.min(open, close) ||
            high < Math.max(open, close)
          ) {
            return null;
          }
          const volume = optionalFiniteNumber(quote.volume?.[index]);
          return {
            sourceTimestamp: rowTimestamp,
            date,
            data: {
              symbol,
              date,
              open,
              high,
              low,
              close,
              ...(volume === undefined ? {} : { volume }),
            },
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);
      if (rows.length === 0) {
        throw new FreeMarketCollectionAdapterError(
          `Yahoo history has no usable OHLCV rows for ${symbol}`,
        );
      }
      return rows.slice(-limit).map((row) =>
        buildItem(request, {
          itemId: `${symbol}-yahoo-eod-${row.date}`,
          providerName: "yahoo-public-eod-history",
          providerRole: "primary_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: row.sourceTimestamp,
          delayStatus: "end_of_day",
          sourceUrlOrArtifact,
          data: row.data,
        }),
      );
    },
  };
}

/** Public Google News RSS search; metadata-only and cross-check role. */
export function createGoogleNewsRssCollectionAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceMarketCollectionAdapter {
  return createPublicRssNewsCollectionAdapter({
    id: "google_news_rss",
    providerName: "google-news-rss",
    priority: 35,
    fetchImpl: options.fetchImpl,
    buildUrl: (symbol) =>
      apiUrl("https://news.google.com/rss/search", {
        q: symbol,
        hl: "en-US",
        gl: "US",
        ceid: "US:en",
      }),
  });
}

/** Public Yahoo Finance RSS search; metadata-only and cross-check role. */
export function createYahooFinanceRssCollectionAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceMarketCollectionAdapter {
  return createPublicRssNewsCollectionAdapter({
    id: "yahoo_finance_rss",
    providerName: "yahoo-finance-rss",
    priority: 40,
    fetchImpl: options.fetchImpl,
    buildUrl: (symbol) =>
      apiUrl("https://feeds.finance.yahoo.com/rss/2.0/headline", {
        s: symbol,
        region: "US",
        lang: "en-US",
      }),
  });
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
 * Compatibility ID retained; current stable endpoint entitlement is account-dependent.
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
      const baseUrl = "https://financialmodelingprep.com/stable/profile";
      const params = { symbol: request.instrument.toUpperCase() };
      const sourceUrlOrArtifact = fmpUrlWithoutKey(baseUrl, params);
      const payload = await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        apiUrl(baseUrl, { ...params, apikey: apiKey }),
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

/** Compatibility ID retained for stable EOD; no entitlement assumption. */
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
      const baseUrl = "https://financialmodelingprep.com/stable/historical-price-eod/full";
      const params: Record<string, string | number> = { symbol };
      if (request.fromDate) {
        params.from = request.fromDate;
      }
      if (request.toDate) {
        params.to = request.toDate;
      }
      const sourceUrlOrArtifact = fmpUrlWithoutKey(baseUrl, params);
      const payload = await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        apiUrl(baseUrl, { ...params, apikey: apiKey }),
      );
      if (!Array.isArray(payload)) {
        throw new FreeMarketCollectionAdapterError("FMP EOD response has no stable array");
      }
      const records = payload.filter(
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

/** Public spot market history, never an account or execution endpoint. */
export function createBinancePublicEodHistoryCollectionAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): FinanceMarketCollectionAdapter {
  return {
    id: "binance_public_eod_history",
    providerName: "binance-public-eod-history",
    providerRole: "primary_market_data",
    priority: 10,
    supports: (request) =>
      ["crypto", "cryptocurrency"].includes(request.assetClass.toLowerCase()) &&
      request.collection === "eod_history",
    collect: async (request) => {
      const symbol = request.instrument.toUpperCase();
      if (!/^[A-Z0-9]{5,24}$/u.test(symbol)) {
        throw new FreeMarketCollectionAdapterError("invalid spot symbol");
      }
      const startTime = utcDayEpoch(request.fromDate ?? "", "fromDate");
      const endTime = utcDayEpoch(request.toDate ?? "", "toDate") + 86_400_000 - 1;
      if (endTime <= startTime || endTime >= Date.parse(request.asOf)) {
        throw new FreeMarketCollectionAdapterError(
          "history must contain completed days before asOf",
        );
      }
      const url = apiUrl("https://data-api.binance.vision/api/v3/klines", {
        symbol,
        interval: "1d",
        startTime,
        endTime,
        limit: Math.min(1000, request.limit ?? 1000),
      });
      const body: unknown = JSON.parse(
        await fetchText(resolveFinanceFetch(options.fetchImpl), url),
      );
      if (!Array.isArray(body)) {
        throw new FreeMarketCollectionAdapterError("invalid kline response");
      }
      return body.map((value: unknown) => {
        if (!Array.isArray(value) || value.length < 7) {
          throw new FreeMarketCollectionAdapterError("invalid kline row");
        }
        const [opened, open, high, low, close, volume, closed] = value.map(Number);
        if (
          ![opened, open, high, low, close, volume, closed].every(Number.isFinite) ||
          opened < startTime ||
          closed > endTime ||
          opened % 86_400_000 !== 0 ||
          closed !== opened + 86_400_000 - 1 ||
          Math.min(open, high, low, close) <= 0 ||
          low > Math.min(open, close) ||
          high < Math.max(open, close) ||
          volume < 0
        ) {
          throw new FreeMarketCollectionAdapterError("invalid completed OHLCV bar");
        }
        return buildItem(request, {
          itemId: `${symbol}-${opened}`,
          providerName: "binance-public-eod-history",
          providerRole: "primary_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: new Date(closed).toISOString(),
          delayStatus: "delayed",
          sourceUrlOrArtifact: url,
          data: {
            symbol,
            date: new Date(opened).toISOString().slice(0, 10),
            open,
            high,
            low,
            close,
            volume,
          },
        });
      });
    },
  };
}

/** Explicit index series only: never substitute an index level for an ETF price. */
export function createFredPublicIndexHistoryCollectionAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): FinanceMarketCollectionAdapter {
  const supported = new Set(["SP500", "NASDAQ100"]);
  return {
    id: "fred_public_index_history",
    providerName: "fred-public-index-history",
    providerRole: "primary_market_data",
    priority: 10,
    supports: (request) =>
      isUsEquity(request.assetClass) &&
      request.collection === "eod_history" &&
      supported.has(request.instrument.toUpperCase()),
    collect: async (request) => {
      const symbol = request.instrument.toUpperCase();
      if (!supported.has(symbol)) {
        throw new FreeMarketCollectionAdapterError("unsupported index series");
      }
      const from = utcDayEpoch(request.fromDate ?? "", "fromDate");
      const to = utcDayEpoch(request.toDate ?? "", "toDate");
      if (from > to || to + 86_400_000 > Date.parse(request.asOf)) {
        throw new FreeMarketCollectionAdapterError(
          "index history requires completed days before asOf",
        );
      }
      // FRED observations use '.' for a missing value; coverage checks retain that gap.
      const url = apiUrl("https://fred.stlouisfed.org/graph/fredgraph.csv", {
        id: symbol,
        cosd: request.fromDate ?? "",
        coed: request.toDate ?? "",
      });
      const lines = (await fetchText(resolveFinanceFetch(options.fetchImpl), url)).split(/\r?\n/u);
      if (lines.shift() !== `observation_date,${symbol}`) {
        throw new FreeMarketCollectionAdapterError("unexpected index CSV schema");
      }
      const rows: FinanceMarketCollectionItem[] = [];
      for (const line of lines) {
        if (!line) {
          continue;
        }
        const columns = line.split(",");
        if (columns.length !== 2) {
          throw new FreeMarketCollectionAdapterError("invalid index CSV row");
        }
        const [date, raw] = columns;
        const epoch = utcDayEpoch(date, "observation_date");
        if (epoch < from || epoch > to) {
          throw new FreeMarketCollectionAdapterError("index observation outside requested window");
        }
        if (raw === "." || raw === "") {
          continue;
        }
        const close = Number(raw);
        if (!Number.isFinite(close) || close <= 0) {
          throw new FreeMarketCollectionAdapterError("invalid index level");
        }
        rows.push(
          buildItem(request, {
            itemId: `${symbol}-${date}`,
            providerName: "fred-public-index-history",
            providerRole: "primary_market_data",
            sourceFamily: "market_data_api",
            sourceTimestamp: new Date(epoch + 86_400_000 - 1).toISOString(),
            delayStatus: "delayed",
            sourceUrlOrArtifact: url,
            data: {
              symbol,
              date,
              close,
              unit: "index_points",
              instrumentType: "index",
              timestampBasis: "observation_date_end_utc_not_publication_time",
            },
          }),
        );
      }
      return rows.slice(-(request.limit ?? 1000));
    },
  };
}
