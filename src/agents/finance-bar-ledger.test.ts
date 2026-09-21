import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendFinanceBars,
  collapseRepeatedBars,
  FINANCE_BAR_DERIVATIONS,
  FINANCE_BAR_RECORD_SCHEMA,
  financeBarLedgerExists,
  readFinanceBarLedger,
  type FinanceBar,
  type FinanceBarAppendInput,
} from "./finance-bar-ledger.js";

const OBSERVED = "2026-09-10T00:00:00Z";
const directories: string[] = [];

type OhlcvInput = Extract<FinanceBarAppendInput, { derivation: "ohlcv" }>;
type PointInput = Extract<FinanceBarAppendInput, { derivation: "point_derived" }>;

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-bar-ledger-"));
  directories.push(directory);
  return directory;
}

function ohlcv(date: string, open: number, high: number, low: number, close: number) {
  return { date, open, high, low, close };
}

/** A point observation has no range: it is one price at one instant. */
function point(date: string, price: number, time = "00:00:00Z") {
  return { date, price, at: `${date}T${time}` };
}

function ohlcvInput(overrides: Partial<OhlcvInput> = {}): OhlcvInput {
  return {
    instrument: "AAA",
    derivation: "ohlcv",
    provenance: { origin: "test-source" },
    observedAt: OBSERVED,
    bars: [ohlcv("2026-09-01", 100, 104, 98, 102)],
    ...overrides,
  };
}

