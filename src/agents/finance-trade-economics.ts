import { z } from "zod";
import { caseflowFingerprint } from "./finance-caseflow.js";

const Observation = z
  .object({
    id: z.string().min(1),
    entryAt: z.string().datetime(),
    exitAt: z.string().datetime(),
    grossReturn: z.number().finite(),
    costFraction: z.number().finite().nonnegative(),
  })
  .strict();
export type FinanceTradeEconomicsObservation = z.infer<typeof Observation>;
const Policy = z
  .object({
    minObservations: z.number().int().min(2),
    priorWins: z.number().finite().positive(),
    priorLosses: z.number().finite().positive(),
    kellyFraction: z.number().finite().positive().max(1),
    maxAllocationFraction: z.number().finite().positive().max(1),
    maxLossBudgetFraction: z.number().finite().positive().max(1),
    uncertaintyPenalty: z.number().finite().nonnegative(),
  })
  .strict();
export type FinanceTradeEconomicsPolicy = z.infer<typeof Policy>;

/** Research estimator only: each estimate reads outcomes closed strictly before the decision. */
export function estimateFinanceTradeEconomics(params: {
  observations: readonly FinanceTradeEconomicsObservation[];
  decisionAt: string;
  roundTripCostFraction: number;
  policy: FinanceTradeEconomicsPolicy;
}) {
  const policy = Policy.parse(params.policy);
  const decisionAt = z.string().datetime().parse(params.decisionAt);
  const cost = z.number().finite().nonnegative().parse(params.roundTripCostFraction);
  const all = params.observations.map((row) => Observation.parse(row));
  if (
    new Set(all.map((row) => row.id)).size !== all.length ||
    all.some((row) => Date.parse(row.entryAt) >= Date.parse(row.exitAt))
  ) {
    throw new Error("duplicate trade identities or invalid outcome ordering");
  }
  const rows = all.filter((row) => Date.parse(row.exitAt) < Date.parse(decisionAt));
  const wins = rows.filter((row) => row.grossReturn > 0);
  const losses = rows.filter((row) => row.grossReturn <= 0);
  const probability =
    (wins.length + policy.priorWins) / (rows.length + policy.priorWins + policy.priorLosses);
  const meanWin = wins.length
    ? wins.reduce((sum, row) => sum + row.grossReturn, 0) / wins.length
    : 0;
  const meanLoss = losses.length
    ? losses.reduce((sum, row) => sum - row.grossReturn, 0) / losses.length
    : 0;
  const expectedNetReturn = probability * meanWin - (1 - probability) * meanLoss - cost;
  const mean = rows.length ? rows.reduce((sum, row) => sum + row.grossReturn, 0) / rows.length : 0;
  const variance =
    rows.length > 1
      ? rows.reduce((sum, row) => sum + (row.grossReturn - mean) ** 2, 0) / (rows.length - 1)
      : 0;
  // A conservative penalty, not a confidence interval for dependent market outcomes.
  const penalizedNetReturn =
    expectedNetReturn - policy.uncertaintyPenalty * Math.sqrt(variance / Math.max(1, rows.length));
  const worstObservedLoss = Math.max(0, ...rows.map((row) => cost - row.grossReturn));
  const sufficient =
    rows.length >= policy.minObservations && wins.length > 0 && losses.length > 0 && variance > 0;
  const fraction =
    sufficient && penalizedNetReturn > 0
      ? Math.min(
          policy.maxAllocationFraction,
          (policy.kellyFraction * penalizedNetReturn) / variance,
          policy.maxLossBudgetFraction / Math.max(worstObservedLoss, Number.EPSILON),
        )
      : 0;
  return Object.freeze({
    schemaVersion: "lcx_finance_trade_economics_v1" as const,
    executionAuthority: "none" as const,
    decisionAt,
    observedTrades: rows.length,
    evidenceRef: caseflowFingerprint(rows),
    policyRef: caseflowFingerprint(policy),
    probabilityGrossProfit: probability,
    expectedNetReturn,
    penalizedNetReturn,
    allocationFraction: fraction,
    roundTripCostFraction: cost,
    status: !sufficient
      ? ("insufficient_evidence" as const)
      : fraction > 0
        ? ("research_candidate" as const)
        : ("nonpositive_conservative_ev" as const),
    limitations: [
      "Empirical returns are not independent; penalty is not a confidence interval.",
      "Observed worst loss is not a bound on future gaps or liquidity loss.",
      "Cost and policy inputs are caller assumptions; no execution or promotion authority.",
    ],
  });
}

