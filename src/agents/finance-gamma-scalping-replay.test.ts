import { describe, expect, it } from "vitest";
import {
  replayGammaScalping,
  type GammaScalpingReplayInput,
} from "./finance-gamma-scalping-replay.js";

const fixture = (
  prices: number[],
  overrides: Partial<GammaScalpingReplayInput> = {},
): GammaScalpingReplayInput => ({
  samples: prices.map((spot, elapsedDays) => ({ elapsedDays, spot, impliedVolatility: 0.3 })),
  strike: 100,
  expiryDays: 30,
  contractsPerLeg: 1,
  contractMultiplier: 100,
  hedgeEnabled: true,
  deltaBandShares: 10,
  hedgeLotShares: 1,
  maxHedgeShares: 100,
  optionHalfSpreadPerShare: 0.02,
  optionCommissionPerContract: 0.5,
  stockHalfSpreadAndSlippagePerShare: 0.01,
  stockCommissionPerShare: 0.005,
  cashBorrowRateAnnual: 0.05,
  shortBorrowRateAnnual: 0.02,
  ...overrides,
});

describe("Gamma Scalping synthetic self-financing replay", () => {
  it("rejects arithmetic overflow rather than reporting null JSON Greek values", () => {
    const input = fixture([100, 104, 100]);
    expect(() =>
      replayGammaScalping({
        ...input,
        samples: input.samples.map((s) => ({ ...s, impliedVolatility: Number.MIN_VALUE })),
      }),
    ).toThrow("must remain finite");
    expect(() =>
      replayGammaScalping({ ...input, contractsPerLeg: Number.MAX_SAFE_INTEGER }),
    ).toThrow("safe integers");
  });
  it("hedges the nonzero initial ATM delta and loses theta on a flat path", () => {
    const result = replayGammaScalping(fixture(Array<number>(16).fill(100)));
    expect(result.rows[0].optionDeltaShares).toBeGreaterThan(0);
    expect(result.rows[0].hedgeShares).toBeLessThan(0);
    expect(result.optionMarkPnl).toBeLessThan(0);
    expect(result.hedgePnl).toBe(0);
    expect(result.netPnl).toBeLessThan(0);
    expect(result.financingCosts).toBeGreaterThan(0);
    expect(result.shortBorrowCosts).toBeGreaterThan(0);
    expect(result.reconciliationResidual).toBeCloseTo(0, 10);
  });

  it("reconciles an oscillating path without treating hedge gains as total gamma", () => {
    const input = fixture([100, 104, 100, 96, 100, 104, 100, 96, 100]);
    const result = replayGammaScalping(input);
    expect(result.netPnl).toBeGreaterThan(0);
    expect(result.rows[1].hedgeTradeShares).toBeLessThan(0);
    expect(result.rows[2].hedgeTradeShares).toBeGreaterThan(0);
    expect(result.rows.at(-1)?.hedgeShares).toBe(0);
    expect(result.rows.at(-1)?.netPnl).toBe(result.netPnl);
    expect(result.reconciliationResidual).toBeCloseTo(0, 10);
    const a = result.attribution;
    expect(a.residualDelta + a.gamma + a.theta + a.vega + a.approximationResidual).toBeCloseTo(
      result.optionMarkPnl + result.hedgePnl,
      10,
    );
    const baseline = replayGammaScalping({ ...input, hedgeEnabled: false });
    expect(baseline.hedgeCosts).toBe(0);
    expect(baseline.hedgePnl).toBe(0);
    expect(baseline.optionCosts).toBe(result.optionCosts);
    expect(baseline.netPnl).toBeLessThan(result.netPnl);
    expect(result.executionAuthority).toBe("none");
  });

  it("keeps trend hedge losses together with positive option revaluation", () => {
    const result = replayGammaScalping(fixture([100, 104, 108, 112, 116]));
    expect(result.hedgePnl).toBeLessThan(0);
    expect(result.optionMarkPnl).toBeGreaterThan(0);
    expect(result.netPnl).toBeCloseTo(
      result.optionMarkPnl + result.hedgePnl - result.totalCosts,
      10,
    );
  });

  it("records IV-crush vega losses and a reconciliation residual for the approximation", () => {
    const input = fixture([100, 100, 100]);
    const result = replayGammaScalping({
      ...input,
      samples: input.samples.map((s, i) => ({ ...s, impliedVolatility: i === 0 ? 0.5 : 0.2 })),
    });
    expect(result.attribution.vega).toBeLessThan(0);
    expect(result.netPnl).toBeLessThan(0);
    expect(result.reconciliationResidual).toBeCloseTo(0, 10);
  });

  it("settles expiry intrinsic without paying early-exit option spreads", () => {
    const result = replayGammaScalping(
      fixture([100, 100], {
        samples: [
          { elapsedDays: 0, spot: 100, impliedVolatility: 0.3 },
          { elapsedDays: 30, spot: 100, impliedVolatility: 0.3 },
        ],
      }),
    );
    expect(result.optionMarkPnl).toBe(-result.initialPremium);
    expect(result.optionCosts).toBe(5);
    expect(result.rows.at(-1)?.optionValue).toBe(0);
    expect(result.reconciliationResidual).toBeCloseTo(0, 10);
  });

  it("charges both option legs and both stock entry/exit sides exactly once", () => {
    const result = replayGammaScalping(fixture([100, 100]));
    expect(result.optionCosts).toBe(10);
    const shares = Math.abs(result.rows[0].hedgeTradeShares);
    expect(result.hedgeCosts).toBeCloseTo(shares * 2 * 0.015, 12);
  });

  it("holds shares inside the declared residual delta band without lookahead", () => {
    const result = replayGammaScalping(fixture([100, 100.01, 100.02]));
    expect(result.rows[1].hedgeTradeShares).toBe(0);
    const other = replayGammaScalping(fixture([100, 100.01, 130]));
    expect(other.rows.slice(0, 2)).toEqual(result.rows.slice(0, 2));
  });

  it("rejects rather than clipping a hedge outside inventory capacity", () => {
    expect(() => replayGammaScalping(fixture([100, 110, 100], { maxHedgeShares: 5 }))).toThrow(
      "maxHedgeShares",
    );
  });

  it.each([
    { deltaBandShares: Number.NaN },
    { stockCommissionPerShare: -1 },
    { contractsPerLeg: 0.5 },
    { hedgeLotShares: 0 },
    { cashBorrowRateAnnual: Number.POSITIVE_INFINITY },
  ])("rejects invalid explicit parameters %j", (overrides) => {
    expect(() => replayGammaScalping(fixture([100, 101], overrides))).toThrow();
  });

  it("rejects missing costs, nonmonotone time, post-expiry and zero IV", () => {
    const input = fixture([100, 101]);
    expect(() =>
      replayGammaScalping({
        ...input,
        optionHalfSpreadPerShare: undefined,
      } as unknown as GammaScalpingReplayInput),
    ).toThrow();
    for (const sample of [
      { elapsedDays: 0, spot: 101, impliedVolatility: 0.3 },
      { elapsedDays: 31, spot: 101, impliedVolatility: 0.3 },
      { elapsedDays: 1, spot: 101, impliedVolatility: 0 },
    ]) {
      expect(() =>
        replayGammaScalping({ ...input, samples: [input.samples[0], sample] }),
      ).toThrow();
    }
  });
});
