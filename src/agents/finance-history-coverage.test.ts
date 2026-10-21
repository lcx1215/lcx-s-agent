import { expect, it } from "vitest";
import { assessFinanceHistoryCoverage } from "./finance-history-coverage.js";
import type { FinanceMarketCollectionItem } from "./finance-market-collection-registry.js";
import { runFinanceResearchBatch } from "./finance-research-batch-runner.js";
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

// NYSE's published exceptional closure supplements its regular holiday calendar.
it("does not require an equity bar on the 2025 national day of mourning", () => {
  const window = {
    ...request,
    fromDate: "2025-01-08",
    toDate: "2025-01-10",
    asOf: "2025-01-11T00:00:00Z",
  };
  expect(
    assessFinanceHistoryCoverage(window, [row("2025-01-08"), row("2025-01-10")]),
  ).toMatchObject({ status: "complete", expectedDays: 2 });
  expect(assessFinanceHistoryCoverage(window, [row("2025-01-08")]).providers[0].missing).toEqual([
    "2025-01-10",
  ]);
});

const julyWindow = {
  ...request,
  fromDate: "2026-07-02",
  toDate: "2026-07-06",
  asOf: "2026-07-07T00:00:00Z",
};
const usHolidayRows = [row("2026-07-02"), row("2026-07-06")];

it.each([
  { instrument: "HK.00700", assetClass: "equity" },
  { instrument: "SH.600519", assetClass: "stock" },
  { instrument: "SZ.000001", assetClass: "common_stock" },
  { instrument: "0700.HK", assetClass: "equity" },
  { instrument: "600519.SS", assetClass: "stock" },
  { instrument: "000001.SZ", assetClass: "common_stock" },
  { instrument: "300135.SHZ", assetClass: "equity" },
  { instrument: "VOD.L", assetClass: "equity" },
])("does not certify a foreign $instrument window using NYSE holidays", (market) => {
  expect(assessFinanceHistoryCoverage({ ...julyWindow, ...market }, usHolidayRows)).toEqual({
    status: "unverified",
    gaps: ["historical_window_coverage_unverified"],
    expectedDays: 0,
    providers: [],
  });
});

it.each(["AAPL", "BRK.B", "BRK-B", "US.AAPL", "US.BRK.B"])(
  "retains the existing US calendar for $instrument",
  (instrument) => {
    expect(
      assessFinanceHistoryCoverage({ ...julyWindow, instrument }, usHolidayRows),
    ).toMatchObject({ status: "complete", expectedDays: 2 });
  },
);

it("keeps the original batch job under review when a foreign window lacks calendar authority", async () => {
  const packet = await runFinanceResearchBatch({
    asOf: julyWindow.asOf,
    useCase: "history-calendar-contract",
    targets: [
      {
        id: "hk",
        instrument: "HK.00700",
        assetClass: "equity",
        realtime: false,
        collections: [
          {
            collection: "eod_history",
            fromDate: julyWindow.fromDate,
            toDate: julyWindow.toDate,
            freshnessMaxMinutes: 10_000,
          },
        ],
      },
    ],
    realtimeAdapters: [],
    collectionAdapters: [
      {
        id: "history-calendar-fixture",
        providerName: "fixture",
        providerRole: "primary_market_data",
        priority: 1,
        supports: (request) => request.collection === "eod_history",
        collect: async () =>
          usHolidayRows.map((record) => ({ ...record, observedAt: julyWindow.asOf })),
      },
    ],
  });
  expect(packet.jobs[0]).toMatchObject({
    status: "needs_review",
    historyCoverage: { status: "unverified", gaps: ["historical_window_coverage_unverified"] },
    missingEvidence: expect.arrayContaining(["historical_window_coverage_unverified"]),
  });
});
