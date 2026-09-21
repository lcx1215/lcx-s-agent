/**
 * Readiness of a declared strategy rule: has it actually been through adverse conditions?
 *
 * This is the one lesson from the trading community that can be turned into a machine check.
 * The advice is: "run the simulation at least four weeks, and it must have lived through at
 * least one unfavourable regime (chop, reversal, gap)". Duration is easy to encode. The second
 * half is harder, and this module makes it a declared, replayable judgement instead of a thing
 * somebody is supposed to remember.
 *
 * Two design decisions carry most of the weight here:
 *
 * 1. **Adversity is measured on the market, not on the rule's PnL.** A strategy that was flat
 *    for a month has a flat equity curve, and reading that as "nothing adverse happened" is
 *    exactly backwards — it means the rule was never tested. So this reads the mark stream
 *    (what prices actually did) and never the equity curve (what the rule happened to make).
 *
 * 2. **Absence is stated, never zero.** Every threshold is opt-in. An undeclared threshold does
 *    not fall back to a default, because a default would quietly answer "ready" for somebody
 *    who never said what "tested" means. It reports numbers and marks the condition `null`.
 *
 * Both failure directions are fail-safe: the required regime set defaults to *all three* kinds
 * (stricter, not looser), and an undeclared threshold makes a condition unjudgeable, which
 * counts as uncovered rather than covered.
 *
 * Pure projection: no store, no clock, no I/O. It reads two already-projected streams, and an
 * optional third: OHLC bars. Bars are what make the range measures honest — a close series cannot
 * see an intraday fall — but only when they are exchange-aggregated, so a bar that was built from
 * point observations is declined rather than quietly read as if it were a bar. See
 * `finance-bar-ledger.ts` for the distinction this rests on.
 */

import type { FinancePositionMark } from "./finance-position-ledger.js";
import type {
  FinanceStrategyRule,
  FinanceStrategyRuleState,
} from "./finance-strategy-rule-ledger.js";
import { calculateMaxDrawdown } from "./tools/quant-math-tool.js";

export const FINANCE_RULE_READINESS_SCHEMA = "lcx_finance_rule_readiness_v1" as const;

/** The adverse regimes a rule should have lived through before anyone trusts it. */
export const FINANCE_ADVERSITY_KINDS = ["chop", "reversal", "gap"] as const;

export type FinanceAdversityKind = (typeof FINANCE_ADVERSITY_KINDS)[number];

/**
 * Every threshold is optional, and that is deliberate: an undeclared threshold leaves its
 * condition unjudgeable rather than silently passing. See the module note.
 */
export type FinanceReadinessThresholds = Readonly<{
  /** Minimum calendar days between the rule's start and `asOf`. */
  minPaperDays?: number;
  /** Minimum mark observations inside the window before any regime may be judged. */
  minObservations?: number;
  /** Peak-to-trough fall, in percent, that counts as a reversal. */
  reversalDrawdownPercent?: number;
  /** Direction changes inside the window that count as chop. */
  chopMinFlips?: number;
  /** Single-observation move, in percent, that counts as a jump. */
  gapMovePercent?: number;
  /** Which regimes must be covered. Defaults to all three. */
  requiredAdversity?: readonly FinanceAdversityKind[];
}>;

/** Declared, machine-recognised threshold keys. Unknown keys are refused, never ignored. */
export const FINANCE_READINESS_NUMERIC_THRESHOLD_KEYS = [
  "minPaperDays",
  "minObservations",
  "reversalDrawdownPercent",
  "chopMinFlips",
  "gapMovePercent",
] as const;

export const FINANCE_READINESS_THRESHOLD_KEYS = [
  ...FINANCE_READINESS_NUMERIC_THRESHOLD_KEYS,
  "requiredAdversity",
] as const;

export type FinanceReadinessThresholdKey = (typeof FINANCE_READINESS_THRESHOLD_KEYS)[number];

export type ParseReadinessThresholdsResult =
  | { ok: true; thresholds: FinanceReadinessThresholds }
  | { ok: false; error: string };

