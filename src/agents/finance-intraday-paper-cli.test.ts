import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildFinanceIntradayPaperPayload } from "../../scripts/operator/lcx-finance-intraday-paper.js";
import { appendFinanceIntradayBars } from "./finance-intraday-ledger.js";

it("selects identical ledger bars for UTC, offset and mixed-offset replay windows", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-offset-"));
  try {
    const start = Date.parse("2026-01-05T14:30:00Z");
    await appendFinanceIntradayBars(directory, {
      instrument: "SPY",
      intervalSeconds: 300,
      observedAt: "2026-01-05T21:01:00Z",
      provenance: { origin: "fixture", feed: "iex" },
      bars: Array.from({ length: 78 }, (_, index) => ({
        startAt: new Date(start + index * 300_000).toISOString(),
        open: index <= 3 ? 100 : 101,
        high: index < 3 ? 100 : 101,
        low: 100,
        close: index < 3 ? 100 : 101,
        volume: 1000,
      })),
    });
    const args = [
      "--instrument",
      "SPY",
      "--ledger-dir",
      directory,
      "--opening-range-bars",
      "3",
      "--capital",
      "10000",
      "--max-allocation",
      "0.5",
      "--fee-bps-per-side",
      "0",
      "--spread-bps",
      "0",
      "--slippage-bps-per-side",
      "0",
    ];
    const utc = await buildFinanceIntradayPaperPayload([
      ...args,
      "--from",
      "2026-01-05T14:30:00Z",
      "--to",
      "2026-01-05T21:00:00Z",
    ]);
    for (const from of ["2026-01-05T09:30:00-05:00", "2026-01-05T14:30:00Z"]) {
      const offset = await buildFinanceIntradayPaperPayload([
        ...args,
        "--from",
        from,
        "--to",
        "2026-01-05T16:00:00-05:00",
      ]);
      expect(offset.source.selectedBars).toBe(78);
      expect(offset.receipt).toEqual(utc.receipt);
    }
    await expect(
      buildFinanceIntradayPaperPayload([
        ...args,
        "--from",
        "2026-01-05T16:00:00-05:00",
        "--to",
        "2026-01-05T20:00:00Z",
      ]),
    ).rejects.toThrow("ordered ISO timestamps");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
