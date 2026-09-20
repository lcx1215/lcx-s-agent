/**
 * Tests for association and significance.
 *
 * The point of this module is to distinguish "these two series move together" from "there is
 * evidence these two series are related". Tests therefore pin known statistical values (a t-table
 * value is not negotiable) and the two traps the module exists to catch: a spurious regression on
 * trending levels, and a correlation that is indistinguishable from zero.
 */

import { describe, expect, it } from "vitest";
import {
  correlationTest,
  eventStudy,
  incompleteBeta,
  leadLagCorrelation,
  regressionDiagnostics,
  spuriousRegressionCheck,
  studentTCritical,
  studentTTwoTailedP,
} from "./quant-math-inference.js";

/** Deterministic wiggle so tests never depend on a random seed. */
function series(length: number, fn: (index: number) => number): number[] {
  return Array.from({ length }, (_unused, index) => fn(index));
}

describe("distribution functions", () => {
  it("matches published two-tailed t values", () => {
    // t = 2.228 with 10 df is the 5% critical value.
    expect(studentTTwoTailedP(2.228, 10)).toBeCloseTo(0.05, 3);
    expect(studentTTwoTailedP(2.0, 10)).toBeCloseTo(0.0734, 3);
    expect(studentTTwoTailedP(0, 10)).toBeCloseTo(1, 12);
    // Large |t| is strong evidence, not weak.
    expect(studentTTwoTailedP(6, 20)).toBeLessThan(0.001);
  });

  it("recovers the familiar normal critical value as df grows", () => {
    expect(studentTCritical(0.975, 10)).toBeCloseTo(2.228, 3);
    expect(studentTCritical(0.975, 1_000_000)).toBeCloseTo(1.96, 2);
  });

  it("agrees with known incomplete beta values", () => {
    expect(incompleteBeta(1, 1, 0.5)).toBeCloseTo(0.5, 10);
    expect(incompleteBeta(2, 3, 0)).toBe(0);
    expect(incompleteBeta(2, 3, 1)).toBe(1);
  });
});

describe("correlationTest", () => {
  it("reports a perfect positive and a perfect negative relationship", () => {
    const up = series(10, (i) => i);
    expect(
      correlationTest(
        up,
        series(10, (i) => 2 * i),
      ).pearson,
    ).toBeCloseTo(1, 12);
    expect(
      correlationTest(
        up,
        series(10, (i) => 20 - 2 * i),
      ).pearson,
    ).toBeCloseTo(-1, 12);
  });

  it("does not call a weak correlation significant", () => {
    const up = series(12, (i) => i);
    const alternating = series(12, (i) => (i % 2 === 0 ? 1 : 0));
    const result = correlationTest(up, alternating);
    expect(Math.abs(result.pearson)).toBeLessThan(0.6);
    expect(result.smallSampleWarning).toBe(true);
  });

  it("flags a strong relationship as distinguishable from zero", () => {
    const up = series(40, (i) => i);
    const noisy = series(40, (i) => i + 0.2 * Math.sin(i));
    const result = correlationTest(up, noisy);
    expect(result.pearson).toBeGreaterThan(0.99);
    expect(result.indistinguishableFromZero).toBe(false);
    // The interval must bracket the point estimate.
    expect(result.confidenceInterval95[0]).toBeLessThan(result.pearson);
    expect(result.confidenceInterval95[1]).toBeGreaterThan(result.pearson);
  });
});

describe("regressionDiagnostics", () => {
  it("recovers a known slope and intercept", () => {
    const x = series(50, (i) => i);
    const y = series(50, (i) => 3 + 2 * i);
    const fit = regressionDiagnostics(x, y);
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.intercept).toBeCloseTo(3, 10);
    expect(fit.rSquared).toBeCloseTo(1, 12);
    expect(fit.slopePValue).toBeLessThan(0.001);
  });

  it("reports a wide interval when the data is mostly noise", () => {
    const x = series(30, (i) => i);
    const y = series(30, (i) => Math.sin(i * 3.7) * 10);
    const fit = regressionDiagnostics(x, y);
    expect(fit.rSquared).toBeLessThan(0.2);
    const width = fit.slopeConfidenceInterval95[1] - fit.slopeConfidenceInterval95[0];
    // The interval must be wide enough to contain zero when there is no signal.
    expect(fit.slopeConfidenceInterval95[0]).toBeLessThan(0);
    expect(fit.slopeConfidenceInterval95[1]).toBeGreaterThan(0);
    expect(width).toBeGreaterThan(0);
  });

  it("detects residual autocorrelation", () => {
    const x = series(60, (i) => i);
    // Residuals follow a smooth wave => strong positive autocorrelation => DW far below 2.
    const y = series(60, (i) => 2 * i + 5 * Math.sin(i / 2));
    const fit = regressionDiagnostics(x, y);
    expect(fit.durbinWatson).toBeLessThan(1);
  });
});

