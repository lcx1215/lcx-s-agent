import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  appendFinanceBars,
  collapseRepeatedBars,
  FINANCE_BAR_DERIVATIONS,
  FINANCE_BAR_RECORD_SCHEMA,
  financeBarLedgerExists,
  readFinanceBarLedger,
  type FinanceBar,
  type FinanceBarAppendInput,
  type FinanceBarRecord,
} from "./finance-bar-ledger.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeBarLedgerPath } from "./finance-state-dir.js";

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

/** Older writers filed repeats; build that valid, immutable history without the new write dedupe. */
function appendLegacyRecord(
  directory: string,
  previous: FinanceBarRecord,
  body: FinanceBarRecord["body"],
): FinanceBarRecord {
  const raw: Omit<FinanceBarRecord, "ref"> = {
    schemaVersion: FINANCE_BAR_RECORD_SCHEMA,
    recordKey: caseflowFingerprint(body),
    sequence: previous.sequence + 1,
    previousRef: previous.ref,
    recordedAt: OBSERVED,
    body,
  };
  const ref = caseflowFingerprint(raw);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(financeBarLedgerPath(directory));
  try {
    db.prepare(
      "INSERT INTO finance_bar_records (ref, sequence, previous_ref, recorded_at, body) VALUES (?, ?, ?, ?, ?)",
    ).run(ref, raw.sequence, raw.previousRef, raw.recordedAt, JSON.stringify(raw));
  } finally {
    db.close();
  }
  return { ...raw, ref };
}

type Corruption = "hash" | "sequence" | "previousRef";
const corruptions: readonly Corruption[] = ["hash", "sequence", "previousRef"];

