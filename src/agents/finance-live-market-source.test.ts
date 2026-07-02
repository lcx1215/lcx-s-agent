import { describe, expect, it } from "vitest";
import { buildFinanceDataGatewaySnapshot } from "./finance-data-gateway.js";
import {
  collectLiveFinanceGatewayInput,
  fetchYahooQuote,
  LiveMarketFetchError,
  parseYahooChart,
  quoteToObservation,
  type FetchImpl,
} from "./finance-live-market-source.js";

// regularMarketTime 1782936000 = 2026-07-01T20:00:00.000Z
const SAMPLE_JSON = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: "USD",
          symbol: "QQQ",
          regularMarketPrice: 725.17,
          regularMarketTime: 1782936000,
          exchangeTimezoneName: "America/New_York",
        },
      },
    ],
    error: null,
  },
});

function fakeFetch(body: string, init?: { ok?: boolean; status?: number }): FetchImpl {
  return async () => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => body,
  });
}

describe("parseYahooChart", () => {
  it("parses a real-shaped yahoo chart response into a quote with provenance", () => {
    const quote = parseYahooChart(SAMPLE_JSON, "qqq");
    expect(quote.symbol).toBe("QQQ");
    expect(quote.price).toBe(725.17);
    expect(quote.currency).toBe("USD");
    expect(quote.delayStatus).toBe("delayed");
    expect(quote.quoteTimestamp).toBe("2026-07-01T20:00:00.000Z");
    expect(quote.sourceUrlOrArtifact).toContain("finance.yahoo.com");
  });

  it("fails closed when yahoo reports an error", () => {
    const body = JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } });
    expect(() => parseYahooChart(body, "zzzz")).toThrowError(LiveMarketFetchError);
  });

  it("fails closed when regularMarketPrice is missing", () => {
    const body = JSON.stringify({
      chart: {
        result: [{ meta: { currency: "USD", regularMarketTime: 1782936000 } }],
        error: null,
      },
    });
    expect(() => parseYahooChart(body, "qqq")).toThrowError(LiveMarketFetchError);
  });

  it("fails closed on an empty body", () => {
    expect(() => parseYahooChart("   ", "qqq")).toThrowError(LiveMarketFetchError);
  });

  it("fails closed on non-JSON", () => {
    expect(() => parseYahooChart("<html>nope</html>", "qqq")).toThrowError(LiveMarketFetchError);
  });
});

describe("fetchYahooQuote", () => {
  it("returns a parsed quote from an injected fetch", async () => {
    const quote = await fetchYahooQuote("QQQ", { fetchImpl: fakeFetch(SAMPLE_JSON) });
    expect(quote.price).toBe(725.17);
  });

  it("fails closed on an http error", async () => {
    await expect(
      fetchYahooQuote("QQQ", { fetchImpl: fakeFetch("", { ok: false, status: 429 }) }),
    ).rejects.toBeInstanceOf(LiveMarketFetchError);
  });

  it("fails closed when the network throws", async () => {
    const throwingFetch: FetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(fetchYahooQuote("QQQ", { fetchImpl: throwingFetch })).rejects.toMatchObject({
      reason: "network_error",
    });
  });
});

describe("quoteToObservation", () => {
  it("maps a quote to a gateway observation preserving full field metadata", () => {
    const quote = parseYahooChart(SAMPLE_JSON, "qqq");
    const observation = quoteToObservation(quote, {
      providerName: "yahoo-qqq",
      providerRole: "primary_market_data",
      observedAt: "2026-06-01T20:05:00.000Z",
    });
    expect(observation.sourceFamily).toBe("market_data_api");
    expect(observation.delayStatus).toBe("delayed");
    const field = observation.fields[0];
    expect(field.name).toBe("last_price");
    expect(field.value).toBe(725.17);
    expect(field.currency).toBe("USD");
    expect(field.sourceTimestamp).toBe("2026-07-01T20:00:00.000Z");
    expect(field.fieldDefinition).toContain("last/close price");
    expect(field.sourceUrlOrArtifact).toContain("finance.yahoo.com");
  });
});

describe("collectLiveFinanceGatewayInput", () => {
  it("produces a gateway-valid input that the pure validator accepts (live-shaped, not fixture)", async () => {
    const input = await collectLiveFinanceGatewayInput({
      instrument: "QQQ",
      assetClass: "etf",
      useCase: "live_gateway_portfolio_macro_risk_research",
      requireOfficialReference: false,
      now: () => new Date("2026-06-01T20:05:00.000Z"),
      fetchImpl: fakeFetch(SAMPLE_JSON),
    });
    expect(input.instrument).toBe("QQQ");
    expect(input.observations).toHaveLength(1);
    expect(input.observations[0].providerRole).toBe("primary_market_data");

    // The gateway's validation contract must still hold on live-shaped data.
    const snapshot = buildFinanceDataGatewaySnapshot(input);
    // Only a primary source is present, so the gateway must honestly mark the
    // snapshot blocked on the missing cross-check provider — not silently pass.
    expect(snapshot.qualityStatus).toBe("blocked");
    expect(snapshot.missingEvidence).toContain("cross_check_market_data_provider");
    const priceField = snapshot.normalizedFields.find((f) => f.name === "last_price");
    expect(priceField?.value).toBe(725.17);
    expect(priceField?.sourceTimestamp).toBe("2026-07-01T20:00:00.000Z");
  });

  it("propagates a fail-closed error when the source is unavailable", async () => {
    await expect(
      collectLiveFinanceGatewayInput({
        instrument: "QQQ",
        assetClass: "etf",
        useCase: "live_gateway_portfolio_macro_risk_research",
        fetchImpl: fakeFetch("", { ok: false, status: 500 }),
      }),
    ).rejects.toBeInstanceOf(LiveMarketFetchError);
  });
});
