import { describe, expect, it } from "vitest";
import {
  createBinanceCryptoTickerAdapter,
  createCoinbaseCryptoTickerAdapter,
  createCoinCapCryptoAssetAdapter,
  parseBinanceCryptoTicker,
  parseCoinGeckoCryptoPrice,
  parseCoinbaseCryptoTicker,
  parseKrakenCryptoTicker,
} from "./finance-crypto-source-adapters.js";
import type { FetchImpl } from "./finance-live-market-source.js";

const REQUEST = {
  instrument: "BTCUSDT",
  assetClass: "crypto",
  useCase: "crypto_source_adapter_test",
  asOf: "2026-09-07T10:45:00.000Z",
} as const;

describe("finance crypto source adapters", () => {
  it("parses Binance public spot data as the primary crypto source", () => {
    const observation = parseBinanceCryptoTicker(
      { symbol: "BTCUSDT", price: "79435.97" },
      REQUEST.instrument,
      "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT",
      REQUEST.asOf,
    );
    expect(observation.providerRole).toBe("primary_market_data");
    expect(observation.sourceFamily).toBe("crypto_market_data");
    expect(observation.fields[0]).toEqual(expect.objectContaining({ value: 79435.97 }));
  });

  it("parses Kraken and Coinbase as independent cross-checks", () => {
    const kraken = parseKrakenCryptoTicker(
      { error: [], result: { XXBTZUSD: { c: ["79429.4"] } } },
      REQUEST.instrument,
      "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
      REQUEST.asOf,
    );
    const coinbase = parseCoinbaseCryptoTicker(
      { price: "79430.97", volume: "2653.57", time: "2026-09-07T10:42:24.040Z" },
      REQUEST.instrument,
      "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
      REQUEST.asOf,
    );
    expect(kraken.providerRole).toBe("cross_check_market_data");
    expect(coinbase.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "last_price",
          sourceTimestamp: "2026-09-07T10:42:24.040Z",
        }),
      ]),
    );
  });

  it("parses CoinGecko keyed output without putting the key in provenance", () => {
    const observation = parseCoinGeckoCryptoPrice(
      { bitcoin: { usd: 79431.2, last_updated_at: 1788777744 } },
      REQUEST.instrument,
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true",
      REQUEST.asOf,
    );
    expect(observation.fields[0]?.sourceUrlOrArtifact).not.toContain("api_key");
    expect(observation.fields[0]?.value).toBe(79431.2);
  });

  it("uses actual public endpoint shapes through injectable fetchers", async () => {
    const fetchImpl: FetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes("binance")
          ? JSON.stringify({ symbol: "BTCUSDT", price: "79435.97" })
          : url.includes("coinbase")
            ? JSON.stringify({ price: "79430.97", time: REQUEST.asOf })
            : JSON.stringify({ data: { priceUsd: "79429.4", timestamp: 1788777744000 } }),
    });
    const binance = await createBinanceCryptoTickerAdapter({ fetchImpl }).collect(
      REQUEST,
      new AbortController().signal,
    );
    const coinbase = await createCoinbaseCryptoTickerAdapter({ fetchImpl }).collect(
      REQUEST,
      new AbortController().signal,
    );
    const coincap = await createCoinCapCryptoAssetAdapter({
      fetchImpl,
      apiKey: "fixture-key",
    }).collect(REQUEST, new AbortController().signal);
    expect(binance.providerName).toBe("binance-public-spot");
    expect(coinbase.providerName).toBe("coinbase-exchange-public");
    expect(coincap.providerName).toBe("coincap-public-assets");
  });

  it("normalizes Kraken response errors instead of treating them as data", () => {
    expect(() =>
      parseKrakenCryptoTicker(
        { error: ["EQuery:Unknown asset pair"] },
        REQUEST.instrument,
        "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
        REQUEST.asOf,
      ),
    ).toThrow("Kraken returned an error");
  });
});

it("uses CoinCap v3 auth and its top-level source timestamp", async () => {
  const adapter = createCoinCapCryptoAssetAdapter({
    apiKey: "fixture-key",
    fetchImpl: async (url, init) => {
      expect(url).toBe("https://rest.coincap.io/v3/assets/bitcoin");
      expect(init?.headers).toEqual({ Authorization: "Bearer fixture-key" });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ timestamp: 1788777744000, data: { priceUsd: "100" } }),
      };
    },
  });
  const observation = await adapter.collect(REQUEST, new AbortController().signal);
  expect(observation.fields[0].sourceTimestamp).toBe(new Date(1788777744000).toISOString());
  expect(JSON.stringify(observation)).not.toContain("fixture-key");
  await expect(
    createCoinCapCryptoAssetAdapter().collect(REQUEST, new AbortController().signal),
  ).rejects.toThrow("CoinCap API key required");
});
