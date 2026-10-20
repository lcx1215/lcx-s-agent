import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import type {
  FinanceRealtimeSourceAdapter,
  FinanceRealtimeSourceRequest,
} from "./finance-realtime-source-registry.js";

const SEC_USER_AGENT = "LCX Agent research-only contact=local";
const NASDAQ_USER_AGENT = "Mozilla/5.0 (LCX Agent research-only; contact=local)";

class AdditionalSourceAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdditionalSourceAdapterError";
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} required`);
  }
  return normalized;
}

function isUsStockClass(assetClass: string): boolean {
  return ["common_stock", "equity", "stock", "us_equity", "etf"].includes(
    assetClass.trim().toLowerCase(),
  );
}

// These USD parsers implement native US stock/ETF symbols, not Yahoo's global formats.
function isUsStockSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)?$/u.test(symbol.trim().toUpperCase());
}

function supportsUsStock(request: FinanceRealtimeSourceRequest): boolean {
  return isUsStockClass(request.assetClass) && isUsStockSymbol(request.instrument);
}

function stooqUsSymbol(request: FinanceRealtimeSourceRequest): string | undefined {
  const symbol = request.instrument.trim().replace(/\.us$/iu, "");
  return isUsStockClass(request.assetClass) && isUsStockSymbol(symbol)
    ? `${symbol.toLowerCase()}.us`
    : undefined;
}

function supportsAlphaVantageStock(request: FinanceRealtimeSourceRequest): boolean {
  const assetClass = request.assetClass.trim().toLowerCase();
  return (
    (isUsStockClass(assetClass) || assetClass.endsWith("_equity")) &&
    /^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/u.test(request.instrument.trim().toUpperCase())
  );
}

function parseFiniteNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AdditionalSourceAdapterError(`${label} must be a finite number`);
  }
  return parsed;
}

function dayStartIso(value: unknown, label: string): string {
  const day =
    typeof value === "string"
      ? requiredText(value, label)
      : typeof value === "number" && Number.isFinite(value)
        ? requiredText(value.toString(), label)
        : (() => {
            throw new AdditionalSourceAdapterError(`${label} must be a date string`);
          })();
  const dateOnly =
    /^\d{4}-\d{2}-\d{2}$/u.test(day) ||
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$/u.test(day);
  const calendarMatch = day.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/u,
  );
  const timestamp = calendarMatch
    ? Date.UTC(
        Number(calendarMatch[3]),
        [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ].indexOf(calendarMatch[1]),
        Number(calendarMatch[2]),
      )
    : Date.parse(dateOnly ? `${day}T00:00:00Z` : day);
  if (!Number.isFinite(timestamp)) {
    throw new AdditionalSourceAdapterError(`${label} must be an ISO date`);
  }
  const parsedDate = new Date(timestamp);
  return new Date(
    Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate()),
  ).toISOString();
}

/** Nasdaq labels intraday timestamps ET; resolve the date's actual US Eastern offset. */
export function parseNasdaqTradeTimestamp(value: string): string {
  const match = value.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? (AM|PM) ET$/u,
  );
  if (!match) {
    if (
      /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
      Number.isFinite(Date.parse(value))
    ) {
      return new Date(value).toISOString();
    }
    if (
      /^\d{4}-\d{2}-\d{2}$/u.test(value) ||
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$/u.test(value)
    ) {
      return dayStartIso(value, "Nasdaq trade date");
    }
    throw new AdditionalSourceAdapterError("unsupported Nasdaq timestamp format");
  }
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(match[1]);
  const hour12 = Number(match[4]);
  if (hour12 < 1 || hour12 > 12 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) {
    throw new AdditionalSourceAdapterError("invalid Nasdaq timestamp");
  }
  const expected = {
    year: Number(match[3]),
    month: month + 1,
    day: Number(match[2]),
    hour: (hour12 % 12) + (match[7] === "PM" ? 12 : 0),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const wall = Date.UTC(
    expected.year,
    month,
    expected.day,
    expected.hour,
    expected.minute,
    expected.second,
  );
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const matches = [4, 5]
    .map((offset) => wall + offset * 3_600_000)
    .filter((epoch) => {
      const parts = Object.fromEntries(
        formatter.formatToParts(epoch).map((part) => [part.type, Number(part.value)]),
      );
      return Object.entries(expected).every(([key, number]) => parts[key] === number);
    });
  if (matches.length !== 1) {
    throw new AdditionalSourceAdapterError("ambiguous or invalid Nasdaq Eastern timestamp");
  }
  return new Date(matches[0]).toISOString();
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
    throw new AdditionalSourceAdapterError(
      `source request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new AdditionalSourceAdapterError(`source http status ${response.status}`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new AdditionalSourceAdapterError("source returned an empty body");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AdditionalSourceAdapterError("source returned invalid JSON");
  }
}

