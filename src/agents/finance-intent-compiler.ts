/**
 * Research conclusion -> execution intent.
 *
 * This is the hop that was missing: everything downstream (run authorization,
 * risk budget, the venue adapter, the receipt) already existed, but nothing
 * turned a conclusion into an orderable intent, so the system could execute and
 * could judge, yet could not decide.
 *
 * The governing rule is that an order path is never inferred. Every refusal
 * below exists because the alternative would be to guess: an unnamed instrument
 * guessed from context, a direction guessed from tone, a size guessed from
 * "this feels like a normal trade". Refusing is cheap; a guess that reaches a
 * venue is not.
 *
 * One judgement call is made here rather than left open, marked DECISION below.
 * It is reversible and should be overruled by the owner if wrong.
 */

import type { FinanceExecutionIntent, FinanceOrderSide } from "./finance-execution-adapter.js";
import {
  DEFAULT_FINANCE_CLASS_RULES,
  classifyFinanceStrategy,
  type FinanceStrategyClass,
} from "./finance-mandate.js";

export type FinanceConclusionDirection = "buy" | "sell" | "hold" | "avoid";

export type FinanceResearchConclusion = Readonly<{
  conclusionId: string;
  instrument?: string;
  direction?: FinanceConclusionDirection;
  /** 0..1. Absent is treated as unknown, not as maximum conviction. */
  conviction?: number;
  /** Why this trade, in the researcher's own words. Required: it becomes the rationale. */
  thesis?: string;
  assetClass?: string;
  /** Intended holding period in days; drives class selection. */
  horizonDays?: number;
  /** Price at which the thesis is wrong. Required for stop-driven classes. */
  invalidationPrice?: number;
  /** Non-price condition that invalidates the thesis. Required for class C. */
  invalidationCondition?: string;
  /** Target price, used only to check reward against risk. */
  targetPrice?: number;
}>;

export type FinanceIntentCompilationResult = Readonly<
  | { ok: true; intent: FinanceExecutionIntent; notes: readonly string[] }
  | { ok: false; refusals: readonly string[] }
>;

export type CompileExecutionIntentParams = Readonly<{
  conclusion: FinanceResearchConclusion;
  /** Observed price and the time it belongs to. "Now" is never assumed. */
  market: { referencePrice: number; referencePriceAt: string };
  /** Account equity in the same currency as the reference price. */
  equity: number;
  /** Existing position in this instrument, if any. */
  existingPosition?: { quantity: number; unrealizedFraction: number };
  /** The explicit authorization that admitted this run. Empty means unauthorized. */
  runAuthorizationId: string;
  /** Minimum conviction to act. Defaults per class below. */
  minConviction?: number;
  strategyClass?: FinanceStrategyClass;
}>;

const DEFAULT_MIN_CONVICTION: Record<FinanceStrategyClass, number> = {
  A: 0.6,
  B: 0.6,
  C: 0.5,
  D: 0.5,
};

