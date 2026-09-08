import type {
  FinanceMarketCollectionKind as Kind,
  FinanceMarketCollectionRegistryOptions as Options,
  FinanceMarketCollectionRequest as Request,
} from "./finance-market-collection-registry.js";
import type { Capability } from "./finance-registered-capability-adapters.js";

type Row = Record<string, unknown>;
const obj = (v: unknown): Row =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const rows = (v: unknown): Row[] =>
  Array.isArray(v) ? v.map(obj).filter((r) => Object.keys(r).length > 0) : [];
const iso = (v: unknown): string | undefined => {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};
const endpoint = (base: string, params: Record<string, string> = {}): URL => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
};
const equity = (r: Request) =>
  ["us_equity", "equity", "stock", "common_stock", "etf"].includes(r.assetClass);
const count = (r: Request) => String(Math.min(r.limit ?? 100, 5000));
const dates = (r: Request) => ({
  from: r.fromDate ?? new Date(Date.parse(r.asOf) - 365 * 86400000).toISOString().slice(0, 10),
  to: r.toDate ?? r.asOf.slice(0, 10),
});
const coinId = (r: Request) =>
  ({ BTC: "bitcoin", BTCUSDT: "bitcoin", ETH: "ethereum", ETHUSDT: "ethereum" })[
    r.instrument.toUpperCase()
  ] ?? r.instrument.toLowerCase();

/** Quoted CSV bulk exports; JSON success/error envelopes are also supported. */
export function decodeFinanceBulk(text: string): unknown {
  const input = text.replace(/^\uFEFF/u, "").trim();
  if (input.startsWith("[") || input.startsWith("{")) {
    return JSON.parse(input) as unknown;
  }
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      row.push(field);
      field = "";
    } else if (ch === "\n" && !quoted) {
      row.push(field.replace(/\r$/u, ""));
      table.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (quoted) {
    throw new Error("unterminated bulk CSV field");
  }
  row.push(field.replace(/\r$/u, ""));
  table.push(row);
  const header = table.shift() ?? [];
  if (!header.includes("symbol") || new Set(header).size !== header.length) {
    throw new Error("unexpected bulk CSV schema");
  }
  return table.map((values) => {
    if (values.length !== header.length) {
      throw new Error("invalid bulk CSV row width");
    }
    return Object.fromEntries(header.map((key, i) => [key, values[i]]));
  });
}

