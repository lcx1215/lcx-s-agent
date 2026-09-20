/**
 * Tests for the foundational statistics.
 *
 * Each test pins a property that is true by construction or checkable by hand: a covariance matrix
 * reproduces a hand-computed variance, an identity matrix correlates to itself, a random walk is not
 * rejected as stationary, and scanning many lags at 5% manufactures a "finding" that the correction
 * then removes. A test that only asserted "a number came back" would prove nothing about any of it.
 */

import { describe, expect, it } from "vitest";
import { cholesky } from "./quant-math-advanced.js";
import {
  adfTest,
  adjustPValues,
  correlationMatrix,
  covarianceMatrix,
  fDistributionUpperTailP,
  grangerCausality,
  olsFit,
  rollingCorrelation,
  shrinkCovariance,
} from "./quant-math-foundations.js";
import { studentTTwoTailedP } from "./quant-math-inference.js";

/** Deterministic pseudo-random series, so a "significant" result cannot be luck of the seed. */
function pseudoRandom(seed: number, length: number): number[] {
  const values: number[] = [];
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    values.push(state / 2147483648 - 0.5);
  }
  return values;
}

function randomWalk(seed: number, length: number): number[] {
  const steps = pseudoRandom(seed, length);
  const values: number[] = [];
  let level = 100;
  for (const step of steps) {
    level += step * 2;
    values.push(level);
  }
  return values;
}

/** An AR(1) that is stationary by construction: |phi| < 1. */
function stationaryAr1(seed: number, length: number, phi: number): number[] {
  const shocks = pseudoRandom(seed, length);
  const values: number[] = [];
  let level = 0;
  for (const shock of shocks) {
    level = phi * level + shock;
    values.push(level);
  }
  return values;
}

describe("covarianceMatrix", () => {
  it("reproduces a hand-computed sample variance on the diagonal", () => {
    // Columns are assets: asset 0 = [1, 2, 3, 4], sample variance with n-1 is 5/3.
    const matrix = [
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ];
    const covariance = covarianceMatrix(matrix);
    expect(covariance[0][0]).toBeCloseTo(5 / 3, 12);
    // Perfectly linear second column: correlation to the first is exactly 1.
    expect(covariance[0][1]).toBeCloseTo((5 / 3) * 10, 12);
  });

  it("matches covariance computed directly from the definition", () => {
    const a = [2, 4, 6, 8, 10, 12, 14];
    const b = [1, 3, 2, 5, 8, 7, 11];
    const matrix = a.map((value, index) => [value, b[index]]);
    const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
    const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
    let expected = 0;
    for (let i = 0; i < a.length; i += 1) {
      expected += (a[i] - meanA) * (b[i] - meanB);
    }
    expected /= a.length - 1;
    expect(covarianceMatrix(matrix)[0][1]).toBeCloseTo(expected, 12);
  });

  it("is symmetric, which a hand-rolled accumulation loop can silently violate", () => {
    const matrix = pseudoRandom(7, 60).map((value, index) => [
      value,
      value * (index % 3),
      1 - value,
    ]);
    const covariance = covarianceMatrix(matrix);
    for (let i = 0; i < covariance.length; i += 1) {
      for (let j = 0; j < covariance.length; j += 1) {
        expect(covariance[i][j]).toBeCloseTo(covariance[j][i], 12);
      }
    }
  });

  it("refuses a single observation rather than dividing by zero", () => {
    expect(() => covarianceMatrix([[1, 2]])).toThrow(/at least two observations/u);
  });
});

describe("correlationMatrix", () => {
  it("puts exactly one on the diagonal", () => {
    const matrix = pseudoRandom(11, 40).map((value, index) => [value, index * 0.5 - value]);
    const correlation = correlationMatrix(matrix);
    expect(correlation[0][0]).toBeCloseTo(1, 12);
    expect(correlation[1][1]).toBeCloseTo(1, 12);
  });

  it("gives -1 for a perfectly inverted column, not +1", () => {
    const matrix = [
      [1, 5],
      [2, 4],
      [3, 3],
      [4, 2],
      [5, 1],
    ];
    expect(correlationMatrix(matrix)[0][1]).toBeCloseTo(-1, 12);
  });

  it("reports zero rather than NaN for a constant column", () => {
    const matrix = [
      [1, 7],
      [2, 7],
      [3, 7],
    ];
    const correlation = correlationMatrix(matrix);
    expect(correlation[0][1]).toBe(0);
    expect(correlation[1][1]).toBe(0);
  });
});

