/**
 * Known answers for the inference layer.
 *
 * Most of what guards this code asks "does it refuse nonsense". That is necessary and not
 * sufficient: a function can refuse every bad input and still be wrong about the good ones. Here a
 * series is built with a known alpha, a known beta, a known lead and a known shock, and the
 * question is whether the estimator finds the number that is actually there.
 *
 * The multiple-testing figures are checked against the worked example rather than against the
 * implementation, so a refactor that changes the arithmetic has something outside itself to be
 * wrong about.
 */

import { describe, expect, it } from "vitest";
import { adjustPValues } from "../src/agents/quant-math-foundations.js";
import { eventStudy, leadLagCorrelation } from "../src/agents/quant-math-inference.js";

function gaussian(seed: number, length: number, scale = 0.015): number[] {
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

describe("multiple testing: the correction is the one textbooks work out", () => {
  /** The standard ten-p-value example; the adjusted column is published, not derived from here. */
  const example = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
  const expected = [0.01, 0.04, 0.084, 0.084, 0.084, 0.1, 0.1057, 0.216, 0.216, 0.216];

  it("reproduces the Benjamini-Hochberg adjusted values", () => {
    const result = adjustPValues({ pValues: example });
    for (let i = 0; i < expected.length; i += 1) {
      expect(result.adjusted[i]).toBeCloseTo(expected[i], 4);
    }
  });

  it("keeps the ordering: a smaller p-value never gets a larger adjusted one", () => {
    // BH enforces monotonicity on purpose; without it a hypothesis could be rejected while a
    // stronger one is not, which is not a result anyone can act on.
    const shuffled = [0.3, 0.001, 0.2, 0.04, 0.5];
    const result = adjustPValues({ pValues: shuffled });
    for (let i = 0; i < shuffled.length; i += 1) {
      for (let j = 0; j < shuffled.length; j += 1) {
        if (shuffled[i] < shuffled[j]) {
          expect(result.adjusted[i]).toBeLessThanOrEqual(result.adjusted[j] + 1e-12);
        }
      }
    }
  });

  it("applies Bonferroni as the plain product, capped at certainty", () => {
    const result = adjustPValues({ pValues: [0.01, 0.02, 0.03], method: "bonferroni" });
    expect(result.adjusted[0]).toBeCloseTo(0.03, 12);
    expect(result.adjusted[1]).toBeCloseTo(0.06, 12);
    expect(result.adjusted[2]).toBeCloseTo(0.09, 12);
    // Only the smallest survives correction at 5%, which is the point of the method.
    expect(result.rejected).toEqual([true, false, false]);
    expect(adjustPValues({ pValues: [0.9, 0.8], method: "bonferroni" }).adjusted).toEqual([1, 1]);
  });

  it("refuses a p-value that is not a probability", () => {
    // A negative p-value used to survive the correction as a negative adjusted value and was then
    // reported as significant: the strongest possible claim, from a number that cannot exist.
    expect(() => adjustPValues({ pValues: [0.01, -0.2, 0.03] })).toThrow(
      /pValues must each be between/u,
    );
    expect(() => adjustPValues({ pValues: [0.01, 1.5, 0.03] })).toThrow(
      /pValues must each be between/u,
    );
    expect(() => adjustPValues({ pValues: [0.01], alpha: 1.5 })).toThrow(/alpha must be between/u);
    expect(() => adjustPValues({ pValues: [0.01], alpha: -0.05 })).toThrow(
      /alpha must be between/u,
    );
  });
});

describe("event study: recovers the model it was built from", () => {
  const market = gaussian(11, 200);
  const noise = gaussian(99, 200, 0.002);
  const alpha = 0.001;
  const beta = 1.2;
  const shock = 0.02;

  /** A market-model series, with the shock added only across the event window. */
  function build(withShock: boolean): number[] {
    return market.map((value, index) => {
      const normal = alpha + beta * value + noise[index];
      return withShock && index >= 150 && index < 155 ? normal + shock : normal;
    });
  }
  const windows = {
    estimationWindow: [0, 150] as [number, number],
    eventWindow: [150, 155] as [number, number],
  };

  it("recovers the alpha and beta it was generated with", () => {
    const study = eventStudy({ returns: build(false), marketReturns: market, ...windows });
    expect(Math.abs(study.alpha - alpha)).toBeLessThan(5e-4);
    expect(Math.abs(study.beta - beta)).toBeLessThan(0.05);
  });

  it("measures the shock that was injected, and calls it significant", () => {
    const study = eventStudy({ returns: build(true), marketReturns: market, ...windows });
    expect(study.eventObservations).toBe(5);
    // Five days of a 2% abnormal return is a cumulative 10%; the estimate carries the noise.
    expect(study.cumulativeAbnormalReturn).toBeGreaterThan(0.09);
    expect(study.cumulativeAbnormalReturn).toBeLessThan(0.11);
    for (const abnormal of study.abnormalReturns) {
      expect(abnormal).toBeGreaterThan(shock - 0.005);
      expect(abnormal).toBeLessThan(shock + 0.005);
    }
    expect(study.significant).toBe(true);
  });

  it("does not call an unshocked window significant", () => {
    const study = eventStudy({ returns: build(false), marketReturns: market, ...windows });
    expect(Math.abs(study.cumulativeAbnormalReturn)).toBeLessThan(0.01);
    expect(study.significant).toBe(false);
  });

  it("refuses an event window with no days in it", () => {
    // Zero event days used to come back as a complete result: a cumulative abnormal return of 0
    // with a p-value of 1, which reads as a study that examined the event and found nothing.
    const base = {
      returns: build(true),
      marketReturns: market,
      estimationWindow: [0, 150] as [number, number],
    };
    expect(() => eventStudy({ ...base, eventWindow: [150, 150] })).toThrow(
      /event window must contain/u,
    );
    expect(() => eventStudy({ ...base, eventWindow: [155, 150] })).toThrow(
      /event window must contain/u,
    );
    // One day is a real window, however short.
    expect(eventStudy({ ...base, eventWindow: [150, 151] }).eventObservations).toBe(1);
  });
});

describe("lead-lag: finds the offset that is actually there", () => {
  it("reports the lag the series was built with, in both directions", () => {
    // Built from one underlying series so the relationship is exact rather than noisy: `behind`
    // is the same series shifted two places later, `ahead` two places earlier.
    // Both windows are the same length as the series, so the only thing that differs is the offset.
    const underlying = gaussian(7, 204);
    const series = underlying.slice(2, 202);
    const behind = underlying.slice(0, 200);
    const ahead = underlying.slice(4, 204);
    expect(leadLagCorrelation(series, behind, 5).bestLag).toBe(2);
    expect(leadLagCorrelation(series, behind, 5).bestCorrelation).toBeCloseTo(1, 6);
    expect(leadLagCorrelation(series, ahead, 5).bestLag).toBe(-2);
    expect(leadLagCorrelation(series, ahead, 5).bestCorrelation).toBeCloseTo(1, 6);
  });

  it("refuses two series that are not the same sample period", () => {
    // Truncating to the overlap gives every lag a different sample size and then reports the
    // largest correlation found over those mismatched samples as the answer.
    expect(() => leadLagCorrelation(gaussian(7, 50), gaussian(8, 200), 3)).toThrow(
      /series lengths disagree/u,
    );
  });

  it("says the lag argument is wrong rather than blaming the data", () => {
    // A fractional lag indexes between observations, which surfaced as a complaint that the series
    // was non-finite — pointing at the data when the argument is what is wrong.
    expect(() => leadLagCorrelation(gaussian(7, 50), gaussian(8, 50), 2.5)).toThrow(
      /maxLag must be a non-negative whole number/u,
    );
    expect(() => leadLagCorrelation(gaussian(7, 50), gaussian(8, 50), -3)).toThrow(
      /maxLag must be a non-negative whole number/u,
    );
    expect(() => leadLagCorrelation(gaussian(7, 50), gaussian(8, 50), Number.NaN)).toThrow(
      /maxLag must be a non-negative whole number/u,
    );
  });
});
