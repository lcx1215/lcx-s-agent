import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  appendFinanceIntradayBars,
  readFinanceIntradayLedger,
  type FinanceIntradayAppendInput,
} from "./finance-intraday-ledger.js";
import { financeIntradayLedgerPath } from "./finance-state-dir.js";

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

it("reuses byte proofs while decoding only selected intraday records", async () => {
  const root = await directory();
  await appendFinanceIntradayBars(root, input());
  await appendFinanceIntradayBars(root, { ...input(), instrument: "QQQ" });
  const all = await readFinanceIntradayLedger(root);
  const parse = vi.spyOn(JSON, "parse");
  try {
    const selected = await readFinanceIntradayLedger(root, { instrument: "SPY" });
    expect(selected).toEqual({ ...all, bars: all.bars.filter((bar) => bar.instrument === "SPY") });
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});

it.each(["body", "ref", "previousRef"] as const)(
  "still rejects changed omitted intraday records after warming proofs: %s",
  async (change) => {
    const root = await directory();
    await appendFinanceIntradayBars(root, input());
    await appendFinanceIntradayBars(root, { ...input(), instrument: "QQQ" });
    await readFinanceIntradayLedger(root);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(financeIntradayLedgerPath(root));
    try {
      const row = db.prepare("SELECT body FROM finance_intraday_records WHERE sequence=2").get();
      if (typeof row?.body !== "string") {
        throw new Error("missing fixture");
      }
      const raw = JSON.parse(row.body);
      if (change === "previousRef") {
        raw.previousRef = null;
      } else if (change === "body") {
        raw.body.bars[0].close = 999;
      }
      db.prepare("UPDATE finance_intraday_records SET body=?,ref=? WHERE sequence=2").run(
        JSON.stringify(raw),
        change === "previousRef" ? caseflowFingerprint(raw) : "0".repeat(64),
      );
    } finally {
      db.close();
    }
    await expect(readFinanceIntradayLedger(root, { instrument: "SPY" })).rejects.toThrow(
      /intraday record (integrity|chain) mismatch/u,
    );
    await expect(appendFinanceIntradayBars(root, input())).rejects.toThrow(
      /intraday record (integrity|chain) mismatch/u,
    );
  },
);

it("does not cache returned bars and preserves scoped head and cutoff", async () => {
  const root = await directory();
  await appendFinanceIntradayBars(root, input());
  await appendFinanceIntradayBars(root, { ...input(), instrument: "QQQ" });
  const first = await readFinanceIntradayLedger(root, { instrument: "SPY" });
  first.bars[0].close = 999;
  const again = await readFinanceIntradayLedger(root, { instrument: "SPY", feed: "test" });
  expect(again.bars[0].close).toBe(101);
  expect(again.recordCount).toBe(2);
  expect(again.headRef).toBe(first.headRef);
  expect(
    await readFinanceIntradayLedger(root, { instrument: "SPY", asOf: "2026-01-05T14:39:00Z" }),
  ).toEqual({ ...again, bars: [] });
  expect(await readFinanceIntradayLedger(root, { instrument: "SPY", feed: "other" })).toEqual({
    ...again,
    bars: [],
  });
});

it("preserves full append numbering and deduplication after a scoped proof read", async () => {
  const root = await directory();
  await appendFinanceIntradayBars(root, input());
  const tail = await appendFinanceIntradayBars(root, { ...input(), instrument: "QQQ" });
  await readFinanceIntradayLedger(root, { instrument: "SPY" });
  expect(await appendFinanceIntradayBars(root, input())).toMatchObject({
    appended: false,
    recordCount: 2,
    headRef: tail.headRef,
  });
  const next = await appendFinanceIntradayBars(root, { ...input(), instrument: "TLT" });
  const ledger = await readFinanceIntradayLedger(root);
  expect(next.appended).toBe(true);
  expect(ledger.recordCount).toBe(3);
  expect(ledger.headRef).toBe(next.headRef);
  expect(ledger.bars.map((bar) => bar.instrument)).toEqual(["QQQ", "SPY", "TLT"]);
  await expect(appendFinanceIntradayBars(root, input(103))).rejects.toThrow(
    /conflicting intraday bar/u,
  );
});
