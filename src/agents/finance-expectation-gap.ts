import { z } from "zod";
import type { FinanceTradeDecisionReviewRequest } from "./finance-trade-decision-review.js";

const hypothesis = z.string().trim().min(1).max(180).nullable();
/** These are model hypotheses tied to the recorded packet, never measured market consensus. */
export const FinanceExpectationGapSchema = z
  .object({
    origin: z.literal("model_hypothesis"),
    edgeKind: z.enum([
      "fundamentals",
      "valuation",
      "interpretation",
      "timing",
      "flow",
      "risk_rebalance",
      "unknown",
    ]),
    marketExpectation: hypothesis,
    variantView: hypothesis,
    catalyst: hypothesis,
    invalidation: hypothesis,
    costRiskAssessment: hypothesis,
  })
  .strict();
export type FinanceExpectationGap = z.infer<typeof FinanceExpectationGapSchema>;

export const FINANCE_EXPECTATION_GAP_GUIDANCE =
  "Evaluate the difference between a plausible market expectation and your variant view, not whether the news is merely good or bad. Public availability does not prove full pricing; a price alone does not reveal consensus. Mark the market expectation as a hypothesis unless supplied evidence establishes it, and leave unknowns explicit. Identify what could realize the difference, its timing and what would falsify it. Distinguish fundamental, valuation, interpretation, timing and flow expectation gaps; privileged information is not the objective. Reposts of one source are one claim, not independent confirmations. Do not invent private information, consensus numbers, success probabilities, fees, or net expected profit. Target upside and reward/risk are conditional scenarios, not expected returns. Incomplete evidence may support a bounded Paper attempt; absence of consensus or a complete cost estimate alone is not a veto. Risk reduction and rebalancing need not claim a valuation or expectation advantage. Do not delay a protective exit to discover alpha. Connect approve/veto to the supplied strategy, opportunity hypothesis and concrete risks; never turn a new hypothesis into an adopted execution condition.";

/** Quote arithmetic is supplied separately so model conjecture cannot masquerade as measurement. */
export function buildFinanceOpportunityContext(request: FinanceTradeDecisionReviewRequest) {
  return request.candidates.map((candidate) => {
    const { bidPrice: bid, askPrice: ask } = candidate.executionQuote;
    const quoteValid =
      typeof bid === "number" &&
      Number.isFinite(bid) &&
      bid > 0 &&
      typeof ask === "number" &&
      Number.isFinite(ask) &&
      ask >= bid;
    const spread = quoteValid ? ask - bid : null;
    const entry = candidate.side === "buy" && quoteValid ? ask : null;
    const stop = "stopPrice" in candidate ? candidate.stopPrice : undefined;
    const target = "targetPrice" in candidate ? candidate.targetPrice : undefined;
    return {
      candidateId: candidate.candidateId,
      origin: "packet_arithmetic" as const,
      quoteObservedAt: candidate.executionQuote.referencePriceAt,
      spreadPerUnit: spread,
      spreadBps: quoteValid ? ((ask - bid) / ((ask + bid) / 2)) * 10000 : null,
      conditionalUpsidePerUnit:
        entry !== null && typeof target === "number" && Number.isFinite(target)
          ? target - entry
          : null,
      plannedStopDistancePerUnit:
        entry !== null && typeof stop === "number" && Number.isFinite(stop) ? entry - stop : null,
      totalRoundTripCost: null,
      netExpectedValue: null,
      boundary:
        "spread_is_not_full_cost; targets_are_not_expected_returns; fill_and_stop_prices_not_guaranteed",
    };
  });
}

export const FINANCE_FUNDAMENTAL_EXPECTATION_GUIDANCE =
  "For investment-relevant fundamental research, organize the report around a testable expectation gap, not a catalogue of good/bad news. Separate (1) observed business results and their publication/as-of dates, (2) an explicitly sourced consensus or a labelled price-implied hypothesis, (3) your variant revenue, margin, cash-flow, capex or valuation driver and its causal basis, (4) catalyst and realization horizon, (5) contrary evidence and invalidation. Analyst price targets are source opinions, not proof of what the current price embeds or an independent proprietary edge. Compare expectations for the same period, metric, currency and accounting basis; if alignment or a baseline is missing, retain a conditional hypothesis with null unknowns rather than inventing consensus. Explain why the information might not yet be reflected in price and why your reading could be wrong. Derive trade candidates from the magnitude and timing of the disagreement relative to costs and downside, not from source count, popularity or positive sentiment. Use existing evidence IDs and original-source lineage; syndicated reports are not separate corroboration. Do not require this investment framing for a purely factual lookup.";
