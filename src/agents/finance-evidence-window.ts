/**
 * How far back evidence is allowed to come from, and how fast it goes stale.
 *
 * The bug this exists to fix: news sentiment was read as "the latest N
 * articles". N is not a time window. On a heavily covered name fifty articles
 * might span two days; on a quiet one the same fifty might span six months, and
 * six-month-old sentiment was being used to judge the next thirty days. The same
 * parameter silently meant different things on different instruments.
 *
 * So evidence is windowed in days, not in counts, and:
 *
 * 1. **The window follows the horizon.** Judging thirty days ahead from two
 *    years of history drags in a regime that no longer applies; judging it from
 *    three days is noise. Lookback is a multiple of the horizon.
 * 2. **Different instruments decay at different rates.** A single stock is
 *    event-driven and its news goes stale in days; an index is macro-driven and
 *    its narrative persists; crypto is faster than both. One window for
 *    everything is wrong in both directions at once.
 * 3. **Recency is weighted, not flat.** An article from a week ago should not
 *    count the same as one from an hour ago, so weight halves every half-life.
 * 4. **Too little evidence is silence.** A handful of articles inside the window
 *    is not a reading, and it must not be inflated into one.
 */

export const FINANCE_ASSET_TYPES = ["equity", "index", "crypto"] as const;
export type FinanceAssetType = (typeof FINANCE_ASSET_TYPES)[number];

export type EvidenceWindowPolicy = Readonly<{
  /** How far ahead the judgement is meant to hold. */
  horizonDays: number;
  /** Oldest evidence admitted. */
  lookbackDays: number;
  /** Article weight halves over this many days. */
  newsHalfLifeDays: number;
  /** Minimum articles inside the window before sentiment says anything. */
  minNewsArticles: number;
}>;

const LOOKBACK_MULTIPLIER: Record<FinanceAssetType, number> = {
  equity: 4,
  index: 8,
  crypto: 2,
};

const NEWS_HALF_LIFE_DAYS: Record<FinanceAssetType, number> = {
  equity: 7,
  index: 14,
  crypto: 2,
};

export const DEFAULT_MIN_NEWS_ARTICLES = 5;

export function defaultEvidenceWindow(params: {
  horizonDays: number;
  assetType?: FinanceAssetType;
  minNewsArticles?: number;
}): EvidenceWindowPolicy {
  const assetType = params.assetType ?? "equity";
  const horizonDays = Math.max(1, Math.round(params.horizonDays));
  return {
    horizonDays,
    lookbackDays: Math.round(horizonDays * LOOKBACK_MULTIPLIER[assetType]),
    newsHalfLifeDays: NEWS_HALF_LIFE_DAYS[assetType],
    minNewsArticles: params.minNewsArticles ?? DEFAULT_MIN_NEWS_ARTICLES,
  };
}

export type NewsItem = Readonly<{
  /** Age in days at the time of the judgement. Negative or NaN is rejected. */
  ageDays: number;
  /** Sentiment score, expected in roughly -1..1. */
  score: number;
}>;

export type NewsCohortSummary = Readonly<{
  usable: boolean;
  /** Recency-weighted mean score, or null when the cohort is unusable. */
  weightedMean: number | null;
  /** Articles actually used. */
  used: number;
  /** Span between the oldest and newest article used, in days. */
  spanDays: number;
  refusals: readonly string[];
}>;

export function summarizeNewsCohort(
  items: readonly NewsItem[],
  policy: EvidenceWindowPolicy,
): NewsCohortSummary {
  const refusals: string[] = [];
  const inWindow = items.filter(
    (item) =>
      Number.isFinite(item.ageDays) && item.ageDays >= 0 && item.ageDays <= policy.lookbackDays,
  );

  if (inWindow.length === 0) {
    return {
      usable: false,
      weightedMean: null,
      used: 0,
      spanDays: 0,
      refusals: [`no article is inside the ${policy.lookbackDays}-day window`],
    };
  }

  const ages = inWindow.map((item) => item.ageDays);
  const spanDays = Math.max(...ages) - Math.min(...ages);

  if (inWindow.length < policy.minNewsArticles) {
    refusals.push(
      `${inWindow.length} article(s) inside the ${policy.lookbackDays}-day window, ` +
        `${policy.minNewsArticles} required; a thin cohort is not a reading`,
    );
    return { usable: false, weightedMean: null, used: inWindow.length, spanDays, refusals };
  }

  let weightSum = 0;
  let weightedSum = 0;
  for (const item of inWindow) {
    const weight = Math.pow(0.5, item.ageDays / policy.newsHalfLifeDays);
    weightSum += weight;
    weightedSum += weight * item.score;
  }

  if (weightSum <= 0) {
    return {
      usable: false,
      weightedMean: null,
      used: inWindow.length,
      spanDays,
      refusals: ["every article in the window is too old to carry weight"],
    };
  }

  return {
    usable: true,
    weightedMean: weightedSum / weightSum,
    used: inWindow.length,
    spanDays,
    refusals,
  };
}

/**
 * Parse Alpha Vantage's `time_published` ("20240415T153000") into an age in days.
 * Returns null for anything unparseable rather than defaulting to "fresh",
 * because defaulting to fresh is how stale news gets counted.
 */
export function parseAvPublishedAgeDays(value: unknown, asOfMs: number): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/u);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(ms)) {
    return null;
  }
  return (asOfMs - ms) / 86_400_000;
}
