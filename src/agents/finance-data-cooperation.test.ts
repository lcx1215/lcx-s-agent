import { afterEach, expect, it, vi } from "vitest";
import { createFutuDataCollectionAdapters } from "./finance-futu-data-source.js";
import type { FetchImpl } from "./finance-live-market-source.js";
import {
  createFinanceMarketCollectionRegistry,
  runFinanceMarketCollectionRefresh,
} from "./finance-market-collection-registry.js";
import { runFinanceResearchBatch } from "./finance-research-batch-runner.js";

afterEach(() => vi.useRealTimers());

it("keeps a qualified Hong Kong local-day bar through the original chain without certifying a US calendar", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  const fetchImpl = vi.fn<FetchImpl>(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ret_code: 0,
        data: {
          kline_list: [
            {
              time_key: Date.parse("2026-10-15T16:00:00Z"),
              date: 20261016,
              time_zone: 480,
              open: 100,
              high: 102,
              low: 99,
              close: 101,
              volume: 100,
              turnover: 10100,
            },
          ],
          volume_precision: 0,
        },
      }),
  }));
  const adapters = createFinanceMarketCollectionRegistry({
    fetchImpl,
    additionalAdapters: createFutuDataCollectionAdapters({
      fetchImpl,
      retry: { attempts: 1 },
      resolveQuoteReadAuthorization: async () => ({
        accessToken: "fixture-quote-read-token",
        scopes: ["quote:read"],
        expiresAt: "2026-10-20T00:00:00Z",
      }),
      resolveHistoryBarMetadata: async ({ symbol }) => ({
        symbol,
        currency: "HKD",
        completed: true,
        availableAt: "2026-10-16T08:15:00Z",
        evidenceRef: "fixture:hk-exchange-currency-and-completed-bar",
      }),
    }),
  }).filter((adapter) => adapter.id.startsWith("futunn_quote_read_"));
  const request = {
    instrument: "HK.00700",
    assetClass: "equity",
    collection: "eod_history" as const,
    asOf: "2026-10-19T12:00:00Z",
    fromDate: "2026-10-16",
    toDate: "2026-10-16",
    limit: 2,
  };
  const receipt = await runFinanceMarketCollectionRefresh({ request, adapters });
  expect(receipt.status).toBe("ready");
  expect(receipt.records).toMatchObject([
    {
      sourceTimestamp: "2026-10-15T16:00:00.000Z",
      data: { date: "2026-10-16", vendorDate: 20261016, currency: "HKD" },
    },
  ]);
  const batch = await runFinanceResearchBatch({
    asOf: request.asOf,
    useCase: "data-source-cooperation",
    realtimeAdapters: [],
    collectionAdapters: adapters,
    targets: [
      {
        id: "hk-history",
        instrument: request.instrument,
        assetClass: request.assetClass,
        realtime: false,
        collections: [{ ...request, freshnessMaxMinutes: 10000 }],
      },
    ],
  });
  expect(batch.jobs[0]).toMatchObject({
    status: "needs_review",
    historyCoverage: { status: "unverified" },
    missingEvidence: ["historical_window_coverage_unverified"],
    receipt: { status: "ready", records: [{ data: { date: "2026-10-16", currency: "HKD" } }] },
  });
  expect(JSON.stringify(batch)).not.toContain("fixture-quote-read-token");
});
