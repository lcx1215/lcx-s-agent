export type FinanceQuotaWindow = Readonly<{
  limit: number;
  durationMs: number;
  alignment?: "utc_day";
}>;
export type FinanceQuotaPolicy = Readonly<{
  id: string;
  provider: string;
  hosts: readonly string[];
  windows: readonly FinanceQuotaWindow[];
  minIntervalMs: number;
  basis: "observed_and_documented" | "documented" | "conservative_unknown";
  documentation?: string;
  tokenBucket?: { capacity: number; refillPerSecond: number };
}>;
const minute = 60_000;
const day = 24 * 60 * minute;
const policy = (
  id: string,
  hosts: string[],
  windows: FinanceQuotaWindow[],
  minIntervalMs: number,
  basis: FinanceQuotaPolicy["basis"],
  documentation?: string,
): FinanceQuotaPolicy => ({
  id,
  provider: id,
  hosts,
  windows,
  minIntervalMs,
  basis,
  documentation,
});

/** Limits are shared across all routes in a provider group, never multiplied by route count. */
export const FINANCE_SOURCE_QUOTA_POLICIES: readonly FinanceQuotaPolicy[] = [
  policy(
    "fmp",
    ["financialmodelingprep.com"],
    [{ limit: 250, durationMs: day }],
    1_001,
    "observed_and_documented",
    "https://site.financialmodelingprep.com/developer/docs/pricing",
  ),
  policy(
    "binance",
    ["api.binance.com", "data-api.binance.vision"],
    [{ limit: 6000, durationMs: minute }],
    21,
    "documented",
    "https://developers.binance.com/en/docs/products/spot/rest-api",
  ),

  policy(
    "massive",
    ["api.massive.com"],
    [{ limit: 5, durationMs: minute }],
    12_001,
    "observed_and_documented",
    "https://massive.com/stocks",
  ),
  policy(
    "twelve_data",
    ["api.twelvedata.com"],
    [
      { limit: 8, durationMs: minute },
      { limit: 800, durationMs: day, alignment: "utc_day" },
    ],
    7_501,
    "observed_and_documented",
    "https://support.twelvedata.com/en/articles/5615854-credits",
  ),
  policy(
    "finnhub",
    ["finnhub.io"],
    [{ limit: 60, durationMs: minute }],
    1_001,
    "observed_and_documented",
    "https://finnhub.io/docs/api",
  ),
  {
    ...policy(
      "alpaca",
      ["data.alpaca.markets"],
      [],
      301,
      "observed_and_documented",
      "https://docs.alpaca.markets/us/docs/about-market-data-api",
    ),
    tokenBucket: { capacity: 200, refillPerSecond: 200 / 60 },
  },
  policy(
    "alpha_vantage",
    ["www.alphavantage.co"],
    [{ limit: 25, durationMs: day }],
    1_001,
    "observed_and_documented",
    "https://www.alphavantage.co/support/",
  ),
  policy(
    "fred",
    ["api.stlouisfed.org"],
    [{ limit: 120, durationMs: minute }],
    501,
    "observed_and_documented",
    "https://fred.stlouisfed.org/docs/api/fred/errors.html",
  ),
  policy(
    "bls",
    ["api.bls.gov"],
    [{ limit: 25, durationMs: day }],
    1_001,
    "documented",
    "https://www.bls.gov/developers/api_faqs.htm",
  ),
  policy(
    "sec",
    ["data.sec.gov", "www.sec.gov", "efts.sec.gov"],
    [{ limit: 10, durationMs: 1_000 }],
    101,
    "documented",
    "https://www.sec.gov/about/developer-resources",
  ),
  policy(
    "kraken",
    ["api.kraken.com"],
    [{ limit: 1, durationMs: 1_000 }],
    1_001,
    "documented",
    "https://support.kraken.com/articles/206548367-what-are-the-api-rate-limits-",
  ),
  policy(
    "coinbase",
    ["api.exchange.coinbase.com"],
    [{ limit: 10, durationMs: 1_000 }],
    101,
    "documented",
    "https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits",
  ),
  policy(
    "okx",
    ["www.okx.com", "okx.com"],
    [{ limit: 20, durationMs: 2_000 }],
    101,
    "documented",
    "https://app.okx.com/docs-v5/en",
  ),
  policy(
    "bybit",
    ["api.bybit.com"],
    [{ limit: 600, durationMs: 5_000 }],
    11,
    "documented",
    "https://bybit-exchange.github.io/docs/v5/rate-limit",
  ),
  policy(
    "bitstamp",
    ["www.bitstamp.net", "bitstamp.net"],
    [
      { limit: 400, durationMs: 1_000 },
      { limit: 10_000, durationMs: 10 * minute },
    ],
    61,
    "documented",
    "https://www.bitstamp.net/api/",
  ),
  // These sources do not have a verified account/IP ceiling. Pacing is a local policy, not a claimed entitlement.
  ...(
    [
      [
        "yahoo",
        ["query1.finance.yahoo.com", "query2.finance.yahoo.com", "feeds.finance.yahoo.com"],
      ],
      ["coingecko", ["api.coingecko.com"]],
      ["coincap", ["rest.coincap.io", "api.coincap.io"]],
      ["nasdaq", ["api.nasdaq.com"]],
      ["stooq", ["stooq.com"]],
      ["invesco", ["dng-api.invesco.com"]],
      ["treasury", ["api.fiscaldata.treasury.gov"]],
      ["google_news", ["news.google.com"]],
    ] as const
  ).map(([id, hosts]) => policy(id, [...hosts], [], 1_001, "conservative_unknown")),
  {
    ...policy("fred_public", ["fred.stlouisfed.org"], [], 1_001, "conservative_unknown"),
    provider: "fred",
  },
  {
    ...policy("gdelt_doc", ["api.gdeltproject.org"], [], 5_001, "conservative_unknown"),
    provider: "gdelt",
  },
  {
    ...policy("gdelt_titles", ["data.gdeltproject.org"], [], 1_001, "conservative_unknown"),
    provider: "gdelt",
  },
];

export type FinanceQuotaBodyLimit = "daily" | "monthly" | "rate";
/** Only error-envelope fields are inspected; news text and numeric data cannot trigger this gate. */
export function classifyFinanceQuotaBody(body: string): FinanceQuotaBodyLimit | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const parsed = value as Record<string, unknown>;
  const text = JSON.stringify([
    parsed.Information,
    parsed["Error Message"],
    parsed.Note,
    parsed.error,
    parsed.message,
    parsed.msg,
    parsed.retMsg,
  ]);
  const code = parsed.code ?? parsed.retCode ?? parsed.response_code;
  const limited =
    ["50011", "10006", "-1003", "400.002"].includes(String(code)) ||
    /(?:rate.?limit|limit (?:reach|exceed)|too many requests|requests too frequent|call frequency|api (?:call|request|credit).{0,50}(?:limit|exceed)|daily (?:limit|quota)|maximum number of daily requests|daily.{0,60}(?:threshold|exceed)|threshold.{0,80}(?:daily|reach|exceed))/iu.test(
      text,
    );
  if (!limited) {
    return undefined;
  }
  return /month/iu.test(text)
    ? "monthly"
    : /(?:daily|per day|a day)/iu.test(text)
      ? "daily"
      : "rate";
}
