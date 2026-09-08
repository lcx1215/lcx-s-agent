import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import type { FinanceRealtimeSourceAdapter } from "./finance-realtime-source-registry.js";

class CryptoSourceAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoSourceAdapterError";
  }
}

type CryptoInstrument = Readonly<{
  base: string;
  binance: string;
  coinbase: string;
  kraken: string;
  coinCap: string;
  coinGecko: string;
}>;

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CryptoSourceAdapterError(`${label} required`);
  }
  return normalized;
}

function parseFiniteNumber(value: unknown, label: string): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    throw new CryptoSourceAdapterError(`${label} must be a finite number`);
  }
  return parsed;
}

function parseTimestamp(value: unknown, fallback: string, label: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const timestamp = new Date(milliseconds).toISOString();
    if (Number.isFinite(Date.parse(timestamp))) {
      return timestamp;
    }
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (Number.isFinite(Date.parse(fallback))) {
    return fallback;
  }
  throw new CryptoSourceAdapterError(`${label} must be a valid timestamp`);
}

async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let response: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new CryptoSourceAdapterError(
      `source request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new CryptoSourceAdapterError(`source http status ${response.status}`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new CryptoSourceAdapterError("source returned an empty body");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CryptoSourceAdapterError("source returned invalid JSON");
  }
}

function normalizeCryptoInstrument(instrument: string): CryptoInstrument {
  const normalized = requiredText(instrument, "crypto instrument")
    .toUpperCase()
    .replace(/[\s/_-]/gu, "");
  const quote = normalized.endsWith("USDT") ? "USDT" : normalized.endsWith("USD") ? "USD" : "";
  const base = quote ? normalized.slice(0, -quote.length) : normalized;
  const krakenBase = base === "BTC" ? "XBT" : base;
  const coinCap =
    (
      { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "xrp", DOGE: "dogecoin" } as
        | Record<string, string>
        | undefined
    )?.[base] ?? base.toLowerCase();
  const coinGecko =
    (
      { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", DOGE: "dogecoin" } as
        | Record<string, string>
        | undefined
    )?.[base] ?? coinCap;
  return {
    base,
    binance: `${base}USDT`,
    coinbase: `${base}-USD`,
    kraken: `${krakenBase}USD`,
    coinCap,
    coinGecko,
  };
}

function cryptoRequest(request: { instrument: string; assetClass: string }): CryptoInstrument {
  if (request.assetClass.trim().toLowerCase() !== "crypto") {
    throw new CryptoSourceAdapterError("crypto adapter requires assetClass=crypto");
  }
  return normalizeCryptoInstrument(request.instrument);
}

function cryptoObservation(options: {
  providerName: string;
  providerRole: FinanceDataGatewayObservationInput["providerRole"];
  observedAt: string;
  sourceFamily?: FinanceDataGatewayObservationInput["sourceFamily"];
  delayStatus?: FinanceDataGatewayObservationInput["delayStatus"];
  sourceUrlOrArtifact: string;
  sourceTimestamp?: string;
  fields: FinanceDataGatewayObservationInput["fields"];
}): FinanceDataGatewayObservationInput {
  return {
    providerName: options.providerName,
    providerRole: options.providerRole,
    sourceFamily: options.sourceFamily ?? "crypto_market_data",
    observedAt: options.observedAt,
    timezone: "UTC",
    delayStatus: options.delayStatus ?? "realtime",
    fields: options.fields.map((field) => ({
      ...field,
      sourceTimestamp: field.sourceTimestamp ?? options.sourceTimestamp ?? options.observedAt,
      sourceUrlOrArtifact: field.sourceUrlOrArtifact ?? options.sourceUrlOrArtifact,
    })),
  };
}

export function parseBinanceCryptoTicker(
  payload: unknown,
  instrument: string,
  sourceUrlOrArtifact: string,
  observedAt: string,
): FinanceDataGatewayObservationInput {
  const ticker = payload as { symbol?: unknown; price?: unknown };
  const crypto = normalizeCryptoInstrument(instrument);
  if (ticker.symbol !== crypto.binance || ticker.price === undefined) {
    throw new CryptoSourceAdapterError("Binance response has no usable public ticker");
  }
  const price = parseFiniteNumber(ticker.price, "Binance price");
  return cryptoObservation({
    providerName: "binance-public-spot",
    providerRole: "primary_market_data",
    observedAt,
    sourceUrlOrArtifact,
    sourceTimestamp: observedAt,
    fields: [
      {
        name: "last_price",
        value: price,
        currency: "USDT",
        adjusted: false,
        fieldDefinition: `Binance public spot price for ${crypto.binance}; endpoint omits exchange event time`,
        sourceTimestamp: observedAt,
        sourceUrlOrArtifact,
      },
    ],
  });
}

export function createBinanceCryptoTickerAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "binance_public_crypto_ticker",
    providerName: "binance-public-spot",
    providerRole: "primary_market_data",
    priority: 11,
    supports: (request) => request.assetClass.trim().toLowerCase() === "crypto",
    collect: async (request) => {
      const crypto = cryptoRequest(request);
      const sourceUrlOrArtifact = `https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(crypto.binance)}`;
      const payload = await fetchJson(resolveFinanceFetch(options.fetchImpl), sourceUrlOrArtifact);
      return parseBinanceCryptoTicker(
        payload,
        request.instrument,
        sourceUrlOrArtifact,
        request.asOf,
      );
    },
  };
}

export function parseKrakenCryptoTicker(
  payload: unknown,
  instrument: string,
  sourceUrlOrArtifact: string,
  observedAt: string,
): FinanceDataGatewayObservationInput {
  const body = payload as { error?: unknown; result?: Record<string, { c?: unknown[] }> };
  if (Array.isArray(body.error) && body.error.length > 0) {
    throw new CryptoSourceAdapterError(`Kraken returned an error for ${instrument}`);
  }
  const ticker = Object.values(body.result ?? {})[0];
  const last = ticker?.c?.[0];
  const crypto = normalizeCryptoInstrument(instrument);
  const price = parseFiniteNumber(last, "Kraken last trade price");
  return cryptoObservation({
    providerName: "kraken-public-spot",
    providerRole: "cross_check_market_data",
    observedAt,
    sourceUrlOrArtifact,
    sourceTimestamp: observedAt,
    fields: [
      {
        name: "last_price",
        value: price,
        currency: "USD",
        adjusted: false,
        fieldDefinition: `Kraken public spot last trade for ${crypto.base}; endpoint response has no event timestamp`,
        sourceTimestamp: observedAt,
        sourceUrlOrArtifact,
      },
    ],
  });
}

export function createKrakenCryptoTickerAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "kraken_public_crypto_ticker",
    providerName: "kraken-public-spot",
    providerRole: "cross_check_market_data",
    priority: 14,
    supports: (request) => request.assetClass.trim().toLowerCase() === "crypto",
    collect: async (request) => {
      const crypto = cryptoRequest(request);
      const sourceUrlOrArtifact = `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(crypto.kraken)}`;
      const payload = await fetchJson(resolveFinanceFetch(options.fetchImpl), sourceUrlOrArtifact);
      return parseKrakenCryptoTicker(
        payload,
        request.instrument,
        sourceUrlOrArtifact,
        request.asOf,
      );
    },
  };
}

export function parseCoinbaseCryptoTicker(
  payload: unknown,
  instrument: string,
  sourceUrlOrArtifact: string,
  observedAt: string,
): FinanceDataGatewayObservationInput {
  const ticker = payload as { price?: unknown; time?: unknown; volume?: unknown };
  const crypto = normalizeCryptoInstrument(instrument);
  const price = parseFiniteNumber(ticker.price, "Coinbase price");
  const sourceTimestamp = parseTimestamp(ticker.time, observedAt, "Coinbase trade time");
  const fields: FinanceDataGatewayObservationInput["fields"] = [
    {
      name: "last_price",
      value: price,
      currency: "USD",
      adjusted: false,
      fieldDefinition: `Coinbase Exchange public ticker price for ${crypto.coinbase}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    },
  ];
  if (ticker.volume !== undefined) {
    fields.push({
      name: "volume_24h_base",
      value: parseFiniteNumber(ticker.volume, "Coinbase 24h volume"),
      unit: crypto.base,
      fieldDefinition: `Coinbase Exchange public ticker 24-hour base volume for ${crypto.coinbase}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    });
  }
  return cryptoObservation({
    providerName: "coinbase-exchange-public",
    providerRole: "cross_check_market_data",
    observedAt,
    sourceUrlOrArtifact,
    sourceTimestamp,
    fields,
  });
}

export function createCoinbaseCryptoTickerAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "coinbase_exchange_public_crypto_ticker",
    providerName: "coinbase-exchange-public",
    providerRole: "cross_check_market_data",
    priority: 15,
    supports: (request) => request.assetClass.trim().toLowerCase() === "crypto",
    collect: async (request) => {
      const crypto = cryptoRequest(request);
      const sourceUrlOrArtifact = `https://api.exchange.coinbase.com/products/${encodeURIComponent(crypto.coinbase)}/ticker`;
      const payload = await fetchJson(resolveFinanceFetch(options.fetchImpl), sourceUrlOrArtifact, {
        Accept: "application/json",
        "User-Agent": "LCX Agent research-only crypto snapshot",
        "Cache-Control": "no-cache",
      });
      return parseCoinbaseCryptoTicker(
        payload,
        request.instrument,
        sourceUrlOrArtifact,
        request.asOf,
      );
    },
  };
}

