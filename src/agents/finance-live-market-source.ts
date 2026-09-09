import { gunzipSync } from "node:zlib";
// Track A: turn the finance data gateway from fixture-only into one that can
// ingest a REAL, authorized public market data source.
//
// The gateway (`finance-data-gateway.ts`) is a pure validator/normalizer: it
// takes already-collected observations and enforces provenance. Nothing in the
// repo actually fetched real quotes before this module — the only inputs were
// hard-coded fixtures in `scripts/operator/finance-data-gateway-smoke.ts`.
//
// This module adds a real fetch adapter for the Yahoo Finance public chart
// endpoint (key-less), which serves delayed quotes. That delay is stated
// honestly in the produced observations (delayStatus), so a research-only
// answer can never present these as realtime execution-grade numbers. The
// fetch implementation is injectable so the mapping logic is testable offline
// and so the live path can fail closed when the network or data is unavailable.
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import {
  ApiCallError,
  governApiFetch,
  type ApiFetch,
  type ApiTransportOptions,
} from "./api-call-contract.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import type {
  FinanceDataGatewayInput,
  FinanceDataGatewayObservationInput,
} from "./finance-data-gateway.js";
import { governFinanceQuota } from "./finance-source-quota.js";

export type LiveMarketQuote = {
  /** Uppercase instrument symbol as understood by the caller, e.g. "QQQ". */
  symbol: string;
  /** Last/regular-market price in the quote currency. */
  price: number;
  /** ISO timestamp of the quote as reported by the source. */
  quoteTimestamp: string;
  currency: string;
  /** Honest freshness of the source feed. Yahoo public chart is delayed. */
  delayStatus: "delayed" | "end_of_day";
  /** Human/source URL or artifact the value came from, for provenance. */
  sourceUrlOrArtifact: string;
};

export type FetchImpl = ApiFetch;

const YAHOO_CHART_URL = (symbol: string, host = "query2"): string =>
  `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol.toUpperCase(),
  )}?interval=1d&range=1d`;

const YAHOO_CHART_HOSTS = ["query2", "query1"] as const;

// Yahoo returns 429/403 without a browser-like UA; keep it explicit and honest.
const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0 (LCX Agent research-only market snapshot)" };

let defaultFinanceProxyAgent: EnvHttpProxyAgent | undefined;
let defaultFinanceProxyUrl: string | undefined;

export function createFinanceNativeFetch(gzipText = false): FetchImpl {
  return async (url, init) => {
    const proxy = resolveFinanceCredentialEnv().LCX_FINANCE_HTTP_PROXY?.trim() || undefined;
    if (!defaultFinanceProxyAgent || proxy !== defaultFinanceProxyUrl) {
      const previous = defaultFinanceProxyAgent;
      // The governed AbortSignal owns the total request budget. Undici's 10s
      // connection default otherwise truncates callers that explicitly allow longer.
      defaultFinanceProxyAgent = new EnvHttpProxyAgent({
        ...(proxy ? { httpProxy: proxy, httpsProxy: proxy } : {}),
        connectTimeout: 30_000,
        requestTls: { timeout: 30_000 },
      });
      defaultFinanceProxyUrl = proxy;
      void previous?.close().catch(() => undefined);
    }
    const response = await undiciFetch(url, {
      dispatcher: defaultFinanceProxyAgent,
      headers: init?.headers,
      signal: init?.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text: async () => {
        if (!gzipText || !response.ok) {
          return response.text();
        }
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("Missing compressed public data body");
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            size += value.byteLength;
            if (size > 4 * 1024 * 1024) {
              throw new Error("Compressed public data exceeds size limit");
            }
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const body = Buffer.concat(chunks);
        return gunzipSync(body, { maxOutputLength: 16 * 1024 * 1024 }).toString("utf8");
      },
    };
  };
}

/** Resolve the repository's proxy-aware public HTTP path for source adapters. */
export function resolveFinanceFetch(
  fetchImpl?: FetchImpl,
  options: ApiTransportOptions = {},
): FetchImpl {
  return governApiFetch(fetchImpl ?? governFinanceQuota(createFinanceNativeFetch()), options);
}

/** Injected fetches supply decoded text; native downloads remain bounded and proxy-aware. */
export function resolveFinanceGzipTextFetch(fetchImpl?: FetchImpl): FetchImpl {
  return governApiFetch(fetchImpl ?? governFinanceQuota(createFinanceNativeFetch(true)));
}

export class LiveMarketFetchError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "network_error"
      | "http_error"
      | "forbidden"
      | "empty_body"
      | "unparseable"
      | "no_value"
      | "stale_or_invalid",
  ) {
    super(message);
    this.name = "LiveMarketFetchError";
  }
}