describe("olsFit", () => {
  it("recovers a known slope and intercept exactly", () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8];
    const y = x.map((value) => 3 + 2 * value);
    const fit = olsFit(y, [Array.from({ length: x.length }, () => 1), x]);
    expect(fit.coefficients[0]).toBeCloseTo(3, 10);
    expect(fit.coefficients[1]).toBeCloseTo(2, 10);
    // A perfect fit leaves no residual, so the standard errors collapse to zero.
    expect(fit.residualSumOfSquares).toBeCloseTo(0, 12);
  });

  it("refuses a collinear design instead of returning NaN coefficients", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(() => olsFit(y, [x, x.map((value) => value * 2)])).toThrow(/collinear/u);
  });

  it("refuses more regressors than observations", () => {
    expect(() =>
      olsFit(
        [1, 2],
        [
          [1, 2],
          [1, 2],
          [1, 2],
        ],
      ),
    ).toThrow(/not enough observations/u);
  });
});

describe("fDistributionUpperTailP", () => {
  it("returns 1 at f = 0 and falls towards 0 as f grows", () => {
    expect(fDistributionUpperTailP(0, 3, 20)).toBe(1);
    const small = fDistributionUpperTailP(1, 3, 20);
    const large = fDistributionUpperTailP(10, 3, 20);
    expect(large).toBeLessThan(small);
  });

  it("reproduces the two-tailed Student-t p-value exactly at F(1, df) = t^2", () => {
    // F(1, df) is t(df)^2, so the upper tail at t^2 must equal the two-tailed t p-value for every
    // t. This is an identity, not a coincidence at one point, and it is checked against the
    // independently written Student-t path rather than against a number copied from a table.
    const df = 18;
    for (const t of [0.5, 1.5, 2.1, 2.878, 4]) {
      expect(fDistributionUpperTailP(t * t, 1, df)).toBeCloseTo(studentTTwoTailedP(t, df), 12);
    }
  });

  it("lands on the published t critical values: 2.101 at 5% and 2.878 at 1% for 18 df", () => {
    expect(fDistributionUpperTailP(2.101 * 2.101, 1, 18)).toBeCloseTo(0.05, 3);
    expect(fDistributionUpperTailP(2.878 * 2.878, 1, 18)).toBeCloseTo(0.01, 3);
  });
});

describe("adfTest", () => {
  it("does not reject a unit root in a random walk", () => {
    const result = adfTest({ values: randomWalk(3, 300) });
    expect(result.verdict).toBe("unit_root");
    expect(result.statistic).toBeGreaterThan(result.criticalValues[2].value);
  });

  it("rejects a unit root in a stationary AR(1)", () => {
    const result = adfTest({ values: stationaryAr1(5, 400, 0.4) });
    expect(result.verdict).toBe("stationary");
    expect(result.statistic).toBeLessThan(result.criticalValues[1].value);
  });

  it("separates the two on the same generator, so the test is doing the work", () => {
    const walk = adfTest({ values: randomWalk(9, 300) });
    const stationary = adfTest({ values: stationaryAr1(9, 300, 0.3) });
    expect(stationary.statistic).toBeLessThan(walk.statistic - 1);
  });

  it("states that its critical values are asymptotic rather than implying sample-size precision", () => {
    expect(adfTest({ values: stationaryAr1(2, 200, 0.5) }).note).toMatch(/asymptotic/iu);
  });

  it("refuses a series too short to test", () => {
    expect(() => adfTest({ values: [1, 2, 3] })).toThrow(/at least 8/u);
  });
});

