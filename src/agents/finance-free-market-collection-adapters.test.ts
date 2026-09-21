import { describe, expect, it } from "vitest";
import { createBinancePublicEodHistoryCollectionAdapter } from "./finance-free-market-collection-adapters.js";

const DAY = 86_400_000;
const BASE = Date.parse("2026-09-01T00:00:00Z");

/** Minimal kline rows: [opened, open, high, low, close, volume, closed]. */
function klines(count: number): unknown[][] {
  return Array.from({ length: count }, (_, index) => [
    BASE + index * DAY,
    "100",
    "101",
    "99",
    "100",
    "1000",
    BASE + index * DAY + DAY - 1,
  ]);
}

/** Records the URL so the limit actually sent to the venue can be asserted. */
function harness(rows: unknown[][]) {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  return { urls, adapter: createBinancePublicEodHistoryCollectionAdapter({ fetchImpl }) };
}

const request = {
  instrument: "BTCUSDT",
  assetClass: "crypto",
  collection: "eod_history",
  fromDate: "2026-09-01",
  toDate: "2026-09-03",
} as const;

/**
 * `limit` was read independently in seven adapters and the degenerate values did seven different
 * things — `slice(0, 0)` yields nothing while `slice(-0)` yields *everything*, and `slice(0, -5)`
 * drops the last five rather than returning five. A zero in particular returns an empty result that
 * a reader cannot tell apart from "no data in this window".
 */
describe("a declared collection limit", () => {
  it("is sent through when it is a positive integer", async () => {
    const { urls, adapter } = harness(klines(3));
    await adapter.collect({ ...request, limit: 500 });
    expect(urls[0] && new URL(urls[0]).searchParams.get("limit")).toBe("500");
  });

  it("keeps its own fallback when it is not declared", async () => {
    const { urls, adapter } = harness(klines(3));
    await adapter.collect(request);
    expect(urls[0] && new URL(urls[0]).searchParams.get("limit")).toBe("1000");
  });

  it("is refused when it would make the window empty, inverted or fractional", async () => {
    for (const limit of [0, -5, 1.5, Number.NaN]) {
      const { adapter } = harness(klines(3));
      await expect(adapter.collect({ ...request, limit })).rejects.toThrow(
        /limit must be a positive integer/,
      );
    }
  });
});
