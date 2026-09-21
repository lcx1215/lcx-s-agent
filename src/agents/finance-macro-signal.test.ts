import { describe, expect, it } from "vitest";
import {
  MACRO_ROUTES,
  macroRouteFor,
  macroTrendSignal,
  type MacroObservation,
} from "./finance-macro-signal.js";

const OBSERVED_AT = "2026-09-21T14:00:00.000Z";

function series(values: readonly number[]): MacroObservation[] {
  return values.map((value, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    value,
  }));
}

describe("macroTrendSignal", () => {
  it("reads a falling yield as bullish for long duration", () => {
    const signal = macroTrendSignal({
      route: MACRO_ROUTES.TLT,
      observations: series([5.0, 4.9]),
      observedAt: OBSERVED_AT,
    });
    expect(signal?.direction).toBe("buy");
  });

  it("reads a rising yield as bearish for long duration", () => {
    const signal = macroTrendSignal({
      route: MACRO_ROUTES.TLT,
      observations: series([4.9, 5.1]),
      observedAt: OBSERVED_AT,
    });
    expect(signal?.direction).toBe("sell");
  });

  it("reads a rising series as bullish under direct polarity", () => {
    // Crude for a commodity basket: the basket follows it, it does not move against it.
    const signal = macroTrendSignal({
      route: MACRO_ROUTES.DBC,
      observations: series([100, 105]),
      observedAt: OBSERVED_AT,
    });
    expect(signal?.direction).toBe("buy");
  });

  it("has no opinion when the series has not moved", () => {
    // The point of the threshold: a source that calls every wobble a direction is an eager second
    // vote, not evidence. Reporting nothing is the honest answer and fusion counts it as neither
    // for nor against.
    const signal = macroTrendSignal({
      route: MACRO_ROUTES.TLT,
      observations: series([5.0, 5.001]),
      observedAt: OBSERVED_AT,
    });
    expect(signal).toBeUndefined();
  });

  it("has no opinion when it cannot see two usable points", () => {
    expect(
      macroTrendSignal({ route: MACRO_ROUTES.TLT, observations: [], observedAt: OBSERVED_AT }),
    ).toBeUndefined();
    expect(
      macroTrendSignal({
        route: MACRO_ROUTES.TLT,
        observations: series([5.0]),
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();
    // A gap in the series is not a number, and inventing one would be the failure this whole
    // source exists to avoid.
    expect(
      macroTrendSignal({
        route: MACRO_ROUTES.TLT,
        observations: [
          { date: "2026-01-01", value: Number.NaN },
          { date: "2026-01-02", value: 5.0 },
        ],
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();
  });

  it("scales strength with the size of the move and never past the route ceiling", () => {
    const small = macroTrendSignal({
      route: MACRO_ROUTES.TLT,
      observations: series([5.0, 4.95]),
      observedAt: OBSERVED_AT,
    });
    const large = macroTrendSignal({
      route: MACRO_ROUTES.TLT,
      observations: series([5.0, 4.5]),
      observedAt: OBSERVED_AT,
    });
    expect(small?.strength).toBeLessThan(large?.strength ?? 0);
    expect(large?.strength).toBe(1);
    // Confidence is about the relationship, not today, so it is the ceiling on both.
    expect(small?.confidence).toBe(MACRO_ROUTES.TLT.maxConfidence);
    expect(large?.confidence).toBe(MACRO_ROUTES.TLT.maxConfidence);
  });

  it("does not claim the strong relationships are as strong as the weak ones", () => {
    // Long duration versus its own yield is an identity; a credit spread standing in for equity
    // risk appetite is a proxy. Treating them as equally trustworthy would be the overclaim that
    // made the old sampler refuse everything rather than guess.
    expect(MACRO_ROUTES.TLT.maxConfidence).toBeGreaterThan(MACRO_ROUTES.SPY.maxConfidence);
  });

  it("carries the series in its provenance so fusion can count sources", () => {
    const signal = macroTrendSignal({
      route: MACRO_ROUTES.SPY,
      observations: series([2.76, 2.7]),
      observedAt: OBSERVED_AT,
    });
    expect(signal?.sourceId).toBe("fred:BAMLH0A0HYM2");
    expect(signal?.kind).toBe("macro");
  });
});

describe("macroRouteFor", () => {
  it("has a route for every instrument the active rule trades", () => {
    // The reason this module exists: without one, an ETF still has no analyst target, still cannot
    // reach two sources, and is still sampled as a refusal forever.
    for (const instrument of ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "GLD", "DBC"]) {
      expect(macroRouteFor(instrument), instrument).toBeDefined();
    }
  });

  it("has no route for an instrument no relationship has been argued for", () => {
    // Not a plausible neighbour: no route means no macro source, not a borrowed one.
    expect(macroRouteFor("AAPL")).toBeUndefined();
  });
});
