/**
 * Real chart structure from a price series, and the signal it supports.
 *
 * The earlier signal was price versus its own mean, which is not structure: it
 * cannot tell a trend from a range and it reacts to noise. This computes the
 * things a chart actually shows - where fast and slow averages sit, how far
 * price has travelled over the lookback, and how volatile the path was.
 *
 * Two deliberate choices:
 *
 * 1. **Volatility lowers confidence rather than raising it.** A trend in a calm
 *    series is more trustworthy than the same slope in a violent one, because
 *    the violent one is more likely to be noise that will reverse. This is the
 *    same instinct behind volatility targeting, applied to how much a signal is
 *    believed.
 * 2. **No structure is silence, not a weak vote.** When the averages do not
 *    agree with the move, the result is `hold`, which the fusion layer treats as
 *    no opinion at all. A market with no readable structure should not produce a
 *    signal, and manufacturing a weak one just to have an opinion is how a
 *    system ends up trading noise.
 */

import type { FinanceSignal } from "./finance-signal-fusion.js";

export type FinanceChartStructure = Readonly<{
  fastAverage: number;
  slowAverage: number;
  lastPrice: number;
  /** Percentage move across the lookback window. */
  momentumPct: number;
  /** Annualised realised volatility as a fraction (0.3 = 30%). */
  realizedVolFraction: number;
  /** `up` when the fast average is above the slow one, `down` when below. */
  trend: "up" | "down" | "flat";
}>;

const TRADING_DAYS = 252;

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Returns null when there is not enough history to describe structure.
 * Refusing is better than computing a slow average from three points and
 * calling it a trend.
 */
export function computeChartStructure(
  closes: readonly number[],
  options: { fastWindow?: number; slowWindow?: number } = {},
): FinanceChartStructure | null {
  const fastWindow = options.fastWindow ?? 20;
  const slowWindow = options.slowWindow ?? 50;
  const series = closes.filter((value) => Number.isFinite(value) && value > 0);
  if (series.length < slowWindow + 1) {
    return null;
  }
  const lastPrice = series[series.length - 1];
  const fastAverage = mean(series.slice(-fastWindow));
  const slowAverage = mean(series.slice(-slowWindow));

  // Momentum across the slow window, so it matches the structure being judged.
  const past = series[series.length - 1 - slowWindow];
  const momentumPct = past > 0 ? (lastPrice - past) / past : 0;

  // Realised volatility from daily log returns over the slow window.
  const returns: number[] = [];
  for (let index = series.length - slowWindow; index < series.length; index += 1) {
    const previous = series[index - 1];
    const current = series[index];
    if (previous > 0 && current > 0) {
      returns.push(Math.log(current / previous));
    }
  }
  const variance =
    returns.length > 1
      ? returns.reduce((sum, value) => sum + (value - mean(returns)) ** 2, 0) / (returns.length - 1)
      : 0;
  const realizedVolFraction = Math.sqrt(variance * TRADING_DAYS);

  const trend: FinanceChartStructure["trend"] =
    fastAverage > slowAverage ? "up" : fastAverage < slowAverage ? "down" : "flat";

  return { fastAverage, slowAverage, lastPrice, momentumPct, realizedVolFraction, trend };
}

export type ChartSignalOptions = Readonly<{
  sourceId: string;
  observedAt: string;
  ref?: string;
  /** Base confidence before the volatility haircut. Default 0.6. */
  baseConfidence?: number;
  /** Realised volatility at which confidence is halved. Default 0.4 (40%). */
  volatilityHalfLifeFraction?: number;
}>;

export function chartStructureSignal(
  structure: FinanceChartStructure,
  options: ChartSignalOptions,
): FinanceSignal {
  const baseConfidence = options.baseConfidence ?? 0.6;
  const halfLife = options.volatilityHalfLifeFraction ?? 0.4;

  // Structure and movement must agree, or there is nothing to say.
  const agrees =
    (structure.trend === "up" && structure.momentumPct > 0) ||
    (structure.trend === "down" && structure.momentumPct < 0);
  if (!agrees) {
    // Silence. The fusion layer counts this as no opinion, not as a weak vote.
    return {
      sourceId: options.sourceId,
      kind: "technical",
      direction: "hold",
      strength: 0,
      confidence: 0,
      observedAt: options.observedAt,
      ...(options.ref !== undefined ? { ref: options.ref } : {}),
    };
  }

  // Volatility haircut: confidence shrinks as the path gets noisier.
  const haircut = 1 / (1 + structure.realizedVolFraction / halfLife);
  const confidence = baseConfidence * haircut;
  const strength = Math.min(1, Math.abs(structure.momentumPct) / 0.1);

  return {
    sourceId: options.sourceId,
    kind: "technical",
    direction: structure.trend === "up" ? "buy" : "sell",
    strength,
    confidence,
    observedAt: options.observedAt,
    ...(options.ref !== undefined ? { ref: options.ref } : {}),
  };
}
