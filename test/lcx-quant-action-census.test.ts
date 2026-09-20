/**
 * A census of every action both quant tools advertise.
 *
 * Twenty-five of the fifty-six actions had never been named in any test. The functions behind them
 * were exercised, but the wiring was not: the action string, the parameter names the dispatch reads,
 * and whether a NaN in the payload is stopped before it reaches the arithmetic. Renaming a case in
 * the dispatch is invisible to every test that calls the function directly, which is exactly how a
 * tool ends up advertising an action that no longer goes anywhere.
 *
 * So this asks two things of each action, and nothing more: give it a sane payload and expect an
 * answer with no NaNs in it; give it a payload with one hole in it and expect a refusal.
 */

import { describe, expect, it } from "vitest";
import { createQuantLabTool } from "../src/agents/tools/quant-lab-tool.js";
import { createQuantMathTool } from "../src/agents/tools/quant-math-tool.js";

type ToolUnderTest = {
  execute: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

const lab = createQuantLabTool() as unknown as ToolUnderTest;
const math = createQuantMathTool() as unknown as ToolUnderTest;

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

const series = gaussian(11, 200);
const benchmark = gaussian(22, 200, 0.015);
const cov = [
  [0.0004, 0.0001],
  [0.0001, 0.0004],
];
const returnsMatrix = Array.from({ length: 200 }, (_, row) => [series[row], benchmark[row]]);
const weights = [0.6, 0.4];

type Case = {
  tool: "lab" | "math";
  action: string;
  params: Record<string, unknown>;
  /** The field a caller would realistically have a gap in; poisoned to check the refusal. */
  hole: string;
};

const cases: Case[] = [
  // ---- quant_lab ----
  { tool: "lab", action: "min_variance", params: { cov }, hole: "cov" },
  {
    tool: "lab",
    action: "max_sharpe",
    params: { cov, expectedReturns: [0.001, 0.0008] },
    hole: "cov",
  },
  { tool: "lab", action: "risk_parity", params: { cov }, hole: "cov" },
  { tool: "lab", action: "max_diversification", params: { cov }, hole: "cov" },
  { tool: "lab", action: "black_litterman", params: { cov, marketWeights: weights }, hole: "cov" },
  { tool: "lab", action: "component_var", params: { cov, weights }, hole: "cov" },
  {
    tool: "lab",
    action: "cornish_fisher_var",
    params: { series, confidenceLevel: 0.95 },
    hole: "series",
  },
  {
    tool: "lab",
    action: "ewma_covariance",
    params: { returnsMatrix, lambda: 0.94 },
    hole: "returnsMatrix",
  },
  { tool: "lab", action: "covariance_matrix", params: { returnsMatrix }, hole: "returnsMatrix" },
  { tool: "lab", action: "correlation_matrix", params: { returnsMatrix }, hole: "returnsMatrix" },
  { tool: "lab", action: "shrink_covariance", params: { returnsMatrix }, hole: "returnsMatrix" },
  { tool: "lab", action: "newey_west_mean", params: { series, lags: 4 }, hole: "series" },
  { tool: "lab", action: "jarque_bera", params: { series }, hole: "series" },
  { tool: "lab", action: "moments", params: { series }, hole: "series" },
  { tool: "lab", action: "durbin_watson", params: { series }, hole: "series" },
  { tool: "lab", action: "acf", params: { series, maxLag: 3 }, hole: "series" },
  { tool: "lab", action: "pacf", params: { series, maxLag: 3 }, hole: "series" },
  { tool: "lab", action: "adf_test", params: { series }, hole: "series" },
  {
    tool: "lab",
    action: "adjust_p_values",
    params: { pValues: [0.01, 0.2, 0.03] },
    hole: "pValues",
  },
  { tool: "lab", action: "correlation_test", params: { series, benchmark }, hole: "series" },
  { tool: "lab", action: "regression_diagnostics", params: { series, benchmark }, hole: "series" },
  {
    tool: "lab",
    action: "spurious_regression_check",
    params: { series, benchmark },
    hole: "series",
  },
  {
    tool: "lab",
    action: "lead_lag_correlation",
    params: { series, benchmark, maxLag: 3 },
    hole: "series",
  },
  {
    tool: "lab",
    action: "granger_causality",
    params: { series, benchmark, lags: 2 },
    hole: "series",
  },
  {
    tool: "lab",
    action: "rolling_correlation",
    params: { series, benchmark, window: 60 },
    hole: "series",
  },
  {
    tool: "lab",
    action: "event_study",
    params: { series, benchmark, estimationWindow: [0, 120], eventWindow: [120, 150] },
    hole: "series",
  },
  {
    tool: "lab",
    action: "stress_test",
    params: { weights, scenarios: [{ name: "crash", shocks: [-0.3, -0.2] }] },
    hole: "weights",
  },
  {
    tool: "lab",
    action: "turnover_cost",
    params: { currentWeights: weights, targetWeights: [0.4, 0.6], costBasisPoints: 10 },
    hole: "currentWeights",
  },
  {
    tool: "lab",
    action: "brinson_attribution",
    params: {
      sectors: ["majors", "alts"],
      portfolioWeights: weights,
      portfolioReturns: [0.1, 0.2],
      benchmarkWeights: [0.7, 0.3],
      benchmarkReturns: [0.08, 0.15],
    },
    hole: "portfolioReturns",
  },
  // ---- quant_math ----
  { tool: "math", action: "beta", params: { series, benchmark }, hole: "series" },
  { tool: "math", action: "correlation", params: { series, benchmark }, hole: "series" },
  {
    tool: "math",
    action: "returns_from_levels",
    params: { series: [100, 101, 99, 102] },
    hole: "series",
  },
  {
    tool: "math",
    action: "covariance_matrix",
    params: { seriesMatrix: returnsMatrix },
    hole: "seriesMatrix",
  },
  {
    tool: "math",
    action: "correlation_matrix",
    params: { seriesMatrix: returnsMatrix },
    hole: "seriesMatrix",
  },
  { tool: "math", action: "linear_regression", params: { series, benchmark }, hole: "series" },
  {
    tool: "math",
    action: "rolling_beta",
    params: { series, benchmark, window: 60 },
    hole: "series",
  },
  {
    tool: "math",
    action: "rolling_correlation",
    params: { series, benchmark, window: 60 },
    hole: "series",
  },
  { tool: "math", action: "sharpe", params: { series }, hole: "series" },
  { tool: "math", action: "sortino", params: { series }, hole: "series" },
  { tool: "math", action: "tracking_error", params: { series, benchmark }, hole: "series" },
  { tool: "math", action: "information_ratio", params: { series, benchmark }, hole: "series" },
  { tool: "math", action: "max_drawdown", params: { series }, hole: "series" },
  { tool: "math", action: "drawdown_duration", params: { series }, hole: "series" },
  { tool: "math", action: "cagr", params: { series }, hole: "series" },
  { tool: "math", action: "calmar_ratio", params: { series }, hole: "series" },
  { tool: "math", action: "z_score", params: { series }, hole: "series" },
  {
    tool: "math",
    action: "historical_var",
    params: { series, confidenceLevel: 0.95 },
    hole: "series",
  },
  {
    tool: "math",
    action: "expected_shortfall",
    params: { series, confidenceLevel: 0.95 },
    hole: "series",
  },
  { tool: "math", action: "rolling_volatility", params: { series, window: 60 }, hole: "series" },
  {
    tool: "math",
    action: "rolling_max_drawdown",
    params: { series: [100, 101, 99, 102, 98, 103], window: 3 },
    hole: "series",
  },
  {
    tool: "math",
    action: "portfolio_return",
    params: { series: [0.001, 0.002], weights },
    hole: "series",
  },
  {
    tool: "math",
    action: "portfolio_volatility",
    params: { covarianceMatrix: cov, weights },
    hole: "covarianceMatrix",
  },
  {
    tool: "math",
    action: "portfolio_risk_contribution",
    params: { covarianceMatrix: cov, weights },
    hole: "covarianceMatrix",
  },
  {
    tool: "math",
    action: "risk_budget_deviation",
    params: { covarianceMatrix: cov, weights, targetRiskBudgets: [0.5, 0.5] },
    hole: "covarianceMatrix",
  },
  {
    tool: "math",
    action: "black_scholes",
    params: {
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
      optionType: "call",
    },
    hole: "volatility",
  },
  {
    tool: "math",
    action: "bond_duration",
    params: {
      couponRate: 0.05,
      yieldRate: 0.04,
      maturityYears: 10,
      paymentsPerYear: 2,
      faceValue: 100,
    },
    hole: "couponRate",
  },
];

/** Put a single NaN somewhere in the middle of whatever the caller supplied. */
function poison(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.NaN;
  }
  if (Array.isArray(value)) {
    const copy = value.slice();
    copy[Math.floor(copy.length / 2)] = poison(copy[Math.floor(copy.length / 2)]);
    return copy;
  }
  return value;
}

