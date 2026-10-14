import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAlpacaIntradayBars } from "./finance-alpaca-intraday.js";
import { readFinanceIntradayLedger } from "./finance-intraday-ledger.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

describe("Alpaca intraday sync", () => {
  it("follows a symbol-bound empty page before consuming a later closed bar", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-empty-page-"));
    temporary.push(directory);
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ symbol: "WBD", bars: null, next_page_token: "more" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          symbol: "WBD",
          bars: [{ t: "2026-01-05T14:30:00Z", o: 30, h: 31, l: 29, c: 30, v: 1 }],
          next_page_token: null,
        }),
      });
    const result = await syncAlpacaIntradayBars({
      directory,
      instrument: "WBD",
      start: "2026-01-05T14:30:00Z",
      end: "2026-01-05T14:40:00Z",
      intervalSeconds: 300,
      feed: "iex",
      credentials: { apiKeyId: "key", apiSecretKey: "secret" },
      read,
      now: () => new Date("2026-01-05T15:00:00Z"),
    });
    expect(result).toMatchObject({ pages: 2, barsReceived: 1, closedBarsAccepted: 1 });
    expect(read.mock.calls[1]?.[0]).toContain("page_token=more");
    expect((await readFinanceIntradayLedger(directory)).bars).toHaveLength(1);
  });

  it.each([
    { bars: null, symbol: "WBD", next_page_token: null },
    { bars: [], symbol: "WBD", next_page_token: null },
    { bars: [{ t: "2026-01-05T14:35:00Z", o: 30, h: 31, l: 29, c: 30, v: 1 }] },
  ])("reports unavailable closed data without recording prices: %j", async (body) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-empty-intraday-"));
    temporary.push(directory);
    await expect(
      syncAlpacaIntradayBars({
        directory,
        instrument: "WBD",
        start: "2026-01-05T14:30:00Z",
        end: "2026-01-05T14:38:00Z",
        intervalSeconds: 300,
        feed: "iex",
        credentials: { apiKeyId: "key", apiSecretKey: "secret" },
        read: vi.fn().mockResolvedValue({ status: 200, body: JSON.stringify(body) }),
        now: () => new Date("2026-01-05T14:38:00Z"),
      }),
    ).rejects.toMatchObject({
      name: "AlpacaIntradayBarsUnavailableError",
      observation: {
        status: "unavailable",
        reason: "no_closed_bars",
        instrument: "WBD",
        feed: "iex",
        closedBarsAccepted: 0,
        append: null,
        orderPathTouched: false,
      },
    });
    expect((await readFinanceIntradayLedger(directory)).recordCount).toBe(0);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each([
    { bars: null },
    { bars: null, symbol: "SPY", next_page_token: null },
    { bars: null, symbol: "WBD", next_page_token: 7 },
    { bars: {} },
  ])("keeps malformed empty responses blocked: %j", async (body) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-bad-empty-intraday-"));
    temporary.push(directory);
    await expect(
      syncAlpacaIntradayBars({
        directory,
        instrument: "WBD",
        start: "2026-01-05T14:30:00Z",
        end: "2026-01-05T14:40:00Z",
        intervalSeconds: 300,
        feed: "iex",
        credentials: { apiKeyId: "key", apiSecretKey: "secret" },
        read: vi.fn().mockResolvedValue({ status: 200, body: JSON.stringify(body) }),
        now: () => new Date("2026-01-05T15:00:00Z"),
      }),
    ).rejects.toThrow("response is malformed");
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("reuses the authenticated read seam, paginates, skips an unclosed bar, and appends locally", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-intraday-"));
    temporary.push(directory);
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          bars: [{ t: "2026-01-05T14:30:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 12 }],
          next_page_token: "next",
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          bars: [{ t: "2026-01-05T14:35:00Z", o: 100.5, h: 102, l: 100, c: 101, v: 15 }],
        }),
      });
    const result = await syncAlpacaIntradayBars({
      directory,
      instrument: "SPY",
      start: "2026-01-05T14:30:00Z",
      end: "2026-01-05T14:40:00Z",
      intervalSeconds: 300,
      feed: "iex",
      credentials: { apiKeyId: "key", apiSecretKey: "secret" },
      read,
      now: () => new Date("2026-01-05T14:38:00Z"),
    });
    expect(result).toMatchObject({
      pages: 2,
      barsReceived: 2,
      closedBarsAccepted: 1,
      unclosedBarsSkipped: 1,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(String(read.mock.calls[1]?.[0])).toContain("page_token=next");
    expect((await readFinanceIntradayLedger(directory)).bars).toHaveLength(1);
  });

  it("refuses malformed prices before writing", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-intraday-"));
    temporary.push(directory);
    await expect(
      syncAlpacaIntradayBars({
        directory,
        instrument: "SPY",
        start: "2026-01-05T14:30:00Z",
        end: "2026-01-05T14:40:00Z",
        intervalSeconds: 300,
        feed: "iex",
        credentials: { apiKeyId: "key", apiSecretKey: "secret" },
        read: vi.fn().mockResolvedValue({
          status: 200,
          body: JSON.stringify({
            bars: [{ t: "2026-01-05T14:30:00Z", o: 0, h: 1, l: 1, c: 1, v: 1 }],
          }),
        }),
        now: () => new Date("2026-01-05T15:00:00Z"),
      }),
    ).rejects.toThrow(/positive open/);
    expect((await readFinanceIntradayLedger(directory)).recordCount).toBe(0);
  });
});

