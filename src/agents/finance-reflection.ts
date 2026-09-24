/**
 * Turn past forecast claims and their directional outcomes into something a model can be shown.
 *
 * The design rule here is the whole point, so it is worth stating plainly:
 * this reports facts, it does not issue corrections.
 *
 * Telling a model "you have been overconfident, lower your number" would work
 * mechanically - it would lower the number - without making the model any more
 * accurate. The score would improve while the judgement stayed as bad as it was,
 * which is worse than no loop at all because it looks like learning.
 *
 * So the prompt gets what actually happened: how often the calls were right,
 * what was claimed versus what was delivered, and a few concrete instances.
 * Adjusting to that is the model's job. If it cannot, no amount of instruction
 * will make it calibrated.
 *
 * With no history it says so. An empty record is not a good record, and a
 * reflection that invented a baseline would be one more confident-sounding
 * number with nothing behind it.
 */

export type ScoredSample = Readonly<{
  instrument: string;
  asOf: string;
  direction: "buy" | "sell";
  conviction: number;
  /** 1 if the forecast direction was right, 0 if not. This is not a trade P&L result. */
  outcome: 0 | 1;
  /** Percentage move over the horizon, signed. */
  movePct: number;
}>;

export type ReflectionSummary = Readonly<{
  scope: "forecast_directional_accuracy_only";
  instrument: string | null;
  samples: number;
  hitRate: number | null;
  meanClaimed: number | null;
  brier: number | null;
  /** Positive means it claimed more confidence than it delivered. */
  overconfidenceGap: number | null;
  /** A few concrete past calls, most recent last. */
  instances: readonly string[];
}>;

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function buildReflection(
  scored: readonly ScoredSample[],
  options: { instrument?: string; instanceLimit?: number } = {},
): ReflectionSummary {
  const instrument = options.instrument?.toUpperCase();
  const limit = options.instanceLimit ?? 5;
  const pool = instrument
    ? scored.filter((sample) => sample.instrument.toUpperCase() === instrument)
    : scored;

  if (pool.length === 0) {
    return {
      scope: "forecast_directional_accuracy_only",
      instrument: instrument ?? null,
      samples: 0,
      hitRate: null,
      meanClaimed: null,
      brier: null,
      overconfidenceGap: null,
      instances: [],
    };
  }

  const outcomes = pool.map((sample) => sample.outcome);
  const claimed = pool.map((sample) => sample.conviction);
  const hitRate = mean(outcomes);
  const meanClaimed = mean(claimed);
  const brier = mean(pool.map((sample) => (sample.conviction - sample.outcome) ** 2));

  const instances = pool
    .slice(-limit)
    .map(
      (sample) =>
        sample.asOf.slice(0, 10) +
        " claimed " +
        sample.conviction.toFixed(2) +
        " " +
        sample.direction +
        ", price moved " +
        (sample.movePct >= 0 ? "+" : "") +
        sample.movePct.toFixed(2) +
        "%" +
        " -> " +
        (sample.outcome === 1 ? "right" : "wrong"),
    );

  return {
    scope: "forecast_directional_accuracy_only",
    instrument: instrument ?? null,
    samples: pool.length,
    hitRate,
    meanClaimed,
    brier,
    overconfidenceGap: hitRate === null || meanClaimed === null ? null : meanClaimed - hitRate,
    instances,
  };
}

/**
 * Render a reflection for a prompt. States what happened and stops there.
 */
export function renderReflection(summary: ReflectionSummary): string {
  if (summary.samples === 0) {
    const scope = summary.instrument ? " for " + summary.instrument : "";
    return (
      "Your track record" +
      scope +
      ": no scored history yet. " +
      "There is no evidence about how accurate you have been, so do not assume " +
      "either accuracy or inaccuracy - judge this one on its own evidence."
    );
  }

  const lines: string[] = [];
  lines.push(
    "Scope: forecast direction accuracy only; these scores do not measure executed or net trading P&L.",
  );
  const scope = summary.instrument ? " on " + summary.instrument : " across the pool";
  lines.push("Your track record" + scope + " over " + summary.samples + " scored calls:");
  if (summary.hitRate !== null) {
    lines.push("- calls that were right: " + (summary.hitRate * 100).toFixed(1) + "%");
  }
  if (summary.meanClaimed !== null) {
    lines.push("- average conviction you claimed: " + summary.meanClaimed.toFixed(3));
  }
  if (summary.brier !== null) {
    lines.push(
      "- Brier score: " +
        summary.brier.toFixed(3) +
        " (0.25 is what always saying 50/50 would score; lower is better)",
    );
  }
  if (summary.overconfidenceGap !== null && summary.overconfidenceGap > 0.05) {
    lines.push(
      "- you claimed more confidence than you delivered by " +
        summary.overconfidenceGap.toFixed(3) +
        ". Treat that as a fact about the past, not as an instruction to adjust " +
        "this number; judge this case on its own evidence.",
    );
  }
  if (summary.instances.length > 0) {
    lines.push("- examples:");
    for (const instance of summary.instances) {
      lines.push("  " + instance);
    }
  }
  return lines.join("\n");
}
