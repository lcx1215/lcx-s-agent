import { describe, expect, it } from "vitest";
import type { FinanceMarketCollectionItem } from "./finance-market-collection-registry.js";
import {
  summarizeFinancePriceHistory,
  findUncitedFinanceInstruments,
  rankFinanceWindowDrawdowns,
} from "./finance-research-evidence.js";
const row = (
  date: string,
  close: number,
  providerName = "primary",
): FinanceMarketCollectionItem => ({
  itemId: date,
  collection: "eod_history",
  providerName,
  providerRole: "primary_market_data",
  sourceFamily: "market_data_api",
  sourceTimestamp: `${date}T20:00:00Z`,
  observedAt: "2026-09-10T00:00:00Z",
  delayStatus: "end_of_day",
  sourceUrlOrArtifact: "fixture://prices",
  data: { date, close },
});
describe("finance price arithmetic before model prompting", () => {
  it("ranks actual drawdown magnitude without putting every cryptocurrency ahead of stocks", () => {
    const common = { from: "2026-03-09", to: "2026-09-09" };
    const result = rankFinanceWindowDrawdowns([
      { ...common, instrument: "BTCUSDT", maxDrawdownPct: -28.689 },
      { ...common, instrument: "TSLA", maxDrawdownPct: -33.002 },
      { ...common, instrument: "ETHUSDT", maxDrawdownPct: -35.186 },
      { ...common, from: "2026-03-10", instrument: "SP500", maxDrawdownPct: -6.455 },
    ]);
    expect(result[0]?.ranked.map((entry) => entry.instrument)).toEqual([
      "ETHUSDT",
      "TSLA",
      "BTCUSDT",
    ]);
    expect(result[1]?.ranked.map((entry) => entry.instrument)).toEqual(["SP500"]);
  });
  it("rejects a real but unrelated evidence ID for an explicitly named instrument", () => {
    const evidence = [{ id: "finance-model:SPY" }, { id: "finance-model:ETHUSDT" }];
    const claims = [
      {
        id: "c1",
        text: "ETHUSDT +23.841%",
        status: "supported" as const,
        evidenceIds: ["finance-model:SPY"],
      },
    ];
    expect(findUncitedFinanceInstruments(evidence, claims)).toEqual(["c1:finance-model:ETHUSDT"]);
    expect(
      findUncitedFinanceInstruments(evidence, [
        { ...claims[0], evidenceIds: ["finance-model:ETHUSDT"] },
      ]),
    ).toEqual([]);
  });
  it("computes path drawdown and window return rather than counting rows", () => {
    const result = summarizeFinancePriceHistory(
      [
        row("2026-09-01", 100),
        row("2026-09-02", 120),
        row("2026-09-03", 90),
        row("2026-09-04", 110),
      ],
      "2026-09-10T00:00:00Z",
    );
    expect(result.summaries[0]).toMatchObject({
      priceReturnPct: 10,
      maxDrawdownPct: -25,
      currentDrawdownPct: -8.333,
    });
    expect(result.summaries[0]?.returnsByObservationPct[21]).toBeNull();
    expect(result.summaries[0]?.observationWindows[1]).toEqual({
      from: "2026-09-03",
      to: "2026-09-04",
    });
    expect(result.summaries[0]?.observationWindows[21]).toBeNull();
  });
  it("deduplicates same dates but rejects a conflicting source series", () => {
    const base = row("2026-09-01", 100);
    const result = summarizeFinancePriceHistory(
      [base, base, row("2026-09-01", 102)],
      "2026-09-10T00:00:00Z",
    );
    expect(result).toMatchObject({ duplicates: 2, conflicts: 1, usable: false });
  });
  it("does not combine different providers or feed definitions", () => {
    const result = summarizeFinancePriceHistory(
      [row("2026-09-01", 100), row("2026-09-02", 200, "iex")],
      "2026-09-10T00:00:00Z",
    );
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries.every((s) => s.priceReturnPct === 0)).toBe(true);
  });
  it("excludes unfinished days, invalid calendar dates and nonpositive prices", () => {
    const result = summarizeFinancePriceHistory(
      [row("2026-09-10", 100), row("2026-02-30", 100), row("2026-09-02", 0), row("2026-09-03", 90)],
      "2026-09-10T22:00:00Z",
    );
    expect(result.invalid).toBe(3);
    expect(result.summaries[0]?.observations).toBe(1);
  });
  it("allows post-cutoff records only when live-now evidence is bounded", () => {
    const postCutoff = row("2026-09-08", 100);
    const historical = summarizeFinancePriceHistory([postCutoff], "2026-09-08T12:00:00Z");
    const liveNow = summarizeFinancePriceHistory([postCutoff], "2026-09-08T12:00:00Z", {
      asOfMode: "live_now",
      futureTimestampLimitMs: Date.parse("2026-09-08T20:05:00Z"),
    });

    expect(historical.summaries).toHaveLength(0);
    expect(liveNow.summaries).toHaveLength(1);
  });
});
