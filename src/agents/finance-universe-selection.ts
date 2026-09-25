/**
 * Lets the system choose its own universe instead of inheriting a hand-written ticker list.
 *
 * The selection is deliberately built only from things the system can actually observe:
 *
 *   1. **Candidates** come from the venue's own tradable-asset list, not from a curated file.
 *   2. **Liquidity** comes from the venue's real dollar volume. Most of the venue's list is
 *      dead weight (measured: the median candidate trades ~$0 a day), so this does most of the
 *      work.
 *   3. **Eligibility** comes from the same EOD history the strategy will trade on. A symbol the
 *      data source cannot serve is not a candidate, whatever the venue says.
 *   4. **Diversification** comes from the measured correlation structure, not from labels: the
 *      greedy picks whatever is least related to what is already in.
 *
 * No model call, no curated list, no assumed asset-class labels. Every threshold is a parameter
 * so the choice can be audited rather than discovered.
 */

export const FINANCE_UNIVERSE_SELECTION_SCHEMA = "lcx_finance_universe_selection_v1" as const;
export const FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME =
  "finance-universe-selection-latest.json" as const;
export const FINANCE_UNIVERSE_SELECTION_FRESHNESS_BASIS =
  "latest_completed_weekday_16_00_et_without_holiday_calendar" as const;
export const FINANCE_UNIVERSE_SELECTION_SOURCES = Object.freeze({
  assetListing: "alpaca_active_us_equity_assets",
  liquidityPreScreen: "alpaca_snapshot_latest_completed_daily_bar_close_times_volume",
  finalLiquidityRanking: "china_reachable_us_eod_history_median_daily_dollar_volume",
  eligibilityHistory: "china_reachable_us_eod_history_complete_regular_session_bars",
} as const);

/** Candidate-evaluation ceiling, not a requested or promised final universe size. */
export const DEFAULT_UNIVERSE_SCREEN_SIZE = 120;
export const MAX_UNIVERSE_SCREEN_SIZE = 500;

/** A row of the venue's tradable-asset list, reduced to what selection needs. */
export type UniverseAsset = Readonly<{
  symbol: string;
  name: string;
  exchange: string;
  tradable: boolean;
  status: string;
  fractionable?: boolean;
}>;

/** One completed market session of observable liquidity from the venue. */
export type UniverseQuote = Readonly<{ close?: number; volume?: number; sessionDate?: string }>;

export type UniverseBar = Readonly<{ date: string; close: number; volume?: number }>;

export type UniverseMetrics = Readonly<{
  symbol: string;
  bars: number;
  firstDate: string;
  lastDate: string;
  medianDollarVolume: number;
  annualisedVol: number;
  /**
   * Single-day moves too large to be real for an unleveraged fund. These are data defects
   * (a missed split adjustment, a bad tick), not market events, and they inflate volatility
   * enough to corrupt inverse-volatility sizing.
   */
  outlierCount: number;
  /**
   * Largest calendar gap between consecutive bars. Real listings sit at 4 days (a long
   * weekend); a much larger gap means the source spliced an unrelated earlier security onto
   * this symbol, which is how IBIT passed every other check with years of fabricated history.
   */
  maxGapDays: number;
}>;

export type UniverseThresholds = Readonly<{
  /** Minimum EOD bars. A monthly signal needs 13 month-ends; this leaves room to spare. */
  minBars: number;
  /** Annualised volatility floor: below this the instrument barely moves. */
  minVol: number;
  /** Annualised volatility ceiling: above this it is not a diversifier, it is a risk. */
  maxVol: number;
  /** Median daily dollar volume floor. */
  minMedianDollarVolume: number;
  /** Absolute log return above which a single day is treated as a data defect. */
  maxAbsDailyMove: number;
  /** How many such days disqualify the candidate. */
  maxOutliers: number;
  /** Largest tolerated calendar gap in days. A long weekend is 4; a splice is hundreds. */
  maxGapDays: number;
}>;

export const DEFAULT_UNIVERSE_THRESHOLDS: UniverseThresholds = Object.freeze({
  minBars: 750,
  minVol: 0.03,
  maxVol: 0.6,
  minMedianDollarVolume: 1_000_000,
  // ~50% in a day. Real crash days for unleveraged funds land well below this; the observed
  // defect (a utilities ETF halving) landed at 0.703.
  maxAbsDailyMove: 0.4,
  maxOutliers: 0,
  maxGapDays: 10,
});