// Yahoo chart JSON shape (trimmed):
// { chart: { result: [ { meta: { currency, symbol, regularMarketPrice,
//   regularMarketTime, exchangeTimezoneName } } ], error: null } }
export function parseYahooChart(
  body: string,
  requestedSymbol: string,
  sourceUrlOrArtifact = YAHOO_CHART_URL(requestedSymbol),
): LiveMarketQuote {
  const text = body.trim();
  if (!text) {
    throw new LiveMarketFetchError("yahoo returned an empty body", "empty_body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LiveMarketFetchError("yahoo body is not valid JSON", "unparseable");
  }
  const chart = (parsed as { chart?: { result?: unknown[]; error?: unknown } }).chart;
  if (!chart || chart.error) {
    throw new LiveMarketFetchError(
      `yahoo reported an error for ${requestedSymbol}`,
      "stale_or_invalid",
    );
  }
  const meta = (chart.result?.[0] as { meta?: Record<string, unknown> } | undefined)?.meta;
  if (!meta) {
    throw new LiveMarketFetchError(`yahoo has no result for ${requestedSymbol}`, "no_value");
  }
  const priceRaw = meta.regularMarketPrice;
  if (typeof priceRaw !== "number" || !Number.isFinite(priceRaw)) {
    throw new LiveMarketFetchError(
      `yahoo has no regularMarketPrice for ${requestedSymbol}`,
      "no_value",
    );
  }
  const marketTime = meta.regularMarketTime;
  if (typeof marketTime !== "number" || !Number.isFinite(marketTime)) {
    throw new LiveMarketFetchError(
      `yahoo has no regularMarketTime for ${requestedSymbol}`,
      "stale_or_invalid",
    );
  }
  const currency = typeof meta.currency === "string" && meta.currency ? meta.currency : "USD";
  return {
    symbol: requestedSymbol.toUpperCase(),
    price: priceRaw,
    // regularMarketTime is epoch seconds.
    quoteTimestamp: new Date(marketTime * 1000).toISOString(),
    currency,
    // The public chart endpoint is delayed, not realtime execution-grade.
    delayStatus: "delayed",
    sourceUrlOrArtifact,
  };
}

export async function fetchYahooQuote(
  symbol: string,
  options: ApiTransportOptions & { fetchImpl?: FetchImpl } = {},
): Promise<LiveMarketQuote> {
  const fetchImpl = resolveFinanceFetch(options.fetchImpl, options);
  let lastError: LiveMarketFetchError | undefined;
  for (const host of YAHOO_CHART_HOSTS) {
    const url = YAHOO_CHART_URL(symbol, host);
    let response: { ok: boolean; status: number; text: () => Promise<string> };
    try {
      response = await fetchImpl(url, { headers: YAHOO_HEADERS });
    } catch (error) {
      if (error instanceof ApiCallError) {
        if (error.kind === "timeout" || error.kind === "cancelled") {
          throw error;
        }
        if (error.kind === "http_error" && error.httpStatus === 403) {
          lastError = new LiveMarketFetchError(error.message, "forbidden");
          continue;
        }
        if (error.kind === "forbidden") {
          lastError = new LiveMarketFetchError(error.message, "forbidden");
          continue;
        }
        if (error.kind === "http_error") {
          throw new LiveMarketFetchError(error.message, "http_error");
        }
      }
      lastError = new LiveMarketFetchError(
        `yahoo request failed on ${host}: ${(error as Error).message}`,
        "network_error",
      );
      continue;
    }
    if (!response.ok) {
      lastError = new LiveMarketFetchError(
        `yahoo http status ${response.status} on ${host}`,
        response.status === 403 ? "forbidden" : "http_error",
      );
      continue;
    }
    try {
      const body = await response.text();
      return parseYahooChart(body, symbol, url);
    } catch (error) {
      if (!(error instanceof LiveMarketFetchError)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError ?? new LiveMarketFetchError("yahoo request failed", "network_error");
}

// Map a fetched quote into the gateway's observation contract, preserving full
// provenance (source timestamp, field definition, unit/currency, adjusted
// status, source URL). One quote becomes one observation with a `last_price`
// field. The provider role lets the same quote act as primary or cross-check.
export function quoteToObservation(
  quote: LiveMarketQuote,
  params: {
    providerName: string;
    providerRole: FinanceDataGatewayObservationInput["providerRole"];
    observedAt: string;
    timezone?: string;
  },
): FinanceDataGatewayObservationInput {
  return {
    providerName: params.providerName,
    providerRole: params.providerRole,
    sourceFamily: "market_data_api",
    observedAt: params.observedAt,
    timezone: params.timezone ?? "UTC",
    delayStatus: quote.delayStatus,
    fields: [
      {
        name: "last_price",
        value: quote.price,
        currency: quote.currency,
        adjusted: false,
        fieldDefinition: `${quote.delayStatus} consolidated last/close price from ${params.providerName}`,
        sourceTimestamp: quote.quoteTimestamp,
        sourceUrlOrArtifact: quote.sourceUrlOrArtifact,
      },
    ],
  };
}

export type CollectLiveSnapshotOptions = {
  instrument: string;
  assetClass: string;
  useCase: string;
  /** When false, run without an official/issuer reference provider. */
  requireOfficialReference?: boolean;
  freshnessMaxMinutes?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  fetchImpl?: FetchImpl;
};

// Compose fetch -> observation -> gateway. This is the live counterpart to the
// fixture builder in finance-data-gateway-smoke.ts. It fetches one real quote
// and feeds it into the pure gateway validator. On any fetch/data failure it
// throws a LiveMarketFetchError so callers fail closed instead of silently
// degrading to a fake or empty snapshot.
export async function collectLiveFinanceGatewayInput(
  options: CollectLiveSnapshotOptions,
): Promise<FinanceDataGatewayInput> {
  const now = (options.now ?? (() => new Date()))();
  const observedAt = now.toISOString();
  const quote = await fetchYahooQuote(options.instrument, { fetchImpl: options.fetchImpl });

  // A single public source can only honestly fill the primary market data
  // role. Cross-check and official/issuer references still require separate
  // real providers, so the gateway will mark this snapshot as `blocked` until
  // those are supplied — which is the correct, non-silent behavior.
  const observations: FinanceDataGatewayObservationInput[] = [
    quoteToObservation(quote, {
      providerName: `yahoo-${options.instrument.toLowerCase()}`,
      providerRole: "primary_market_data",
      observedAt,
    }),
  ];

  return {
    instrument: options.instrument,
    assetClass: options.assetClass,
    useCase: options.useCase,
    asOf: observedAt,
    freshnessMaxMinutes: options.freshnessMaxMinutes,
    requireOfficialReference: options.requireOfficialReference,
    observations,
  };
}
