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
  expect(assessFinanceHistoryCoverage({ ...request, fromDate: "2024-12-31" }, []).status).toBe(
    "unverified",
  );
  expect(assessFinanceHistoryCoverage({ ...request, toDate: "2026-04-07" }, []).status).toBe(
    "unverified",
  );
});

it("verifies a complete 12-month NYSE session window crossing 2025 and 2026", () => {
  const windowRequest = {
    ...request,
    fromDate: "2025-09-30",
    toDate: "2026-09-29",
    asOf: "2026-09-30T02:00:00Z",
  };
  const closures = new Set([
    "2025-11-27",
    "2025-12-25",
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-04-03",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
  ]);
  const records: FinanceMarketCollectionItem[] = [];
  for (
    let timestamp = Date.parse(`${windowRequest.fromDate}T00:00:00Z`);
    timestamp <= Date.parse(`${windowRequest.toDate}T00:00:00Z`);
    timestamp += 86_400_000
  ) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const weekday = new Date(timestamp).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !closures.has(date)) {
      records.push(row(date));
    }
  }

  expect(assessFinanceHistoryCoverage(windowRequest, records)).toMatchObject({
    status: "complete",
    expectedDays: 251,
    providers: [{ coveredDays: 251, complete: true }],
  });
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
