import { describe, expect, it } from "vitest";
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

const REQUEST = {
  instrument: "QQQ",
  assetClass: "etf",
  useCase: "additional_source_adapter_test",
  asOf: "2026-09-07T10:15:00.000Z",
} as const;

describe("additional finance source adapters", () => {
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

  it("normalizes the public Nasdaq exchange quote as an independent cross-check", async () => {
    const fetchImpl: FetchImpl = async () => ({
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
    });
    const observation = await createNasdaqExchangeMarketAdapter({ fetchImpl }).collect(
      REQUEST,
      new AbortController().signal,
    );
    expect(observation.providerRole).toBe("cross_check_market_data");
    expect(observation.fields[0]).toEqual(
      expect.objectContaining({
        name: "last_price",
        value: 718.96,
        sourceTimestamp: "2026-09-03T00:00:00.000Z",
      }),
    );
  });

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
