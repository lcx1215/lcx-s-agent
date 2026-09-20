/**
 * The tool face: `quant_lab` driven the way a model actually drives it.
 *
 * Every other test in this area calls the maths directly. That proves the arithmetic and says
 * nothing about whether the schema a model sends is wired to the function that runs. A parameter
 * the dispatch forgets to forward, a bounds object it fails to assemble, or a new field the
 * response drops will all leave the unit tests green while the tool does something else — which is
 * the failure shape that cannot be seen from inside the function.
 *
 * So these go in through `execute`, read back what the model would read, and assert on that.
 */

import { describe, expect, it } from "vitest";
import { createQuantLabTool } from "../src/agents/tools/quant-lab-tool.js";

type ToolPayload = { content?: Array<{ text?: string }> };

async function callLab(
  action: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tool = createQuantLabTool() as unknown as {
    execute: (id: string, params: Record<string, unknown>) => Promise<ToolPayload>;
  };
  const result = await tool.execute("tool-face", { action, ...params });
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`${action} returned no text content`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function weightsOf(payload: Record<string, unknown>): number[] {
  const weights = payload.weights;
  if (!Array.isArray(weights) || !weights.every((value) => typeof value === "number")) {
    throw new Error(`no numeric weights in the response: ${JSON.stringify(payload)}`);
  }
  return weights;
}

function numberField(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number") {
    throw new Error(`${key} is missing from the response: ${JSON.stringify(payload)}`);
  }
  return value;
}

/** Two assets that are nearly the same asset: the shape behind a wrapper or a pegged twin. */
function nearCollinearRows(rho: number): number[][] {
  const days = 250;
  const uniforms = (seed: number) => {
    const values: number[] = [];
    let state = seed;
    for (let i = 0; i < days * 2; i += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      values.push(state / 2147483648);
    }
    return values;
  };
  const series = (seed: number): number[] => {
    const raw = uniforms(seed);
    const out: number[] = [];
    for (let i = 0; i < days; i += 1) {
      const u1 = Math.max(raw[2 * i], 1e-12);
      out.push(0.02 * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * raw[2 * i + 1]));
    }
    return out;
  };
  const factor = series(101);
  const idiosyncratic = series(202);
  const noise = Math.sqrt(1 - rho * rho);
  return Array.from({ length: days }, (_unused, day) => [
    factor[day],
    rho * factor[day] + noise * idiosyncratic[day],
  ]);
}

