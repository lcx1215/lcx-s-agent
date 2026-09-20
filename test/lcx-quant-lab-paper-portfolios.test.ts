/**
 * Paper portfolios: the toolkit run against the portfolio shapes that actually show up.
 *
 * Unit tests prove the maths. These prove the toolkit survives the data: more coins than days of
 * history, a coin that never traded, two tickers that are the same asset twice, correlations that
 * collapse to one in a selloff. Each case below is a shape real crypto data arrives in, and the
 * assertion is about what the toolkit does with it — solve it, refuse it, or say which.
 *
 * The dangerous outcome is never an exception; it is a plausible-looking answer built on a matrix
 * that was not invertible, or a numeric zero that was really "no data".
 */

import { describe, expect, it } from "vitest";
import {
  cholesky,
  componentVar,
  cornishFisherVar,
  durbinWatson,
  ewmaCovariance,
  neweyWestMean,
  stressTest,
  jarqueBera,
  maxSharpePortfolio,
  minVariancePortfolio,
  maxDiversificationPortfolio,
  riskParityPortfolio,
  covarianceConditioning,
  autocorrelationFunction,
  partialAutocorrelationFunction,
  brinsonAttribution,
  blackLitterman,
  turnoverAndCost,
} from "../src/agents/quant-math-advanced.js";
import {
  covarianceMatrix,
  shrinkCovariance,
  correlationMatrix,
  adfTest,
} from "../src/agents/quant-math-foundations.js";

function pseudoRandom(seed: number, length: number): number[] {
  const values: number[] = [];
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    values.push(state / 2147483648);
  }
  return values;
}

function gaussianSeries(seed: number, days: number, scale = 0.012): number[] {
  const uniforms = pseudoRandom(seed, days * 2);
  const out: number[] = [];
  for (let i = 0; i < days; i += 1) {
    const u1 = Math.max(uniforms[2 * i], 1e-12);
    out.push(scale * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * uniforms[2 * i + 1]));
  }
  return out;
}

function dailyReturns(seed: number, days: number, scale = 0.02): number[] {
  return pseudoRandom(seed, days).map((value) => (value - 0.5) * scale);
}

/** One common factor: the correlation structure a real book has. */
function factorBook(params: { days: number; assets: number; seed?: number }): number[][] {
  const seed = params.seed ?? 5001;
  const factor = pseudoRandom(seed, params.days).map((value) => (value - 0.5) * 0.03);
  const loadings = pseudoRandom(seed + 1, params.assets).map((value) => 0.5 + value * 1.5);
  return Array.from({ length: params.days }, (_unused, day) =>
    loadings.map(
      (beta, asset) =>
        beta * factor[day] + (pseudoRandom(seed + 100 + asset * 13 + day * 31, 1)[0] - 0.5) * 0.01,
    ),
  );
}

function portfolioVolatility(cov: number[][], weights: number[]): number {
  let variance = 0;
  for (let i = 0; i < weights.length; i += 1) {
    for (let j = 0; j < weights.length; j += 1) {
      variance += weights[i] * weights[j] * cov[i][j];
    }
  }
  return Math.sqrt(Math.max(0, variance));
}

describe("paper portfolio: more coins than days of history", () => {
  it("is refused on the raw sample covariance, because it is singular by construction", () => {
    const book = factorBook({ days: 30, assets: 50 });
    expect(cholesky(covarianceMatrix(book))).toBeNull();
    expect(() => minVariancePortfolio(covarianceMatrix(book))).toThrow(/positive definite/u);
  });

  it("becomes solvable after shrinkage, and reports that the raw sample was not usable", () => {
    const book = factorBook({ days: 30, assets: 50 });
    const shrunk = shrinkCovariance({ returnsMatrix: book });
    expect(shrunk.sampleUsable).toBe(false);
    expect(shrunk.shrinkageIntensity).toBeGreaterThan(0);

    const solution = minVariancePortfolio(shrunk.covariance);
    const total = solution.weights.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 8);
    expect(solution.weights.every((value) => Number.isFinite(value))).toBe(true);
    expect(portfolioVolatility(shrunk.covariance, solution.weights)).toBeGreaterThan(0);
  });

  it("gives risk parity somewhere to start when the sample cannot support it", () => {
    const book = factorBook({ days: 40, assets: 60 });
    const shrunk = shrinkCovariance({ returnsMatrix: book });
    const solution = riskParityPortfolio(shrunk.covariance);
    expect(solution.weights).toHaveLength(60);
    expect(solution.weights.every((value) => Number.isFinite(value))).toBe(true);
    expect(solution.weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
  });
});