export function parseStooqDailyCsv(
  body: string,
  symbol: string,
  sourceUrlOrArtifact: string,
  observedAt = new Date().toISOString(),
): FinanceDataGatewayObservationInput {
  const lines = body
    .trim()
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = lines[0]?.toLowerCase();
  const row = lines.at(-1)?.split(",");
  if (
    header !== "date,open,high,low,close,volume" ||
    !row ||
    row.length < 5 ||
    /<html|challenge|verify/iu.test(body)
  ) {
    throw new AdditionalSourceAdapterError(`stooq returned no usable daily CSV for ${symbol}`);
  }
  const date = dayStartIso(row[0], "stooq date");
  const close = parseFiniteNumber(row[4], "stooq close");
  return {
    providerName: "stooq-public-daily",
    providerRole: "cross_check_market_data",
    sourceFamily: "market_data_api",
    observedAt,
    timezone: "UTC",
    delayStatus: "end_of_day",
    fields: [
      {
        name: "last_price",
        value: close,
        currency: "USD",
        adjusted: false,
        fieldDefinition: `end-of-day close from Stooq for ${symbol}`,
        sourceTimestamp: date,
        sourceUrlOrArtifact,
      },
    ],
  };
}

export function createStooqDelayedMarketAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "stooq_public_daily",
    providerName: "stooq-public-daily",
    providerRole: "cross_check_market_data",
    priority: 20,
    supports: (request) => stooqUsSymbol(request) !== undefined,
    collect: async (request, signal) => {
      const symbol = stooqUsSymbol(request);
      if (!symbol) {
        throw new AdditionalSourceAdapterError("unsupported Stooq US stock/ETF request");
      }
      signal.throwIfAborted();
      const sourceUrlOrArtifact = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
      const fetchImpl = resolveFinanceFetch(options.fetchImpl, { signal });
      let response: { ok: boolean; status: number; text: () => Promise<string> };
      try {
        response = await fetchImpl(sourceUrlOrArtifact, {
          headers: { "User-Agent": SEC_USER_AGENT },
        });
      } catch (error) {
        throw new AdditionalSourceAdapterError(
          `stooq request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        throw new AdditionalSourceAdapterError(`stooq http status ${response.status}`);
      }
      return parseStooqDailyCsv(
        await response.text(),
        request.instrument,
        sourceUrlOrArtifact,
        request.asOf,
      );
    },
  };
}

function parseDollarNumber(value: unknown, label: string): number {
  const normalized =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? value.toString()
        : "";
  return parseFiniteNumber(normalized.replace(/[$,%\s,]/gu, "").trim(), label);
}

export function createNasdaqExchangeMarketAdapter(
  options: {
    fetchImpl?: FetchImpl;
  } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "nasdaq_exchange_quote",
    providerName: "nasdaq-exchange-public-quote",
    providerRole: "cross_check_market_data",
    priority: 12,
    sampleRequest: { instrument: "AAPL", assetClass: "us_equity" },
    supports: supportsUsStock,
    collect: async (request, signal) => {
      if (!supportsUsStock(request)) {
        throw new AdditionalSourceAdapterError("unsupported Nasdaq US stock/ETF request");
      }
      signal.throwIfAborted();
      const assetClass = request.assetClass.trim().toLowerCase();
      const nasdaqAssetClass = assetClass === "etf" ? "etfs" : "stocks";
      const symbol = request.instrument.trim().toUpperCase();
      const sourceUrlOrArtifact = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${nasdaqAssetClass}`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl, { signal }),
        sourceUrlOrArtifact,
        {
          Accept: "application/json, text/plain, */*",
          "User-Agent": NASDAQ_USER_AGENT,
        },
      )) as {
        data?: {
          primaryData?: {
            lastSalePrice?: string;
            lastTradeTimestamp?: string;
            isRealTime?: boolean;
          };
        };
      };
      const primary = payload.data?.primaryData;
      if (!primary?.lastSalePrice || !primary.lastTradeTimestamp) {
        throw new AdditionalSourceAdapterError("Nasdaq response has no usable primary quote");
      }
      const sourceTimestamp = parseNasdaqTradeTimestamp(primary.lastTradeTimestamp);
      return {
        providerName: "nasdaq-exchange-public-quote",
        providerRole: "cross_check_market_data",
        sourceFamily: "market_data_api",
        observedAt: request.asOf,
        timezone: "America/New_York",
        delayStatus: primary.isRealTime ? "realtime" : "end_of_day",
        fields: [
          {
            name: "last_price",
            value: parseDollarNumber(primary.lastSalePrice, "Nasdaq last sale price"),
            currency: "USD",
            adjusted: false,
            fieldDefinition: `Nasdaq public exchange last sale for ${symbol}`,
            sourceTimestamp,
            sourceUrlOrArtifact,
          },
        ],
      };
    },
  };
}