describe("adjustPValues", () => {
  it("shows that scanning many lags manufactures a finding, and then removes it", () => {
    // Twenty independent tests on noise: at 5% one is expected by chance alone.
    const pValues = Array.from({ length: 20 }, (_unused, index) => (index === 7 ? 0.03 : 0.6));
    const result = adjustPValues({ pValues });
    expect(result.rawSignificant).toBe(1);
    expect(result.adjustedSignificant).toBe(0);
    expect(result.rejected[7]).toBe(false);
  });

  it("keeps a genuinely strong result significant after correction", () => {
    const pValues = [0.0001, 0.0002, 0.7, 0.8];
    const result = adjustPValues({ pValues });
    expect(result.rejected[0]).toBe(true);
    expect(result.rejected[1]).toBe(true);
    expect(result.rejected[2]).toBe(false);
  });

  it("matches the Benjamini-Hochberg definition on a hand-worked case", () => {
    // p = [0.01, 0.02, 0.03, 0.04] with m = 4: adjusted[i] = min over j >= i of m/j * p_(j).
    const result = adjustPValues({ pValues: [0.01, 0.02, 0.03, 0.04] });
    // Largest: 4/4 * 0.04 = 0.04. Then 4/3 * 0.03 = 0.04. Then 4/2*0.02 = 0.04. Then 4/1*0.01=0.04.
    for (const value of result.adjusted) {
      expect(value).toBeCloseTo(0.04, 12);
    }
  });

  it("is monotone: a smaller raw p-value never gets a larger adjusted one", () => {
    const pValues = [0.9, 0.04, 0.4, 0.001, 0.03];
    const { adjusted } = adjustPValues({ pValues });
    const sortedByRaw = pValues
      .map((value, index) => ({ value, index }))
      .toSorted((a, b) => a.value - b.value);
    for (let i = 1; i < sortedByRaw.length; i += 1) {
      expect(adjusted[sortedByRaw[i].index]).toBeGreaterThanOrEqual(
        adjusted[sortedByRaw[i - 1].index] - 1e-12,
      );
    }
  });

  it("is at least as conservative as Bonferroni is not a claim; Bonferroni is never smaller", () => {
    const pValues = [0.01, 0.02, 0.3, 0.5];
    const bh = adjustPValues({ pValues, method: "benjamini_hochberg" });
    const bonferroni = adjustPValues({ pValues, method: "bonferroni" });
    for (let i = 0; i < pValues.length; i += 1) {
      expect(bh.adjusted[i]).toBeLessThanOrEqual(bonferroni.adjusted[i] + 1e-12);
    }
  });
});

describe("grangerCausality", () => {
  it("finds predictive precedence when x genuinely leads y", () => {
    const driver = stationaryAr1(21, 200, 0.5);
    // y_t = 0.6 * x_{t-1} + noise: the driver is the only thing in y's past that predicts it.
    const noise = pseudoRandom(22, 200);
    const y = driver.map((value, index) =>
      index === 0 ? noise[0] : 0.6 * driver[index - 1] + noise[index] * 0.3,
    );
    const result = grangerCausality({ y, x: driver, lags: 2 });
    expect(result.pValue).toBeLessThan(0.01);
    expect(result.predictivePrecedence).toBe(true);
  });

  it("does not find precedence between two independent series", () => {
    const result = grangerCausality({
      y: stationaryAr1(31, 200, 0.4),
      x: stationaryAr1(41, 200, 0.4),
      lags: 2,
    });
    expect(result.pValue).toBeGreaterThan(0.05);
    expect(result.predictivePrecedence).toBe(false);
  });

  it("cannot lose fit by adding regressors, which bounds the statistic below zero", () => {
    const result = grangerCausality({
      y: stationaryAr1(51, 150, 0.3),
      x: stationaryAr1(61, 150, 0.3),
      lags: 1,
    });
    expect(result.residualUnrestricted).toBeLessThanOrEqual(result.residualRestricted + 1e-12);
    expect(result.fStatistic).toBeGreaterThanOrEqual(0);
  });

  it("says what it established rather than claiming causation", () => {
    const result = grangerCausality({
      y: stationaryAr1(71, 120, 0.3),
      x: stationaryAr1(81, 120, 0.3),
      lags: 1,
    });
    expect(result.note).toMatch(/predictive, not causal/iu);
  });
});

