import { ApiCallError } from "./api-call-contract.js";
import { resolveFinanceFetch } from "./finance-live-market-source.js";
import type {
  FinanceMarketCollectionAdapter,
  FinanceMarketCollectionRequest,
  FinanceMarketCollectionRegistryOptions,
} from "./finance-market-collection-registry.js";

type Row = Record<string, unknown>;
function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(object) : [];
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
type Capability = {
  id: string;
  provider: string;
  key: string | undefined;
  collection: FinanceMarketCollectionRequest["collection"];
  crypto?: boolean;
  url: (request: FinanceMarketCollectionRequest) => URL;
  auth: string;
  parse: (body: Row, raw: unknown) => { data: Row; time?: string }[];
};
const url = (base: string, params: Record<string, string> = {}) => {
  const result = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    result.searchParams.set(key, value);
  }
  return result;
};

/** One endpoint per adapter keeps entitlement failures and HTTP budgets independent. */
export function createRegisteredCapabilityAdapters(
  options: FinanceMarketCollectionRegistryOptions,
): FinanceMarketCollectionAdapter[] {
  const capabilities: Capability[] = [];
  for (const fn of ["OVERVIEW", "INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"] as const) {
    capabilities.push({
      id: `alpha_vantage_${fn.toLowerCase()}`,
      provider: "Alpha Vantage",
      key: options.alphaVantageApiKey,
      collection: fn === "OVERVIEW" ? "company_profile" : "financial_statements",
      auth: "apikey",
      url: (r) => url("https://www.alphavantage.co/query", { function: fn, symbol: r.instrument }),
      parse: (body) =>
        fn === "OVERVIEW"
          ? body.Symbol
            ? [{ data: body }]
            : []
          : rows(body.annualReports).map((data) => ({
              data: {
                ...data,
                statementType: fn,
                periodType: "annual",
                publicationTimeUnknown: true,
              },
              time: timestamp(data.fiscalDateEnding),
            })),
    });
  }
  capabilities.push({
    id: "alpha_vantage_daily_history",
    provider: "Alpha Vantage",
    key: options.alphaVantageApiKey,
    collection: "eod_history",
    auth: "apikey",
    url: (r) =>
      url("https://www.alphavantage.co/query", {
        function: "TIME_SERIES_DAILY",
        symbol: r.instrument,
        outputsize: "compact",
      }),
    parse: (body) =>
      Object.entries(object(body["Time Series (Daily)"])).map(([date, value]) => ({
        time: timestamp(date),
        data: {
          ...object(value),
          close: Number(object(value)["4. close"]),
          volume: Number(object(value)["5. volume"]),
          date,
          adjusted: false,
          coverageLimit: "latest_100_sessions",
        },
      })),
  });
  for (const endpoint of ["profile2", "metric", "earnings"] as const) {
    capabilities.push({
      id: `finnhub_${endpoint}`,
      provider: "Finnhub",
      key: options.finnhubApiKey,
      collection: endpoint === "earnings" ? "earnings" : "company_profile",
      auth: "X-Finnhub-Token",
      url: (r) =>
        url(`https://finnhub.io/api/v1/stock/${endpoint}`, {
          symbol: r.instrument,
          ...(endpoint === "metric" ? { metric: "all" } : {}),
        }),
      parse: (body, raw) =>
        endpoint === "earnings"
          ? rows(raw).map((data) => ({
              data: { ...data, publicationTimeUnknown: true },
              time: timestamp(data.period),
            }))
          : endpoint === "metric"
            ? Object.keys(object(body.metric)).length
              ? [{ data: body }]
              : []
            : body.ticker
              ? [{ data: body }]
              : [],
    });
  }
  capabilities.push({
    id: "massive_daily_history",
    provider: "Massive",
    key: options.massiveApiKey,
    collection: "eod_history",
    auth: "Authorization",
    url: (r) =>
      url(
        `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(r.instrument)}/range/1/day/${r.fromDate ?? new Date(Date.parse(r.asOf) - 90 * 86400000).toISOString().slice(0, 10)}/${r.toDate ?? r.asOf.slice(0, 10)}`,
        { adjusted: "true", sort: "desc", limit: "50000" },
      ),
    parse: (body) =>
      rows(body.results).map((data) => ({
        data: { ...data, close: data.c, volume: data.v, adjusted: true },
        time: timestamp(data.t),
      })),
  });
  capabilities.push({
    id: "coingecko_daily_history",
    provider: "CoinGecko",
    key: options.coinGeckoApiKey,
    collection: "eod_history",
    crypto: true,
    auth: "x-cg-demo-api-key",
    url: (r) => {
      const coin = r.instrument.toLowerCase();
      const id =
        (
          { btc: "bitcoin", btcusdt: "bitcoin", eth: "ethereum", ethusdt: "ethereum" } as Record<
            string,
            string
          >
        )[coin] ?? coin;
      return url(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart`, {
        vs_currency: "usd",
        days: "365",
        interval: "daily",
      });
    },
    parse: (body) =>
      (Array.isArray(body.prices) ? body.prices : []).flatMap((entry: unknown) => {
        if (!Array.isArray(entry) || typeof entry[1] !== "number") {
          return [];
        }
        return [
          {
            time: timestamp(entry[0]),
            data: {
              price: entry[1],
              currency: "USD",
              fieldDefinition: "daily snapshot price; not exchange OHLC close",
              coverageLimit: "latest_365_days",
            },
          },
        ];
      }),
  });
  return capabilities
    .filter((c) => c.key?.trim())
    .map((c) => ({
      id: c.id,
      providerName: c.provider,
      providerRole: "cross_check_market_data",
      priority: 65,
      supports: (r) =>
        r.collection === c.collection &&
        (c.crypto
          ? r.assetClass === "crypto"
          : ["us_equity", "stock", "equity", "common_stock"].includes(r.assetClass)),
      collect: async (r, signal) => {
        const endpoint = c.url(r);
        const sourceUrlOrArtifact = endpoint.toString();
        const headers: Record<string, string> = {};
        if (c.auth === "apikey") {
          endpoint.searchParams.set(c.auth, c.key!.trim());
        } else {
          headers[c.auth] = c.auth === "Authorization" ? `Bearer ${c.key!.trim()}` : c.key!.trim();
        }
        let response;
        try {
          response = await resolveFinanceFetch(options.fetchImpl, { signal })(endpoint.toString(), {
            headers,
          });
        } catch (error) {
          if (error instanceof ApiCallError) {
            throw error;
          }
          throw new ApiCallError("network_error");
        }
        if (!response.ok) {
          throw new ApiCallError(
            response.status === 403
              ? "forbidden"
              : response.status === 429
                ? "rate_limited"
                : "http_error",
            response.status,
          );
        }
        let raw: unknown;
        try {
          raw = JSON.parse(await response.text()) as unknown;
        } catch {
          throw new Error(`${c.id}: invalid JSON`);
        }
        const body = object(raw);
        if (
          body.Note ||
          body.Information ||
          body["Error Message"] ||
          body.error ||
          body.status === "ERROR"
        ) {
          throw new Error(`${c.id}: provider rejected request (quota, entitlement or parameters)`);
        }
        const parsed = c
          .parse(body, raw)
          .filter((row) => {
            if (!row.time) {
              return c.collection === "company_profile";
            }
            if (c.collection === "eod_history") {
              const price = row.data.close ?? row.data.price;
              if (
                typeof price !== "number" ||
                !Number.isFinite(price) ||
                price <= 0 ||
                row.time.slice(0, 10) >= r.asOf.slice(0, 10)
              ) {
                return false;
              }
            }
            const date = row.time.slice(0, 10);
            return (
              Date.parse(row.time) <= Date.parse(r.asOf) &&
              (!r.fromDate || date >= r.fromDate) &&
              (!r.toDate || date <= r.toDate)
            );
          })
          .toSorted((a, b) => (b.time ?? "").localeCompare(a.time ?? ""))
          .slice(0, r.limit ?? 20);
        if (!parsed.length) {
          throw new Error(`${c.id}: no usable records in requested window`);
        }
        return parsed.map((row, index) => ({
          itemId: `${c.id}:${r.instrument}:${row.time ?? r.asOf}:${index}`,
          collection: r.collection,
          providerName: c.provider,
          providerRole: "cross_check_market_data",
          sourceFamily: c.collection === "eod_history" ? "market_data_api" : "fundamentals_api",
          sourceTimestamp: row.time ?? r.asOf,
          observedAt: r.asOf,
          delayStatus: "manual_or_unknown",
          sourceUrlOrArtifact,
          data: {
            ...row.data,
            sourceTimestampMeaning: row.time
              ? "observation_or_fiscal_period_not_publication"
              : "retrieved_snapshot_provider_timestamp_unavailable",
          },
        }));
      },
    }));
}
