import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendFinanceIntradayBars,
  readFinanceIntradayLedger,
  type FinanceIntradayAppendInput,
} from "./finance-intraday-ledger.js";

const temporary: string[] = [];

async function directory(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "finance-intraday-"));
  temporary.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

function input(close = 101): FinanceIntradayAppendInput {
  return {
    instrument: "SPY",
    intervalSeconds: 300,
    observedAt: "2026-01-05T14:40:00.000Z",
    provenance: { origin: "fixture", feed: "test" },
    bars: [
      {
        startAt: "2026-01-05T14:30:00.000Z",
        open: 100,
        high: Math.max(102, close),
        low: 99,
        close,
        volume: 1000,
      },
    ],
  };
}

describe("finance intraday ledger", () => {
  it("appends, reads, and idempotently skips an exact replay", async () => {
    const root = await directory();
    const first = await appendFinanceIntradayBars(root, input());
    const second = await appendFinanceIntradayBars(root, input());
    const ledger = await readFinanceIntradayLedger(root, { instrument: "SPY" });
    expect(first.appended).toBe(true);
    expect(second).toMatchObject({ appended: false, repeatsSkipped: 1, recordCount: 1 });
    expect(ledger.bars).toHaveLength(1);
    expect(ledger.bars[0]?.endAt).toBe("2026-01-05T14:35:00.000Z");
  });

  it("refuses a conflicting value for the same instrument interval", async () => {
    const root = await directory();
    await appendFinanceIntradayBars(root, input());
    await expect(appendFinanceIntradayBars(root, input(103))).rejects.toThrow(
      /conflicting intraday bar/,
    );
  });

  it("refuses bars before close and future observations", async () => {
    const root = await directory();
    await expect(
      appendFinanceIntradayBars(root, { ...input(), observedAt: "2026-01-05T14:32:00.000Z" }),
    ).rejects.toThrow(/before it closed/);
    await expect(
      appendFinanceIntradayBars(root, { ...input(), observedAt: "2099-01-05T14:40:00.000Z" }),
    ).rejects.toThrow(/future/);
  });

  it("applies record observation time to point-in-time reads", async () => {
    const root = await directory();
    await appendFinanceIntradayBars(root, input());
    expect(
      (await readFinanceIntradayLedger(root, { asOf: "2026-01-05T14:39:00.000Z" })).bars,
    ).toHaveLength(0);
    expect(
      (await readFinanceIntradayLedger(root, { asOf: "2026-01-05T14:40:00.000Z" })).bars,
    ).toHaveLength(1);
  });
});
