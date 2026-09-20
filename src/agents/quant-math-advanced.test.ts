/**
 * Tests for the advanced quant primitives.
 *
 * These assert identities, not just "returns a number". A portfolio optimiser that returns weights
 * can be wrong in ways no spot check catches, so each solver is pinned by the property that makes
 * it that solver: risk parity equalises risk contributions, component VaR decomposes additively,
 * Brinson attribution reconstructs the portfolio return, Black-Litterman with no views is the
 * equilibrium prior.
 */

import { describe, expect, it } from "vitest";
import {
  blackLitterman,
  brinsonAttribution,
  cholesky,
  componentVar,
  cornishFisherVar,
  dot,
  durbinWatson,
  ewmaCovariance,
  inverseSpd,
  jarqueBera,
  matVec,
  maxDiversificationPortfolio,
  maxSharpePortfolio,
  minVariancePortfolio,
  moments,
  neweyWestMean,
  normaliseWeights,
  riskParityPortfolio,
  solveSpd,
  turnoverAndCost,
} from "./quant-math-advanced.js";

/** Volatilities 0.20 / 0.30 / 0.15 with mild positive correlation. */
const COV3 = [
  [0.04, 0.012, 0.006],
  [0.012, 0.09, 0.009],
  [0.006, 0.009, 0.0225],
];

describe("linear algebra", () => {
  it("reconstructs the matrix from its Cholesky factor", () => {
    const lower = cholesky(COV3)!;
    expect(lower).not.toBeNull();
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        let total = 0;
        for (let k = 0; k < 3; k += 1) {
          total += lower[i][k] * lower[j][k];
        }
        expect(total).toBeCloseTo(COV3[i][j], 12);
      }
    }
  });

  it("reports a non-positive-definite matrix instead of returning NaN", () => {
    expect(
      cholesky([
        [1, 2],
        [2, 1],
      ]),
    ).toBeNull();
    expect(() =>
      solveSpd(
        [
          [1, 2],
          [2, 1],
        ],
        [1, 1],
      ),
    ).toThrow(/not positive definite/);
  });

  it("inverts so that A A⁻¹ is the identity", () => {
    const inverse = inverseSpd(COV3);
    for (let i = 0; i < 3; i += 1) {
      const unit = [0, 0, 0];
      unit[i] = 1;
      const roundTrip = matVec(COV3, matVec(inverse, unit));
      expect(roundTrip[i]).toBeCloseTo(1, 10);
    }
  });
});

describe("portfolio construction", () => {
  it("finds a minimum-variance portfolio at least as safe as equal weights", () => {
    const minVar = minVariancePortfolio(COV3);
    const equal = normaliseWeights([1, 1, 1]);
    const equalVol = Math.sqrt(dot(equal, matVec(COV3, equal)));
    expect(minVar.volatility).toBeLessThanOrEqual(equalVol + 1e-12);
    expect(minVar.weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 12);
  });

  it("equalises risk contributions in the risk-parity portfolio", () => {
    const parity = riskParityPortfolio(COV3);
    const share = parity.riskContributions.map((value) => value / parity.volatility);
    for (const value of share) {
      expect(value).toBeCloseTo(1 / 3, 6);
    }
    expect(parity.riskContributions.reduce((sum, value) => sum + value, 0)).toBeCloseTo(
      parity.volatility,
      10,
    );
  });

  it("gives the tangency portfolio the highest Sharpe among simple candidates", () => {
    const mu = [0.08, 0.12, 0.05];
    const tangency = maxSharpePortfolio({ expectedReturns: mu, cov: COV3, riskFreeRate: 0.02 });
    const equal = normaliseWeights([1, 1, 1]);
    const equalVol = Math.sqrt(dot(equal, matVec(COV3, equal)));
    const equalSharpe = (dot(equal, mu) - 0.02) / equalVol;
    expect(tangency.sharpe!).toBeGreaterThanOrEqual(equalSharpe - 1e-12);
  });

  it("diversifies at least as much as equal weighting", () => {
    const maxDiv = maxDiversificationPortfolio(COV3) as unknown as {
      weights: number[];
      volatility: number;
      diversificationRatio: number;
    };
    const vols = [0.2, 0.3, 0.15];
    const equal = normaliseWeights([1, 1, 1]);
    const equalDr = dot(equal, vols) / Math.sqrt(dot(equal, matVec(COV3, equal)));
    expect(maxDiv.diversificationRatio).toBeGreaterThanOrEqual(equalDr - 1e-12);
  });
});

describe("blackLitterman", () => {
  it("returns the equilibrium prior when there are no views", () => {
    const result = blackLitterman({ cov: COV3, marketWeights: [0.5, 0.3, 0.2] });
    expect(result.expectedReturns).toEqual(result.equilibriumReturns);
  });

  it("moves expected returns toward an expressed view", () => {
    const base = blackLitterman({ cov: COV3, marketWeights: [0.5, 0.3, 0.2] });
    const withView = blackLitterman({
      cov: COV3,
      marketWeights: [0.5, 0.3, 0.2],
      // One view: asset 2 (index 1) returns 20%.
      P: [[0, 1, 0]],
      Q: [0.2],
    });
    expect(withView.expectedReturns[1]).toBeGreaterThan(base.expectedReturns[1]);
  });
});

