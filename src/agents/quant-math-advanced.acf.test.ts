import { describe, expect, it } from "vitest";
import { autocorrelationFunction, partialAutocorrelationFunction } from "./quant-math-advanced.js";

/** Geometric decay: x_t = 0.8 * x_{t-1}. Strongly persistent, no randomness. */
function decaying(length = 40): number[] {
  const values: number[] = [1];
  for (let i = 1; i < length; i += 1) {
    values.push(values[i - 1] * 0.8);
  }
  return values;
}

function alternating(length = 40): number[] {
  return Array.from({ length }, (_unused, index) => (index % 2 === 0 ? 1 : -1));
}

describe("autocorrelationFunction", () => {
  it("reports a strong positive echo for a persistent series", () => {
    const result = autocorrelationFunction({ values: decaying(), maxLag: 3 });
    expect(result.n).toBe(40);
    expect(result.maxLag).toBe(3);
    expect(result.lags[0]).toBeGreaterThan(0.5);
    expect(result.significant[0]).toBe(true);
  });

  it("reports a negative echo for an alternating series", () => {
    const result = autocorrelationFunction({ values: alternating(), maxLag: 2 });
    expect(result.lags[0]).toBeLessThan(-0.5);
    expect(result.lags[1]).toBeGreaterThan(0.5);
  });

  it("returns one value per requested lag", () => {
    const result = autocorrelationFunction({ values: decaying(), maxLag: 5 });
    expect(result.lags).toHaveLength(5);
    expect(result.significant).toHaveLength(5);
    expect(result.significanceBand).toBeGreaterThan(0);
  });

  it("refuses a series too short to carry an echo", () => {
    expect(() => autocorrelationFunction({ values: [1, 2, 3] })).toThrow(/at least 8/);
  });

  it("refuses a constant series instead of reporting zeros as structure", () => {
    expect(() => autocorrelationFunction({ values: Array.from({ length: 20 }, () => 5) })).toThrow(
      /constant series/,
    );
  });

  it("clamps maxLag to what the sample can actually support", () => {
    const result = autocorrelationFunction({ values: decaying(12), maxLag: 100 });
    expect(result.maxLag).toBeLessThanOrEqual(Math.floor(12 / 2) - 1);
  });
});

describe("partialAutocorrelationFunction", () => {
  it("isolates the direct lag-1 echo for a first-order series", () => {
    const result = partialAutocorrelationFunction({ values: decaying(60), maxLag: 4 });
    // An AR(1) signature: lag 1 strong, longer lags small once lag 1 is removed.
    expect(result.lags[0]).toBeGreaterThan(0.5);
    expect(Math.abs(result.lags[1])).toBeLessThan(Math.abs(result.lags[0]));
    expect(Math.abs(result.lags[2])).toBeLessThan(Math.abs(result.lags[0]));
  });

  it("keeps the alternating echo negative at lag 1", () => {
    const result = partialAutocorrelationFunction({ values: alternating(), maxLag: 2 });
    expect(result.lags[0]).toBeLessThan(-0.5);
  });

  it("matches count and band with the ACF it is derived from", () => {
    const values = decaying(40);
    const acf = autocorrelationFunction({ values, maxLag: 3 });
    const pacf = partialAutocorrelationFunction({ values, maxLag: 3 });
    expect(pacf.lags).toHaveLength(acf.lags.length);
    expect(pacf.maxLag).toBe(acf.maxLag);
    expect(pacf.significanceBand).toBeCloseTo(acf.significanceBand, 12);
  });

  it("propagates the refusal for a series that is too short", () => {
    expect(() => partialAutocorrelationFunction({ values: [1, 2] })).toThrow(/at least 8/);
  });
});
