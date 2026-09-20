import { createApiRateLimiter } from "./api-call-contract.js";
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
import { financeNewsQuery } from "./finance-news-entity.js";

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

function sourceTimestamp(value: unknown): string | undefined {
  const raw = textValue(value).trim();
  if (!raw) {
    return undefined;
  }
  const gdeltCompact = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u);
  const normalized = gdeltCompact
    ? `${gdeltCompact[1]}-${gdeltCompact[2]}-${gdeltCompact[3]}T${gdeltCompact[4]}:${gdeltCompact[5]}:${gdeltCompact[6]}Z`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
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
      const items = records.flatMap((record, index) => {
        const timestamp = sourceTimestamp(record.pubDate);
        if (!timestamp) {
          return [];
        }
        return [
          buildItem(request, {
            itemId: record.link || `${symbol}-${options.id}-${index}`,
            providerName: options.providerName,
            providerRole: "cross_check_market_data",
            sourceFamily: "market_data_api",
            sourceTimestamp: timestamp,
            delayStatus: "delayed",
            sourceUrlOrArtifact,
            data: record,
          }),
        ];
      });
      if (items.length === 0) {
        throw new FreeMarketCollectionAdapterError(
          `${options.providerName} RSS returned no timestamped items`,
        );
      }
      return items.slice(0, request.limit);
    },
  };
}

