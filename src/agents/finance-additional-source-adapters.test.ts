import { describe, expect, it, vi } from "vitest";
import { ApiCallError } from "./api-call-contract.js";
import {
  createAlphaVantageMarketAdapter,
  createInvescoIssuerReferenceAdapter,
  createNasdaqExchangeMarketAdapter,
  parseNasdaqTradeTimestamp,
  createSecOfficialReferenceAdapter,
  createStooqDelayedMarketAdapter,
  parseAlphaVantageGlobalQuote,
  parseStooqDailyCsv,
} from "./finance-additional-source-adapters.js";
import type { FetchImpl } from "./finance-live-market-source.js";
import {
  createYahooDelayedMarketAdapter,
  runFinanceRealtimeRefresh,
} from "./finance-realtime-source-registry.js";
import { createFinanceRealtimeRefreshTool } from "./tools/finance-realtime-refresh-tool.js";

vi.stubEnv("LCX_ENABLE_YAHOO_PUBLIC_SOURCE", "1");

const REQUEST = {
  instrument: "QQQ",
  assetClass: "etf",
  useCase: "additional_source_adapter_test",
  asOf: "2026-09-07T10:15:00.000Z",
} as const;

describe("additional finance source adapters", () => {
  it("preserves an inner transport timeout before the source deadline", async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new ApiCallError("timeout");
    };
    const receipt = await runFinanceRealtimeRefresh({
      request: REQUEST,
      adapters: [
        createNasdaqExchangeMarketAdapter({ fetchImpl }),
        createStooqDelayedMarketAdapter({ fetchImpl }),
      ],
      timeoutMs: 5_000,
      retry: { attempts: 1 },
    });
    expect(receipt.sourceAttempts.map((attempt) => attempt.error)).toEqual([
      "API timeout",
      "API timeout",
    ]);
    expect(receipt.sourceAttempts.every((attempt) => attempt.status === "failed")).toBe(true);
    expect(receipt.snapshot).toBeUndefined();
  });

  it("parses a Stooq daily response and rejects challenge HTML", () => {
    const observation = parseStooqDailyCsv(
      "Date,Open,High,Low,Close,Volume\n2026-09-04,717,720,715,718.96,123456",
      "QQQ",
      "https://stooq.com/q/d/l/?s=qqq.us&i=d",
      REQUEST.asOf,
    );
    expect(observation.providerRole).toBe("cross_check_market_data");
    expect(observation.fields[0]).toEqual(
      expect.objectContaining({ value: 718.96, sourceTimestamp: "2026-09-04T00:00:00.000Z" }),
    );
    expect(() =>
      parseStooqDailyCsv("<html>verify browser</html>", "QQQ", "https://stooq.com"),
    ).toThrow("no usable daily CSV");
  });

  it("parses Alpha Vantage as an explicitly keyed end-of-day cross-check", () => {
    const observation = parseAlphaVantageGlobalQuote(
      {
        "Global Quote": {
          "01. symbol": "QQQ",
          "05. price": "718.96",
          "07. latest trading day": "2026-09-04",
        },
      },
      "QQQ",
      "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=QQQ",
      REQUEST.asOf,
    );
    expect(observation.providerName).toBe("alpha-vantage-global-quote");
    expect(observation.delayStatus).toBe("end_of_day");
    expect(observation.fields[0]?.value).toBe(718.96);
  });

  it.each([
    { instrument: "AAPL", assetClass: "us_equity", route: "stocks" },
    { instrument: "QQQ", assetClass: "etf", route: "etfs" },
  ])(
    "normalizes the public Nasdaq $assetClass quote as an independent cross-check",
    async ({ instrument, assetClass, route }) => {
      let requestedUrl = "";
      const fetchImpl: FetchImpl = async (input) => {
        requestedUrl = String(input);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: {
                primaryData: {
                  lastSalePrice: "$718.96",
                  lastTradeTimestamp: "Sep 3, 2026",
                  isRealTime: false,
                },
              },
            }),
        };
      };
      const adapter = createNasdaqExchangeMarketAdapter({ fetchImpl });
      expect(adapter.sampleRequest).toEqual({ instrument: "AAPL", assetClass: "us_equity" });
      const observation = await adapter.collect(
        { ...REQUEST, instrument, assetClass },
        new AbortController().signal,
      );
      expect(requestedUrl).toContain(`/quote/${instrument}/info?assetclass=${route}`);
      expect(observation.providerRole).toBe("cross_check_market_data");
      expect(observation.fields[0]).toEqual(
        expect.objectContaining({
          name: "last_price",
          value: 718.96,
          sourceTimestamp: "2026-09-03T00:00:00.000Z",
        }),
      );
    },
  );

  it("fetches SEC official filing evidence without importing a credential", async () => {
    const fetchImpl: FetchImpl = async () => {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            name: "INVESCO QQQ TRUST, SERIES 1",
            filings: { recent: { filingDate: ["2026-08-31"], form: ["NPORT-P"] } },
          }),
      };
    };
    const observation = await createSecOfficialReferenceAdapter({ fetchImpl }).collect(
      REQUEST,
      new AbortController().signal,
    );
    expect(observation.sourceFamily).toBe("official_filing");
    expect(observation.providerRole).toBe("official_or_issuer_reference");
    expect(observation.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "latest_official_filing_date", value: "2026-08-31" }),
      ]),
    );
  });

  it("fetches an issuer reference through the Invesco endpoint", async () => {
    const fetchImpl: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          effectiveDate: "2026-08-31",
          cumulativePerformance: [{ label: "marketPrice", ytd: 16.98 }],
        }),
    });
    const observation = await createInvescoIssuerReferenceAdapter({ fetchImpl }).collect(
      REQUEST,
      new AbortController().signal,
    );
    expect(observation.sourceFamily).toBe("etf_issuer");
    expect(observation.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "issuer_market_price_ytd_return_percent",
          value: 16.98,
        }),
      ]),
    );
  });

  it("requires an explicit Alpha Vantage key", () => {
    expect(() => createAlphaVantageMarketAdapter({ apiKey: "   " })).toThrow("apiKey required");
    const adapter = createAlphaVantageMarketAdapter({ apiKey: "test-key" });
    expect(adapter.providerRole).toBe("cross_check_market_data");
  });

  it("exposes Stooq as an independent source even when its current endpoint is challenged", () => {
    const adapter = createStooqDelayedMarketAdapter();
    expect(adapter.id).toBe("stooq_public_daily");
    expect(adapter.providerName).not.toBe("yahoo-public-chart");
  });
});

