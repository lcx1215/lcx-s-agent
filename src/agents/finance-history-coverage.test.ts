import { expect, it } from "vitest";
import { assessFinanceHistoryCoverage } from "./finance-history-coverage.js";
import type { FinanceMarketCollectionItem } from "./finance-market-collection-registry.js";
const request = {
  instrument: "SPY",
  assetClass: "equity",
  collection: "eod_history" as const,
  fromDate: "2026-04-02",
  toDate: "2026-04-06",
  asOf: "2026-04-07T00:00:00Z",
};
function row(date: string): FinanceMarketCollectionItem {
  return {
    itemId: date,
    collection: "eod_history",
    providerName: "fixture",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    sourceTimestamp: `${date}T00:00:00Z`,
    observedAt: request.asOf,
    delayStatus: "delayed",
    sourceUrlOrArtifact: "fixture",
    data: { date, close: 100 },
  };
}
it("excludes exchange holidays and weekends, detects missing sessions", () => {
  expect(
    assessFinanceHistoryCoverage(request, [row("2026-04-02"), row("2026-04-06")]),
  ).toMatchObject({ status: "complete", expectedDays: 2 });
  expect(assessFinanceHistoryCoverage(request, [row("2026-04-06")]).providers[0].missing).toEqual([
    "2026-04-02",
  ]);
});
it("rejects duplicate rows, unknown years and incomplete current days", () => {
  expect(
    assessFinanceHistoryCoverage(request, [row("2026-04-02"), row("2026-04-02"), row("2026-04-06")])
      .status,
  ).toBe("incomplete");
  expect(assessFinanceHistoryCoverage({ ...request, fromDate: "2025-12-31" }, []).status).toBe(
    "unverified",
  );
  expect(assessFinanceHistoryCoverage({ ...request, toDate: "2026-04-07" }, []).status).toBe(
    "unverified",
  );
});
it("requires every UTC day for crypto and does not combine fragmented providers", () => {
  expect(
    assessFinanceHistoryCoverage({ ...request, assetClass: "crypto" }, [
      row("2026-04-02"),
      row("2026-04-06"),
    ]),
  ).toMatchObject({ status: "incomplete", expectedDays: 5 });
  expect(
    assessFinanceHistoryCoverage(request, [
      row("2026-04-02"),
      { ...row("2026-04-06"), providerName: "other" },
    ]).status,
  ).toBe("incomplete");
});
