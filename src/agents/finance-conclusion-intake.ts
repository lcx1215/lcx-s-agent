/**
 * Intake for a research conclusion, and calibration of the conviction it claims.
 *
 * Two problems are solved here, and they are the same problem seen twice: how
 * much should a conclusion be trusted?
 *
 * 1. Intake. A model emits JSON. This validates it into a
 *    `FinanceResearchConclusion` rather than casting it and hoping. Every field
 *    the compiler needs is required here, because a missing field that reaches
 *    the compiler would be refused anyway - better to refuse at the door with a
 *    reason the caller can act on.
 *
 * 2. Calibration. A model will happily report "0.8 confident". That number is
 *    uncalibrated: it sounds reasonable and means nothing. So the claim is
 *    recorded alongside what actually happened, and the gap between the two
 *    raises the bar next time. A system that never checks whether its own
 *    confidence means anything will keep acting on noise at full size.
 *
 * Evidence is required, not optional. A conclusion with no cited source cannot
 * be distinguished from one the model invented, and an invented conclusion that
 * is well-formed passes every other check in the chain.
 */

import type { FinanceConclusionDirection } from "./finance-intent-compiler.js";

export type FinanceEvidenceRef = Readonly<{
  /** Where this came from. A bare label is allowed; a URL is better. */
  sourceId: string;
  url?: string;
  publishedAt?: string;
}>;

export type FinanceIntakeConclusion = Readonly<{
  conclusionId: string;
  instrument: string;
  direction: FinanceConclusionDirection;
  conviction: number;
  thesis: string;
  assetClass: string;
  evidence: readonly FinanceEvidenceRef[];
  horizonDays?: number;
  invalidationPrice?: number;
  invalidationCondition?: string;
  targetPrice?: number;
}>;

