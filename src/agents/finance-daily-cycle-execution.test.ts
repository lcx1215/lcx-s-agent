import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  order: vi.fn(),
  paper: vi.fn(),
  venue: vi.fn(),
}));
vi.mock("./finance-free-market-collection-adapters.js", () => ({
  createChinaReachableUsEodHistoryCollectionAdapter: () => ({ collect: mocks.collect }),
}));
vi.mock("./finance-alpaca-run.js", () => ({
  fetchAlpacaVenueState: mocks.venue,
  runFinanceAlpacaOrder: mocks.order,
}));
vi.mock("./finance-paper-run.js", () => ({ runFinancePaperOrder: mocks.paper }));
vi.mock("./finance-bar-ledger.js", () => ({
  appendFinanceBars: async () => ({ repeatsSkipped: 0, appended: true }),
}));
vi.mock("./finance-position-ledger.js", () => ({
  readFinancePositionLedger: async () => ({ ledger: { positions: [] }, receipts: [], marks: [] }),
  projectFinancePositions: () => ({ positions: [] }),
  appendFinanceExecutionReceipt: vi.fn(),
  appendFinancePositionMark: vi.fn(),
}));
import {
  runFinanceDailyCycle,
  type FinanceDailyCycleExecutionQuote,
} from "./finance-daily-cycle.js";
const asOf = "2026-09-22T19:30:00.000Z";
const params = {
  instruments: ["AAPL", "MSFT"],
  equity: 100000,
  asOf,
  caps: { maxOrderNotional: 1000, maxInstrumentNotional: 2000, maxOrdersPerRun: 2 },
  runAuthorizationId: "synthetic",
  place: true,
  venue: "alpaca" as const,
  directory: "/synthetic/not-written",
};
function quotes(change: Partial<FinanceDailyCycleExecutionQuote> = {}) {
  return new Map(
    params.instruments.map((symbol) => [
      symbol,
      {
        referencePrice: 250,
        referencePriceAt: asOf,
        sourceUrlOrArtifact: "fixture://execution-quote",
        maxAgeMs: 1000,
        ...change,
      },
    ]),
  );
}
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(asOf));
  // Deliberately old history remains research input, never a current executable quote.
  mocks.collect.mockResolvedValue(
    Array.from({ length: 500 }, (_, i) => {
      const date = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      const close = 100 + i * 0.1 + Math.sin(i);
      return {
        providerName: "fixture",
        sourceUrlOrArtifact: "fixture://bars",
        sourceTimestamp: `${date}T20:00:00Z`,
        data: { date, open: close, high: close + 1, low: close - 1, close, volume: 1000 },
      };
    }),
  );
  mocks.venue.mockResolvedValue({
    ok: true,
    state: { openOrders: new Map(), positions: new Map() },
  });
  mocks.order.mockResolvedValue({ ok: false, stage: "place", refusals: ["synthetic refusal"] });
  mocks.paper.mockResolvedValue({ ok: false, stage: "place", refusals: ["synthetic refusal"] });
});
describe("daily cycle execution data boundary", () => {
  it("does not promote old EOD research bars into venue orders", async () => {
    const report = await runFinanceDailyCycle(params);
    expect(report.targets).toHaveLength(2);
    expect(report.refusals.join()).toContain("no execution quote");
    expect(report.ok).toBe(false);
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it.each([
    { referencePriceAt: "2026-09-20T00:00:00Z" },
    { referencePriceAt: "2026-09-23T00:00:00Z" },
    { referencePriceAt: "invalid" },
    { sourceUrlOrArtifact: "" },
    { maxAgeMs: Number.POSITIVE_INFINITY },
    { referencePrice: 0 },
  ])("rejects unusable quote %j before any placement", async (change) => {
    const report = await runFinanceDailyCycle({ ...params, executionQuotes: quotes(change) });
    expect(report.ok).toBe(false);
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it("uses the independent current quote and reports placement refusal as failure", async () => {
    const report = await runFinanceDailyCycle({ ...params, executionQuotes: quotes() });
    expect(mocks.order).toHaveBeenCalledTimes(2);
    expect(mocks.order).toHaveBeenCalledWith(
      expect.objectContaining({ market: { referencePrice: 250, referencePriceAt: asOf } }),
    );
    expect(report.ok).toBe(false);
  });
  it("stops the entire book when a submitted order is uncertain", async () => {
    const { AlpacaOrderUncertainError } = await import("./finance-alpaca-execution-adapter.js");
    mocks.order.mockRejectedValueOnce(
      new AlpacaOrderUncertainError(
        "fixture-client",
        "fixture-order",
        new Error("synthetic unknown"),
      ),
    );
    const report = await runFinanceDailyCycle({ ...params, executionQuotes: quotes() });
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(report.ok).toBe(false);
    expect(report.dataIssues.join()).toContain("stopped remaining orders");
  });
  it("validates lazy quotes against current control clock, not historical strategy asOf", async () => {
    const now = Date.parse(asOf) + 600000;
    const executionQuoteProvider = vi.fn(async () => ({
      ...quotes().get("AAPL")!,
      referencePriceAt: new Date(now).toISOString(),
      bidPrice: 249,
      askPrice: 251,
    }));
    await runFinanceDailyCycle({ ...params, executionNow: () => now, executionQuoteProvider });
    expect(executionQuoteProvider).toHaveBeenCalledTimes(2);
    expect(mocks.order).toHaveBeenCalledWith(
      expect.objectContaining({
        market: { referencePrice: 251, referencePriceAt: new Date(now).toISOString() },
      }),
    );
  });
  it("rejects a quote that ages during collection", async () => {
    const executionQuoteProvider = vi.fn(async () => ({
      ...quotes().get("AAPL")!,
      bidPrice: 249,
      askPrice: 251,
    }));
    const report = await runFinanceDailyCycle({
      ...params,
      executionNow: () => Date.parse(asOf) + 5000,
      executionQuoteProvider,
    });
    expect(report.refusals.join()).toContain("stale");
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it("bounds a provider that never settles without placing an order", async () => {
    vi.useFakeTimers();
    try {
      const executionQuoteProvider = vi.fn(
        () => new Promise<FinanceDailyCycleExecutionQuote>(() => {}),
      );
      const run = runFinanceDailyCycle({
        ...params,
        instruments: ["AAPL"],
        executionQuoteProvider,
      });
      await vi.runAllTimersAsync();
      const report = await run;
      expect(report.refusals.join()).toContain("timeout");
      expect(mocks.order).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps local paper simulation usable without an execution feed", async () => {
    await runFinanceDailyCycle({ ...params, venue: "paper" });
    expect(mocks.paper).toHaveBeenCalledTimes(2);
    expect(mocks.order).not.toHaveBeenCalled();
  });
});
