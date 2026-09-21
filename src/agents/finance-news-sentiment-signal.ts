/**
 * Turn a cohort of news into one signal, and score a headline when no vendor score exists.
 *
 * This deliberately contains no new aggregation. `summarizeNewsCohort` already windows articles
 * by *days* (not by count), weights them by recency, and refuses to speak on a thin cohort --
 * that logic exists because "the latest N articles" silently meant six months on a quiet name.
 * What was missing is only the last step: that cohort was never converted into a `FinanceSignal`,
 * so news could be gathered and reported but never counted as a source by fusion. This is that
 * step, so a news source can stand next to chart structure and macro instead of beside them.
 *
 * Two limits are stated rather than hidden:
 *
 * 1. A neutral cohort says nothing. A score of 0.02 is noise, and turning noise into a direction
 *    is how a source starts overclaiming.
 * 2. News is the weakest of the three sources and is capped below macro. Headlines are not
 *    filings, and a keyword lexicon is not a model.
 */

import {
  defaultEvidenceWindow,
  summarizeNewsCohort,
  type EvidenceWindowPolicy,
  type NewsItem,
} from "./finance-evidence-window.js";
import type { FinanceSignal } from "./finance-signal-fusion.js";

/** Below this absolute weighted mean the cohort is noise, not a direction. */
export const NEWS_SENTIMENT_NEUTRAL_BAND = 0.05;
/** Weighted mean at which the signal is at full strength. */
export const NEWS_SENTIMENT_FULL_STRENGTH = 0.5;
/** Capped below the macro routes (0.45-0.6): headlines are weaker evidence than official series. */
export const NEWS_SENTIMENT_MAX_CONFIDENCE = 0.4;

export function newsSentimentSignal(params: {
  sourceId: string;
  items: readonly NewsItem[];
  observedAt: string;
  /** Defaults to a 30-day-horizon window, the same horizon the loop settles against. */
  policy?: EvidenceWindowPolicy;
  maxConfidence?: number;
}): FinanceSignal | undefined {
  const policy = params.policy ?? defaultEvidenceWindow({ horizonDays: 30 });
  const cohort = summarizeNewsCohort(params.items, policy);
  if (!cohort.usable || cohort.weightedMean === null) {
    return undefined;
  }
  const mean = cohort.weightedMean;
  if (Math.abs(mean) <= NEWS_SENTIMENT_NEUTRAL_BAND) {
    return undefined;
  }
  const strength = Math.min(1, Math.abs(mean) / NEWS_SENTIMENT_FULL_STRENGTH);
  return Object.freeze({
    sourceId: params.sourceId,
    kind: "news_tone",
    direction: mean > 0 ? "buy" : "sell",
    strength: Number(strength.toFixed(4)),
    confidence: params.maxConfidence ?? NEWS_SENTIMENT_MAX_CONFIDENCE,
    observedAt: params.observedAt,
    ref:
      `weightedMean=${mean.toFixed(4)} used=${cohort.used}` +
      ` spanDays=${cohort.spanDays.toFixed(1)} window=${policy.lookbackDays}d`,
  });
}

/**
 * A short, auditable lexicon for providers that return headlines but no score.
 *
 * Every term is listed here so a reading can be argued with. It is intentionally blunt: it has no
 * model of negation ("not weak"), sarcasm, or how central the subject is, so it is used only when
 * a vendor score is unavailable and its confidence stays at the news ceiling.
 */
const POSITIVE_TERMS = [
  "beat",
  "beats",
  "upgrade",
  "raises",
  "record",
  "surge",
  "surges",
  "jump",
  "jumps",
  "rally",
  "rallies",
  "outperform",
  "bullish",
  "buyback",
  "approval",
  "wins",
] as const;
const NEGATIVE_TERMS = [
  "miss",
  "misses",
  "downgrade",
  "cuts",
  "slash",
  "plunge",
  "plunges",
  "selloff",
  "sell-off",
  "bearish",
  "weak",
  "loss",
  "losses",
  "probe",
  "lawsuit",
  "recall",
  "fraud",
  "layoff",
  "layoffs",
  "bankruptcy",
] as const;

/**
 * Score one headline in roughly -1..1, or `undefined` when it carries no sentiment term.
 *
 * "No opinion" is a different answer from "neutral", and returning 0 for a headline the lexicon
 * does not understand would quietly drag every cohort toward neutral instead of leaving it out.
 */
export function scoreHeadline(text: string): number | undefined {
  if (typeof text !== "string" || text.trim().length === 0) {
    return undefined;
  }
  const lower = text.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const term of POSITIVE_TERMS) {
    if (lower.includes(term)) {
      score += 1;
      hits += 1;
    }
  }
  for (const term of NEGATIVE_TERMS) {
    if (lower.includes(term)) {
      score -= 1;
      hits += 1;
    }
  }
  if (hits === 0) {
    return undefined;
  }
  // A single term is half-strength at most; repeated agreement can reach the bound.
  return Math.max(-1, Math.min(1, score / Math.max(2, hits)));
}