const SYMBOL_SHAPE = /^[A-Z]{1,5}(?:\.[A-Z])?$/u;
/**
 * Leveraged, inverse and volatility products are excluded rather than "handled": their daily
 * compounding makes a monthly trend signal meaningless, and a 3x product is not three times the
 * exposure of the underlying over any horizon longer than a day.
 *
 * Inverse is matched by construction ("ProShares Short", "1X Short"), never by a bare `Short` —
 * which would also drop short-duration bond funds that are legitimate holdings.
 */
const PRODUCT_EXCLUDE =
  /2X|3X|1\.5X|-1X|Ultra|Inverse|Leveraged|Bear\b|Bull\b|Volatility|VIX\b|ProShares Short|1X Short|Daily Short|Warrant|Right\b|Unit\b/i;

/**
 * Structural screen. This is intentionally shallow: it removes what is obviously untradeable
 * (non-tradable, OTC, warrant/unit symbols, leveraged products) across venue-listed U.S. equities;
 * it includes both common stocks and funds, then leaves eligibility to measured market data rather
 * than to a hand-picked asset-class/name allowlist.
 */
export function filterUniverseAssets(assets: readonly UniverseAsset[]): readonly UniverseAsset[] {
  return assets.filter((asset) => {
    if (!asset.tradable || asset.status !== "active") {
      return false;
    }
    if (asset.exchange === "OTC") {
      return false;
    }
    if (!SYMBOL_SHAPE.test(asset.symbol)) {
      return false;
    }
    const name = asset.name ?? "";
    if (PRODUCT_EXCLUDE.test(name)) {
      return false;
    }
    return true;
  });
}

/** Ranks by the venue's own dollar volume. Symbols with no usable bar sort last, then drop out. */
export function rankByDollarVolume(
  quotes: Readonly<Record<string, UniverseQuote>>,
): readonly { symbol: string; dollarVolume: number; sessionDate?: string }[] {
  const ranked: { symbol: string; dollarVolume: number; sessionDate?: string }[] = [];
  for (const [symbol, quote] of Object.entries(quotes)) {
    const close = Number(quote?.close);
    const volume = Number(quote?.volume);
    if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(volume) || volume <= 0) {
      continue;
    }
    ranked.push({
      symbol,
      dollarVolume: close * volume,
      ...(typeof quote.sessionDate === "string" ? { sessionDate: quote.sessionDate } : {}),
    });
  }
  return ranked.toSorted((a, b) => b.dollarVolume - a.dollarVolume);
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? Number.NaN;
  }
  const low = sorted[middle - 1] ?? Number.NaN;
  const high = sorted[middle] ?? Number.NaN;
  return (low + high) / 2;
}

export function annualisedVolFromReturns(returns: readonly number[]): number {
  if (returns.length < 30) {
    return Number.NaN;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252);
}

export function annualisedVolFromCloses(closes: readonly number[]): number {
  if (closes.length < 30) {
    return Number.NaN;
  }
  return annualisedVolFromReturns(logReturnSeries(closes));
}

/**
 * Measures a candidate. Volatility is computed with implausible single-day moves removed, so a
 * bad tick cannot masquerade as a volatile instrument; the count is still reported, because a
 * series that contains one says the source is unreliable for that symbol either way.
 */
function maxCalendarGapDays(dates: readonly string[]): number {
  let worst = 0;
  for (let index = 1; index < dates.length; index += 1) {
    const previous = Date.parse(`${dates[index - 1]}T00:00:00Z`);
    const current = Date.parse(`${dates[index]}T00:00:00Z`);
    if (!Number.isFinite(previous) || !Number.isFinite(current)) {
      continue;
    }
    const gap = (current - previous) / 86_400_000;
    if (gap > worst) {
      worst = gap;
    }
  }
  return worst;
}

