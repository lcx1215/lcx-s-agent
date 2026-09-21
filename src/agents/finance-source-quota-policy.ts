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
  // FMP Basic is documented as a *per day* allowance ("250 Calls / Day"), not a rolling
  // 24-hour one. Modelling it as rolling cost a full extra day of silence: 195 calls made
  // between 13:00Z and 15:00Z held the local budget at 250/250 for ~24h after the server had
  // already rolled over, while a direct call to /stable/historical-price-eod/full still
  // returned HTTP 200 with real bars. The boundary is the vendor's and is not observable from
  // here (FMP sends no rate-limit headers), so UTC midnight is the documented reading. If that
  // reading is wrong the response body says "daily limit" and `classifyFinanceQuotaBody`
  // converts it into a bounded cooldown -- an honest, attributable refusal instead of a silent
  // day-long blackout that presents downstream as "this source has no opinion".
  policy(
    "fmp",
    ["financialmodelingprep.com"],
    [{ limit: 250, durationMs: day, alignment: "utc_day" }],
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

/**
 * Quota is scarce per provider *per day*, and one greedy consumer can silently starve the
 * others: a single diagnostics sweep took 195 of FMP's 250 calls in two hours, after which the
 * production sampling that feeds the decision loop got `budget_exhausted` for the rest of the
 * day and presented downstream as "this source has no opinion". A single shared counter cannot
 * answer "who spent it", and an answer of "nobody knows" is not an allocation.
 *
 * Every call therefore carries the purpose it serves, and the day budget is split by purpose.
 * Protection only binds under real contention -- see `financeLaneAllowance`.
 */
export const FINANCE_QUOTA_LANES = ["production", "calibration", "diagnostics"] as const;
export type FinanceQuotaLane = (typeof FINANCE_QUOTA_LANES)[number];

/** Calls that never declare a purpose are production: that is what the loop runs on. */
export const FINANCE_QUOTA_DEFAULT_LANE: FinanceQuotaLane = "production";

/**
 * Fraction of a provider's day budget protected for each lane. The remainder is a shared
 * reserve any lane may draw from once its own share is spent.
 */
export const FINANCE_QUOTA_LANE_SHARES: Readonly<Record<FinanceQuotaLane, number>> = Object.freeze({
  production: 0.5,
  calibration: 0.2,
  diagnostics: 0.1,
});

export function isFinanceQuotaLane(value: unknown): value is FinanceQuotaLane {
  return typeof value === "string" && (FINANCE_QUOTA_LANES as readonly string[]).includes(value);
}

/** The window that actually makes a provider scarce. Minute-scale windows pace, they do not run out. */
export function financeQuotaDayWindow(policy: FinanceQuotaPolicy): FinanceQuotaWindow | undefined {
  return policy.windows.find((window) => window.durationMs >= 86_400_000);
}

export function financeQuotaReserveShare(): number {
  const claimed = FINANCE_QUOTA_LANES.reduce(
    (sum, lane) => sum + FINANCE_QUOTA_LANE_SHARES[lane],
    0,
  );
  return Math.max(0, 1 - claimed);
}

export type FinanceLaneAllowance = Readonly<{
  /** Calls this lane can make before it has to borrow from the shared reserve. */
  own: number;
  /** Additional calls any lane may draw once its own share is spent. */
  reserve: number;
  /**
   * True when no other lane has spent anything in the window. Protecting shares against lanes
   * that are not running would waste the budget, so the lane cap is lifted entirely and only
   * the provider's own limit binds.
   */
  uncontended: boolean;
}>;

/**
 * Split a provider's day budget for one lane.
 *
 * `usedByLane` is the whole window's spend keyed by lane. A lane gets its own share plus the
 * shared reserve, and -- when it is the only lane that has spent anything -- the entire
 * remaining provider budget, because holding 50% idle "just in case" is how a scarce free tier
 * gets wasted.
 */
export function financeLaneAllowance(params: {
  dayLimit: number;
  lane: FinanceQuotaLane;
  usedByLane: Readonly<Record<string, number>>;
}): FinanceLaneAllowance {
  const own = Math.floor(params.dayLimit * FINANCE_QUOTA_LANE_SHARES[params.lane]);
  const reserve = Math.floor(params.dayLimit * financeQuotaReserveShare());
  const others = FINANCE_QUOTA_LANES.filter((lane) => lane !== params.lane);
  const uncontended = others.every((lane) => (params.usedByLane[lane] ?? 0) === 0);
  return Object.freeze({ own, reserve, uncontended });
}

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