describe("paper portfolio: a coin that never traded", () => {
  it("is refused on the raw covariance, so a missing series cannot silently become a free hedge", () => {
    // A zero-variance column is extremely attractive to an optimiser: it looks like risk-free
    // exposure. Accepting it would put weight on an asset the data says nothing about.
    const live = dailyReturns(21, 80);
    const other = dailyReturns(33, 80);
    const book = live.map((value, index) => [value, 0, other[index]]);
    expect(cholesky(covarianceMatrix(book))).toBeNull();
    expect(() => minVariancePortfolio(covarianceMatrix(book))).toThrow(/positive definite/u);
  });

  it("becomes usable after shrinkage, which gives the untraded asset a variance instead of zero", () => {
    const live = dailyReturns(21, 80);
    const other = dailyReturns(33, 80);
    const book = live.map((value, index) => [value, 0, other[index]]);
    const shrunk = shrinkCovariance({ returnsMatrix: book });
    expect(shrunk.covariance[1][1]).toBeGreaterThan(0);
    expect(cholesky(shrunk.covariance)).not.toBeNull();
  });
});

describe("paper portfolio: the same asset listed twice", () => {
  it("refuses a minimum-variance solve on exactly collinear columns", () => {
    const one = dailyReturns(11, 60);
    const book = one.map((value, index) => [value, value * 2, dailyReturns(99, 60)[index]]);
    expect(() => minVariancePortfolio(covarianceMatrix(book))).toThrow(/positive definite/u);
  });

  it("still equalises risk contributions through risk parity, which is a different question", () => {
    // Risk parity does not need the inverse of the covariance matrix to be unique — it needs the
    // risk contributions to be equal, and that can hold even when the assets are collinear. So the
    // two optimisers disagreeing here is correct behaviour, not an inconsistency to paper over:
    // one question has no unique answer, the other does.
    const one = dailyReturns(11, 60);
    const book = one.map((value, index) => [value, value * 2, dailyReturns(99, 60)[index]]);
    const cov = covarianceMatrix(book);
    const solution = riskParityPortfolio(cov);
    expect(solution.weights.every((value) => Number.isFinite(value))).toBe(true);
    expect(solution.weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);

    const decomposition = componentVar({ cov, weights: solution.weights });
    const shares = decomposition.componentShare;
    for (const share of shares) {
      expect(share).toBeCloseTo(1 / shares.length, 3);
    }
  });
});

describe("paper portfolio: correlations go to one in a selloff", () => {
  it("removes the diversification benefit as correlation rises, monotonically", () => {
    // Two assets with equal variance: as rho goes up, the minimum-variance portfolio's volatility
    // must rise towards the single-asset volatility. If it does not, the optimiser is finding
    // diversification that the correlation says is not there.
    const base = dailyReturns(41, 200);
    const noise = dailyReturns(42, 200);
    const volatilities: number[] = [];
    for (const mixture of [0, 0.5, 0.9, 1]) {
      const second = base.map((value, index) => mixture * value + (1 - mixture) * noise[index]);
      const book = base.map((value, index) => [value, second[index]]);
      const cov = covarianceMatrix(book);
      const solution = minVariancePortfolio(cov);
      volatilities.push(portfolioVolatility(cov, solution.weights));
    }
    for (let i = 1; i < volatilities.length; i += 1) {
      expect(volatilities[i]).toBeGreaterThanOrEqual(volatilities[i - 1] - 1e-12);
    }
    // Fully redundant assets: no diversification left at all.
    expect(volatilities[3]).toBeGreaterThan(volatilities[0]);
  });

  it("spreads risk evenly across a book, and the components add up to the whole", () => {
    const book = factorBook({ days: 300, assets: 8 });
    const cov = covarianceMatrix(book);
    const solution = riskParityPortfolio(cov);
    const decomposition = componentVar({ cov, weights: solution.weights });
    // Euler decomposition: the parts must sum to the whole.
    const total = decomposition.componentVar.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(decomposition.portfolioVar, 12);
    for (const share of decomposition.componentShare) {
      expect(share).toBeCloseTo(1 / 8, 3);
    }
  });

  it("reports component risk in VaR units, not variance units, which the field name does not say", () => {
    // `portfolioVar` is Value at Risk, not variance: at the default 95% level it is the volatility
    // scaled by 1.645, not its square. Comparing it against a variance is the natural mistake, so
    // the relationship is pinned here rather than left to be rediscovered.
    const book = factorBook({ days: 300, assets: 8 });
    const cov = covarianceMatrix(book);
    const solution = riskParityPortfolio(cov);
    const decomposition = componentVar({ cov, weights: solution.weights });
    expect(decomposition.portfolioVolatility).toBeCloseTo(
      portfolioVolatility(cov, solution.weights),
      12,
    );
    expect(decomposition.portfolioVar / decomposition.portfolioVolatility).toBeCloseTo(1.645, 2);
  });
});

