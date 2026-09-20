/**
 * Behaviour profile of the owner's own fills.
 *
 * The external-learning intake
 * (`ops/external-learning/2026-09-18-trading-agent-ecosystem-intake.md`, confirmed gap ②)
 * recorded that LCX can describe a trade and hold a position, but cannot say anything about
 * *how the owner trades*. This module closes that gap the only way this repository allows:
 * as a **pure projection** over the receipt/mark stream the position ledger already stores.
 *
 * Four properties are load-bearing:
 *
 *   - **No new state root.** Receipts and marks arrive as arguments. This module opens no
 *     database, writes nothing, and imports no store; the caller decides where the stream
 *     came from. That keeps it usable from the operator layer without a second source of truth.
 *   - **Deterministic.** Ordering is `recordedAt` then `receiptId`, the same rule the ledger's
 *     own projection uses, so one stream yields exactly one profile.
 *   - **Absence is stated, never zeroed.** A dimension that cannot be measured carries a named
 *     reason; a dimension whose threshold was not declared carries numbers but **no** label.
 *     The repository's rule holds here: a number nobody declared is worse than no number.
 *   - **Labels are not advice.** Every statement describes an observation over recorded fills.
 *     The profile never says what to do, and `advice` is pinned to `false` so a reader cannot
 *     mistake a label for a recommendation.
 *
 * The measures are the standard operationalisations rather than invented ones: the disposition
 * effect is the Odean proportion-of-gains-realised (PGR) versus proportion-of-losses-realised
 * (PLR) gap; round-level clustering is the usual anchoring proxy; "momentum chasing" is a buy
 * whose fill price sits above the last mark seen before it.
 *
 * A same-name warning is worth repeating here, because the collision is real: the ontology's
 * `shadow_replay` / `shadow_live` nodes mean *isolated replay of an external pattern*. This
 * module is a different concept and deliberately does not reuse that vocabulary.
 */

import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import {
  projectFinancePositions,
  type FinancePosition,
  type FinancePositionMark,
} from "./finance-position-ledger.js";

export const FINANCE_BEHAVIOUR_PROFILE_SCHEMA = "lcx_finance_behaviour_profile_v1" as const;

/** The four dimensions this module can speak to. Fixed, so a reader can rely on all four. */
export const FINANCE_BEHAVIOUR_DIMENSIONS = [
  "disposition_effect",
  "turnover",
  "momentum_chasing",
  "anchoring",
] as const;
export type FinanceBehaviourDimensionId = (typeof FINANCE_BEHAVIOUR_DIMENSIONS)[number];

/**
 * The declared-threshold names, in the order the profile reports them.
 *
 * Exported as a runtime list because a caller supplying thresholds from a file has to reject a
 * misspelled key. Without it, `dispositionGap` for `dispositionGapThreshold` would read as
 * "not declared" and the operator would see a missing threshold they believe they supplied.
 * The test pins the reported key set, so adding a field to the type below without adding it
 * here fails rather than silently going un-echoed.
 */
export const FINANCE_BEHAVIOUR_THRESHOLD_KEYS = [
  "dispositionGapThreshold",
  "maxFillsPerDay",
  "momentumMovePercent",
  "momentumShareThreshold",
  "roundLevelTolerancePercent",
  "anchorShareThreshold",
] as const;
export type FinanceBehaviourThresholdKey = (typeof FINANCE_BEHAVIOUR_THRESHOLD_KEYS)[number];

export type FinanceBehaviourThresholds = Readonly<{
  /** Minimum `PGR - PLR` before `disposition_effect` may be labelled. */
  dispositionGapThreshold?: number;
  /** Fills per day above which `turnover` may be labelled. */
  maxFillsPerDay?: number;
  /** Percent move against the last prior mark that counts as "into strength". */
  momentumMovePercent?: number;
  /** Minimum share of measured buys into strength before `momentum_chasing` may be labelled. */
  momentumShareThreshold?: number;
  /** Percent distance from a round level that still counts as "on" it. */
  roundLevelTolerancePercent?: number;
  /** Minimum share of fills on round levels before `anchoring` may be labelled. */
  anchorShareThreshold?: number;
}>;

