/**
 * Machine-executable trading mandate, split by strategy class.
 *
 * Why this exists as code and not as a document: a system cannot act on
 * adjectives. "Do not be greedy" is not a rule; `risk <= equity * 1%` is. Every
 * rule here is therefore written as a predicate that returns pass / refuse /
 * needs_human.
 *
 * Why it is split by class: one ruler does not fit every strategy. A -10%
 * drawdown halt is sane for intraday directional trading and nonsense for value
 * investing, where a 30-50% drawdown is normal and expected. Applying a
 * short-term ruler to a long-horizon strategy produces confident, wrong
 * refusals.
 *
 * The classification step is a gate, not a convenience: if the class cannot be
 * determined, the only legal verdict is `refuse`. Guessing a class and applying
 * its rules would be worse than refusing, because it launders a guess into an
 * enforced decision.
 *
 * All numeric defaults are PROPOSED and must be confirmed by the owner before
 * any real capital is involved.
 */

export const FINANCE_STRATEGY_CLASSES = ["A", "B", "C", "D"] as const;
export type FinanceStrategyClass = (typeof FINANCE_STRATEGY_CLASSES)[number];

export type FinanceVerdict = "pass" | "refuse" | "needs_human";

export type FinanceClassRules = Readonly<{
  label: string;
  /** Maximum risk per trade as a fraction of equity (0.01 = 1%). */
  maxRiskPerTradeFraction: number;
  stopLossRequired: boolean;
  /** `structural` = price level; `thesis` = the reason for holding broke. */
  stopLossKind: "structural" | "thesis" | "none";
  /** Peak-to-trough that halts the strategy. null = not applicable. */
  maxDrawdownHaltFraction: number | null;
  evaluationPeriodDays: number;
  /** Only meaningful for predictive strategies; false for value / web3. */
  requireSignificantAutocorrelation: boolean;
}>;

export const DEFAULT_FINANCE_CLASS_RULES: Readonly<
  Record<FinanceStrategyClass, FinanceClassRules>
> = Object.freeze({
  // Short-horizon directional trading: stocks, ETFs, futures.
  A: Object.freeze({
    label: "短线方向交易",
    maxRiskPerTradeFraction: 0.01,
    stopLossRequired: true,
    stopLossKind: "structural",
    maxDrawdownHaltFraction: 0.1,
    evaluationPeriodDays: 30,
    requireSignificantAutocorrelation: true,
  }),
  // Crypto: 24/7, far higher volatility, venue and custody risk.
  B: Object.freeze({
    label: "币圈",
    maxRiskPerTradeFraction: 0.005,
    stopLossRequired: true,
    stopLossKind: "structural",
    maxDrawdownHaltFraction: 0.15,
    evaluationPeriodDays: 30,
    requireSignificantAutocorrelation: true,
  }),
  // Value / fundamental: thesis-driven, long horizon, deep drawdowns normal.
  C: Object.freeze({
    label: "价值投资",
    maxRiskPerTradeFraction: 0.03,
    stopLossRequired: false,
    stopLossKind: "thesis",
    maxDrawdownHaltFraction: 0.4,
    evaluationPeriodDays: 365,
    requireSignificantAutocorrelation: false,
  }),
  // On-chain: contract, bridge, oracle and custody risks dominate.
  D: Object.freeze({
    label: "Web3 / 链上",
    maxRiskPerTradeFraction: 0.01,
    stopLossRequired: false,
    stopLossKind: "none",
    maxDrawdownHaltFraction: 0.25,
    evaluationPeriodDays: 90,
    requireSignificantAutocorrelation: false,
  }),
});

export type FinanceStrategyInput = Readonly<{
  assetClass: string;
  /** Intended holding period in days; drives long vs short horizon. */
  holdingPeriodDays?: number;
  onChain?: boolean;
}>;

/**
 * Classify a strategy, or admit it cannot be classified.
 *
 * Returns the literal string `"unknown"` rather than undefined so callers are
 * forced to handle it: a missing field is easy to ignore, a value that says
 * "unknown" is not.
 */
