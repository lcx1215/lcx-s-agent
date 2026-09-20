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
});
