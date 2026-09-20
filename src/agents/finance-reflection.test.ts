import { describe, expect, it } from "vitest";
import { buildReflection, renderReflection, type ScoredSample } from "./finance-reflection.js";

const sample = (
  instrument: string,
  conviction: number,
  outcome: 0 | 1,
  movePct: number,
  day = "2026-08-01",
): ScoredSample => ({
  instrument,
  asOf: day + "T00:00:00.000Z",
  direction: "buy",
  conviction,
  outcome,
  movePct,
});

describe("buildReflection", () => {
  it("reports nothing invented when there is no history", () => {
    const summary = buildReflection([]);
    expect(summary.samples).toBe(0);
    expect(summary.hitRate).toBeNull();
    expect(summary.brier).toBeNull();
  });

  it("separates the instrument's record from the pool's", () => {
    const scored = [
      sample("AAPL", 0.8, 1, 3),
      sample("AAPL", 0.8, 0, -2),
      sample("MSFT", 0.2, 1, 1),
    ];
    const aapl = buildReflection(scored, { instrument: "AAPL" });
    const pool = buildReflection(scored);
    expect(aapl.samples).toBe(2);
    expect(pool.samples).toBe(3);
  });

  it("computes hit rate, mean claim and the gap between them", () => {
    const scored = [sample("AAPL", 0.8, 1, 3), sample("AAPL", 0.8, 0, -2, "2026-08-02")];
    const summary = buildReflection(scored, { instrument: "AAPL" });
    expect(summary.hitRate).toBe(0.5);
    expect(summary.meanClaimed).toBe(0.8);
    expect(summary.overconfidenceGap).toBeCloseTo(0.3, 10);
  });

  it("scores a perfect forecaster at zero and a coin-flip claim at 0.25", () => {
    expect(buildReflection([sample("A", 1, 1, 2)]).brier).toBe(0);
    const coinFlips = [sample("A", 0.5, 1, 1), sample("A", 0.5, 0, -1, "2026-08-02")];
    expect(buildReflection(coinFlips).brier).toBeCloseTo(0.25, 10);
  });

  it("keeps only the most recent instances", () => {
    const scored = Array.from({ length: 10 }, (_unused, i) =>
      sample("A", 0.5, i % 2 === 0 ? 1 : 0, i, "2026-08-0" + ((i % 9) + 1)),
    );
    const summary = buildReflection(scored, { instanceLimit: 3 });
    expect(summary.instances).toHaveLength(3);
  });
});

describe("renderReflection", () => {
  it("says there is no history instead of implying a clean record", () => {
    const text = renderReflection(buildReflection([], { instrument: "AAPL" }));
    expect(text).toContain("no scored history yet");
    expect(text).toContain("do not assume");
  });

  it("states the facts it has", () => {
    const text = renderReflection(
      buildReflection([sample("AAPL", 0.8, 1, 3), sample("AAPL", 0.8, 0, -2, "2026-08-02")], {
        instrument: "AAPL",
      }),
    );
    expect(text).toContain("50.0%");
    expect(text).toContain("0.800");
    expect(text).toContain("Brier");
  });

  it("reports overconfidence as a fact and refuses to turn it into an instruction", () => {
    const text = renderReflection(
      buildReflection([sample("AAPL", 0.9, 0, -2), sample("AAPL", 0.9, 0, -1, "2026-08-02")]),
    );
    expect(text).toContain("claimed more confidence than you delivered");
    // The point of the design: facts, not a directive to move the number.
    expect(text).toContain("not as an instruction to adjust");
  });

  it("stays silent about overconfidence when there is none", () => {
    const text = renderReflection(
      buildReflection([sample("AAPL", 0.5, 1, 2), sample("AAPL", 0.5, 0, -1, "2026-08-02")]),
    );
    expect(text).not.toContain("claimed more confidence");
  });
});
