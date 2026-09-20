import { describe, expect, it } from "vitest";
import { defaultEvidenceWindow } from "./finance-evidence-window.js";
import {
  insiderFlowSignal,
  insiderPeriodAgeDays,
  insiderSentimentSignal,
  type InsiderSentimentPeriod,
  type InsiderTransaction,
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

describe("insiderFlowSignal", () => {
  const tx = (daysAgo: number, change: number, code?: string): InsiderTransaction => ({
    transactionDate: new Date(Date.parse(at) - daysAgo * 86_400_000).toISOString().slice(0, 10),
    change,
    ...(code !== undefined ? { transactionCode: code } : {}),
  });

  it("reads open-market buying as a buy", () => {
    const signal = insiderFlowSignal([tx(10, 5000, "P"), tx(20, 3000, "P")], {
      observedAt: at,
      window,
    });
    expect(signal.direction).toBe("buy");
    expect(signal.strength).toBeCloseTo(1, 6);
  });

  it("reads open-market selling as a sell", () => {
    const signal = insiderFlowSignal([tx(10, -9000, "S"), tx(20, 1000, "P")], {
      observedAt: at,
      window,
    });
    expect(signal.direction).toBe("sell");
  });

  it("ignores grants and gifts, which are compensation not conviction", () => {
    // A large award would otherwise read as massive insider demand.
    const signal = insiderFlowSignal([tx(10, 500000, "G"), tx(12, 400000, "A")], {
      observedAt: at,
      window,
    });
    expect(signal.direction).toBe("hold");
    expect(signal.ref).toContain("no open-market");
  });

  it("drops transactions outside the window rather than counting them", () => {
    const signal = insiderFlowSignal([tx(400, -90000, "S"), tx(500, -90000, "S")], {
      observedAt: at,
      window,
    });
    expect(signal.direction).toBe("hold");
  });

  it("is scale free: the same buy/sell mix reads the same at any size", () => {
    const small = insiderFlowSignal([tx(5, 300, "P"), tx(6, -100, "S")], {
      observedAt: at,
      window,
    });
    const large = insiderFlowSignal([tx(5, 300000, "P"), tx(6, -100000, "S")], {
      observedAt: at,
      window,
    });
    if (small.direction !== "hold" && large.direction !== "hold") {
      expect(large.strength).toBeCloseTo(small.strength, 6);
      expect(large.direction).toBe(small.direction);
    }
  });

  it("stays silent when the mix is inside the deadband", () => {
    const signal = insiderFlowSignal([tx(5, 1000, "P"), tx(6, -950, "S")], {
      observedAt: at,
      window,
    });
    expect(signal.direction).toBe("hold");
    expect(signal.ref).toContain("deadband");
  });

  it("trusts a thicker set of transactions more than a single filing", () => {
    const one = insiderFlowSignal([tx(5, -5000, "S")], { observedAt: at, window });
    const many = insiderFlowSignal(
      [
        tx(5, -5000, "S"),
        tx(6, -4000, "S"),
        tx(7, -3000, "S"),
        tx(8, -2000, "S"),
        tx(9, -1000, "S"),
      ],
      { observedAt: at, window },
    );
    expect(many.confidence).toBeGreaterThan(one.confidence);
  });

  it("covers a lagged monthly series by preferring current filings", () => {
    // The monthly ratio for this name was ~11 months stale; these are weeks old.
    const signal = insiderFlowSignal([tx(15, -20000, "S"), tx(25, -10000, "S")], {
      observedAt: at,
      window,
    });
    expect(signal.direction).toBe("sell");
  });
});

/**
 * The two tunables are caller-supplied and were unvalidated, so a degenerate one manufactured a vote
 * instead of withholding one -- the same construction, and the same defect, as
 * `finance-fundamental-signal.ts`.
 *
 * Measured before the fix: `deadbandMspr: -5` made `mspr > deadband` hold for a small *negative*
 * mspr, so a mild sell tilt was reported as a buy; `baseConfidence: 5` and `-1` emitted weights of 5
 * and -1. Silence rather than a clamp: a clamp would honour part of a contradictory request and still
 * vote.
 */
describe("an incoherent configuration withholds a vote instead of manufacturing one", () => {
  const signalWith = (options: Parameters<typeof insiderSentimentSignal>[1]) =>
    insiderSentimentSignal(recentPeriod(1, -2), options);

  it("refuses a negative deadband, which would report a mild sell tilt as a buy", () => {
    const signal = signalWith({ observedAt: at, window, deadbandMspr: -5 });
    expect(signal.direction).toBe("hold");
    expect(signal.confidence).toBe(0);
  });

  it("refuses a confidence weight outside [0, 1]", () => {
    for (const baseConfidence of [5, -1, Number.NaN]) {
      const signal = insiderSentimentSignal(recentPeriod(1, 30), {
        observedAt: at,
        window,
        baseConfidence,
      });
      expect(signal.direction).toBe("hold");
      expect(signal.confidence).toBe(0);
    }
  });

  it("still honours every coherent configuration", () => {
    const buy = insiderSentimentSignal(recentPeriod(1, 30), {
      observedAt: at,
      window,
      baseConfidence: 0.2,
    });
    expect(buy.direction).toBe("buy");
    expect(buy.confidence).toBeCloseTo(0.2, 10);
    expect(
      insiderSentimentSignal(recentPeriod(1, 2), { observedAt: at, window, deadbandMspr: 1 })
        .direction,
    ).toBe("buy");
  });
});