/** Explicit GET endpoints only. Registration is not a claim of plan entitlement. */
export function extendedFinanceCapabilities(options: Options): Capability[] {
  const result: Capability[] = [];
  const fmpDoc = "https://site.financialmodelingprep.com/developer/docs";
  const fmp = (
    path: string,
    collection: Kind,
    mode: "dated" | "snapshot" | "forecast" = "dated",
    extra: Record<string, string> = {},
    symbol = "AAPL",
    symbolParam = "symbol",
  ) => {
    result.push({
      id: `fmp_${path.replaceAll(/[/-]/gu, "_")}${extra.period ? `_${extra.period}` : ""}`,
      provider: "FMP",
      key: options.fmpApiKey,
      auth: "apikey-header",
      documentation: fmpDoc,
      collection,
      snapshot: mode !== "dated",
      accepts: equity,
      sample: { instrument: symbol, assetClass: "us_equity", collection },
      url: (r) =>
        endpoint(`https://financialmodelingprep.com/stable/${path}`, {
          ...(symbolParam ? { [symbolParam]: r.instrument } : {}),
          ...extra,
          ...(collection === "news" ||
          collection === "sec_filings" ||
          collection === "event_calendar"
            ? dates(r)
            : {}),
        }),
      parse: (_body, raw) =>
        rows(raw)
          .filter((data) => !data.error && !data["Error Message"])
          .map((data) => ({
            data: {
              ...data,
              ...(mode === "forecast"
                ? {
                    valueNature: "forecast_or_scheduled_event_not_realized",
                    targetPeriod: data.date,
                  }
                : {}),
              publicationTimeUnknown: !data.publishedDate && !data.filingDate && !data.acceptedDate,
            },
            // A forecast target date must never be treated as a future observation.
            time:
              mode === "forecast"
                ? undefined
                : iso(data.publishedDate ?? data.acceptedDate ?? data.filingDate ?? data.date),
          })),
    });
  };
  for (const period of ["annual", "quarter"]) {
    for (const path of [
      "income-statement",
      "balance-sheet-statement",
      "cash-flow-statement",
      "key-metrics",
      "ratios",
      "income-statement-growth",
      "balance-sheet-statement-growth",
      "cash-flow-statement-growth",
      "financial-growth",
      "income-statement-as-reported",
      "balance-sheet-statement-as-reported",
      "cash-flow-statement-as-reported",
    ]) {
      fmp(path, "financial_statements", "dated", { period, limit: "100" });
    }
  }
  for (const path of [
    "key-metrics-ttm",
    "ratios-ttm",
    "financial-scores",
    "enterprise-values",
    "discounted-cash-flow",
    "levered-discounted-cash-flow",
  ]) {
    fmp(path, "valuation", "snapshot");
  }
  for (const path of [
    "price-target-consensus",
    "price-target-summary",
    "grades-consensus",
    "ratings-snapshot",
  ]) {
    fmp(path, "analyst_estimates", "snapshot");
  }
  fmp("analyst-estimates", "analyst_estimates", "forecast", {
    period: "annual",
    page: "0",
    limit: "100",
  });
  fmp("grades", "analyst_estimates");
  fmp("stock-peers", "market_reference", "snapshot");
  for (const path of ["news/stock", "news/press-releases"]) {
    fmp(path, "news", "dated", { limit: "100" }, "AAPL", "symbols");
  }
  for (const path of ["dividends", "splits"] as const) {
    fmp(path, path);
  }
  fmp("earnings", "earnings", "forecast");
  for (const path of [
    "earnings-calendar",
    "economic-calendar",
    "ipos-calendar",
    "splits-calendar",
    "dividends-calendar",
  ]) {
    fmp(path, "event_calendar", "forecast", {}, "MARKET", "");
  }
  fmp("earning-call-transcript-dates", "transcripts", "snapshot");
  for (const path of [
    "etf/holdings",
    "etf/info",
    "etf/country-weightings",
    "etf/sector-weightings",
  ]) {
    fmp(path, "etf_holdings", "snapshot", {}, "SPY");
  }
  fmp("etf/asset-exposure", "etf_holdings", "snapshot");
  for (const path of [
    "insider-trading/search",
    "insider-trading/statistics",
    "senate-trades",
    "house-trades",
  ]) {
    fmp(path, "ownership", "snapshot");
  }
  fmp("sec-filings-search/symbol", "sec_filings", "dated", { page: "0", limit: "100" });
  for (const path of [
    "stock-list",
    "etf-list",
    "index-list",
    "forex-list",
    "cryptocurrency-list",
    "commodities-list",
    "available-exchanges",
    "available-sectors",
    "available-industries",
    "sp500-constituent",
    "nasdaq-constituent",
    "dowjones-constituent",
  ]) {
    fmp(path, "market_reference", "snapshot", {}, "MARKET", "");
  }
  for (const indicator of ["sma", "ema", "rsi", "adx", "standarddeviation"]) {
    fmp(`technical-indicators/${indicator}`, "technical_indicators", "dated", {
      periodLength: "14",
      timeframe: "1day",
    });
  }

  for (const path of ["esg-disclosures", "esg-ratings"]) {
    fmp(path, "valuation", "snapshot");
  }
  for (const path of [
    "all-exchange-market-hours",
    "commitment-of-traders-list",
    "biggest-gainers",
    "biggest-losers",
    "most-actives",
    "crowdfunding-offerings-latest",
    "fundraising-latest",
  ]) {
    fmp(path, "market_reference", "snapshot", {}, "MARKET", "");
  }
  fmp("commitment-of-traders-report", "ownership", "dated", {}, "MARKET", "");
  fmp("search-symbol", "market_reference", "snapshot", {}, "AAPL", "query");
  fmp("search-name", "market_reference", "snapshot", {}, "Apple", "query");
  fmp("quote", "market_reference", "snapshot");
  for (const path of ["sector-performance-snapshot", "sector-pe-snapshot"]) {
    result.push({
      id: `fmp_${path.replaceAll("-", "_")}`,
      provider: "FMP",
      key: options.fmpApiKey,
      auth: "apikey-header",
      documentation: fmpDoc,
      collection: "market_reference",
      accepts: equity,
      sample: { instrument: "MARKET", assetClass: "us_equity", collection: "market_reference" },
      url: (r) =>
        endpoint(`https://financialmodelingprep.com/stable/${path}`, {
          date: r.toDate ?? new Date(Date.parse(r.asOf) - 86400000).toISOString().slice(0, 10),
        }),
      parse: (_body, raw) => rows(raw).map((data) => ({ data, time: iso(data.date) })),
    });
  }
  for (const name of [
    "GDP",
    "realGDP",
    "unemploymentRate",
    "CPI",
    "inflationRate",
    "federalFunds",
  ]) {
    result.push({
      id: `fmp_macro_${name}`,
      provider: "FMP",
      key: options.fmpApiKey,
      auth: "apikey-header",
      documentation: fmpDoc,
      collection: "macro_series",
      sample: {
        instrument: name,
        seriesId: name,
        assetClass: "macro_series",
        collection: "macro_series",
      },
      accepts: (r) => r.assetClass === "macro_series" && (r.seriesId ?? r.instrument) === name,
      url: (r) =>
        endpoint("https://financialmodelingprep.com/stable/economic-indicators", {
          name,
          ...dates(r),
        }),
      parse: (_body, raw) =>
        rows(raw)
          .filter((data) => !data.error && !data["Error Message"])
          .map((data) => ({ data, time: iso(data.date) })),
    });
  }
  for (const path of ["profile-bulk", "eod-bulk"] as const) {
    result.push({
      id: `fmp_${path.replaceAll("-", "_")}`,
      provider: "FMP",
      key: options.fmpApiKey,
      auth: "apikey-header",
      documentation: fmpDoc,
      collection: "bulk_dataset",
      snapshot: path === "profile-bulk",
      decode: decodeFinanceBulk,
      sample:
        path === "profile-bulk"
          ? { instrument: "MARKET", assetClass: "us_equity", collection: "bulk_dataset" }
          : undefined,
      accepts: (r) =>
        equity(r) &&
        (path === "profile-bulk"
          ? !r.seriesId || /^part:\d+$/u.test(r.seriesId)
          : /^\d{4}-\d{2}-\d{2}$/u.test(r.seriesId ?? "")),
      url: (r) =>
        endpoint(
          `https://financialmodelingprep.com/stable/${path}`,
          path === "profile-bulk" ? { part: r.seriesId?.slice(5) ?? "0" } : { date: r.seriesId! },
        ),
      parse: (_body, raw) =>
        rows(raw)
          .filter((data) => typeof data.symbol === "string")
          .map((data) => ({ data, time: path === "eod-bulk" ? iso(data.date) : undefined })),
    });
  }
  // Transcript and 13F periods are explicit, never guessed from today's calendar.
  for (const [path, collection] of [
    ["earning-call-transcript", "transcripts"],
    ["institutional-ownership/symbol-positions-summary", "ownership"],
  ] as const) {
    result.push({
      id: `fmp_${path.replaceAll(/[/-]/gu, "_")}`,
      provider: "FMP",
      key: options.fmpApiKey,
      auth: "apikey-header",
      documentation: fmpDoc,
      collection,
      snapshot: true,
      accepts: (r) => equity(r) && /^\d{4}-Q[1-4]$/u.test(r.seriesId ?? ""),
      url: (r) => {
        const [year, quarter] = r.seriesId!.split("-Q");
        return endpoint(`https://financialmodelingprep.com/stable/${path}`, {
          symbol: r.instrument,
          year,
          quarter,
        });
      },
      parse: (_body, raw) =>
        rows(raw)
          .filter((data) => !data.error && !data["Error Message"])
          .map((data) => ({ data, time: iso(data.date) })),
    });
  }

  for (const fn of [
    "EARNINGS",
    "DIVIDENDS",
    "SPLITS",
    "INSIDER_TRANSACTIONS",
    "ETF_PROFILE",
    "NEWS_SENTIMENT",
  ] as const) {
    const collection: Kind = (
      {
        EARNINGS: "earnings",
        DIVIDENDS: "dividends",
        SPLITS: "splits",
        INSIDER_TRANSACTIONS: "ownership",
        ETF_PROFILE: "etf_holdings",
        NEWS_SENTIMENT: "news",
      } as const
    )[fn];
    result.push({
      id: `alpha_vantage_${fn.toLowerCase()}`,
      provider: "Alpha Vantage",
      key: options.alphaVantageApiKey,
      auth: "apikey",
      collection,
      documentation: "https://www.alphavantage.co/documentation/",
      snapshot: fn === "ETF_PROFILE",
      accepts: equity,
      sample: {
        instrument: fn === "ETF_PROFILE" ? "SPY" : "AAPL",
        assetClass: "us_equity",
        collection,
      },
      url: (r) =>
        endpoint("https://www.alphavantage.co/query", {
          function: fn,
          [fn === "NEWS_SENTIMENT" ? "tickers" : "symbol"]: r.instrument,
          ...(fn === "NEWS_SENTIMENT" ? { limit: count(r) } : {}),
        }),
      parse: (body) =>
        fn === "ETF_PROFILE"
          ? Array.isArray(body.holdings)
            ? [{ data: body }]
            : []
          : rows(
              fn === "EARNINGS"
                ? body.quarterlyEarnings
                : fn === "NEWS_SENTIMENT"
                  ? body.feed
                  : body.data,
            ).map((data) => ({
              data,
              time: iso(
                data.reportedDate ??
                  data.fiscalDateEnding ??
                  data.ex_dividend_date ??
                  data.effective_date ??
                  data.transaction_date ??
                  (typeof data.time_published === "string"
                    ? data.time_published.replace(
                        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/u,
                        "$1-$2-$3T$4:$5:$6Z",
                      )
                    : undefined),
              ),
            })),
    });
  }
  for (const [path, collection] of [
    ["stock/recommendation", "analyst_estimates"],
    ["stock/price-target", "analyst_estimates"],
    ["stock/insider-transactions", "ownership"],
    ["stock/insider-sentiment", "ownership"],
    ["stock/financials-reported", "financial_statements"],
  ] as const) {
    result.push({
      id: `finnhub_${path.replaceAll(/[/-]/gu, "_")}`,
      provider: "Finnhub",
      key: options.finnhubApiKey,
      auth: "X-Finnhub-Token",
      collection,
      snapshot: true,
      accepts: equity,
      documentation: "https://finnhub.io/docs/api",
      sample: { instrument: "AAPL", assetClass: "us_equity", collection },
      url: (r) =>
        endpoint(`https://finnhub.io/api/v1/${path}`, {
          symbol: r.instrument,
          ...(path.includes("insider") ? dates(r) : {}),
        }),
      parse: (body, raw) =>
        (Array.isArray(raw)
          ? rows(raw)
          : Array.isArray(body.data)
            ? rows(body.data)
            : typeof body.targetMean === "number"
              ? [body]
              : []
        ).map((data) => ({
          data,
          time: iso(
            data.filedDate ??
              data.transactionDate ??
              data.period ??
              data.endDate ??
              data.lastUpdated,
          ),
        })),
    });
  }
  for (const path of ["time_series", "sma", "ema", "rsi", "macd", "bbands", "atr"] as const) {
    const collection = path === "time_series" ? "eod_history" : "technical_indicators";
    result.push({
      id: `twelve_data_${path}`,
      provider: "Twelve Data",
      key: options.twelveDataApiKey,
      auth: "apikey",
      collection,
      accepts: equity,
      documentation: "https://twelvedata.com/docs/introduction/overview",
      sample: { instrument: "AAPL", assetClass: "us_equity", collection },
      url: (r) =>
        endpoint(`https://api.twelvedata.com/${path}`, {
          symbol: r.instrument,
          interval: "1day",
          outputsize: count(r),
          order: "desc",
          start_date: dates(r).from,
          end_date: dates(r).to,
        }),
      parse: (body) =>
        rows(body.values).map((data) => ({
          data: {
            ...data,
            ...(path === "time_series"
              ? { close: Number(data.close), volume: Number(data.volume) }
              : {}),
          },
          time: iso(data.datetime),
        })),
    });
  }
  if (options.alpacaApiSecretKey) {
    result.push({
      id: "alpaca_daily_history",
      provider: "Alpaca",
      key: options.alpacaApiKeyId,
      auth: "APCA-API-KEY-ID",
      extraHeaders: { "APCA-API-SECRET-KEY": options.alpacaApiSecretKey },
      collection: "eod_history",
      accepts: equity,
      documentation: "https://docs.alpaca.markets/us/reference/stockbars",
      sample: { instrument: "AAPL", assetClass: "us_equity", collection: "eod_history" },
      url: (r) =>
        endpoint(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(r.instrument)}/bars`, {
          timeframe: "1Day",
          start: `${dates(r).from}T00:00:00Z`,
          end: `${dates(r).to}T00:00:00Z`,
          limit: count(r),
          sort: "desc",
          adjustment: "all",
          feed: options.alpacaDataFeed ?? "iex",
        }),
      parse: (body) =>
        rows(body.bars).map((data) => ({
          data: {
            ...data,
            close: data.c,
            volume: data.v,
            feed: options.alpacaDataFeed ?? "iex",
            adjusted: true,
            continuationRequired: Boolean(body.next_page_token),
          },
          time: iso(data.t),
        })),
    });
  }
  for (const path of ["tickers", "tickers/{ticker}"] as const) {
    result.push({
      id: path === "tickers" ? "massive_ticker_directory" : "massive_ticker_overview",
      provider: "Massive",
      key: options.massiveApiKey,
      auth: "Authorization",
      collection: "market_reference",
      snapshot: true,
      accepts: equity,
      documentation: "https://massive.com/docs/rest/stocks/tickers/ticker-overview",
      sample: { instrument: "AAPL", assetClass: "us_equity", collection: "market_reference" },
      url: (r) =>
        endpoint(
          `https://api.massive.com/v3/reference/${path.replace("{ticker}", encodeURIComponent(r.instrument))}`,
          path === "tickers" ? { market: "stocks", active: "true", limit: "1000" } : {},
        ),
      parse: (body) =>
        (Array.isArray(body.results)
          ? rows(body.results)
          : obj(body.results).ticker
            ? [obj(body.results)]
            : []
        ).map((data) => ({ data: { ...data, continuationRequired: Boolean(body.next_url) } })),
    });
  }
  for (const path of [
    "global",
    "coins/markets",
    "coins/list",
    "coins/{id}",
    "coins/{id}/tickers",
  ] as const) {
    result.push({
      id: `coingecko_${path.replaceAll(/[/{ }]/gu, "_")}`,
      provider: "CoinGecko",
      key: options.coinGeckoApiKey,
      auth: "x-cg-demo-api-key",
      collection: "market_reference",
      snapshot: true,
      accepts: (r) => r.assetClass === "crypto",
      documentation: "https://docs.coingecko.com/reference/endpoint-overview",
      sample: { instrument: "BTCUSDT", assetClass: "crypto", collection: "market_reference" },
      url: (r) =>
        endpoint(
          `https://api.coingecko.com/api/v3/${path.replace("{id}", encodeURIComponent(coinId(r)))}`,
          path === "coins/markets"
            ? { vs_currency: "usd", ids: coinId(r) }
            : path === "coins/{id}"
              ? {
                  localization: "false",
                  tickers: "false",
                  community_data: "false",
                  developer_data: "false",
                }
              : {},
        ),
      parse: (body, raw) =>
        (Array.isArray(raw)
          ? rows(raw)
          : path === "global" && obj(body.data).total_market_cap
            ? [obj(body.data)]
            : path.endsWith("tickers")
              ? rows(body.tickers)
              : body.id
                ? [body]
                : []
        ).map((data) => ({ data, time: iso(data.last_updated ?? data.timestamp) })),
    });
  }
  return result;
}
