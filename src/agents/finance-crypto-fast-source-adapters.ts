import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import type { FinanceRealtimeSourceAdapter } from "./finance-realtime-source-registry.js";

class FastCryptoSourceAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FastCryptoSourceAdapterError";
  }
}

type FastCryptoInstrument = Readonly<{
  base: string;
  bybit: string;
  okx: string;
  bitstamp: string;
}>;

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new FastCryptoSourceAdapterError(`${label} required`);
  }
  return normalized;
}

function parseFiniteNumber(value: unknown, label: string): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    throw new FastCryptoSourceAdapterError(`${label} must be a finite number`);
  }
  return parsed;
}

function parseTimestamp(value: unknown, fallback: string, label: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (Number.isFinite(Date.parse(fallback))) {
    return fallback;
  }
  throw new FastCryptoSourceAdapterError(`${label} must be a valid timestamp`);
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
    throw new FastCryptoSourceAdapterError(
      `source request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new FastCryptoSourceAdapterError(`source http status ${response.status}`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new FastCryptoSourceAdapterError("source returned an empty body");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new FastCryptoSourceAdapterError("source returned invalid JSON");
  }
}

function normalizeInstrument(instrument: string): FastCryptoInstrument {
  const normalized = requiredText(instrument, "crypto instrument")
    .toUpperCase()
    .replace(/[\s/_-]/gu, "");
  const quote = normalized.endsWith("USDT") ? "USDT" : normalized.endsWith("USD") ? "USD" : "";
  const base = quote ? normalized.slice(0, -quote.length) : normalized;
  return {
    base,
    bybit: `${base}USDT`,
    okx: `${base}-USDT`,
    bitstamp: `${base.toLowerCase()}usd`,
  };
}

function cryptoRequest(request: { instrument: string; assetClass: string }): FastCryptoInstrument {
  if (request.assetClass.trim().toLowerCase() !== "crypto") {
    throw new FastCryptoSourceAdapterError("crypto adapter requires assetClass=crypto");
  }
  return normalizeInstrument(request.instrument);
}

function observation(options: {
  providerName: string;
  providerRole: FinanceDataGatewayObservationInput["providerRole"];
  observedAt: string;
  sourceUrlOrArtifact: string;
  sourceTimestamp: string;
  fields: FinanceDataGatewayObservationInput["fields"];
}): FinanceDataGatewayObservationInput {
  return {
    providerName: options.providerName,
    providerRole: options.providerRole,
    sourceFamily: "crypto_market_data",
    observedAt: options.observedAt,
    timezone: "UTC",
    delayStatus: "realtime",
    fields: options.fields.map((field) => ({
      ...field,
      sourceTimestamp: field.sourceTimestamp ?? options.sourceTimestamp,
      sourceUrlOrArtifact: field.sourceUrlOrArtifact ?? options.sourceUrlOrArtifact,
    })),
  };
}

export function parseBybitCryptoTicker(
  payload: unknown,
  instrument: string,
  sourceUrlOrArtifact: string,
  observedAt: string,
): FinanceDataGatewayObservationInput {
  const body = payload as {
    retCode?: unknown;
    result?: { list?: Array<{ symbol?: unknown; lastPrice?: unknown; volume24h?: unknown }> };
    time?: unknown;
  };
  const crypto = normalizeInstrument(instrument);
  const row = body.result?.list?.[0];
  if (body.retCode !== 0 || row?.symbol !== crypto.bybit) {
    throw new FastCryptoSourceAdapterError("Bybit returned no usable public spot ticker");
  }
  const sourceTimestamp = parseTimestamp(body.time, observedAt, "Bybit server time");
  const fields: FinanceDataGatewayObservationInput["fields"] = [
    {
      name: "last_price",
      value: parseFiniteNumber(row.lastPrice, "Bybit last price"),
      currency: "USDT",
      adjusted: false,
      fieldDefinition: `Bybit V5 public spot ticker last price for ${crypto.bybit}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    },
  ];
  if (row.volume24h !== undefined) {
    fields.push({
      name: "volume_24h_base",
      value: parseFiniteNumber(row.volume24h, "Bybit 24h volume"),
      unit: crypto.base,
      fieldDefinition: `Bybit V5 public spot 24-hour base volume for ${crypto.bybit}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    });
  }
  return observation({
    providerName: "bybit-public-spot",
    providerRole: "cross_check_market_data",
    observedAt,
    sourceUrlOrArtifact,
    sourceTimestamp,
    fields,
  });
}

export function createBybitCryptoTickerAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "bybit_public_crypto_ticker",
    providerName: "bybit-public-spot",
    providerRole: "cross_check_market_data",
    priority: 16,
    supports: (request) => request.assetClass.trim().toLowerCase() === "crypto",
    collect: async (request) => {
      const crypto = cryptoRequest(request);
      const sourceUrlOrArtifact = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(crypto.bybit)}`;
      const payload = await fetchJson(resolveFinanceFetch(options.fetchImpl), sourceUrlOrArtifact, {
        Accept: "application/json",
        "User-Agent": "LCX Agent research-only crypto snapshot",
      });
      return parseBybitCryptoTicker(payload, request.instrument, sourceUrlOrArtifact, request.asOf);
    },
  };
}

