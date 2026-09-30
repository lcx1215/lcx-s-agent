import { describe, expect, it } from "vitest";
import { decodeFinanceBulk } from "./finance-extended-capability-catalog.js";
import { assessFinanceHistoryCoverage } from "./finance-history-coverage.js";
import {
  createFinanceMarketCollectionRegistry,
  inspectFinanceMarketCollectionRegistry,
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
  it("keeps the full 100-plus endpoint catalog discoverable for on-demand system calls", () => {
    const credentials = {
      alphaVantageApiKey: "test",
      finnhubApiKey: "test",
      massiveApiKey: "test",
      coinGeckoApiKey: "test",
      fmpApiKey: "test",
      fredApiKey: "test",
      twelveDataApiKey: "test",
      alpacaApiKeyId: "test",
      alpacaApiSecretKey: "test",
    };
    const adapters = createRegisteredCapabilityAdapters(credentials);
    const registry = createFinanceMarketCollectionRegistry(credentials);
    const ids = new Set(adapters.map((adapter) => adapter.id));

    expect(adapters.length).toBeGreaterThanOrEqual(100);
    expect(ids.size).toBe(adapters.length);
    expect(registry.length).toBeGreaterThanOrEqual(adapters.length);
    expect(registry.some((adapter) => adapter.id === "alpaca_indicative_options_chain")).toBe(true);
    expect(
      registry.some(
        (adapter) =>
          adapter.id === "alpaca_indicative_options_chain" &&
          adapter.supports({
            instrument: "SPY",
            assetClass: "us_equity",
            collection: "options_chain",
            asOf,
          }),
      ),
    ).toBe(true);
  });

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
    expect(result.records[0].sourceTimestamp).not.toBe(asOf);
    expect(result.records[0].observedAt).toBe(result.records[0].sourceTimestamp);
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
  it("declares end-of-day provenance for daily bars instead of the unusable default", async () => {
    // `manual_or_unknown` is refused as evidence downstream, so a collection the adapter itself
    // restricts to days strictly before `asOf` must not fall back to it: those bars are completed
    // end-of-day bars by construction, and saying so is a fact rather than an assumption.
    const adapters = createRegisteredCapabilityAdapters({
      massiveApiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [{ t: Date.parse("2026-09-04"), c: 99 }] }),
      }),
    });
    const receipt = await runFinanceMarketCollectionRefresh({
      request: { ...request, collection: "eod_history" },
      adapters,
    });
    expect(receipt.records[0].delayStatus).toBe("end_of_day");
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
    expect(estimates.records[0].sourceTimestamp).not.toBe(asOf);
    expect(estimates.records[0].observedAt).toBe(estimates.records[0].sourceTimestamp);
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
  it("requests the complete Alpaca end date and accepts its session date after the NY close", async () => {
    let requestedUrl = "";
    const adapters = createRegisteredCapabilityAdapters({
      alpacaApiKeyId: "test-id",
      alpacaApiSecretKey: "test-secret",
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              bars: [
                { t: "2026-09-11T04:00:00Z", o: 101, h: 103, l: 100, c: 102, v: 15 },
                { t: "2026-09-10T04:00:00Z", o: 100, h: 102, l: 99, c: 101, v: 20 },
                { t: "2026-09-09T04:00:00Z", o: 99, h: 101, l: 98, c: 100, v: 42 },
              ],
            }),
        };
      },
    });
    const receipt = await runFinanceMarketCollectionRefresh({
      request: {
        ...request,
        asOf: "2026-09-10T20:00:01Z",
        fromDate: "2026-09-04",
        toDate: "2026-09-10",
        collection: "eod_history",
      },
      adapters: adapters.filter((adapter) => adapter.id === "alpaca_daily_history"),
    });
    expect(new URL(requestedUrl).searchParams.get("end")).toBe("2026-09-10T23:59:59.999Z");
    expect(receipt.records.map((record) => record.sourceTimestamp)).toEqual([
      "2026-09-10T04:00:00.000Z",
      "2026-09-09T04:00:00.000Z",
    ]);
    expect(receipt.records[0]?.data).toMatchObject({
      date: "2026-09-10",
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 20,
      feed: "iex",
      sourceTimestampMeaning: "new_york_session_date_label_not_close_time",
    });
  });

  it("collects every session in a 13-month NYSE window for controller risk warmup", async () => {
    const closures = new Set([
      "2025-09-01",
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
    const bars: Record<string, unknown>[] = [];
    for (
      let timestamp = Date.parse("2025-08-30T00:00:00Z");
      timestamp <= Date.parse("2026-09-29T00:00:00Z");
      timestamp += 86_400_000
    ) {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      const weekday = new Date(timestamp).getUTCDay();
      if (weekday !== 0 && weekday !== 6 && !closures.has(date)) {
        bars.push({ t: `${date}T04:00:00Z`, o: 100, h: 101, l: 99, c: 100, v: 10 });
      }
    }
    let requestedUrl = "";
    const adapters = createRegisteredCapabilityAdapters({
      alpacaApiKeyId: "test-id",
      alpacaApiSecretKey: "test-secret",
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ bars: bars.toReversed() }),
        };
      },
    }).filter((adapter) => adapter.id === "alpaca_daily_history");
    const windowRequest = {
      instrument: "SPY",
      assetClass: "us_equity",
      collection: "eod_history" as const,
      asOf: "2026-09-30T02:00:00Z",
      fromDate: "2025-08-30",
      toDate: "2026-09-29",
      limit: 280,
    };
    const receipt = await runFinanceMarketCollectionRefresh({
      request: windowRequest,
      adapters,
    });

    expect(new URL(requestedUrl).searchParams.get("limit")).toBe("280");
    expect(receipt.records).toHaveLength(271);
    expect(receipt.records.some((record) => record.data.continuationRequired === true)).toBe(false);
    expect(assessFinanceHistoryCoverage(windowRequest, receipt.records)).toMatchObject({
      status: "complete",
      expectedDays: 271,
    });
    await expect(
      runFinanceMarketCollectionRefresh({
        request: { ...windowRequest, limit: 281 },
        adapters,
      }),
    ).rejects.toThrow("limit must be an integer between 1 and 280");
  });

  it("does not treat the current Alpaca session label as a completed bar before the NY close", async () => {
    const adapters = createRegisteredCapabilityAdapters({
      alpacaApiKeyId: "test-id",
      alpacaApiSecretKey: "test-secret",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            bars: [
              { t: "2026-09-10T04:00:00Z", o: 100, h: 102, l: 99, c: 101, v: 20 },
              { t: "2026-09-09T04:00:00Z", o: 99, h: 101, l: 98, c: 100, v: 42 },
            ],
          }),
      }),
    });
    const receipt = await runFinanceMarketCollectionRefresh({
      request: {
        ...request,
        asOf: "2026-09-10T19:59:59Z",
        fromDate: "2026-09-04",
        toDate: "2026-09-10",
        collection: "eod_history",
      },
      adapters: adapters.filter((adapter) => adapter.id === "alpaca_daily_history"),
    });
    expect(receipt.records.map((record) => record.data.date)).toEqual(["2026-09-09"]);
  });
  it("keeps configured Alpaca daily history inside the bounded primary-source selection", () => {
    const registry = createFinanceMarketCollectionRegistry({
      alpacaApiKeyId: "test-id",
      alpacaApiSecretKey: "test-secret",
      includeYahooPublicSources: true,
    });
    const inspection = inspectFinanceMarketCollectionRegistry(
      {
        instrument: "EFA",
        assetClass: "us_equity",
        collection: "eod_history",
        asOf: "2026-09-30T00:08:59.000Z",
        fromDate: "2026-09-01",
        toDate: "2026-09-29",
        limit: 20,
      },
      registry,
    );

    expect(inspection.noNetworkCalled).toBe(true);
    expect(inspection.candidateAdapters.slice(0, 3)).toEqual([
      {
        id: "china_reachable_us_eod_history",
        providerName: "china-reachable-us-eod-history",
        providerRole: "primary_market_data",
        priority: 10,
      },
      {
        id: "alpaca_daily_history",
        providerName: "Alpaca",
        providerRole: "primary_market_data",
        priority: 15,
      },
      {
        id: "yahoo_public_eod_history",
        providerName: "yahoo-public-eod-history",
        providerRole: "primary_market_data",
        priority: 20,
      },
    ]);
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

it("makes indicative options usable while preserving delayed, modified and incomplete-feed limits", async () => {
  let actualUrl = "";
  const adapters = createRegisteredCapabilityAdapters({
    alpacaApiKeyId: "private-id",
    alpacaApiSecretKey: "private-secret",
    fetchImpl: async (url) => {
      actualUrl = String(url);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            next_page_token: "more",
            snapshots: {
              AAPL260918C00300000: {
                latestTrade: { p: 10, t: "2026-09-07T15:30:00Z" },
                latestQuote: { ap: 11, bp: 9, t: "2026-09-07T15:45:00Z" },
              },
              MISSING: { latestQuote: { ap: 10 } },
            },
          }),
      };
    },
  });
  const receipt = await runFinanceMarketCollectionRefresh({
    request: {
      instrument: "AAPL",
      assetClass: "us_equity",
      collection: "options_chain",
      asOf: "2026-09-08T00:00:00Z",
      limit: 5,
    },
    adapters,
  });
  expect(new URL(actualUrl).hostname).toBe("data.alpaca.markets");
  expect(new URL(actualUrl).searchParams.get("feed")).toBe("indicative");
  expect(receipt.records).toHaveLength(1);
  expect(receipt.records[0]).toMatchObject({
    delayStatus: "delayed",
    sourceFamily: "market_data_api",
    sourceTimestamp: "2026-09-07T15:30:00.000Z",
    data: {
      symbol: "AAPL260918C00300000",
      quotesModified: true,
      tradesDelayed: true,
      executionGrade: false,
      continuationRequired: true,
    },
  });
  expect(JSON.stringify(receipt)).not.toContain("private-");
});