/**
 * Validate a readiness threshold declaration.
 *
 * Unknown keys are refused rather than ignored, for the same reason as the behaviour thresholds:
 * a misspelled key is silently dropped by the projection, which then reports "not declared" for a
 * boundary the owner did set. Refusing turns a misreading into an error naming the key.
 */
export function parseFinanceReadinessThresholds(
  value: unknown,
  file: string,
): ParseReadinessThresholdsResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `${file} must contain a JSON object of readiness thresholds` };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !(FINANCE_READINESS_THRESHOLD_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error:
        `${file} has unknown readiness threshold key(s): ${unknownKeys.join(", ")}; ` +
        `known keys are ${FINANCE_READINESS_THRESHOLD_KEYS.join(", ")}`,
    };
  }
  const thresholds: Record<string, number | readonly FinanceAdversityKind[]> = {};
  for (const key of FINANCE_READINESS_NUMERIC_THRESHOLD_KEYS) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return {
        ok: false,
        error:
          `${file}: ${key} must be a non-negative finite number, ` +
          `received: ${JSON.stringify(raw)}`,
      };
    }
    thresholds[key] = raw;
  }
  const required = record["requiredAdversity"];
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((item) => typeof item !== "string")) {
      return {
        ok: false,
        error: `${file}: requiredAdversity must be an array of regime names`,
      };
    }
    const invalid = required.filter(
      (item) => !(FINANCE_ADVERSITY_KINDS as readonly string[]).includes(item),
    );
    if (invalid.length > 0) {
      return {
        ok: false,
        error:
          `${file}: requiredAdversity has unknown regime(s): ${invalid.join(", ")}; ` +
          `known regimes are ${FINANCE_ADVERSITY_KINDS.join(", ")}`,
      };
    }
    thresholds["requiredAdversity"] = required as FinanceAdversityKind[];
  }
  return { ok: true, thresholds: thresholds as unknown as FinanceReadinessThresholds };
}

/**
 * One price observation with a known intraday range.
 *
 * `sampleCount` is what separates a real bar from a bar-shaped guess, so it is required rather
 * than inferred: `null` means an exchange aggregated the period (high/low are the extremes traded
 * through), a number means the bar was built from that many point observations (high/low are only
 * the extremes *seen*). Range measures are read off it directly — see `windowedBars` and the
 * bar ledger, which is the only writer.
 */
export type FinanceReadinessBar = Readonly<{
  instrument: string;
  /** Bar period as `YYYY-MM-DD` or an ISO instant; only the date part decides window membership. */
  at: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** `null` for exchange-aggregated bars, otherwise how many point observations produced it. */
  sampleCount: number | null;
}>;

export type FinanceAdversityObservation = Readonly<{
  kind: FinanceAdversityKind;
  /** `true` covered, `false` not seen, `null` cannot be judged from what was declared. */
  observed: boolean | null;
  /**
   * What the numbers were read off: `ohlc` uses high/low (or the opening gap), `close` uses one
   * price per observation. A close-based drawdown is *not* the same quantity as an OHLC one, so
   * the basis travels with the number instead of being left for the reader to guess.
   */
  basis: "ohlc" | "close";
  /** The measured numbers, always present so a reader can see what the judgement rests on. */
  detail: Readonly<Record<string, number | null>>;
  /** Present when `observed` is `null`: why this cannot be judged. */
  unavailableReason: string | null;
}>;

export type FinanceRuleReadinessEntry = Readonly<{
  ruleId: string;
  state: FinanceStrategyRuleState;
  /** Activation time when present, declaration time otherwise — the rule's exposure start. */
  since: string;
  elapsedDays: number | null;
  instruments: readonly string[];
  observationCount: number;
  /**
   * Set when the window was measured on closes *even though a bar book exists*: without it, a
   * reader cannot tell "this rule has no history yet" from "the history is there and the window
   * misses it", and the two call for opposite actions (wait, versus look at the dates).
   */
  barWindowNote: string | null;
  adversity: readonly FinanceAdversityObservation[];
  covered: readonly FinanceAdversityKind[];
  uncovered: readonly FinanceAdversityKind[];
  /** `null` when `minPaperDays` was not declared. */
  durationMet: boolean | null;
  /** `null` when the question cannot be answered from what was declared. */
  ready: boolean | null;
  readyUnavailableReason: string | null;
}>;