export function summariseUniverseSeries(
  symbol: string,
  bars: readonly UniverseBar[],
  thresholds: UniverseThresholds = DEFAULT_UNIVERSE_THRESHOLDS,
): UniverseMetrics {
  const ordered = [...bars].toSorted((a, b) => a.date.localeCompare(b.date));
  const dollarVolumes = ordered
    .map((bar) => (bar.volume === undefined ? Number.NaN : bar.close * bar.volume))
    .filter((value) => Number.isFinite(value));
  const returns = logReturnSeries(ordered.map((bar) => bar.close));
  const clean = returns.filter((value) => Math.abs(value) <= thresholds.maxAbsDailyMove);
  return {
    symbol,
    bars: ordered.length,
    firstDate: ordered.at(0)?.date ?? "",
    lastDate: ordered.at(-1)?.date ?? "",
    medianDollarVolume: median(dollarVolumes),
    annualisedVol: annualisedVolFromReturns(clean),
    outlierCount: returns.length - clean.length,
    maxGapDays: maxCalendarGapDays(ordered.map((bar) => bar.date)),
  };
}

/** Why a measured candidate did not make it. Empty means eligible. */
export function universeRejectionReason(
  metrics: UniverseMetrics,
  thresholds: UniverseThresholds = DEFAULT_UNIVERSE_THRESHOLDS,
): string {
  if (metrics.bars < thresholds.minBars) {
    return `history too short (${metrics.bars} bars < ${thresholds.minBars})`;
  }
  // Data quality first: a series that contains an impossible move is not measurable, and
  // sizing from it would be sizing from an error.
  if (metrics.outlierCount > thresholds.maxOutliers) {
    return `implausible daily moves (${metrics.outlierCount} > ${thresholds.maxOutliers}); source unreliable for this symbol`;
  }
  // A gap this wide is not a holiday: the source has spliced something else onto this symbol,
  // so its history, volatility and correlations are all partly fabricated.
  if (metrics.maxGapDays > thresholds.maxGapDays) {
    return `history has a ${metrics.maxGapDays}-day gap (max ${thresholds.maxGapDays}); series is spliced, not continuous`;
  }
  if (!Number.isFinite(metrics.annualisedVol)) {
    return "volatility not computable";
  }
  if (metrics.annualisedVol < thresholds.minVol) {
    return `volatility too low (${metrics.annualisedVol.toFixed(3)})`;
  }
  if (metrics.annualisedVol > thresholds.maxVol) {
    return `volatility too high (${metrics.annualisedVol.toFixed(3)})`;
  }
  if (!Number.isFinite(metrics.medianDollarVolume)) {
    return "liquidity not computable";
  }
  if (metrics.medianDollarVolume < thresholds.minMedianDollarVolume) {
    return `too illiquid (median $${Math.round(metrics.medianDollarVolume)} < $${thresholds.minMedianDollarVolume})`;
  }
  return "";
}

/** Pearson correlation of two daily-log-return series aligned by index. */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  if (length < 30) {
    return Number.NaN;
  }
  const x = a.slice(a.length - length);
  const y = b.slice(b.length - length);
  const meanX = x.reduce((sum, value) => sum + value, 0) / length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let index = 0; index < length; index += 1) {
    const vx = (x[index] ?? 0) - meanX;
    const vy = (y[index] ?? 0) - meanY;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  if (dx === 0 || dy === 0) {
    return Number.NaN;
  }
  const value = num / Math.sqrt(dx * dy);
  return Math.min(1, Math.max(-1, value));
}

export function logReturnSeries(closes: readonly number[]): readonly number[] {
  const out: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const previous = closes[index - 1];
    const current = closes[index];
    if (!previous || !current) {
      continue;
    }
    out.push(Math.log(current / previous));
  }
  return out;
}

/**
 * Greedy maximum-diversification pick: start from the most liquid eligible candidate, then
 * repeatedly add the candidate whose worst correlation to anything already chosen is lowest.
 *
 * `maxCorrelation` caps how related a new member may be to the set; when nothing fits, the set
 * is returned shorter rather than padded with a near-duplicate. There is no fixed final member
 * count: selection stops when no eligible candidate remains, or an explicit resource ceiling is
 * reached. The venue screen is applied before this function and is not a target universe size.
 */
export type UniverseSelectionEvidence = Readonly<{
  selected: readonly string[];
  selectedEvidence: readonly Readonly<{
    symbol: string;
    rank: number;
    reason: "highest_liquidity_eligible_seed" | "lowest_correlation_to_selected";
    maxCorrelationToPriorMembers?: number;
  }>[];
  exclusions: readonly Readonly<{
    symbol: string;
    reason:
      | "insufficient_return_history"
      | "correlation_unavailable"
      | "max_correlation_exceeded"
      | "resource_ceiling_reached"
      | "incoherent_selection_config";
    maxCorrelationToSelected?: number;
  }>[];
}>;