type AlphaVantageQuoteMetadata = Readonly<{
  currency: string;
  timezone: string;
  sourceUrlOrArtifact?: string;
}>;

function isAlphaVantageTimezone(value: string): boolean {
  const match = value.match(/^UTC(?:[+-](\d{1,2})(?::([0-5]\d)|(\.(?:25|5|75)))?)?$/u);
  return (
    match !== null &&
    Number(match[1] ?? 0) + Number(match[2] ?? 0) / 60 + Number(match[3] ?? 0) <= 14
  );
}

function parseAlphaVantageSymbolMetadata(
  payload: unknown,
  symbol: string,
  sourceUrlOrArtifact: string,
): AlphaVantageQuoteMetadata {
  const matches = (payload as { bestMatches?: unknown } | null)?.bestMatches;
  const exact = Array.isArray(matches)
    ? matches.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry["1. symbol"] === "string" &&
          entry["1. symbol"].trim().toUpperCase() === symbol.trim().toUpperCase(),
      )
    : [];
  if (exact.length === 0) {
    throw new AdditionalSourceAdapterError("alpha vantage metadata has no exact symbol match");
  }
  const currencies = new Set(Intl.supportedValuesOf("currency"));
  const metadata = exact.map((entry) => {
    const currency = entry["8. currency"];
    const timezone = entry["7. timezone"];
    if (
      typeof currency !== "string" ||
      // Alpha Vantage's documented London quotes use GBX (pence); never relabel as GBP.
      (!currencies.has(currency.trim()) && currency.trim() !== "GBX") ||
      typeof timezone !== "string" ||
      !isAlphaVantageTimezone(timezone.trim())
    ) {
      throw new AdditionalSourceAdapterError(
        "alpha vantage metadata currency/timezone unavailable",
      );
    }
    return { currency: currency.trim(), timezone: timezone.trim(), sourceUrlOrArtifact };
  });
  const first = metadata[0];
  if (
    metadata.some((entry) => entry.currency !== first.currency || entry.timezone !== first.timezone)
  ) {
    throw new AdditionalSourceAdapterError("alpha vantage metadata has conflicting exact matches");
  }
  return first;
}

