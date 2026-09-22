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
  /**
   * Target price. Checked only for coherence: a target on the wrong side of the entry is refused.
   * No reward/risk ratio floor is enforced.
   */
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
  /** Trusted controller flag permitting a pre-budgeted add to an underwater position. */
  plannedScaleIn?: boolean;
  /** The explicit authorization that admitted this run. Empty means unauthorized. */
  runAuthorizationId: string;
  /** Minimum conviction to act. Defaults per class below. */
  minConviction?: number;
  strategyClass?: FinanceStrategyClass;
  /** Trusted controller-only exact quantity, used to close an observed position without re-sizing. */
  quantityOverride?: number;
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

  // `targetPrice` was declared here as "used only to check reward against risk", asked for by the
  // research prompt and parsed by the intake -- and then read by nothing at all, so a target on the
  // wrong side of the entry compiled into an order. A target that sits below a long entry (or above
  // a short one) is incoherent in the same way a stop on the wrong side is, so it is refused here.
  //
  // No reward/risk *ratio* floor is enforced. That is a strategy judgement, and inventing one here
  // would launder a guess into an enforced decision -- the same reason `classifyFinanceStrategy`
  // refuses instead of guessing a class.
  const target = conclusion.targetPrice;
  if (
    target !== undefined &&
    Number.isFinite(target) &&
    (conclusion.direction === "buy" || conclusion.direction === "sell")
  ) {
    const targetOnWrongSide =
      conclusion.direction === "buy"
        ? target <= market.referencePrice
        : target >= market.referencePrice;
    if (targetOnWrongSide) {
      refusals.push(
        `refuse: a ${conclusion.direction} at ${market.referencePrice} with a target at ${target} is on the wrong side`,
      );
    }
  }

  // DECISION - the averaging-down boundary.
  //
  // The question was how to tell legitimate tranching from averaging down. The
  // test chosen is not "is this a tranche" but "is there already a losing
  // position in this name": adding to a position that is underwater in the same
  // direction is the behaviour that destroys accounts, while building a planned
  // position in a name with no losing exposure is ordinary execution. This lets
  // class C build a position over time without being refused for it, while still
  // catching the real thing. A pre-budgeted scale-in is allowed through this
  // compiler, but remains subject to the separate account and risk caps.
  const existing = params.existingPosition;
  if (
    existing &&
    existing.quantity !== 0 &&
    existing.unrealizedFraction < 0 &&
    conclusion.direction === (existing.quantity > 0 ? "buy" : "sell")
  ) {
    if (params.plannedScaleIn !== true) {
      refusals.push(
        "refuse: adding to an existing losing position (averaging down) without a pre-budgeted scale-in plan",
      );
    } else {
      notes.push("planned scale-in accepted; aggregate account and instrument caps still apply");
    }
  }

  // Sizing. Stop-driven classes risk the distance to the stop; classes without a
  // price stop risk the whole position, which is deliberately more conservative
  // rather than pretending a missing stop is a tight one.
  let quantity = 0;
  if (params.quantityOverride !== undefined) {
    if (!Number.isFinite(params.quantityOverride) || params.quantityOverride <= 0) {
      refusals.push("refuse: quantity override must be positive and finite");
    } else {
      quantity = params.quantityOverride;
      notes.push(
        "trusted controller exact-quantity override; risk budget and account gates still apply",
      );
    }
  } else if (classRules.stopLossKind === "structural") {
    const stop = conclusion.invalidationPrice;
    if (stop === undefined || !Number.isFinite(stop) || stop <= 0) {
      refusals.push(`refuse: class ${strategyClass} sizes from a price stop and none was given`);
    } else {
      const distance = Math.abs(market.referencePrice - stop);
      // `Math.abs` above erases the sign, so a stop on the wrong side of the entry -- one that is
      // already breached -- used to size and emit an order anyway. Measured at a reference price of
      // 100: a long with a stop at 110 compiled to qty=100 with a "sized from stop distance 10"
      // note, and a short with a stop at 90 did the same. A breached stop is not a tight stop, and
      // the size it produces is not a small position: it is a position sized from a distance that
      // cannot be travelled. The zero-distance case below was already handled; the sign was not.
      const stopOnWrongSide =
        conclusion.direction === "buy"
          ? stop > market.referencePrice
          : stop < market.referencePrice;
      if (stopOnWrongSide) {
        refusals.push(
          `refuse: a ${conclusion.direction} at ${market.referencePrice} with a stop at ${stop} is on the wrong side; the stop is already breached`,
        );
      } else if (distance === 0) {
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
      // A conclusion for a condition-driven class may still carry an invalidation price. It is not
      // this class's stop, and carrying it as one would contradict both the note above and the
      // class's own rule ("leaves the stop off when the class uses a condition instead of a price").
      // Saying so out loud keeps it from being silently dropped.
      if (conclusion.invalidationPrice !== undefined) {
        notes.push(
          "note: an invalidation price was supplied, but this class stops on its stated condition; it is not carried as a stop price",
        );
      }
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
      // Only a structural stop is a stop. Emitting one for a condition-driven class produced an
      // intent whose note said "no price stop" while it carried a stop at the price it never sized
      // from -- measured with a class-C conclusion supplying both a condition and a price.
      ...(classRules.stopLossKind === "structural" && conclusion.invalidationPrice !== undefined
        ? { stopPrice: conclusion.invalidationPrice }
        : {}),
      rationale: conclusion.thesis ?? "",
    },
  };
}
