import { describe, expect, it } from "vitest";
import {
  classifyFinanceStrategy,
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

describe("classifyFinanceStrategy", () => {
  it("routes crypto away from equities", () => {
    expect(classifyFinanceStrategy({ assetClass: "crypto" })).toBe("B");
  });

  it("routes on-chain explicitly", () => {
    expect(classifyFinanceStrategy({ assetClass: "us_equity", onChain: true })).toBe("D");
  });

  it("reads a long holding period as value investing", () => {
    expect(classifyFinanceStrategy({ assetClass: "us_equity", holdingPeriodDays: 500 })).toBe("C");
  });

  it("admits defeat instead of guessing", () => {
    expect(classifyFinanceStrategy({ assetClass: "soybean_futures" })).toBe("unknown");
  });
});

describe("evaluateFinanceMandate", () => {
  it("refuses when the class cannot be determined", () => {
    const decision = evaluateFinanceMandate({
      ...base,
      strategy: { assetClass: "soybean_futures" },
    });
    expect(decision.verdict).toBe("refuse");
    expect(decision.rules).toBeNull();
    expect(decision.reasons.join()).toMatch(/cannot be determined/);
  });

  it("applies a tighter risk cap to crypto than to equities", () => {
    // 1% is fine for A, over the line for B.
    const decision = evaluateFinanceMandate({
      ...base,
      strategy: { assetClass: "crypto" },
      riskFractionOfEquity: 0.01,
    });
    expect(decision.strategyClass).toBe("B");
    expect(decision.verdict).toBe("refuse");
  });

  it("halts a short-term strategy at a drawdown that value investing absorbs", () => {
    const at20 = { ...base, drawdownFraction: 0.2 };
    const shortTerm = evaluateFinanceMandate(at20);
    const value = evaluateFinanceMandate({
      ...at20,
      strategy: { assetClass: "us_equity", holdingPeriodDays: 500 },
    });
    // The same 20% drawdown is a halt for A and ordinary for C. That asymmetry
    // is the whole point of splitting the mandate by class.
    expect(shortTerm.verdict).toBe("needs_human");
    expect(value.strategyClass).toBe("C");
    expect(value.verdict).toBe("pass");
  });

  it("refuses averaging down in every class", () => {
    const decision = evaluateFinanceMandate({ ...base, averagingDown: true });
    expect(decision.verdict).toBe("refuse");
    expect(decision.reasons.join()).toMatch(/losing position/);
  });

  it("refuses revenge sizing", () => {
    const decision = evaluateFinanceMandate({ ...base, revengeSizing: true });
    expect(decision.verdict).toBe("refuse");
    expect(decision.reasons.join()).toMatch(/win back/);
  });

  it("demands structure evidence from predictive classes only", () => {
    const noEcho = { ...base, hasSignificantAutocorrelation: false };
    // A is predictive: no echo, no trade.
    expect(evaluateFinanceMandate(noEcho).verdict).toBe("refuse");
    // C is not: it must not be refused for lacking an echo.
    const value = evaluateFinanceMandate({
      ...noEcho,
      strategy: { assetClass: "us_equity", holdingPeriodDays: 500 },
    });
    expect(value.verdict).toBe("pass");
  });

  it("requires a stop where the class requires one, and not where it does not", () => {
    const noStop = { ...base, stopLossDefined: false };
    expect(evaluateFinanceMandate(noStop).verdict).toBe("refuse");
    const value = evaluateFinanceMandate({
      ...noStop,
      strategy: { assetClass: "us_equity", holdingPeriodDays: 500 },
    });
    expect(value.verdict).toBe("pass");
  });

  it("reports every refusal at once rather than only the first", () => {
    const decision = evaluateFinanceMandate({
      ...base,
      averagingDown: true,
      revengeSizing: true,
      riskFractionOfEquity: 0.5,
    });
    expect(decision.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a risk that is not a finite number instead of passing it", () => {
    // Every comparison against NaN is false, so a NaN risk would clear the cap
    // and be reported as safe. Unknown risk is not low risk.
    const decision = evaluateFinanceMandate({
      ...base,
      riskFractionOfEquity: Number.NaN,
    });
    expect(decision.verdict).toBe("refuse");
    expect(decision.reasons.join()).toMatch(/not a finite number/);
  });

  it("refuses an unknown drawdown rather than treating it as none", () => {
    const decision = evaluateFinanceMandate({
      ...base,
      drawdownFraction: Number.NaN,
    });
    expect(decision.verdict).toBe("refuse");
    expect(decision.reasons.join()).toMatch(/drawdown is not a finite/);
  });
});