export function classifyFinanceStrategy(
  input: FinanceStrategyInput,
): FinanceStrategyClass | "unknown" {
  const asset = input.assetClass.trim().toLowerCase();
  if (input.onChain === true || asset === "web3" || asset === "onchain") {
    return "D";
  }
  if (asset.includes("crypto") || asset.includes("btc") || asset.includes("eth")) {
    return "B";
  }
  if (asset === "us_equity" || asset === "etf" || asset === "us_option") {
    const holding = input.holdingPeriodDays;
    if (typeof holding === "number" && holding > 365) {
      return "C";
    }
    return "A";
  }
  return "unknown";
}

export type FinanceMandateContext = Readonly<{
  strategy: FinanceStrategyInput;
  /** Risk at stake on this trade, as a fraction of equity. */
  riskFractionOfEquity: number;
  /** Current peak-to-trough drawdown as a positive fraction. */
  drawdownFraction: number;
  /** True when this order adds to an existing losing position. */
  averagingDown?: boolean;
  /** True when size was increased after a loss to win it back. */
  revengeSizing?: boolean;
  /** Present only when the class requires it. */
  hasSignificantAutocorrelation?: boolean;
  stopLossDefined?: boolean;
}>;

export type FinanceMandateDecision = Readonly<{
  strategyClass: FinanceStrategyClass | "unknown";
  verdict: FinanceVerdict;
  reasons: readonly string[];
  rules: FinanceClassRules | null;
}>;

/**
 * Evaluate one intended action against the mandate.
 *
 * Refusals are collected rather than thrown so the caller sees every reason at
 * once; a single reason invites fixing only that one and retrying.
 */
export function evaluateFinanceMandate(
  context: FinanceMandateContext,
  rules: Readonly<Record<FinanceStrategyClass, FinanceClassRules>> = DEFAULT_FINANCE_CLASS_RULES,
): FinanceMandateDecision {
  const strategyClass = classifyFinanceStrategy(context.strategy);
  if (strategyClass === "unknown") {
    return {
      strategyClass: "unknown",
      verdict: "refuse",
      reasons: [
        "strategy class cannot be determined; refusing rather than guessing which rules apply",
      ],
      rules: null,
    };
  }

  const classRules = rules[strategyClass];
  const reasons: string[] = [];

  // Class-independent: these come from the owner's own words.
  if (context.averagingDown === true) {
    reasons.push("refuse: adding to a losing position");
  }
  if (context.revengeSizing === true) {
    reasons.push("refuse: increasing size to win back a loss");
  }

  if (context.riskFractionOfEquity > classRules.maxRiskPerTradeFraction) {
    reasons.push(
      `refuse: risk ${(context.riskFractionOfEquity * 100).toFixed(2)}% exceeds the ${(
        classRules.maxRiskPerTradeFraction * 100
      ).toFixed(2)}% cap for class ${strategyClass}`,
    );
  }

  if (classRules.stopLossRequired && context.stopLossDefined !== true) {
    reasons.push(`refuse: class ${strategyClass} requires a defined stop`);
  }

  if (
    classRules.requireSignificantAutocorrelation &&
    context.hasSignificantAutocorrelation !== true
  ) {
    reasons.push(
      `refuse: class ${strategyClass} requires evidence of structure (significant ACF/PACF); none supplied`,
    );
  }

  if (
    classRules.maxDrawdownHaltFraction !== null &&
    context.drawdownFraction >= classRules.maxDrawdownHaltFraction
  ) {
    return {
      strategyClass,
      verdict: "needs_human",
      reasons: [
        `drawdown ${(context.drawdownFraction * 100).toFixed(1)}% reached the ${(
          classRules.maxDrawdownHaltFraction * 100
        ).toFixed(0)}% halt for class ${strategyClass}; manual review required`,
        ...reasons,
      ],
      rules: classRules,
    };
  }

  return {
    strategyClass,
    verdict: reasons.length > 0 ? "refuse" : "pass",
    reasons,
    rules: classRules,
  };
}
