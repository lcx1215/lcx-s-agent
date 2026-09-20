/**
 * End-to-end scenarios with known answers.
 *
 * The unit tests prove each function is correct. These prove the toolkit answers the question it
 * was built for: "is this coin associated with this event, or am I looking at noise?" Every scenario
 * below has a planted truth — an effect was either injected or it was not, a shared trend was either
 * there or it was not — so a passing test means the toolkit separated them, not that it returned
 * numbers. A test that only checked "a p-value came back" would pass just as happily on a tool that
 * always said yes.
 *
 * All series come from a seeded generator, so nothing here depends on luck.
 */

import { describe, expect, it } from "vitest";
import { adfTest, adjustPValues } from "../src/agents/quant-math-foundations.js";
import {
  eventStudy,
  leadLagCorrelation,
  spuriousRegressionCheck,
} from "../src/agents/quant-math-inference.js";

function pseudoRandom(seed: number, length: number): number[] {
  const values: number[] = [];
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    values.push(state / 2147483648);
  }
  return values;
}

/** Box–Muller from the seeded generator: reproducible gaussian noise. */
function gaussian(seed: number, length: number, scale: number): number[] {
  const uniforms = pseudoRandom(seed, length * 2);
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const u1 = Math.max(uniforms[2 * i], 1e-12);
    const u2 = uniforms[2 * i + 1];
    const radius = Math.sqrt(-2 * Math.log(u1));
    out.push(scale * radius * Math.cos(2 * Math.PI * u2));
  }
  return out;
}

/**
 * A coin that tracks the market with beta 1.2, 250 days, with an optional event effect planted in
 * days 200..204. `effectPerDay` of 0 means there is genuinely nothing to find.
 */
function marketModelSeries(params: { seed: number; effectPerDay: number }): {
  returns: number[];
  marketReturns: number[];
  estimationWindow: [number, number];
  eventWindow: [number, number];
} {
  const length = 205;
  const marketReturns = gaussian(params.seed, length, 0.01);
  const idiosyncratic = gaussian(params.seed + 1000, length, 0.005);
  const returns = marketReturns.map(
    (market, index) => 0.0005 + 1.2 * market + idiosyncratic[index],
  );
  for (let day = 200; day < 205; day += 1) {
    returns[day] += params.effectPerDay;
  }
  return {
    returns,
    marketReturns,
    estimationWindow: [0, 200],
    eventWindow: [200, 205],
  };
}

