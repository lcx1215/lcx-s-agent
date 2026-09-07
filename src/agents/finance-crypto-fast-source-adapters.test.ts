import { describe, expect, it } from "vitest";
import {
  createBitstampCryptoTickerAdapter,
  createBybitCryptoTickerAdapter,
  createOkxCryptoTickerAdapter,
  parseBitstampCryptoTicker,
  parseBybitCryptoTicker,
  parseOkxCryptoTicker,
} from "./finance-crypto-fast-source-adapters.js";

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