describe("paper portfolio: the tangency portfolio wants more than the book has", () => {
  /** Six assets whose volatilities span 0.5% to 30%: the shape of a book mixing majors and alts. */
  function wideVolatilityBook(): { cov: number[][]; expectedReturns: number[] } {
    const days = 300;
    const volatilities = [0.005, 0.01, 0.02, 0.05, 0.1, 0.3];
    const factor = pseudoRandom(5001, days * 2);
    const market: number[] = [];
    for (let i = 0; i < days; i += 1) {
      const u1 = Math.max(factor[2 * i], 1e-12);
      market.push(0.02 * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * factor[2 * i + 1]));
    }
    const rows = Array.from({ length: days }, (_unused, day) =>
      volatilities.map((volatility, asset) => {
        const shock = pseudoRandom(7000 + asset * 17 + day * 29, 1)[0] - 0.5;
        return (0.4 + 0.1 * asset) * market[day] + shock * volatility;
      }),
    );
    return {
      cov: covarianceMatrix(rows),
      expectedReturns: volatilities.map((_value, index) => 0.0002 + 0.0001 * index),
    };
  }

  /**
   * Same book, but every asset is expected to return the same: the tangency question is then well
   * posed and the answer is still levered, which is the case where hidden leverage does damage.
   */
  function riskPremiumBook(): { cov: number[][]; expectedReturns: number[] } {
    const { cov } = wideVolatilityBook();
    return { cov, expectedReturns: [0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.0008] };
  }

  it("refuses an unbounded tangency portfolio instead of returning a sign-flipped one", () => {
    // With these expected returns the normalising scale is negative, so no finite maximiser exists.
    // Normalising anyway flips the whole vector and returns a portfolio whose Sharpe is negative
    // from a call named "maximum Sharpe", at nearly ten times gross exposure. That is worse than an
    // error because it looks like an answer.
    const { cov, expectedReturns } = wideVolatilityBook();
    expect(() => maxSharpePortfolio({ cov, expectedReturns })).toThrow(/unbounded/u);
  });

  it("solves the same book once bounds make the question well posed", () => {
    const { cov, expectedReturns } = wideVolatilityBook();
    const bounded = maxSharpePortfolio({ cov, expectedReturns, bounds: { lower: 0 } });
    expect(Number.isFinite(bounded.sharpe ?? Number.NaN)).toBe(true);
    expect(bounded.netExposure).toBeCloseTo(1, 8);
    expect(bounded.grossExposure).toBeCloseTo(1, 6);
  });

  it("says how much leverage it used, instead of leaving it to be read off the weights", () => {
    // A book where the tangency solution is well posed but still levered: the weights alone do not
    // announce the leverage, and 2.09 read as "allocate 209%" is the expensive misunderstanding.
    const { cov, expectedReturns } = riskPremiumBook();
    const solution = maxSharpePortfolio({ cov, expectedReturns });
    expect(solution.netExposure).toBeCloseTo(1, 8);
    expect(solution.grossExposure).toBeGreaterThan(1);
    expect(Math.max(...solution.weights.map(Math.abs))).toBeGreaterThan(1);
  });

  it("honours the bounds it was given, rather than reporting the unconstrained answer", () => {
    const { cov, expectedReturns } = wideVolatilityBook();
    const constrained = maxSharpePortfolio({
      cov,
      expectedReturns,
      bounds: { lower: 0, upper: 0.4 },
    });
    for (const weight of constrained.weights) {
      expect(weight).toBeGreaterThanOrEqual(-1e-9);
      expect(weight).toBeLessThanOrEqual(0.4 + 1e-9);
    }
    // A long-only book that is fully invested has no leverage left to hide.
    expect(constrained.grossExposure).toBeCloseTo(1, 6);
  });

  it("costs return for the constraint, which is the honest trade", () => {
    // Constraining cannot improve the objective: the whole point of reporting both is that the
    // caller can see what the constraint cost rather than being told it was free. Checked on a book
    // where the unconstrained question is well posed, so the comparison means something.
    const { cov, expectedReturns } = riskPremiumBook();
    const free = maxSharpePortfolio({ cov, expectedReturns });
    const constrained = maxSharpePortfolio({ cov, expectedReturns, bounds: { lower: 0 } });
    expect(constrained.sharpe ?? 0).toBeLessThanOrEqual((free.sharpe ?? 0) + 1e-12);
  });

  it("keeps a long-only minimum-variance book unlevered", () => {
    const { cov } = wideVolatilityBook();
    const solution = minVariancePortfolio(cov, { lower: 0, upper: 0.5 });
    expect(solution.grossExposure).toBeCloseTo(1, 6);
    expect(solution.weights.every((value) => value >= -1e-9)).toBe(true);
  });
});