async function callAction(
  tool: "lab" | "math",
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const target = tool === "lab" ? lab : math;
  const result = await target.execute("census", { action, ...params });
  return JSON.parse(result.content[0].text) as unknown;
}

function nanPaths(value: unknown, path = ""): string[] {
  if (typeof value === "number") {
    return Number.isNaN(value) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => nanPaths(entry, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      nanPaths(entry, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

describe("quant action census: every advertised action is reachable", () => {
  it("covers both tool faces", () => {
    expect(cases.filter((entry) => entry.tool === "lab").length).toBeGreaterThanOrEqual(29);
    expect(cases.filter((entry) => entry.tool === "math").length).toBeGreaterThanOrEqual(27);
  });

  for (const entry of cases) {
    it(`${entry.tool} ${entry.action} answers a sane payload with no NaNs in it`, async () => {
      const result = await callAction(entry.tool, entry.action, entry.params);
      expect(result).toBeTypeOf("object");
      // An answer that is nothing but a NaN still parses as a number, so look for them explicitly.
      expect(nanPaths(result)).toEqual([]);
    });

    it(`${entry.tool} ${entry.action} refuses a payload with a hole in it`, async () => {
      const holed = { ...entry.params, [entry.hole]: poison(entry.params[entry.hole]) };
      // Not just "it threw": an unknown action also throws, and its message contains the word
      // "must". A dispatch detached from the advertised name would satisfy a loose assertion, so
      // check that the refusal is about the payload and not about the action failing to resolve.
      const error = await callAction(entry.tool, entry.action, holed).then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toMatch(/action must be one of|Unsupported|unknown action/u);
      expect(error?.message).toMatch(/finite|required|non-zero|positive|between|at least/u);
    });
  }
});