describe("scenario: does this event move this coin?", () => {
  it("finds an effect that was actually planted", () => {
    const result = eventStudy(marketModelSeries({ seed: 777, effectPerDay: 0.008 }));
    // Planted: +0.8% per day for five days. The estimate will not land on 4% exactly — the market
    // leg in the event window is whatever it happened to be — but it must land clearly positive.
    expect(result.cumulativeAbnormalReturn).toBeGreaterThan(0.03);
    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.01);
  });

  it("stays quiet when nothing was planted", () => {
    // The expensive failure is a tool that reports an event effect in every window. This pins the
    // opposite direction, which is the one that would quietly generate endless findings. Same seed
    // as the test above, so the only difference is the effect that was or was not planted.
    const result = eventStudy(marketModelSeries({ seed: 777, effectPerDay: 0 }));
    expect(result.significant).toBe(false);
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it("separates the two on the same generator, so the test is the thing doing the work", () => {
    const withEffect = eventStudy(marketModelSeries({ seed: 777, effectPerDay: 0.008 }));
    const without = eventStudy(marketModelSeries({ seed: 777, effectPerDay: 0 }));
    expect(withEffect.tStatistic).toBeGreaterThan(without.tStatistic + 2);
  });

  it("recovers the beta it was built with, because a wrong market model invents abnormal returns", () => {
    const result = eventStudy(marketModelSeries({ seed: 99, effectPerDay: 0 }));
    // Planted beta was 1.2; the estimation window has 200 observations, so it should land close.
    expect(result.beta).toBeGreaterThan(1.0);
    expect(result.beta).toBeLessThan(1.4);
  });
});

describe("scenario: two series that both went up, so are they related?", () => {
  it("refuses to call a shared trend a relationship", () => {
    // Both series are dominated by the same drift and have independent noise: a textbook spurious
    // regression. On levels the fit looks excellent; on differences there is nothing there.
    const drift = Array.from({ length: 200 }, (_unused, index) => index * 0.5);
    const noiseA = gaussian(31, 200, 0.4);
    const noiseB = gaussian(67, 200, 0.4);
    const a = drift.map((value, index) => 100 + value + noiseA[index]);
    const b = drift.map((value, index) => 50 + value * 0.8 + noiseB[index]);

    const result = spuriousRegressionCheck(a, b);
    expect(result.levels.rSquared).toBeGreaterThan(0.8);
    expect(result.differences.rSquared).toBeLessThan(0.2);
    expect(result.verdict).toBe("likely_spurious");
  });

  it("confirms the diagnosis with a unit root, which is what says 'difference before regressing'", () => {
    const drift = Array.from({ length: 200 }, (_unused, index) => index * 0.5);
    const a = drift.map((value, index) => 100 + value + gaussian(11, 200, 0.4)[index]);
    expect(adfTest({ values: a }).verdict).toBe("unit_root");
  });

  it("does not flag a genuine difference relationship as spurious", () => {
    // Same shocks in both series: the levels are unrelated but the daily moves move together, which
    // is a real association and must survive the check.
    const shocks = gaussian(53, 200, 0.5);
    const a: number[] = [];
    const b: number[] = [];
    let levelA = 100;
    let levelB = 50;
    for (const shock of shocks) {
      levelA += shock;
      levelB += shock * 0.7 + 0.01;
      a.push(levelA);
      b.push(levelB);
    }
    const result = spuriousRegressionCheck(a, b);
    expect(result.verdict).not.toBe("likely_spurious");
    expect(result.differences.rSquared).toBeGreaterThan(0.5);
  });
});

describe("scenario: I scanned twenty lags, is the best one real?", () => {
  it("manufactures a finding by scanning, then removes it by correcting", () => {
    // Twenty unrelated pairs, eleven lags each: 220 tests on series that have no relationship at
    // all. At a nominal 5% that is ~11 "discoveries" before a single one means anything.
    // Counting only the best p-value per pair would understate the search: the scan is 220 tests,
    // not 20, and correcting as if it were 20 is how a finding survives its own correction.
    const scannedPValues: number[] = [];
    for (let pair = 0; pair < 20; pair += 1) {
      const a = gaussian(1000 + pair, 120, 0.01);
      const b = gaussian(2000 + pair, 120, 0.01);
      scannedPValues.push(...leadLagCorrelation(a, b, 5).byLag.map((entry) => entry.pValue));
    }
    const corrected = adjustPValues({ pValues: scannedPValues });
    expect(scannedPValues.length).toBeGreaterThan(200);
    // The raw count is the number a naive scan would report as evidence.
    expect(corrected.rawSignificant).toBeGreaterThan(5);
    // Priced for the search that actually happened, nothing survives.
    expect(corrected.adjustedSignificant).toBe(0);
  });

  it("keeps the honest count visible rather than collapsing it into one verdict", () => {
    const pValues = [0.001, 0.4, 0.5, 0.6];
    const result = adjustPValues({ pValues });
    // One real signal among noise: raw and adjusted agree here, and the gap is the useful part —
    // it is what tells you how much of a larger scan was noise.
    expect(result.rawSignificant).toBe(1);
    expect(result.adjustedSignificant).toBe(1);
    expect(result.tests).toBe(4);
  });

  it("keeps a real lead-lag relationship after correction", () => {
    // b is a lagged copy of a: a genuine lead of two periods, buried under noise.
    const a = gaussian(31337, 140, 0.01);
    const noise = gaussian(31338, 140, 0.004);
    const b = a.map((value, index) =>
      index < 2 ? noise[index] : 0.8 * a[index - 2] + noise[index],
    );
    const result = leadLagCorrelation(a, b, 5);
    expect(result.bestLag).toBe(2);
    const corrected = adjustPValues({ pValues: [result.bestPValue] });
    expect(corrected.rejected[0]).toBe(true);
  });
});