type YahooChartHistoryResult = {
  meta?: { instrumentType?: unknown; currency?: unknown };
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
  return sourceTimestamp(value) ?? fallback;
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
              ...(typeof result.meta?.instrumentType === "string"
                ? { instrumentType: result.meta.instrumentType.toLowerCase() }
                : {}),
              ...(typeof result.meta?.currency === "string" ? { unit: result.meta.currency } : {}),
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

// ---------------------------------------------------------------------------
// China-reachable US equity EOD history
// ---------------------------------------------------------------------------
//
// Yahoo Finance has refused mainland-China source IPs since 2021-11-01: every
// chart and quote request answers 403 with a Chinese region-notice HTML page.
// That is a source-side geographic block, not a credential, crumb, header or
// network defect, so no amount of client-side tuning makes Yahoo usable from a
// mainland host. These adapters reach the same asset class through public,
// key-less endpoints that do answer mainland IPs. They stay research-only:
// values are end-of-day and are never execution-grade.
//
// Two providers with deliberately different failure modes:
//   eastmoney - fastest (~150ms) and richest (turnover, amplitude, listed
//               adjustment flag), but the US market code is not derivable from
//               the ticker: 105 Nasdaq / 106 NYSE / 107 NYSE American. It is
//               probed once per symbol and then cached.
//   sina      - ~2s, but needs no market code at all and returns the whole
//               listed history, so it is the fallback that cannot fail on a
//               market-code guess.
const EASTMONEY_US_MARKET_CODES = ["105", "106", "107"] as const;

const EASTMONEY_REFERER = "https://quote.eastmoney.com/";

const eastmoneyMarketBySymbol = new Map<string, string>();

type OhlcvRow = Readonly<{
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}>;

/** Eastmoney asks for YYYYMMDD; fall back to a 365-day window ending at `asOf`. */
function eastmoneyCompactDay(value: string | undefined, fallback: Date): string {
  const trimmed = value?.trim() ?? "";
  const base = /^\d{4}-\d{2}-\d{2}$/u.test(trimmed)
    ? new Date(`${trimmed}T00:00:00.000Z`)
    : fallback;
  if (!Number.isFinite(base.getTime())) {
    return fallback.toISOString().slice(0, 10).replace(/-/gu, "");
  }
  return base.toISOString().slice(0, 10).replace(/-/gu, "");
}

function eastmoneyWindow(request: FinanceMarketCollectionRequest): {
  beg: string;
  end: string;
} {
  const asOfDay = new Date(`${new Date(request.asOf).toISOString().slice(0, 10)}T00:00:00.000Z`);
  const end = eastmoneyCompactDay(request.toDate, asOfDay);
  const fallbackStart = new Date(
    Date.parse(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}T00:00:00.000Z`) -
      365 * 24 * 60 * 60 * 1_000,
  );
  return { beg: eastmoneyCompactDay(request.fromDate, fallbackStart), end };
}

/**
 * Reject a bar that cannot be true regardless of provider.
 *
 * Both Chinese providers emit `open,close,high,low` (NOT the more familiar
 * `open,high,low,close`), so a mis-ordered parse shows up here as a high below
 * the open/close range rather than as a crash. Guarding on the OHLC invariant is
 * what makes the field order a checked fact instead of an assumption.
 */
function sanitizeBar(row: OhlcvRow, asOfDay: string): OhlcvRow | null {
  const { date, open, high, low, close } = row;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || date >= asOfDay) {
    return null;
  }
  if (
    [open, high, low, close].some((value) => !Number.isFinite(value)) ||
    Math.min(open, high, low, close) <= 0
  ) {
    return null;
  }
  if (high < Math.max(open, close) || low > Math.min(open, close)) {
    return null;
  }
  return row;
}

function parseEastmoneyKlines(body: string): OhlcvRow[] {
  const payload = JSON.parse(body) as {
    data?: { klines?: string[]; dktotal?: number };
  };
  const rows = payload.data?.klines;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.flatMap((line) => {
    const parts = String(line).split(",");
    if (parts.length < 6) {
      return [];
    }
    // f51 date, f52 open, f53 close, f54 high, f55 low, f56 volume.
    const [date, open, close, high, low, volume] = parts;
    const row = {
      date: date ?? "",
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      ...(Number.isFinite(Number(volume)) ? { volume: Number(volume) } : {}),
    };
    return [row];
  });
}

function parseSinaKlines(body: string): OhlcvRow[] {
  // The endpoint answers JSONP: a script-guard comment, then `var _AAPL([...])`.
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return [];
  }
  const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    const date = typeof record.d === "string" ? record.d : "";
    const open = Number(record.o);
    const high = Number(record.h);
    const low = Number(record.l);
    const close = Number(record.c);
    const volume = Number(record.v);
    return [
      {
        date,
        open,
        high,
        low,
        close,
        ...(Number.isFinite(volume) ? { volume } : {}),
      },
    ];
  });
}

/** Resolve the Eastmoney US market code once per symbol, then reuse it. */
async function resolveEastmoneyMarket(
  fetchImpl: FetchImpl,
  symbol: string,
  probeUrl: (market: string) => string,
): Promise<string | undefined> {
  const cached = eastmoneyMarketBySymbol.get(symbol);
  if (cached) {
    return cached;
  }
  for (const market of EASTMONEY_US_MARKET_CODES) {
    try {
      const body = await fetchText(fetchImpl, probeUrl(market), {
        "User-Agent": "Mozilla/5.0 (LCX Agent research-only market history)",
        Referer: EASTMONEY_REFERER,
      });
      if (parseEastmoneyKlines(body).length > 0) {
        eastmoneyMarketBySymbol.set(symbol, market);
        return market;
      }
    } catch {
      // A missing market code is a normal miss, not a failure: try the next one.
    }
  }
  return undefined;
}

/**
 * US equity end-of-day history from mainland-reachable public endpoints.
 *
 * Drop-in replacement for `yahoo_public_eod_history` where Yahoo is
 * geo-blocked. Eastmoney is tried first and Sina second; both are adjusted
 * (Eastmoney `fqt=1`, Sina's own adjusted series) so splits and dividends do
 * not masquerade as trend signals.
 */
export function createChinaReachableUsEodHistoryCollectionAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceMarketCollectionAdapter {
  const id = "china_reachable_us_eod_history";
  const supports = (request: FinanceMarketCollectionRequest): boolean =>
    isUsEquity(request.assetClass) && request.collection === "eod_history";

  const toItems = (
    request: FinanceMarketCollectionRequest,
    rows: readonly OhlcvRow[],
    providerName: string,
    sourceUrlOrArtifact: string,
    instrumentType?: string,
  ): FinanceMarketCollectionItem[] =>
    rows.map((row) =>
      buildItem(request, {
        itemId: `${request.instrument.toUpperCase()}-${providerName}-eod-${row.date}`,
        providerName,
        providerRole: "primary_market_data",
        sourceFamily: "market_data_api",
        sourceTimestamp: `${row.date}T00:00:00.000Z`,
        delayStatus: "end_of_day",
        sourceUrlOrArtifact,
        data: {
          symbol: request.instrument.toUpperCase(),
          date: row.date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          ...(row.volume === undefined ? {} : { volume: row.volume }),
          unit: "USD",
          ...(instrumentType ? { instrumentType } : {}),
        },
      }),
    );

  const finish = (
    request: FinanceMarketCollectionRequest,
    rawRows: readonly OhlcvRow[],
    providerName: string,
    sourceUrlOrArtifact: string,
    limit: number,
    instrumentType?: string,
  ): FinanceMarketCollectionItem[] => {
    const asOfDay = new Date(request.asOf).toISOString().slice(0, 10);
    const rows = rawRows
      .map((row) => sanitizeBar(row, asOfDay))
      .filter((row): row is OhlcvRow => row !== null);
    if (rows.length === 0) {
      throw new FreeMarketCollectionAdapterError(
        `${providerName} has no usable OHLCV rows for ${request.instrument.toUpperCase()}`,
      );
    }
    return toItems(request, rows.slice(-limit), providerName, sourceUrlOrArtifact, instrumentType);
  };

  return {
    id,
    providerName: "china-reachable-us-eod-history",
    providerRole: "primary_market_data",
    // Outranks `yahoo_public_eod_history` (20): on a mainland host Yahoo answers
    // 403 for every symbol, so trying it first only burns the request budget.
    priority: 10,
    supports,
    collect: async (request) => {
      const symbol = request.instrument.toUpperCase();
      const limit = request.limit ?? 20;
      const fetchImpl = resolveFinanceFetch(options.fetchImpl);
      const headers = {
        "User-Agent": "Mozilla/5.0 (LCX Agent research-only market history)",
        Referer: EASTMONEY_REFERER,
      };

      const { beg, end } = eastmoneyWindow(request);
      const eastmoneyUrl = (market: string): string =>
        apiUrl("https://push2his.eastmoney.com/api/qt/stock/kline/get", {
          secid: `${market}.${symbol}`,
          klt: 101,
          fqt: 1,
          beg,
          end,
          fields1: "f1,f2,f3,f4,f5,f6",
          fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        });
      // Probe with a one-day window: resolution only needs a non-empty body.
      const probeUrl = (market: string): string =>
        apiUrl("https://push2his.eastmoney.com/api/qt/stock/kline/get", {
          secid: `${market}.${symbol}`,
          klt: 101,
          fqt: 1,
          beg: end,
          end,
          fields1: "f1,f2,f3",
          fields2: "f51,f52,f53,f54,f55,f56",
        });

      let eastmoneyError: unknown;
      const market = await resolveEastmoneyMarket(fetchImpl, symbol, probeUrl);
      if (market) {
        const url = eastmoneyUrl(market);
        try {
          const body = await fetchText(fetchImpl, url, headers);
          return finish(
            request,
            parseEastmoneyKlines(body),
            "eastmoney-us-eod-history",
            url,
            limit,
          );
        } catch (error) {
          eastmoneyError = error;
        }
      }

      const sinaUrl = apiUrl(
        "https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20_lcx/US_MinKService.getDailyK",
        { symbol, ___qn: 3 },
      );
      try {
        const body = await fetchText(fetchImpl, sinaUrl, {
          "User-Agent": "Mozilla/5.0 (LCX Agent research-only market history)",
          Referer: "https://finance.sina.com.cn",
        });
        const all = parseSinaKlines(body);
        const windowed =
          request.fromDate || request.toDate
            ? all.filter((row) => {
                const from = request.fromDate?.trim();
                const to = request.toDate?.trim();
                if (from && row.date < from) {
                  return false;
                }
                return !(to && row.date > to);
              })
            : all;
        return finish(request, windowed, "sina-us-eod-history", sinaUrl, limit);
      } catch (error) {
        if (eastmoneyError) {
          // Report the primary failure; the fallback only adds a second attempt.
          throw eastmoneyError;
        }
        throw error;
      }
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
        q: financeNewsQuery(symbol),
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
// GDELT's public service asks clients to send at most one request per five seconds.
const gdeltPublicRateLimiter = createApiRateLimiter({ minIntervalMs: 5_000, maxConcurrent: 1 });

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
      const fromMs = request.fromDate ? utcDayEpoch(request.fromDate, "fromDate") : undefined;
      const toMs = request.toDate
        ? utcDayEpoch(request.toDate, "toDate") + 24 * 60 * 60 * 1_000
        : undefined;
      if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) {
        throw new FreeMarketCollectionAdapterError("fromDate must be before toDate");
      }
      const params: Record<string, string | number> = {
        query: request.seriesId?.trim() || financeNewsQuery(request.instrument),
        mode: "artlist",
        maxrecords: request.limit ?? 20,
        sort: "datedesc",
        format: "json",
      };
      if (request.fromDate || request.toDate) {
        if (request.fromDate) {
          params.startdatetime = `${request.fromDate.replaceAll("-", "")}000000`;
        }
        if (request.toDate) {
          params.enddatetime = `${request.toDate.replaceAll("-", "")}235959`;
        }
      } else {
        params.timespan = "1d";
      }
      const sourceUrlOrArtifact = apiUrl(baseUrl, params);
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl, {
          rateLimiter: gdeltPublicRateLimiter,
          retry: { minDelayMs: 5_000 },
        }),
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
      const datedArticles = articles.flatMap((article) => {
        const timestamp = sourceTimestamp(article.seendate);
        if (!timestamp) {
          return [];
        }
        const timestampMs = Date.parse(timestamp);
        if (
          (fromMs !== undefined && timestampMs < fromMs) ||
          (toMs !== undefined && timestampMs >= toMs)
        ) {
          return [];
        }
        return [{ article, timestamp }];
      });
      if (datedArticles.length === 0) {
        throw new FreeMarketCollectionAdapterError(
          `GDELT returned no timestamped articles in the requested window for ${request.instrument.toUpperCase()}`,
        );
      }
      return datedArticles.slice(0, request.limit).map(({ article, timestamp }, index) => {
        const url = textValue(article.url);
        return buildItem(request, {
          itemId: url || `${request.instrument.toUpperCase()}-gdelt-news-${index}`,
          providerName: "gdelt-public-news",
          providerRole: "cross_check_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: timestamp,
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