describe("paper portfolio: fat tails and gaps", () => {
  function gaussian(seed: number, days: number, scale = 0.012): number[] {
    const uniforms = pseudoRandom(seed, days * 2);
    const out: number[] = [];
    for (let i = 0; i < days; i += 1) {
      const u1 = Math.max(uniforms[2 * i], 1e-12);
      out.push(scale * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * uniforms[2 * i + 1]));
    }
    return out;
  }

  /** Mostly small moves, occasional gap down: the shape crypto returns actually have. */
  function gappy(seed: number, days: number, drop = 0.15, probability = 0.03): number[] {
    const base = gaussian(seed, days, 0.01);
    const triggers = pseudoRandom(seed + 999, days);
    return base.map((value, index) => (triggers[index] < probability ? value - drop : value));
  }

  it("raises VaR above the Gaussian figure when the tail is fat, which is the point of the correction", () => {
    const result = cornishFisherVar({ returns: gappy(31, 800) });
    expect(result.skewness).toBeLessThan(-1);
    expect(result.excessKurtosis).toBeGreaterThan(3);
    expect(result.varCornishFisher).toBeGreaterThan(result.varGaussian);
    expect(result.correction).toBeGreaterThan(0);
  });

  it("agrees with the Gaussian figure when the data really is Gaussian", () => {
    // A correction that fires on normal data would be inventing risk that is not there.
    const result = cornishFisherVar({ returns: gaussian(31, 800) });
    expect(Math.abs(result.correction)).toBeLessThan(0.2 * Math.abs(result.varGaussian));
  });

  it("refuses the expansion instead of returning a negative VaR", () => {
    // At skew -11.6 and excess kurtosis 151 the adjusted quantile crosses zero and the figure
    // comes out negative, which reads as "no risk". That is worse than an error, so it is an error.
    expect(() => cornishFisherVar({ returns: gappy(51, 800, 0.4, 0.01) })).toThrow(
      /not valid at this skewness/u,
    );
  });

  it("detects the non-normality it is correcting for, and the Gaussian book it is not", () => {
    expect(jarqueBera(gappy(41, 800)).rejectNormalityAt5Pct).toBe(true);
    expect(jarqueBera(gaussian(41, 800)).rejectNormalityAt5Pct).toBe(false);
  });
});