export type FinanceBehaviourThresholdsParse =
  | Readonly<{ ok: true; thresholds: FinanceBehaviourThresholds }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Validate a caller-supplied thresholds object.
 *
 * Pure, and it **returns a result instead of throwing**, because the two callers need different
 * failure behaviour from the same rules. The operator entry has nothing to report when its
 * declaration is broken, so it turns a failure into an error and stops. The agent read tool must
 * still return the positions — a broken declaration is not a reason to make the book unreadable —
 * so it reports the reason beside them. Writing the rules twice to get those two behaviours is
 * how the two sides would come to disagree about what a valid declaration is.
 *
 * Unknown keys are refused rather than ignored. A misspelled key (`dispositionGap` for
 * `dispositionGapThreshold`) is silently ignored by `buildFinanceBehaviourProfile`, which then
 * reports "thresholds.dispositionGapThreshold was not declared". An owner who did supply a
 * number reads that as "my threshold was not met". Refusing the object turns a misreading into a
 * named error. Values are checked for the same reason: a threshold the module cannot compare
 * against is worse than a missing one, because it looks declared.
 */
export function parseFinanceBehaviourThresholds(
  value: unknown,
  source: string,
): FinanceBehaviourThresholdsParse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `${source} must contain a JSON object of behaviour thresholds` };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !(FINANCE_BEHAVIOUR_THRESHOLD_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error:
        `${source} has unknown behaviour threshold key(s): ${unknownKeys.join(", ")}; ` +
        `known keys are ${FINANCE_BEHAVIOUR_THRESHOLD_KEYS.join(", ")}`,
    };
  }
  const thresholds: Record<string, number> = {};
  for (const key of FINANCE_BEHAVIOUR_THRESHOLD_KEYS) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      return {
        ok: false,
        error: `${source}: ${key} must be a positive finite number, received: ${JSON.stringify(raw)}`,
      };
    }
    thresholds[key] = raw;
  }
  return { ok: true, thresholds: Object.freeze(thresholds) as FinanceBehaviourThresholds };
}

export type FinanceBehaviourProfileOptions = Readonly<{
  receipts: readonly FinanceExecutionReceipt[];
  marks?: readonly FinancePositionMark[];
  /** Declared thresholds. A measure without a declared threshold reports numbers but no label. */
  thresholds?: FinanceBehaviourThresholds;
  /**
   * Minimum observations before a share-based label may be produced. Defaults to 3.
   * This is a statistical floor rather than a judgement, so it is not required to be declared.
   */
  minObservations?: number;
}>;

export type FinanceBehaviourLabel = Readonly<{
  /** Stable id. Descriptive, never an instruction. */
  id: string;
  /** One sentence stating what was observed over the recorded fills. */
  statement: string;
  /** The measured numbers behind the label, so a reader can disagree with the reading. */
  evidence: Readonly<Record<string, number>>;
}>;

export type FinanceBehaviourFinding = Readonly<{
  dimension: FinanceBehaviourDimensionId;
  /** `null` whenever no threshold was declared or the sample cannot support a reading. */
  label: FinanceBehaviourLabel | null;
  /** Present exactly when `label` is null. Names the reason instead of implying zero. */
  unavailableReason: string | null;
  /** How many observations stood behind the reading. Always reported. */
  observations: Readonly<Record<string, number>>;
}>;