export type FinanceIntakeResult = Readonly<
  | { ok: true; conclusion: FinanceIntakeConclusion; notes: readonly string[] }
  | { ok: false; refusals: readonly string[] }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseResearchConclusion(
  raw: unknown,
  options: {
    minSources?: number;
    /**
     * The track record this claim should be judged against.
     *
     * Without it a conclusion is taken at its own word: the model says 0.7 and
     * the floor is compared against 0.7, even if the model has historically
     * claimed 0.7 and delivered 0.5. The calibration functions in this file
     * existed for exactly this and had no caller, so the adjustment was computed
     * nowhere and applied nowhere.
     *
     * Omitted means unadjusted, which is what callers that have no history yet
     * should get - it is not a silent default of "trust the model".
     */
    calibrationRecords?: readonly FinanceCalibrationRecord[];
    /** The floor before adjustment. Required alongside calibrationRecords. */
    baseFloor?: number;
  } = {},
): FinanceIntakeResult {
  const minSources = options.minSources ?? 2;
  const refusals: string[] = [];
  const notes: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, refusals: ["refuse: the conclusion is not an object"] };
  }

  const conclusionId = typeof raw.conclusionId === "string" ? raw.conclusionId.trim() : "";
  if (!conclusionId) {
    refusals.push("refuse: conclusionId is missing");
  }

  const instrument = typeof raw.instrument === "string" ? raw.instrument.trim().toUpperCase() : "";
  if (!instrument) {
    refusals.push("refuse: instrument is missing");
  }

  const direction = raw.direction;
  if (direction !== "buy" && direction !== "sell") {
    refusals.push(
      `refuse: direction must be buy or sell (got ${typeof direction === "string" ? direction : "none"})`,
    );
  }

  const conviction = typeof raw.conviction === "number" ? raw.conviction : Number.NaN;
  if (!Number.isFinite(conviction)) {
    refusals.push("refuse: conviction is missing or not a number");
  } else if (conviction < 0 || conviction > 1) {
    refusals.push("refuse: conviction must be between 0 and 1");
  }

  // The calibration gate: a conviction is judged against what this system has
  // actually delivered, not against what it just claimed.
  let adjustedFloor: number | null = null;
  if (options.calibrationRecords !== undefined && options.baseFloor !== undefined) {
    adjustedFloor = calibrationAdjustedFloor(options.baseFloor, options.calibrationRecords);
    if (Number.isFinite(conviction) && conviction < adjustedFloor) {
      refusals.push(
        "refuse: conviction " +
          conviction.toFixed(2) +
          " is below the calibrated floor " +
          adjustedFloor.toFixed(2) +
          " (base " +
          options.baseFloor.toFixed(2) +
          " raised by the measured overconfidence gap); this system has been claiming more " +
          "than it delivers, so its own number does not clear the bar it set",
      );
    }
  }

  const thesis = typeof raw.thesis === "string" ? raw.thesis.trim() : "";
  if (!thesis) {
    refusals.push("refuse: thesis is missing; an order needs a stated reason");
  }

  const assetClass = typeof raw.assetClass === "string" ? raw.assetClass.trim() : "";
  if (!assetClass) {
    refusals.push("refuse: assetClass is missing, so the strategy class cannot be determined");
  }

  // Evidence. Counted by distinct source so quoting one document three times
  // does not become three independent sources.
  const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  const sources = new Set<string>();
  for (const item of rawEvidence) {
    if (!isRecord(item)) {
      continue;
    }
    const sourceId = typeof item.sourceId === "string" ? item.sourceId.trim() : "";
    if (sourceId) {
      sources.add(sourceId);
    }
  }
  const evidence: FinanceEvidenceRef[] = rawEvidence
    .filter(isRecord)
    .map((item) => ({
      // Typed rather than String(...): coercing an unknown here could quietly
      // turn an object into "[object Object]" and pass it off as a source.
      sourceId: typeof item.sourceId === "string" ? item.sourceId : "",
      ...(typeof item.url === "string" ? { url: item.url } : {}),
      ...(typeof item.publishedAt === "string" ? { publishedAt: item.publishedAt } : {}),
    }))
    .filter((item) => item.sourceId.length > 0);

  if (sources.size < minSources) {
    refusals.push(
      `refuse: ${sources.size} distinct source(s) cited, ${minSources} required; a single source must not decide a trade`,
    );
  }

  if (refusals.length > 0) {
    return { ok: false, refusals };
  }

  if (sources.size < rawEvidence.length) {
    notes.push(
      `${rawEvidence.length - sources.size} evidence item(s) collapsed as duplicate sources`,
    );
  }

  return {
    ok: true,
    notes,
    conclusion: {
      conclusionId,
      instrument,
      direction: direction as FinanceConclusionDirection,
      conviction,
      thesis,
      assetClass,
      evidence,
      ...(typeof raw.horizonDays === "number" && Number.isFinite(raw.horizonDays)
        ? { horizonDays: raw.horizonDays }
        : {}),
      ...(typeof raw.invalidationPrice === "number" && Number.isFinite(raw.invalidationPrice)
        ? { invalidationPrice: raw.invalidationPrice }
        : {}),
      ...(typeof raw.invalidationCondition === "string"
        ? { invalidationCondition: raw.invalidationCondition }
        : {}),
      ...(typeof raw.targetPrice === "number" && Number.isFinite(raw.targetPrice)
        ? { targetPrice: raw.targetPrice }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export type FinanceCalibrationRecord = Readonly<{
  /** What the model claimed, 0..1. */
  claimedProbability: number;
  /** What happened: 1 if the call worked out, 0 if it did not. */
  outcome: 0 | 1;
}>;

/**
 * Brier score: mean squared error of the claimed probabilities.
 * 0 is perfect, 0.25 is what always saying "50/50" scores, 1 is always wrong.
 *
 * Returns null with no records rather than 0, because 0 would read as perfect.
 */
export function brierScore(records: readonly FinanceCalibrationRecord[]): number | null {
  if (records.length === 0) {
    return null;
  }
  const total = records.reduce(
    (sum, record) => sum + (record.claimedProbability - record.outcome) ** 2,
    0,
  );
  return total / records.length;
}

/** Mean claimed probability minus the realized hit rate. Positive = overconfident. */
export function overconfidenceGap(records: readonly FinanceCalibrationRecord[]): number | null {
  if (records.length === 0) {
    return null;
  }
  const claimed = records.reduce((sum, r) => sum + r.claimedProbability, 0) / records.length;
  const realized = records.reduce((sum, r) => sum + r.outcome, 0) / records.length;
  return claimed - realized;
}

/**
 * Raise the conviction floor by however far the model has been overselling
 * itself. A model that claims 0.8 and delivers 0.5 is not "confident" - it is
 * miscalibrated, and acting on its number at face value sizes trades off a
 * fiction.
 */
export function calibrationAdjustedFloor(
  baseFloor: number,
  records: readonly FinanceCalibrationRecord[],
): number {
  const gap = overconfidenceGap(records);
  if (gap === null || gap <= 0) {
    return baseFloor;
  }
  return Math.min(0.95, baseFloor + gap);
}
