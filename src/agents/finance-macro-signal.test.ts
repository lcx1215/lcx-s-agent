import { describe, expect, it } from "vitest";
import {
  MACRO_ROUTES,
  fetchPublicFredMacroSeries,
  macroRouteFor,
  macroTrendSignal,
  parseFredMacroCsv,
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

/**
 * The keyless transport.
 *
 * A route being defined was not the same fact as the series being reachable: `FRED_API_KEY` is
 * absent here, so `defaultMacroFor` returned `undefined` and the sampler skipped the leg -- silently,
 * because the code said the absence was not a failure. FRED serves these series without a key, over
 * the same public endpoint the repo already reads for index history, so the transport below is what
 * "the loop is closed" actually depends on.
 */
describe("the public FRED CSV is read into observations", () => {
  const asOf = "2026-09-19";

  function csv(seriesId: string, rows: readonly string[]): string {
    return [`observation_date,${seriesId}`, ...rows].join("\n");
  }

  it("reads a dated value into an observation", () => {
    expect(parseFredMacroCsv(csv("DGS10", ["2026-09-17,4.94", "2026-09-18,4.9"]), "DGS10")).toEqual(
      [
        { date: "2026-09-17", value: 4.94 },
        { date: "2026-09-18", value: 4.9 },
      ],
    );
  });

  /**
   * FRED writes '.' for a missing observation. Dropping it is right; reading it as zero would make
   * a fall look like a collapse and hand the sampler a direction that did not happen.
   */
  it("drops a missing observation instead of reading it as zero", () => {
    expect(parseFredMacroCsv(csv("DGS10", ["2026-09-17,4.94", "2026-09-18,."]), "DGS10")).toEqual([
      { date: "2026-09-17", value: 4.94 },
    ]);
  });

  it("rejects a response that is not this series", () => {
    // The header names the series; a different one means the URL asked for something else.
    expect(() => parseFredMacroCsv(csv("DFII10", ["2026-09-17,2.1"]), "DGS10")).toThrow(/schema/u);
  });

  it("rejects a value that is not a number", () => {
    expect(() => parseFredMacroCsv(csv("DGS10", ["2026-09-17,not-a-number"]), "DGS10")).toThrow(
      /observation/u,
    );
  });

  it("asks the public endpoint for the series, bounded to a window", async () => {
    const seen: string[] = [];
    const observations = await fetchPublicFredMacroSeries("DGS10", {
      asOf,
      windowDays: 30,
      fetchText: async (url) => {
        seen.push(url);
        return csv("DGS10", ["2026-09-17,4.94"]);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("fred.stlouisfed.org/graph/fredgraph.csv");
    expect(seen[0]).toContain("id=DGS10");
    expect(seen[0]).toContain("coed=2026-09-19");
    expect(seen[0]).toContain("cosd=2026-08-20");
    expect(observations).toEqual([{ date: "2026-09-17", value: 4.94 }]);
  });

  it("feeds a route end to end: a real series produces a signal", async () => {
    const route = macroRouteFor("TLT");
    expect(route).toBeDefined();
    const observations = await fetchPublicFredMacroSeries(route!.seriesId, {
      asOf,
      fetchText: async () => csv(route!.seriesId, ["2026-08-17,4.60", "2026-09-17,4.30"]),
    });
    const signal = macroTrendSignal({ route: route!, observations, observedAt: asOf });
    // Yields fell over the window, and the route is inverse, so this is bullish.
    expect(signal?.direction).toBe("buy");
    expect(signal?.sourceId).toBe(`fred:${route!.seriesId}`);
  });
});