export type FinanceBehaviourProfile = Readonly<{
  schemaVersion: typeof FINANCE_BEHAVIOUR_PROFILE_SCHEMA;
  receiptCount: number;
  /**
   * The paper/venue split of the measured stream, carried over from the ledger projection.
   *
   * The ledger keeps these apart so a simulated fill is never read as a market observation.
   * The labels below are computed over both, which is a deliberate choice rather than an
   * oversight — but a reader cannot tell a real behaviour profile from a simulated one without
   * these two numbers, so they travel with it.
   */
  paperFillCount: number;
  venueFillCount: number;
  markCount: number;
  /**
   * Marks the projection discarded for a missing timestamp or a non-positive price.
   *
   * `markCount` counts what the caller supplied; this counts what was dropped. Without it,
   * `markCount: 5` reads as "five marks informed the profile" when three did, and the reader
   * cannot tell a rejected mark from a mark that simply fell after every fill.
   */
  rejectedMarkCount: number;
  instruments: readonly string[];
  /** Earliest and latest `filledAt` across the stream. `null` when there are no receipts. */
  observedFrom: string | null;
  observedTo: string | null;
  dimensions: readonly FinanceBehaviourFinding[];
  /** Echo of what the caller declared, so "above threshold" can be checked by the reader. */
  declaredThresholds: Readonly<Record<string, number | null>>;
  minObservations: number;
  /** Pinned `false`: this module measures the owner's behaviour, it does not advise. */
  advice: false;
  interpretationBoundary: string;
}>;

const INTERPRETATION_BOUNDARY =
  "These are descriptive labels over recorded fills and marks. They are not investment advice, " +
  "not a performance claim, and not evidence that any behaviour caused any outcome. A label is " +
  "absent when the sample or the declared threshold does not support it. Labels are computed " +
  "across every recorded fill, so the paper/venue mix is reported alongside them: a profile " +
  "drawn mostly from simulated fills describes the simulation as much as the owner.";

/**
 * One wording for "there was nothing to measure", shared by all four dimensions.
 *
 * A fresh install has no receipts, which makes this the most common state a reader will meet
 * first. Four different vacuous sentences ("no realised or paper gains were observed", "no
 * receipt carried a positive finite fill price") would each be technically true and together
 * would read as four separate problems. The cause is one: the stream is empty.
 */