export function parseCoinCapCryptoAsset(
  payload: unknown,
  instrument: string,
  sourceUrlOrArtifact: string,
  observedAt: string,
): FinanceDataGatewayObservationInput {
  const body = payload as {
    timestamp?: unknown;
    data?: { priceUsd?: unknown; timestamp?: unknown; volumeUsd24Hr?: unknown };
  };
  const crypto = normalizeCryptoInstrument(instrument);
  const price = parseFiniteNumber(body.data?.priceUsd, "CoinCap price");
  const sourceTimestamp = parseTimestamp(
    body.timestamp ?? body.data?.timestamp,
    observedAt,
    "CoinCap timestamp",
  );
  const fields: FinanceDataGatewayObservationInput["fields"] = [
    {
      name: "last_price",
      value: price,
      currency: "USD",
      adjusted: false,
      fieldDefinition: `CoinCap public asset price for ${crypto.coinCap}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    },
  ];
  if (body.data?.volumeUsd24Hr !== undefined) {
    fields.push({
      name: "volume_24h_usd",
      value: parseFiniteNumber(body.data.volumeUsd24Hr, "CoinCap 24h volume"),
      currency: "USD",
      fieldDefinition: `CoinCap public 24-hour USD volume for ${crypto.coinCap}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    });
  }
  return cryptoObservation({
    providerName: "coincap-public-assets",
    providerRole: "cross_check_market_data",
    observedAt,
    sourceUrlOrArtifact,
    sourceTimestamp,
    fields,
  });
}

