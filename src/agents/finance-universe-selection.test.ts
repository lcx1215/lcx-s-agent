import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNIVERSE_THRESHOLDS,
  correlation,
  filterUniverseAssets,
  logReturnSeries,
  rankByDollarVolume,
  selectDiversifiedUniverse,
  summariseUniverseSeries,
  universeRejectionReason,
  type UniverseAsset,
} from "./finance-universe-selection.js";

function asset(overrides: Partial<UniverseAsset> & { symbol: string }): UniverseAsset {
  return {
    name: "Some Fund ETF",
    exchange: "NASDAQ",
    tradable: true,
    status: "active",
    ...overrides,
  };
}

describe("filterUniverseAssets", () => {
  it("keeps a plain, tradable fund", () => {
    const kept = filterUniverseAssets([asset({ symbol: "SPY", name: "SPDR S&P 500 ETF Trust" })]);
    expect(kept.map((a) => a.symbol)).toEqual(["SPY"]);
  });

  it("drops OTC listings", () => {
    expect(filterUniverseAssets([asset({ symbol: "ABCD", exchange: "OTC" })])).toHaveLength(0);
  });

  it("drops anything the venue says is not tradable", () => {
    expect(filterUniverseAssets([asset({ symbol: "SPY", tradable: false })])).toHaveLength(0);
  });

  it("drops leveraged products", () => {
    expect(
      filterUniverseAssets([asset({ symbol: "TQQQ", name: "ProShares UltraPro QQQ 3X" })]),
    ).toHaveLength(0);
  });

  it("drops volatility products", () => {
    expect(
      filterUniverseAssets([
        asset({ symbol: "VIXY", name: "ProShares VIX Short-Term Futures ETF" }),
      ]),
    ).toHaveLength(0);
  });

  it("drops inverse products", () => {
    // Observed failure: RWM reached a draft universe because "Short" alone was not matched.
    expect(
      filterUniverseAssets([asset({ symbol: "RWM", name: "ProShares Short Russell2000" })]),
    ).toHaveLength(0);
  });

  it("keeps short-DURATION bond funds when excluding inverse products", () => {
    // The guard against over-matching: "Short" here means maturity, not direction.
    expect(
      filterUniverseAssets([asset({ symbol: "SHV", name: "iShares Short Treasury Bond ETF" })]).map(
        (a) => a.symbol,
      ),
    ).toEqual(["SHV"]);
  });

  it("drops foreign single stocks whose name contains American Depositary Shares", () => {
    // Observed failure: ADRs entered the pool because the fund hint matched a bare "Shares".
    expect(
      filterUniverseAssets([
        asset({ symbol: "EQNR", name: "Equinor ASA American Depositary Shares" }),
      ]),
    ).toHaveLength(0);
  });
});

describe("rankByDollarVolume", () => {
  it("ranks by close times volume and drops unusable rows", () => {
    const ranked = rankByDollarVolume({
      A: { close: 10, volume: 100 },
      B: { close: 100, volume: 50 },
      C: { close: 0, volume: 999 },
      D: { close: 10 },
    });
    expect(ranked.map((entry) => entry.symbol)).toEqual(["B", "A"]);
    expect(ranked[0]?.dollarVolume).toBe(5000);
  });
});

describe("summariseUniverseSeries", () => {
  const flat = (n: number, price = 100): { date: string; close: number; volume?: number }[] =>
    Array.from({ length: n }, (_, index) => ({
      date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
      close: price,
      volume: 1000,
    }));

  it("counts implausible daily moves without letting them set the volatility", () => {
    // Observed: XLU halved in one bar (87.42 -> 43.30), which doubled its measured volatility
    // and would have halved its inverse-volatility weight.
    const bars = [...flat(400), { date: "2026-02-01", close: 50, volume: 1000 }, ...flat(400)];
    const metrics = summariseUniverseSeries("XLU", bars);
    expect(metrics.outlierCount).toBe(1);
    expect(metrics.annualisedVol).toBeLessThan(0.01);
  });

  it("reports zero outliers for a clean series", () => {
    const closes = Array.from({ length: 300 }, (_, index) => 100 + (index % 7));
    const bars = closes.map((close, index) => ({
      date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
      close,
      volume: 500,
    }));
    expect(summariseUniverseSeries("SPY", bars).outlierCount).toBe(0);
  });

  it("reports the largest calendar gap so spliced history cannot hide", () => {
    const early = Array.from({ length: 30 }, (_, index) => ({
      date: `2022-09-${String(index + 1).padStart(2, "0")}`,
      close: 25,
      volume: 100,
    }));
    const late = Array.from({ length: 30 }, (_, index) => ({
      date: `2024-02-${String(index + 1).padStart(2, "0")}`,
      close: 30,
      volume: 100,
    }));
    // Bar count alone would not catch this: 60 bars of "history" spanning two unrelated series.
    expect(summariseUniverseSeries("IBIT", [...early, ...late]).maxGapDays).toBeGreaterThan(400);
  });
});