function pointInput(overrides: Partial<PointInput> = {}): PointInput {
  return {
    instrument: "AAA",
    derivation: "point_derived",
    provenance: { origin: "test-source" },
    observedAt: OBSERVED,
    points: [point("2026-09-01", 100)],
    ...overrides,
  };
}

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("finance-bar-ledger", () => {
  it("exposes both derivations and no others", () => {
    expect([...FINANCE_BAR_DERIVATIONS]).toEqual(["ohlcv", "point_derived"]);
  });

  it("appends a real OHLCV batch and replays it as a no-op", async () => {
    const directory = await storeDirectory();
    const first = await appendFinanceBars(directory, ohlcvInput());
    expect(first.appended).toBe(true);
    expect(first.recordCount).toBe(1);

    const replay = await appendFinanceBars(directory, ohlcvInput());
    expect(replay.appended).toBe(false);
    expect(replay.recordCount).toBe(1);

    const ledger = await readFinanceBarLedger(directory);
    expect(ledger.bars).toHaveLength(1);
    expect(ledger.bars[0]?.close).toBe(102);
    // A vendor bar carries a real range, so there is nothing to count.
    expect(ledger.bars[0]?.sampleCount).toBeNull();
  });

  it("files only the days that are new when a full history is re-collected", async () => {
    const directory = await storeDirectory();
    // The unattended cycle re-collects the whole series every run (the vendor has no incremental
    // endpoint). Batching by content rather than by batch identity is what keeps the book from
    // gaining a full copy of history per run.
    await appendFinanceBars(
      directory,
      ohlcvInput({
        bars: [ohlcv("2026-09-01", 100, 104, 98, 102), ohlcv("2026-09-02", 102, 106, 100, 104)],
      }),
    );
    const second = await appendFinanceBars(
      directory,
      ohlcvInput({
        bars: [
          ohlcv("2026-09-01", 100, 104, 98, 102),
          ohlcv("2026-09-02", 102, 106, 100, 104),
          ohlcv("2026-09-03", 104, 108, 102, 106),
        ],
      }),
    );
    expect(second.appended).toBe(true);
    expect(second.repeatsSkipped).toBe(2);
    // Only the new day is filed: the two repeats are not new evidence.
    expect(second.record.body.bars.map((bar) => bar.date)).toEqual(["2026-09-03"]);

    const ledger = await readFinanceBarLedger(directory);
    expect(ledger.bars.map((bar) => bar.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("writes nothing when a re-collection brings no new day, and says so", async () => {
    const directory = await storeDirectory();
    const bars = [ohlcv("2026-09-01", 100, 104, 98, 102), ohlcv("2026-09-02", 102, 106, 100, 104)];
    await appendFinanceBars(directory, ohlcvInput({ bars }));
    const again = await appendFinanceBars(directory, ohlcvInput({ bars }));
    expect(again.appended).toBe(false);
    expect(again.repeatsSkipped).toBe(2);
    expect(again.recordCount).toBe(1);
  });

  it("still files a day whose values changed, so a vendor revision is not lost", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(
      directory,
      ohlcvInput({ bars: [ohlcv("2026-09-01", 100, 104, 98, 102)] }),
    );
    const revised = await appendFinanceBars(
      directory,
      ohlcvInput({
        provenance: { origin: "source-b" },
        bars: [ohlcv("2026-09-01", 100, 104, 98, 103)],
      }),
    );
    // A changed value is not a replay: it is a second opinion, and it must reach the book.
    expect(revised.appended).toBe(true);
    expect(revised.repeatsSkipped).toBe(0);
    const ledger = await readFinanceBarLedger(directory);
    expect(ledger.bars).toHaveLength(2);
    expect(ledger.divergentDates).toEqual(["AAA@2026-09-01"]);
  });

  it("rejects prices that cannot be true together", async () => {
    const directory = await storeDirectory();
    await expect(
      appendFinanceBars(directory, ohlcvInput({ bars: [ohlcv("2026-09-01", 100, 102, 101, 103)] })),
    ).rejects.toThrow(/impossible prices/);
  });

  it("makes a claimed range unrepresentable for point_derived input", async () => {
    const directory = await storeDirectory();
    // The point of the discriminated union: under `point_derived` there is no field in which a
    // caller could state a high/low it never observed. The shape is the enforcement.
    const forged = {
      instrument: "AAA",
      derivation: "point_derived",
      provenance: { origin: "test-source" },
      observedAt: OBSERVED,
      bars: [{ instrument: "AAA", date: "2026-09-01", open: 100, high: 104, low: 98, close: 102 }],
    } as unknown as FinanceBarAppendInput;
    await expect(appendFinanceBars(directory, forged)).rejects.toThrow(/invalid bar append/);
  });

  it("derives a day's range from the points it was given, not from a claimed one", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(
      directory,
      pointInput({
        points: [
          point("2026-09-01", 100, "01:00:00Z"),
          point("2026-09-01", 108, "02:00:00Z"),
          point("2026-09-01", 96, "03:00:00Z"),
          point("2026-09-01", 102, "04:00:00Z"),
        ],
      }),
    );
    const ledger = await readFinanceBarLedger(directory);
    // open = first observation, close = last, high/low = extremes *among the observations*.
    expect(ledger.bars[0]).toMatchObject({
      open: 100,
      high: 108,
      low: 96,
      close: 102,
      sampleCount: 4,
    });
  });

  it("orders a derived day by observation time, not by arrival order", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(
      directory,
      pointInput({
        points: [point("2026-09-01", 102, "04:00:00Z"), point("2026-09-01", 100, "01:00:00Z")],
      }),
    );
    const ledger = await readFinanceBarLedger(directory);
    expect(ledger.bars[0]?.open).toBe(100);
    expect(ledger.bars[0]?.close).toBe(102);
  });

  it("marks a single-observation day as range-unknown rather than range-zero", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(directory, pointInput());
    const ledger = await readFinanceBarLedger(directory);
    // high === low here means "no range was observed", which is not the same as "there was no
    // range". sampleCount is what lets a reader tell those apart.
    expect(ledger.bars[0]?.high).toBe(ledger.bars[0]?.low);
    expect(ledger.bars[0]?.sampleCount).toBe(1);
  });

  it("rejects a point filed under a day that does not match its instant", async () => {
    const directory = await storeDirectory();
    await expect(
      appendFinanceBars(
        directory,
        pointInput({
          points: [{ date: "2026-09-01", price: 100, at: "2026-09-02T01:00:00Z" }],
        }),
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("carries the instrument on the batch, never on the bar, so a mixed batch cannot be expressed", async () => {
    // Stronger than rejecting a mixed batch. Neither an ohlcv bar nor a point observation has an
    // `instrument` field, so the batch's instrument is the only one that can ever be recorded:
    // there is no way to file one instrument's prices under another's provenance, and therefore
    // no runtime check that someone could later drop.
    const directory = await storeDirectory();
    await appendFinanceBars(
      directory,
      ohlcvInput({ bars: [ohlcv("2026-09-01", 100, 104, 98, 102)] }),
    );
    await appendFinanceBars(
      directory,
      pointInput({ instrument: "BBB", points: [point("2026-09-02", 10)] }),
    );
    const ledger = await readFinanceBarLedger(directory);
    expect(ledger.bars.map((bar) => `${bar.instrument}@${bar.date}`)).toEqual([
      "AAA@2026-09-01",
      "BBB@2026-09-02",
    ]);
    // The exchange-aggregated bar has no sample count; the point-derived one does, and it is what
    // lets a reader tell "no range was observed" from "the range was zero".
    expect(ledger.bars[0]?.sampleCount).toBeNull();
    expect(ledger.bars[1]?.sampleCount).toBe(1);
  });

  it("rejects duplicate dates inside one batch", async () => {
    const directory = await storeDirectory();
    await expect(
      appendFinanceBars(
        directory,
        ohlcvInput({
          bars: [ohlcv("2026-09-01", 100, 104, 98, 102), ohlcv("2026-09-01", 101, 105, 99, 103)],
        }),
      ),
    ).rejects.toThrow(/duplicate dates/);
  });

  it("rejects a batch observed in the future", async () => {
    const directory = await storeDirectory();
    await expect(
      appendFinanceBars(directory, ohlcvInput({ observedAt: "2999-01-01T00:00:00Z" })),
    ).rejects.toThrow(/cannot be dated in the future/);
  });

  it("keeps both sides of a source disagreement and names the divergent dates", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(
      directory,
      ohlcvInput({
        provenance: { origin: "source-a" },
        bars: [ohlcv("2026-09-01", 100, 104, 98, 102)],
      }),
    );
    await appendFinanceBars(
      directory,
      ohlcvInput({
        provenance: { origin: "source-b" },
        bars: [ohlcv("2026-09-01", 100, 104, 98, 99)],
      }),
    );
    const ledger = await readFinanceBarLedger(directory);
    // Not collapsed: the disagreement is a fact about the sources, not a duplicate to drop.
    expect(ledger.bars).toHaveLength(2);
    expect(ledger.divergentDates).toEqual(["AAA@2026-09-01"]);
    expect(ledger.collapsedRepeats).toBe(0);
  });

  it("collapses exact replays on read but keeps a genuine second opinion", () => {
    // Writes no longer create replays, but the book is append-only: books written before that
    // change still hold them, and collapsing on read corrects them without rewriting history.
    const day: FinanceBar = {
      instrument: "AAA",
      date: "2026-09-01",
      open: 100,
      high: 104,
      low: 98,
      close: 102,
      volume: 1000,
      sampleCount: null,
    };
    const replay = collapseRepeatedBars([day, { ...day }]);
    expect(replay.bars).toHaveLength(1);
    expect(replay.collapsedRepeats).toBe(1);

    // Same day, different close: not a replay, a disagreement.
    const disagreement = collapseRepeatedBars([day, { ...day, close: 99 }]);
    expect(disagreement.bars).toHaveLength(2);
    expect(disagreement.collapsedRepeats).toBe(0);
  });

  it("filters by as-of and by instrument", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(
      directory,
      ohlcvInput({
        bars: [ohlcv("2026-09-01", 100, 104, 98, 102)],
        observedAt: "2026-09-01T00:00:00Z",
      }),
    );
    await appendFinanceBars(
      directory,
      ohlcvInput({
        bars: [ohlcv("2026-09-02", 102, 106, 100, 104)],
        observedAt: "2026-09-02T00:00:00Z",
      }),
    );
    const before = await readFinanceBarLedger(directory, { asOf: "2026-09-01T00:00:00Z" });
    expect(before.bars).toHaveLength(1);
    expect(before.bars[0]?.date).toBe("2026-09-01");

    const other = await readFinanceBarLedger(directory, { instrument: "BBB" });
    expect(other.bars).toHaveLength(0);
  });

  it("orders bars by instrument then date", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(
      directory,
      ohlcvInput({
        instrument: "BBB",
        provenance: { origin: "s" },
        bars: [ohlcv("2026-09-02", 10, 11, 9, 10)],
      }),
    );
    await appendFinanceBars(
      directory,
      ohlcvInput({ bars: [ohlcv("2026-09-01", 100, 104, 98, 102)] }),
    );
    const ledger = await readFinanceBarLedger(directory);
    expect(ledger.bars.map((bar) => `${bar.instrument}@${bar.date}`)).toEqual([
      "AAA@2026-09-01",
      "BBB@2026-09-02",
    ]);
  });

  it("does not create the book on a pure read", async () => {
    const directory = await storeDirectory();
    expect(await financeBarLedgerExists(directory)).toBe(false);
    const ledger = await readFinanceBarLedger(directory);
    expect(ledger.bars).toEqual([]);
    expect(ledger.headRef).toBeNull();
    expect(await financeBarLedgerExists(directory)).toBe(false);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("is a pure projection: same input, same output", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(
      directory,
      ohlcvInput({
        bars: [ohlcv("2026-09-01", 100, 104, 98, 102), ohlcv("2026-09-02", 102, 108, 96, 97)],
      }),
    );
    const first = await readFinanceBarLedger(directory);
    const second = await readFinanceBarLedger(directory);
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    expect(first.recordCount).toBe(1);
  });

  it("stamps the record schema on every stored record", async () => {
    const directory = await storeDirectory();
    const appended = await appendFinanceBars(directory, ohlcvInput());
    expect(FINANCE_BAR_RECORD_SCHEMA).toBe("lcx_finance_bar_record_v1");
    expect(appended.record.schemaVersion).toBe(FINANCE_BAR_RECORD_SCHEMA);
    expect(appended.record.previousRef).toBeNull();
  });
});