it("parses observed Nasdaq ET intraday timestamps with summer and winter offsets", () => {
  expect(parseNasdaqTradeTimestamp("Sep 8, 2026 7:48 AM ET")).toBe("2026-09-08T11:48:00.000Z");
  expect(parseNasdaqTradeTimestamp("Jan 8, 2026 4:00 PM ET")).toBe("2026-01-08T21:00:00.000Z");
  expect(() => parseNasdaqTradeTimestamp("Nov 1, 2026 1:30 AM ET")).toThrow("ambiguous");
  expect(() => parseNasdaqTradeTimestamp("Mar 8, 2026 2:30 AM ET")).toThrow("invalid");
});

it("anchors date-only Nasdaq timestamps to the UTC calendar date", () => {
  expect(parseNasdaqTradeTimestamp("2026-01-02")).toBe("2026-01-02T00:00:00.000Z");
});

describe("additional source market contracts", () => {
  it.each([
    { instrument: "EURUSD=X", assetClass: "fx" },
    { instrument: "0700.HK", assetClass: "hk_equity" },
    { instrument: "600519.SS", assetClass: "cn_equity" },
  ])(
    "does not advertise USD stock fallbacks for $instrument in the original tool",
    async (market) => {
      vi.stubEnv("LCX_ENABLE_YAHOO_PUBLIC_SOURCE", "1");
      const fetchImpl = vi.fn<FetchImpl>();
      const result = await createFinanceRealtimeRefreshTool({
        workspaceDir: "/tmp/offline-market-contract",
        fetchImpl,
      }).execute("market-inspection", {
        ...REQUEST,
        ...market,
        liveFetch: false,
        writeReceipt: false,
      });
      const inspection = result.details as {
        candidateAdapters: Array<{ id: string }>;
        noNetworkCalled: boolean;
      };
      expect(inspection.candidateAdapters.map((adapter) => adapter.id)).not.toContain(
        "nasdaq_exchange_quote",
      );
      expect(inspection.candidateAdapters.map((adapter) => adapter.id)).not.toContain(
        "stooq_public_daily",
      );
      expect(inspection.candidateAdapters.map((adapter) => adapter.id)).toContain(
        "yahoo_public_chart",
      );
      expect(inspection.noNetworkCalled).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    { instrument: "EURUSD=X", assetClass: "fx" },
    { instrument: "0700.HK", assetClass: "etf" },
    { instrument: "600519.SS", assetClass: "equity" },
  ])("guards direct Nasdaq/Stooq collection before HTTP for $instrument", async (market) => {
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "invalid-for-market" });
    for (const adapter of [
      createNasdaqExchangeMarketAdapter({ fetchImpl }),
      createStooqDelayedMarketAdapter({ fetchImpl }),
    ]) {
      expect(adapter.supports({ ...REQUEST, ...market })).toBe(false);
      await expect(
        adapter.collect({ ...REQUEST, ...market }, new AbortController().signal),
      ).rejects.toThrow("unsupported");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("excludes FX and non-stock routes from the original GLOBAL_QUOTE adapter", async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const adapter = createAlphaVantageMarketAdapter({ apiKey: "offline-key", fetchImpl });
    for (const market of [
      { instrument: "EURUSD=X", assetClass: "fx" },
      { instrument: "BTC", assetClass: "crypto" },
      { instrument: "^GSPC", assetClass: "index" },
    ]) {
      expect(adapter.supports({ ...REQUEST, ...market })).toBe(false);
      await expect(
        adapter.collect({ ...REQUEST, ...market }, new AbortController().signal),
      ).rejects.toThrow("unsupported");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps native US and explicit Stooq .us requests on their existing one-request path", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "Date,Open,High,Low,Close,Volume\n2026-09-04,1,2,1,2,10",
    });
    const stooq = createStooqDelayedMarketAdapter({ fetchImpl });
    for (const instrument of ["AAPL", "AAPL.US"]) {
      expect(stooq.supports({ ...REQUEST, instrument, assetClass: "us_equity" })).toBe(true);
      expect(
        (
          await stooq.collect(
            { ...REQUEST, instrument, assetClass: "us_equity" },
            new AbortController().signal,
          )
        ).fields[0]?.currency,
      ).toBe("USD");
    }
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://stooq.com/q/d/l/?s=aapl.us&i=d",
      "https://stooq.com/q/d/l/?s=aapl.us&i=d",
    ]);
    fetchImpl.mockClear().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          "Global Quote": {
            "01. symbol": "AAPL",
            "05. price": "2",
            "07. latest trading day": "2026-09-04",
          },
        }),
    });
    const alpha = createAlphaVantageMarketAdapter({ apiKey: "offline-key", fetchImpl });
    expect(
      (
        await alpha.collect(
          { ...REQUEST, instrument: "AAPL", assetClass: "us_equity" },
          new AbortController().signal,
        )
      ).fields[0]?.currency,
    ).toBe("USD");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("function=GLOBAL_QUOTE");
  });

  it.each([
    { symbol: "300135.SHZ", assetClass: "cn_equity", currency: "CNY", timezone: "UTC+08" },
    { symbol: "LLOY.LON", assetClass: "uk_equity", currency: "GBX", timezone: "UTC+01" },
    { symbol: "LLOYDSTEEL.BSE", assetClass: "in_equity", currency: "INR", timezone: "UTC+5.5" },
  ])(
    "binds $symbol to its exact symbol metadata instead of USD",
    async ({ symbol, assetClass, currency, timezone }) => {
      const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (url) => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            String(url).includes("SYMBOL_SEARCH")
              ? {
                  bestMatches: [
                    {
                      "1. symbol": "300135.SHX",
                      "7. timezone": "UTC-05",
                      "8. currency": "USD",
                      "9. matchScore": "1.0000",
                    },
                    {
                      "1. symbol": symbol,
                      "3. type": "Equity",
                      "7. timezone": timezone,
                      "8. currency": currency,
                      "9. matchScore": "0.5000",
                    },
                  ],
                }
              : {
                  "Global Quote": {
                    "01. symbol": symbol,
                    "05. price": "12.5",
                    "07. latest trading day": "2026-09-04",
                  },
                },
          ),
      }));
      const adapter = createAlphaVantageMarketAdapter({ apiKey: "offline-key", fetchImpl });
      const request = { ...REQUEST, instrument: symbol, assetClass };
      expect(adapter.supports(request)).toBe(true);
      const observation = await adapter.collect(request, new AbortController().signal);
      expect(observation.fields[0]?.currency).toBe(currency);
      expect(observation.timezone).toBe(timezone);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(observation)).not.toContain("offline-key");
    },
  );

  it.each([
    {
      name: "missing exact symbol",
      matches: [{ "1. symbol": "300135.SHX", "7. timezone": "UTC+08", "8. currency": "CNY" }],
    },
    { name: "missing currency", matches: [{ "1. symbol": "300135.SHZ", "7. timezone": "UTC+08" }] },
    { name: "missing timezone", matches: [{ "1. symbol": "300135.SHZ", "8. currency": "CNY" }] },
    {
      name: "unknown currency",
      matches: [{ "1. symbol": "300135.SHZ", "7. timezone": "UTC+08", "8. currency": "ZZZ" }],
    },
    {
      name: "unknown timezone",
      matches: [{ "1. symbol": "300135.SHZ", "7. timezone": "unknown", "8. currency": "CNY" }],
    },
    {
      name: "conflicting metadata",
      matches: [
        { "1. symbol": "300135.SHZ", "7. timezone": "UTC+08", "8. currency": "CNY" },
        { "1. symbol": "300135.SHZ", "7. timezone": "UTC+08", "8. currency": "USD" },
      ],
    },
  ])("does not emit a currency-less global quote for $name", async ({ matches }) => {
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          String(url).includes("SYMBOL_SEARCH")
            ? { bestMatches: matches }
            : {
                "Global Quote": {
                  "01. symbol": "300135.SHZ",
                  "05. price": "12.5",
                  "07. latest trading day": "2026-09-04",
                },
              },
        ),
    }));
    await expect(
      createAlphaVantageMarketAdapter({ apiKey: "offline-key", fetchImpl }).collect(
        { ...REQUEST, instrument: "300135.SHZ", assetClass: "cn_equity" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("metadata");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails a forbidden metadata request without dispatching a quote", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    });
    await expect(
      createAlphaVantageMarketAdapter({ apiKey: "offline-key", fetchImpl }).collect(
        { ...REQUEST, instrument: "300135.SHZ", assetClass: "cn_equity" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "ApiCallError", kind: "forbidden", httpStatus: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("charges metadata and quote to the same original HTTP dispatch budget", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          bestMatches: [
            { "1. symbol": "300135.SHZ", "7. timezone": "UTC+08", "8. currency": "CNY" },
          ],
        }),
    });
    let reservations = 0;
    const receipt = await runFinanceRealtimeRefresh({
      request: { ...REQUEST, instrument: "300135.SHZ", assetClass: "cn_equity" },
      adapters: [createAlphaVantageMarketAdapter({ apiKey: "offline-key", fetchImpl })],
      beforeHttpDispatch: () => {
        if (++reservations > 1) {
          throw new Error("fixture original HTTP budget exhausted");
        }
      },
    });
    expect(reservations).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(receipt.sourceAttempts[0]?.status).toBe("failed");
    expect(receipt.snapshot).toBeUndefined();
  });

  it("aborts metadata at the original source deadline without starting the quote", async () => {
    let metadataSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (_url, init) => {
      metadataSignal = init?.signal;
      return new Promise(() => {});
    });
    const receipt = await runFinanceRealtimeRefresh({
      request: { ...REQUEST, instrument: "300135.SHZ", assetClass: "cn_equity" },
      adapters: [createAlphaVantageMarketAdapter({ apiKey: "offline-key", fetchImpl })],
      timeoutMs: 10,
      correlationId: "market-metadata-deadline",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(metadataSignal?.aborted).toBe(true);
    expect(receipt.sourceAttempts[0]?.apiCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "http_get",
          status: "timed_out",
          correlationId: "market-metadata-deadline",
        }),
        expect.objectContaining({ operation: "collect", status: "timed_out" }),
      ]),
    );
    expect(receipt.snapshot).toBeUndefined();
  });

  it("rejects a quote for a different global symbol after metadata binding", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          String(url).includes("SYMBOL_SEARCH")
            ? {
                bestMatches: [
                  { "1. symbol": "300135.SHZ", "7. timezone": "UTC+08", "8. currency": "CNY" },
                ],
              }
            : {
                "Global Quote": {
                  "01. symbol": "300135.SHX",
                  "05. price": "12.5",
                  "07. latest trading day": "2026-09-04",
                },
              },
        ),
    }));
    await expect(
      createAlphaVantageMarketAdapter({ apiKey: "offline-key", fetchImpl }).collect(
        { ...REQUEST, instrument: "300135.SHZ", assetClass: "cn_equity" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("symbol mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps a subsequent quote under the metadata's original deadline and correlation", async () => {
    let quoteSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (url, init) => {
      if (String(url).includes("SYMBOL_SEARCH")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              bestMatches: [
                { "1. symbol": "300135.SHZ", "7. timezone": "UTC+08", "8. currency": "CNY" },
              ],
            }),
        };
      }
      quoteSignal = init?.signal;
      return new Promise(() => {});
    });
    const receipt = await runFinanceRealtimeRefresh({
      request: { ...REQUEST, instrument: "300135.SHZ", assetClass: "cn_equity" },
      adapters: [createAlphaVantageMarketAdapter({ apiKey: "offline-key", fetchImpl })],
      timeoutMs: 10,
      correlationId: "market-total-deadline",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(quoteSignal?.aborted).toBe(true);
    expect(receipt.sourceAttempts[0]?.apiCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "http_get",
          status: "succeeded",
          correlationId: "market-total-deadline",
        }),
        expect.objectContaining({
          operation: "http_get",
          status: "timed_out",
          correlationId: "market-total-deadline",
        }),
        expect.objectContaining({ operation: "collect", status: "timed_out" }),
      ]),
    );
    expect(receipt.snapshot).toBeUndefined();
  });

  it("keeps Yahoo's declared cross-market formats usable", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  currency: "HKD",
                  regularMarketPrice: 12.5,
                  regularMarketTime: Date.parse(REQUEST.asOf) / 1000,
                },
              },
            ],
            error: null,
          },
        }),
    });
    const yahoo = createYahooDelayedMarketAdapter({ fetchImpl });
    for (const market of [
      { instrument: "EURUSD=X", assetClass: "fx" },
      { instrument: "0700.HK", assetClass: "hk_equity" },
      { instrument: "600519.SS", assetClass: "cn_equity" },
    ]) {
      expect(yahoo.supports({ ...REQUEST, ...market })).toBe(true);
    }
    const quote = await yahoo.collect(
      { ...REQUEST, instrument: "0700.HK", assetClass: "hk_equity" },
      new AbortController().signal,
    );
    expect(quote.fields[0]?.currency).toBe("HKD");
  });
});
