import { describe, expect, it } from "vitest";
import { chartStructureSignal, computeChartStructure } from "./finance-chart-structure.js";

/** Rising closes: enough points for a 20/50 structure with room to spare. */
function rising(length = 80, step = 1): number[] {
  return Array.from({ length }, (_unused, index) => 100 + index * step);
}
function falling(length = 80, step = 1): number[] {
  return Array.from({ length }, (_unused, index) => 100 + (length - 1 - index) * step);
}
function flat(length = 80): number[] {
  return Array.from({ length }, () => 100);
}

describe("computeChartStructure", () => {
  it("reads an uptrend from rising prices", () => {
    const structure = computeChartStructure(rising());
    expect(structure).not.toBeNull();
    if (structure) {
      expect(structure.trend).toBe("up");
      expect(structure.momentumPct).toBeGreaterThan(0);
    }
  });

  it("reads a downtrend from falling prices", () => {
    const structure = computeChartStructure(falling());
    if (structure) {
      expect(structure.trend).toBe("down");
      expect(structure.momentumPct).toBeLessThan(0);
    }
  });

  it("refuses to describe structure from too little history", () => {
    // A 50-day average computed from 20 points is not structure, it is arithmetic.
    expect(computeChartStructure(rising(20))).toBeNull();
  });

  it("reports near-zero volatility for a flat series", () => {
    const structure = computeChartStructure(flat());
    if (structure) {
      expect(structure.realizedVolFraction).toBeLessThan(0.001);
    }
  });

  it("measures higher volatility for a choppy series than a smooth one", () => {
    const choppy = Array.from({ length: 80 }, (_unused, i) => 100 + (i % 2 === 0 ? 8 : -8));
    const smooth = rising(80, 0.2);
    const a = computeChartStructure(choppy);
    const b = computeChartStructure(smooth);
    if (a && b) {
      expect(a.realizedVolFraction).toBeGreaterThan(b.realizedVolFraction);
    }
  });
});

describe("chartStructureSignal", () => {
  const at = "2026-09-20T00:00:00.000Z";

  it("votes buy when trend and momentum agree upward", () => {
    const structure = computeChartStructure(rising());
    const signal = chartStructureSignal(structure!, { sourceId: "chart", observedAt: at });
    expect(signal.direction).toBe("buy");
    expect(signal.strength).toBeGreaterThan(0);
    expect(signal.confidence).toBeGreaterThan(0);
  });

  it("votes sell when trend and momentum agree downward", () => {
    const structure = computeChartStructure(falling());
    const signal = chartStructureSignal(structure!, { sourceId: "chart", observedAt: at });
    expect(signal.direction).toBe("sell");
  });

  it("stays silent when there is no structure, rather than voting weakly", () => {
    // Flat series: no trend, no move. Manufacturing an opinion here is how a
    // system ends up trading noise.
    const structure = computeChartStructure(flat());
    const signal = chartStructureSignal(structure!, { sourceId: "chart", observedAt: at });
    expect(signal.direction).toBe("hold");
    expect(signal.strength).toBe(0);
    expect(signal.confidence).toBe(0);
  });

  it("trusts the same trend less when the path is volatile", () => {
    const smoothSignal = chartStructureSignal(computeChartStructure(rising(80, 0.3))!, {
      sourceId: "chart",
      observedAt: at,
    });
    const choppyUp = Array.from(
      { length: 80 },
      (_unused, i) => 100 + i * 0.3 + (i % 2 === 0 ? 6 : -6),
    );
    const choppySignal = chartStructureSignal(computeChartStructure(choppyUp)!, {
      sourceId: "chart",
      observedAt: at,
    });
    expect(choppySignal.confidence).toBeLessThan(smoothSignal.confidence);
  });

  it("caps strength at 1 so a huge move cannot drown out other sources", () => {
    const signal = chartStructureSignal(computeChartStructure(rising(80, 50))!, {
      sourceId: "chart",
      observedAt: at,
    });
    expect(signal.strength).toBeLessThanOrEqual(1);
  });
});