export function parseOkxCryptoTicker(
  payload: unknown,
  instrument: string,
  sourceUrlOrArtifact: string,
  observedAt: string,
): FinanceDataGatewayObservationInput {
  const body = payload as {
    code?: unknown;
    data?: Array<{ instId?: unknown; last?: unknown; vol24h?: unknown; ts?: unknown }>;
  };
  const crypto = normalizeInstrument(instrument);
  const row = body.data?.[0];
  if (body.code !== "0" || row?.instId !== crypto.okx) {
    throw new FastCryptoSourceAdapterError("OKX returned no usable public spot ticker");
  }
  const sourceTimestamp = parseTimestamp(row.ts, observedAt, "OKX ticker timestamp");
  const fields: FinanceDataGatewayObservationInput["fields"] = [
    {
      name: "last_price",
      value: parseFiniteNumber(row.last, "OKX last price"),
      currency: "USDT",
      adjusted: false,
      fieldDefinition: `OKX public spot ticker last price for ${crypto.okx}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    },
  ];
  if (row.vol24h !== undefined) {
    fields.push({
      name: "volume_24h_base",
      value: parseFiniteNumber(row.vol24h, "OKX 24h volume"),
      unit: crypto.base,
      fieldDefinition: `OKX public spot 24-hour base volume for ${crypto.okx}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    });
  }
  return observation({
    providerName: "okx-public-spot",
    providerRole: "cross_check_market_data",
    observedAt,
    sourceUrlOrArtifact,
    sourceTimestamp,
    fields,
  });
}

export function createOkxCryptoTickerAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "okx_public_crypto_ticker",
    providerName: "okx-public-spot",
    providerRole: "cross_check_market_data",
    priority: 17,
    supports: (request) => request.assetClass.trim().toLowerCase() === "crypto",
    collect: async (request) => {
      const crypto = cryptoRequest(request);
      const sourceUrlOrArtifact = `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(crypto.okx)}`;
      const payload = await fetchJson(resolveFinanceFetch(options.fetchImpl), sourceUrlOrArtifact, {
        Accept: "application/json",
        "User-Agent": "LCX Agent research-only crypto snapshot",
      });
      return parseOkxCryptoTicker(payload, request.instrument, sourceUrlOrArtifact, request.asOf);
    },
  };
}

export function parseBitstampCryptoTicker(
  payload: unknown,
  instrument: string,
  sourceUrlOrArtifact: string,
  observedAt: string,
): FinanceDataGatewayObservationInput {
  const ticker = payload as { timestamp?: unknown; last?: unknown; volume?: unknown };
  const crypto = normalizeInstrument(instrument);
  const sourceTimestamp = parseTimestamp(ticker.timestamp, observedAt, "Bitstamp ticker timestamp");
  const fields: FinanceDataGatewayObservationInput["fields"] = [
    {
      name: "last_price",
      value: parseFiniteNumber(ticker.last, "Bitstamp last price"),
      currency: "USD",
      adjusted: false,
      fieldDefinition: `Bitstamp public spot ticker last price for ${crypto.bitstamp}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    },
  ];
  if (ticker.volume !== undefined) {
    fields.push({
      name: "volume_24h_base",
      value: parseFiniteNumber(ticker.volume, "Bitstamp 24h volume"),
      unit: crypto.base,
      fieldDefinition: `Bitstamp public spot 24-hour base volume for ${crypto.bitstamp}`,
      sourceTimestamp,
      sourceUrlOrArtifact,
    });
  }
  return observation({
    providerName: "bitstamp-public-spot",
    providerRole: "cross_check_market_data",
    observedAt,
    sourceUrlOrArtifact,
    sourceTimestamp,
    fields,
  });
}

export function createBitstampCryptoTickerAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): FinanceRealtimeSourceAdapter {
  return {
    id: "bitstamp_public_crypto_ticker",
    providerName: "bitstamp-public-spot",
    providerRole: "cross_check_market_data",
    priority: 18,
    supports: (request) => request.assetClass.trim().toLowerCase() === "crypto",
    collect: async (request) => {
      const crypto = cryptoRequest(request);
      const sourceUrlOrArtifact = `https://www.bitstamp.net/api/v2/ticker/${encodeURIComponent(crypto.bitstamp)}/`;
      const payload = await fetchJson(resolveFinanceFetch(options.fetchImpl), sourceUrlOrArtifact, {
        Accept: "application/json",
        "User-Agent": "LCX Agent research-only crypto snapshot",
      });
      return parseBitstampCryptoTicker(
        payload,
        request.instrument,
        sourceUrlOrArtifact,
        request.asOf,
      );
    },
  };
}
