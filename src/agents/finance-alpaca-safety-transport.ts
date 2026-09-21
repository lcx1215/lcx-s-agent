import { fetch } from "undici";
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
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Alpaca safety empty response");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) {
          break;
        }
        size += item.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          throw new Error("Alpaca safety response too large");
        }
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return { status: response.status, body: Buffer.concat(chunks).toString("utf8") };
  };
}
