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
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  type FinanceExecutionReceipt,
} from "../../src/agents/finance-execution-adapter.ts";
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

/**
 * A minimal paper receipt at a chosen fill price. Three of these at round prices are enough to
 * give the anchoring dimension something to measure, which is the cheapest stream that reaches
 * a label.
 */
function receiptFixture(id: string, instrument: string, price: number): FinanceExecutionReceipt {
  return {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: id,
    intentId: `i-${id}`,
    runAuthorizationId: "run-1",
    adapterId: "paper",
    adapterKind: "paper",
    venue: "paper",
    instrument,
    side: "buy",
    orderType: "market",
    quantity: 10,
    referencePrice: price,
    referencePriceAt: PAST,
    notional: price * 10,
    fill: { filledQuantity: 10, fillPrice: price, filledAt: PAST, venueRef: "paper" },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: PAST,
  };
}

async function writeJson(directory: string, name: string, value: unknown): Promise<string> {
  const file = path.join(directory, name);
  await fs.writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

async function appendReceipt(
  directory: string,
  id: string,
  instrument: string,
  price: number,
): Promise<void> {
  const receiptPath = await writeJson(
    directory,
    `${id}.json`,
    receiptFixture(id, instrument, price),
  );
  await buildFinancePositionLedgerPayload({ directory, receiptPath, marks: [], json: true });
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
    // Declaring behaviour thresholds is what turns measured numbers into labels, so the flag has
    // to reach the payload builder rather than being dropped as an unknown argument.
    expect(parseArgs(["--behaviour-thresholds", "/t.json"])).toMatchObject({
      behaviourThresholdsPath: "/t.json",
    });
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

  it("reports a behaviour profile over the stored stream, without labels until thresholds exist", async () => {
    const directory = await storeDirectory();
    await appendReceipt(directory, "r1", "AAPL", 100);

    const payload = await buildFinancePositionLedgerPayload({ directory, marks: [], json: true });

    expect(payload.behaviour.receiptCount).toBe(1);
    expect(payload.behaviour.paperFillCount).toBe(1);
    expect(payload.behaviour.venueFillCount).toBe(0);
    expect(payload.behaviour.advice).toBe(false);
    expect(payload.behaviour.dimensions).toHaveLength(4);
    // The numbers are reported either way; only the labels wait for a declared threshold.
    expect(payload.behaviour.dimensions.every((item) => item.label === null)).toBe(true);
    expect(payload.behaviourThresholdsSource).toBeNull();
  });

  it("labels the behaviour once the thresholds are declared", async () => {
    const directory = await storeDirectory();
    await appendReceipt(directory, "r1", "AAA", 100);
    await appendReceipt(directory, "r2", "BBB", 200);
    await appendReceipt(directory, "r3", "CCC", 300);

    const undeclared = await buildFinancePositionLedgerPayload({
      directory,
      marks: [],
      json: true,
    });
    const anchoringOf = (payload: typeof undeclared) =>
      payload.behaviour.dimensions.find((item) => item.dimension === "anchoring");

    // Same stream, same measured numbers — the label is the only thing the file changes.
    expect(anchoringOf(undeclared)?.label).toBeNull();
    expect(anchoringOf(undeclared)?.observations.measurableFills).toBe(3);

    const thresholdsPath = await writeJson(directory, "thresholds.json", {
      roundLevelTolerancePercent: 0.5,
      anchorShareThreshold: 0.6,
    });
    const declared = await buildFinancePositionLedgerPayload({
      directory,
      marks: [],
      behaviourThresholdsPath: thresholdsPath,
      json: true,
    });

    expect(anchoringOf(declared)?.label?.id).toBe("fills_cluster_on_round_levels");
    expect(declared.behaviourThresholdsSource).toBe(thresholdsPath);
  });

  it("refuses a thresholds file whose key is misspelled instead of reading it as undeclared", async () => {
    const directory = await storeDirectory();
    // `dispositionGap` is not a threshold this module knows. Ignoring it would report
    // "dispositionGapThreshold was not declared", which an operator who supplied a number
    // would read as "my threshold was not met" — the exact misreading this refusal prevents.
    const thresholdsPath = await writeJson(directory, "thresholds.json", { dispositionGap: 0.1 });

    await expect(
      buildFinancePositionLedgerPayload({
        directory,
        marks: [],
        behaviourThresholdsPath: thresholdsPath,
        json: true,
      }),
    ).rejects.toThrow("unknown behaviour threshold key");
  });

  it("refuses a thresholds file whose value is not a usable number", async () => {
    const directory = await storeDirectory();
    const thresholdsPath = await writeJson(directory, "thresholds.json", { maxFillsPerDay: 0 });

    await expect(
      buildFinancePositionLedgerPayload({
        directory,
        marks: [],
        behaviourThresholdsPath: thresholdsPath,
        json: true,
      }),
    ).rejects.toThrow("maxFillsPerDay must be a positive finite number");
  });
});
