import { describe, expect, it } from "vitest";
import { __test as allMethods } from "../../scripts/operator/finance-strategy-all-methods.ts";
import {
  __test,
  buildStressVariants,
} from "../../scripts/operator/finance-strategy-method-benchmark.ts";

describe("finance strategy method benchmark math", () => {
  it("does not use the same close for the decision and return", () => {
    const dates = Array.from(
      { length: 24 },
      (_, index) => `2026-01-${String(index + 1).padStart(2, "0")}`,
    );
    const rowsBySymbol = Object.fromEntries(
      ["SPY", "QQQ", "IWM"].map((symbol) => [
        symbol,
        dates.map((date, index) => ({
          date,
          close: 100 + index,
          sourceTimestamp: `${date}T13:30:00.000Z`,
        })),
      ]),
    );
    const evaluated = __test.evaluateSeries(
      "SPY",
      rowsBySymbol,
      dates,
      20,
      1,
      0.0015,
      "trend_breadth_gate",
    );
    expect(evaluated.positions.slice(0, 21).every((position) => position === 0)).toBe(true);
    expect(evaluated.positions[21]).toBe(1);
    expect(evaluated.metric.observations).toBe(23);
  });

  it("freezes a full cost, lookback, and breadth stress matrix", () => {
    const variants = buildStressVariants();
    expect(variants).toHaveLength(48);
    expect(new Set(variants.map((variant) => JSON.stringify(variant))).size).toBe(48);
    expect(variants[0]).toEqual({ lookback: 100, costBps: 0, breadth: 0.4 });
    expect(variants.at(-1)).toEqual({ lookback: 250, costBps: 60, breadth: 0.6 });
    expect(Object.isFrozen(variants)).toBe(true);
    expect(Object.isFrozen(variants[0])).toBe(true);
  });

  it("requires three distinct instruments after symbol deduplication", () => {
    expect(() => __test.parseOptions(["--symbols", "AAPL,AAPL,MSFT"])).toThrow(
      "at least three instruments",
    );
    expect(__test.parseOptions(["--symbols", "AAPL,AAPL,MSFT,QQQ"]).symbols).toEqual([
      "AAPL",
      "MSFT",
      "QQQ",
    ]);
  });

  it("includes forced liquidation in turnover", () => {
    const dates = ["2026-01-01", "2026-01-02", "2026-01-03"];
    const rowsBySymbol = Object.fromEntries(
      ["SPY", "QQQ", "IWM"].map((symbol) => [
        symbol,
        dates.map((date, index) => ({
          date,
          close: 100 + index,
          sourceTimestamp: `${date}T13:30:00.000Z`,
        })),
      ]),
    );
    const evaluated = __test.evaluateSeries("SPY", rowsBySymbol, dates, 20, 1, 0.0015, "buy_hold");
    expect(evaluated.metric.turnover).toBe(2);
  });
});

describe("strategy receipt evidence boundaries", () => {
  it("does not default to overwriting a dated receipt and rejects incomplete output options", () => {
    expect(allMethods.parseOutputPath([])).toBeUndefined();
    expect(allMethods.parseOutputPath(["--out", "./receipt.json"])).toMatch(/receipt\.json$/u);
    for (const args of [["--out"], ["--out", "--json"], ["--unknown"]]) {
      expect(() => allMethods.parseOutputPath(args)).toThrow("Usage:");
    }
  });
  it("keeps empty, failed and malformed source groups unready", () => {
    expect(allMethods.sourceGroupReady({})).toBe(false);
    expect(allMethods.sourceGroupReady({ feed: null })).toBe(false);
    expect(allMethods.sourceGroupReady({ feed: { http_status: 403 } })).toBe(false);
    expect(allMethods.sourceGroupReady({ a: { http_status: 200 }, b: { http_status: 503 } })).toBe(
      false,
    );
    expect(
      allMethods.sourceGroupReady({ a: { http_status: 200 }, b: { http_status: "200" } }),
    ).toBe(true);
  });
  it("does not stringify invalid source metadata into credible receipt labels", () => {
    for (const value of [{ gate_status: "ready" }, null, undefined, 200, " "]) {
      expect(() => allMethods.requiredText(value, "source.stage")).toThrow("non-empty string");
    }
    expect(allMethods.requiredText("research_only", "source.stage")).toBe("research_only");
  });
});
