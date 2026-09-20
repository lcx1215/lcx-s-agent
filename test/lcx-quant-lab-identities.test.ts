/**
 * Identities: the equalities that hold no matter what the data looks like.
 *
 * The shape-driven tests ask "does this survive crypto data". These ask a harder question: does the
 * arithmetic still add up. An attribution that does not decompose into its own three effects, or a
 * risk decomposition whose parts do not sum to the whole, will happily return numbers — they just
 * will not be the numbers they claim to be.
 *
 * Nothing here is tuned to a fixture. Each assertion is an identity the function promises by its
 * own definition, so any of them failing means the definition was broken.
 */

import { describe, expect, it } from "vitest";
import {
  blackLitterman,
  brinsonAttribution,
  componentVar,
  maxDiversificationPortfolio,
  minVariancePortfolio,
  riskParityPortfolio,
  turnoverAndCost,
} from "../src/agents/quant-math-advanced.js";
import {
  correlationMatrix,
  covarianceMatrix,
  shrinkCovariance,
} from "../src/agents/quant-math-foundations.js";

/** Three uncorrelated-ish assets: enough structure to be interesting, not enough to be special. */
function book(): { rows: number[][]; cov: number[][] } {
  const days = 300;
  const uniforms = (seed: number) => {
    const values: number[] = [];
    let state = seed;
    for (let i = 0; i < days * 2; i += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      values.push(state / 2147483648);
    }
    return values;
  };
  const series = (seed: number, scale: number): number[] => {
    const raw = uniforms(seed);
    const out: number[] = [];
    for (let i = 0; i < days; i += 1) {
      const u1 = Math.max(raw[2 * i], 1e-12);
      out.push(scale * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * raw[2 * i + 1]));
    }
    return out;
  };
  const columns = [series(11, 0.02), series(22, 0.015), series(33, 0.03)];
  const rows = Array.from({ length: days }, (_unused, day) => columns.map((column) => column[day]));
  return { rows, cov: covarianceMatrix(rows) };
}

describe("identities: attribution decomposes into its own parts", () => {
  const attribution = brinsonAttribution({
    sectors: ["majors", "alts", "defi"],
    portfolioWeights: [0.5, 0.3, 0.2],
    portfolioReturns: [0.1, 0.2, -0.05],
    benchmarkWeights: [0.6, 0.25, 0.15],
    benchmarkReturns: [0.08, 0.15, 0.02],
  });

  it("splits the active return exactly into allocation, selection and interaction", () => {
    // This is what the word "attribution" means. If the three effects do not sum to the active
    // return, the caller is being shown a decomposition of something else.
    const summed = attribution.allocation + attribution.selection + attribution.interaction;
    expect(summed).toBeCloseTo(attribution.activeReturn, 12);
  });

  it("adds up per sector to the same totals it reports", () => {
    const total = (pick: (entry: (typeof attribution.bySector)[number]) => number) =>
      attribution.bySector.reduce((sum, entry) => sum + pick(entry), 0);
    expect(total((entry) => entry.allocation)).toBeCloseTo(attribution.allocation, 12);
    expect(total((entry) => entry.selection)).toBeCloseTo(attribution.selection, 12);
    expect(total((entry) => entry.interaction)).toBeCloseTo(attribution.interaction, 12);
  });
});

describe("identities: risk decomposes into contributions", () => {
  it("sums the risk contributions to the portfolio volatility", () => {
    // Euler decomposition for a homogeneous risk measure: the parts must add to the whole, and if
    // they do not then every per-asset number beneath them is off by the same factor.
    const { cov } = book();
    for (const solution of [minVariancePortfolio(cov), riskParityPortfolio(cov)]) {
      const summed = solution.riskContributions.reduce((sum, value) => sum + value, 0);
      expect(summed).toBeCloseTo(solution.volatility, 12);
    }
  });

  it("splits VaR into components that sum to the whole and shares that sum to one", () => {
    const { cov } = book();
    const decomposed = componentVar({ cov, weights: [0.5, 0.3, 0.2] });
    const summed = decomposed.componentVar.reduce((sum, value) => sum + value, 0);
    expect(summed).toBeCloseTo(decomposed.portfolioVar, 12);
    expect(decomposed.componentShare.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });

  it("leaves every component share signed the way its contribution is", () => {
    // A negative-risk asset — one that hedges the book — has to show up as a negative share, not
    // as a positive one that merely looks small.
    // A small long in a strongly negatively correlated asset: its marginal contribution is
    // negative, so it subtracts from the book's risk rather than adding to it.
    const decomposed = componentVar({
      cov: [
        [0.0004, -0.0002],
        [-0.0002, 0.0004],
      ],
      weights: [1, 0.05],
    });
    expect(decomposed.componentShare.some((share) => share < 0)).toBe(true);
    expect(decomposed.componentShare.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });
});

describe("identities: trading costs are symmetric", () => {
  it("costs the same to get there as to get back", () => {
    const out = turnoverAndCost({
      currentWeights: [0.5, 0.3, 0.2],
      targetWeights: [0.2, 0.3, 0.5],
    });
    const back = turnoverAndCost({
      currentWeights: [0.2, 0.3, 0.5],
      targetWeights: [0.5, 0.3, 0.2],
    });
    expect(out.turnover).toBeCloseTo(back.turnover, 12);
    expect(out.cost).toBeCloseTo(back.cost, 12);
  });

  it("charges nothing for holding still", () => {
    const still = turnoverAndCost({
      currentWeights: [0.5, 0.3, 0.2],
      targetWeights: [0.5, 0.3, 0.2],
    });
    expect(still.turnover).toBe(0);
    expect(still.cost).toBe(0);
  });
});

describe("identities: a correlation matrix is a correlation matrix", () => {
  it("has ones on the diagonal, is symmetric, and stays within plus or minus one", () => {
    const { rows } = book();
    const matrix = correlationMatrix(rows);
    for (let i = 0; i < matrix.length; i += 1) {
      expect(matrix[i][i]).toBeCloseTo(1, 12);
      for (let j = 0; j < matrix.length; j += 1) {
        expect(matrix[i][j]).toBeCloseTo(matrix[j][i], 12);
        expect(Math.abs(matrix[i][j])).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });
});

describe("identities: shrinkage stays a convex combination", () => {
  it("keeps its intensity between nothing and everything", () => {
    // Outside [0, 1] it is no longer shrinking towards the target, it is extrapolating away from
    // the sample, and the resulting matrix has no guarantee of staying positive definite.
    const { rows } = book();
    const shrunk = shrinkCovariance({ returnsMatrix: rows });
    expect(shrunk.shrinkageIntensity).toBeGreaterThanOrEqual(0);
    expect(shrunk.shrinkageIntensity).toBeLessThanOrEqual(1);
  });
});

describe("identities: Black-Litterman without opinions is the equilibrium", () => {
  it("leaves the equilibrium returns exactly where they were", () => {
    // The posterior is the equilibrium plus a view term. With no views that term is zero, so any
    // movement at all means the view machinery is firing on an empty input.
    const { cov } = book();
    const result = blackLitterman({ cov, marketWeights: [0.4, 0.35, 0.25] });
    for (const [index, value] of result.expectedReturns.entries()) {
      expect(value).toBeCloseTo(result.equilibriumReturns[index], 12);
    }
  });
});

describe("identities: diversification is not leverage", () => {
  it("delivers a fully invested book rather than a levered one", () => {
    const { cov } = book();
    const solution = maxDiversificationPortfolio(cov);
    expect(solution.grossExposure).toBeCloseTo(1, 8);
    expect(solution.netExposure).toBeCloseTo(1, 8);
  });
});