describe("paper portfolio: volatility comes in regimes", () => {
  it("tracks the current regime instead of averaging over the calm period", () => {
    // A hundred calm days then a hundred violent ones. The equal-weighted estimate still carries the
    // calm half at full weight; EWMA is supposed to have mostly forgotten it.
    const calm = gaussianSeries(11, 100, 0.005);
    const crisis = gaussianSeries(22, 100, 0.03);
    const rows = [...calm, ...crisis].map((value) => [value]);
    const ewma = ewmaCovariance({ returnsMatrix: rows });
    const crisisVolatility = Math.sqrt(covarianceMatrix(crisis.map((value) => [value]))[0][0]);
    const calmVolatility = Math.sqrt(covarianceMatrix(calm.map((value) => [value]))[0][0]);
    const tracked = Math.sqrt(ewma.covariance[0][0]);
    expect(tracked).toBeGreaterThan(calmVolatility * 3);
    // Within 10% of the crisis-period volatility, not merely higher than the calm one.
    expect(Math.abs(tracked - crisisVolatility) / crisisVolatility).toBeLessThan(0.1);
  });

  it("separates a stablecoin from a large-cap on five observations", () => {
    // The seeded-recursion bug: starting from a constant variance meant a short quiet history was
    // still reporting the seed, so a stablecoin and a large-cap came out nearly identical. Both
    // estimates must now scale with the data, which they do by construction once the seed is gone.
    const quiet = ewmaCovariance({
      returnsMatrix: gaussianSeries(33, 5, 0.0001).map((value) => [value]),
    });
    const loud = ewmaCovariance({
      returnsMatrix: gaussianSeries(33, 5, 0.01).map((value) => [value]),
    });
    // True variances differ by 10,000x; the estimates must differ by orders of magnitude too.
    expect(loud.covariance[0][0] / quiet.covariance[0][0]).toBeGreaterThan(1000);
  });

  it("stays finite with lambda = 1, which degenerates to an equal weighting", () => {
    const result = ewmaCovariance({
      returnsMatrix: gaussianSeries(44, 60, 0.02).map((value) => [value]),
      lambda: 1,
    });
    expect(Number.isFinite(result.covariance[0][0])).toBe(true);
    expect(result.covariance[0][0]).toBeGreaterThan(0);
  });
});

describe("paper portfolio: serial correlation changes what is significant", () => {
  function ar1(seed: number, days: number, phi: number): number[] {
    const shocks = gaussianSeries(seed, days, 0.01);
    const out: number[] = [];
    let previous = 0;
    for (const shock of shocks) {
      previous = phi * previous + shock;
      out.push(previous);
    }
    return out;
  }

  it("widens the standard error when the series is positively autocorrelated", () => {
    // Overlapping windows and smoothed marks produce exactly this shape, and a naive standard error
    // on it reports significance that is not there. HAC is supposed to take the finding away.
    const result = neweyWestMean({ values: ar1(44, 300, 0.7), lags: 4 });
    expect(result.standardError).toBeGreaterThan(result.naiveStandardError * 1.2);
  });

  it("narrows it under negative autocorrelation instead of always widening", () => {
    // Mean-reverting series give a more precise mean than iid data, so a HAC estimator that only
    // ever inflated would be wrong in the other direction.
    const result = neweyWestMean({ values: ar1(66, 300, -0.5), lags: 4 });
    expect(result.standardError).toBeLessThan(result.naiveStandardError);
  });

  it("collapses to the naive error at zero lags, which is the estimator's own identity", () => {
    const result = neweyWestMean({ values: gaussianSeries(55, 300, 0.01), lags: 0 });
    expect(result.standardError).toBeCloseTo(result.naiveStandardError, 12);
  });

  it("leaves a white-noise series alone rather than inventing autocorrelation", () => {
    const result = neweyWestMean({ values: gaussianSeries(55, 300, 0.01), lags: 4 });
    expect(result.standardError / result.naiveStandardError).toBeCloseTo(1, 1);
  });

  it("refuses a wider bandwidth than the sample can support", () => {
    // Past n - 1 there are no autocovariances left to weight, so a bigger bandwidth does not add
    // correction, it reweights noise — and with the clamp that keeps the variance non-negative the
    // standard error shrinks towards zero, which inflates the t statistic. Staying finite is not
    // the same as staying meaningful, so this is refused rather than answered.
    expect(() => neweyWestMean({ values: gaussianSeries(55, 60, 0.01), lags: 500 })).toThrow(
      /lags must be between 0 and 59/u,
    );
    expect(() => neweyWestMean({ values: gaussianSeries(55, 60, 0.01), lags: -1 })).toThrow(
      /lags must be between 0/u,
    );
    // The widest bandwidth the sample does support still has to work.
    const widest = neweyWestMean({ values: gaussianSeries(55, 60, 0.01), lags: 59 });
    expect(Number.isFinite(widest.standardError)).toBe(true);
    expect(widest.standardError).toBeGreaterThanOrEqual(0);
  });

  it("flags positive autocorrelation and stays near 2 on white noise", () => {
    expect(durbinWatson(ar1(44, 300, 0.7))).toBeLessThan(1);
    expect(durbinWatson(gaussianSeries(55, 300, 0.01))).toBeGreaterThan(1.8);
  });
});

