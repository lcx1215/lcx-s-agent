import { describe, expect, it } from "vitest";
import {
  createFinanceMarketCollectionRegistry,
  runFinanceMarketCollectionRefresh,
} from "./finance-market-collection-registry.js";
import { createRegisteredCapabilityAdapters } from "./finance-registered-capability-adapters.js";
import { buildAllRegisteredFinanceResearchTargets } from "./finance-research-runner.js";
const asOf = "2026-09-08T12:00:00Z";
const request = {
  instrument: "AAPL",
  assetClass: "us_equity",
  collection: "financial_statements" as const,
  asOf,
  limit: 20,
};
describe("registered provider capabilities", () => {
  it("routes every configured endpoint through the all-source planner including crypto", () => {
    const adapters = createRegisteredCapabilityAdapters({
      alphaVantageApiKey: "test",
      finnhubApiKey: "test",
      massiveApiKey: "test",
      coinGeckoApiKey: "test",
    });
    const targets = buildAllRegisteredFinanceResearchTargets(asOf, 3, [], adapters);
    expect(adapters).toHaveLength(10);
    expect(targets).toHaveLength(10);
    expect(targets.find((t) => t.id === "source-coingecko_daily_history")?.assetClass).toBe(
      "crypto",
    );
    expect(
      createFinanceMarketCollectionRegistry({ alphaVantageApiKey: "test" }).some(
        (a) => a.id === "alpha_vantage_cash_flow",
      ),
    ).toBe(true);
  });
  it("keeps fiscal periods, filters future reports, bounds records and excludes keys from receipts", async () => {
    let calls = 0;
    const adapters = createRegisteredCapabilityAdapters({
      alphaVantageApiKey: "private-test-value",
      fetchImpl: async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              annualReports: [
                { fiscalDateEnding: "2027-01-01", totalRevenue: "1" },
                { fiscalDateEnding: "2025-09-30", totalRevenue: "100" },
              ],
            }),
        };
      },
    });
    const result = await runFinanceMarketCollectionRefresh({
      request,
      adapters: adapters.filter((a) => a.id === "alpha_vantage_income_statement"),
      retry: { attempts: 1 },
    });
    expect(calls).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].data.publicationTimeUnknown).toBe(true);
    expect(result.records[0].sourceTimestamp).toBe("2025-09-30T00:00:00.000Z");
    expect(JSON.stringify(result)).not.toContain("private-test-value");
  });
  it("rejects successful HTTP quota envelopes instead of fabricating evidence", async () => {
    const adapters = createRegisteredCapabilityAdapters({
      alphaVantageApiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ Information: "quota exceeded" }),
      }),
    });
    const result = await runFinanceMarketCollectionRefresh({
      request,
      adapters: adapters.filter((a) => a.id === "alpha_vantage_income_statement"),
    });
    expect(result.status).toBe("blocked");
    expect(result.records).toHaveLength(0);
  });
  it("does not label untimestamped profiles as provider-fresh data", async () => {
    const adapters = createRegisteredCapabilityAdapters({
      finnhubApiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ticker: "AAPL", name: "Apple" }),
      }),
    });
    const result = await runFinanceMarketCollectionRefresh({
      request: { ...request, collection: "company_profile" },
      adapters: adapters.filter((a) => a.id === "finnhub_profile2"),
    });
    expect(result.records[0].delayStatus).toBe("manual_or_unknown");
    expect(result.records[0].data.sourceTimestampMeaning).toContain("timestamp_unavailable");
  });
  it("drops invalid and unfinished daily bars while retaining usable history", async () => {
    const adapters = createRegisteredCapabilityAdapters({
      massiveApiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            results: [
              { t: Date.parse(asOf), c: 100 },
              { t: Date.parse("2026-09-07"), c: -1 },
              { t: Date.parse("2026-09-04"), c: 99 },
            ],
          }),
      }),
    });
    const receipt = await runFinanceMarketCollectionRefresh({
      request: { ...request, collection: "eod_history" },
      adapters,
    });
    expect(receipt.records).toHaveLength(1);
    expect(receipt.records[0].data.close).toBe(99);
  });
});