const EMPTY_STREAM_REASON = "no receipts were supplied, so this dimension cannot be measured yet";

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeInstrument(instrument: string): string {
  return instrument.trim().toUpperCase();
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function notDeclared(name: string): string {
  return `${name} was not declared, so no label is produced; the measured numbers are reported below`;
}

/* -------------------------------------------------------------------------- */
/* Disposition effect                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Odean's proportion of gains realised (PGR) versus proportion of losses realised (PLR).
 *
 * The ledger's own projection already splits each instrument into a realised part (closed
 * quantity) and an open part (quantity still held, valued at the latest mark). That split is
 * exactly what PGR/PLR needs, so this module re-uses it instead of re-deriving fill math —
 * one fill-matching rule in the repository, not two.
 */
function buildDispositionFinding(
  positions: readonly FinancePosition[],
  thresholds: FinanceBehaviourThresholds,
  minObservations: number,
): FinanceBehaviourFinding {
  if (positions.length === 0) {
    return {
      dimension: "disposition_effect",
      label: null,
      unavailableReason: EMPTY_STREAM_REASON,
      observations: {
        realizedGains: 0,
        realizedLosses: 0,
        paperGains: 0,
        paperLosses: 0,
        openPositionsWithoutMark: 0,
      },
    };
  }

  let realizedGains = 0;
  let realizedLosses = 0;
  let paperGains = 0;
  let paperLosses = 0;
  let openWithoutMark = 0;

  for (const position of positions) {
    if (position.quantity === 0) {
      if (position.realizedPnl > 0) {
        realizedGains += 1;
      } else if (position.realizedPnl < 0) {
        realizedLosses += 1;
      }
      continue;
    }
    if (position.unrealizedPnl === undefined) {
      // An open position with no usable mark. Counting it as a paper loss or gain would
      // invent a price, so it is excluded and the exclusion is reported.
      openWithoutMark += 1;
      continue;
    }
    if (position.unrealizedPnl > 0) {
      paperGains += 1;
    } else if (position.unrealizedPnl < 0) {
      paperLosses += 1;
    }
  }

  const observations = {
    realizedGains,
    realizedLosses,
    paperGains,
    paperLosses,
    openPositionsWithoutMark: openWithoutMark,
  };

  const realizedDenominator = realizedGains + paperGains;
  const paperDenominator = realizedLosses + paperLosses;
  if (realizedDenominator === 0 || paperDenominator === 0) {
    return {
      dimension: "disposition_effect",
      label: null,
      unavailableReason:
        realizedDenominator === 0
          ? "no realised or paper gains were observed, so PGR has no denominator"
          : "no realised or paper losses were observed, so PLR has no denominator",
      observations,
    };
  }

  const pgr = realizedGains / realizedDenominator;
  const plr = realizedLosses / paperDenominator;
  const gap = pgr - plr;
  const evidence = { pgr: round6(pgr), plr: round6(plr), gap: round6(gap) };
  const totalClosed = realizedGains + realizedLosses;

  if (totalClosed < minObservations) {
    return {
      dimension: "disposition_effect",
      label: null,
      unavailableReason: `only ${totalClosed} closed instrument(s) observed; at least ${minObservations} are required before a label is produced`,
      observations,
    };
  }

  const declared = thresholds.dispositionGapThreshold;
  if (declared === undefined) {
    return {
      dimension: "disposition_effect",
      label: null,
      unavailableReason: notDeclared("thresholds.dispositionGapThreshold"),
      observations,
    };
  }
  if (gap < declared) {
    return {
      dimension: "disposition_effect",
      label: null,
      unavailableReason: `PGR - PLR is ${round6(gap)}, below the declared threshold ${declared}`,
      observations,
    };
  }

  return {
    dimension: "disposition_effect",
    label: {
      id: "realized_gains_kept_losers",
      statement: `Gains were closed at a higher rate than losses: PGR ${round6(pgr)} versus PLR ${round6(plr)} over ${totalClosed} closed instrument(s).`,
      evidence,
    },
    unavailableReason: null,
    observations,
  };
}

/* -------------------------------------------------------------------------- */
/* Turnover                                                                   */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 86_400_000;

function buildTurnoverFinding(
  receipts: readonly FinanceExecutionReceipt[],
  thresholds: FinanceBehaviourThresholds,
  minObservations: number,
): FinanceBehaviourFinding {
  if (receipts.length === 0) {
    return {
      dimension: "turnover",
      label: null,
      unavailableReason: EMPTY_STREAM_REASON,
      observations: { receipts: 0, notionalTurnover: 0 },
    };
  }

  const fillTimes = receipts
    .map((receipt) => Date.parse(receipt.fill.filledAt))
    .filter((value) => Number.isFinite(value));
  const notionalTurnover = receipts.reduce(
    (total, receipt) => total + Math.abs(receipt.notional),
    0,
  );

  if (fillTimes.length === 0) {
    return {
      dimension: "turnover",
      label: null,
      unavailableReason: "no receipt carried a parseable fill time, so no span can be measured",
      observations: { receipts: receipts.length, notionalTurnover: round6(notionalTurnover) },
    };
  }

  const from = Math.min(...fillTimes);
  const to = Math.max(...fillTimes);
  const spanDays = (to - from) / MS_PER_DAY;
  const observations = {
    receipts: receipts.length,
    spanDays: round6(spanDays),
    notionalTurnover: round6(notionalTurnover),
  };

  if (spanDays === 0) {
    return {
      dimension: "turnover",
      label: null,
      // Every fill shares one instant, so "per day" has no meaning rather than an infinite value.
      unavailableReason:
        "every fill shares one timestamp, so a per-day rate has no denominator; notional turnover is reported instead",
      observations,
    };
  }

  const fillsPerDay = receipts.length / spanDays;
  const withRate = { ...observations, fillsPerDay: round6(fillsPerDay) };
  const declared = thresholds.maxFillsPerDay;

  if (receipts.length < minObservations) {
    return {
      dimension: "turnover",
      label: null,
      unavailableReason: `only ${receipts.length} fill(s) observed; at least ${minObservations} are required before a label is produced`,
      observations: withRate,
    };
  }
  if (declared === undefined) {
    return {
      dimension: "turnover",
      label: null,
      unavailableReason: notDeclared("thresholds.maxFillsPerDay"),
      observations: withRate,
    };
  }
  if (fillsPerDay <= declared) {
    return {
      dimension: "turnover",
      label: null,
      unavailableReason: `${round6(fillsPerDay)} fills/day is at or below the declared budget ${declared}`,
      observations: withRate,
    };
  }

  return {
    dimension: "turnover",
    label: {
      id: "turnover_above_declared_budget",
      statement: `${receipts.length} fills over ${round6(spanDays)} day(s) is ${round6(fillsPerDay)} fills/day, above the declared budget of ${declared}.`,
      evidence: { fillsPerDay: round6(fillsPerDay), spanDays: round6(spanDays) },
    },
    unavailableReason: null,
    observations: withRate,
  };
}

/* -------------------------------------------------------------------------- */
/* Momentum chasing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Index marks by instrument in time order, so "the last mark seen before this fill" is a
 * lookup rather than a scan. Marks are not deduplicated: two marks at the same instant stay
 * two observations, because dropping one would be an edit the caller did not ask for.
 */
function indexMarksByInstrument(
  marks: readonly FinancePositionMark[],
): Map<string, readonly FinancePositionMark[]> {
  const byInstrument = new Map<string, FinancePositionMark[]>();
  for (const mark of marks) {
    if (!isFinitePositive(mark.price) || mark.at.trim().length === 0) {
      continue;
    }
    const instrument = normalizeInstrument(mark.instrument);
    if (instrument.length === 0) {
      continue;
    }
    const bucket = byInstrument.get(instrument);
    if (bucket === undefined) {
      byInstrument.set(instrument, [mark]);
    } else {
      bucket.push(mark);
    }
  }
  for (const bucket of byInstrument.values()) {
    bucket.sort((left, right) => left.at.localeCompare(right.at));
  }
  return byInstrument;
}

function lastMarkAtOrBefore(
  bucket: readonly FinancePositionMark[] | undefined,
  filledAt: string,
): FinancePositionMark | null {
  if (bucket === undefined) {
    return null;
  }
  let found: FinancePositionMark | null = null;
  for (const mark of bucket) {
    if (mark.at.localeCompare(filledAt) > 0) {
      break;
    }
    found = mark;
  }
  return found;
}

function buildMomentumFinding(
  receipts: readonly FinanceExecutionReceipt[],
  marks: readonly FinancePositionMark[],
  thresholds: FinanceBehaviourThresholds,
  minObservations: number,
): FinanceBehaviourFinding {
  if (receipts.length === 0) {
    return {
      dimension: "momentum_chasing",
      label: null,
      unavailableReason: EMPTY_STREAM_REASON,
      observations: {
        buys: 0,
        buysWithPriorMark: 0,
        buysWithoutPriorMark: 0,
        sellsWithPriorMark: 0,
        sellsIntoWeakness: 0,
      },
    };
  }

  const byInstrument = indexMarksByInstrument(marks);
  const ordered = receipts.toSorted((left, right) =>
    left.recordedAt === right.recordedAt
      ? left.receiptId.localeCompare(right.receiptId)
      : left.recordedAt.localeCompare(right.recordedAt),
  );

  let buys = 0;
  let buysWithoutPriorMark = 0;
  let buysIntoStrength = 0;
  let sells = 0;
  let sellsIntoWeakness = 0;
  const moves: number[] = [];

  for (const receipt of ordered) {
    if (receipt.side !== "buy") {
      continue;
    }
    buys += 1;
    const prior = lastMarkAtOrBefore(
      byInstrument.get(normalizeInstrument(receipt.instrument)),
      receipt.fill.filledAt,
    );
    if (prior === null) {
      buysWithoutPriorMark += 1;
      continue;
    }
    const movePercent = (receipt.fill.fillPrice / prior.price - 1) * 100;
    moves.push(movePercent);
  }

  // The sell side is measured separately so a one-sided stream is not read as an absent one.
  for (const receipt of ordered) {
    if (receipt.side !== "sell") {
      continue;
    }
    const prior = lastMarkAtOrBefore(
      byInstrument.get(normalizeInstrument(receipt.instrument)),
      receipt.fill.filledAt,
    );
    if (prior === null) {
      continue;
    }
    sells += 1;
    if (receipt.fill.fillPrice < prior.price) {
      sellsIntoWeakness += 1;
    }
  }

  const measuredBuys = moves.length;
  const observations = {
    buys,
    buysWithPriorMark: measuredBuys,
    buysWithoutPriorMark,
    sellsWithPriorMark: sells,
    sellsIntoWeakness,
  };

  if (measuredBuys === 0) {
    return {
      dimension: "momentum_chasing",
      label: null,
      unavailableReason:
        "no buy had a mark at or before its fill time, so the price it moved against cannot be established",
      observations,
    };
  }

  const declaredMove = thresholds.momentumMovePercent;
  if (declaredMove === undefined) {
    return {
      dimension: "momentum_chasing",
      label: null,
      unavailableReason: notDeclared("thresholds.momentumMovePercent"),
      observations: { ...observations, meanBuyMovePercent: round6(mean(moves)) },
    };
  }

  for (const move of moves) {
    if (move >= declaredMove) {
      buysIntoStrength += 1;
    }
  }
  const share = buysIntoStrength / measuredBuys;
  const withShare = {
    ...observations,
    buysIntoStrength,
    shareIntoStrength: round6(share),
    meanBuyMovePercent: round6(mean(moves)),
  };

  if (measuredBuys < minObservations) {
    return {
      dimension: "momentum_chasing",
      label: null,
      unavailableReason: `only ${measuredBuys} buy(s) had a prior mark; at least ${minObservations} are required before a label is produced`,
      observations: withShare,
    };
  }

  const declaredShare = thresholds.momentumShareThreshold;
  if (declaredShare === undefined) {
    return {
      dimension: "momentum_chasing",
      label: null,
      unavailableReason: notDeclared("thresholds.momentumShareThreshold"),
      observations: withShare,
    };
  }
  if (share < declaredShare) {
    return {
      dimension: "momentum_chasing",
      label: null,
      unavailableReason: `${round6(share)} of measured buys were into strength, below the declared share ${declaredShare}`,
      observations: withShare,
    };
  }

  return {
    dimension: "momentum_chasing",
    label: {
      id: "buys_follow_a_prior_rise",
      statement: `${buysIntoStrength} of ${measuredBuys} measured buys filled at or above ${declaredMove}% above the last mark seen before them.`,
      evidence: { shareIntoStrength: round6(share), buysIntoStrength, measuredBuys },
    },
    unavailableReason: null,
    observations: withShare,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/* -------------------------------------------------------------------------- */
/* Anchoring                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Distance from the nearest round level, expressed as a percent of the price.
 *
 * The grid is one order of magnitude below the price itself (123 → steps of 10, 12.3 → steps
 * of 1), so the same rule reads sensibly across instruments of very different scale. This is
 * the usual round-number proxy for anchoring; it measures price clustering, not intent.
 */
function distanceToRoundLevelPercent(price: number): number {
  const magnitude = Math.floor(Math.log10(price));
  const step = 10 ** (magnitude - 1);
  if (!Number.isFinite(step) || step <= 0) {
    return Number.NaN;
  }
  const nearest = Math.round(price / step) * step;
  return (Math.abs(price - nearest) / price) * 100;
}

function buildAnchoringFinding(
  receipts: readonly FinanceExecutionReceipt[],
  thresholds: FinanceBehaviourThresholds,
  minObservations: number,
): FinanceBehaviourFinding {
  if (receipts.length === 0) {
    return {
      dimension: "anchoring",
      label: null,
      unavailableReason: EMPTY_STREAM_REASON,
      observations: { fills: 0 },
    };
  }

  const distances = receipts
    .map((receipt) => distanceToRoundLevelPercent(receipt.fill.fillPrice))
    .filter((value) => Number.isFinite(value));

  if (distances.length === 0) {
    return {
      dimension: "anchoring",
      label: null,
      unavailableReason: "no receipt carried a positive finite fill price",
      observations: { fills: receipts.length },
    };
  }

  const declaredTolerance = thresholds.roundLevelTolerancePercent;
  const observations = {
    fills: receipts.length,
    measurableFills: distances.length,
    meanDistancePercent: round6(mean(distances)),
  };

  if (distances.length < minObservations) {
    return {
      dimension: "anchoring",
      label: null,
      unavailableReason: `only ${distances.length} fill(s) had a measurable distance to a round level; at least ${minObservations} are required`,
      observations,
    };
  }
  if (declaredTolerance === undefined) {
    return {
      dimension: "anchoring",
      label: null,
      unavailableReason: notDeclared("thresholds.roundLevelTolerancePercent"),
      observations,
    };
  }

  const onRoundLevel = distances.filter((value) => value <= declaredTolerance).length;
  const share = onRoundLevel / distances.length;
  const withShare = { ...observations, onRoundLevel, shareOnRoundLevel: round6(share) };
  const declaredShare = thresholds.anchorShareThreshold;

  if (declaredShare === undefined) {
    return {
      dimension: "anchoring",
      label: null,
      unavailableReason: notDeclared("thresholds.anchorShareThreshold"),
      observations: withShare,
    };
  }
  if (share < declaredShare) {
    return {
      dimension: "anchoring",
      label: null,
      unavailableReason: `${round6(share)} of fills sat within ${declaredTolerance}% of a round level, below the declared share ${declaredShare}`,
      observations: withShare,
    };
  }

  return {
    dimension: "anchoring",
    label: {
      id: "fills_cluster_on_round_levels",
      statement: `${onRoundLevel} of ${distances.length} fills sat within ${declaredTolerance}% of a round level.`,
      evidence: {
        shareOnRoundLevel: round6(share),
        onRoundLevel,
        measurableFills: distances.length,
      },
    },
    unavailableReason: null,
    observations: withShare,
  };
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the profile. Pure: same inputs, same output, no store, no clock, no randomness.
 *
 * `projectFinancePositions` is called once and its result feeds the disposition dimension, so
 * the fill-matching rule used here is the same rule the ledger reports positions with.
 */
export function buildFinanceBehaviourProfile(
  options: FinanceBehaviourProfileOptions,
): FinanceBehaviourProfile {
  const thresholds = options.thresholds ?? {};
  const minObservations = options.minObservations ?? 3;
  const marks = options.marks ?? [];
  const ledger = projectFinancePositions({ receipts: options.receipts, marks });

  const fillTimes = options.receipts
    .map((receipt) => receipt.fill.filledAt)
    .filter((value) => value.trim().length > 0)
    .toSorted((left, right) => left.localeCompare(right));

  const declaredThresholds: Record<string, number | null> = {};
  for (const key of FINANCE_BEHAVIOUR_THRESHOLD_KEYS) {
    declaredThresholds[key] = thresholds[key] ?? null;
  }

  return {
    schemaVersion: FINANCE_BEHAVIOUR_PROFILE_SCHEMA,
    receiptCount: options.receipts.length,
    paperFillCount: ledger.paperFillCount,
    venueFillCount: ledger.venueFillCount,
    markCount: marks.length,
    rejectedMarkCount: ledger.rejectedMarks.length,
    instruments: ledger.positions.map((position) => position.instrument).toSorted(),
    observedFrom: fillTimes.length === 0 ? null : (fillTimes[0] ?? null),
    observedTo: fillTimes.length === 0 ? null : (fillTimes[fillTimes.length - 1] ?? null),
    dimensions: [
      buildDispositionFinding(ledger.positions, thresholds, minObservations),
      buildTurnoverFinding(options.receipts, thresholds, minObservations),
      buildMomentumFinding(options.receipts, marks, thresholds, minObservations),
      buildAnchoringFinding(options.receipts, thresholds, minObservations),
    ],
    declaredThresholds,
    minObservations,
    advice: false,
    interpretationBoundary: INTERPRETATION_BOUNDARY,
  };
}