export function selectDiversifiedUniverseWithEvidence(
  candidates: readonly { symbol: string; returns: readonly number[] }[],
  options: { maxMembers?: number; maxCorrelation?: number } = {},
): UniverseSelectionEvidence {
  const maxCorrelation = options.maxCorrelation ?? 0.95;

  // `maxCorrelation` outside [-1, 1] (or NaN) silently removed the diversification constraint this
  // function exists to apply. Measured with 7 near-duplicates of one series among 8 candidates: the
  // default 0.95 returned 2 symbols, while `maxCorrelation: 5` and `Number.NaN` both returned all 8
  // -- the set was padded with exactly the near-duplicates the cap is there to exclude. An
  // incoherent configuration selects nothing instead of padding, which is the same outcome this
  // module already documents for "nothing fits".
  const configCoherent =
    (options.maxMembers === undefined ||
      (Number.isSafeInteger(options.maxMembers) && options.maxMembers >= 1)) &&
    Number.isFinite(maxCorrelation) &&
    maxCorrelation >= -1 &&
    maxCorrelation <= 1;
  if (!configCoherent) {
    return {
      selected: [],
      selectedEvidence: [],
      exclusions: candidates.map(({ symbol }) => ({
        symbol,
        reason: "incoherent_selection_config",
      })),
    };
  }

  const exclusions: Array<UniverseSelectionEvidence["exclusions"][number]> = candidates
    .filter((entry) => entry.returns.length < 30)
    .map(({ symbol }) => ({ symbol, reason: "insufficient_return_history" }));
  const pool = candidates.filter((entry) => entry.returns.length >= 30);
  if (pool.length === 0) {
    return { selected: [], selectedEvidence: [], exclusions };
  }
  const chosen: { symbol: string; returns: readonly number[] }[] = [pool[0]];
  const selectedEvidence: Array<UniverseSelectionEvidence["selectedEvidence"][number]> = [
    { symbol: pool[0].symbol, rank: 1, reason: "highest_liquidity_eligible_seed" },
  ];
  const remaining = pool.slice(1);

  while (
    (options.maxMembers === undefined || chosen.length < options.maxMembers) &&
    remaining.length > 0
  ) {
    let bestIndex = -1;
    let bestWorst = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      let worst = Number.NEGATIVE_INFINITY;
      let usable = true;
      for (const member of chosen) {
        const value = correlation(candidate.returns, member.returns);
        if (!Number.isFinite(value)) {
          usable = false;
          break;
        }
        worst = Math.max(worst, value);
      }
      if (!usable) {
        continue;
      }
      if (worst < bestWorst) {
        bestWorst = worst;
        bestIndex = index;
      }
    }
    if (bestIndex < 0 || bestWorst > maxCorrelation) {
      for (const candidate of remaining) {
        const values = chosen.map((member) => correlation(candidate.returns, member.returns));
        if (values.some((value) => !Number.isFinite(value))) {
          exclusions.push({ symbol: candidate.symbol, reason: "correlation_unavailable" });
          continue;
        }
        const worst = Math.max(...values);
        exclusions.push({
          symbol: candidate.symbol,
          reason: worst > maxCorrelation ? "max_correlation_exceeded" : "correlation_unavailable",
          maxCorrelationToSelected: worst,
        });
      }
      break;
    }
    const selected = remaining[bestIndex];
    chosen.push(selected);
    selectedEvidence.push({
      symbol: selected.symbol,
      rank: chosen.length,
      reason: "lowest_correlation_to_selected",
      maxCorrelationToPriorMembers: bestWorst,
    });
    remaining.splice(bestIndex, 1);
  }
  if (
    remaining.length > 0 &&
    options.maxMembers !== undefined &&
    chosen.length >= options.maxMembers
  ) {
    exclusions.push(
      ...remaining.map(({ symbol }) => ({ symbol, reason: "resource_ceiling_reached" as const })),
    );
  }
  return {
    selected: chosen.map((entry) => entry.symbol),
    selectedEvidence,
    exclusions,
  };
}

export function selectDiversifiedUniverse(
  candidates: readonly { symbol: string; returns: readonly number[] }[],
  options: { maxMembers?: number; maxCorrelation?: number } = {},
): readonly string[] {
  return selectDiversifiedUniverseWithEvidence(candidates, options).selected;
}
