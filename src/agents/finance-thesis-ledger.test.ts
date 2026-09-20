import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { financeThesisLedgerPath } from "./finance-state-dir.js";
import {
  openFinanceThesis,
  projectFinanceTheses,
  readFinanceThesisLedger,
  transitionFinanceThesis,
  type FinanceThesisOpenInput,
} from "./finance-thesis-ledger.js";

/**
 * Safely in the past, so the "no future observations" guard is never what a test measures.
 * Tests that need ordering use later hours of the same day.
 */
const PAST = "2026-09-10T00:00:00Z";
const LATER = "2026-09-10T06:00:00Z";
const MUCH_LATER = "2026-09-11T00:00:00Z";

const directories: string[] = [];

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-thesis-ledger-"));
  directories.push(directory);
  return directory;
}

function openInput(overrides: Partial<FinanceThesisOpenInput> = {}): FinanceThesisOpenInput {
  return {
    thesisId: "thesis-1",
    instrument: "AAA",
    claim: "Margins recover as pricing resets.",
    evidence: [{ id: "e1", source: "filing", reference: "10-Q 2026 Q2" }],
    invalidationConditions: ["Gross margin below 30% for two quarters."],
    observedAt: PAST,
    ...overrides,
  };
}

describe("finance thesis ledger", () => {
  afterAll(async () => {
    await Promise.all(
      directories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("reports an empty book when no database exists", async () => {
    const directory = await storeDirectory();
    const ledger = await readFinanceThesisLedger(directory);
    expect(ledger.theses).toEqual([]);
    expect(ledger.recordCount).toBe(0);
    expect(ledger.headRef).toBeNull();
  });

  it("opens a thesis into active", async () => {
    const directory = await storeDirectory();
    const append = await openFinanceThesis(directory, openInput());
    expect(append.appended).toBe(true);
    expect(append.recordCount).toBe(1);

    const ledger = await readFinanceThesisLedger(directory);
    expect(ledger.theses).toHaveLength(1);
    const thesis = ledger.theses[0];
    expect(thesis.state).toBe("active");
    expect(thesis.instrument).toBe("AAA");
    expect(thesis.openedAt).toBe(PAST);
    expect(thesis.closedAt).toBeNull();
    expect(thesis.transitions).toEqual([]);
    expect(thesis.invalidationConditions).toEqual(["Gross margin below 30% for two quarters."]);
  });

  it("derives the state from the last transition and never stores it", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    await transitionFinanceThesis(directory, {
      thesisId: "thesis-1",
      to: "invalidated",
      reason: "Margin printed 27%.",
      observedAt: LATER,
    });

    const ledger = await readFinanceThesisLedger(directory);
    const thesis = ledger.theses[0];
    expect(thesis.state).toBe("invalidated");
    expect(thesis.closedAt).toBe(LATER);
    expect(thesis.transitions).toEqual([
      {
        to: "invalidated",
        reason: "Margin printed 27%.",
        evidence: [],
        observedAt: LATER,
        recordedAt: thesis.transitions[0].recordedAt,
      },
    ]);
  });

  it("supports realised as the other terminal state", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    await transitionFinanceThesis(directory, {
      thesisId: "thesis-1",
      to: "realised",
      reason: "Margin printed 41%.",
      observedAt: LATER,
    });
    const ledger = await readFinanceThesisLedger(directory);
    expect(ledger.theses[0].state).toBe("realised");
  });

  it("is idempotent: reopening identical content appends nothing", async () => {
    const directory = await storeDirectory();
    const input = openInput();
    const first = await openFinanceThesis(directory, input);
    const second = await openFinanceThesis(directory, input);
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.recordCount).toBe(1);

    const ledger = await readFinanceThesisLedger(directory);
    expect(ledger.recordCount).toBe(1);
    expect(ledger.openedRecordCount).toBe(1);
    expect(ledger.transitionRecordCount).toBe(0);
  });

  it("refuses to reopen a thesis with different content", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    await expect(
      openFinanceThesis(directory, openInput({ claim: "A different claim entirely." })),
    ).rejects.toThrow(/already recorded with different content/);

    // The book is untouched: a refused append leaves no trace.
    const ledger = await readFinanceThesisLedger(directory);
    expect(ledger.theses[0].claim).toBe("Margins recover as pricing resets.");
    expect(ledger.recordCount).toBe(1);
  });

  it("refuses a transition for a thesis that was never opened", async () => {
    const directory = await storeDirectory();
    await expect(
      transitionFinanceThesis(directory, {
        thesisId: "never-opened",
        to: "invalidated",
        reason: "No such thesis.",
        observedAt: LATER,
      }),
    ).rejects.toThrow(/has no opening record/);
  });

  it("refuses a second transition: a closed thesis is history", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    await transitionFinanceThesis(directory, {
      thesisId: "thesis-1",
      to: "invalidated",
      reason: "Margin printed 27%.",
      observedAt: LATER,
    });
    await expect(
      transitionFinanceThesis(directory, {
        thesisId: "thesis-1",
        to: "realised",
        reason: "Trying again.",
        observedAt: MUCH_LATER,
      }),
    ).rejects.toThrow(/already closed/);
  });

  it("refuses an observation dated in the future", async () => {
    const directory = await storeDirectory();
    await expect(
      openFinanceThesis(directory, openInput({ observedAt: "2099-01-01T00:00:00Z" })),
    ).rejects.toThrow(/cannot be dated in the future/);
  });

  it("refuses duplicate evidence ids", async () => {
    const directory = await storeDirectory();
    await expect(
      openFinanceThesis(
        directory,
        openInput({
          evidence: [
            { id: "e1", source: "filing", reference: "a" },
            { id: "e1", source: "filing", reference: "b" },
          ],
        }),
      ),
    ).rejects.toThrow(/duplicate thesis evidence id/);
  });

  it("gives a historical view with as-of, because only events are stored", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    await transitionFinanceThesis(directory, {
      thesisId: "thesis-1",
      to: "invalidated",
      reason: "Margin printed 27%.",
      observedAt: LATER,
    });

    const before = await readFinanceThesisLedger(directory, { asOf: PAST });
    expect(before.theses[0].state).toBe("active");
    expect(before.theses[0].closedAt).toBeNull();
    expect(before.recordCount).toBe(1);

    const after = await readFinanceThesisLedger(directory, { asOf: LATER });
    expect(after.theses[0].state).toBe("invalidated");
    expect(after.recordCount).toBe(2);
  });

  it("reading does not write: size and head are unchanged", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    const database = financeThesisLedgerPath(directory);
    const before = await fs.stat(database);
    const beforeLedger = await readFinanceThesisLedger(directory);

    await readFinanceThesisLedger(directory, { asOf: PAST });

    const after = await fs.stat(database);
    const afterLedger = await readFinanceThesisLedger(directory);
    expect(after.size).toBe(before.size);
    expect(afterLedger.headRef).toBe(beforeLedger.headRef);
    expect(afterLedger.recordCount).toBe(beforeLedger.recordCount);
  });

  it("rejects UPDATE and DELETE at the storage layer", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(financeThesisLedgerPath(directory));
    try {
      expect(() => db.exec("UPDATE finance_thesis_records SET body='{}'")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM finance_thesis_records")).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("detects a tampered body instead of reading it silently", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(financeThesisLedgerPath(directory));
    try {
      const body = JSON.stringify({ kind: "opened", thesisId: "tampered" });
      db.prepare(
        "INSERT INTO finance_thesis_records(kind,record_key,sequence,ref,body) VALUES (?,?,?,?,?)",
      ).run("opened", "opened:tampered", 2, "f".repeat(64), body);
    } finally {
      db.close();
    }
    await expect(readFinanceThesisLedger(directory)).rejects.toThrow(/integrity mismatch/);
  });

  it("projects deterministically from the same events", async () => {
    const directory = await storeDirectory();
    const first = await openFinanceThesis(directory, openInput());
    const second = await transitionFinanceThesis(directory, {
      thesisId: "thesis-1",
      to: "realised",
      reason: "Target reached.",
      observedAt: LATER,
    });
    const records = [first.record, second.record];
    expect(projectFinanceTheses(records)).toEqual(projectFinanceTheses(records));
  });
});
