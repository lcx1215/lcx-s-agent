import { describe, expect, it } from "vitest";
import type { FetchImpl } from "./finance-live-market-source.js";
import {
  createBlsMacroSeriesCollectionAdapter,
  createFinnhubNewsCollectionAdapter,
  createFredMacroSeriesCollectionAdapter,
  createFmpFreeBasicEodCollectionAdapter,
  createFmpFreeBasicProfileCollectionAdapter,
  createGdeltPublicNewsCollectionAdapter,
  createSecFilingsCollectionAdapter,
  createMassiveDividendsCollectionAdapter,
  createMassiveNewsCollectionAdapter,
  createMassiveOptionsChainCollectionAdapter,
  createMassiveSplitsCollectionAdapter,
  createTreasuryDebtCollectionAdapter,
  createTreasuryAverageInterestRatesCollectionAdapter,
  createFinanceMarketCollectionRegistry,
  inspectFinanceMarketCollectionRegistry,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
  runFinanceMarketCollectionRefresh,
  type FinanceMarketCollectionRequest,
} from "./finance-market-collection-registry.js";

const EQUITY_REQUEST: FinanceMarketCollectionRequest = {
  instrument: "AAPL",
  assetClass: "us_equity",
  collection: "news",
  asOf: "2026-09-07T14:00:00.000Z",
  fromDate: "2026-09-06",
  toDate: "2026-09-07",
  limit: 10,
};

const MACRO_REQUEST: FinanceMarketCollectionRequest = {
  instrument: "CUSR0000SA0",
  assetClass: "macro_series",
  collection: "macro_series",
  seriesId: "CUSR0000SA0",
  asOf: "2026-09-07T14:00:00.000Z",
  limit: 3,
};

function fakeFetch(url: string): ReturnType<FetchImpl> {
  if (url.includes("massive.com/v2/reference/news")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [{ id: "news-1", title: "AAPL report", published_utc: "2026-09-07T13:00:00Z" }],
        }),
    });
  }
  if (url.includes("massive.com/v3/snapshot/options")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [
            {
              details: { ticker: "O:AAPL261016C00320000", contract_type: "call" },
              implied_volatility: 0.25,
              last_quote: { bid: 1, ask: 2, last_updated: 1788780000000000000 },
              open_interest: 100,
            },
          ],
        }),
    });
  }
  if (url.includes("massive.com/v3/reference/dividends")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [
            { id: "div-1", ticker: "AAPL", ex_dividend_date: "2026-08-08", cash_amount: 0.25 },
          ],
        }),
    });
  }
  if (url.includes("massive.com/stocks/v1/splits")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [
            {
              id: "split-1",
              ticker: "AAPL",
              execution_date: "2020-08-31",
              split_from: 1,
              split_to: 4,
            },
          ],
        }),
    });
  }
  if (url.includes("finnhub.io/api/v1/company-news")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ id: 2, headline: "cross-check", datetime: 1788780000 }]),
    });
  }
  if (url.includes("api.gdeltproject.org/api/v2/doc/doc")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          articles: [
            {
              url: "https://example.test/aapl-news",
              title: "AAPL public news",
              seendate: "20260907T130000Z",
            },
          ],
        }),
    });
  }
  if (url.includes("financialmodelingprep.com/api/v3/profile/AAPL")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ symbol: "AAPL", companyName: "Apple Inc." }]),
    });
  }
  if (url.includes("financialmodelingprep.com/api/v3/historical-price-full/AAPL")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ historical: [{ date: "2026-09-04", close: 250 }] }),
    });
  }
  if (url.includes("api.bls.gov")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: "REQUEST_SUCCEEDED",
          Results: {
            series: [
              { seriesID: "CUSR0000SA0", data: [{ year: "2026", period: "M07", value: "321.5" }] },
            ],
          },
        }),
    });
  }
  if (url.includes("fiscaldata.treasury.gov")) {
    if (url.includes("avg_interest_rates")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              {
                record_date: "2026-09-04",
                security_desc: "Treasury Bills",
                avg_interest_rate_amt: "3.788",
              },
            ],
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: [{ record_date: "2026-09-04", tot_pub_debt_out_amt: "100" }] }),
    });
  }
  if (url.includes("www.sec.gov/files/company_tickers.json")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL" } }),
    });
  }
  if (url.includes("data.sec.gov/submissions/CIK0000320193.json")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          name: "Apple Inc.",
          filings: {
            recent: {
              accessionNumber: ["0000320193-26-000001"],
              filingDate: ["2026-08-01"],
              reportDate: ["2026-06-30"],
              acceptanceDateTime: ["2026-08-01T16:00:00.000Z"],
              form: ["10-Q"],
              primaryDocument: ["aapl-20260630.htm"],
              primaryDocDescription: ["Quarterly report"],
              act: ["34"],
              fileNumber: ["001-36743"],
              filmNumber: ["261234567"],
            },
          },
        }),
    });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ observations: [{ date: "2026-09-01", value: "321.5" }] }),
  });
}

