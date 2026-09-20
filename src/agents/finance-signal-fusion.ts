/**
 * Fuse heterogeneous signals into one research conclusion.
 *
 * The system already reads many different things - news and filing text,
 * fundamentals, chart structure, macro and liquidity readings, learned
 * capabilities. On their own none of them is a trade, and several of them
 * routinely disagree. This is the layer where they become one answer, or no
 * answer at all.
 *
 * Three rules hold it together:
 *
 * 1. **Provenance decides weight, not repetition.** Signals are counted by
 *    distinct source. Twenty articles from one wire are one source.
 * 2. **Disagreement is information.** When informed sources split, the honest
 *    answer is a lower conviction or a refusal - not an average that hides the
 *    split behind a confident-looking number.
 * 3. **Silence is not a signal.** A source that has nothing to say contributes
 *    nothing. Hold/neutral signals neither help nor hurt the count, so a single
 *    enthusiastic source cannot be propped up by a crowd of indifferent ones.
 */

export const FINANCE_SIGNAL_KINDS = [
  "news_tone",
  "filing_text",
  "fundamental",
  "technical",
  "macro",
  "learned_capability",
] as const;
export type FinanceSignalKind = (typeof FINANCE_SIGNAL_KINDS)[number];

export type FinanceSignal = Readonly<{
  /** Provenance. Signals sharing a sourceId are one source, however many. */
  sourceId: string;
  kind: FinanceSignalKind;
  /** What this source is saying. `hold` means it has no directional opinion. */
  direction: "buy" | "sell" | "hold";
  /** How strongly it says it, 0..1. */
  strength: number;
  /** How much this source is trusted, 0..1. Set by the caller, never assumed. */
  confidence: number;
  observedAt: string;
  /** Optional citation: a filing id, a url, a chart snapshot reference. */
  ref?: string;
}>;

export type FinanceFusedConclusion = Readonly<{
  direction: "buy" | "sell";
  conviction: number;
  /** Fraction of opinionated sources that agree with the winning side, 0..1. */
  agreement: number;
  distinctSources: number;
  /** The winning side's evidence, one entry per distinct source. */
  evidence: readonly { sourceId: string; ref?: string }[];
  notes: readonly string[];
}>;

export type FinanceFusionResult = Readonly<
  { ok: true; conclusion: FinanceFusedConclusion } | { ok: false; refusals: readonly string[] }
>;

export type FuseSignalsOptions = Readonly<{
  /** Minimum distinct opinionated sources. Default 2. */
  minSources?: number;
  /** Minimum share of opinionated sources on the winning side. Default 0.6. */
  minAgreement?: number;
}>;

function isValidSignal(value: unknown): value is FinanceSignal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const signal = value as Record<string, unknown>;
  return (
    typeof signal.sourceId === "string" &&
    signal.sourceId.trim().length > 0 &&
    (signal.direction === "buy" || signal.direction === "sell" || signal.direction === "hold") &&
    typeof signal.strength === "number" &&
    Number.isFinite(signal.strength) &&
    signal.strength >= 0 &&
    signal.strength <= 1 &&
    typeof signal.confidence === "number" &&
    Number.isFinite(signal.confidence) &&
    signal.confidence >= 0 &&
    signal.confidence <= 1 &&
    typeof signal.observedAt === "string"
  );
}

export function fuseSignals(
  rawSignals: readonly unknown[],
  options: FuseSignalsOptions = {},
): FinanceFusionResult {
  const minSources = options.minSources ?? 2;
  const minAgreement = options.minAgreement ?? 0.6;

  // Collapse by source: the last reading from a source is its current view,
  // and one source is one vote no matter how many times it speaks.
  const bySource = new Map<string, FinanceSignal>();
  const refusals: string[] = [];
  for (const raw of rawSignals) {
    if (!isValidSignal(raw)) {
      refusals.push("refuse: a signal is malformed; refusing rather than skipping it silently");
      continue;
    }
    const existing = bySource.get(raw.sourceId);
    if (!existing || raw.observedAt >= existing.observedAt) {
      bySource.set(raw.sourceId, raw);
    }
  }
  if (refusals.length > 0) {
    return { ok: false, refusals };
  }

  // Only opinionated sources vote. A neutral source is silence, not a vote.
  const opinionated = [...bySource.values()].filter((signal) => signal.direction !== "hold");
  if (opinionated.length === 0) {
    return { ok: false, refusals: ["refuse: no source expressed a direction"] };
  }

  const buyers = opinionated.filter((signal) => signal.direction === "buy");
  const sellers = opinionated.filter((signal) => signal.direction === "sell");
  const winning = buyers.length >= sellers.length ? buyers : sellers;
  const losing = winning === buyers ? sellers : buyers;
  const direction: "buy" | "sell" = winning === buyers ? "buy" : "sell";

  const agreement = winning.length / opinionated.length;
  const notes: string[] = [];

  if (winning.length < minSources) {
    return {
      ok: false,
      refusals: [
        `refuse: ${winning.length} distinct source(s) support ${direction}, ${minSources} required`,
      ],
    };
  }
  if (agreement < minAgreement) {
    return {
      ok: false,
      refusals: [
        `refuse: sources disagree (${winning.length} for ${direction}, ${losing.length} against); agreement ${agreement.toFixed(2)} is below ${minAgreement}`,
      ],
    };
  }

  // Conviction scales with strength, with the source's own reliability, and
  // with how much of the room agrees. An unopposed but weak signal stays weak.
  const weighted =
    winning.reduce((sum, signal) => sum + signal.strength * signal.confidence, 0) / winning.length;
  const conviction = weighted * agreement;
  notes.push(
    `fused ${winning.length}/${opinionated.length} opinionated sources on ${direction}; ` +
      `${bySource.size - opinionated.length} source(s) were neutral and did not vote`,
  );

  return {
    ok: true,
    conclusion: {
      direction,
      conviction: Math.max(0, Math.min(1, conviction)),
      agreement,
      distinctSources: bySource.size,
      evidence: winning.map((signal) => ({
        sourceId: signal.sourceId,
        ...(signal.ref !== undefined ? { ref: signal.ref } : {}),
      })),
      notes,
    },
  };
}