export type FinanceRuleReadiness = Readonly<{
  schemaVersion: typeof FINANCE_RULE_READINESS_SCHEMA;
  asOf: string;
  ruleCount: number;
  markCount: number;
  /** Bars offered to this projection, before windowing. Zero means the mark-only reading. */
  barCount: number;
  rules: readonly FinanceRuleReadinessEntry[];
  declaredThresholds: Readonly<Record<string, number | null>>;
  requiredAdversity: readonly FinanceAdversityKind[];
  interpretationBoundary: string;
  /** Pinned: readiness is an observation, never a recommendation to trade. */
  advice: false;
}>;

const INTERPRETATION_BOUNDARY_CORE =
  "This says whether a declared rule has been exposed to adverse price action for long enough. " +
  "It is not investment advice, not a performance claim, and not evidence that the rule works: " +
  "a rule can survive chop and still be wrong. Adversity is measured on observed prices, so it " +
  "describes what the market did, never what the rule earned.";

/**
 * Which quantity a number means depends on what it was read from, and a close-to-close fall is not
 * a smaller version of a peak-to-trough fall — it is a different measurement. The qualifier is
 * therefore part of the answer rather than a footnote, and it changes with the supply.
 */
const MARKS_QUALIFIER =
  "Only sparse spot marks were available, so a reversal is a close-to-close fall and a 'jump' is " +
  "the move between two consecutive observations, not the exchange-level opening gap.";

const OHLC_QUALIFIER =
  "Exchange-aggregated bars were available, so a reversal is the fall from a peak high to a " +
  "subsequent low and a 'jump' is the opening gap (this open against the previous close). Chop is " +
  "still counted on closes.";

const BARS_REFUSED_QUALIFIER =
  "Where bars were present but their high/low are point-derived, no range measure was taken from " +
  "them: those regimes are reported as unjudgeable, which counts as uncovered, rather than as " +
  "'nothing happened'.";

function interpretationBoundary(usedOhlc: boolean, refusedBars: boolean): string {
  const parts = [INTERPRETATION_BOUNDARY_CORE];
  if (usedOhlc) {
    parts.push(OHLC_QUALIFIER);
  }
  if (refusedBars) {
    parts.push(BARS_REFUSED_QUALIFIER);
  }
  if (!usedOhlc) {
    parts.push(MARKS_QUALIFIER);
  }
  return parts.join(" ");
}

const MS_PER_DAY = 86_400_000;
const DEFAULT_MIN_OBSERVATIONS = 3;

function toMillis(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Marks inside the window for the rule's instruments, with unusable prices dropped. */
function windowedMarks(
  marks: readonly FinancePositionMark[],
  instruments: readonly string[],
  since: string,
  asOf: string,
): readonly FinancePositionMark[] {
  const wanted = new Set(instruments);
  return marks.filter(
    (mark) =>
      wanted.has(mark.instrument) &&
      mark.at.localeCompare(since) >= 0 &&
      mark.at.localeCompare(asOf) <= 0 &&
      Number.isFinite(mark.price) &&
      mark.price > 0,
  );
}

/**
 * Bars inside the window for the rule's instruments.
 *
 * Bars and marks are windowed on different clocks: a mark is an instant, a bar is a period, and a
 * bar dated the same day as `since` is *inside* the window even though its date string sorts
 * before that instant. Comparing only the date part is what makes that true; comparing raw strings
 * would silently drop the first (and last) bar of every window.
 */
function windowedBars(
  bars: readonly FinanceReadinessBar[],
  instruments: readonly string[],
  since: string,
  asOf: string,
): readonly FinanceReadinessBar[] {
  const wanted = new Set(instruments);
  const first = dayOf(since);
  const last = dayOf(asOf);
  return bars.filter((bar) => {
    if (!wanted.has(bar.instrument) || !Number.isFinite(bar.close) || bar.close <= 0) {
      return false;
    }
    const day = dayOf(bar.at);
    return day.localeCompare(first) >= 0 && day.localeCompare(last) <= 0;
  });
}

function dayOf(value: string): string {
  return value.slice(0, 10);
}

/**
 * Split one window into per-instrument series, oldest first.
 *
 * Every measure below is computed per instrument and then aggregated, never on the instruments
 * concatenated. A "return" between the last price of AAA and the first price of BBB is a change of
 * instrument, not a move the market made, and reading it as a move manufactures jumps and flips
 * that no holder of either instrument ever experienced — which would answer "ready" on evidence
 * that does not exist.
 */
function seriesByInstrument<T extends { instrument: string; at: string }>(
  items: readonly T[],
): readonly T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const bucket = groups.get(item.instrument);
    if (bucket === undefined) {
      groups.set(item.instrument, [item]);
    } else {
      bucket.push(item);
    }
  }
  return [...groups.values()].map((group) =>
    group.toSorted((left, right) => left.at.localeCompare(right.at)),
  );
}

