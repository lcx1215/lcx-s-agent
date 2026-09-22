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