describe("paper portfolio: stress scenarios", () => {
  it("signs the P&L correctly, including for a short position", () => {
    const result = stressTest({
      weights: [0.6, -0.2, 0.6],
      scenarios: [
        { name: "risk off", shocks: [-0.1, -0.1, -0.1] },
        { name: "alt season", shocks: [-0.05, 0.2, 0.3] },
      ],
    });
    const riskOff = result.find((entry) => entry.name === "risk off");
    // Long 1.2, short 0.2, everything down 10%: the short leg earns, the rest does not.
    expect(riskOff?.pnl).toBeCloseTo(0.6 * -0.1 + -0.2 * -0.1 + 0.6 * -0.1, 12);
  });

  it("refuses a scenario whose shocks do not match the book", () => {
    // Silently padding a short shock vector with zeros would understate the loss, which is the one
    // failure mode a stress test cannot have.
    expect(() =>
      stressTest({ weights: [0.5, 0.5], scenarios: [{ name: "partial", shocks: [0.1] }] }),
    ).toThrow(/lengths disagree/u);
  });
});

describe("paper portfolio: dirty data must not travel silently", () => {
  /**
   * A NaN in a return series is a missing candle, a failed fetch, or a divide-by-zero upstream.
   * Every one of these used to flow through the arithmetic and come out as a NaN answer, which a
   * caller has no way to distinguish from a real number. Refusing at the boundary is the only
   * useful behaviour: the caller then knows to fix the data.
   */
  const nonFinite = (name: string, run: () => unknown) => {
    it(`refuses ${name} rather than returning NaN`, () => {
      expect(run).toThrow(/non-finite/u);
    });
  };

  nonFinite("a NaN in the returns matrix", () =>
    covarianceMatrix([
      [0.01, NaN],
      [0.02, 0.01],
    ]),
  );
  nonFinite("an Infinity in the returns matrix", () =>
    covarianceMatrix([
      [0.01, Infinity],
      [0.02, 0.01],
    ]),
  );
  nonFinite("a NaN reaching the correlation matrix", () =>
    correlationMatrix([
      [0.01, NaN],
      [0.02, 0.01],
    ]),
  );
  nonFinite("a NaN in a unit-root test", () =>
    adfTest({ values: [1, 2, 3, NaN, 5, 6, 7, 8, 9, 10] }),
  );
  nonFinite("a NaN weight in VaR decomposition", () =>
    componentVar({
      cov: [
        [0.01, 0.002],
        [0.002, 0.04],
      ],
      weights: [NaN, 0.5],
    }),
  );
  nonFinite("a NaN weight in a stress test", () =>
    stressTest({ weights: [0.5, NaN], scenarios: [{ name: "risk off", shocks: [-0.1, -0.1] }] }),
  );
  nonFinite("a NaN shock inside a stress scenario", () =>
    stressTest({ weights: [0.5, 0.5], scenarios: [{ name: "risk off", shocks: [-0.1, NaN] }] }),
  );
  nonFinite("a NaN in the EWMA returns matrix", () =>
    ewmaCovariance({
      returnsMatrix: [
        [0.01, NaN],
        [0.02, 0.01],
      ],
    }),
  );
  nonFinite("a NaN sector weight in attribution", () =>
    brinsonAttribution({
      sectors: ["majors", "alts"],
      portfolioWeights: [0.5, NaN],
      portfolioReturns: [0.1, 0.2],
      benchmarkWeights: [0.5, 0.5],
      benchmarkReturns: [0.08, 0.15],
    }),
  );
  nonFinite("a NaN market weight in Black-Litterman", () =>
    blackLitterman({
      cov: [
        [0.01, 0.002],
        [0.002, 0.04],
      ],
      marketWeights: [0.5, NaN],
      P: [[1, 0]],
      Q: [0.1],
    }),
  );
  nonFinite("a NaN view return in Black-Litterman", () =>
    blackLitterman({
      cov: [
        [0.01, 0.002],
        [0.002, 0.04],
      ],
      marketWeights: [0.5, 0.5],
      P: [[1, 0]],
      Q: [NaN],
    }),
  );
  nonFinite("a NaN current weight in turnover", () =>
    turnoverAndCost({ currentWeights: [0.5, NaN], targetWeights: [0.4, 0.6] }),
  );

  it("still solves the clean book, because a guard that over-rejects is its own bug", () => {
    const clean = [
      [0.01, 0.02],
      [0.02, -0.01],
      [0.005, 0.03],
      [-0.01, 0.01],
    ];
    const cov = covarianceMatrix(clean);
    expect(cov.every((row) => row.every(Number.isFinite))).toBe(true);
    expect(Number.isFinite(componentVar({ cov, weights: [0.5, 0.5] }).portfolioVar)).toBe(true);
    expect(
      Number.isFinite(
        turnoverAndCost({ currentWeights: [0.5, 0.5], targetWeights: [0.4, 0.6] }).turnover,
      ),
    ).toBe(true);
  });
});