function maxOf(values: readonly (number | null)[]): number | null {
  let worst: number | null = null;
  for (const value of values) {
    if (value === null) {
      continue;
    }
    if (worst === null || value > worst) {
      worst = value;
    }
  }
  return worst;
}

/**
 * Peak-high to subsequent-low fall, in percent.
 *
 * This is the quantity the word "reversal" is actually about and it is not computable from closes:
 * an instrument can trade 12% below its peak intraday and close 2% down, and a close-only series
 * reports 2%. Tradeable range is what a stop has to survive, so the range is what gets measured
 * whenever the bars can support it.
 */
function trueDrawdownPercent(bars: readonly FinanceReadinessBar[]): number | null {
  if (bars.length < 2) {
    return null;
  }
  let peak = 0;
  let worst = 0;
  for (const bar of bars) {
    if (bar.high > peak) {
      peak = bar.high;
    }
    if (peak > 0 && bar.low > 0) {
      const fall = (peak - bar.low) / peak;
      if (fall > worst) {
        worst = fall;
      }
    }
  }
  return worst * 100;
}

/**
 * Largest opening gap, in percent: this open against the previous close.
 *
 * With closes only, the closest available quantity is the move between two observations, which the
 * boundary text says out loud. An exchange-aggregated bar makes the actual opening gap readable,
 * and that is a different number — a session that gaps down at the open and recovers by the close
 * is visible in one and invisible in the other.
 */
function openingGapPercent(bars: readonly FinanceReadinessBar[]): number | null {
  if (bars.length < 2) {
    return null;
  }
  let worst = 0;
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1]?.close ?? 0;
    const current = bars[index]?.open ?? 0;
    if (previous <= 0) {
      continue;
    }
    const move = Math.abs(current / previous - 1);
    if (move > worst) {
      worst = move;
    }
  }
  return worst * 100;
}

/** Signed simple returns between consecutive prices. */
function simpleReturns(prices: readonly number[]): readonly number[] {
  const out: number[] = [];
  for (let index = 1; index < prices.length; index += 1) {
    const previous = prices[index - 1];
    const current = prices[index];
    out.push(previous === 0 ? 0 : current / previous - 1);
  }
  return out;
}

/** How many times the direction of travel flips across the window. */
function directionFlips(returns: readonly number[]): number {
  let flips = 0;
  let previousSign = 0;
  for (const value of returns) {
    const sign = value > 0 ? 1 : value < 0 ? -1 : 0;
    if (sign === 0) {
      continue;
    }
    if (previousSign !== 0 && sign !== previousSign) {
      flips += 1;
    }
    previousSign = sign;
  }
  return flips;
}

function maxAbsPercent(returns: readonly number[]): number | null {
  if (returns.length === 0) {
    return null;
  }
  let worst = 0;
  for (const value of returns) {
    const magnitude = Math.abs(value) * 100;
    if (magnitude > worst) {
      worst = magnitude;
    }
  }
  return worst;
}

/**
 * Everything the three regimes are judged from, measured once per rule.
 *
 * Each field is the worst case across the rule's instruments, never a blend of them: "did this
 * rule live through a reversal" is answered by the instrument that actually fell, and averaging
 * would let one quiet instrument dilute the one that mattered.
 */
