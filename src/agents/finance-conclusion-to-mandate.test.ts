import { describe, expect, it } from "vitest";
import { evaluateConclusionToMandate } from "./finance-conclusion-to-mandate.js";

const raw = {
  conclusionId: "fixture",
  instrument: "SPY",
  direction: "buy",
  conviction: 0.8,
  thesis: "fixture evidence",
  assetClass: "us_equity",
  horizonDays: 30,
  invalidationPrice: 95,
  evidence: [{ sourceId: "a" }, { sourceId: "b" }],
};
const params = {
  raw,
  referencePrice: 100,
  referencePriceAt: "2026-09-22T00:00:00Z",
  equity: 100000,
  runAuthorizationId: "fixture-no-execution",
};
const risk = {
  drawdownFraction: 0,
  averagingDown: false,
  revengeSizing: false,
  hasSignificantAutocorrelation: true,
};

describe("caller-owned conclusion risk context", () => {
  it("refuses absent context even when the model supplies reassuring risk claims", () => {
    expect(
      evaluateConclusionToMandate({ ...params, raw: { ...raw, riskContext: risk } }),
    ).toMatchObject({ ok: false, stage: "risk_context" });
  });
  it("passes only with explicit valid caller state", () => {
    expect(evaluateConclusionToMandate({ ...params, riskContext: risk })).toMatchObject({
      ok: true,
      passed: true,
      strategyClass: "A",
      mandate: { strategyClass: "A" },
    });
  });
  it.each(["averagingDown", "revengeSizing"] as const)(
    "refuses %s without emitting an executable intent",
    (flag) => {
      expect(
        evaluateConclusionToMandate({ ...params, riskContext: { ...risk, [flag]: true } }),
      ).toMatchObject({ ok: true, passed: false, intent: undefined });
    },
  );
  it("requires observed structure for a predictive class", () => {
    expect(
      evaluateConclusionToMandate({
        ...params,
        riskContext: { ...risk, hasSignificantAutocorrelation: undefined },
      }),
    ).toMatchObject({ ok: true, passed: false, intent: undefined });
  });
  it("uses observed drawdown and volatility rather than defaults", () => {
    expect(
      evaluateConclusionToMandate({ ...params, riskContext: { ...risk, drawdownFraction: 0.2 } }),
    ).toMatchObject({ passed: false, mandate: { verdict: "needs_human" }, intent: undefined });
    expect(
      evaluateConclusionToMandate({
        ...params,
        riskContext: { ...risk, realizedVolatilityFraction: 0.4 },
      }),
    ).toMatchObject({ passed: false, intent: undefined });
  });
  it("uses one horizon-aware strategy at both sizing and mandate", () => {
    const result = evaluateConclusionToMandate({
      ...params,
      raw: {
        ...raw,
        horizonDays: 900,
        invalidationPrice: undefined,
        invalidationCondition: "thesis invalidated",
      },
      riskContext: { ...risk, hasSignificantAutocorrelation: undefined },
    });
    expect(result).toMatchObject({
      ok: true,
      passed: true,
      strategyClass: "C",
      mandate: { strategyClass: "C" },
    });
  });
  it("refuses incomplete or malformed caller context", () => {
    for (const riskContext of [
      null,
      {},
      { ...risk, averagingDown: "false" },
      { ...risk, revengeSizing: undefined },
    ]) {
      expect(
        evaluateConclusionToMandate({
          ...params,
          riskContext: riskContext as unknown as typeof risk,
        }),
      ).toMatchObject({ ok: false, stage: "risk_context" });
    }
  });
});
