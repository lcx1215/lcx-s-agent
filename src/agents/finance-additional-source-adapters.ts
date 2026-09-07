import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import type { FinanceRealtimeSourceAdapter } from "./finance-realtime-source-registry.js";

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
  const timestamp = Date.parse(day);
  if (!Number.isFinite(timestamp)) {
    throw new AdditionalSourceAdapterError(`${label} must be an ISO date`);
  }
  const parsedDate = new Date(timestamp);
  return new Date(
    Date.UTC(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate()),
  ).toISOString();
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
    supports: (request) => request.assetClass.trim().toLowerCase() !== "crypto",
    collect: async (request) => {
      const symbol = request.instrument.includes(".")
        ? request.instrument.toLowerCase()
        : `${request.instrument.toLowerCase()}.us`;
      const sourceUrlOrArtifact = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
      const fetchImpl = resolveFinanceFetch(options.fetchImpl);
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
    supports: (request) => request.assetClass.trim().toLowerCase() !== "crypto",
    collect: async (request) => {
      const assetClass = request.assetClass.trim().toLowerCase();
      const nasdaqAssetClass = assetClass === "etf" ? "etfs" : "stocks";
      const sourceUrlOrArtifact = `https://api.nasdaq.com/api/quote/${encodeURIComponent(request.instrument.toUpperCase())}/info?assetclass=${nasdaqAssetClass}`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
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
      const sourceTimestamp = dayStartIso(primary.lastTradeTimestamp, "Nasdaq trade date");
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
            fieldDefinition: `Nasdaq public exchange last sale for ${request.instrument.toUpperCase()}`,
            sourceTimestamp,
            sourceUrlOrArtifact,
          },
        ],
      };
    },
  };
}

export function parseAlphaVantageGlobalQuote(
  payload: unknown,
  symbol: string,
  sourceUrlOrArtifact: string,
  observedAt = new Date().toISOString(),
): FinanceDataGatewayObservationInput {
  const quote = (payload as { [key: string]: unknown })["Global Quote"] as
    | Record<string, unknown>
    | undefined;
  if (!quote || Object.keys(quote).length === 0) {
    throw new AdditionalSourceAdapterError("alpha vantage returned no Global Quote");
  }
  const date = dayStartIso(quote["07. latest trading day"], "alpha vantage trading day");
  const close = parseFiniteNumber(quote["05. price"], "alpha vantage price");
  return {
    providerName: "alpha-vantage-global-quote",
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
        fieldDefinition: `end-of-day global quote from Alpha Vantage for ${symbol}`,
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
    supports: (request) => request.assetClass.trim().toLowerCase() !== "crypto",
    collect: async (request) => {
      const sourceUrlOrArtifact = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(request.instrument)}`;
      const url = `${sourceUrlOrArtifact}&apikey=${encodeURIComponent(apiKey)}`;
      const payload = await fetchJson(resolveFinanceFetch(options.fetchImpl), url);
      const observation = parseAlphaVantageGlobalQuote(
        payload,
        request.instrument,
        sourceUrlOrArtifact,
        request.asOf,
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
