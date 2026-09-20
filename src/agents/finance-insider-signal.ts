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

  // The two tunables are caller-supplied and were unvalidated, so a degenerate one manufactured a
  // vote instead of withholding one -- the same construction, and the same defect, as
  // `finance-fundamental-signal.ts`. A negative deadband makes `mspr > deadband` hold for a small
  // *negative* mspr, so a mild sell tilt would be reported as a buy; a `baseConfidence` outside
  // [0, 1] is not a weight at all. Silence rather than a clamp: a clamp would honour part of a
  // contradictory request and still vote.
  const configCoherent =
    Number.isFinite(deadband) &&
    deadband >= 0 &&
    Number.isFinite(baseConfidence) &&
    baseConfidence >= 0 &&
    baseConfidence <= 1;
  if (!configCoherent) {
    return silent("incoherent configuration");
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

/**
 * Open-market transaction codes. Awards, gifts and exercises are excluded: an
 * executive receiving a grant did not choose to buy, and counting it as insider
 * demand would read compensation as conviction.
 */
const OPEN_MARKET_CODES = new Set(["P", "S"]);

export type InsiderTransaction = Readonly<{
  /** ISO date of the transaction. */
  transactionDate: string;
  /** Signed share change: negative for sales, positive for purchases. */
  change: number;
  /** Filing code when the provider supplies one. */
  transactionCode?: string;
}>;

export type InsiderFlowOptions = Readonly<{
  observedAt: string;
  window: EvidenceWindowPolicy;
  /** |net ratio| below this is noise. Default 0.1. */
  deadbandRatio?: number;
  /** Confidence ceiling. Default 0.45. */
  baseConfidence?: number;
  /** Transaction count treated as fully credible. Default 5. */
  fullCredibilityCount?: number;
  sourceId?: string;
}>;

/**
 * Insider flow from individual open-market transactions.
 *
 * Preferred over the monthly ratio because the monthly series lagged by around
 * eleven months in practice, which is far too slow for a thirty-day view. These
 * filings were current to within weeks.
 *
 * The measure is scale-free on purpose: (buys - sells) / (buys + sells) needs no
 * share count and no price, so it cannot be distorted by a company's size or by
 * a period with unusually large individual trades.
 */
export function insiderFlowSignal(
  transactions: readonly InsiderTransaction[],
  options: InsiderFlowOptions,
): FinanceSignal {
  const deadband = options.deadbandRatio ?? 0.1;
  const baseConfidence = options.baseConfidence ?? 0.45;
  const fullCredibilityCount = options.fullCredibilityCount ?? 5;
  const sourceId = options.sourceId ?? FINNHUB_INSIDER_SOURCE_ID;
  const asOfMs = Date.parse(options.observedAt);

  const silent = (reason: string): FinanceSignal => ({
    sourceId,
    kind: "fundamental",
    direction: "hold",
    strength: 0,
    confidence: 0,
    observedAt: options.observedAt,
    ref: reason,
  });

  if (!Number.isFinite(asOfMs)) {
    return silent("no observation time");
  }

  let buys = 0;
  let sells = 0;
  let count = 0;
  for (const tx of transactions) {
    const when = Date.parse(tx.transactionDate);
    const ageDays = Number.isFinite(when) ? (asOfMs - when) / 86_400_000 : Number.NaN;
    // Undated or outside the window is dropped, never assumed current.
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > options.window.lookbackDays) {
      continue;
    }
    // Only open-market activity. A grant is not a purchase.
    if (tx.transactionCode !== undefined && !OPEN_MARKET_CODES.has(tx.transactionCode)) {
      continue;
    }
    if (!Number.isFinite(tx.change) || tx.change === 0) {
      continue;
    }
    count += 1;
    if (tx.change > 0) {
      buys += tx.change;
    } else {
      sells += -tx.change;
    }
  }

  const total = buys + sells;
  if (count === 0 || total <= 0) {
    return silent("no open-market insider activity inside the window");
  }

  const ratio = (buys - sells) / total;
  const direction: FinanceSignal["direction"] =
    ratio > deadband ? "buy" : ratio < -deadband ? "sell" : "hold";
  if (direction === "hold") {
    return silent("insider flow inside the deadband");
  }

  const coverage = Math.min(1, count / fullCredibilityCount);
  return {
    sourceId,
    kind: "fundamental",
    direction,
    strength: Math.min(1, Math.abs(ratio)),
    confidence: baseConfidence * (0.5 + 0.5 * coverage),
    observedAt: options.observedAt,
    ref:
      "buys=" +
      buys +
      " sells=" +
      sells +
      " ratio=" +
      ratio.toFixed(3) +
      " n=" +
      count +
      " window=" +
      options.window.lookbackDays +
      "d",
  };
}
