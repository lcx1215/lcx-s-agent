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

const PairedHash = z.string().regex(/^[a-f\d]{64}$/u);
const PairedTime = z.string().datetime({ offset: true });
const PairedArm = z
  .object({
    modelRef: z.string().min(1),
    modelConfigRef: PairedHash,
    promptRef: PairedHash,
    decidedAt: PairedTime,
    decision: z.enum(["approve", "veto", "failed"]),
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    latencyMs: z.number().finite().nonnegative(),
    inferenceCostUsd: z.number().finite().nonnegative().nullable(),
    receiptRef: PairedHash,
  })
  .strict();
export const FinancePairedEconomicsProtocolSchema = z
  .object({
    schemaVersion: z.literal("lcx_finance_paired_economics_protocol_v1"),
    frozenAt: PairedTime,
    sourceSha: z.string().regex(/^[a-f\d]{40}$/u),
    modelRef: z.string().min(1),
    modelConfigRef: PairedHash,
    promptRefs: z.object({ system: PairedHash, baseline: PairedHash }).strict(),
    maxModelCalls: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    timeoutMs: z.number().int().positive(),
    notionalUsd: z.number().finite().positive(),
    horizonSeconds: z.number().int().positive(),
  })
  .strict();
export const FinancePairedEconomicsCandidateSchema = z
  .object({
    id: z.string().min(1),
    candidateAt: PairedTime,
    registeredAt: PairedTime,
    requestRef: PairedHash,
    system: PairedArm.nullable(),
    baseline: PairedArm.nullable(),
    outcome: z
      .object({
        basis: z.literal("common_quote_replay"),
        entryAt: PairedTime,
        exitAt: PairedTime,
        grossPnlUsd: z.number().finite(),
        tradingCostUsd: z.number().finite().nonnegative().nullable(),
        notionalUsd: z.number().finite().positive(),
        receiptRef: PairedHash,
      })
      .strict()
      .nullable(),
  })
  .strict();

/** Paired selection diagnostic over a caller-supplied complete candidate manifest.
 * Common quote replay isolates selection; it does not manufacture a second broker fill.
 */
