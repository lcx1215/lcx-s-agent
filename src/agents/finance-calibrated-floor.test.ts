import { describe, expect, it } from "vitest";
import { breakEvenFloor, type FloorSample } from "./finance-calibrated-floor.js";

/** `n` samples at one conviction, `wins` of them correct. */
function at(conviction: number, n: number, wins: number): FloorSample[] {
  return Array.from({ length: n }, (_unused, i) => ({
    conviction,
    outcome: i < wins ? (1 as const) : (0 as const),
  }));
}

describe("breakEvenFloor", () => {
  it("refuses to invent a floor when there is no data", () => {
    const result = breakEvenFloor([]);
    expect(result.floor).toBeNull();
    expect(result.basis).toMatch(/no scored samples/);
  });

  it("derives the floor from the lowest conviction that breaks even", () => {
    const samples = [
      ...at(0.2, 5, 1), // 0.20 - loses
      ...at(0.3, 5, 2), // 0.40 - loses
      ...at(0.5, 5, 4), // 0.80 - wins
      ...at(0.7, 5, 5), // 1.00 - wins
    ];
    const result = breakEvenFloor(samples);
    expect(result.floor).toBe(0.5);
    expect(result.samplesUsed).toBe(20);
  });

  it("returns null when nothing has demonstrated break-even", () => {
    const samples = [...at(0.2, 10, 1), ...at(0.4, 10, 3)];
    const result = breakEvenFloor(samples);
    expect(result.floor).toBeNull();
    expect(result.basis).toMatch(/none reached break-even/);
  });

  it("distrusts a lucky low bucket when a higher one fails", () => {
    // 0.30 looks great on five samples, 0.50 is poor. Trusting the low bucket
    // would set the bar using the one lucky draw.
    const samples = [...at(0.3, 5, 4), ...at(0.5, 5, 1)];
    const result = breakEvenFloor(samples);
    expect(result.floor).toBeNull();
    expect(result.basis).toMatch(/not monotonic/);
  });

  it("ignores buckets too thin to mean anything", () => {
    // Two perfect calls at 0.2 is not evidence; five at 0.6 is.
    const samples = [...at(0.2, 2, 2), ...at(0.6, 6, 4)];
    const result = breakEvenFloor(samples);
    expect(result.floor).toBe(0.6);
  });

  it("requires every bucket above the floor to hold, not just the lowest", () => {
    const samples = [...at(0.5, 5, 5), ...at(0.6, 5, 1)];
    const result = breakEvenFloor(samples);
    expect(result.floor).toBeNull();
  });

  it("exposes the buckets so the number can be argued with", () => {
    const result = breakEvenFloor([...at(0.5, 5, 4), ...at(0.7, 5, 5)]);
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.buckets[0]?.n).toBeGreaterThan(0);
  });

  it("drops malformed samples rather than scoring them", () => {
    const samples: FloorSample[] = [
      { conviction: Number.NaN, outcome: 1 },
      { conviction: 1.5, outcome: 1 },
      ...at(0.6, 5, 4),
    ];
    const result = breakEvenFloor(samples);
    expect(result.samplesUsed).toBe(5);
  });
});
