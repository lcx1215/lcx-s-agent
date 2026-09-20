/**
 * Derive the conviction floor from observed outcomes instead of inventing one.
 *
 * The floor that has been gating every trade up to now was a constant picked
 * while writing the class rules. Nothing derived it, nothing validated it, and
 * it silently decided that no trade would ever happen. A number like that is not
 * a risk control, it is an opinion with veto power.
 *
 * The floor should answer one question: from what conviction upward has this
 * system actually broken even? Below that point, taking the trade destroys
 * money on average, however confident it sounds.
 *
 * So the samples are bucketed by claimed conviction and each bucket's realised
 * hit rate is compared against break-even. The floor is the lowest conviction
 * that has demonstrated it.
 *
 * When no bucket has demonstrated break-even, the answer is null - not a
 * fallback constant. Falling back to a guessed number in the absence of
 * evidence is exactly the failure this replaces. A caller holding null should
 * decline to trade, or trade only in a mode whose stated purpose is to produce
 * the evidence that is missing.
 */

export type FloorSample = Readonly<{
  /** What the system claimed, 0..1. */
  conviction: number;
  /** 1 if the call was right, 0 if not. */
  outcome: 0 | 1;
}>;

export type CalibratedFloor = Readonly<{
  /** The derived floor, or null when the data cannot support one. */
  floor: number | null;
  samplesUsed: number;
  /** What the floor rests on, or why there isn't one. */
  basis: string;
  /** Per-bucket evidence, so the number can be argued with. */
  buckets: readonly { from: number; to: number; n: number; hitRate: number }[];
}>;

export function breakEvenFloor(
  samples: readonly FloorSample[],
  options: {
    /** Hit rate needed to break even on a symmetric payoff. Default 0.5. */
    breakEvenHitRate?: number;
    /** Samples a bucket needs before its hit rate means anything. Default 5. */
    minBucketSamples?: number;
    /** Bucket width in conviction. Default 0.05. */
    bucketWidth?: number;
  } = {},
): CalibratedFloor {
  const breakEvenHitRate = options.breakEvenHitRate ?? 0.5;
  const minBucketSamples = options.minBucketSamples ?? 5;
  const bucketWidth = options.bucketWidth ?? 0.05;

  const usable = samples.filter(
    (s) =>
      Number.isFinite(s.conviction) &&
      s.conviction >= 0 &&
      s.conviction <= 1 &&
      (s.outcome === 0 || s.outcome === 1),
  );

  if (usable.length === 0) {
    return {
      floor: null,
      samplesUsed: 0,
      basis: "no scored samples; refusing to invent a floor",
      buckets: [],
    };
  }

  // Bucket by claimed conviction.
  const buckets = new Map<number, { n: number; wins: number }>();
  for (const sample of usable) {
    // Epsilon before flooring: 0.6 / 0.05 evaluates to 11.9999... in binary
    // floating point, which would drop the sample into the bucket below and
    // shift every boundary down by one - and the floor is the bucket edge, so
    // the error would land directly in the number being derived.
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
      hitRate: bucket.n > 0 ? bucket.wins / bucket.n : 0,
    }))
    .toSorted((a, b) => a.from - b.from);

  const qualifying = rows.filter(
    (row) => row.n >= minBucketSamples && row.hitRate >= breakEvenHitRate,
  );

  if (qualifying.length === 0) {
    return {
      floor: null,
      samplesUsed: usable.length,
      basis:
        usable.length +
        " sample(s) across " +
        rows.length +
        " bucket(s), but none reached break-even (" +
        breakEvenHitRate +
        ") on at least " +
        minBucketSamples +
        " observations; no floor can be justified",
      buckets: rows,
    };
  }

  // Every bucket at or above the chosen one must also break even, otherwise a
  // single lucky low bucket would set the bar for all the worse ones above it.
  const lowest = Math.min(...qualifying.map((row) => row.from));
  const atOrAbove = rows.filter((row) => row.from >= lowest && row.n >= minBucketSamples);
  const allHold = atOrAbove.every((row) => row.hitRate >= breakEvenHitRate);

  if (!allHold) {
    return {
      floor: null,
      samplesUsed: usable.length,
      basis:
        "a lower bucket clears break-even but a higher one does not, so the " +
        "relationship is not monotonic yet; waiting for more samples rather than " +
        "trusting the lucky bucket",
      buckets: rows,
    };
  }

  return {
    floor: Number(lowest.toFixed(4)),
    samplesUsed: usable.length,
    basis:
      "lowest bucket clearing break-even (" +
      breakEvenHitRate +
      ") on >= " +
      minBucketSamples +
      " observations, with every bucket above it also clearing",
    buckets: rows,
  };
}