describe("rollingCorrelation", () => {
  it("returns one correlation per window and is 1 when both series move together throughout", () => {
    const a = Array.from({ length: 30 }, (_unused, index) => index);
    const result = rollingCorrelation({ a, b: a.map((value) => value * 2 + 1), window: 10 });
    expect(result.windows).toBe(21);
    for (const value of result.correlations) {
      expect(value).toBeCloseTo(1, 12);
    }
    expect(result.range).toBeCloseTo(0, 12);
    expect(result.signFlips).toBe(0);
  });

  it("detects a relationship that flips sign halfway, which a single pooled correlation hides", () => {
    const length = 40;
    const a = Array.from({ length }, (_unused, index) => index);
    const b = a.map((value, index) => (index < length / 2 ? value : -value));
    const result = rollingCorrelation({ a, b, window: 10 });
    expect(result.min).toBeLessThan(-0.9);
    expect(result.max).toBeGreaterThan(0.9);
    expect(result.signFlips).toBeGreaterThan(0);
  });

  it("leaves instability unlabelled unless the caller states a threshold", () => {
    const a = Array.from({ length: 30 }, (_unused, index) => index);
    const b = a.map((value) => value * 2);
    expect(rollingCorrelation({ a, b, window: 10 }).unstable).toBeNull();
    expect(rollingCorrelation({ a, b, window: 10, unstableRangeThreshold: 0.5 }).unstable).toBe(
      false,
    );
  });

  it("refuses a window longer than the series", () => {
    expect(() => rollingCorrelation({ a: [1, 2, 3], b: [1, 2, 3], window: 10 })).toThrow(
      /shorter than the window/u,
    );
  });
});

describe("shrinkCovariance", () => {
  function independentRows(observations: number, assets: number): number[][] {
    return Array.from({ length: observations }, (_unused, index) =>
      pseudoRandom(1000 + index * 7, assets).map((value) => (value - 0.5) * 0.02),
    );
  }

  /** One common factor: every asset loads on it, so the covariance has real structure. */
  function factorRows(observations: number, assets: number): number[][] {
    const factor = pseudoRandom(5001, observations).map((value) => (value - 0.5) * 0.03);
    const loadings = pseudoRandom(6001, assets).map((value) => 0.5 + value * 1.5);
    return Array.from({ length: observations }, (_unused, t) =>
      loadings.map(
        (beta, asset) =>
          beta * factor[t] + (pseudoRandom(7001 + asset * 13 + t * 31, 1)[0] - 0.5) * 0.01,
      ),
    );
  }

  it("makes a singular sample covariance usable without pretending it was fine", () => {
    // 30 observations for 50 assets: singular by construction, and the shape crypto data arrives in.
    const result = shrinkCovariance({ returnsMatrix: independentRows(30, 50) });
    expect(result.sampleUsable).toBe(false);
    expect(cholesky(result.covariance)).not.toBeNull();
  });

  it("keeps the estimate invertible when assets equal observations", () => {
    const result = shrinkCovariance({ returnsMatrix: independentRows(60, 60) });
    expect(result.sampleUsable).toBe(false);
    expect(cholesky(result.covariance)).not.toBeNull();
  });

  it("shrinks less as the sample grows, when there is real structure to recover", () => {
    // This is the property that says the intensity is estimated rather than fixed: with one common
    // factor and more history, the sample covariance needs less help.
    const intensities = [30, 120, 500, 1000].map(
      (observations) =>
        shrinkCovariance({ returnsMatrix: factorRows(observations, 20) }).shrinkageIntensity,
    );
    for (let i = 1; i < intensities.length; i += 1) {
      expect(intensities[i]).toBeLessThan(intensities[i - 1]);
    }
  });

  it("shrinks hard when the assets are independent, because there is no structure to preserve", () => {
    // Equal-variance independent assets have a true covariance close to m*I. Recognising that and
    // shrinking towards the target is the correct behaviour, not a failure to fit.
    const result = shrinkCovariance({ returnsMatrix: independentRows(250, 20) });
    expect(result.shrinkageIntensity).toBeGreaterThan(0.5);
  });

  it("stays inside [0, 1] and symmetric across every shape tried", () => {
    for (const [observations, assets] of [
      [30, 50],
      [60, 20],
      [250, 20],
      [1000, 10],
    ] as const) {
      const result = shrinkCovariance({ returnsMatrix: independentRows(observations, assets) });
      expect(result.shrinkageIntensity).toBeGreaterThanOrEqual(0);
      expect(result.shrinkageIntensity).toBeLessThanOrEqual(1);
      for (let i = 0; i < assets; i += 1) {
        for (let j = 0; j < assets; j += 1) {
          expect(result.covariance[i][j]).toBeCloseTo(result.covariance[j][i], 12);
        }
      }
    }
  });

  it("refuses all-zero data instead of returning a matrix of nothing", () => {
    expect(() =>
      shrinkCovariance({
        returnsMatrix: [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
      }),
    ).toThrow(/zero variance/u);
  });

  it("says the sample was already usable when it was, so callers can skip shrinking", () => {
    const result = shrinkCovariance({ returnsMatrix: factorRows(400, 10) });
    expect(result.sampleUsable).toBe(true);
  });
});