describe("tool face: what the model sends is what runs", () => {
  // The unconstrained tangency solution on this pair is short 3.09 and long 4.09 — a 7x gross
  // book. Asking for a long-only portfolio and getting that back, with no error, is the failure
  // this file exists to catch.
  const cov = [
    [0.0004, 0.00039],
    [0.00039, 0.0004],
  ];
  const expectedReturns = [0.001, 0.0012];

  it("honours a lower bound sent through the schema", async () => {
    const free = await callLab("max_sharpe", { cov, expectedReturns });
    expect(numberField(free, "grossExposure")).toBeGreaterThan(1);

    const longOnly = await callLab("max_sharpe", { cov, expectedReturns, lower: 0 });
    for (const weight of weightsOf(longOnly)) {
      expect(weight).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(numberField(longOnly, "grossExposure")).toBeCloseTo(1, 6);
  });

  it("honours an upper bound too, rather than only the lower one", async () => {
    const capped = await callLab("max_sharpe", { cov, expectedReturns, lower: 0, upper: 0.6 });
    const weights = weightsOf(capped);
    for (const weight of weights) {
      expect(weight).toBeGreaterThanOrEqual(-1e-9);
      expect(weight).toBeLessThanOrEqual(0.6 + 1e-9);
    }
    // Two assets capped at 0.6 can still fill the book, so the cap must not quietly leave cash.
    expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
  });

  it("says when bounds cannot be met instead of returning weights that ignore them", async () => {
    // Two assets, each capped at 0.4, can only ever reach 0.8 of the book.
    await expect(
      callLab("max_sharpe", { cov, expectedReturns, lower: 0, upper: 0.4 }),
    ).rejects.toThrow(/infeasible/u);
  });

  it("puts the risk fields in the response, not only in the function's return", async () => {
    const result = await callLab("max_sharpe", { cov, expectedReturns });
    expect(numberField(result, "grossExposure")).toBeGreaterThan(1);
    expect(numberField(result, "netExposure")).toBeCloseTo(1, 6);
    expect(numberField(result, "conditionNumber")).toBeGreaterThan(0);
    expect(result.illConditioned).toBe(false);
  });

  it("runs the documented remedy end to end, all of it through the tool", async () => {
    // The description tells the caller to shrink when a solution comes back ill-conditioned. That
    // instruction is only worth giving if the three calls it implies actually compose.
    const rows = nearCollinearRows(0.999999);
    const covariance = await callLab("covariance_matrix", { returnsMatrix: rows });
    const before = await callLab("min_variance", { cov: covariance.covariance });
    expect(before.illConditioned).toBe(true);

    const shrunk = await callLab("shrink_covariance", { returnsMatrix: rows });
    const after = await callLab("min_variance", { cov: shrunk.covariance });
    expect(after.illConditioned).toBe(false);
    expect(numberField(after, "grossExposure")).toBeCloseTo(1, 4);
  });

  it("refuses an action the schema does not have", async () => {
    await expect(callLab("teleport_portfolio", { cov })).rejects.toThrow(/action must be one of/u);
  });

  it("leaves a calculation id behind, so a later claim can be checked", async () => {
    const first = await callLab("min_variance", { cov });
    const second = await callLab("min_variance", { cov });
    expect(typeof first.calculationId).toBe("string");
    // A number the model says it computed has to be traceable to a run that happened; two calls
    // are two records, and the ledger size has to have grown with them.
    expect(numberField(second, "ledgerSize")).toBeGreaterThan(numberField(first, "ledgerSize"));
  });
});

describe("tool face: the autocorrelation actions", () => {
  /** A persistent series: the textbook shape both functions are meant to distinguish from noise. */
  function persistent(days = 200): number[] {
    const raw: number[] = [];
    let state = 44;
    for (let i = 0; i < days * 2; i += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      raw.push(state / 2147483648);
    }
    const shocks: number[] = [];
    for (let i = 0; i < days; i += 1) {
      const u1 = Math.max(raw[2 * i], 1e-12);
      shocks.push(0.01 * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * raw[2 * i + 1]));
    }
    const out: number[] = [];
    let previous = 0;
    for (const shock of shocks) {
      previous = 0.7 * previous + shock;
      out.push(previous);
    }
    return out;
  }

  it("reaches the ACF through the action name the schema advertises", async () => {
    const result = await callLab("acf", { series: persistent(), maxLag: 3 });
    expect(numberField(result, "n")).toBe(200);
    expect(numberField(result, "maxLag")).toBe(3);
    const lags = weightsOf({ weights: result.lags });
    // AR(1) with phi 0.7: the first lag recovers phi and the rest decay geometrically.
    expect(lags[0]).toBeCloseTo(0.7, 1);
    expect(lags[0]).toBeGreaterThan(lags[1]);
  });

  it("reaches the PACF too, and it cuts off where the ACF does not", async () => {
    const series = persistent();
    const acf = await callLab("acf", { series, maxLag: 3 });
    const pacf = await callLab("pacf", { series, maxLag: 3 });
    const acfLags = weightsOf({ weights: acf.lags });
    const pacfLags = weightsOf({ weights: pacf.lags });
    expect(pacfLags[0]).toBeCloseTo(acfLags[0], 6);
    expect(Math.abs(pacfLags[1])).toBeLessThan(Math.abs(acfLags[1]));
  });

  it("says the series is missing rather than reading it as empty", async () => {
    await expect(callLab("acf", { maxLag: 3 })).rejects.toThrow(/series is required/u);
  });

  it("refuses a series with a hole in it, at the schema and not only in the function", async () => {
    // The function now rejects this too, but the tool has to reject it before the numbers ever
    // reach the maths: a dropped candle would silently re-pair the days either side of it.
    const series = persistent();
    series[100] = NaN;
    await expect(callLab("acf", { series, maxLag: 3 })).rejects.toThrow(/finite/u);
    await expect(callLab("pacf", { series, maxLag: 3 })).rejects.toThrow(/finite/u);
  });
});
