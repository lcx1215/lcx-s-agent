import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import type { FinanceDailyCycleExecutionQuoteProvider } from "./finance-daily-cycle.js";
import {
  createFinanceUncachedFetch,
  type FinanceUncachedFetch,
} from "./finance-write-transport.js";

export const ALPACA_EXECUTION_QUOTE_FEEDS = ["iex", "sip"] as const;
export type AlpacaExecutionQuoteFeed = (typeof ALPACA_EXECUTION_QUOTE_FEEDS)[number];
export type AlpacaExecutionQuoteFailureCode =
  | "unsupported_instrument"
  | "credentials_unavailable"
  | "transport_error"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "provider_error"
  | "http_error"
  | "invalid_json"
  | "invalid_quote";

export class AlpacaExecutionQuoteError extends Error {
  constructor(
    readonly failureCode: AlpacaExecutionQuoteFailureCode,
    readonly httpStatus?: number,
  ) {
    const description =
      failureCode === "unsupported_instrument"
        ? "Alpaca execution quotes currently support unambiguous US-equity symbols only; crypto quote capability unavailable"
        : failureCode === "credentials_unavailable"
          ? "Alpaca quote credentials unavailable"
          : failureCode === "invalid_quote"
            ? "Alpaca execution quote requires positive noncrossed bid/ask and a native timestamp"
            : `Alpaca execution quote ${failureCode}`;
    super(description + (httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`));
    this.name = "AlpacaExecutionQuoteError";
  }
}

/** Strict execution reference adapter; research adapters retain their delayed/legacy contract. */
export function createAlpacaExecutionQuoteProvider(options: {
  feed: AlpacaExecutionQuoteFeed;
  maxAgeMs: number;
  read?: FinanceUncachedFetch;
  credentials?: { apiKeyId: string; apiSecretKey: string };
}): FinanceDailyCycleExecutionQuoteProvider {
  if (
    !ALPACA_EXECUTION_QUOTE_FEEDS.includes(options.feed) ||
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs <= 0
  ) {
    throw new Error(
      "an explicit supported execution quote feed and positive maxAgeMs are required",
    );
  }
  const read = options.read ?? createFinanceUncachedFetch();
  return async (request, signal) => {
    signal.throwIfAborted();
    const symbol = request.instrument.trim().toUpperCase();
    if (
      request.assetClass !== "us_equity" ||
      !/^[A-Z][A-Z0-9.-]{0,14}$/u.test(symbol) ||
      /(?:USD|USDT)$/u.test(symbol)
    ) {
      throw new AlpacaExecutionQuoteError("unsupported_instrument");
    }
    const env = options.credentials ? undefined : resolveFinanceCredentialEnv(process.env);
    const key = options.credentials?.apiKeyId ?? env?.ALPACA_API_KEY_ID;
    const secret = options.credentials?.apiSecretKey ?? env?.ALPACA_API_SECRET_KEY;
    if (typeof key !== "string" || !key.trim() || typeof secret !== "string" || !secret.trim()) {
      throw new AlpacaExecutionQuoteError("credentials_unavailable");
    }
    const sourceUrlOrArtifact = `https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=${encodeURIComponent(symbol)}&feed=${options.feed}`;
    const response = await new Promise<Awaited<ReturnType<FinanceUncachedFetch>>>(
      (resolve, reject) => {
        const aborted = () =>
          reject(signal.reason ?? new AlpacaExecutionQuoteError("transport_error"));
        signal.addEventListener("abort", aborted, { once: true });
        void Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return read(sourceUrlOrArtifact, {
              headers: {
                "APCA-API-KEY-ID": key,
                "APCA-API-SECRET-KEY": secret,
                accept: "application/json",
              },
              signal,
            });
          })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", aborted));
      },
    ).catch((error: unknown) => {
      if (signal.aborted) {
        throw error;
      }
      throw new AlpacaExecutionQuoteError("transport_error");
    });
    signal.throwIfAborted();
    if (response.status !== 200) {
      const failureCode =
        response.status === 401
          ? "unauthorized"
          : response.status === 403
            ? "forbidden"
            : response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "provider_error"
                : "http_error";
      throw new AlpacaExecutionQuoteError(failureCode, response.status);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch {
      throw new AlpacaExecutionQuoteError("invalid_json");
    }
    const quotes =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).quotes
        : undefined;
    const quoteCandidate =
      quotes !== null && typeof quotes === "object" && !Array.isArray(quotes)
        ? (quotes as Record<string, unknown>)[symbol]
        : undefined;
    const quote =
      quoteCandidate !== null &&
      typeof quoteCandidate === "object" &&
      !Array.isArray(quoteCandidate)
        ? (quoteCandidate as Record<string, unknown>)
        : undefined;
    if (
      !quote ||
      typeof quote.bp !== "number" ||
      !Number.isFinite(quote.bp) ||
      quote.bp <= 0 ||
      typeof quote.ap !== "number" ||
      !Number.isFinite(quote.ap) ||
      quote.ap < quote.bp ||
      typeof quote.t !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/u.test(quote.t) ||
      !Number.isFinite(Date.parse(quote.t))
    ) {
      throw new AlpacaExecutionQuoteError("invalid_quote");
    }
    return {
      referencePrice: request.side === "buy" ? quote.ap : quote.bp,
      referencePriceAt: quote.t,
      bidPrice: quote.bp,
      askPrice: quote.ap,
      priceBasis: request.side === "buy" ? "ask" : "bid",
      feed: options.feed,
      sourceUrlOrArtifact,
      maxAgeMs: options.maxAgeMs,
    };
  };
}
