import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheFile } from "../paper-loop/cache.ts";
import { runTrendAnalysis } from "../paper-loop/loop.ts";

/**
 * The trend lane pages through daily klines and caches each page by request URL.
 * `end` defaults to `Date.now()`, so a page whose key carried `endTime` was a
 * permanent cache miss: it was refetched on every run and re-stored a
 * byte-identical payload. These tests pin the contract that makes the cache
 * useful -- `endTime` appears only on a page whose window can run past it.
 */

const DAY_MS = 86_400_000;

/** Binance klines row: [openTime, open, high, low, close, ...]. */
function klines(count: number, startMs: number): unknown[][] {
  return Array.from({ length: count }, (_, i) => [
    startMs + i * DAY_MS,
    "1",
    "1",
    "1",
    "1",
    "0",
    0,
    "0",
    0,
    "0",
    "0",
    "0",
  ]);
}

const requestedUrls: string[] = [];

function stubKlines(): void {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    const params = new URL(url).searchParams;
    const limit = Number(params.get("limit"));
    const startTime = params.get("startTime");
    const endTime = Number(params.get("endTime"));
    const start = startTime ? Number(startTime) : endTime - limit * DAY_MS;
    return new Response(JSON.stringify(klines(limit, start)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function pageUrl(limit: string): string {
  const url = requestedUrls.find(
    (candidate) => new URL(candidate).searchParams.get("limit") === limit,
  );
  if (!url) {
    throw new Error(`no requested page had limit=${limit}: ${requestedUrls.join(", ")}`);
  }
  return url;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const url of requestedUrls) {
    const file = cacheFile(url);
    if (existsSync(file)) {
      rmSync(file);
    }
  }
  requestedUrls.length = 0;
});

describe("trend kline cache keys", () => {
  it("omits endTime from a page that sits entirely in the past", async () => {
    stubKlines();
    await runTrendAnalysis({
      symbols: ["BTCUSDT"],
      bars: 1800,
      start: "2021-11-08",
      end: "2026-09-10",
      useCache: false,
    });

    // 1000 days from 2021-11-08 lands well before the requested end.
    expect(new URL(pageUrl("1000")).searchParams.get("endTime")).toBeNull();
  });

  it("keeps endTime on the trailing page, whose window runs past the end", async () => {
    stubKlines();
    await runTrendAnalysis({
      symbols: ["BTCUSDT"],
      bars: 1800,
      start: "2021-11-08",
      end: "2026-09-10",
      useCache: false,
    });

    // The second page starts after the first 1000 days and reaches past the end.
    expect(new URL(pageUrl("800")).searchParams.get("endTime")).toBe(
      String(Date.parse("2026-09-10T00:00:00Z")),
    );
  });

  it("issues a byte-identical historical page URL for different end dates", async () => {
    stubKlines();
    await runTrendAnalysis({
      symbols: ["BTCUSDT"],
      bars: 1800,
      start: "2021-11-08",
      end: "2026-09-10",
      useCache: false,
    });
    const earlier = pageUrl("1000");

    requestedUrls.length = 0;
    stubKlines();
    await runTrendAnalysis({
      symbols: ["BTCUSDT"],
      bars: 1800,
      start: "2021-11-08",
      end: "2026-09-11",
      useCache: false,
    });
    const later = pageUrl("1000");

    expect(later).toBe(earlier);
  });
});