describe("spuriousRegressionCheck", () => {
  it("rejects a level fit that is only shared trend", () => {
    // Two series that both trend upward but whose changes are unrelated (sine vs cosine).
    const a = series(40, (i) => i + 0.3 * Math.sin(i));
    const b = series(40, (i) => 2 * i + 0.3 * Math.cos(i));
    const result = spuriousRegressionCheck(a, b);
    expect(result.levels.rSquared).toBeGreaterThan(0.8);
    expect(result.verdict).toBe("likely_spurious");
    expect(result.explanation).toMatch(/shared trend/);
  });

  it("recognises a real relationship that survives differencing", () => {
    // b changes are exactly 2x a changes: a genuine co-movement, not shared trend.
    const base = series(40, (i) => Math.sin(i * 1.3) * 2);
    const a: number[] = [];
    const b: number[] = [];
    let levelA = 100;
    let levelB = 50;
    for (const change of base) {
      levelA += change;
      levelB += 2 * change;
      a.push(levelA);
      b.push(levelB);
    }
    const result = spuriousRegressionCheck(a, b);
    expect(result.differences.slopePValue).toBeLessThan(0.001);
    expect(result.verdict).not.toBe("likely_spurious");
  });

  it("says inconclusive rather than inventing a relationship", () => {
    const a = series(40, (i) => Math.sin(i * 2.1));
    const b = series(40, (i) => Math.cos(i * 5.3));
    const result = spuriousRegressionCheck(a, b);
    expect(["inconclusive", "difference_relationship", "level_relationship"]).toContain(
      result.verdict,
    );
    expect(typeof result.explanation).toBe("string");
  });
});

describe("leadLagCorrelation", () => {
  it("finds the lag at which one series leads the other", () => {
    const driver = series(40, (i) => Math.sin(i * 0.7) * 3);
    // follower is driver shifted by 2, padded so lengths match.
    const follower = series(40, (i) => (i >= 2 ? driver[i - 2] : 0));
    const result = leadLagCorrelation(driver, follower, 4);
    expect(result.bestLag).toBe(2);
    expect(Math.abs(result.bestCorrelation)).toBeGreaterThan(0.9);
    expect(result.significant).toBe(true);
  });
});

describe("eventStudy", () => {
  it("detects a cumulative abnormal return around a known shock", () => {
    const market = series(80, (i) => 0.001 * Math.sin(i * 1.7));
    // Returns follow the market with beta 1.2, plus a 3-day +4% shock at index 60.
    const returns = series(80, (i) => {
      const base = 0.0005 + 1.2 * market[i] + 0.0002 * Math.sin(i * 3.1);
      return i >= 60 && i < 63 ? base + 0.04 : base;
    });
    const result = eventStudy({
      returns,
      marketReturns: market,
      estimationWindow: [0, 60],
      eventWindow: [60, 63],
    });
    expect(result.beta).toBeGreaterThan(0.9);
    expect(result.cumulativeAbnormalReturn).toBeGreaterThan(0.1);
    expect(result.significant).toBe(true);
  });

  it("does not report an event when there was none", () => {
    const market = series(80, (i) => 0.001 * Math.sin(i * 1.7));
    const returns = series(80, (i) => 0.0005 + 1.2 * market[i] + 0.0002 * Math.sin(i * 3.1));
    const result = eventStudy({
      returns,
      marketReturns: market,
      estimationWindow: [0, 60],
      eventWindow: [60, 63],
    });
    expect(result.significant).toBe(false);
  });

  it("refuses windows where estimation leaks into the event", () => {
    const market = series(80, () => 0.001);
    const returns = series(80, () => 0.001);
    expect(() =>
      eventStudy({
        returns,
        marketReturns: market,
        estimationWindow: [0, 70],
        eventWindow: [60, 63],
      }),
    ).toThrow(/must end before/);
  });
});