it("consumes cumulative HWM revision through the original native sync and cutoff reader", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hwm-native-revision-"));
  try {
    const old = { t: "2026-10-14T14:35:00Z", o: 219.71, h: 219.71, l: 219.39, c: 219.39, v: 1049 };
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ symbol: "HWM", bars: [old], next_page_token: null }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          symbol: "HWM",
          bars: [{ ...old, c: 219.595, v: 1162 }],
          next_page_token: null,
        }),
      });
    const opts = {
      directory,
      instrument: "HWM",
      start: "2026-10-14T14:35:00Z",
      end: "2026-10-14T14:40:00Z",
      intervalSeconds: 300 as const,
      feed: "iex" as const,
      read,
      credentials: { apiKeyId: "synthetic", apiSecretKey: "synthetic" },
    };
    await syncAlpacaIntradayBars({ ...opts, now: () => new Date("2026-10-14T14:40:00.640Z") });
    await syncAlpacaIntradayBars({ ...opts, now: () => new Date("2026-10-14T14:43:00.000Z") });
    expect(
      (await readFinanceIntradayLedger(directory, { instrument: "HWM", feed: "iex" })).bars,
    ).toMatchObject([{ close: 219.595, volume: 1162 }]);
    expect(
      (
        await readFinanceIntradayLedger(directory, {
          instrument: "HWM",
          feed: "iex",
          asOf: "2026-10-14T14:41:00Z",
        })
      ).bars,
    ).toMatchObject([{ close: 219.39, volume: 1049 }]);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each(["wrong_symbol", "cancelled"])(
  "does not append a native revision from %s read",
  async (kind) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hwm-revision-boundary-"));
    try {
      const caller = new AbortController();
      const read = vi.fn(async () => {
        if (kind === "cancelled") {
          caller.abort();
        }
        return {
          status: 200,
          body: JSON.stringify({
            symbol: kind === "wrong_symbol" ? "SPY" : "HWM",
            bars: [
              { t: "2026-10-14T14:35:00Z", o: 219.71, h: 219.71, l: 219.39, c: 219.595, v: 1162 },
            ],
            next_page_token: null,
          }),
        };
      });
      await expect(
        syncAlpacaIntradayBars({
          directory,
          instrument: "HWM",
          start: "2026-10-14T14:35:00Z",
          end: "2026-10-14T14:40:00Z",
          intervalSeconds: 300,
          feed: "iex",
          read,
          signal: caller.signal,
          credentials: { apiKeyId: "synthetic", apiSecretKey: "synthetic" },
          now: () => new Date("2026-10-14T14:43:00Z"),
        }),
      ).rejects.toThrow();
      expect((await readFinanceIntradayLedger(directory)).recordCount).toBe(0);
      expect(read).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
