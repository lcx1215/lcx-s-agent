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
  it("allows averaging down only when the trusted caller marks a planned scale-in", () => {
    expect(
      evaluateConclusionToMandate({
        ...params,
        riskContext: { ...risk, averagingDown: true, plannedScaleIn: true },
      }),
    ).toMatchObject({ ok: true, passed: true });
  });
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

it("measures whole-position risk when class C compiler does not attach the model's price stop", () => {
  const value = {
    ...params,
    raw: {
      ...raw,
      horizonDays: 900,
      invalidationCondition: "thesis fails",
      invalidationPrice: 99.99,
    },
    riskContext: risk,
  };
  const normal = evaluateConclusionToMandate(value);
  expect(normal).toMatchObject({ ok: true, passed: true, strategyClass: "C" });
  if (!normal.ok || !normal.intent) {
    throw new Error("expected valid class C intent");
  }
  expect(normal.intent.stopPrice).toBeUndefined();
  expect((normal.intent.quantity * normal.intent.referencePrice) / value.equity).toBeCloseTo(0.03);
  const tightened = evaluateConclusionToMandate({ ...value, regime: "risk_off" });
  expect(tightened).toMatchObject({ ok: true, passed: false, intent: undefined });
  if (!tightened.ok) {
    throw new Error("expected mandate decision");
  }
  expect(tightened.mandate.reasons.join()).toContain("risk 3.00% exceeds the 1.50% cap");
});

describe("controller-owned exact quantity preflight", () => {
  const crypto = {
    ...params,
    raw: {
      ...raw,
      instrument: "BTC/USD",
      assetClass: "crypto",
      direction: "sell",
      invalidationPrice: 110,
    },
    riskContext: risk,
  };
  it("measures a small exact crypto reduction instead of a synthetic risk-sized position", () => {
    const result = evaluateConclusionToMandate({ ...crypto, quantityOverride: 0.000399 });
    expect(result).toMatchObject({
      ok: true,
      passed: true,
      strategyClass: "B",
      intent: { quantity: 0.000399, side: "sell" },
    });
  });
  it("still refuses an exact quantity that exceeds the class risk ceiling", () => {
    expect(evaluateConclusionToMandate({ ...crypto, quantityOverride: 51 })).toMatchObject({
      ok: true,
      passed: false,
      intent: undefined,
    });
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid controller quantity %s",
    (quantityOverride) => {
      expect(evaluateConclusionToMandate({ ...crypto, quantityOverride })).toMatchObject({
        ok: false,
        stage: "compile",
      });
    },
  );
  it("does not accept a model-authored exact quantity", () => {
    const result = evaluateConclusionToMandate({
      ...crypto,
      raw: { ...crypto.raw, quantityOverride: 0.000399 },
    });
    expect(result).toMatchObject({ ok: true, passed: true, intent: { quantity: 50 } });
  });
  it("preserves caller risk and predictive structure requirements with exact quantity", () => {
    expect(
      evaluateConclusionToMandate({
        ...crypto,
        quantityOverride: 0.000399,
        riskContext: undefined,
      }),
    ).toMatchObject({ ok: false, stage: "risk_context" });
    expect(
      evaluateConclusionToMandate({
        ...crypto,
        quantityOverride: 0.000399,
        riskContext: { ...risk, hasSignificantAutocorrelation: undefined },
      }),
    ).toMatchObject({ ok: true, passed: false, intent: undefined });
  });
  it("retains the risk ceiling for controller-sized buys", () => {
    expect(
      evaluateConclusionToMandate({ ...params, quantityOverride: 201, riskContext: risk }),
    ).toMatchObject({ ok: true, passed: false, intent: undefined });
  });
});