export function evaluateFinancePairedEconomics(params: {
  protocol: z.infer<typeof FinancePairedEconomicsProtocolSchema>;
  candidates: readonly z.infer<typeof FinancePairedEconomicsCandidateSchema>[];
  asOf: string;
}) {
  const protocol = FinancePairedEconomicsProtocolSchema.parse(params.protocol);
  const asOf = PairedTime.parse(params.asOf);
  const cutoff = Date.parse(asOf);
  if (Date.parse(protocol.frozenAt) > cutoff) {
    throw new Error("paired protocol is not frozen as of evaluation");
  }
  const candidates = params.candidates.map((row) =>
    FinancePairedEconomicsCandidateSchema.parse(row),
  );
  if (new Set(candidates.map((row) => row.id)).size !== candidates.length) {
    throw new Error("duplicate paired candidate identities");
  }
  const rows = candidates.map((row) => {
    const issues: string[] = [];
    const candidateAt = Date.parse(row.candidateAt);
    const registeredAt = Date.parse(row.registeredAt);
    if (
      candidateAt < Date.parse(protocol.frozenAt) ||
      registeredAt < candidateAt ||
      registeredAt > cutoff
    ) {
      issues.push("candidate_not_registered_prospectively");
    }
    for (const key of ["system", "baseline"] as const) {
      const arm = row[key];
      if (!arm) {
        issues.push(`${key}_decision_missing`);
        continue;
      }
      if (
        arm.modelRef !== protocol.modelRef ||
        arm.modelConfigRef !== protocol.modelConfigRef ||
        arm.promptRef !== protocol.promptRefs[key]
      ) {
        issues.push(`${key}_model_or_prompt_mismatch`);
      }
      if (
        arm.modelCalls > protocol.maxModelCalls ||
        arm.toolCalls > protocol.maxToolCalls ||
        arm.latencyMs > protocol.timeoutMs ||
        (arm.decision !== "failed" && arm.modelCalls === 0)
      ) {
        issues.push(`${key}_budget_violation`);
      }
      if (Date.parse(arm.decidedAt) <= registeredAt || Date.parse(arm.decidedAt) > cutoff) {
        issues.push(`${key}_decision_time_invalid`);
      }
      if (arm.decision === "failed") {
        issues.push(`${key}_decision_failed`);
      }
      if (arm.inferenceCostUsd === null) {
        issues.push(`${key}_inference_cost_unknown`);
      }
    }
    const outcome = row.outcome;
    if (!outcome) {
      issues.push("outcome_pending");
    } else {
      const entryAt = Date.parse(outcome.entryAt);
      const exitAt = Date.parse(outcome.exitAt);
      if (
        entryAt < registeredAt ||
        exitAt > cutoff ||
        exitAt - entryAt !== protocol.horizonSeconds * 1_000 ||
        [row.system, row.baseline].some((arm) => arm && Date.parse(arm.decidedAt) >= entryAt)
      ) {
        issues.push("outcome_time_invalid_or_not_yet_available");
      }
      if (outcome.notionalUsd !== protocol.notionalUsd) {
        issues.push("common_notional_mismatch");
      }
      if (outcome.tradingCostUsd === null) {
        issues.push("trading_cost_unknown");
      }
    }
    // Missing cost is unknown, never a free trade or a free model call.
    const score = (arm: z.infer<typeof PairedArm> | null) =>
      issues.length ||
      !arm ||
      !outcome ||
      arm.inferenceCostUsd === null ||
      outcome.tradingCostUsd === null
        ? null
        : (arm.decision === "approve" ? outcome.grossPnlUsd - outcome.tradingCostUsd : 0) -
          arm.inferenceCostUsd;
    let systemNetPnlUsd = score(row.system);
    let baselineNetPnlUsd = score(row.baseline);
    let incrementalNetPnlUsd =
      systemNetPnlUsd === null || baselineNetPnlUsd === null
        ? null
        : systemNetPnlUsd - baselineNetPnlUsd;
    if (
      [systemNetPnlUsd, baselineNetPnlUsd, incrementalNetPnlUsd].some(
        (value) => value !== null && !Number.isFinite(value),
      )
    ) {
      issues.push("nonfinite_derived_economics");
      systemNetPnlUsd = baselineNetPnlUsd = incrementalNetPnlUsd = null;
    }
    return {
      id: row.id,
      requestRef: row.requestRef,
      issues,
      systemNetPnlUsd,
      baselineNetPnlUsd,
      incrementalNetPnlUsd,
    };
  });
  const scored = rows.filter((row) => row.incrementalNetPnlUsd !== null);
  const complete = rows.length > 0 && scored.length === rows.length;
  const sum = (key: "systemNetPnlUsd" | "baselineNetPnlUsd" | "incrementalNetPnlUsd") =>
    scored.length ? scored.reduce((total, row) => total + (row[key] ?? 0), 0) : null;
  const sums = {
    systemNetPnlUsd: sum("systemNetPnlUsd"),
    baselineNetPnlUsd: sum("baselineNetPnlUsd"),
    incrementalNetPnlUsd: sum("incrementalNetPnlUsd"),
  };
  const aggregateArithmeticValid = Object.values(sums).every(
    (value) => value === null || Number.isFinite(value),
  );
  return {
    schemaVersion: "lcx_finance_paired_economics_eval_v1" as const,
    executionAuthority: "none" as const,
    promotionAllowed: false,
    asOf,
    protocolRef: caseflowFingerprint(protocol),
    datasetRef: caseflowFingerprint(candidates),
    status:
      complete && aggregateArithmeticValid
        ? "paired_quote_diagnostic_complete"
        : "incomplete_evidence",
    evaluationIssues: aggregateArithmeticValid ? [] : ["nonfinite_aggregate_economics"],
    totalCandidates: rows.length,
    scoredCandidates: scored.length,
    missingOrInvalidCandidates: rows.length - scored.length,
    coverage: rows.length ? scored.length / rows.length : null,
    coveredPairs: Object.fromEntries(
      Object.entries(sums).map(([key, value]) => [
        key,
        value !== null && !Number.isFinite(value) ? null : value,
      ]),
    ),
    fullManifestIncrementalNetPnlUsd:
      complete && aggregateArithmeticValid ? sums.incrementalNetPnlUsd : null,
    rows,
    limitations: [
      "Caller supplies the complete candidate manifest and receipt references; this function does not authenticate recording times or verify source hashes against a database.",
      "Same model, prompt bindings and budget ceilings are checked; actual paid usage can differ and inference costs remain required for vetoes.",
      "Common quote replay is counterfactual selection evidence, not actual broker fills or portfolio P&L; no compounding, drawdown, confidence interval or profitability claim.",
      "A positive covered-pair sum does not establish value when candidate coverage is incomplete or market outcomes are dependent.",
    ],
  };
}
