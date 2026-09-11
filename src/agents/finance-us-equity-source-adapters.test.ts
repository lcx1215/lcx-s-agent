import { describe, expect, it } from "vitest";
import type { FetchImpl } from "./finance-live-market-source.js";
import {
  createAlpacaUsEquityQuoteAdapter,
  createFinnhubUsEquityQuoteAdapter,
  createMassiveUsEquitySnapshotAdapter,
  createSecCompanyFactsAdapter,
  createTwelveDataUsEquityQuoteAdapter,
} from "./finance-us-equity-source-adapters.js";

const REQUEST = {
  instrument: "AAPL",
  assetClass: "us_equity",
  useCase: "us_equity_source_adapter_test",
  asOf: "2026-09-07T14:00:00.000Z",
} as const;

describe("US equity finance source adapters", () => {
  it("resolves a ticker through the official SEC map and normalizes company facts", async () => {
    const fetchImpl: FetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes("company_tickers")
          ? JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } })
          : JSON.stringify({
              entityName: "Apple Inc.",
              facts: {
                "us-gaap": {
                  Revenues: {
                    label: "Revenues",
                    units: {
                      USD: [{ val: 1000, filed: "2026-08-01", end: "2026-06-30", form: "10-Q" }],
                    },
                  },
                  Assets: {
                    label: "Assets",
                    units: {
                      USD: [{ val: 5000, filed: "2026-08-01", end: "2026-06-30", form: "10-Q" }],
                    },
                  },
                },
                dei: {
                  EntityCommonStockSharesOutstanding: {
                    label: "Entity Common Stock Shares Outstanding",
                    units: {
                      shares: [{ val: 100, filed: "2026-08-01", end: "2026-06-30", form: "10-Q" }],
                    },
                  },
                },
              },
            }),
    });
    const observation = await createSecCompanyFactsAdapter({ fetchImpl }).collect(
      REQUEST,
      new AbortController().signal,
    );
    expect(observation.providerRole).toBe("official_or_issuer_reference");
    expect(observation.sourceFamily).toBe("fundamentals_api");
    expect(observation.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fundamental_revenue", value: 1000 }),
        expect.objectContaining({ name: "fundamental_assets", value: 5000 }),
        expect.objectContaining({ name: "shares_outstanding", value: 100 }),
      ]),
    );
  });

  it("keeps API credentials out of the recorded source URL", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      urls.push(url);
      if (url.includes("massive.com")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ ticker: { lastTrade: { p: 200, t: 1788780000 }, day: { v: 10 } } }),
        };
      }
      if (url.includes("alpaca.markets")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              quotes: { AAPL: { bp: 199, ap: 201, t: "2026-09-07T13:59:00.000Z" } },
            }),
        };
      }
      if (url.includes("finnhub.io")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ c: 200, t: 1788780000 }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ close: "200", timestamp: "1788780000" }),
      };
    };

    const adapters = [
      createMassiveUsEquitySnapshotAdapter({ apiKey: "massive-secret", fetchImpl }),
      createAlpacaUsEquityQuoteAdapter({
        apiKeyId: "alpaca-id",
        apiSecretKey: "alpaca-secret",
        fetchImpl,
      }),
      createFinnhubUsEquityQuoteAdapter({ apiKey: "finnhub-secret", fetchImpl }),
      createTwelveDataUsEquityQuoteAdapter({ apiKey: "twelve-secret", fetchImpl }),
    ];
    for (const adapter of adapters) {
      const observation = await adapter.collect(REQUEST, new AbortController().signal);
      const sourceUrl = observation.fields[0]?.sourceUrlOrArtifact ?? "";
      expect(sourceUrl).not.toContain("secret");
    }
    expect(urls.some((url) => url.includes("massive-secret"))).toBe(true);
    expect(urls.some((url) => url.includes("twelve-secret"))).toBe(true);
  });

  it("only supports US equity asset classes", () => {
    const adapter = createMassiveUsEquitySnapshotAdapter({ apiKey: "test-key" });
    expect(adapter.supports(REQUEST)).toBe(true);
    expect(adapter.supports({ ...REQUEST, assetClass: "etf" })).toBe(false);
    expect(adapter.supports({ ...REQUEST, assetClass: "crypto" })).toBe(false);
  });

  it("does not coerce null or blank quote fields into zero", async () => {
    const fetchImpl: FetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes("massive.com")
          ? JSON.stringify({ ticker: { day: { c: null, v: "" } } })
          : url.includes("finnhub.io")
            ? JSON.stringify({ c: null, t: 1788780000 })
            : JSON.stringify({ close: "", timestamp: "1788780000" }),
    });
    await expect(
      createMassiveUsEquitySnapshotAdapter({ apiKey: "key", fetchImpl }).collect(
        REQUEST,
        new AbortController().signal,
      ),
    ).rejects.toThrow("no supported fields");
    await expect(
      createFinnhubUsEquityQuoteAdapter({ apiKey: "key", fetchImpl }).collect(
        REQUEST,
        new AbortController().signal,
      ),
    ).rejects.toThrow("no supported fields");
    await expect(
      createTwelveDataUsEquityQuoteAdapter({ apiKey: "key", fetchImpl }).collect(
        REQUEST,
        new AbortController().signal,
      ),
    ).rejects.toThrow("no supported fields");
  });
});