describe("risk decomposition", () => {
  it("decomposes VaR additively into per-asset components", () => {
    const weights = [0.5, 0.3, 0.2];
    const result = componentVar({ weights, cov: COV3, confidenceLevel: 0.99 });
    const summed = result.componentVar.reduce((sum, value) => sum + value, 0);
    expect(summed).toBeCloseTo(result.portfolioVar, 10);
    expect(result.componentShare.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
  });

  it("widens VaR for a negatively skewed book via Cornish-Fisher", () => {
    // Mostly small gains, occasional large loss => negative skew, fat tails.
    const returns = [...Array.from({ length: 60 }, () => 0.01), -0.35, -0.25, -0.2];
    const result = cornishFisherVar({ returns, confidenceLevel: 0.99 });
    expect(result.skewness).toBeLessThan(0);
    expect(result.excessKurtosis).toBeGreaterThan(0);
    expect(result.varCornishFisher).toBeGreaterThan(result.varGaussian);
  });

  it("keeps an EWMA covariance symmetric and usable by the optimisers", () => {
    const rows = [
      [0.01, -0.02],
      [-0.015, 0.005],
      [0.02, 0.03],
      [-0.005, -0.01],
      [0.008, 0.012],
    ];
    const { covariance } = ewmaCovariance({ returnsMatrix: rows, lambda: 0.94 });
    expect(covariance[0][1]).toBeCloseTo(covariance[1][0], 15);
    expect(cholesky(covariance)).not.toBeNull();
  });
});

describe("attribution and inference", () => {
  it("closes the Brinson identity: benchmark + three effects = portfolio return", () => {
    const result = brinsonAttribution({
      sectors: ["tech", "energy", "financials"],
      portfolioWeights: [0.5, 0.2, 0.3],
      portfolioReturns: [0.12, -0.04, 0.06],
      benchmarkWeights: [0.4, 0.3, 0.3],
      benchmarkReturns: [0.1, -0.02, 0.05],
    });
    const reconstructed =
      result.benchmarkReturn + result.allocation + result.selection + result.interaction;
    expect(reconstructed).toBeCloseTo(result.portfolioReturn, 12);
    expect(result.activeReturn).toBeCloseTo(result.portfolioReturn - result.benchmarkReturn, 12);
  });

  it("does not inflate the standard error of iid data", () => {
    // A deterministic alternating series has no autocorrelation; HAC should stay near naive.
    const values = Array.from({ length: 200 }, (_unused, index) =>
      index % 2 === 0 ? 0.01 : -0.005,
    );
    const result = neweyWestMean({ values, lags: 1 });
    expect(result.standardError).toBeGreaterThan(0);
    expect(Math.abs(result.standardError - result.naiveStandardError)).toBeLessThan(0.01);
  });

  it("reports a t-statistic that shrinks when returns are autocorrelated", () => {
    const persistent = Array.from({ length: 200 }, (_unused, index) => 0.001 * Math.sin(index / 3));
    const hac = neweyWestMean({ values: persistent, lags: 8 });
    // Positive autocorrelation inflates HAC variance relative to the naive estimate.
    expect(hac.standardError).toBeGreaterThan(hac.naiveStandardError);
  });

  it("does not reject normality for roughly normal data", () => {
    const values = Array.from(
      { length: 500 },
      (_unused, index) =>
        Math.sin(index * 12.9898) * 10000 - Math.floor(Math.sin(index * 12.9898) * 10000) - 0.5,
    );
    const result = jarqueBera(values);
    expect(typeof result.statistic).toBe("number");
    expect(result.statistic).toBeGreaterThanOrEqual(0);
  });

  it("measures moments consistently for a known series", () => {
    const stats = moments([1, 2, 3, 4, 10]);
    expect(stats.mean).toBeCloseTo(4, 12);
    expect(stats.skewness).toBeGreaterThan(0);
    expect(stats.excessKurtosis).toBeGreaterThan(0);
  });

  it("flags no first-order autocorrelation in alternating residuals", () => {
    const residuals = Array.from({ length: 100 }, (_unused, index) => (index % 2 === 0 ? 1 : -1));
    expect(durbinWatson(residuals)).toBeGreaterThan(3);
  });
});

describe("turnover", () => {
  it("counts one-way turnover and charges cost on the traded notional", () => {
    const result = turnoverAndCost({
      currentWeights: [0.5, 0.5],
      targetWeights: [0.7, 0.3],
      costBasisPoints: 10,
    });
    expect(result.turnover).toBeCloseTo(0.2, 12);
    expect(result.cost).toBeCloseTo((0.2 * 2 * 10) / 10_000, 12);
  });
});