export function parseAlphaVantageGlobalQuote(
  payload: unknown,
  symbol: string,
  sourceUrlOrArtifact: string,
  observedAt = new Date().toISOString(),
  metadata?: AlphaVantageQuoteMetadata,
): FinanceDataGatewayObservationInput {
  if (!metadata && !isUsStockSymbol(symbol)) {
    throw new AdditionalSourceAdapterError("alpha vantage metadata required for a global symbol");
  }
  const quote = (payload as { [key: string]: unknown })["Global Quote"] as
    | Record<string, unknown>
    | undefined;
  if (!quote || Object.keys(quote).length === 0) {
    throw new AdditionalSourceAdapterError("alpha vantage returned no Global Quote");
  }
  if (
    typeof quote["01. symbol"] !== "string" ||
    quote["01. symbol"].trim().toUpperCase() !== symbol.trim().toUpperCase()
  ) {
    throw new AdditionalSourceAdapterError("alpha vantage Global Quote symbol mismatch");
  }
  const date = dayStartIso(quote["07. latest trading day"], "alpha vantage trading day");
  const close = parseFiniteNumber(quote["05. price"], "alpha vantage price");
  return {
    providerName: "alpha-vantage-global-quote",
    providerRole: "cross_check_market_data",
    sourceFamily: "market_data_api",
    observedAt,
    timezone: metadata?.timezone ?? "UTC",
    delayStatus: "end_of_day",
    fields: [
      {
        name: "last_price",
        value: close,
        currency: metadata?.currency ?? "USD",
        adjusted: false,
        fieldDefinition: `end-of-day global quote from Alpha Vantage for ${symbol}${metadata?.sourceUrlOrArtifact ? `; currency/timezone from ${metadata.sourceUrlOrArtifact}` : ""}`,
        sourceTimestamp: date,
        sourceUrlOrArtifact,
      },
    ],
  };
}

export function createAlphaVantageMarketAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
  delayStatus?: "delayed" | "end_of_day";
}): FinanceRealtimeSourceAdapter {
  const apiKey = requiredText(options.apiKey, "Alpha Vantage apiKey");
  const delayStatus = options.delayStatus ?? "end_of_day";
  return {
    id: "alpha_vantage_global_quote",
    providerName: "alpha-vantage-global-quote",
    providerRole: "cross_check_market_data",
    priority: 15,
    supports: supportsAlphaVantageStock,
    collect: async (request, signal) => {
      if (!supportsAlphaVantageStock(request)) {
        throw new AdditionalSourceAdapterError(
          "unsupported Alpha Vantage GLOBAL_QUOTE stock/ETF request",
        );
      }
      signal.throwIfAborted();
      const symbol = request.instrument.trim();
      const fetchImpl = resolveFinanceFetch(options.fetchImpl, { signal });
      let metadata: AlphaVantageQuoteMetadata | undefined;
      if (!supportsUsStock(request)) {
        const metadataUrl = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(symbol)}`;
        let payload: unknown;
        try {
          payload = await fetchJson(
            fetchImpl,
            `${metadataUrl}&apikey=${encodeURIComponent(apiKey)}`,
          );
        } catch (error) {
          throw new AdditionalSourceAdapterError(
            `alpha vantage metadata unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        metadata = parseAlphaVantageSymbolMetadata(payload, symbol, metadataUrl);
      }
      signal.throwIfAborted();
      const sourceUrlOrArtifact = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}`;
      const url = `${sourceUrlOrArtifact}&apikey=${encodeURIComponent(apiKey)}`;
      const payload = await fetchJson(fetchImpl, url);
      const observation = parseAlphaVantageGlobalQuote(
        payload,
        symbol,
        sourceUrlOrArtifact,
        request.asOf,
        metadata,
      );
      return { ...observation, delayStatus };
    },
  };
}

export function createSecOfficialReferenceAdapter(
  options: {
    fetchImpl?: FetchImpl;
    cikByInstrument?: Readonly<Record<string, string>>;
  } = {},
): FinanceRealtimeSourceAdapter {
  const cikByInstrument: Readonly<Record<string, string>> = {
    QQQ: "0001067839",
    ...options.cikByInstrument,
  };
  return {
    id: "sec_edgar_official_reference",
    providerName: "sec-edgar-official",
    providerRole: "official_or_issuer_reference",
    priority: 10,
    supports: (request) =>
      request.assetClass.trim().toLowerCase() !== "crypto" &&
      Boolean(cikByInstrument[request.instrument.trim().toUpperCase()]),
    collect: async (request) => {
      const fetchImpl = resolveFinanceFetch(options.fetchImpl);
      const cik = cikByInstrument[request.instrument.trim().toUpperCase()];
      if (!cik || !/^\d{10}$/u.test(cik)) {
        throw new AdditionalSourceAdapterError(
          `SEC CIK mapping required for ${request.instrument}; ticker-map endpoint unavailable`,
        );
      }
      const sourceUrlOrArtifact = `https://data.sec.gov/submissions/CIK${cik}.json`;
      const submissions = (await fetchJson(fetchImpl, sourceUrlOrArtifact, {
        "User-Agent": SEC_USER_AGENT,
      })) as {
        name?: string;
        filings?: { recent?: { filingDate?: string[]; form?: string[] } };
      };
      const filingDate = submissions.filings?.recent?.filingDate?.[0];
      const filingForm = submissions.filings?.recent?.form?.[0];
      const sourceTimestamp = dayStartIso(filingDate, "SEC latest filing date");
      return {
        providerName: "sec-edgar-official",
        providerRole: "official_or_issuer_reference",
        sourceFamily: "official_filing",
        observedAt: request.asOf,
        timezone: "UTC",
        delayStatus: "official_lagged",
        fields: [
          {
            name: "latest_official_filing_date",
            value: filingDate ?? "",
            fieldDefinition: `latest SEC filing date for ${submissions.name ?? request.instrument}`,
            sourceTimestamp,
            sourceUrlOrArtifact,
          },
          {
            name: "latest_official_filing_form",
            value: filingForm ?? "",
            fieldDefinition: "latest SEC filing form identifier",
            sourceTimestamp,
            sourceUrlOrArtifact,
          },
        ],
      };
    },
  };
}

