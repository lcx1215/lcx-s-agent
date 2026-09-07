import type { FinanceDataGatewayFieldInput } from "./finance-data-gateway.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import type { FinanceRealtimeSourceAdapter } from "./finance-realtime-source-registry.js";

const SEC_USER_AGENT = "LCX Agent research-only contact=local";

class UsEquitySourceAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsEquitySourceAdapterError";
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

function parseFiniteNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new UsEquitySourceAdapterError(`${label} must be a finite number`);
  }
  return parsed;
}

function isoDate(value: unknown, label: string): string {
  const normalized = requiredText(textValue(value), label);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new UsEquitySourceAdapterError(`${label} must be a date`);
  }
  return new Date(timestamp).toISOString();
}

function isoEpoch(value: unknown, label: string): string {
  const parsed = parseFiniteNumber(value, label);
  const milliseconds =
    parsed > 100_000_000_000_000
      ? parsed / 1_000_000
      : parsed > 10_000_000_000
        ? parsed
        : parsed * 1_000;
  if (!Number.isFinite(milliseconds)) {
    throw new UsEquitySourceAdapterError(`${label} must be a valid epoch`);
  }
  return new Date(milliseconds).toISOString();
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
    throw new UsEquitySourceAdapterError(
      `source request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new UsEquitySourceAdapterError(`source http status ${response.status}`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new UsEquitySourceAdapterError("source returned an empty body");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new UsEquitySourceAdapterError("source returned invalid JSON");
  }
}

function isUsEquityRequest(assetClass: string): boolean {
  return ["common_stock", "equity", "stock", "us_equity"].includes(assetClass.trim().toLowerCase());
}

function field(
  name: string,
  value: string | number,
  definition: string,
  sourceTimestamp: string,
  sourceUrlOrArtifact: string,
  extras: Pick<FinanceDataGatewayFieldInput, "unit" | "currency" | "adjusted"> = {},
): FinanceDataGatewayFieldInput {
  return {
    name,
    value,
    fieldDefinition: definition,
    sourceTimestamp,
    sourceUrlOrArtifact,
    ...extras,
  };
}

type SecFactUnit = {
  val?: unknown;
  filed?: unknown;
  end?: unknown;
  start?: unknown;
  form?: unknown;
  fp?: unknown;
  fy?: unknown;
  frame?: unknown;
};

type SecFactsPayload = {
  entityName?: string;
  facts?: Record<string, Record<string, { label?: string; units?: Record<string, SecFactUnit[]> }>>;
};

function latestFact(
  payload: SecFactsPayload,
  tags: readonly string[],
  preferredUnits: readonly string[],
): { tag: string; unit: string; fact: SecFactUnit } | undefined {
  const candidates = tags.flatMap((tag) => {
    const tagged = Object.entries(payload.facts ?? {}).flatMap(([namespace, facts]) => {
      const fact = facts[tag];
      if (!fact?.units) {
        return [];
      }
      return Object.entries(fact.units).flatMap(([unit, values]) =>
        values.map((entry) => ({ namespace, tag, unit, fact: entry })),
      );
    });
    return tagged;
  });
  const sorted = candidates.toSorted((left, right) => {
    const unitRank = (unit: string) => {
      const index = preferredUnits.indexOf(unit);
      return index < 0 ? preferredUnits.length : index;
    };
    return (
      unitRank(left.unit) - unitRank(right.unit) ||
      textValue(right.fact.filed || right.fact.end).localeCompare(
        textValue(left.fact.filed || left.fact.end),
      ) ||
      textValue(right.fact.end).localeCompare(textValue(left.fact.end))
    );
  });
  const selected = sorted.find((candidate) => Number.isFinite(Number(candidate.fact.val)));
  return selected;
}

function factField(
  fact: { tag: string; unit: string; fact: SecFactUnit },
  name: string,
  entityName: string,
  sourceUrlOrArtifact: string,
): FinanceDataGatewayFieldInput | undefined {
  const value = Number(fact.fact.val);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const sourceTimestamp = isoDate(fact.fact.filed ?? fact.fact.end, `${name} source date`);
  const period = [textValue(fact.fact.start), textValue(fact.fact.end)]
    .filter(Boolean)
    .join(" to ");
  const filing = [
    textValue(fact.fact.form),
    fact.fact.fy === undefined ? "" : `FY${textValue(fact.fact.fy)}`,
    textValue(fact.fact.fp),
  ]
    .filter(Boolean)
    .join(" ");
  return field(
    name,
    value,
    `${entityName} SEC XBRL fact ${fact.tag}${period ? ` for ${period}` : ""}${filing ? ` (${filing})` : ""}`,
    sourceTimestamp,
    sourceUrlOrArtifact,
    {
      unit: fact.unit,
      currency: fact.unit === "USD" ? "USD" : undefined,
      adjusted: false,
    },
  );
}

type SecTickerRecord = { cik_str?: unknown; ticker?: unknown };

async function resolveSecCik(
  instrument: string,
  fetchImpl: FetchImpl,
  overrides: Readonly<Record<string, string>>,
  tickerMapPromise: { value?: Promise<Map<string, string>> },
): Promise<string> {
  const symbol = instrument.trim().toUpperCase();
  const override = overrides[symbol];
  if (override && /^\d{1,10}$/u.test(override)) {
    return override.padStart(10, "0");
  }
  if (!tickerMapPromise.value) {
    tickerMapPromise.value = fetchJson(
      fetchImpl,
      "https://www.sec.gov/files/company_tickers.json",
      {
        "User-Agent": SEC_USER_AGENT,
      },
    ).then((payload) => {
      const map = new Map<string, string>();
      for (const record of Object.values((payload ?? {}) as Record<string, SecTickerRecord>)) {
        const ticker = typeof record.ticker === "string" ? record.ticker.trim().toUpperCase() : "";
        const cik =
          typeof record.cik_str === "number" ? String(record.cik_str) : textValue(record.cik_str);
        if (ticker && /^\d{1,10}$/u.test(cik)) {
          map.set(ticker, cik.padStart(10, "0"));
        }
      }
      return map;
    });
  }
  try {
    const tickerMap = await tickerMapPromise.value;
    const variants = [symbol, symbol.replace(".", "-")];
    const cik = variants.map((variant) => tickerMap.get(variant)).find(Boolean);
    if (cik) {
      return cik;
    }
  } catch {
    // The SEC www host can reject automated requests while data.sec.gov remains
    // available. Fall through to the official EDGAR search index in that case.
  }
  const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(symbol)}&forms=10-K&from=0&size=100`;
  const searchPayload = (await fetchJson(fetchImpl, searchUrl, {
    "User-Agent": SEC_USER_AGENT,
  })) as {
    hits?: { hits?: Array<{ _source?: { ciks?: unknown; display_names?: unknown } }> };
  };
  const hits = searchPayload.hits?.hits ?? [];
  const displayNameMarkers = [`(${symbol})`, `(${symbol.replace(".", "-")})`].map((value) =>
    value.toUpperCase(),
  );
  const matchingHit = hits.find((hit) =>
    (Array.isArray(hit._source?.display_names) ? hit._source.display_names : []).some(
      (name) =>
        typeof name === "string" &&
        displayNameMarkers.some((marker) => name.toUpperCase().includes(marker)),
    ),
  );
  const ciks = matchingHit?._source?.ciks;
  const cik = (Array.isArray(ciks) ? ciks : []).find(
    (candidate): candidate is string =>
      typeof candidate === "string" && /^\d{1,10}$/u.test(candidate),
  );
  if (!cik) {
    throw new UsEquitySourceAdapterError(`SEC EDGAR search index has no CIK for ${symbol}`);
  }
  return cik.padStart(10, "0");
}

export function createSecCompanyFactsAdapter(
  options: {
    fetchImpl?: FetchImpl;
    cikByInstrument?: Readonly<Record<string, string>>;
  } = {},
): FinanceRealtimeSourceAdapter {
  const overrides = Object.fromEntries(
    Object.entries(options.cikByInstrument ?? {}).map(([key, value]) => [key.toUpperCase(), value]),
  );
  const tickerMapPromise: { value?: Promise<Map<string, string>> } = {};
  return {
    id: "sec_edgar_companyfacts",
    providerName: "sec-edgar-companyfacts",
    providerRole: "official_or_issuer_reference",
    priority: 11,
    supports: (request) => isUsEquityRequest(request.assetClass),
    collect: async (request) => {
      const fetchImpl = resolveFinanceFetch(options.fetchImpl);
      const cik = await resolveSecCik(request.instrument, fetchImpl, overrides, tickerMapPromise);
      const sourceUrlOrArtifact = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
      const payload = (await fetchJson(fetchImpl, sourceUrlOrArtifact, {
        "User-Agent": SEC_USER_AGENT,
      })) as SecFactsPayload;
      const entityName = payload.entityName ?? request.instrument.toUpperCase();
      const factSpecs = [
        {
          name: "fundamental_revenue",
          tags: [
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "Revenues",
            "SalesRevenueNet",
          ],
          units: ["USD"],
        },
        { name: "fundamental_net_income", tags: ["NetIncomeLoss", "ProfitLoss"], units: ["USD"] },
        { name: "fundamental_assets", tags: ["Assets"], units: ["USD"] },
        { name: "fundamental_liabilities", tags: ["Liabilities"], units: ["USD"] },
        {
          name: "fundamental_stockholders_equity",
          tags: [
            "StockholdersEquity",
            "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
          ],
          units: ["USD"],
        },
        {
          name: "shares_outstanding",
          tags: ["EntityCommonStockSharesOutstanding"],
          units: ["shares"],
        },
      ] as const;
      const fields = factSpecs.flatMap((spec) => {
        const selected = latestFact(payload, spec.tags, spec.units);
        const normalized =
          selected && factField(selected, spec.name, entityName, sourceUrlOrArtifact);
        return normalized ? [normalized] : [];
      });
      if (fields.length === 0) {
        throw new UsEquitySourceAdapterError(
          `SEC companyfacts has no supported facts for ${request.instrument}`,
        );
      }
      return {
        providerName: "sec-edgar-companyfacts",
        providerRole: "official_or_issuer_reference",
        sourceFamily: "fundamentals_api",
        observedAt: request.asOf,
        timezone: "UTC",
        delayStatus: "official_lagged",
        fields,
      };
    },
  };
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type MassiveSnapshot = {
  ticker?: {
    day?: { c?: unknown; v?: unknown; vw?: unknown; o?: unknown; h?: unknown; l?: unknown };
    prevDay?: { c?: unknown };
    lastTrade?: { p?: unknown; t?: unknown };
    lastQuote?: { P?: unknown; p?: unknown; T?: unknown };
    updated?: unknown;
  };
};

export function createMassiveUsEquitySnapshotAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
  delayStatus?: "realtime" | "delayed";
}): FinanceRealtimeSourceAdapter {
  const apiKey = requiredText(options.apiKey, "Massive apiKey");
  const delayStatus = options.delayStatus ?? "delayed";
  return {
    id: "massive_us_equity_snapshot",
    providerName: "massive-us-equity-snapshot",
    providerRole: "primary_market_data",
    priority: 5,
    supports: (request) => isUsEquityRequest(request.assetClass),
    collect: async (request) => {
      const baseUrl = `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(request.instrument.toUpperCase())}`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        `${baseUrl}?apiKey=${encodeURIComponent(apiKey)}`,
      )) as MassiveSnapshot;
      const ticker = payload.ticker;
      if (!ticker) {
        throw new UsEquitySourceAdapterError(
          `Massive returned no ticker snapshot for ${request.instrument}`,
        );
      }
      const updated = ticker.updated ?? ticker.lastTrade?.t ?? ticker.lastQuote?.T;
      const sourceTimestamp =
        updated === undefined ? request.asOf : isoEpoch(updated, "Massive update time");
      const lastPrice = optionalNumber(ticker.lastTrade?.p ?? ticker.day?.c);
      const bid = optionalNumber(ticker.lastQuote?.p);
      const ask = optionalNumber(ticker.lastQuote?.P);
      const fields = [
        lastPrice === undefined
          ? undefined
          : field(
              "last_price",
              lastPrice,
              `Massive consolidated snapshot last trade for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              baseUrl,
              { currency: "USD", adjusted: false },
            ),
        bid === undefined
          ? undefined
          : field(
              "bid_price",
              bid,
              `Massive consolidated snapshot bid for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              baseUrl,
              { currency: "USD" },
            ),
        ask === undefined
          ? undefined
          : field(
              "ask_price",
              ask,
              `Massive consolidated snapshot ask for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              baseUrl,
              { currency: "USD" },
            ),
        optionalNumber(ticker.day?.v) === undefined
          ? undefined
          : field(
              "day_volume",
              optionalNumber(ticker.day?.v)!,
              `Massive consolidated snapshot day volume for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              baseUrl,
              { unit: "shares" },
            ),
        optionalNumber(ticker.day?.o) === undefined
          ? undefined
          : field(
              "day_open",
              optionalNumber(ticker.day?.o)!,
              `Massive consolidated snapshot day open for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              baseUrl,
              { currency: "USD" },
            ),
        optionalNumber(ticker.day?.h) === undefined
          ? undefined
          : field(
              "day_high",
              optionalNumber(ticker.day?.h)!,
              `Massive consolidated snapshot day high for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              baseUrl,
              { currency: "USD" },
            ),
        optionalNumber(ticker.day?.l) === undefined
          ? undefined
          : field(
              "day_low",
              optionalNumber(ticker.day?.l)!,
              `Massive consolidated snapshot day low for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              baseUrl,
              { currency: "USD" },
            ),
      ].filter((value): value is FinanceDataGatewayFieldInput => Boolean(value));
      if (fields.length === 0) {
        throw new UsEquitySourceAdapterError(
          `Massive snapshot has no supported fields for ${request.instrument}`,
        );
      }
      return {
        providerName: "massive-us-equity-snapshot",
        providerRole: "primary_market_data",
        sourceFamily: "market_data_api",
        observedAt: request.asOf,
        timezone: "America/New_York",
        delayStatus,
        fields,
      };
    },
  };
}

export function createAlpacaUsEquityQuoteAdapter(options: {
  apiKeyId: string;
  apiSecretKey: string;
  fetchImpl?: FetchImpl;
  feed?: string;
}): FinanceRealtimeSourceAdapter {
  const apiKeyId = requiredText(options.apiKeyId, "Alpaca apiKeyId");
  const apiSecretKey = requiredText(options.apiSecretKey, "Alpaca apiSecretKey");
  const feed = options.feed?.trim() || "iex";
  return {
    id: "alpaca_us_equity_latest_quote",
    providerName: "alpaca-us-equity-latest-quote",
    providerRole: "cross_check_market_data",
    priority: 6,
    supports: (request) => isUsEquityRequest(request.assetClass),
    collect: async (request) => {
      const sourceUrlOrArtifact = `https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=${encodeURIComponent(request.instrument.toUpperCase())}&feed=${encodeURIComponent(feed)}`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
        {
          "APCA-API-KEY-ID": apiKeyId,
          "APCA-API-SECRET-KEY": apiSecretKey,
        },
      )) as {
        quotes?: Record<
          string,
          { ap?: unknown; as?: unknown; bp?: unknown; bs?: unknown; t?: unknown }
        >;
      };
      const quote = payload.quotes?.[request.instrument.toUpperCase()];
      if (!quote) {
        throw new UsEquitySourceAdapterError(`Alpaca returned no quote for ${request.instrument}`);
      }
      const sourceTimestamp =
        quote.t === undefined ? request.asOf : isoDate(quote.t, "Alpaca quote time");
      const bid = optionalNumber(quote.bp);
      const ask = optionalNumber(quote.ap);
      const fields = [
        bid === undefined
          ? undefined
          : field(
              "bid_price",
              bid,
              `Alpaca ${feed} bid for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        ask === undefined
          ? undefined
          : field(
              "ask_price",
              ask,
              `Alpaca ${feed} ask for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        bid === undefined || ask === undefined
          ? undefined
          : field(
              "quote_mid_price",
              (bid + ask) / 2,
              `Alpaca ${feed} bid-ask midpoint for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        optionalNumber(quote.bs) === undefined
          ? undefined
          : field(
              "bid_size",
              optionalNumber(quote.bs)!,
              `Alpaca ${feed} bid size for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { unit: "shares" },
            ),
        optionalNumber(quote.as) === undefined
          ? undefined
          : field(
              "ask_size",
              optionalNumber(quote.as)!,
              `Alpaca ${feed} ask size for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { unit: "shares" },
            ),
      ].filter((value): value is FinanceDataGatewayFieldInput => Boolean(value));
      if (fields.length === 0) {
        throw new UsEquitySourceAdapterError(
          `Alpaca quote has no supported fields for ${request.instrument}`,
        );
      }
      return {
        providerName: "alpaca-us-equity-latest-quote",
        providerRole: "cross_check_market_data",
        sourceFamily: "market_data_api",
        observedAt: request.asOf,
        timezone: "America/New_York",
        delayStatus: "delayed",
        fields,
      };
    },
  };
}

export function createFinnhubUsEquityQuoteAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
  delayStatus?: "realtime" | "delayed";
}): FinanceRealtimeSourceAdapter {
  const apiKey = requiredText(options.apiKey, "Finnhub apiKey");
  const delayStatus = options.delayStatus ?? "delayed";
  return {
    id: "finnhub_us_equity_quote",
    providerName: "finnhub-us-equity-quote",
    providerRole: "cross_check_market_data",
    priority: 7,
    supports: (request) => isUsEquityRequest(request.assetClass),
    collect: async (request) => {
      const sourceUrlOrArtifact = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(request.instrument.toUpperCase())}`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        `${sourceUrlOrArtifact}&token=${encodeURIComponent(apiKey)}`,
      )) as {
        c?: unknown;
        d?: unknown;
        dp?: unknown;
        h?: unknown;
        l?: unknown;
        o?: unknown;
        pc?: unknown;
        t?: unknown;
      };
      const sourceTimestamp =
        payload.t === undefined ? request.asOf : isoEpoch(payload.t, "Finnhub quote time");
      const fields = [
        optionalNumber(payload.c) === undefined
          ? undefined
          : field(
              "last_price",
              optionalNumber(payload.c)!,
              `Finnhub current quote for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD", adjusted: false },
            ),
        optionalNumber(payload.d) === undefined
          ? undefined
          : field(
              "change",
              optionalNumber(payload.d)!,
              `Finnhub session price change for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        optionalNumber(payload.dp) === undefined
          ? undefined
          : field(
              "change_percent",
              optionalNumber(payload.dp)!,
              `Finnhub session percentage change for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { unit: "%" },
            ),
        optionalNumber(payload.h) === undefined
          ? undefined
          : field(
              "day_high",
              optionalNumber(payload.h)!,
              `Finnhub session high for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        optionalNumber(payload.l) === undefined
          ? undefined
          : field(
              "day_low",
              optionalNumber(payload.l)!,
              `Finnhub session low for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        optionalNumber(payload.o) === undefined
          ? undefined
          : field(
              "day_open",
              optionalNumber(payload.o)!,
              `Finnhub session open for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        optionalNumber(payload.pc) === undefined
          ? undefined
          : field(
              "previous_close",
              optionalNumber(payload.pc)!,
              `Finnhub previous close for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
      ].filter((value): value is FinanceDataGatewayFieldInput => Boolean(value));
      if (fields.length === 0) {
        throw new UsEquitySourceAdapterError(
          `Finnhub quote has no supported fields for ${request.instrument}`,
        );
      }
      return {
        providerName: "finnhub-us-equity-quote",
        providerRole: "cross_check_market_data",
        sourceFamily: "market_data_api",
        observedAt: request.asOf,
        timezone: "America/New_York",
        delayStatus,
        fields,
      };
    },
  };
}

export function createTwelveDataUsEquityQuoteAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceRealtimeSourceAdapter {
  const apiKey = requiredText(options.apiKey, "Twelve Data apiKey");
  return {
    id: "twelve_data_us_equity_quote",
    providerName: "twelve-data-us-equity-quote",
    providerRole: "cross_check_market_data",
    priority: 8,
    supports: (request) => isUsEquityRequest(request.assetClass),
    collect: async (request) => {
      const sourceUrlOrArtifact = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(request.instrument.toUpperCase())}`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        `${sourceUrlOrArtifact}&apikey=${encodeURIComponent(apiKey)}`,
      )) as Record<string, unknown>;
      if (typeof payload.status === "string" && payload.status.toLowerCase() === "error") {
        throw new UsEquitySourceAdapterError(
          textValue(payload.message) || "Twelve Data returned an error",
        );
      }
      const sourceTimestamp =
        payload.timestamp !== undefined
          ? isoEpoch(payload.timestamp, "Twelve Data quote time")
          : isoDate(payload.datetime, "Twelve Data quote date");
      const fields = [
        optionalNumber(payload.close) === undefined
          ? undefined
          : field(
              "last_price",
              optionalNumber(payload.close)!,
              `Twelve Data quote close for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD", adjusted: false },
            ),
        optionalNumber(payload.change) === undefined
          ? undefined
          : field(
              "change",
              optionalNumber(payload.change)!,
              `Twelve Data session price change for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        optionalNumber(payload.percent_change) === undefined
          ? undefined
          : field(
              "change_percent",
              optionalNumber(payload.percent_change)!,
              `Twelve Data session percentage change for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { unit: "%" },
            ),
        optionalNumber(payload.high) === undefined
          ? undefined
          : field(
              "day_high",
              optionalNumber(payload.high)!,
              `Twelve Data session high for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        optionalNumber(payload.low) === undefined
          ? undefined
          : field(
              "day_low",
              optionalNumber(payload.low)!,
              `Twelve Data session low for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { currency: "USD" },
            ),
        optionalNumber(payload.volume) === undefined
          ? undefined
          : field(
              "day_volume",
              optionalNumber(payload.volume)!,
              `Twelve Data session volume for ${request.instrument.toUpperCase()}`,
              sourceTimestamp,
              sourceUrlOrArtifact,
              { unit: "shares" },
            ),
      ].filter((value): value is FinanceDataGatewayFieldInput => Boolean(value));
      if (fields.length === 0) {
        throw new UsEquitySourceAdapterError(
          `Twelve Data quote has no supported fields for ${request.instrument}`,
        );
      }
      return {
        providerName: "twelve-data-us-equity-quote",
        providerRole: "cross_check_market_data",
        sourceFamily: "market_data_api",
        observedAt: request.asOf,
        timezone: "America/New_York",
        delayStatus: "delayed",
        fields,
      };
    },
  };
}
