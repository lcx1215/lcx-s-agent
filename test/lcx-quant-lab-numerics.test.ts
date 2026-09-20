/**
 * Numerics: what the toolkit does when the arithmetic itself is the hard part.
 *
 * Three questions the shape-driven tests do not ask. Can it refuse a quantity that does not exist,
 * rather than returning a number for it. Does it stay accurate when one asset is a stablecoin and
 * another moves half its value a day — nine orders of magnitude of variance in one matrix. And does
 * the same input give the same answer twice, which is what makes a reported figure checkable at all.
 */

import { describe, expect, it } from "vitest";
import {
  cholesky,
  covarianceConditioning,
  durbinWatson,
  ewmaCovariance,
  minVariancePortfolio,
  neweyWestMean,
  solveSpd,
} from "../src/agents/quant-math-advanced.js";
import { covarianceMatrix, fDistributionUpperTailP } from "../src/agents/quant-math-foundations.js";
import {
  correlationTest,
  incompleteBeta,
  regressionDiagnostics,
  studentTCritical,
  studentTTwoTailedP,
} from "../src/agents/quant-math-inference.js";

function gaussian(seed: number, length: number, scale = 0.012): number[] {
  const raw: number[] = [];
  let state = seed;
  for (let i = 0; i < length * 2; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    raw.push(state / 2147483648);
  }
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const u1 = Math.max(raw[2 * i], 1e-12);
    out.push(scale * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * raw[2 * i + 1]));
  }
  return out;
}

describe("numerics: refusing a quantity that does not exist", () => {
  it("refuses to correlate a constant series instead of reporting a measured zero", () => {
    // A pegged stablecoin that never moved: every correlation with it is 0/0. Kendall's tau-b used
    // to put a NaN in the payload while Pearson reported 0 with a confidence interval — a number
    // where there is no number, sitting next to one that looks measured.
    const moving = gaussian(22, 50, 0.01);
    expect(() =>
      correlationTest(
        Array.from({ length: 50 }, () => 1),
        moving,
      ),
    ).toThrow(/no correlation to measure/u);
    expect(() =>
      correlationTest(
        moving,
        Array.from({ length: 50 }, () => 1),
      ),
    ).toThrow(/no correlation to measure/u);
  });

  it("refuses a regression on non-finite inputs rather than fitting through them", () => {
    expect(() => regressionDiagnostics([1, 2, 3, 4, 5], [1, 2, NaN, 4, 5])).toThrow(/non-finite/u);
    expect(() => regressionDiagnostics([1, 2, Infinity, 4, 5], [1, 2, 3, 4, 5])).toThrow(
      /non-finite/u,
    );
  });

  it("refuses a p-value it cannot compute rather than asserting no effect", () => {
    // Returning 1 here read as "withholding a claim", but p = 1 is the strongest available claim in
    // the other direction: certainly no effect. With no degrees of freedom there is no p-value.
    expect(() => studentTTwoTailedP(1, 0)).toThrow(/no p-value/u);
    expect(() => studentTTwoTailedP(1, -3)).toThrow(/no p-value/u);
    expect(() => studentTTwoTailedP(NaN, 10)).toThrow(/no p-value/u);
  });

  it("still answers where there is something to answer", () => {
    const a = gaussian(11, 100, 0.02);
    const b = gaussian(22, 100, 0.015);
    expect(Number.isFinite(correlationTest(a, b).pearson)).toBe(true);
    expect(studentTTwoTailedP(2.228, 10)).toBeCloseTo(0.05, 3);
    expect(studentTTwoTailedP(0, 10)).toBeCloseTo(1, 12);
    // Symmetry, and the t distribution closing on the normal as the sample grows.
    expect(studentTTwoTailedP(-2.228, 10)).toBeCloseTo(studentTTwoTailedP(2.228, 10), 12);
    expect(studentTCritical(0.975, 1)).toBeCloseTo(12.706, 2);
    expect(studentTCritical(0.975, 1_000_000)).toBeCloseTo(1.96, 2);
  });

  it("keeps the incomplete beta function's own identities", () => {
    // The Student-t p-values above are built on this, so its identities are theirs.
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(incompleteBeta(1, 1, x)).toBeCloseTo(x, 12);
    }
    expect(incompleteBeta(2, 3, 0)).toBeCloseTo(0, 12);
    expect(incompleteBeta(2, 3, 1)).toBeCloseTo(1, 12);
    expect(incompleteBeta(2, 3, 0.4) + incompleteBeta(3, 2, 0.6)).toBeCloseTo(1, 12);
  });
});