type InvescoPerformancePayload = {
  effectiveDate?: string;
  cumulativePerformance?: Array<{
    label?: string;
    ytd?: number;
  }>;
};

export function createInvescoIssuerReferenceAdapter(
  options: {
    ticker?: string;
    fetchImpl?: FetchImpl;
  } = {},
): FinanceRealtimeSourceAdapter {
  const ticker = (options.ticker ?? "QQQ").trim().toUpperCase();
  requiredText(ticker, "Invesco ticker");
  return {
    id: `invesco_${ticker.toLowerCase()}_issuer_reference`,
    providerName: "invesco-issuer-reference",
    providerRole: "official_or_issuer_reference",
    priority: 20,
    supports: (request) =>
      request.assetClass.trim().toLowerCase() !== "crypto" &&
      request.instrument.trim().toUpperCase() === ticker,
    collect: async (request) => {
      const sourceUrlOrArtifact = `https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/${encodeURIComponent(ticker)}/performance/standard?idType=ticker&performanceSubType=cumulative&productType=ETF`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
      )) as InvescoPerformancePayload;
      const effectiveDate = dayStartIso(payload.effectiveDate, "Invesco effective date");
      const marketPrice = payload.cumulativePerformance?.find(
        (entry) => entry.label === "marketPrice",
      );
      if (!marketPrice || typeof marketPrice.ytd !== "number") {
        throw new AdditionalSourceAdapterError("Invesco response has no market-price YTD field");
      }
      return {
        providerName: "invesco-issuer-reference",
        providerRole: "official_or_issuer_reference",
        sourceFamily: "etf_issuer",
        observedAt: request.asOf,
        timezone: "UTC",
        delayStatus: "official_lagged",
        fields: [
          {
            name: "issuer_effective_date",
            value: payload.effectiveDate ?? "",
            fieldDefinition: `Invesco ${ticker} performance effective date`,
            sourceTimestamp: effectiveDate,
            sourceUrlOrArtifact,
          },
          {
            name: "issuer_market_price_ytd_return_percent",
            value: marketPrice.ytd,
            unit: "%",
            fieldDefinition: `Invesco ${ticker} cumulative market-price YTD return`,
            sourceTimestamp: effectiveDate,
            sourceUrlOrArtifact,
          },
        ],
      };
    },
  };
}
