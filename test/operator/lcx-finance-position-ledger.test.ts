/**
 * Tests for the operator entry that owns the durable position ledger.
 *
 * This entry had no tests before the read/write alignment change, which is how it kept requiring
 * `--dir`: nothing exercised the case where the operator does not name a directory, so nobody saw
 * that the agent's read tool was resolving a different one.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFinancePositionLedgerPayload,
  parseArgs,
} from "../../scripts/operator/lcx-finance-position-ledger.ts";
import {
  FINANCE_STATE_DIR_ENV,
  financePositionLedgerPath,
} from "../../src/agents/finance-state-dir.ts";

/** Safely in the past, so the ledger's future-observation guard is never what a test measures. */
const PAST = "2026-09-17T00:00:00Z";

const directories: string[] = [];

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-ledger-cli-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("finance position ledger operator entry", () => {
  it("no longer requires --dir, so the shared resolver can decide", () => {
    // Regression guard for the alignment change: this used to throw
    // "--dir requires the ledger directory", which forced every caller to name a path that the
    // agent's read tool then had to be told separately.
    expect(parseArgs([])).toEqual({ marks: [], json: false });
    expect(parseArgs(["--dir", "/book"])).toMatchObject({ directory: "/book" });
  });

  it("treats a blank --dir as absent rather than as a path", () => {
    expect(parseArgs(["--dir", "   "])).toMatchObject({ directory: "" });
  });

  it("still rejects an unknown argument and states the usage", () => {
    expect(() => parseArgs(["--nope"])).toThrow("unknown argument: --nope");
    expect(() => parseArgs(["--help"])).toThrow("Usage:");
  });

  it("refuses an annualised period with no curve to annualise", () => {
    expect(() => parseArgs(["--periods-per-year", "252"])).toThrow(
      "--periods-per-year needs --initial-capital",
    );
  });

  it("reports an explicit directory as explicit and touches no disk when only reading", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinancePositionLedgerPayload({ directory, marks: [], json: true });

    expect(payload.directory).toBe(directory);
    expect(payload.directorySource).toBe("explicit");
    // Asserted through the shared resolver rather than a literal filename: the name carries a
    // schema generation, and a test that spells it out would drift the moment the generation moves.
    expect(payload.database).toBe(financePositionLedgerPath(directory));
    expect(payload.claims.databaseWritten).toBe(false);
    // Nothing was written, so there is nothing to warn about.
    expect(payload.directorySourceNotice).toBeNull();
  });

  it("announces a write into a location the operator did not name", async () => {
    const directory = await storeDirectory();
    const previous = process.env[FINANCE_STATE_DIR_ENV];
    process.env[FINANCE_STATE_DIR_ENV] = directory;
    try {
      const payload = await buildFinancePositionLedgerPayload({
        marks: [{ instrument: "AAPL", price: 120, at: PAST }],
        json: true,
      });

      expect(payload.directory).toBe(directory);
      expect(payload.directorySource).toBe("env");
      expect(payload.claims.databaseWritten).toBe(true);
      // The write is allowed to land on the resolved location, but it must say so: the operator
      // named neither --dir nor a path, which is the one case where the wrong book is plausible.
      expect(payload.directorySourceNotice).toContain("rather than one named with --dir");
    } finally {
      if (previous === undefined) {
        delete process.env[FINANCE_STATE_DIR_ENV];
      } else {
        process.env[FINANCE_STATE_DIR_ENV] = previous;
      }
    }
  });

  it("counts a replayed mark once instead of twice", async () => {
    const directory = await storeDirectory();
    const mark = { instrument: "AAPL", price: 120, at: PAST };
    const payload = await buildFinancePositionLedgerPayload({
      directory,
      marks: [mark, { ...mark }],
      json: true,
    });

    expect(payload.appended.marks.map((item) => item.appended)).toEqual([true, false]);
    expect(payload.markRecordCount).toBe(1);
    expect(payload.recordCount).toBe(1);
    expect(payload.claims.databaseWritten).toBe(true);
  });

  it("reads back what a previous run wrote, without letting a mark invent a position", async () => {
    const directory = await storeDirectory();
    await buildFinancePositionLedgerPayload({
      directory,
      marks: [{ instrument: "AAPL", price: 120, at: PAST }],
      json: true,
    });

    const reopened = await buildFinancePositionLedgerPayload({ directory, marks: [], json: true });

    expect(reopened.markRecordCount).toBe(1);
    // A mark prices a position; it does not create one. Only a fill can do that, so a reopened
    // book holding one mark and no receipt must still report a flat account rather than a
    // one-instrument portfolio.
    expect(reopened.ledger.positions).toHaveLength(0);
    expect(reopened.ledger.realizedPnl).toBe(0);
    expect(reopened.claims.databaseWritten).toBe(false);
    expect(reopened.headRef).not.toBeNull();
  });
});