describe("numerics: a stablecoin and a shitcoin in one matrix", () => {
  /** Volatilities of 1e-5 and 0.5: variances nine orders of magnitude apart. */
  function extremeBook(): { rows: number[][]; cov: number[][] } {
    const days = 400;
    const volatilities = [1e-5, 0.5];
    const rows = Array.from({ length: days }, (_unused, day) =>
      volatilities.map(
        (volatility, asset) => gaussian(300 + asset * 13 + day * 7, 1, 1)[0] * volatility,
      ),
    );
    return { rows, cov: covarianceMatrix(rows) };
  }

  it("factors, solves, and says the matrix is exactly as badly conditioned as it is", () => {
    const { cov } = extremeBook();
    const lower = cholesky(cov);
    expect(lower).not.toBeNull();
    const conditioning = covarianceConditioning(cov);
    // Nine orders of magnitude between the two variances: this is genuinely ill-conditioned, and a
    // diagnostic that stayed quiet on it would not be a diagnostic.
    expect(conditioning.illConditioned).toBe(true);
    expect(conditioning.conditionNumber).toBeGreaterThan(1e6);
  });

  it("gets the portfolio volatility right without losing the small asset", () => {
    const { cov } = extremeBook();
    const solution = minVariancePortfolio(cov);
    // Checked against the naive expansion rather than against the same code path: the minimum
    // variance answer here is dominated by the stablecoin, and a solver that simply dropped the
    // tiny column would still look plausible.
    const [w1, w2] = solution.weights;
    const naive = w1 * w1 * cov[0][0] + 2 * w1 * w2 * cov[0][1] + w2 * w2 * cov[1][1];
    expect(Math.sqrt(naive)).toBeCloseTo(solution.volatility, 15);
    // The book is essentially all stablecoin, so its risk is the stablecoin's risk. A solver that
    // quietly dropped the tiny column would report something far larger.
    expect(solution.volatility / 1e-5).toBeCloseTo(1, 2);
  });

  it("keeps the risk decomposition exact even at this scale", () => {
    const { cov } = extremeBook();
    const solution = minVariancePortfolio(cov);
    const summed = solution.riskContributions.reduce((sum, value) => sum + value, 0);
    expect(Math.abs(summed - solution.volatility) / solution.volatility).toBeLessThan(1e-12);
  });
});

describe("numerics: the same input gives the same answer", () => {
  it("is bit-for-bit reproducible, because a figure that cannot be reproduced cannot be checked", () => {
    const { cov } = (() => {
      const rows = Array.from({ length: 200 }, (_unused, day) => [
        gaussian(11, 200, 0.02)[day],
        gaussian(22, 200, 0.015)[day],
      ]);
      return { cov: covarianceMatrix(rows) };
    })();
    const a = gaussian(11, 100, 0.02);
    const b = gaussian(22, 100, 0.015);
    const cases: Array<[string, () => unknown]> = [
      [
        "covarianceMatrix",
        () =>
          covarianceMatrix([
            [0.01, 0.02],
            [0.02, -0.01],
            [0.005, 0.03],
          ]),
      ],
      ["minVariancePortfolio", () => minVariancePortfolio(cov)],
      ["covarianceConditioning", () => covarianceConditioning(cov)],
      ["correlationTest", () => correlationTest(a, b)],
      ["regressionDiagnostics", () => regressionDiagnostics(a, b)],
    ];
    for (const [label, run] of cases) {
      expect(JSON.stringify(run()), `${label} is not reproducible`).toBe(JSON.stringify(run()));
    }
  });
});