describe("universeRejectionReason", () => {
  const base = {
    symbol: "X",
    bars: 1200,
    firstDate: "2020-01-01",
    lastDate: "2026-01-01",
    medianDollarVolume: 5_000_000,
    annualisedVol: 0.2,
    outlierCount: 0,
    maxGapDays: 4,
  };

  it("accepts a measurable, liquid candidate", () => {
    expect(universeRejectionReason(base)).toBe("");
  });

  it("rejects a series containing an implausible move", () => {
    expect(universeRejectionReason({ ...base, outlierCount: 1 })).toContain("implausible");
  });

  it("rejects a spliced series with a huge calendar gap", () => {
    // Observed: IBIT carried 92 bars of another security's history before its real 2024-01-11
    // listing, leaving a 260-day gap, and passed every other check with them.
    expect(universeRejectionReason({ ...base, maxGapDays: 260 })).toContain("spliced");
  });

  it("accepts a normal long weekend gap", () => {
    expect(universeRejectionReason({ ...base, maxGapDays: 4 })).toBe("");
  });

  it("rejects short history before looking at anything else", () => {
    expect(universeRejectionReason({ ...base, bars: 100 })).toContain("history too short");
  });

  it("rejects unliquid candidates", () => {
    expect(
      universeRejectionReason({ ...base, medianDollarVolume: 1000 }, DEFAULT_UNIVERSE_THRESHOLDS),
    ).toContain("too illiquid");
  });
});

describe("correlation and diversification", () => {
  it("recovers a known correlation", () => {
    const up = Array.from({ length: 200 }, (_, index) => index * 0.001);
    const same = [...up];
    const down = [...up].toReversed();
    expect(correlation(up, same)).toBeCloseTo(1, 6);
    expect(correlation(up, down)).toBeCloseTo(-1, 6);
  });

  it("prefers the candidate least related to what is already chosen", () => {
    const base = Array.from({ length: 200 }, (_, index) => Math.sin(index / 9) * 0.01);
    const twin = [...base];
    const unrelated = Array.from({ length: 200 }, (_, index) => Math.cos(index / 3) * 0.02);
    const chosen = selectDiversifiedUniverse(
      [
        { symbol: "BASE", returns: logReturnSeries(base.map((v) => 100 * Math.exp(v))) },
        { symbol: "TWIN", returns: logReturnSeries(twin.map((v) => 100 * Math.exp(v))) },
        { symbol: "OTHER", returns: logReturnSeries(unrelated.map((v) => 100 * Math.exp(v))) },
      ],
      { target: 2 },
    );
    expect(chosen).toEqual(["BASE", "OTHER"]);
  });

  it("returns empty when nothing is measurable", () => {
    expect(selectDiversifiedUniverse([{ symbol: "X", returns: [] }], { target: 3 })).toEqual([]);
  });
});

/**
 * An incoherent `maxCorrelation` silently removed the diversification constraint this function exists
 * to apply. Measured with 7 near-duplicates of one series among 8 candidates: the default 0.95
 * returned 2 symbols, while `maxCorrelation: 5` and `Number.NaN` both returned all 8 -- padded with
 * exactly the near-duplicates the cap is there to exclude.
 *
 * Selecting nothing is the same outcome the module already documents for "nothing fits", and it is
 * the fail-closed one for a selector. Clamping is deliberately not used: it would honour part of a
 * contradictory request and still return a padded set.
 */
describe("an incoherent selection configuration selects nothing", () => {
  const base = Array.from({ length: 40 }, (_, index) => Math.sin(index / 3) * 0.01);
  const independent = Array.from({ length: 40 }, (_, index) => Math.cos(index / 7) * 0.02);
  const nearDuplicates = ["B", "C", "D", "E", "F", "G"].map((symbol, offset) => ({
    symbol,
    returns: base.map((value, index) => value + (index % (offset + 2) ? 1e-6 : -1e-6)),
  }));
  const candidates = [
    { symbol: "A", returns: base },
    ...nearDuplicates,
    { symbol: "H", returns: independent },
  ];

  it("still applies the cap with the default configuration", () => {
    // A and H are the only pair the default 0.95 admits.
    expect(selectDiversifiedUniverse(candidates, { target: 8 })).toEqual(["A", "H"]);
  });

  it("refuses a correlation cap outside [-1, 1] instead of padding the set", () => {
    for (const maxCorrelation of [5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(selectDiversifiedUniverse(candidates, { target: 8, maxCorrelation })).toEqual([]);
    }
  });

  it("refuses a target that is not a usable count", () => {
    for (const target of [Number.NaN, 0, -5]) {
      expect(selectDiversifiedUniverse(candidates, { target })).toEqual([]);
    }
  });

  it("still honours the coherent bounds", () => {
    // A cap of exactly 1 admits every pair, so the set fills: coherent, just not selective.
    expect(selectDiversifiedUniverse(candidates, { target: 8, maxCorrelation: 1 })).toHaveLength(8);
    expect(selectDiversifiedUniverse(candidates, { target: 8, maxCorrelation: 0.9 })).toEqual([
      "A",
      "H",
    ]);
    // -1 admits nothing beyond the seed, which is the documented "returned shorter" behaviour.
    expect(selectDiversifiedUniverse(candidates, { target: 8, maxCorrelation: -1 })).toEqual(["A"]);
  });
});
