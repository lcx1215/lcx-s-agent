import { describe, expect, it } from "vitest";
import { analystTargetSignal, type AnalystTargetSummary } from "./finance-fundamental-signal.js";

const at = "2026-09-20T00:00:00.000Z";
const summary = (target: number, count: number): AnalystTargetSummary => ({
  currentPrice: 100,
  avgTarget: target,
  analystCount: count,
  window: "lastMonth",
});

describe("analystTargetSignal", () => {
  it("votes buy when the target sits meaningfully above the price", () => {
    const signal = analystTargetSignal(summary(115, 10), { observedAt: at });
    expect(signal.direction).toBe("buy");
    expect(signal.strength).toBeGreaterThan(0);
    expect(signal.confidence).toBeGreaterThan(0);
  });

  it("votes sell when the target sits below", () => {
    const signal = analystTargetSignal(summary(85, 10), { observedAt: at });
    expect(signal.direction).toBe("sell");
  });

  it("stays silent inside the deadband rather than voting on noise", () => {
    // 101 against a price of 100 is 1% - inside the 3% deadband.
    const signal = analystTargetSignal(summary(101, 10), { observedAt: at });
    expect(signal.direction).toBe("hold");
    expect(signal.strength).toBe(0);
    expect(signal.confidence).toBe(0);
  });

  it("trusts a target more when more analysts stand behind it", () => {
    const thin = analystTargetSignal(summary(120, 2), { observedAt: at });
    const broad = analystTargetSignal(summary(120, 30), { observedAt: at });
    expect(broad.confidence).toBeGreaterThan(thin.confidence);
  });

  it("keeps confidence below the technical signal's, because targets skew optimistic", () => {
    const signal = analystTargetSignal(summary(200, 50), { observedAt: at });
    // Even a huge, widely held target must not sound certain.
    expect(signal.confidence).toBeLessThanOrEqual(0.45);
  });

  it("caps strength so one wild target cannot dominate", () => {
    const signal = analystTargetSignal(summary(1000, 50), { observedAt: at });
    expect(signal.strength).toBeLessThanOrEqual(1);
  });

  it("refuses an unusable price instead of dividing by it", () => {
    const signal = analystTargetSignal(
      { currentPrice: 0, avgTarget: 120, analystCount: 10, window: "lastMonth" },
      { observedAt: at },
    );
    expect(signal.direction).toBe("hold");
  });

  it("shares one sourceId so two FMP fields cannot fake a majority", () => {
    const a = analystTargetSignal(summary(115, 10), { observedAt: at });
    const b = analystTargetSignal(
      { currentPrice: 100, avgTarget: 118, analystCount: 12, window: "lastQuarter" },
      { observedAt: at },
    );
    expect(a.sourceId).toBe(b.sourceId);
  });

  it("stays silent when no analyst is known to stand behind the target", () => {
    // Coverage of zero used to floor at half confidence: a modest-sounding
    // number derived from nobody.
    for (const count of [0, Number.NaN]) {
      const signal = analystTargetSignal(summary(120, count), { observedAt: at });
      expect(signal.direction).toBe("hold");
      expect(signal.confidence).toBe(0);
    }
  });

  it("does not emit a NaN confidence that would poison downstream conviction", () => {
    const signal = analystTargetSignal(summary(120, Number.NaN), { observedAt: at });
    expect(Number.isFinite(signal.confidence)).toBe(true);
  });
});

/**
 * The three tunables are caller-supplied and were unvalidated, so a degenerate one manufactured a
 * vote instead of withholding one. Measured before the fix:
 *
 *   fullCredibilityCount: -10, 100 analysts  -> confidence = -2.025
 *   deadbandFraction: -0.03, target 2% BELOW  -> direction = "buy"   (both comparisons hold, first wins)
 *   maxConfidence: 5                          -> confidence = 5
 *
 * An incoherent configuration yields no opinion rather than a clamped one: clamping would honour part
 * of a contradictory request and still vote, which is the "manufactures conviction" failure this
 * module's own deadband exists to avoid.
 */
describe("an incoherent configuration withholds a vote instead of manufacturing one", () => {
  const coherent = (options: Parameters<typeof analystTargetSignal>[1]) =>
    analystTargetSignal(summary(115, 10), options);

  it("refuses a negative credibility count instead of emitting a negative confidence", () => {
    const signal = analystTargetSignal(summary(120, 100), {
      observedAt: at,
      fullCredibilityCount: -10,
    });
    expect(signal.direction).toBe("hold");
    expect(signal.confidence).toBe(0);
    expect(signal.ref).toContain("config=incoherent");
  });

  it("refuses a zero credibility count, which would silently drop the coverage weighting", () => {
    expect(coherent({ observedAt: at, fullCredibilityCount: 0 }).direction).toBe("hold");
  });

  it("refuses a negative deadband, which would turn a small drop into a buy", () => {
    const signal = analystTargetSignal(summary(98, 10), {
      observedAt: at,
      deadbandFraction: -0.03,
    });
    expect(signal.direction).toBe("hold");
  });

  it("refuses a confidence ceiling outside [0, 1]", () => {
    expect(coherent({ observedAt: at, maxConfidence: 5 }).confidence).toBe(0);
    expect(coherent({ observedAt: at, maxConfidence: -1 }).confidence).toBe(0);
    expect(coherent({ observedAt: at, maxConfidence: Number.NaN }).confidence).toBe(0);
  });

  it("still honours every coherent configuration", () => {
    expect(coherent({ observedAt: at, maxConfidence: 0.3 }).confidence).toBeCloseTo(0.3, 10);
    expect(coherent({ observedAt: at, deadbandFraction: 0 }).direction).toBe("buy");
    expect(coherent({ observedAt: at, fullCredibilityCount: 3 }).confidence).toBeGreaterThan(0);
  });
});