describe("numerics: an answer of 1 is still an answer", () => {
  /**
   * A tail probability of 1 means "the data are entirely consistent with no effect". It is a real
   * claim, and several functions were returning it for a different reason: the statistic was never
   * computable in the first place. The two have to be told apart, because the second one reads as
   * the strongest possible evidence for the opposite of what was asked.
   */
  it("distinguishes a statistic below the tail from a statistic that does not exist", () => {
    // A non-positive F really does have an upper-tail probability of 1: nothing falls below it.
    expect(fDistributionUpperTailP(0, 3, 20)).toBe(1);
    expect(fDistributionUpperTailP(-2, 3, 20)).toBe(1);
    // An uncomputable statistic, or a test with no degrees of freedom, has no probability at all.
    expect(() => fDistributionUpperTailP(Number.NaN, 3, 20)).toThrow(/no F tail probability/u);
    expect(() => fDistributionUpperTailP(2, 0, 20)).toThrow(/degrees of freedom/u);
    expect(() => fDistributionUpperTailP(2, 3, -1)).toThrow(/degrees of freedom/u);
    // The valid part still behaves: more evidence against the null is a smaller tail.
    expect(fDistributionUpperTailP(1, 3, 20)).toBeGreaterThan(fDistributionUpperTailP(10, 3, 20));
  });

  it("refuses a decay factor that makes older observations weigh more", () => {
    const returnsMatrix = Array.from({ length: 120 }, (_, row) => [
      gaussian(11 + row, 1, 0.02)[0],
      gaussian(200 + row, 1, 0.015)[0],
    ]);
    // lambda is the weight on the previous estimate, so 1 - lambda is the weight on the newest
    // observation: above 1 that flips negative and the bias correction changes sign, yet the
    // recursion still returns a plausible-looking matrix.
    expect(() => ewmaCovariance({ returnsMatrix, lambda: 1.5 })).toThrow(/lambda must be in/u);
    expect(() => ewmaCovariance({ returnsMatrix, lambda: 0 })).toThrow(/lambda must be in/u);
    expect(() => ewmaCovariance({ returnsMatrix, lambda: Number.NaN })).toThrow(
      /lambda must be in/u,
    );
    // Both ends of the legal range are real settings: 0.94 is the RiskMetrics choice and 1
    // degenerates to equal weighting, which the function handles explicitly.
    expect(ewmaCovariance({ returnsMatrix, lambda: 0.94 }).lambda).toBe(0.94);
    expect(ewmaCovariance({ returnsMatrix, lambda: 1 }).lambda).toBe(1);
  });

  it("checks the right-hand side of a solve, not only the matrix", () => {
    const cov = [
      [0.0004, 0.0001],
      [0.0001, 0.0004],
    ];
    // The matrix is validated for positive definiteness, but a NaN in the target vector sailed
    // through the substitution and came out as a NaN solution.
    expect(() => solveSpd(cov, [Number.NaN, 1])).toThrow(/b contains a non-finite/u);
    expect(() => solveSpd(cov, [1, Number.POSITIVE_INFINITY])).toThrow(/b contains a non-finite/u);
    expect(solveSpd(cov, [1, 1]).every((value) => Number.isFinite(value))).toBe(true);
  });

  it("does not let a missing observation reach a serial-correlation statistic", () => {
    const series = gaussian(55, 120, 0.01);
    const holed = series.slice();
    holed[40] = Number.NaN;
    // The Durbin-Watson statistic is a sum of squared successive differences, so one missing
    // residual turns the whole thing into a NaN that reads as a number.
    expect(() => durbinWatson(holed)).toThrow(/residuals contains a non-finite/u);
    // And the same hole in a Newey-West mean poisons the mean, the error and the t statistic.
    expect(() => neweyWestMean({ values: holed })).toThrow(/values contains a non-finite/u);
    expect(Number.isFinite(neweyWestMean({ values: series }).tStatistic)).toBe(true);
  });
});