type ReadinessMeasures = Readonly<{
  /** Observations in the window, across every instrument. */
  observationCount: number;
  /** True when the window was read from bars; false when it was read from sparse marks. */
  barsPresent: boolean;
  /** Direction flips on the close series, worst case across instruments. */
  flips: number | null;
  /** Close-to-close peak-to-trough fall, worst case. Only used when no usable bars exist. */
  closeDrawdownPercent: number | null;
  /** Largest move between consecutive closes, worst case. Only used when no usable bars exist. */
  closeMaxJumpPercent: number | null;
  /** Peak-high-to-trough-low fall; `null` unless usable exchange bars exist. */
  trueDrawdownPercent: number | null;
  /** Largest opening gap; `null` unless usable exchange bars exist. */
  openingGapPercent: number | null;
  /** Whether range measures (reversal, gap) may be read off high/low and open. */
  ohlcUsable: boolean;
  /** Why range measures cannot be read from the bars that are present. */
  ohlcUnavailableReason: string | null;
  /**
   * Bars the book holds for these instruments *outside* the window, and the newest of them.
   *
   * "No bars in the window" has two very different causes — the history does not exist, or it
   * exists and the window sits outside it — and from the measures alone they are identical.
   */
  barsOutsideWindow: number;
  latestBarDate: string | null;
}>;

function ohlcUnavailableReason(params: {
  barsPresent: boolean;
  barCount: number;
  derivedCount: number;
  shortInstrumentCount: number;
  ohlcUsable: boolean;
}): string | null {
  if (params.ohlcUsable) {
    return null;
  }
  if (!params.barsPresent) {
    return "no OHLC bars in the window, so range measures fall back to closes";
  }
  const parts: string[] = [];
  if (params.derivedCount > 0) {
    parts.push(
      `${params.derivedCount} of ${params.barCount} bar(s) carry point-derived high/low, and ` +
        "a bar built from one observation has an unknown range rather than a zero range, so a " +
        "peak-to-trough fall read off it would be understated",
    );
  }
  if (params.shortInstrumentCount > 0) {
    parts.push(`${params.shortInstrumentCount} instrument(s) have fewer than two bars`);
  }
  return (
    "cannot read a peak-to-trough fall or an opening gap from these bars: " +
    (parts.length > 0 ? parts.join("; ") : "no usable bar in the window")
  );
}

function measureWindow(params: {
  marks: readonly FinancePositionMark[];
  bars: readonly FinanceReadinessBar[];
  instruments: readonly string[];
  since: string;
  asOf: string;
}): ReadinessMeasures {
  const marks = windowedMarks(params.marks, params.instruments, params.since, params.asOf);
  const bars = windowedBars(params.bars, params.instruments, params.since, params.asOf);
  const barsPresent = bars.length > 0;

  const closeSeries = barsPresent
    ? seriesByInstrument(bars).map((group) => group.map((bar) => bar.close))
    : seriesByInstrument(marks).map((group) => group.map((mark) => mark.price));
  const returns = closeSeries.map((series) => simpleReturns(series));

  const inScope = params.bars.filter(
    (bar) =>
      params.instruments.includes(bar.instrument) && Number.isFinite(bar.close) && bar.close > 0,
  );
  const barsOutsideWindow = inScope.length - bars.length;
  const latestBarDate = inScope.reduce<string | null>(
    (latest, bar) => (latest === null || bar.at > latest ? bar.at : latest),
    null,
  );

  const barGroups = seriesByInstrument(bars);
  // A range measure is only honest when every bar in the group is exchange-aggregated: one
  // point-derived bar would set a peak or a trough from an extreme nobody established.
  const usableGroups = barGroups.filter(
    (group) => group.length >= 2 && group.every((bar) => bar.sampleCount === null),
  );

  return {
    observationCount: barsPresent ? bars.length : marks.length,
    barsPresent,
    flips: maxOf(returns.map((series) => directionFlips(series))),
    closeDrawdownPercent: maxOf(
      closeSeries.map((series) =>
        series.length >= 2
          ? Math.abs(calculateMaxDrawdown([...series], "levels").maxDrawdown) * 100
          : null,
      ),
    ),
    closeMaxJumpPercent: maxOf(returns.map((series) => maxAbsPercent(series))),
    trueDrawdownPercent: maxOf(usableGroups.map((group) => trueDrawdownPercent(group))),
    openingGapPercent: maxOf(usableGroups.map((group) => openingGapPercent(group))),
    ohlcUsable: usableGroups.length > 0,
    barsOutsideWindow,
    latestBarDate: latestBarDate === null ? null : latestBarDate.slice(0, 10),
    ohlcUnavailableReason: ohlcUnavailableReason({
      barsPresent,
      barCount: bars.length,
      derivedCount: bars.filter((bar) => bar.sampleCount !== null).length,
      shortInstrumentCount: barGroups.filter((group) => group.length < 2).length,
      ohlcUsable: usableGroups.length > 0,
    }),
  };
}