function corruptStoredRecord(directory: string, record: FinanceBarRecord, corruption: Corruption) {
  const { ref, ...raw } = record;
  const changed = {
    ...raw,
    ...(corruption === "hash" ? { recordedAt: "2026-09-11T00:00:00Z" } : {}),
    ...(corruption === "sequence" ? { sequence: raw.sequence + 1 } : {}),
    ...(corruption === "previousRef" ? { previousRef: "0".repeat(64) } : {}),
  };
  // Chain cases have a valid content hash and schema, isolating back-link/sequence verification.
  const changedRef = corruption === "hash" ? ref : caseflowFingerprint(changed);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(financeBarLedgerPath(directory));
  try {
    db.prepare("UPDATE finance_bar_records SET ref=?, body=? WHERE ref=?").run(
      changedRef,
      JSON.stringify(changed),
      ref,
    );
  } finally {
    db.close();
  }
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

  it.each(
    [
      { scope: "as-of", options: { asOf: "2026-09-01T00:00:00Z" } },
      { scope: "instrument", options: { instrument: "AAA" } },
    ].flatMap(({ scope, options }) =>
      corruptions.map((corruption) => ({ scope, options, corruption })),
    ),
  )("rejects $corruption damage in a tail excluded by $scope", async ({ options, corruption }) => {
    const directory = await storeDirectory();
    await appendFinanceBars(directory, ohlcvInput({ observedAt: "2026-09-01T00:00:00Z" }));
    const tail = await appendFinanceBars(
      directory,
      ohlcvInput({ instrument: "BBB", observedAt: "2026-09-02T00:00:00Z" }),
    );
    // Establish that the narrow projection is valid before changing an excluded record.
    expect((await readFinanceBarLedger(directory, options)).bars).toHaveLength(1);
    corruptStoredRecord(directory, tail.record, corruption);
    await expect(readFinanceBarLedger(directory, options)).rejects.toThrow(
      corruption === "hash" ? /integrity mismatch/ : /chain mismatch/,
    );
  });

  it("rejects damage in an older record belonging to an excluded instrument", async () => {
    const directory = await storeDirectory();
    const old = await appendFinanceBars(directory, ohlcvInput({ instrument: "BBB" }));
    await appendFinanceBars(directory, ohlcvInput());
    expect((await readFinanceBarLedger(directory, { instrument: "AAA" })).bars).toHaveLength(1);
    corruptStoredRecord(directory, old.record, "hash");
    await expect(readFinanceBarLedger(directory, { instrument: "AAA" })).rejects.toThrow(
      /integrity mismatch/,
    );
  });

  it.each(corruptions)(
    "rejects a duplicate append when its existing holder precedes %s tail damage",
    async (corruption) => {
      const directory = await storeDirectory();
      await appendFinanceBars(directory, ohlcvInput());
      const tail = await appendFinanceBars(directory, ohlcvInput({ instrument: "BBB" }));
      corruptStoredRecord(directory, tail.record, corruption);
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(financeBarLedgerPath(directory), { readOnly: true });
      try {
        const before = db
          .prepare("SELECT ref, body FROM finance_bar_records ORDER BY sequence")
          .all();
        await expect(appendFinanceBars(directory, ohlcvInput())).rejects.toThrow(
          corruption === "hash" ? /integrity mismatch/ : /chain mismatch/,
        );
        expect(
          db.prepare("SELECT ref, body FROM finance_bar_records ORDER BY sequence").all(),
        ).toEqual(before);
      } finally {
        db.close();
      }
    },
  );

  it("collapses a valid historical replay across sources and preserves its first observation", async () => {
    const directory = await storeDirectory();
    const first = await appendFinanceBars(
      directory,
      ohlcvInput({ bars: [{ ...ohlcv("2026-09-01", 100, 104, 98, 102), volume: 1000 }] }),
    );
    const replay = appendLegacyRecord(directory, first.record, {
      ...first.record.body,
      provenance: { origin: "another-source" },
      observedAt: "2026-09-11T00:00:00Z",
    });
    const ledger = await readFinanceBarLedger(directory);
    expect(ledger.bars).toEqual(first.record.body.bars);
    expect(ledger.collapsedRepeats).toBe(1);
    expect(ledger.divergentDates).toEqual([]);
    expect(ledger.recordCount).toBe(2);
    expect(ledger.headRef).toBe(replay.ref);
  });

  it.each([
    { field: "OHLC", changes: { open: 101, high: 105, low: 97 } },
    { field: "volume", changes: { volume: 2000 } },
  ])(
    "retains different $field at the same close without claiming a close disagreement",
    async ({ changes }) => {
      const directory = await storeDirectory();
      const first = await appendFinanceBars(
        directory,
        ohlcvInput({ bars: [{ ...ohlcv("2026-09-01", 100, 104, 98, 102), volume: 1000 }] }),
      );
      const second = appendLegacyRecord(directory, first.record, {
        ...first.record.body,
        provenance: { origin: "another-source" },
        bars: first.record.body.bars.map((bar) => ({ ...bar, ...changes })),
      });
      const ledger = await readFinanceBarLedger(directory);
      expect(ledger.bars).toEqual([...first.record.body.bars, ...second.body.bars]);
      expect(ledger.collapsedRepeats).toBe(0);
      expect(ledger.divergentDates).toEqual([]);
    },
  );

  it("projects mixed historical replays and disagreements while retaining whole-chain count and head", async () => {
    const directory = await storeDirectory();
    const first = await appendFinanceBars(
      directory,
      ohlcvInput({ observedAt: "2026-09-01T00:00:00Z" }),
    );
    const body = first.record.body;
    const replay = appendLegacyRecord(directory, first.record, {
      ...body,
      observedAt: "2026-09-02T00:00:00Z",
      provenance: { origin: "source-b" },
    });
    const other = appendLegacyRecord(directory, replay, {
      ...body,
      instrument: "ETHUSD",
      observedAt: "2026-09-02T00:00:00Z",
      bars: body.bars.map((bar) => ({ ...bar, instrument: "ETHUSD" })),
    });
    const revised = appendLegacyRecord(directory, other, {
      ...body,
      observedAt: "2026-09-03T00:00:00Z",
      provenance: { origin: "source-c" },
      bars: body.bars.map((bar) => ({ ...bar, close: 99 })),
    });
    const nextDay = appendLegacyRecord(directory, revised, {
      ...body,
      observedAt: "2026-09-04T00:00:00Z",
      bars: body.bars.map((bar) => ({ ...bar, date: "2026-09-02" })),
    });
    // A,B,B and A,B,A remain two values in first-observed order, even with another key between.
    const repeatedRevision = appendLegacyRecord(directory, nextDay, {
      ...revised.body,
      observedAt: "2026-09-05T00:00:00Z",
    });
    const repeatedFirst = appendLegacyRecord(directory, repeatedRevision, {
      ...body,
      observedAt: "2026-09-06T00:00:00Z",
      provenance: { origin: "source-d" },
    });
    const tail = appendLegacyRecord(directory, repeatedFirst, {
      ...other.body,
      observedAt: "2026-09-07T00:00:00Z",
      bars: other.body.bars.map((bar) => ({ ...bar, close: 99 })),
    });

    const all = await readFinanceBarLedger(directory);
    expect(all.bars).toEqual([
      ...body.bars,
      ...revised.body.bars,
      ...nextDay.body.bars,
      ...other.body.bars,
      ...tail.body.bars,
    ]);
    expect(all.divergentDates).toEqual(["AAA@2026-09-01", "ETHUSD@2026-09-01"]);
    expect(all.collapsedRepeats).toBe(3);

    const instrument = await readFinanceBarLedger(directory, { instrument: "AAA" });
    expect(instrument.bars).toEqual([...body.bars, ...revised.body.bars, ...nextDay.body.bars]);
    expect(instrument.divergentDates).toEqual(["AAA@2026-09-01"]);
    expect(instrument.collapsedRepeats).toBe(3);

    const earlier = await readFinanceBarLedger(directory, {
      instrument: "AAA",
      asOf: "2026-09-02T00:00:00Z",
    });
    expect(earlier.bars).toEqual(body.bars);
    expect(earlier.divergentDates).toEqual([]);
    expect(earlier.collapsedRepeats).toBe(1);

    for (const projection of [all, instrument, earlier]) {
      expect(projection.recordCount).toBe(8);
      expect(projection.headRef).toBe(tail.ref);
    }
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

  it("lists retained selectable sources at the cutoff without choosing a winner", async () => {
    const directory = await storeDirectory();
    const source = { origin: "vendor", sourceUrlOrArtifact: "fixture://daily" };
    await appendFinanceBars(directory, ohlcvInput({ provenance: source }));
    await appendFinanceBars(
      directory,
      ohlcvInput({
        provenance: { origin: "other", sourceUrlOrArtifact: "fixture://other" },
        bars: [ohlcv("2026-09-01", 100, 105, 98, 103)],
      }),
    );
    await appendFinanceBars(
      directory,
      ohlcvInput({
        instrument: "BBB",
        provenance: { origin: "foreign", sourceUrlOrArtifact: "fixture://foreign" },
      }),
    );
    await appendFinanceBars(
      directory,
      ohlcvInput({
        observedAt: "2026-09-11T00:00:00Z",
        provenance: { origin: "future", sourceUrlOrArtifact: "fixture://future" },
        bars: [ohlcv("2026-09-02", 100, 105, 98, 103)],
      }),
    );
    const plain = await readFinanceBarLedger(directory, { instrument: "AAA", asOf: OBSERVED });
    const listed = await readFinanceBarLedger(directory, {
      instrument: "AAA",
      asOf: OBSERVED,
      includeSources: true,
    });
    expect(listed.sourceCatalog?.sources.map((item) => item.source)).toEqual([
      source,
      { origin: "other", sourceUrlOrArtifact: "fixture://other" },
    ]);
    expect(listed.sourceCatalog?.omittedRecordCount).toBe(0);
    expect(listed.bars).toEqual(plain.bars);
    expect(listed.divergentDates).toEqual(["AAA@2026-09-01"]);
    expect(plain.sourceCatalog).toBeUndefined();
  });

  it("bounds provenance choices and counts omitted records without inventing deduped labels", async () => {
    const directory = await storeDirectory();
    for (let i = 0; i < 7; i += 1) {
      await appendFinanceBars(
        directory,
        ohlcvInput({
          provenance: {
            origin: `source-${i}`,
            sourceUrlOrArtifact: i === 6 ? "长".repeat(400) : `fixture://${i}`,
          },
          bars: [ohlcv(`2026-09-${String(i + 1).padStart(2, "0")}`, 100, 104, 98, 102)],
        }),
      );
    }
    const listed = await readFinanceBarLedger(directory, { includeSources: true });
    expect(listed.sourceCatalog?.sources).toHaveLength(4);
    expect(listed.sourceCatalog?.omittedRecordCount).toBe(3);
    const selected = await readFinanceBarLedger(directory, {
      source: listed.sourceCatalog!.sources[0].source,
      includeSources: true,
    });
    expect(selected.sourceCatalog).toEqual(listed.sourceCatalog);
    expect(selected.bars).toHaveLength(1);
    expect(selected.sourceSelection?.matchedRecordCount).toBe(1);
  });

  it("selects exact origin and URL while keeping all-source disagreement visible", async () => {
    const directory = await storeDirectory();
    const source = { origin: "vendor", sourceUrlOrArtifact: "fixture://daily?feed=a" };
    await appendFinanceBars(directory, ohlcvInput({ provenance: source }));
    const tail = await appendFinanceBars(
      directory,
      ohlcvInput({
        provenance: { ...source, sourceUrlOrArtifact: "fixture://daily?feed=b" },
        bars: [ohlcv("2026-09-01", 100, 105, 98, 103)],
      }),
    );
    const all = await readFinanceBarLedger(directory);
    const selected = await readFinanceBarLedger(directory, { instrument: "AAA", source });
    expect(all.bars).toHaveLength(2);
    expect(all.divergentDates).toEqual(["AAA@2026-09-01"]);
    expect(all.sourceSelection).toBeUndefined();
    expect(selected.bars.map((bar) => bar.close)).toEqual([102]);
    expect(selected.divergentDates).toEqual([]);
    expect(selected.headRef).toBe(tail.headRef);
    expect(selected.recordCount).toBe(2);
    expect(selected.sourceSelection).toEqual({
      requested: source,
      matchedRecordCount: 1,
      excludedRecordCount: 1,
      allSourcesDivergentDates: ["AAA@2026-09-01"],
      boundary: "exact_retained_provenance_not_verified_coverage_or_adjustment",
    });
    expect(await readFinanceBarLedger(directory)).toEqual(all);
  });

  it("preserves selected-source revisions and the original cutoff", async () => {
    const directory = await storeDirectory();
    const source = { origin: "vendor", sourceUrlOrArtifact: "fixture://daily" };
    await appendFinanceBars(
      directory,
      ohlcvInput({ provenance: source, observedAt: "2026-09-01T00:00:00Z" }),
    );
    await appendFinanceBars(
      directory,
      ohlcvInput({
        provenance: source,
        observedAt: "2026-09-02T00:00:00Z",
        bars: [ohlcv("2026-09-01", 100, 105, 98, 103)],
      }),
    );
    const before = await readFinanceBarLedger(directory, { source, asOf: "2026-09-01T00:00:00Z" });
    expect(before.bars).toHaveLength(1);
    expect(before.sourceSelection?.allSourcesDivergentDates).toEqual([]);
    const revised = await readFinanceBarLedger(directory, { source });
    expect(revised.bars).toHaveLength(2);
    expect(revised.divergentDates).toEqual(["AAA@2026-09-01"]);
  });

  it("does not invent deduplicated source labels or fall back to another source", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(directory, ohlcvInput());
    const source = { origin: "other", sourceUrlOrArtifact: "fixture://other" };
    expect((await appendFinanceBars(directory, ohlcvInput({ provenance: source }))).appended).toBe(
      false,
    );
    const selected = await readFinanceBarLedger(directory, { source });
    expect(selected.bars).toEqual([]);
    expect(selected.sourceSelection).toMatchObject({
      matchedRecordCount: 0,
      excludedRecordCount: 1,
    });
  });

  it.each(corruptions)("rejects %s damage outside the selected source", async (corruption) => {
    const directory = await storeDirectory();
    const source = { origin: "selected", sourceUrlOrArtifact: "fixture://selected" };
    await appendFinanceBars(directory, ohlcvInput({ provenance: source }));
    const tail = await appendFinanceBars(
      directory,
      ohlcvInput({
        provenance: { origin: "other", sourceUrlOrArtifact: "fixture://other" },
        bars: [ohlcv("2026-09-02", 100, 104, 98, 102)],
      }),
    );
    corruptStoredRecord(directory, tail.record, corruption);
    await expect(readFinanceBarLedger(directory, { source })).rejects.toThrow(
      corruption === "hash" ? /integrity mismatch/ : /chain mismatch/,
    );
  });

  it("source-filtered absent reads do not create a book", async () => {
    const directory = await storeDirectory();
    const source = { origin: "missing", sourceUrlOrArtifact: "fixture://missing" };
    const empty = await readFinanceBarLedger(directory, { source });
    expect(empty.bars).toEqual([]);
    expect(empty.sourceSelection).toMatchObject({ requested: source, matchedRecordCount: 0 });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("stamps the record schema on every stored record", async () => {
    const directory = await storeDirectory();
    const appended = await appendFinanceBars(directory, ohlcvInput());
    expect(FINANCE_BAR_RECORD_SCHEMA).toBe("lcx_finance_bar_record_v1");
    expect(appended.record.schemaVersion).toBe(FINANCE_BAR_RECORD_SCHEMA);
    expect(appended.record.previousRef).toBeNull();
  });
});
