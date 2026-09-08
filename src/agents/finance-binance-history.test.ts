import { expect, it, vi } from "vitest";
import { createBinancePublicEodHistoryCollectionAdapter } from "./finance-free-market-collection-adapters.js";
const from = Date.parse("2026-04-01T00:00:00Z");
const request = {
  instrument: "BTCUSDT",
  assetClass: "crypto",
  collection: "eod_history" as const,
  fromDate: "2026-04-01",
  toDate: "2026-04-01",
  asOf: "2026-04-02T00:00:00Z",
  limit: 200,
};
it("maps completed UTC bars and rejects malformed or unfinished data", async () => {
  const row = [from, "100", "120", "90", "110", "42", from + 86_400_000 - 1];
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([row]),
  }));
  const adapter = createBinancePublicEodHistoryCollectionAdapter({ fetchImpl });
  expect((await adapter.collect(request, new AbortController().signal))[0].data).toMatchObject({
    date: "2026-04-01",
    close: 110,
  });
  expect(fetchImpl.mock.calls).toHaveLength(1);
  row[4] = "999";
  await expect(adapter.collect(request, new AbortController().signal)).rejects.toThrow(
    "invalid completed OHLCV bar",
  );
  await expect(
    adapter.collect({ ...request, asOf: "2026-04-01T12:00:00Z" }, new AbortController().signal),
  ).rejects.toThrow("completed days");
});
