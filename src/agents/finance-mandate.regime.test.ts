import { describe, expect, it } from "vitest";
import {
  DEFAULT_FINANCE_CLASS_RULES,
  applyRegimeToClassRules,
  evaluateFinanceMandate,
  type FinanceMandateContext,
} from "./finance-mandate.js";

const base: FinanceMandateContext = {
  strategy: { assetClass: "us_equity" },
  riskFractionOfEquity: 0.01,
  drawdownFraction: 0,
  stopLossDefined: true,
  hasSignificantAutocorrelation: true,
};

describe("applyRegimeToClassRules", () => {
  it("halves the per-trade cap in a risk-off regime", () => {
    const adjusted = applyRegimeToClassRules(DEFAULT_FINANCE_CLASS_RULES.A, "risk_off");
    expect(adjusted.maxRiskPerTradeFraction).toBeCloseTo(0.005, 10);
  });

  it("leaves the cap alone in a normal regime", () => {
    const adjusted = applyRegimeToClassRules(DEFAULT_FINANCE_CLASS_RULES.A, "normal");
    expect(adjusted.maxRiskPerTradeFraction).toBe(
      DEFAULT_FINANCE_CLASS_RULES.A.maxRiskPerTradeFraction,
    );
  });

  it("refuses to widen the cap even if the adjustment says to", () => {
    const loosened = {
      normal: { riskFractionMultiplier: 2, volatilityGateFraction: 0.2 },
    } as never;
    const adjusted = applyRegimeToClassRules(DEFAULT_FINANCE_CLASS_RULES.A, "normal", loosened);
    // A regime is a brake, never an accelerator.
    expect(adjusted.maxRiskPerTradeFraction).toBeLessThanOrEqual(
      DEFAULT_FINANCE_CLASS_RULES.A.maxRiskPerTradeFraction,
    );
  });

  it("does not disturb the parts of the rules a regime has no say in", () => {
    const original = DEFAULT_FINANCE_CLASS_RULES.C;
    const adjusted = applyRegimeToClassRules(original, "risk_off");
    expect(adjusted.stopLossKind).toBe(original.stopLossKind);
    expect(adjusted.evaluationPeriodDays).toBe(original.evaluationPeriodDays);
    expect(adjusted.maxDrawdownHaltFraction).toBe(original.maxDrawdownHaltFraction);
  });
});

describe("regime through evaluateFinanceMandate", () => {
  it("passes at 1% normally, and refuses the same trade once risk is off", () => {
    const normal = evaluateFinanceMandate({ ...base, regime: "normal" });
    expect(normal.verdict).toBe("pass");

    const riskOff = evaluateFinanceMandate({ ...base, regime: "risk_off" });
    expect(riskOff.verdict).toBe("refuse");
    expect(riskOff.reasons.join()).toMatch(/exceeds the .* cap/);
  });

  it("reports the tightened cap back to the caller", () => {
    const decision = evaluateFinanceMandate({ ...base, regime: "risk_off" });
    expect(decision.rules?.maxRiskPerTradeFraction).toBeCloseTo(0.005, 10);
  });

  it("actually scales the cap when volatility exceeds the gate", () => {
    // The gate was configured for a while and read by nothing, so the config
    // claimed volatility was being scaled and no code did it.
    const calm = evaluateFinanceMandate({
      ...base,
      riskFractionOfEquity: 0.008,
      realizedVolatilityFraction: 0.15,
    });
    const wild = evaluateFinanceMandate({
      ...base,
      riskFractionOfEquity: 0.008,
      realizedVolatilityFraction: 0.6,
    });
    // Gate is 0.20: at 0.60 volatility the cap shrinks to a third, so 0.8% no
    // longer fits.
    expect(calm.verdict).toBe("pass");
    expect(wild.verdict).toBe("refuse");
  });

  it("applies the volatility gate on top of a regime, not instead of it", () => {
    const both = evaluateFinanceMandate({
      ...base,
      riskFractionOfEquity: 0.004,
      regime: "risk_off",
      realizedVolatilityFraction: 0.6,
    });
    expect(both.verdict).toBe("refuse");
  });

  it("does not treat a regime note as a refusal", () => {
    // Guards a real bug: the tightening note was once pushed into `reasons`,
    // and any non-empty `reasons` reads as refuse.
    const decision = evaluateFinanceMandate({
      ...base,
      riskFractionOfEquity: 0.004,
      regime: "risk_off",
    });
    expect(decision.verdict).toBe("pass");
  });
});