describe("paper portfolio: two tickers, one asset", () => {
  /** `rho` of 1 is the same asset listed twice; anything near it is a wrapper or a pegged twin. */
  function nearCollinearBook(rho: number): number[][] {
    const days = 250;
    const factor = gaussianSeries(101, days, 0.02);
    const idiosyncratic = gaussianSeries(202, days, 0.02);
    const noise = Math.sqrt(1 - rho * rho);
    return Array.from({ length: days }, (_unused, day) => [
      factor[day],
      rho * factor[day] + noise * idiosyncratic[day],
    ]);
  }

  it("says when a book is nearly collinear, not only when it is exactly singular", () => {
    // stETH against wstETH, USDC against USDT: two tickers for one asset. The covariance is still
    // positive definite, so it solves with no error at all and returns a sixteen-times levered
    // long/short pair that exists because the optimiser found the estimation noise and traded it.
    const solution = minVariancePortfolio(covarianceMatrix(nearCollinearBook(0.999999)));
    expect(solution.illConditioned).toBe(true);
    // grossExposure already showed the leverage; the new field is what says it is spurious.
    expect(solution.grossExposure).toBeGreaterThan(10);
  });

  it("stays quiet on a book whose assets genuinely differ", () => {
    // A flag that fires on ordinary correlation would train everyone to ignore it.
    const solution = minVariancePortfolio(covarianceMatrix(nearCollinearBook(0.9)));
    expect(solution.illConditioned).toBe(false);
    expect(solution.grossExposure).toBeCloseTo(1, 4);
  });

  it("reports one for the identity, which is the estimator's own check", () => {
    const conditioning = covarianceConditioning([
      [1, 0],
      [0, 1],
    ]);
    expect(conditioning.conditionNumber).toBeCloseTo(1, 12);
    expect(conditioning.illConditioned).toBe(false);
  });

  it("reports a singular book as ill-conditioned rather than refusing to look at it", () => {
    // Exactly collinear is the limit of nearly collinear, and risk parity is still well defined on
    // it: equal contributions do not need a unique solution. Diagnosing the matrix must not turn a
    // call that used to work into one that throws.
    const parity = riskParityPortfolio(covarianceMatrix(nearCollinearBook(1)));
    expect(parity.illConditioned).toBe(true);
    expect(Number.isFinite(parity.volatility)).toBe(true);
  });

  it("points at a remedy that actually works", () => {
    // The flag is only worth reporting if the next call it implies fixes the problem: shrinking
    // towards the identity leaves the real variance alone and removes the near-dependency.
    const rows = nearCollinearBook(0.999999);
    const before = minVariancePortfolio(covarianceMatrix(rows));
    const after = minVariancePortfolio(shrinkCovariance({ returnsMatrix: rows }).covariance);
    expect(before.illConditioned).toBe(true);
    expect(after.illConditioned).toBe(false);
    expect(after.grossExposure).toBeCloseTo(1, 6);
  });
});