describe("finance market collection registry", () => {
  it("collects US equity news, options, dividends, and splits with source timestamps", async () => {
    const adapters = [
      createMassiveNewsCollectionAdapter({ apiKey: "massive-secret", fetchImpl: fakeFetch }),
      createMassiveOptionsChainCollectionAdapter({
        apiKey: "massive-secret",
        fetchImpl: fakeFetch,
      }),
      createMassiveDividendsCollectionAdapter({ apiKey: "massive-secret", fetchImpl: fakeFetch }),
      createMassiveSplitsCollectionAdapter({ apiKey: "massive-secret", fetchImpl: fakeFetch }),
      createFinnhubNewsCollectionAdapter({ apiKey: "finnhub-secret", fetchImpl: fakeFetch }),
    ];
    for (const [collection, adapter] of [
      ["news", adapters[0]],
      ["options_chain", adapters[1]],
      ["dividends", adapters[2]],
      ["splits", adapters[3]],
    ] as const) {
      const records = await adapter.collect(
        { ...EQUITY_REQUEST, collection },
        new AbortController().signal,
      );
      expect(records).toHaveLength(1);
      expect(records[0]?.sourceTimestamp).toMatch(/2026|2020/);
      expect(records[0]?.sourceUrlOrArtifact).not.toContain("secret");
    }
    const news = await adapters[4].collect(EQUITY_REQUEST, new AbortController().signal);
    expect(news[0]?.providerRole).toBe("cross_check_market_data");
  });

  it("collects official BLS, Treasury, and keyed FRED macro records", async () => {
    const adapters = [
      createBlsMacroSeriesCollectionAdapter({ fetchImpl: fakeFetch }),
      createTreasuryDebtCollectionAdapter({ fetchImpl: fakeFetch }),
      createFredMacroSeriesCollectionAdapter({ apiKey: "fred-secret", fetchImpl: fakeFetch }),
    ];
    const bls = await adapters[0].collect(MACRO_REQUEST, new AbortController().signal);
    const treasury = await adapters[1].collect(
      { ...MACRO_REQUEST, instrument: "debt_to_penny", seriesId: "debt_to_penny" },
      new AbortController().signal,
    );
    const fred = await adapters[2].collect(MACRO_REQUEST, new AbortController().signal);
    expect(bls[0]?.sourceFamily).toBe("official_macro_data");
    expect(treasury[0]?.data).toEqual(expect.objectContaining({ record_date: "2026-09-04" }));
    expect(fred[0]?.sourceUrlOrArtifact).not.toContain("fred-secret");
  });

  it("collects official Treasury average rates and SEC filing metadata", async () => {
    const rates = await createTreasuryAverageInterestRatesCollectionAdapter({
      fetchImpl: fakeFetch,
    }).collect(
      { ...MACRO_REQUEST, instrument: "avg_interest_rates", seriesId: "avg_interest_rates" },
      new AbortController().signal,
    );
    const filings = await createSecFilingsCollectionAdapter({ fetchImpl: fakeFetch }).collect(
      { ...EQUITY_REQUEST, collection: "sec_filings" },
      new AbortController().signal,
    );
    expect(rates[0]?.providerName).toBe("treasury-fiscal-average-interest-rates");
    expect(rates[0]?.sourceFamily).toBe("official_macro_data");
    expect(filings[0]?.providerName).toBe("sec-edgar-filings");
    expect(filings[0]?.sourceFamily).toBe("official_filing");
    expect(filings[0]?.sourceUrlOrArtifact).toContain("sec.gov/Archives/edgar/data/320193");
  });

  it("collects public GDELT news and only the free FMP Basic surfaces", async () => {
    const gdelt = await createGdeltPublicNewsCollectionAdapter({ fetchImpl: fakeFetch }).collect(
      EQUITY_REQUEST,
      new AbortController().signal,
    );
    const profile = await createFmpFreeBasicProfileCollectionAdapter({
      apiKey: "fmp-secret",
      fetchImpl: fakeFetch,
    }).collect({ ...EQUITY_REQUEST, collection: "company_profile" }, new AbortController().signal);
    const eod = await createFmpFreeBasicEodCollectionAdapter({
      apiKey: "fmp-secret",
      fetchImpl: fakeFetch,
    }).collect({ ...EQUITY_REQUEST, collection: "eod_history" }, new AbortController().signal);
    expect(gdelt[0]?.sourceTimestamp).toBe("2026-09-07T13:00:00.000Z");
    expect(profile[0]?.delayStatus).toBe("manual_or_unknown");
    expect(eod[0]?.delayStatus).toBe("end_of_day");
    expect(eod[0]?.sourceUrlOrArtifact).not.toContain("fmp-secret");
  });

  it("keeps collection failures visible instead of declaring a partial run ready", async () => {
    const receipt = await runFinanceMarketCollectionRefresh({
      request: EQUITY_REQUEST,
      adapters: [
        createMassiveNewsCollectionAdapter({ apiKey: "key", fetchImpl: fakeFetch }),
        {
          id: "failing-cross-check",
          providerName: "failing-cross-check",
          providerRole: "cross_check_market_data",
          priority: 1,
          supports: (request) => request.collection === "news",
          collect: async () => {
            throw new Error("429");
          },
        },
      ],
    });
    expect(receipt.status).toBe("needs_review");
    expect(receipt.records).toHaveLength(1);
    expect(receipt.sourceAttempts).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed", error: "429" })]),
    );
    expect(receipt.notTouched).toContain("trading_execution");
  });

  it("reports environment-backed providers without exposing credential values", () => {
    const options = resolveFinanceMarketCollectionRegistryOptionsFromEnv({
      MASSIVE_API_KEY: "massive-secret",
      FINNHUB_API_KEY: "finnhub-secret",
      FRED_API_KEY: "fred-secret",
      FMP_API_KEY: "fmp-secret",
    });
    const inspection = inspectFinanceMarketCollectionRegistry(
      EQUITY_REQUEST,
      createFinanceMarketCollectionRegistry(options),
    );
    expect(inspection.candidateAdapters.map((adapter) => adapter.id)).toEqual([
      "massive_us_equity_news",
      "finnhub_us_equity_news",
      "gdelt_public_news",
    ]);
    expect(JSON.stringify(inspection)).not.toContain("secret");
    const fmpInspection = inspectFinanceMarketCollectionRegistry(
      { ...EQUITY_REQUEST, collection: "company_profile" },
      createFinanceMarketCollectionRegistry(options),
    );
    expect(fmpInspection.candidateAdapters.map((adapter) => adapter.id)).toEqual([
      "fmp_free_basic_company_profile",
    ]);
  });

  it("returns a blocked receipt when no optional collection provider is configured", async () => {
    const receipt = await runFinanceMarketCollectionRefresh({
      request: { ...EQUITY_REQUEST, collection: "options_chain" },
      adapters: createFinanceMarketCollectionRegistry(),
    });
    expect(receipt.status).toBe("blocked");
    expect(receipt.records).toHaveLength(0);
    expect(receipt.missingEvidence).toContain("successful_finance_market_collection");
  });

  it("routes Treasury debt requests only to Treasury rather than BLS", () => {
    const inspection = inspectFinanceMarketCollectionRegistry(
      { ...MACRO_REQUEST, instrument: "debt_to_penny", seriesId: "debt_to_penny" },
      createFinanceMarketCollectionRegistry(),
    );
    expect(inspection.candidateAdapters.map((adapter) => adapter.id)).toEqual([
      "treasury_fiscal_debt_to_penny",
    ]);
  });

  it("routes Treasury average rates only to Treasury rather than BLS", () => {
    const inspection = inspectFinanceMarketCollectionRegistry(
      { ...MACRO_REQUEST, instrument: "avg_interest_rates", seriesId: "avg_interest_rates" },
      createFinanceMarketCollectionRegistry(),
    );
    expect(inspection.candidateAdapters.map((adapter) => adapter.id)).toEqual([
      "treasury_fiscal_average_interest_rates",
    ]);
  });
});
