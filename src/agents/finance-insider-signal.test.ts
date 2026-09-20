import { describe, expect, it } from "vitest";
import { defaultEvidenceWindow } from "./finance-evidence-window.js";
import {
  insiderPeriodAgeDays,
  insiderSentimentSignal,
  type InsiderSentimentPeriod,
} from "./finance-insider-signal.js";

const window = defaultEvidenceWindow({ horizonDays: 30 });

/** A period that ends `monthsAgo` months before the observation. */
function recentPeriod(monthsAgo: number, mspr: number): InsiderSentimentPeriod {
  const asOf = new Date("2026-09-20T00:00:00.000Z");
  const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - monthsAgo, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, mspr, change: 1000 };
}

const at = "2026-09-20T00:00:00.000Z";

describe("insiderSentimentSignal", () => {
  it("reads net insider buying as a buy", () => {
    const signal = insiderSentimentSignal(recentPeriod(1, 30), { observedAt: at, window });
    expect(signal.direction).toBe("buy");
    expect(signal.strength).toBeGreaterThan(0);
    expect(signal.confidence).toBeGreaterThan(0);
  });

  it("reads net insider selling as a sell", () => {
    const signal = insiderSentimentSignal(recentPeriod(1, -80), { observedAt: at, window });
    expect(signal.direction).toBe("sell");
  });

  it("falls silent when the reading is older than the window", () => {
    // The real data seen while building this was over a year old. A stale
    // reading looks like evidence and is worse than none.
    const signal = insiderSentimentSignal(recentPeriod(18, -100), { observedAt: at, window });
    expect(signal.direction).toBe("hold");
    expect(signal.confidence).toBe(0);
    expect(signal.ref).toContain("older than");
  });

  it("falls silent inside the deadband rather than voting on noise", () => {
    const signal = insiderSentimentSignal(recentPeriod(1, 2), { observedAt: at, window });
    expect(signal.direction).toBe("hold");
    expect(signal.ref).toContain("deadband");
  });

  it("refuses an undated period instead of assuming it is fresh", () => {
    const signal = insiderSentimentSignal(
      { year: Number.NaN, month: 3, mspr: 50, change: 1 },
      { observedAt: at, window },
    );
    expect(signal.direction).toBe("hold");
    expect(signal.ref).toContain("could not be dated");
  });

  it("keeps confidence middling because insiders sell for many reasons", () => {
    // Even a full -100 must not sound like conviction.
    const signal = insiderSentimentSignal(recentPeriod(1, -100), { observedAt: at, window });
    expect(signal.confidence).toBeLessThanOrEqual(0.4);
  });

  it("caps strength so one extreme month cannot dominate", () => {
    const signal = insiderSentimentSignal(recentPeriod(1, 100), { observedAt: at, window });
    expect(signal.strength).toBeLessThanOrEqual(1);
  });
});

describe("insiderPeriodAgeDays", () => {
  it("measures from the end of the described month", () => {
    // A period describing 2026-08 ends 2026-09-01.
    const age = insiderPeriodAgeDays(
      { year: 2026, month: 8, mspr: 0, change: 0 },
      Date.parse("2026-09-21T00:00:00.000Z"),
    );
    expect(age).toBeCloseTo(20, 0);
  });

  it("returns null for an impossible month rather than guessing", () => {
    const asOf = Date.parse("2026-09-21T00:00:00.000Z");
    expect(insiderPeriodAgeDays({ year: 2026, month: 13, mspr: 0, change: 0 }, asOf)).toBeNull();
    expect(insiderPeriodAgeDays({ year: 2026, month: 0, mspr: 0, change: 0 }, asOf)).toBeNull();
  });
});
