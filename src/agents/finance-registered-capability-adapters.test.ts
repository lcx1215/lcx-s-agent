import { describe, expect, it } from "vitest";
import { decodeFinanceBulk } from "./finance-extended-capability-catalog.js";
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
    expect(adapters.length).toBeGreaterThan(25);
    expect(targets).toHaveLength(adapters.length);
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

describe("extended capability contracts", () => {
  it("keeps all FMP discovery jobs reachable and leaves period-dependent jobs explicit", () => {
    const adapters = createRegisteredCapabilityAdapters({ fmpApiKey: "test" });
    const plan = buildAllRegisteredFinanceResearchTargets(asOf, 3, [], adapters);
    expect(plan.length).toBeGreaterThan(90);
    expect(adapters.length - plan.length).toBe(3);
    for (const job of plan) {
      const adapter = adapters.find((a) => job.sourceAdapterIds?.includes(a.id))!;
      expect(
        adapter.supports({
          ...job.collections![0],
          instrument: job.instrument,
          assetClass: job.assetClass,
          asOf,
        }),
      ).toBe(true);
    }
    const transcript = adapters.find((a) => a.id === "fmp_earning_call_transcript")!;
    expect(transcript.supports({ ...request, collection: "transcripts" })).toBe(false);
    expect(
      transcript.supports({ ...request, collection: "transcripts", seriesId: "2025-Q4" }),
    ).toBe(true);
  });
  it("uses stable FMP paths with header auth and preserves quarterly fields", async () => {
    let requestedUrl = "";
    let headers: unknown;
    const adapters = createRegisteredCapabilityAdapters({
      fmpApiKey: "fmp-private",
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        headers = init?.headers;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
              {
                date: "2025-09-30",
                acceptedDate: "2025-10-31T10:00:00Z",
                period: "Q4",
                revenue: 100,
                operatingCashFlow: 40,
              },
            ]),
        };
      },
    });
    const receipt = await runFinanceMarketCollectionRefresh({
      request,
      adapters: adapters.filter((a) => a.id === "fmp_income_statement_quarter"),
    });
    expect(new URL(requestedUrl).pathname).toBe("/stable/income-statement");
    expect(new URL(requestedUrl).searchParams.get("period")).toBe("quarter");
    expect(requestedUrl).not.toContain("fmp-private");
    expect(headers).toEqual({ apikey: "fmp-private" });
    expect(receipt.records[0].data.operatingCashFlow).toBe(40);
    expect(receipt.records[0].sourceTimestamp).toBe("2025-10-31T10:00:00.000Z");
    expect(JSON.stringify(receipt)).not.toContain("fmp-private");
  });
  it("preserves future estimates as forecasts and rejects future-published statements", async () => {
    const adapters = createRegisteredCapabilityAdapters({
      fmpApiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ date: "2027-12-31", estimatedRevenueAvg: 123 }]),
      }),
    });
    const estimates = await runFinanceMarketCollectionRefresh({
      request: { ...request, collection: "analyst_estimates" },
      adapters: adapters.filter((a) => a.id === "fmp_analyst_estimates_annual"),
    });
    expect(estimates.records[0].data.valueNature).toContain("forecast");
    expect(estimates.records[0].data.targetPeriod).toBe("2027-12-31");
    expect(Date.parse(estimates.records[0].sourceTimestamp)).toBe(Date.parse(asOf));
    const statements = await runFinanceMarketCollectionRefresh({
      request,
      adapters: adapters.filter((a) => a.id === "fmp_income_statement_annual"),
    });
    expect(statements.records).toHaveLength(0);
  });
  it("does not use broker endpoints and keeps both Alpaca credentials out of receipts", async () => {
    let requestedUrl = "";
    const adapters = createRegisteredCapabilityAdapters({
      alpacaApiKeyId: "private-id",
      alpacaApiSecretKey: "private-secret",
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              bars: [{ t: "2026-09-04T04:00:00Z", c: 100, v: 42 }],
              next_page_token: "next",
            }),
        };
      },
    });
    const receipt = await runFinanceMarketCollectionRefresh({
      request: { ...request, collection: "eod_history" },
      adapters,
    });
    expect(new URL(requestedUrl).hostname).toBe("data.alpaca.markets");
    expect(new URL(requestedUrl).searchParams.get("feed")).toBe("iex");
    expect(receipt.records[0].data.continuationRequired).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("private-");
  });
  it("treats Twelve Data entitlement envelopes as failures, even with HTTP 200", async () => {
    const adapters = createRegisteredCapabilityAdapters({
      twelveDataApiKey: "private-key",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: "error", code: 403, message: "plan access" }),
      }),
    });
    const receipt = await runFinanceMarketCollectionRefresh({
      request: { ...request, collection: "technical_indicators" },
      adapters: adapters.filter((a) => a.id === "twelve_data_rsi"),
      retry: { attempts: 1 },
    });
    expect(receipt.records).toHaveLength(0);
    expect(receipt.status).toBe("blocked");
  });
});

it("decodes quoted bulk exports and rejects non-data or broken rows", () => {
  expect(decodeFinanceBulk('symbol,name,price\nAAPL,"Apple, Inc.",100')).toEqual([
    { symbol: "AAPL", name: "Apple, Inc.", price: "100" },
  ]);
  expect(() => decodeFinanceBulk("Upgrade your plan")).toThrow("schema");
  expect(() => decodeFinanceBulk('symbol,name\nAAPL,"unterminated')).toThrow("unterminated");
  expect(() => decodeFinanceBulk("symbol,name\nAAPL")).toThrow("width");
});
it("preserves full raw responses independently of normalized limits and redacts keys", async () => {
  let raw = "";
  const adapters = createRegisteredCapabilityAdapters({
    fmpApiKey: "fixture-secret",
    captureRawResponse: async (r) => {
      raw = r.body;
      return "artifact.json";
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([{ symbol: "AAPL", note: "fixture-secret" }, { symbol: "MSFT" }]),
    }),
  });
  const receipt = await runFinanceMarketCollectionRefresh({
    request: { ...request, collection: "bulk_dataset", limit: 1 },
    adapters: adapters.filter((a) => a.id === "fmp_profile_bulk"),
  });
  expect(JSON.parse(raw)).toHaveLength(2);
  expect(raw).not.toContain("fixture-secret");
  expect(receipt.records).toHaveLength(1);
  expect(receipt.records[0].data.rawArtifact).toBe("artifact.json");
  expect(JSON.stringify(receipt)).not.toContain("fixture-secret");
});
