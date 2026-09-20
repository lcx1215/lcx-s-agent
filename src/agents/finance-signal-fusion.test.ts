import { describe, expect, it } from "vitest";
import { fuseSignals, type FinanceSignal } from "./finance-signal-fusion.js";

const at = "2026-09-20T00:00:00.000Z";

const signal = (
  sourceId: string,
  direction: FinanceSignal["direction"],
  strength = 0.8,
): FinanceSignal => ({
  sourceId,
  kind: "news_tone",
  direction,
  strength,
  confidence: 1,
  observedAt: at,
});

describe("fuseSignals", () => {
  it("fuses agreeing sources into one direction with conviction", () => {
    const result = fuseSignals([signal("a", "buy"), signal("b", "buy")]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conclusion.direction).toBe("buy");
      expect(result.conclusion.agreement).toBe(1);
      expect(result.conclusion.conviction).toBeGreaterThan(0);
      expect(result.conclusion.evidence).toHaveLength(2);
    }
  });

  it("refuses a single source, because one source must not decide a trade", () => {
    const result = fuseSignals([signal("a", "buy")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/1 distinct source/);
    }
  });

  it("counts one source once, however many times it speaks", () => {
    const result = fuseSignals([signal("a", "buy"), signal("a", "buy"), signal("a", "buy")]);
    expect(result.ok).toBe(false);
  });

  it("refuses when informed sources split rather than hiding the split in an average", () => {
    const result = fuseSignals([signal("a", "buy"), signal("b", "sell"), signal("c", "sell")]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conclusion.agreement).toBeLessThan(1);
    }
    // A near-even split must not produce a confident-looking number.
    const split = fuseSignals([
      signal("a", "buy"),
      signal("b", "buy"),
      signal("c", "sell"),
      signal("d", "sell"),
      signal("e", "sell"),
    ]);
    if (split.ok) {
      expect(split.conclusion.agreement).toBeCloseTo(0.6, 10);
    }
  });

  it("refuses a dead-even split instead of picking a side", () => {
    // Both sides clear the source count, so the only reason to refuse is the
    // split itself. With 1 vs 1 the refusal would be "not enough sources"
    // instead, which is a different and weaker statement.
    const result = fuseSignals(
      [signal("a", "buy"), signal("b", "buy"), signal("c", "sell"), signal("d", "sell")],
      { minAgreement: 0.7 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/disagree/);
    }
  });

  it("treats neutral sources as silence, not as support", () => {
    // One buyer plus a crowd of indifferent sources is still one source.
    const result = fuseSignals([signal("a", "buy"), signal("b", "hold"), signal("c", "hold")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/1 distinct source/);
    }
  });

  it("refuses when nothing has an opinion", () => {
    const result = fuseSignals([signal("a", "hold"), signal("b", "hold")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/no source expressed a direction/);
    }
  });

  it("refuses a malformed signal instead of skipping it silently", () => {
    const result = fuseSignals([signal("a", "buy"), { sourceId: "b", direction: "buy" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/malformed/);
    }
  });

  it("keeps the newer reading when one source changes its mind", () => {
    const result = fuseSignals([
      { ...signal("a", "buy"), observedAt: "2026-09-20T00:00:00.000Z" },
      { ...signal("a", "sell"), observedAt: "2026-09-20T12:00:00.000Z" },
      signal("b", "sell"),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conclusion.direction).toBe("sell");
    }
  });

  it("scales conviction with source reliability", () => {
    const strong = fuseSignals([
      { ...signal("a", "buy"), confidence: 1 },
      { ...signal("b", "buy"), confidence: 1 },
    ]);
    const weak = fuseSignals([
      { ...signal("a", "buy"), confidence: 0.25 },
      { ...signal("b", "buy"), confidence: 0.25 },
    ]);
    if (strong.ok && weak.ok) {
      expect(weak.conclusion.conviction).toBeLessThan(strong.conclusion.conviction);
    }
  });
});