export function createCoinCapCryptoAssetAdapter(
  options: { fetchImpl?: FetchImpl; apiKey?: string } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "coincap_public_crypto_asset",
    providerName: "coincap-public-assets",
    providerRole: "cross_check_market_data",
    priority: 20,
    supports: (request) => request.assetClass.trim().toLowerCase() === "crypto",
    collect: async (request) => {
      const crypto = cryptoRequest(request);
      const apiKey = requiredText(options.apiKey ?? "", "CoinCap API key");
      const sourceUrlOrArtifact = `https://rest.coincap.io/v3/assets/${encodeURIComponent(crypto.coinCap)}`;
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
      const payload = await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
        headers,
      );
      return parseCoinCapCryptoAsset(
        payload,
        request.instrument,
        sourceUrlOrArtifact,
        request.asOf,
      );
    },
  };
}

export function parseCoinGeckoCryptoPrice(
  payload: unknown,
  instrument: string,
  sourceUrlOrArtifact: string,
  observedAt: string,
): FinanceDataGatewayObservationInput {
  const crypto = normalizeCryptoInstrument(instrument);
  const quote = (payload as Record<string, { usd?: unknown; last_updated_at?: unknown }>)[
    crypto.coinGecko
  ];
  if (!quote) {
    throw new CryptoSourceAdapterError(`CoinGecko returned no quote for ${crypto.coinGecko}`);
  }
  const sourceTimestamp = parseTimestamp(quote.last_updated_at, observedAt, "CoinGecko timestamp");
  return cryptoObservation({
    providerName: "coingecko-public-api",
    providerRole: "cross_check_market_data",
    observedAt,
    sourceUrlOrArtifact,
    sourceTimestamp,
    fields: [
      {
        name: "last_price",
        value: parseFiniteNumber(quote.usd, "CoinGecko USD price"),
        currency: "USD",
        adjusted: false,
        fieldDefinition: `CoinGecko public simple price for ${crypto.coinGecko}`,
        sourceTimestamp,
        sourceUrlOrArtifact,
      },
    ],
  });
}

export function createCoinGeckoCryptoPriceAdapter(options: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): FinanceRealtimeSourceAdapter {
  const apiKey = requiredText(options.apiKey, "CoinGecko apiKey");
  return {
    id: "coingecko_public_crypto_price",
    providerName: "coingecko-public-api",
    providerRole: "cross_check_market_data",
    priority: 18,
    supports: (request) => request.assetClass.trim().toLowerCase() === "crypto",
    collect: async (request) => {
      const crypto = cryptoRequest(request);
      const sourceUrlOrArtifact = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(crypto.coinGecko)}&vs_currencies=usd&include_last_updated_at=true`;
      const url = `${sourceUrlOrArtifact}&x_cg_demo_api_key=${encodeURIComponent(apiKey)}`;
      const payload = await fetchJson(resolveFinanceFetch(options.fetchImpl), url, {
        Accept: "application/json",
      });
      return parseCoinGeckoCryptoPrice(
        payload,
        request.instrument,
        sourceUrlOrArtifact,
        request.asOf,
      );
    },
  };
}