/**
 * Chop is a close-series notion on purpose. A swing count needs a definition of "swing" that this
 * module has not been given a threshold for, so it keeps the one shape that is comparable to the
 * mark-based reading and says so in `basis`.
 */
function buildChop(
  measures: ReadinessMeasures,
  thresholds: FinanceReadinessThresholds,
  minObservations: number,
): FinanceAdversityObservation {
  const flips = measures.flips;
  const declared = thresholds.chopMinFlips;
  if (declared === undefined) {
    return {
      kind: "chop",
      observed: null,
      basis: "close",
      detail: { flips, minFlips: null },
      unavailableReason: "thresholds.chopMinFlips was not declared",
    };
  }
  if (measures.observationCount < minObservations) {
    return {
      kind: "chop",
      observed: null,
      basis: "close",
      detail: { flips, minFlips: declared },
      unavailableReason:
        `only ${measures.observationCount} observation(s) in the window, below the ` +
        `${minObservations} required to judge chop`,
    };
  }
  return {
    kind: "chop",
    observed: (flips ?? 0) >= declared,
    basis: "close",
    detail: { flips, minFlips: declared },
    unavailableReason: null,
  };
}

function buildReversal(
  measures: ReadinessMeasures,
  thresholds: FinanceReadinessThresholds,
  minObservations: number,
): FinanceAdversityObservation {
  const declared = thresholds.reversalDrawdownPercent;
  if (measures.observationCount < 2) {
    return {
      kind: "reversal",
      observed: null,
      basis: "close",
      detail: { drawdownPercent: null, thresholdPercent: declared ?? null },
      unavailableReason: "fewer than two prices in the window; a peak-to-trough fall needs two",
    };
  }
  // Bars that cannot carry a range do not get to answer this question quietly. Reporting the
  // close-to-close fall instead would output a number that is systematically *smaller* than the
  // thing the threshold is about, which is the one error direction that produces "not adverse"
  // verdicts from adverse markets.
  if (measures.barsPresent && !measures.ohlcUsable) {
    return {
      kind: "reversal",
      observed: null,
      basis: "close",
      detail: { drawdownPercent: null, thresholdPercent: declared ?? null },
      unavailableReason: measures.ohlcUnavailableReason,
    };
  }
  const basis = measures.ohlcUsable ? "ohlc" : "close";
  const drawdown = measures.ohlcUsable
    ? measures.trueDrawdownPercent
    : measures.closeDrawdownPercent;
  if (declared === undefined) {
    return {
      kind: "reversal",
      observed: null,
      basis,
      detail: { drawdownPercent: drawdown, thresholdPercent: null },
      unavailableReason: "thresholds.reversalDrawdownPercent was not declared",
    };
  }
  if (measures.observationCount < minObservations) {
    return {
      kind: "reversal",
      observed: null,
      basis,
      detail: { drawdownPercent: drawdown, thresholdPercent: declared },
      unavailableReason:
        `only ${measures.observationCount} observation(s) in the window, below the ` +
        `${minObservations} required to judge a reversal`,
    };
  }
  return {
    kind: "reversal",
    observed: (drawdown ?? 0) >= declared,
    basis,
    detail: { drawdownPercent: drawdown, thresholdPercent: declared },
    unavailableReason: null,
  };
}

