/**
 * Insider signal from Finnhub's monthly share purchase ratio.
 *
 * This replaces a rule I wrote earlier that counted SEC form types and called
 * the count a direction. That was invented: "a form 4 exists" says nothing
 * about whether insiders bought or sold. The monthly share purchase ratio is a
 * real, signed, provider-computed number, so the direction is measured rather
 * than inferred.
 *
 * The important subtlety is that this data is monthly and can lag by a long
 * way - the sample row seen while building this was over a year old. A stale
 * insider reading is worse than no reading, because it looks like evidence.
 * So the observation is dated to the END of the month it describes and then put
 * through the same evidence window as everything else: older than the lookback
 * means silence, not a weak vote.
 *
 * Confidence is deliberately middling. Insiders sell for reasons unrelated to
 * their view of the business - tax, diversification, pre-arranged plans - so
 * this is a tilt, never a thesis.
 */

import type { EvidenceWindowPolicy } from "./finance-evidence-window.js";
import type { FinanceSignal } from "./finance-signal-fusion.js";

export const FINNHUB_INSIDER_SOURCE_ID = "finnhub-insider";

export type InsiderSentimentPeriod = Readonly<{
  year: number;
  month: number;
  /** Monthly Share Purchase Ratio, roughly -100..100. Positive = net buying. */
  mspr: number;
  /** Net share change over the period. */
  change: number;
}>;

export type InsiderSignalOptions = Readonly<{
  /** When the judgement is being made. */
  observedAt: string;
  window: EvidenceWindowPolicy;
  /** |mspr| below this is noise. Default 5. */
  deadbandMspr?: number;
  /** Confidence ceiling. Default 0.4: a tilt, not a thesis. */
  baseConfidence?: number;
  sourceId?: string;
}>;

/** Age of the period in days, measured from the end of the month it covers. */
export function insiderPeriodAgeDays(
  period: InsiderSentimentPeriod,
  asOfMs: number,
): number | null {
  if (
    !Number.isFinite(period.year) ||
    !Number.isFinite(period.month) ||
    period.month < 1 ||
    period.month > 12
  ) {
    return null;
  }
  // End of the described month, exclusive.
  const endMs = Date.UTC(period.year, period.month, 1);
  if (!Number.isFinite(endMs)) {
    return null;
  }
  return (asOfMs - endMs) / 86_400_000;
}

export function insiderSentimentSignal(
  period: InsiderSentimentPeriod,
  options: InsiderSignalOptions,
): FinanceSignal {
  const deadband = options.deadbandMspr ?? 5;
  const baseConfidence = options.baseConfidence ?? 0.4;
  const sourceId = options.sourceId ?? FINNHUB_INSIDER_SOURCE_ID;
  const asOfMs = Date.parse(options.observedAt);

  const ref =
    period.year +
    "-" +
    String(period.month).padStart(2, "0") +
    " mspr=" +
    period.mspr.toFixed(2) +
    " change=" +
    period.change;

  const silent = (reason: string): FinanceSignal => ({
    sourceId,
    kind: "fundamental",
    direction: "hold",
    strength: 0,
    confidence: 0,
    observedAt: options.observedAt,
    ref: ref + " (" + reason + ")",
  });

  if (!Number.isFinite(asOfMs)) {
    return silent("no observation time");
  }
  const ageDays = insiderPeriodAgeDays(period, asOfMs);
  if (ageDays === null || !Number.isFinite(ageDays)) {
    // An undated reading must not be assumed fresh.
    return silent("period could not be dated");
  }
  if (!Number.isFinite(period.mspr)) {
    return silent("no usable mspr");
  }
  if (ageDays > options.window.lookbackDays) {
    return silent("older than the " + options.window.lookbackDays + "-day window");
  }

  const direction: FinanceSignal["direction"] =
    period.mspr > deadband ? "buy" : period.mspr < -deadband ? "sell" : "hold";
  if (direction === "hold") {
    return silent("inside the deadband");
  }

  return {
    sourceId,
    kind: "fundamental",
    direction,
    strength: Math.min(1, Math.abs(period.mspr) / 50),
    confidence: baseConfidence,
    observedAt: options.observedAt,
    ref: ref + " ageDays=" + ageDays.toFixed(0),
  };
}
