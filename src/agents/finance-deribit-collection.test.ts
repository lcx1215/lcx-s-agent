import { afterEach, expect, it, vi } from "vitest";
import { createDeribitPublicCollectionAdapters } from "./finance-deribit-collection.js";
import type { FetchImpl } from "./finance-live-market-source.js";
import {
  createFinanceMarketCollectionRegistry,
  inspectFinanceMarketCollectionRegistry,
  runFinanceMarketCollectionRefresh,
  type FinanceMarketCollectionRequest,
} from "./finance-market-collection-registry.js";
import { FINANCE_SOURCE_QUOTA_POLICIES } from "./finance-source-quota-policy.js";

const now = new Date("2026-10-14T03:00:00Z");
const request = (
  collection: "options_chain" | "market_reference" = "options_chain",
): FinanceMarketCollectionRequest => ({
  instrument: "BTC",
  assetClass: "crypto",
  collection,
  asOf: now.toISOString(),
  asOfMode: "live_now",
  limit: 1,
});
const row = (fields: Record<string, unknown> = {}) => ({
  instrument_name: "BTC-30OCT26-100000-C",
  base_currency: "BTC",
  quote_currency: "BTC",
  creation_timestamp: now.getTime(),
  mark_price: 0.025,
  open_interest: 12,
  volume: 3,
  bid_price: null,
  ask_price: 0.026,
  mark_iv: 50,
  ...fields,
});
function fetchPayload(result: unknown) {
  return vi.fn<FetchImpl>(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(result),
  }));
}
afterEach(() => vi.useRealTimers());
it.each(["option", "future"])(
  "delivers public %s evidence through the original collection gate",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const f = fetchPayload({
      jsonrpc: "2.0",
      result: [
        row({
          instrument_name: kind === "future" ? "BTC-PERPETUAL" : "BTC-30OCT26-100000-C",
          current_funding: 0.0001,
        }),
      ],
    });
    const adapters = createFinanceMarketCollectionRegistry({ fetchImpl: f });
    const r = request(kind === "future" ? "market_reference" : "options_chain");
    expect(
      inspectFinanceMarketCollectionRegistry(r, adapters).candidateAdapters.some(
        (a) => a.id === `deribit_public_${kind}_summary`,
      ),
    ).toBe(true);
    const receipt = await runFinanceMarketCollectionRefresh({
      request: r,
      adapters,
      maxSources: 1,
    });
    expect(receipt.status).toBe("ready");
    expect(receipt.records).toHaveLength(1);
    const fact = receipt.records[0];
    expect(fact.sourceTimestamp).toBe(now.toISOString());
    expect(fact.data).toMatchObject({
      mark_price: 0.025,
      bid_price: null,
      open_interest: 12,
      mark_iv: 50,
      current_funding: 0.0001,
      useBoundary: "research_snapshot_not_execution_quote_or_trade_permission",
    });
    expect(fact.data.sourceResponseSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(new URL(f.mock.calls[0][0]).searchParams.get("kind")).toBe(kind);
    expect(FINANCE_SOURCE_QUOTA_POLICIES.find((p) => p.provider === "deribit")?.hosts).toContain(
      "www.deribit.com",
    );
  },
);
it.each([
  ["missing timestamp", { creation_timestamp: undefined }],
  ["seconds instead of milliseconds", { creation_timestamp: now.getTime() / 1000 }],
  ["future timestamp", { creation_timestamp: now.getTime() + 3600000 }],
  ["stale snapshot", { creation_timestamp: now.getTime() - 3600000 }],
  ["foreign currency", { base_currency: "ETH" }],
  ["crossed quote", { bid_price: 1, ask_price: 0.1 }],
  ["bad numeric field", { mark_iv: "unknown" }],
] as const)("rejects %s rather than fabricating ready data", async (_name, fields) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const [adapter] = createDeribitPublicCollectionAdapters({
    fetchImpl: fetchPayload({ jsonrpc: "2.0", result: [row(fields)] }),
  });
  await expect(adapter.collect(request(), new AbortController().signal)).rejects.toThrow();
});
it.each([
  { jsonrpc: "2.0", error: { code: 10028 }, result: [row()] },
  { jsonrpc: "2.0", result: [] },
  { jsonrpc: "2.0", result: [row(), row()] },
])("rejects RPC failures, empty data or duplicate identities", async (payload) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const [adapter] = createDeribitPublicCollectionAdapters({ fetchImpl: fetchPayload(payload) });
  await expect(adapter.collect(request(), new AbortController().signal)).rejects.toThrow();
});
it("checks omitted rows and does not hide corrupt data beyond limit", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const [adapter] = createDeribitPublicCollectionAdapters({
    fetchImpl: fetchPayload({
      jsonrpc: "2.0",
      result: [row(), row({ instrument_name: "BTC-30OCT26-100000-P", creation_timestamp: 1 })],
    }),
  });
  await expect(adapter.collect(request(), new AbortController().signal)).rejects.toThrow();
});
it("does not fetch historical, equity or cancelled requests", async () => {
  const f = fetchPayload({});
  const [adapter] = createDeribitPublicCollectionAdapters({ fetchImpl: f });
  for (const r of [
    { ...request(), asOfMode: "historical" as const },
    { ...request(), assetClass: "us_equity" },
  ]) {
    expect(adapter.supports(r)).toBe(false);
    await expect(adapter.collect(r, new AbortController().signal)).rejects.toThrow();
  }
  const controller = new AbortController();
  controller.abort();
  await expect(adapter.collect(request(), controller.signal)).rejects.toThrow();
  expect(f).not.toHaveBeenCalled();
});