function buildGap(
  measures: ReadinessMeasures,
  thresholds: FinanceReadinessThresholds,
  minObservations: number,
): FinanceAdversityObservation {
  const declared = thresholds.gapMovePercent;
  const basis = measures.ohlcUsable ? "ohlc" : "close";
  const worst = measures.ohlcUsable ? measures.openingGapPercent : measures.closeMaxJumpPercent;
  if (declared === undefined) {
    return {
      kind: "gap",
      observed: null,
      basis,
      detail: { maxJumpPercent: worst, thresholdPercent: null },
      unavailableReason: "thresholds.gapMovePercent was not declared",
    };
  }
  if (measures.observationCount < 2) {
    return {
      kind: "gap",
      observed: null,
      basis,
      detail: { maxJumpPercent: null, thresholdPercent: declared },
      unavailableReason: "fewer than two prices in the window; a jump needs two",
    };
  }
  // Same refusal as the reversal: an "open" that is really one sampled point is not an opening
  // gap, and reporting the close-to-close move under this name would mislabel the quantity.
  if (measures.barsPresent && !measures.ohlcUsable) {
    return {
      kind: "gap",
      observed: null,
      basis: "close",
      detail: { maxJumpPercent: null, thresholdPercent: declared },
      unavailableReason: measures.ohlcUnavailableReason,
    };
  }
  if (measures.observationCount < minObservations) {
    return {
      kind: "gap",
      observed: null,
      basis,
      detail: { maxJumpPercent: worst, thresholdPercent: declared },
      unavailableReason:
        `only ${measures.observationCount} observation(s) in the window, below the ` +
        `${minObservations} required to judge a jump`,
    };
  }
  return {
    kind: "gap",
    observed: (worst ?? 0) >= declared,
    basis,
    detail: { maxJumpPercent: worst, thresholdPercent: declared },
    unavailableReason: null,
  };
}

/**
 * Say out loud when a bar book exists but the window misses it.
 *
 * A rule declared today and a rule with no supply at all both answer `basis: "close"`. One of them
 * resolves itself tomorrow and the other needs somebody to go and get data, so the difference is
 * the actionable half of the answer.
 */
function barWindowNote(measures: ReadinessMeasures, since: string): string | null {
  if (measures.barsPresent || measures.barsOutsideWindow === 0) {
    return null;
  }
  const newest = measures.latestBarDate ?? "unknown";
  return (
    `the bar book holds ${measures.barsOutsideWindow} bar(s) for this rule's instruments, but ` +
    `none inside the window (newest bar ${newest}, window starts ${since.slice(0, 10)}), so the ` +
    "range measures fall back to closes"
  );
}

function buildEntry(
  rule: FinanceStrategyRule,
  marks: readonly FinancePositionMark[],
  bars: readonly FinanceReadinessBar[],
  asOf: string,
  thresholds: FinanceReadinessThresholds,
  minObservations: number,
  required: readonly FinanceAdversityKind[],
): FinanceRuleReadinessEntry {
  // The owner's declared clock, never the writer's wall clock: `declaredAt` / `activatedAt` are
  // when the record was written, so windowing history from them makes replay impossible — at a
  // past `asOf` the window start would fall after the window end, silently yielding zero
  // observations, which would read as "nothing adverse happened" instead of "unjudgeable".
  const since = rule.activeObservedAt ?? rule.startObservedAt;
  const sinceMs = toMillis(since);
  const asOfMs = toMillis(asOf);
  const elapsedDays =
    sinceMs === null || asOfMs === null ? null : Math.floor((asOfMs - sinceMs) / MS_PER_DAY);

  const measures = measureWindow({
    marks,
    bars,
    instruments: rule.instruments,
    since,
    asOf,
  });

  const observations = [
    buildChop(measures, thresholds, minObservations),
    buildReversal(measures, thresholds, minObservations),
    buildGap(measures, thresholds, minObservations),
  ];

  const byKind = new Map(observations.map((item) => [item.kind, item]));
  const covered: FinanceAdversityKind[] = [];
  const uncovered: FinanceAdversityKind[] = [];
  for (const kind of required) {
    const item = byKind.get(kind);
    if (item?.observed === true) {
      covered.push(kind);
    } else {
      uncovered.push(kind);
    }
  }

  const declaredDays = thresholds.minPaperDays;
  const durationMet =
    declaredDays === undefined || elapsedDays === null ? null : elapsedDays >= declaredDays;

  const unjudgeable = required.filter((kind) => byKind.get(kind)?.observed === null);
  let ready: boolean | null;
  let readyUnavailableReason: string | null = null;
  if (declaredDays === undefined) {
    ready = null;
    readyUnavailableReason = "thresholds.minPaperDays was not declared, so duration is unjudged";
  } else if (elapsedDays === null) {
    ready = null;
    readyUnavailableReason = `could not parse ${since} or ${asOf} as timestamps`;
  } else if (required.length === 0) {
    // An empty required set is not "no preference", it is the measure cancelling itself: with
    // nothing required, `uncovered` is empty by construction and duration alone answers `ready`,
    // so a rule that sailed through calm markets reads as tested. Measured: a rule on a steadily
    // rising series with no chop, reversal or gap reported `ready: true` under `requiredAdversity:
    // []`, where leaving it undeclared (or naming one regime) reported `false`. The module exists
    // to require exposure to adversity, so a declaration that requires none is unjudgeable rather
    // than satisfied.
    ready = null;
    readyUnavailableReason =
      "thresholds.requiredAdversity is empty, so no adverse regime is required and duration " +
      "alone would answer this; readiness is unjudgeable rather than satisfied";
  } else if (unjudgeable.length > 0) {
    ready = null;
    readyUnavailableReason =
      `cannot judge: ${unjudgeable.join(", ")} had no declared threshold or too few ` +
      "observations, and an unjudgeable condition counts as uncovered";
  } else {
    ready = durationMet === true && uncovered.length === 0;
  }

  return Object.freeze({
    ruleId: rule.ruleId,
    state: rule.state,
    since,
    elapsedDays,
    instruments: rule.instruments,
    observationCount: measures.observationCount,
    barWindowNote: barWindowNote(measures, since),
    adversity: observations,
    covered,
    uncovered,
    durationMet,
    ready,
    readyUnavailableReason,
  });
}

