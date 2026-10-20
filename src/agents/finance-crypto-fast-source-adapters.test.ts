import { describe, expect, it, vi } from "vitest";
import {
  createBitstampCryptoTickerAdapter,
  createBybitCryptoTickerAdapter,
  createOkxCryptoTickerAdapter,
  parseBitstampCryptoTicker,
  parseBybitCryptoTicker,
  parseOkxCryptoTicker,
} from "./finance-crypto-fast-source-adapters.js";
import { runFinanceRealtimeRefresh } from "./finance-realtime-source-registry.js";

const observedAt = "2026-09-07T12:00:00.000Z";

describe("fast public crypto source adapters", () => {
  it("parses Bybit's public spot ticker", () => {
    const observation = parseBybitCryptoTicker(
      {
        retCode: 0,
        time: 1788779160440,
        result: { list: [{ symbol: "BTCUSDT", lastPrice: "79331.8", volume24h: "12" }] },
      },
      "BTCUSDT",
      "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT",
      observedAt,
    );
    expect(observation.providerName).toBe("bybit-public-spot");
    expect(observation.fields[0]).toMatchObject({ name: "last_price", value: 79331.8 });
  });

  it("parses OKX's public spot ticker", () => {
    const observation = parseOkxCryptoTicker(
      {
        code: "0",
        data: [{ instId: "BTC-USDT", last: "79339.6", ts: "1788779160068" }],
      },
      "BTCUSDT",
      "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
      observedAt,
    );
    expect(observation.providerName).toBe("okx-public-spot");
    expect(observation.fields[0]).toMatchObject({ name: "last_price", value: 79339.6 });
  });

  it("parses Bitstamp's public spot ticker", () => {
    const observation = parseBitstampCryptoTicker(
      { timestamp: "1788779160", last: "79330.45", volume: "1158.5" },
      "BTCUSD",
      "https://www.bitstamp.net/api/v2/ticker/btcusd/",
      observedAt,
    );
    expect(observation.providerName).toBe("bitstamp-public-spot");
    expect(observation.fields[0]).toMatchObject({ name: "last_price", value: 79330.45 });
  });

  it("marks all fast adapters as crypto-only cross-checks", () => {
    const adapters = [
      createBybitCryptoTickerAdapter(),
      createOkxCryptoTickerAdapter(),
      createBitstampCryptoTickerAdapter(),
    ];
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "bybit_public_crypto_ticker",
      "okx_public_crypto_ticker",
      "bitstamp_public_crypto_ticker",
    ]);
    expect(
      adapters.every((adapter) =>
        adapter.supports({ instrument: "BTC", assetClass: "crypto" } as never),
      ),
    ).toBe(true);
    expect(
      adapters.some((adapter) =>
        adapter.supports({ instrument: "QQQ", assetClass: "etf" } as never),
      ),
    ).toBe(false);
  });
});

it("preserves provider-specific millisecond and second timestamps", () => {
  const bybit = parseBybitCryptoTicker(
    {
      retCode: 0,
      time: 1788779160440,
      result: { list: [{ symbol: "BTCUSDT", lastPrice: "100" }] },
    },
    "BTCUSD",
    "https://api.bybit.com/",
    observedAt,
  );
  const okx = parseOkxCryptoTicker(
    { code: "0", data: [{ instId: "BTC-USDT", last: "100", ts: "1788779160068" }] },
    "BTCUSD",
    "https://www.okx.com/",
    observedAt,
  );
  const bitstamp = parseBitstampCryptoTicker(
    { timestamp: "1788779160", last: "100" },
    "BTCUSD",
    "https://www.bitstamp.net/",
    observedAt,
  );
  expect.soft(bybit.fields[0].sourceTimestamp).toBe(new Date(1788779160440).toISOString());
  expect.soft(okx.fields[0].sourceTimestamp).toBe(new Date(1788779160068).toISOString());
  expect.soft(bitstamp.fields[0].sourceTimestamp).toBe(new Date(1788779160000).toISOString());
});

it("rejects missing or invalid provider times instead of relabeling current prices", () => {
  for (const value of [undefined, "invalid", "2026-09-07T12:00:00Z"]) {
    expect
      .soft(() =>
        parseBybitCryptoTicker(
          { retCode: 0, time: value, result: { list: [{ symbol: "BTCUSDT", lastPrice: "100" }] } },
          "BTCUSD",
          "https://api.bybit.com/",
          observedAt,
        ),
      )
      .toThrow(/timestamp/);
    expect
      .soft(() =>
        parseOkxCryptoTicker(
          { code: "0", data: [{ instId: "BTC-USDT", last: "100", ts: value }] },
          "BTCUSD",
          "https://www.okx.com/",
          observedAt,
        ),
      )
      .toThrow(/timestamp/);
    expect
      .soft(() =>
        parseBitstampCryptoTicker(
          { timestamp: value, last: "100" },
          "BTCUSD",
          "https://www.bitstamp.net/",
          observedAt,
        ),
      )
      .toThrow(/timestamp/);
  }
});

it("records actual collection time and blocks a latest ticker at a historical cutoff", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T16:00:00.000Z"));
  try {
    const adapter = createOkxCryptoTickerAdapter({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: "0",
            data: [{ instId: "BTC-USDT", last: "100", ts: "1788779160068" }],
          }),
      }),
    });
    const request = {
      instrument: "BTCUSD",
      assetClass: "crypto",
      useCase: "private_timestamp_regression",
      asOf: "2020-01-01T00:00:00.000Z",
      requireOfficialReference: false,
    };
    const observation = await adapter.collect(request, new AbortController().signal);
    expect.soft(observation.observedAt).toBe("2026-10-20T16:00:00.000Z");
    const result = await runFinanceRealtimeRefresh({ request, adapters: [adapter] });
    expect(result.status).toBe("blocked");
    expect(result.sourceAttempts[0].status).toBe("failed");
    expect(result.snapshot).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