/** Walk forward without letting the current or later outcome change its own prediction. */
export function evaluateFinanceTradeEconomics(params: {
  observations: readonly FinanceTradeEconomicsObservation[];
  policy: FinanceTradeEconomicsPolicy;
  additionalCostFraction: number;
  assumedRoundTripCostFraction: number;
}) {
  Policy.parse(params.policy);
  const observations = params.observations
    .map((row) => Observation.parse(row))
    .toSorted((a, b) => a.entryAt.localeCompare(b.entryAt));
  const additional = z.number().finite().nonnegative().parse(params.additionalCostFraction);
  const assumedCost = z.number().finite().nonnegative().parse(params.assumedRoundTripCostFraction);
  let equity = 1;
  let baselineEquity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let brier = 0;
  let baselineBrier = 0;
  let scored = 0;
  const decisions = observations.map((row, index) => {
    const estimate = estimateFinanceTradeEconomics({
      observations,
      decisionAt: row.entryAt,
      roundTripCostFraction: assumedCost + additional,
      policy: params.policy,
    });
    const actualNet = row.grossReturn - row.costFraction - additional;
    // Shared-account returns cannot be compounded independently for overlapping positions.
    const previous = observations[index - 1];
    if (previous && Date.parse(previous.exitAt) > Date.parse(row.entryAt)) {
      throw new Error("overlapping observations require a portfolio replay");
    }
    equity *= 1 + estimate.allocationFraction * actualNet;
    baselineEquity *= 1 + params.policy.maxAllocationFraction * actualNet;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
    if (estimate.observedTrades >= params.policy.minObservations) {
      const outcome = Number(row.grossReturn > 0);
      brier += (estimate.probabilityGrossProfit - outcome) ** 2;
      baselineBrier += (0.5 - outcome) ** 2;
      scored++;
    }
    return { tradeId: row.id, estimate, actualNetReturn: actualNet, equity };
  });
  const summarizeNet = (returns: readonly number[]) => {
    const wins = returns.filter((value) => value > 0);
    const losses = returns.filter((value) => value < 0);
    const profit = wins.reduce((sum, value) => sum + value, 0);
    const loss = -losses.reduce((sum, value) => sum + value, 0);
    const meanWin = wins.length ? profit / wins.length : null;
    const largestLoss = Math.max(0, ...losses.map((value) => -value));
    return {
      observations: returns.length,
      netWins: wins.length,
      netLosses: losses.length,
      netBreakevens: returns.length - wins.length - losses.length,
      netWinRate: returns.length ? wins.length / returns.length : null,
      meanNetReturn: returns.length ? (profit - loss) / returns.length : null,
      meanNetWin: meanWin,
      meanNetLoss: losses.length ? loss / losses.length : null,
      profitFactor: loss > 0 ? profit / loss : null,
      largestNetLoss: largestLoss,
      averageWinsErasedByLargestLoss: meanWin === null ? null : largestLoss / meanWin,
    };
  };
  return {
    schemaVersion: "lcx_finance_trade_economics_eval_v1",
    executionAuthority: "none",
    policy: params.policy,
    policyRef: caseflowFingerprint(params.policy),
    datasetRef: caseflowFingerprint(observations),
    additionalCostFraction: additional,
    assumedRoundTripCostFraction: assumedCost,
    trades: observations.length,
    sizedTrades: decisions.filter((row) => row.estimate.allocationFraction > 0).length,
    calibrationTarget: "gross_return_positive_before_costs",
    brierScore: scored ? brier / scored : null,
    netEconomics: {
      basis: "per_trade_return_fractions_not_currency_pnl",
      allOpportunities: summarizeNet(decisions.map((row) => row.actualNetReturn)),
      selectedOpportunities: summarizeNet(
        decisions
          .filter((row) => row.estimate.allocationFraction > 0)
          .map((row) => row.actualNetReturn),
      ),
      skippedOpportunities: decisions.filter((row) => row.estimate.allocationFraction === 0).length,
      grossWinnersLostAfterCosts: observations.filter(
        (row) => row.grossReturn > 0 && row.grossReturn - row.costFraction - additional <= 0,
      ).length,
    },
    constantHalfBrier: scored ? baselineBrier / scored : null,
    scoredPredictions: scored,
    totalReturn: equity - 1,
    fixedAllocationReturn: baselineEquity - 1,
    maxDrawdown,
    decisions,
    promotionAllowed: false,
    evaluationKind: "retrospective_walk_forward_not_untouched_holdout",
  };
}