export type FinanceRuleReadinessOptions = Readonly<{
  rules: readonly FinanceStrategyRule[];
  marks: readonly FinancePositionMark[];
  /**
   * Optional OHLC bar supply. When a rule's instruments have usable exchange-aggregated bars,
   * the range measures (reversal, gap) are read off high/low and open instead of off closes.
   * Omitting this keeps the mark-only reading; it is never silently substituted.
   */
  bars?: readonly FinanceReadinessBar[];
  asOf: string;
  thresholds?: FinanceReadinessThresholds;
}>;

/**
 * Project readiness for every declared rule.
 *
 * Rules are always reported, including ones that cannot be judged — a rule nobody can judge is
 * the interesting case, not an error to hide.
 */
export function buildFinanceRuleReadiness(
  options: FinanceRuleReadinessOptions,
): FinanceRuleReadiness {
  const thresholds = options.thresholds ?? {};
  const minObservations = thresholds.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
  const required =
    thresholds.requiredAdversity === undefined
      ? FINANCE_ADVERSITY_KINDS
      : FINANCE_ADVERSITY_KINDS.filter((kind) => thresholds.requiredAdversity?.includes(kind));

  const bars = options.bars ?? [];
  const rules = options.rules.map((rule) =>
    buildEntry(rule, options.marks, bars, options.asOf, thresholds, minObservations, required),
  );

  const usedOhlc = rules.some((rule) => rule.adversity.some((item) => item.basis === "ohlc"));
  const refusedBars = rules.some((rule) =>
    rule.adversity.some(
      (item) => item.basis === "close" && item.unavailableReason?.startsWith("cannot read"),
    ),
  );

  return Object.freeze({
    schemaVersion: FINANCE_RULE_READINESS_SCHEMA,
    asOf: options.asOf,
    ruleCount: rules.length,
    markCount: options.marks.length,
    barCount: bars.length,
    rules,
    declaredThresholds: Object.freeze({
      minPaperDays: thresholds.minPaperDays ?? null,
      minObservations,
      reversalDrawdownPercent: thresholds.reversalDrawdownPercent ?? null,
      chopMinFlips: thresholds.chopMinFlips ?? null,
      gapMovePercent: thresholds.gapMovePercent ?? null,
    }),
    requiredAdversity: required,
    interpretationBoundary: interpretationBoundary(usedOhlc, refusedBars),
    advice: false,
  });
}
