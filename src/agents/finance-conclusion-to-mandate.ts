/**
 * The back half of a conclusion's journey: intake, sizing, mandate.
 *
 * This exists because two operator scripts each implemented it, and they had
 * already drifted apart. One passed a regime to the mandate and the other did
 * not, which meant the same conclusion was judged under tighter caps in one path
 * than the other - and the looser verdict was the one the research turn produced.
 * Nobody had declared that difference; it was only visible by reading both.
 *
 * A regime tightens and never widens, so the drift was in the unsafe direction.
 * Two copies of a gate will keep diverging, and the divergence will keep being
 * invisible, so the gate lives here once and both callers reach it.
 *
 * What it does not do: place anything. It answers whether a conclusion survives
 * intake, sizing and the mandate, and hands back the intent if it does.
 */

import type { FinanceCalibrationRecord } from "./finance-conclusion-intake.js";
import { parseResearchConclusion } from "./finance-conclusion-intake.js";
import type { FinanceExecutionIntent } from "./finance-execution-adapter.js";
import { compileExecutionIntent } from "./finance-intent-compiler.js";
import {
  classifyFinanceStrategy,
  evaluateFinanceMandate,
  type FinanceMandateDecision,
  type FinanceMandateContext,
  type FinanceRegime,
  type FinanceStrategyClass,
} from "./finance-mandate.js";

export type ConclusionToMandateResult = Readonly<
  | { ok: false; stage: "intake"; refusals: readonly string[] }
  | { ok: false; stage: "compile" | "risk_context"; refusals: readonly string[] }
  | {
      ok: true;
      stage: "mandate";
      passed: boolean;
      /** The validated conclusion, so callers can report what was claimed. */
      conclusion: import("./finance-conclusion-intake.js").FinanceIntakeConclusion;
      /** "unknown" is possible here: classification can fail, and the mandate refuses on it. */
      strategyClass: FinanceStrategyClass | "unknown";
      regime: FinanceRegime | undefined;
      mandate: FinanceMandateDecision;
      intent: FinanceExecutionIntent | undefined;
      notes: readonly string[];
    }
>;

export type FinanceConclusionRiskContext = Readonly<{
  drawdownFraction: number;
  averagingDown: boolean;
  plannedScaleIn?: boolean;
  revengeSizing: boolean;
  hasSignificantAutocorrelation?: boolean;
  realizedVolatilityFraction?: number;
}>;

export function evaluateConclusionToMandate(params: {
  /** The model's JSON, unvalidated. */
  raw: unknown;
  /** Trusted caller state, never read from model JSON. Missing state refuses execution. */
  riskContext?: FinanceConclusionRiskContext;
  /** Observed price and the time it belongs to. "Now" is never assumed. */
  referencePrice: number;
  referencePriceAt: string;
  equity: number;
  /** The explicit authorization that admitted this run. Empty is refused downstream. */
  runAuthorizationId: string;
  /**
   * Omitted means the base rules. A regime only ever tightens them, so omitting
   * it is the looser judgement - callers that know the regime should pass it.
   */
  regime?: FinanceRegime;
  minSources?: number;
  /**
   * The track record to judge the claimed conviction against. Omitted means
   * unadjusted, which is right for a system with no history yet and is not a
   * silent default of trusting the claim.
   */
  calibrationRecords?: readonly FinanceCalibrationRecord[];
  baseFloor?: number;
}): ConclusionToMandateResult {
  const intake = parseResearchConclusion(params.raw, {
    ...(params.minSources === undefined ? {} : { minSources: params.minSources }),
    ...(params.calibrationRecords === undefined || params.baseFloor === undefined
      ? {}
      : { calibrationRecords: params.calibrationRecords, baseFloor: params.baseFloor }),
  });
  if (!intake.ok) {
    return { ok: false, stage: "intake", refusals: intake.refusals };
  }

  const risk = params.riskContext;
  if (
    !risk ||
    typeof risk.averagingDown !== "boolean" ||
    typeof risk.revengeSizing !== "boolean" ||
    typeof risk.drawdownFraction !== "number"
  ) {
    return {
      ok: false,
      stage: "risk_context",
      refusals: [
        "trusted caller risk context requires observed drawdown and explicit averagingDown/revengeSizing booleans; model claims cannot supply it",
      ],
    };
  }
  const strategy: FinanceMandateContext["strategy"] = {
    assetClass: intake.conclusion.assetClass,
    ...(intake.conclusion.horizonDays === undefined
      ? {}
      : { holdingPeriodDays: intake.conclusion.horizonDays }),
  };
  const strategyClass = classifyFinanceStrategy(strategy);

  const compiled = compileExecutionIntent({
    conclusion: intake.conclusion,
    market: { referencePrice: params.referencePrice, referencePriceAt: params.referencePriceAt },
    equity: params.equity,
    runAuthorizationId: params.runAuthorizationId,
    ...(strategyClass !== "unknown" ? { strategyClass } : {}),
    ...(params.baseFloor === undefined ? {} : { minConviction: params.baseFloor }),
  });
  if (!compiled.ok) {
    return { ok: false, stage: "compile", refusals: compiled.refusals };
  }

  // Risk, not notional. The mandate caps what is lost if the stop is hit, and the
  // compiler already sized the trade on that basis; comparing the notional here
  // would reject every stop-based trade, since notional is many times the risk
  // whenever a stop is close.
  const stopDistance =
    compiled.intent.stopPrice === undefined
      ? params.referencePrice
      : Math.abs(params.referencePrice - compiled.intent.stopPrice);
  const riskFractionOfEquity = (compiled.intent.quantity * stopDistance) / params.equity;

  const mandate = evaluateFinanceMandate({
    strategy,
    riskFractionOfEquity,
    drawdownFraction: risk.drawdownFraction,
    averagingDown: risk.averagingDown,
    ...(risk.plannedScaleIn === undefined ? {} : { plannedScaleIn: risk.plannedScaleIn }),
    revengeSizing: risk.revengeSizing,
    ...(risk.realizedVolatilityFraction === undefined
      ? {}
      : { realizedVolatilityFraction: risk.realizedVolatilityFraction }),
    stopLossDefined: compiled.intent.stopPrice !== undefined,
    ...(risk.hasSignificantAutocorrelation === undefined
      ? {}
      : { hasSignificantAutocorrelation: risk.hasSignificantAutocorrelation }),
    ...(params.regime === undefined ? {} : { regime: params.regime }),
  });

  return {
    ok: true,
    stage: "mandate",
    passed: mandate.verdict === "pass",
    conclusion: intake.conclusion,
    strategyClass,
    regime: params.regime,
    mandate,
    intent: mandate.verdict === "pass" ? compiled.intent : undefined,
    notes: compiled.notes,
  };
}
