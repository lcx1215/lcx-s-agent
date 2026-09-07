import { describe, expect, it } from "vitest";
import type { FetchImpl } from "./finance-live-market-source.js";
import {
  createBlsMacroSeriesCollectionAdapter,
  createFinnhubNewsCollectionAdapter,
  createFredMacroSeriesCollectionAdapter,
  createMassiveDividendsCollectionAdapter,
  createMassiveNewsCollectionAdapter,
  createMassiveOptionsChainCollectionAdapter,
  createMassiveSplitsCollectionAdapter,
  createTreasuryDebtCollectionAdapter,
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
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: [{ record_date: "2026-09-04", tot_pub_debt_out_amt: "100" }] }),
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
    });
    const inspection = inspectFinanceMarketCollectionRegistry(
      EQUITY_REQUEST,
      createFinanceMarketCollectionRegistry(options),
    );
    expect(inspection.candidateAdapters.map((adapter) => adapter.id)).toEqual([
      "massive_us_equity_news",
      "finnhub_us_equity_news",
    ]);
    expect(JSON.stringify(inspection)).not.toContain("secret");
  });

  it("returns a blocked receipt when no optional collection provider is configured", async () => {
    const receipt = await runFinanceMarketCollectionRefresh({
      request: EQUITY_REQUEST,
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
});
