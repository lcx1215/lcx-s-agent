/**
 * Derive a directional-calibration floor from observed forecast outcomes.
 *
 * This owner answers one question only: from what claimed conviction upward
 * has directional hit rate met a declared classification baseline? A right/wrong
 * label contains no payoff size, transaction costs, or execution evidence, so it
 * cannot establish economic break-even or trading profitability.
 *
 * The default 0.5 is a coin-flip classification reference, not an economic
 * break-even estimate. When no bucket meets the declared baseline, the answer
 * is null rather than an invented fallback.
 */

export type DirectionalOutcomeSample = Readonly<{
  /** What the system claimed, 0..1. */
  conviction: number;
  /** 1 if the forecast direction was right, 0 if not. */
  outcome: 0 | 1;
}>;

/** @deprecated Use DirectionalOutcomeSample to distinguish forecasts from trade P&L. */
export type FloorSample = DirectionalOutcomeSample;

export type DirectionalCalibrationFloor = Readonly<{
  /** The derived floor, or null when the data cannot support one. */
  floor: number | null;
  samplesUsed: number;
  /** What the floor rests on, or why there isn't one. */
  basis: string;
  /** Per-bucket evidence, so the number can be argued with. */
  buckets: readonly { from: number; to: number; n: number; hitRate: number }[];
}>;

/** @deprecated Use DirectionalCalibrationFloor for forecast accuracy only. */
export type CalibratedFloor = DirectionalCalibrationFloor;

export function deriveDirectionalCalibrationFloor(
  samples: readonly DirectionalOutcomeSample[],
  options: {
    /** Directional hit-rate classification baseline. Default 0.5; not trade break-even. */
    minimumHitRate?: number;
    /** Samples a bucket needs before its hit rate means anything. Default 5. */
    minBucketSamples?: number;
    /** Bucket width in conviction. Default 0.05. */
    bucketWidth?: number;
  } = {},
): DirectionalCalibrationFloor {
  const minimumHitRate = options.minimumHitRate ?? 0.5;
  const minBucketSamples = options.minBucketSamples ?? 5;
  const bucketWidth = options.bucketWidth ?? 0.05;

  const usable = samples.filter(
    (sample) =>
      Number.isFinite(sample.conviction) &&
      sample.conviction >= 0 &&
      sample.conviction <= 1 &&
      (sample.outcome === 0 || sample.outcome === 1),
  );

  if (usable.length === 0) {
    return {
      floor: null,
      samplesUsed: 0,
      basis:
        "no scored samples with valid directional outcomes; refusing to invent a calibration floor",
      buckets: [],
    };
  }

  const buckets = new Map<number, { n: number; wins: number }>();
  for (const sample of usable) {
    // Avoid moving exact decimal boundaries down a bucket through binary rounding.
    const index = Math.min(
      Math.floor(sample.conviction / bucketWidth + 1e-9),
      Math.ceil(1 / bucketWidth) - 1,
    );
    const bucket = buckets.get(index) ?? { n: 0, wins: 0 };
    bucket.n += 1;
    bucket.wins += sample.outcome;
    buckets.set(index, bucket);
  }

  const rows = [...buckets.entries()]
    .map(([index, bucket]) => ({
      from: Number((index * bucketWidth).toFixed(4)),
      to: Number(((index + 1) * bucketWidth).toFixed(4)),
      n: bucket.n,
      hitRate: bucket.wins / bucket.n,
    }))
    .toSorted((left, right) => left.from - right.from);

  const qualifying = rows.filter(
    (row) => row.n >= minBucketSamples && row.hitRate >= minimumHitRate,
  );

  if (qualifying.length === 0) {
    return {
      floor: null,
      samplesUsed: usable.length,
      basis:
        usable.length +
        " directional sample(s) across " +
        rows.length +
        " bucket(s), but none met the directional hit-rate baseline (" +
        minimumHitRate +
        ") on at least " +
        minBucketSamples +
        " observations; no calibration floor can be justified",
      buckets: rows,
    };
  }

  // Require the observed relationship to remain monotonic above the proposed floor.
  const lowest = Math.min(...qualifying.map((row) => row.from));
  const atOrAbove = rows.filter((row) => row.from >= lowest && row.n >= minBucketSamples);
  const allHold = atOrAbove.every((row) => row.hitRate >= minimumHitRate);

  if (!allHold) {
    return {
      floor: null,
      samplesUsed: usable.length,
      basis:
        "a lower conviction bucket meets the directional hit-rate baseline but a higher one does not; " +
        "the relationship is not monotonic yet",
      buckets: rows,
    };
  }

  return {
    floor: Number(lowest.toFixed(4)),
    samplesUsed: usable.length,
    basis:
      "lowest conviction bucket meeting the directional hit-rate baseline (" +
      minimumHitRate +
      ") on >= " +
      minBucketSamples +
      " observations, with every sufficiently sampled bucket above it also meeting that baseline",
    buckets: rows,
  };
}

/**
 * Compatibility entry point for older callers. The old name implied an
 * economic conclusion that binary directional outcomes cannot support.
 */
export function breakEvenFloor(
  samples: readonly FloorSample[],
  options: {
    breakEvenHitRate?: number;
    minBucketSamples?: number;
    bucketWidth?: number;
  } = {},
): CalibratedFloor {
  return deriveDirectionalCalibrationFloor(samples, {
    ...(options.breakEvenHitRate === undefined ? {} : { minimumHitRate: options.breakEvenHitRate }),
    ...(options.minBucketSamples === undefined
      ? {}
      : { minBucketSamples: options.minBucketSamples }),
    ...(options.bucketWidth === undefined ? {} : { bucketWidth: options.bucketWidth }),
  });
}
