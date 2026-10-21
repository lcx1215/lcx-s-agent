import { describe, expect, it } from "vitest";
import { analyzeFinanceChartBars, normalizeFinanceChartBars } from "./finance-chart-analysis.js";

function bars(count: number) {
  return Array.from({ length: count }, (_unused, index) => {
    const close = 100 + index;
    return {
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      open: close - 1,
      high: close + 1,
      low: close - 2,
      close,
      volume: 1_000 + index * 10,
    };
  });
}

describe("finance chart analysis", () => {
  it.each([
    { label: "boolean", value: true },
    { label: "array", value: [100] },
  ])("does not accept $label values as an OHLC candle", ({ value }) => {
    const normalized = normalizeFinanceChartBars([
      { date: "2026-01-01", open: value, high: value, low: value, close: value },
    ]);
    expect(normalized.bars).toEqual([]);
    expect(normalized.droppedCount).toBe(1);
  });

  it.each([
    { volume: null, expected: undefined },
    { volume: "", expected: undefined },
    { volume: 0, expected: 0 },
    { volume: "0", expected: 0 },
  ])("keeps missing volume distinct from observed zero: $volume", ({ volume, expected }) => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      open: "100",
      high: "101",
      low: "99",
      close: "100",
      volume: index < 20 ? 10 : volume,
    }));
    const normalized = normalizeFinanceChartBars(rows);
    expect(normalized.bars).toHaveLength(40);
    expect(normalized.bars.at(-1)?.volume).toBe(expected === undefined ? undefined : 0);
    expect(analyzeFinanceChartBars("AAPL", normalized.bars).features.recentVolumeRatio).toBe(
      expected,
    );
  });

  it("normalizes, sorts, deduplicates, and drops invalid OHLC rows", () => {
    const normalized = normalizeFinanceChartBars([
      bars(2)[1],
      bars(2)[0],
      { date: "2026-01-03", open: 1, high: 0, low: 1, close: 1 },
      bars(2)[1],
    ]);
    expect(normalized.bars.map((bar) => bar.date)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(normalized.droppedCount).toBe(1);
  });

  it("does not silently stitch overlapping providers into one chart", () => {
    const normalized = normalizeFinanceChartBars([
      { ...bars(1)[0], providerName: "provider-a" },
      { ...bars(1)[0], close: 99, providerName: "provider-b" },
    ]);
    expect(normalized.bars).toHaveLength(1);
    expect(normalized.bars[0]?.close).toBe(100);
    expect(normalized.droppedCount).toBe(1);
  });

  it("rejects conflicting same-date bars instead of depending on input order", () => {
    const normalized = normalizeFinanceChartBars([
      { ...bars(1)[0], providerName: "provider-a" },
      { ...bars(1)[0], open: 101, high: 102, close: 101, providerName: "provider-a" },
    ]);
    expect(normalized.bars).toEqual([]);
    expect(normalized.droppedCount).toBe(2);
  });

  it("preserves the verified local session date without rewriting its source timestamp", () => {
    const normalized = normalizeFinanceChartBars([
      {
        providerName: "futunn-quote-read",
        sourceTimestamp: "2026-10-15T16:00:00Z",
        data: { ...bars(1)[0], date: "2026-10-16", timezoneOffsetMinutes: 480 },
      },
    ]);
    expect(normalized.bars[0]).toMatchObject({
      date: "2026-10-16",
      timestamp: "2026-10-15T16:00:00.000Z",
    });
  });

  it.each([
    ["currency", "USD", "HKD"],
    ["feed", "iex", "sip"],
    ["adjusted", false, true],
    ["adjustment", 1, 2],
    ["symbol", "AAPL", "MSFT"],
    ["unit", "GBX", "GBP"],
  ] as const)(
    "keeps different %s definitions separate within one provider",
    (field, left, right) => {
      const normalized = normalizeFinanceChartBars([
        { providerName: "same-provider", data: { ...bars(2)[0], [field]: left } },
        { providerName: "same-provider", data: { ...bars(2)[1], [field]: right } },
      ]);
      expect(normalized.bars).toHaveLength(1);
      expect(normalized.droppedCount).toBe(1);
    },
  );

  it("drops OHLC rows whose open or close falls outside the high-low range", () => {
    const normalized = normalizeFinanceChartBars([
      { date: "2026-01-01", open: 10, high: 9, low: 1, close: 8 },
      { date: "2026-01-02", open: 2, high: 5, low: 3, close: 4 },
    ]);

    expect(normalized.bars).toEqual([]);
    expect(normalized.droppedCount).toBe(2);
  });

  it("produces deterministic trend, drawdown, and moving-average features", () => {
    const normalized = normalizeFinanceChartBars(bars(25));
    const analysis = analyzeFinanceChartBars("AAPL", normalized.bars);
    expect(analysis.boundary).toBe("finance_chart_analysis_research_only");
    expect(analysis.features.trendDirection).toBe("up");
    expect(analysis.features.totalReturnPct).toBeCloseTo(24, 6);
    expect(analysis.features.sma20).toBeCloseTo(114.5, 6);
    expect(analysis.features.maxDrawdownPct).toBe(0);
    expect(analysis.limitations.join(" ")).toContain("not an order");
  });
});
