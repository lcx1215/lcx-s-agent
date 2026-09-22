import { fetch } from "undici";
import {
  ALPACA_FINANCE_HTTP_BODY_MAX_BYTES,
  readBoundedFinanceResponseText,
} from "./finance-http-body.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

/** Dedicated uncached GET: no redirects, credential lookup, ambient proxy discovery, or writes. */
export function createAlpacaSafetyReadTransport(): FinanceUncachedFetch {
  return async (url, init) => {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !["paper-api.alpaca.markets", "data.alpaca.markets"].includes(parsed.hostname)
    ) {
      throw new Error("Alpaca safety read host denied");
    }
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: init.headers,
      signal: init.signal,
    });
    return {
      status: response.status,
      body: await readBoundedFinanceResponseText(response, {
        maxBytes: ALPACA_FINANCE_HTTP_BODY_MAX_BYTES,
        label: "Alpaca safety",
      }),
    };
  };
}
