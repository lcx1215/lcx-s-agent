/** Small explicit aliases, not a guessed issuer directory. Unknown tickers stay unverified. */
const names: Readonly<Record<string, readonly string[]>> = {
  AAPL: ["Apple"],
  MSFT: ["Microsoft"],
  NVDA: ["Nvidia"],
  AMZN: ["Amazon"],
  GOOGL: ["Alphabet", "Google"],
  GOOG: ["Alphabet", "Google"],
  META: ["Meta Platforms", "Facebook", "Meta"],
  TSLA: ["Tesla"],
  SPY: ["SPDR S&P 500"],
  QQQ: ["Invesco QQQ"],
  IWM: ["iShares Russell 2000"],
  DIA: ["SPDR Dow Jones"],
  GLD: ["SPDR Gold"],
  TLT: ["iShares 20+ Year Treasury"],
  HYG: ["iShares iBoxx"],
  XLE: ["Energy Select Sector SPDR"],
  XLK: ["Technology Select Sector SPDR"],
  XLF: ["Financial Select Sector SPDR"],
  BTCUSDT: ["Bitcoin", "BTC"],
  ETHUSDT: ["Ethereum", "Ether"],
  SOLUSDT: ["Solana"],
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const contains = (text: string, value: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])`, "iu").test(text);
const financialContext =
  /\bstock\b|\bstocks\b|\bshares?\b|\betfs?\b|\bearnings\b|\binvestors?\b|\bdividends?\b|\byields?\b|\bportfolio\b|股价|股票|基金|收益率|财报/iu;

export function financeNewsQuery(instrument: string): string {
  const symbol = instrument
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/gu, "")
    .slice(0, 32);
  const alias = names[symbol]?.[0];
  return `(${symbol}${alias ? ` OR "${alias}"` : ""}) (stock OR shares OR ETF OR earnings)`;
}

export function assessFinanceNewsEntity(
  instrument: string,
  data: Readonly<Record<string, unknown>>,
) {
  const symbol = instrument.toUpperCase();
  const title =
    typeof data.title === "string"
      ? data.title
      : typeof data.headline === "string"
        ? data.headline
        : "";
  if (
    (symbol === "SPY" &&
      /spy movie|spy thriller|spy on|north korean spy|spy who|espionage|backdoor/iu.test(title)) ||
    (symbol === "GLD" && /gld score|good level of development|early years/iu.test(title)) ||
    (symbol === "AAPL" && /swap on usdt|token price/iu.test(title))
  ) {
    return {
      status: "excluded" as const,
      reason: "ambiguous_symbol_other_entity",
      basis: "headline_only",
    };
  }
  // Provider annotations can establish relevance, but never prove the article's claims.
  if (Array.isArray(data.tickers) && data.tickers.some((ticker) => ticker === symbol)) {
    return {
      status: "matched" as const,
      reason: "provider_ticker_annotation",
      basis: "metadata_only",
    };
  }
  const alias = names[symbol]?.find((name) => contains(title, name));
  const specificCompany = [
    "MSFT",
    "NVDA",
    "GOOGL",
    "GOOG",
    "TSLA",
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
  ].includes(symbol);
  const companyContext =
    /iphone|ipad|macbook|apple watch|airpods|muse|zuckerberg|whatsapp|data cent(er|re)|aws|prime|amazon web services|物流|苹果.*发布/iu.test(
      title,
    );
  if (
    (contains(title, symbol) && financialContext.test(title)) ||
    (alias && (specificCompany || financialContext.test(title) || companyContext))
  ) {
    return { status: "matched" as const, reason: "entity_and_context", basis: "headline_only" };
  }
  return {
    status: "unverified" as const,
    reason: "no_verified_entity_context",
    basis: "headline_only",
  };
}
