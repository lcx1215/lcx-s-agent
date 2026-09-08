import { expect, it } from "vitest";
import { createYahooPublicEodHistoryCollectionAdapter } from "./finance-free-market-collection-adapters.js";
it("excludes same-day provisional bars, future bars and invalid OHLC before limiting", async () => {
  const adapter = createYahooPublicEodHistoryCollectionAdapter({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          chart: {
            result: [
              {
                timestamp: [
                  "2026-09-04T13:30Z",
                  "2026-09-05T13:30Z",
                  "2026-09-08T13:30Z",
                  "2026-09-09T13:30Z",
                ].map((d) => Date.parse(d) / 1000),
                indicators: {
                  quote: [
                    {
                      open: [10, 10, 10, 10],
                      high: [12, 9, 12, 12],
                      low: [9, 9, 9, 9],
                      close: [11, 11, 11, 11],
                      volume: [1, 1, 1, 1],
                    },
                  ],
                },
              },
            ],
          },
        }),
    }),
  });
  const rows = await adapter.collect(
    {
      instrument: "AAPL",
      assetClass: "us_equity",
      collection: "eod_history",
      asOf: "2026-09-08T17:00:00Z",
      limit: 1,
    },
    new AbortController().signal,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].data.date).toBe("2026-09-04");
});
