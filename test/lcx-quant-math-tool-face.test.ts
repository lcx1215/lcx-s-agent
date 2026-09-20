/**
 * The second quant tool face.
 *
 * `quant_math` is a separate registered tool from `quant_lab`, with its own 27 actions and its own
 * arithmetic — it does not call into the quant-math-* modules that the lab tool is built on. Two
 * things follow from that, and both are checked here. Its refusal behaviour has to hold on its own,
 * because the guards in the other layer do not cover it. And where the two tools can answer the same
 * question, they have to agree, because which one an agent reaches for is not under anyone's control.
 */

import { describe, expect, it } from "vitest";
import { correlationMatrix, covarianceMatrix } from "../src/agents/quant-math-foundations.js";
import { createQuantMathTool } from "../src/agents/tools/quant-math-tool.js";

type ToolExecuteResult = { content: Array<{ text: string }> };

const tool = createQuantMathTool() as unknown as {
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolExecuteResult>;
};

async function callMath(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const result = await tool.execute("call", { action, ...params });
  return JSON.parse(result.content[0].text) as unknown;
}

function gaussian(seed: number, length: number, scale = 0.02): number[] {
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

describe("quant_math: a flat series has no ratio to report", () => {
  /**
   * Every "must be non-zero" guard in this file compares a computed variance against exact zero.
   * That works when the data are integers, because then the mean is exact and the deviations really
   * are zero. It stops working the moment the mean is a rounded sum: on a flat series the deviations
   * are the leftovers of that rounding, around 1e-18, so the variance is tiny but not zero and the
   * guard waves it through. What comes out is not a small number, it is a meaningless one — a Sharpe
   * of 1e16, and a correlation of exactly 1 between two series that never moved.
   */
  const flat = Array.from({ length: 100 }, () => 0.01);
  const other = gaussian(11, 100);

  it("refuses a Sharpe ratio for a series with no volatility", () => {
    // The integer-valued flat series was already rejected; the decimal one was not, which is the
    // whole problem: whether the guard fires was decided by how the number happens to round.
    return expect(callMath("sharpe", { series: flat })).rejects.toThrow(
      /volatility must be non-zero/u,
    );
  });

  it("refuses a z-score for the same series", () => {
    return expect(callMath("z_score", { series: flat })).rejects.toThrow(
      /standard deviation must be non-zero/u,
    );
  });

  it("does not report two motionless series as perfectly correlated", () => {
    // Correlation is covariance over the product of two standard deviations. With both denominators
    // at the rounding floor, that ratio lands on 1 — the strongest possible claim, produced by two
    // series with no variation in them at all.
    return expect(
      callMath("correlation", { series: flat, benchmark: Array.from({ length: 100 }, () => 0.02) }),
    ).rejects.toThrow(/standard deviation must be non-zero/u);
  });

  it("refuses a beta against a benchmark that never moved", () => {
    return expect(callMath("beta", { series: other, benchmark: flat })).rejects.toThrow(
      /benchmark variance must be non-zero/u,
    );
  });

  it("still answers all of them for a series that does move", async () => {
    const sharpe = (await callMath("sharpe", { series: other })) as { sharpe: number };
    const zScore = (await callMath("z_score", { series: other })) as { zScore: number };
    const correlation = (await callMath("correlation", {
      series: other,
      benchmark: gaussian(22, 100, 0.015),
    })) as { correlation: number };
    expect(Number.isFinite(sharpe.sharpe)).toBe(true);
    expect(Number.isFinite(zScore.zScore)).toBe(true);
    expect(Math.abs(correlation.correlation)).toBeLessThanOrEqual(1);
  });
});

describe("quant_math: the two tool faces agree on the questions both can answer", () => {
  const seriesMatrix = Array.from({ length: 300 }, (_, row) => [
    gaussian(900 + row, 1, 0.02)[0],
    gaussian(5000 + row, 1, 0.015)[0],
  ]);

  it("returns the same covariance matrix as the lab layer", async () => {
    const fromTool = (await callMath("covariance_matrix", { seriesMatrix })) as {
      covarianceMatrix: number[][];
    };
    const fromLab = covarianceMatrix(seriesMatrix);
    for (let i = 0; i < fromLab.length; i += 1) {
      for (let j = 0; j < fromLab.length; j += 1) {
        expect(fromTool.covarianceMatrix[i][j]).toBeCloseTo(fromLab[i][j], 18);
      }
    }
  });

  it("returns the same correlation matrix as the lab layer", async () => {
    const fromTool = (await callMath("correlation_matrix", { seriesMatrix })) as {
      correlationMatrix: number[][];
    };
    const fromLab = correlationMatrix(seriesMatrix);
    for (let i = 0; i < fromLab.length; i += 1) {
      for (let j = 0; j < fromLab.length; j += 1) {
        expect(fromTool.correlationMatrix[i][j]).toBeCloseTo(fromLab[i][j], 12);
      }
    }
  });
});

describe("quant_math: refuses what it cannot compute, rather than returning a number", () => {
  const series = gaussian(11, 200);

  it("rejects a hole in the series before the arithmetic sees it", async () => {
    const holed = series.slice();
    holed[100] = Number.NaN;
    await expect(callMath("sharpe", { series: holed })).rejects.toThrow(/finite/u);
    await expect(
      callMath("historical_var", { series: holed, confidenceLevel: 0.95 }),
    ).rejects.toThrow(/finite/u);
    await expect(callMath("max_drawdown", { series: holed })).rejects.toThrow(/finite/u);
  });

  it("keeps the confidence level inside its own domain", async () => {
    // A level of 1 would ask for the worst of every observation, and 0 for none of them; neither is
    // a quantile the estimator can return.
    await expect(callMath("historical_var", { series, confidenceLevel: 0 })).rejects.toThrow(
      /confidenceLevel must be between/u,
    );
    await expect(callMath("historical_var", { series, confidenceLevel: 1 })).rejects.toThrow(
      /confidenceLevel must be between/u,
    );
    await expect(callMath("historical_var", { series, confidenceLevel: 1.5 })).rejects.toThrow(
      /confidenceLevel must be between/u,
    );
  });

  it("rejects an option that cannot exist", async () => {
    const base = {
      spot: 100,
      strike: 100,
      riskFreeRate: 0.05,
      volatility: 0.2,
      optionType: "call",
    };
    await expect(callMath("black_scholes", { ...base, timeToExpiryYears: 0 })).rejects.toThrow(
      /timeToExpiryYears must be positive/u,
    );
    await expect(
      callMath("black_scholes", { ...base, timeToExpiryYears: 1, volatility: 0 }),
    ).rejects.toThrow(/volatility must be positive/u);
    await expect(
      callMath("black_scholes", { ...base, timeToExpiryYears: 1, volatility: -0.2 }),
    ).rejects.toThrow(/volatility must be positive/u);
    await expect(
      callMath("black_scholes", { ...base, timeToExpiryYears: 1, spot: -100 }),
    ).rejects.toThrow(/spot must be positive/u);
  });

  it("keeps a rolling window inside the series", async () => {
    await expect(
      callMath("rolling_volatility", { series: series.slice(0, 20), window: 50 }),
    ).rejects.toThrow(/window must not exceed/u);
    await expect(callMath("rolling_volatility", { series, window: 0 })).rejects.toThrow(
      /window must be at least/u,
    );
  });

  it("refuses a downside-risk ratio when there is no downside", async () => {
    // Every period is a gain, so the downside deviation is zero and the ratio has no denominator.
    await expect(
      callMath("sortino", { series: Array.from({ length: 100 }, () => 0.01) }),
    ).rejects.toThrow(/downside deviation must be non-zero/u);
  });
});
