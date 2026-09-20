/**
 * Fundamental signal from analyst price targets.
 *
 * Chosen over growth rates because a target versus the current price is already
 * relative: the market's own analysts have done the valuing, and the only thing
 * left is how far their number is from today's. A growth rate would need a
 * threshold invented here ("is 8% revenue growth good?"), which is a guess
 * dressed up as analysis.
 *
 * Two honest limits are built in:
 *
 * 1. **Analyst targets are optimistic.** They are well documented to skew
 *    upward, so confidence is capped well below the technical signal's. A
 *    target says what analysts hope, not what will happen.
 * 2. **A small gap is silence.** Inside the deadband the signal is `hold`,
 *    which fusion treats as no opinion. A target 1% above the price is noise,
 *    and turning noise into a vote is how a system manufactures conviction.
 *
 * Source identity: everything here is one provider's view of analysts, so all
 * of it shares one sourceId. Two fields from the same provider are not two
 * independent sources, and counting them as such would fake a majority.
 */

import type { FinanceSignal } from "./finance-signal-fusion.js";

export const FMP_ANALYST_SOURCE_ID = "fmp-analyst";

export type AnalystTargetSummary = Readonly<{
  currentPrice: number;
  /** Consensus target over the chosen window. */
  avgTarget: number;
  /** How many analysts the target is based on. */
  analystCount: number;
  /** Which window the target covers, for the evidence string. */
  window: string;
}>;

export type AnalystTargetSignalOptions = Readonly<{
  observedAt: string;
  /** Absolute upside needed before this has an opinion. Default 0.03 (3%). */
  deadbandFraction?: number;
  /** Confidence ceiling. Default 0.45, deliberately below technical signals. */
  maxConfidence?: number;
  /** Analyst count treated as fully credible. Default 10. */
  fullCredibilityCount?: number;
  sourceId?: string;
}>;

export function analystTargetSignal(
  summary: AnalystTargetSummary,
  options: AnalystTargetSignalOptions,
): FinanceSignal {
  const deadband = options.deadbandFraction ?? 0.03;
  const maxConfidence = options.maxConfidence ?? 0.45;
  const fullCredibilityCount = options.fullCredibilityCount ?? 10;
  const sourceId = options.sourceId ?? FMP_ANALYST_SOURCE_ID;

  const ref =
    "target=" +
    summary.avgTarget.toFixed(2) +
    " price=" +
    summary.currentPrice.toFixed(2) +
    " n=" +
    summary.analystCount +
    " window=" +
    summary.window;

  // The three tunables are caller-supplied and were unvalidated, so a degenerate one manufactured a
  // vote instead of withholding one. Measured: `fullCredibilityCount: -10` with 100 analysts produced
  // `confidence = -2.025`; `deadbandFraction: -0.03` turned a target 2% *below* the price into a
  // `buy`, because both `upside > -0.03` and `upside < 0.03` hold there and the first branch wins;
  // `maxConfidence: 5` emitted a weight of 5 for a field this module documents as capped below the
  // technical signal's. Clamping would silently honour part of a contradictory request and still
  // vote, so an incoherent configuration yields no opinion instead.
  const configCoherent =
    Number.isFinite(deadband) &&
    deadband >= 0 &&
    Number.isFinite(maxConfidence) &&
    maxConfidence >= 0 &&
    maxConfidence <= 1 &&
    Number.isFinite(fullCredibilityCount) &&
    fullCredibilityCount >= 1;

  if (!configCoherent) {
    return {
      sourceId,
      kind: "fundamental",
      direction: "hold",
      strength: 0,
      confidence: 0,
      observedAt: options.observedAt,
      ref: ref + " config=incoherent",
    };
  }

  // A target is a claim by someone. With no known claimant there is nothing to
  // weigh, and coverage of zero would otherwise still return a floor of half
  // confidence - a number that sounds modest but was derived from nobody.
  const knownClaimants = Number.isFinite(summary.analystCount) && summary.analystCount >= 1;
  const valid =
    Number.isFinite(summary.currentPrice) &&
    summary.currentPrice > 0 &&
    Number.isFinite(summary.avgTarget) &&
    summary.avgTarget > 0 &&
    knownClaimants;

  const upside = valid ? (summary.avgTarget - summary.currentPrice) / summary.currentPrice : 0;
  const direction: FinanceSignal["direction"] =
    upside > deadband ? "buy" : upside < -deadband ? "sell" : "hold";

  if (!valid || direction === "hold") {
    return {
      sourceId,
      kind: "fundamental",
      direction: "hold",
      strength: 0,
      confidence: 0,
      observedAt: options.observedAt,
      ref,
    };
  }

  // Coverage matters: three analysts is an anecdote, thirty is a view.
  const coverage = Math.min(1, summary.analystCount / fullCredibilityCount);
  const confidence = maxConfidence * (0.5 + 0.5 * coverage);
  const strength = Math.min(1, Math.abs(upside) / 0.15);

  return {
    sourceId,
    kind: "fundamental",
    direction,
    strength,
    confidence,
    observedAt: options.observedAt,
    ref: ref + " upside=" + (upside * 100).toFixed(2) + "%",
  };
}
