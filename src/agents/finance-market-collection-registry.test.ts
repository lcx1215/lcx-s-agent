import { describe, expect, it } from "vitest";
import type { FetchImpl } from "./finance-live-market-source.js";
import {
  createBlsMacroSeriesCollectionAdapter,
  createFinnhubNewsCollectionAdapter,
  createFredMacroSeriesCollectionAdapter,
  createFredPublicIndexHistoryCollectionAdapter,
  createFmpFreeBasicEodCollectionAdapter,
  createFmpFreeBasicProfileCollectionAdapter,
  createGdeltPublicNewsCollectionAdapter,
  createGoogleNewsRssCollectionAdapter,
  createSecFilingsCollectionAdapter,
  createMassiveDividendsCollectionAdapter,
  createMassiveNewsCollectionAdapter,
  createMassiveOptionsChainCollectionAdapter,
  createMassiveSplitsCollectionAdapter,
  createTreasuryDebtCollectionAdapter,
  createTreasuryAverageInterestRatesCollectionAdapter,
  createYahooPublicEodHistoryCollectionAdapter,
  createYahooFinanceRssCollectionAdapter,
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
  if (url.includes("news.google.com/rss/search")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        `<?xml version="1.0"?><rss><channel><item><title>Google AAPL</title><link>https://example.test/google-aapl</link><description><![CDATA[Google description]]></description><pubDate>Mon, 07 Sep 2026 13:00:00 GMT</pubDate><source>Example Wire</source></item></channel></rss>`,
    });
  }
  if (url.includes("feeds.finance.yahoo.com/rss/2.0/headline")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        `<?xml version="1.0"?><rss><channel><item><title>Yahoo AAPL</title><link>https://example.test/yahoo-aapl</link><description>Yahoo description</description><pubDate>Mon, 07 Sep 2026 12:00:00 GMT</pubDate><source>Yahoo Finance</source></item></channel></rss>`,
    });
  }
  if (url.includes("query2.finance.yahoo.com/v8/finance/chart/AAPL")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          chart: {
            result: [
              {
                meta: { instrumentType: "EQUITY", currency: "USD" },
                timestamp: [1788523200, 1788609600, 1788696000],
                indicators: {
                  quote: [
                    {
                      open: [245, 248, null],
                      high: [250, 252, 255],
                      low: [244, 247, 251],
                      close: [249, 251, 254],
                      volume: [1000, 1100, 1200],
                    },
                  ],
                },
              },
            ],
            error: null,
          },
        }),
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
  if (url.includes("financialmodelingprep.com/stable/profile?symbol=AAPL")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ symbol: "AAPL", companyName: "Apple Inc." }]),
    });
  }
  if (url.includes("financialmodelingprep.com/stable/historical-price-eod/full?symbol=AAPL")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ date: "2026-09-04", close: 250 }]),
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

  it("maps the BLS annual-average period to the end of its observation year", async () => {
    const adapter = createBlsMacroSeriesCollectionAdapter({
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: "REQUEST_SUCCEEDED",
              Results: {
                series: [
                  {
                    seriesID: "CUSR0000SA0",
                    data: [{ year: "2026", period: "M13", value: "321.5" }],
                  },
                ],
              },
            }),
        }) as Awaited<ReturnType<FetchImpl>>,
    });
    const records = await adapter.collect(MACRO_REQUEST, new AbortController().signal);
    expect(records[0]?.sourceTimestamp).toBe("2026-12-31T00:00:00.000Z");
  });

  it("rejects unsupported BLS observation periods instead of inventing a January date", async () => {
    const adapter = createBlsMacroSeriesCollectionAdapter({
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: "REQUEST_SUCCEEDED",
              Results: {
                series: [{ seriesID: "CUSR0000SA0", data: [{ year: "2026", period: "A01" }] }],
              },
            }),
        }) as Awaited<ReturnType<FetchImpl>>,
    });
    await expect(adapter.collect(MACRO_REQUEST, new AbortController().signal)).rejects.toThrow(
      "unsupported BLS observation period",
    );
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

  it("collects public RSS news without retaining article bodies", async () => {
    const google = await createGoogleNewsRssCollectionAdapter({ fetchImpl: fakeFetch }).collect(
      EQUITY_REQUEST,
      new AbortController().signal,
    );
    const yahoo = await createYahooFinanceRssCollectionAdapter({ fetchImpl: fakeFetch }).collect(
      EQUITY_REQUEST,
      new AbortController().signal,
    );
    expect(google[0]?.providerName).toBe("google-news-rss");
    expect(google[0]?.sourceTimestamp).toBe("2026-09-07T13:00:00.000Z");
    expect(google[0]?.data).toEqual(expect.objectContaining({ title: "Google AAPL" }));
    expect(yahoo[0]?.providerName).toBe("yahoo-finance-rss");
    expect(yahoo[0]?.sourceTimestamp).toBe("2026-09-07T12:00:00.000Z");
  });

  it("drops RSS items without valid provider timestamps", async () => {
    const adapter = createGoogleNewsRssCollectionAdapter({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          `<?xml version="1.0"?><rss><channel><item><title>Untimestamped AAPL</title><link>https://example.test/missing</link></item><item><title>Timestamped AAPL</title><link>https://example.test/valid</link><pubDate>Mon, 07 Sep 2026 13:00:00 GMT</pubDate></item></channel></rss>`,
      }),
    });

    const records = await adapter.collect(EQUITY_REQUEST, new AbortController().signal);

    expect(records).toHaveLength(1);
    expect(records[0]?.itemId).toBe("https://example.test/valid");
  });

  it("encodes an explicit GDELT news window", async () => {
    let requestedUrl = "";
    const adapter = createGdeltPublicNewsCollectionAdapter({
      fetchImpl: async (url) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              articles: [
                { url: "https://example.test/aapl-window", seendate: "20260907T130000Z" },
                { url: "https://example.test/aapl-future", seendate: "20260908T130000Z" },
                { url: "https://example.test/aapl-undated" },
              ],
            }),
        };
      },
    });

    const records = await adapter.collect(
      { ...EQUITY_REQUEST, fromDate: "2026-09-01", toDate: "2026-09-07" },
      new AbortController().signal,
    );

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("startdatetime")).toBe("20260901000000");
    expect(url.searchParams.get("enddatetime")).toBe("20260907235959");
    expect(url.searchParams.get("timespan")).toBeNull();
    expect(records).toHaveLength(1);
    expect(records[0]?.itemId).toBe("https://example.test/aapl-window");
  });

  it("collects public Yahoo EOD bars and drops incomplete rows", async () => {
    const bars = await createYahooPublicEodHistoryCollectionAdapter({
      fetchImpl: fakeFetch,
    }).collect({ ...EQUITY_REQUEST, collection: "eod_history" }, new AbortController().signal);
    expect(bars).toHaveLength(2);
    expect(bars[0]?.providerName).toBe("yahoo-public-eod-history");
    expect(bars[0]?.delayStatus).toBe("end_of_day");
    expect(bars[0]?.data).toEqual(
      expect.objectContaining({
        symbol: "AAPL",
        open: 245,
        close: 249,
        volume: 1000,
        instrumentType: "equity",
        unit: "USD",
      }),
    );
    expect(bars[0]?.sourceUrlOrArtifact).toContain("period1=");
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

  it("does not mark records outside the requested historical window ready", async () => {
    const receipt = await runFinanceMarketCollectionRefresh({
      request: EQUITY_REQUEST,
      adapters: [
        {
          id: "out-of-window",
          providerName: "out-of-window",
          providerRole: "primary_market_data",
          priority: 1,
          supports: () => true,
          collect: async () => [
            {
              itemId: "future-news",
              collection: "news",
              providerName: "out-of-window",
              providerRole: "primary_market_data",
              sourceFamily: "market_data_api",
              sourceTimestamp: "2026-09-08T13:00:00.000Z",
              observedAt: "2026-09-08T13:00:00.000Z",
              delayStatus: "realtime",
              sourceUrlOrArtifact: "fixture://out-of-window",
              data: { title: "future evidence" },
            },
          ],
        },
      ],
    });

    expect(receipt.status).toBe("needs_review");
    expect(receipt.missingEvidence).toContain("timestamped_records_within_requested_window");
    expect(receipt.requiredNextSteps).toContain("inspect_out_of_window_collection_records");
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
      "gdelt_public_news_titles",
      "google_news_rss",
      "fmp_news_press_releases",
      "fmp_news_stock",
    ]);
    expect(
      inspectFinanceMarketCollectionRegistry(
        EQUITY_REQUEST,
        createFinanceMarketCollectionRegistry({ ...options, includeYahooPublicSources: true }),
      ).candidateAdapters.map((adapter) => adapter.id),
    ).toEqual([
      "massive_us_equity_news",
      "finnhub_us_equity_news",
      "gdelt_public_news",
      "gdelt_public_news_titles",
      "google_news_rss",
      "yahoo_finance_rss",
      "fmp_news_press_releases",
      "fmp_news_stock",
    ]);
    expect(JSON.stringify(inspection)).not.toContain("secret");
    const fmpInspection = inspectFinanceMarketCollectionRegistry(
      { ...EQUITY_REQUEST, collection: "company_profile" },
      createFinanceMarketCollectionRegistry(options),
    );
    expect(fmpInspection.candidateAdapters.map((adapter) => adapter.id)).toEqual([
      "fmp_free_basic_company_profile",
      "finnhub_metric",
      "finnhub_profile2",
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

describe("market collection API transport governance", () => {
  it("aborts keyed HTTP and keeps credentials out of the failed receipt", async () => {
    let httpSignal: AbortSignal | undefined;
    const source = createMassiveNewsCollectionAdapter({
      apiKey: "fake-private-key",
      fetchImpl: async (_url, init) => {
        httpSignal = init?.signal;
        return new Promise(() => {});
      },
    });
    const receipt = await runFinanceMarketCollectionRefresh({
      request: EQUITY_REQUEST,
      adapters: [source],
      timeoutMs: 10,
    });
    expect(httpSignal?.aborted).toBe(true);
    expect(receipt.sourceAttempts[0].apiCalls).toEqual([
      expect.objectContaining({ operation: "http_get", status: "timed_out" }),
      expect.objectContaining({ operation: "collect", status: "timed_out" }),
    ]);
    expect(JSON.stringify(receipt)).not.toContain("fake-private-key");
  });

  it("records HTTP success separately from invalid source data", async () => {
    const source = createMassiveNewsCollectionAdapter({
      apiKey: "fake-private-key",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "invalid" }),
    });
    const receipt = await runFinanceMarketCollectionRefresh({
      request: EQUITY_REQUEST,
      adapters: [source],
    });
    expect(receipt.status).toBe("blocked");
    expect(receipt.sourceAttempts[0].apiCalls).toEqual([
      expect.objectContaining({ operation: "http_get", status: "succeeded", httpStatus: 200 }),
      expect.objectContaining({
        operation: "collect",
        status: "failed",
        transportError: "source_error",
      }),
    ]);
  });

  it("redacts arbitrary adapter errors and does not enable keyed adapters without keys", async () => {
    expect(
      createFinanceMarketCollectionRegistry({}).some((a) => a.id === "massive_us_equity_news"),
    ).toBe(false);
    const source = {
      ...createMassiveNewsCollectionAdapter({ apiKey: "fake-private-key" }),
      collect: async () => {
        throw new Error("https://example.test?token=fake-private-key");
      },
    };
    const receipt = await runFinanceMarketCollectionRefresh({
      request: EQUITY_REQUEST,
      adapters: [source],
    });
    expect(JSON.stringify(receipt)).not.toContain("fake-private-key");
    expect(receipt.sourceAttempts[0].error).toBe("source_error");
  });
});

describe("public FRED index history", () => {
  const request = {
    ...EQUITY_REQUEST,
    instrument: "SP500",
    collection: "eod_history" as const,
    fromDate: "2026-09-03",
    toDate: "2026-09-04",
    asOf: "2026-09-05T00:00:00Z",
  };
  it("keeps index units explicit and does not silently substitute an ETF", async () => {
    const adapter = createFredPublicIndexHistoryCollectionAdapter({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => "observation_date,SP500\n2026-09-03,6500\n2026-09-04,.\n",
      }),
    });
    expect(adapter.supports(request)).toBe(true);
    expect(adapter.supports({ ...request, instrument: "SPY" })).toBe(false);
    const rows = await adapter.collect(request, new AbortController().signal);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({
      close: 6500,
      unit: "index_points",
      instrumentType: "index",
    });
  });
  it("rejects invalid schemas, values, range leaks, and unfinished dates", async () => {
    for (const body of [
      "Date,Close\n2026-09-03,6500",
      "observation_date,SP500\n2026-09-03,NaN",
      "observation_date,SP500\n2026-09-02,6500",
    ]) {
      const adapter = createFredPublicIndexHistoryCollectionAdapter({
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => body,
        }),
      });
      await expect(adapter.collect(request, new AbortController().signal)).rejects.toThrow();
    }
    const adapter = createFredPublicIndexHistoryCollectionAdapter();
    await expect(
      adapter.collect({ ...request, asOf: "2026-09-04T12:00:00Z" }, new AbortController().signal),
    ).rejects.toThrow("completed days");
  });
});

it("uses the FRED v1 api_key parameter and excludes it from provenance", async () => {
  let requested: URL | undefined;
  const adapter = createFredMacroSeriesCollectionAdapter({
    apiKey: "fixture-fred-key",
    fetchImpl: async (url) => {
      requested = new URL(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ observations: [{ date: "2026-08-01", value: "3.5" }] }),
      };
    },
  });
  const records = await adapter.collect(
    { ...MACRO_REQUEST, instrument: "FEDFUNDS", seriesId: "FEDFUNDS" },
    new AbortController().signal,
  );
  expect(requested?.searchParams.get("api_key")).toBe("fixture-fred-key");
  expect(requested?.searchParams.has("apiKey")).toBe(false);
  expect(records[0].sourceUrlOrArtifact).not.toContain("fixture-fred-key");
});