export function compileExecutionIntent(
  params: CompileExecutionIntentParams,
): FinanceIntentCompilationResult {
  const { conclusion, market, equity } = params;
  const refusals: string[] = [];
  const notes: string[] = [];

  if (!params.runAuthorizationId.trim()) {
    refusals.push("refuse: no run authorization; an unauthorized run produces no order");
  }

  const instrument = conclusion.instrument?.trim().toUpperCase();
  if (!instrument) {
    refusals.push("refuse: the conclusion names no instrument");
  }

  // A direction is either stated or absent. Tone is not evidence.
  if (conclusion.direction !== "buy" && conclusion.direction !== "sell") {
    refusals.push(
      `refuse: no directional call (got ${conclusion.direction ?? "none"}); hold and avoid are not orders`,
    );
  }

  if (!Number.isFinite(market.referencePrice) || market.referencePrice <= 0) {
    refusals.push("refuse: reference price is missing or not positive");
  }
  if (!market.referencePriceAt.trim()) {
    refusals.push("refuse: reference price carries no timestamp");
  }
  if (!Number.isFinite(equity) || equity <= 0) {
    refusals.push("refuse: equity is missing or not positive");
  }

  const strategyClass =
    params.strategyClass ??
    classifyFinanceStrategy({
      assetClass: conclusion.assetClass ?? "",
      ...(conclusion.horizonDays !== undefined
        ? { holdingPeriodDays: conclusion.horizonDays }
        : {}),
    });
  if (strategyClass === "unknown") {
    refusals.push("refuse: strategy class cannot be determined from the conclusion");
  }

  if (refusals.length > 0 || strategyClass === "unknown" || !instrument) {
    return { ok: false, refusals };
  }

  const classRules = DEFAULT_FINANCE_CLASS_RULES[strategyClass];
  const minConviction = params.minConviction ?? DEFAULT_MIN_CONVICTION[strategyClass];
  const conviction = conclusion.conviction;
  if (conviction === undefined || !Number.isFinite(conviction)) {
    refusals.push("refuse: the conclusion states no conviction; refusing rather than assuming");
  } else if (conviction < minConviction) {
    refusals.push(
      `refuse: conviction ${conviction} is below the ${minConviction} floor for class ${strategyClass}`,
    );
  }

  if (!conclusion.thesis?.trim()) {
    refusals.push("refuse: the conclusion gives no thesis; an order needs a stated reason");
  }

  // DECISION - the averaging-down boundary.
  //
  // The question was how to tell legitimate tranching from averaging down. The
  // test chosen is not "is this a tranche" but "is there already a losing
  // position in this name": adding to a position that is underwater in the same
  // direction is the behaviour that destroys accounts, while building a planned
  // position in a name with no losing exposure is ordinary execution. This lets
  // class C build a position over time without being refused for it, while still
  // catching the real thing. Overrule if the owner prefers plan-based evidence.
  const existing = params.existingPosition;
  if (
    existing &&
    existing.quantity !== 0 &&
    existing.unrealizedFraction < 0 &&
    conclusion.direction === (existing.quantity > 0 ? "buy" : "sell")
  ) {
    refusals.push(
      "refuse: adding to an existing losing position in the same direction (averaging down)",
    );
  }

  // Sizing. Stop-driven classes risk the distance to the stop; classes without a
  // price stop risk the whole position, which is deliberately more conservative
  // rather than pretending a missing stop is a tight one.
  let quantity = 0;
  if (classRules.stopLossKind === "structural") {
    const stop = conclusion.invalidationPrice;
    if (stop === undefined || !Number.isFinite(stop) || stop <= 0) {
      refusals.push(`refuse: class ${strategyClass} sizes from a price stop and none was given`);
    } else {
      const distance = Math.abs(market.referencePrice - stop);
      if (distance === 0) {
        refusals.push("refuse: stop distance is zero; size would be unbounded");
      } else {
        quantity = Math.floor((equity * classRules.maxRiskPerTradeFraction) / distance);
        notes.push(
          `sized from stop distance ${distance.toFixed(4)} at ${(classRules.maxRiskPerTradeFraction * 100).toFixed(2)}% risk`,
        );
      }
    }
  } else {
    if (!conclusion.invalidationCondition?.trim()) {
      refusals.push(
        `refuse: class ${strategyClass} needs a stated invalidation condition in place of a price stop`,
      );
    } else {
      quantity = Math.floor((equity * classRules.maxRiskPerTradeFraction) / market.referencePrice);
      notes.push(
        `sized on full position at risk (no price stop) at ${(classRules.maxRiskPerTradeFraction * 100).toFixed(2)}% of equity`,
      );
    }
  }

  if (quantity <= 0 && refusals.length === 0) {
    refusals.push("refuse: computed size rounds to zero; refusing rather than trading a token");
  }

  if (refusals.length > 0) {
    return { ok: false, refusals };
  }

  const side: FinanceOrderSide = conclusion.direction === "buy" ? "buy" : "sell";
  return {
    ok: true,
    notes,
    intent: {
      intentId: `intent:${conclusion.conclusionId}`,
      instrument,
      side,
      orderType: "market",
      quantity,
      referencePrice: market.referencePrice,
      referencePriceAt: market.referencePriceAt,
      runAuthorizationId: params.runAuthorizationId,
      ...(conclusion.invalidationPrice !== undefined
        ? { stopPrice: conclusion.invalidationPrice }
        : {}),
      rationale: conclusion.thesis ?? "",
    },
  };
}