describe("paper portfolio: autocorrelation on a series with holes in it", () => {
  function ar1(seed: number, days: number, phi: number): number[] {
    const shocks = gaussianSeries(seed, days, 0.01);
    const out: number[] = [];
    let previous = 0;
    for (const shock of shocks) {
      previous = phi * previous + shock;
      out.push(previous);
    }
    return out;
  }

  it("refuses a missing candle instead of quietly closing the gap", () => {
    // Dropping a NaN does not merely lose an observation: it makes the day after the hole adjacent
    // to the day before it, so lag 1 starts measuring a two-day relationship. The returned n drops
    // to 199 and nothing says the series was re-paired — a plausible-looking number built on a
    // broken timeline.
    const series = gaussianSeries(77, 200, 0.01);
    const holed = series.slice();
    holed[100] = NaN;
    expect(() => autocorrelationFunction({ values: holed, maxLag: 3 })).toThrow(/non-finite/u);
    expect(() => partialAutocorrelationFunction({ values: holed, maxLag: 3 })).toThrow(
      /non-finite/u,
    );
    // The clean series is still fine, so the guard is about the hole and not about the length.
    expect(autocorrelationFunction({ values: series, maxLag: 3 }).n).toBe(200);
  });

  it("uses the 1.96 over root-n band, which is the claim its significance flags make", () => {
    const result = autocorrelationFunction({ values: gaussianSeries(55, 200, 0.01), maxLag: 2 });
    expect(result.significanceBand).toBeCloseTo(1.96 / Math.sqrt(200), 12);
    // A white-noise series should mostly not trip it; a flag that always fires is no flag at all.
    expect(result.significant.every((value) => !value)).toBe(true);
  });

  it("decays geometrically for AR(1) in the ACF and cuts off after lag 1 in the PACF", () => {
    // This pair of signatures is how you tell an AR(1) from anything else, and both halves have to
    // be right: an ACF that failed to decay, or a PACF that did not cut off, would point at the
    // wrong model.
    const series = ar1(44, 500, 0.7);
    const acf = autocorrelationFunction({ values: series, maxLag: 4 });
    const pacf = partialAutocorrelationFunction({ values: series, maxLag: 4 });
    expect(acf.lags[0]).toBeCloseTo(0.7, 1);
    expect(acf.lags[1]).toBeCloseTo(0.7 ** 2, 1);
    expect(acf.lags[0]).toBeGreaterThan(acf.lags[1]);
    expect(acf.lags[1]).toBeGreaterThan(acf.lags[2]);
    expect(pacf.lags[0]).toBeCloseTo(0.7, 1);
    expect(Math.abs(pacf.lags[1])).toBeLessThan(0.1);
    expect(Math.abs(pacf.lags[2])).toBeLessThan(0.1);
  });

  it("clamps a max lag longer than the series rather than returning empty lags", () => {
    const result = autocorrelationFunction({ values: gaussianSeries(88, 20, 0.01), maxLag: 50 });
    expect(result.maxLag).toBeLessThan(20);
    expect(result.lags.length).toBe(result.maxLag);
    expect(result.lags.every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe("paper portfolio: books nobody will actually hold", () => {
  /**
   * A one-asset book, an empty scenario list, an all-cash position: all of them are things a caller
   * can legitimately ask for, and most of them have no interesting answer. What matters is that the
   * toolkit either answers them or says it cannot, and never returns a NaN that reads as a number.
   */
  it("solves a one-asset book instead of dividing by a portfolio of nothing", () => {
    const cov = [[0.0004]];
    for (const solution of [
      minVariancePortfolio(cov),
      riskParityPortfolio(cov),
      maxDiversificationPortfolio(cov),
      maxSharpePortfolio({ cov, expectedReturns: [0.001] }),
    ]) {
      expect(solution.weights).toEqual([1]);
      expect(solution.grossExposure).toBe(1);
      // A 1x1 matrix is perfectly conditioned by definition, so this must not be flagged.
      expect(solution.illConditioned).toBe(false);
    }
  });

  it("refuses a covariance matrix with no variance in it", () => {
    // All zeros is singular, and solving it would mean pretending the book has no risk at all.
    expect(() =>
      minVariancePortfolio([
        [0, 0],
        [0, 0],
      ]),
    ).toThrow(/positive definite/u);
  });

  it("returns zeros rather than NaNs for an all-cash position", () => {
    const decomposed = componentVar({
      cov: [
        [0.0004, 0.0001],
        [0.0001, 0.0004],
      ],
      weights: [0, 0],
    });
    expect(decomposed.portfolioVolatility).toBe(0);
    expect(decomposed.componentVar.every((value) => value === 0)).toBe(true);
  });

  it("has no scenarios to report when given none", () => {
    expect(stressTest({ weights: [0.5, 0.5], scenarios: [] })).toEqual([]);
  });

  it("rejects a view that does not have an entry per asset", () => {
    // Padding it silently would mean the view was applied to the wrong asset.
    expect(() =>
      blackLitterman({
        cov: [
          [0.0004, 0.0001],
          [0.0001, 0.0004],
        ],
        marketWeights: [0.5, 0.5],
        P: [[1, 0, 0]],
        Q: [0.1],
      }),
    ).toThrow(/one entry per asset/u);
  });
});
