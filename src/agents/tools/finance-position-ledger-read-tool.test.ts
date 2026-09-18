import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  type FinanceExecutionReceipt,
} from "../finance-execution-adapter.js";
import {
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  readFinancePositionLedger,
} from "../finance-position-ledger.js";
import { FINANCE_STATE_DIR_ENV, financePositionLedgerPath } from "../finance-state-dir.js";
import type { AnyAgentTool } from "./common.js";
import { createFinancePositionLedgerReadTool } from "./finance-position-ledger-read-tool.js";

/** Safely in the past, so the store's future-observation guard is never what a test measures. */
const PAST = "2026-09-10T00:00:00Z";
const MARK_LATER = "2026-09-10T01:00:00Z";
const MARK_LATEST = "2026-09-10T02:00:00Z";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-ledger-read-"));
  directories.push(directory);
  return directory;
}

let sequence = 0;

function fill(overrides: Partial<FinanceExecutionReceipt> = {}): FinanceExecutionReceipt {
  sequence += 1;
  const at = overrides.recordedAt ?? PAST;
  const quantity = overrides.quantity ?? 10;
  const fillPrice = overrides.fill?.fillPrice ?? 100;
  return {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `r${sequence}`,
    intentId: `i${sequence}`,
    runAuthorizationId: "run-1",
    adapterId: "paper",
    adapterKind: "paper",
    venue: "paper",
    instrument: "AAPL",
    side: "buy",
    orderType: "market",
    quantity,
    referencePrice: fillPrice,
    referencePriceAt: at,
    notional: fillPrice * quantity,
    fill: { filledQuantity: quantity, fillPrice, filledAt: at, venueRef: "paper" },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: at,
    ...overrides,
  };
}

type ReadPayload = {
  ok: boolean;
  status?: string;
  reason?: string;
  action?: string;
  boundary?: string;
  ledgerDirectory?: string;
  resolvedFrom?: string;
  databasePath?: string;
  recordCount?: number;
  paperFillCount?: number;
  venueFillCount?: number;
  positionCount?: number;
  openPositionCount?: number;
  positions?: readonly {
    instrument: string;
    quantity: number;
    averageCost: number;
    markPrice?: number;
    unrealizedPnl?: number;
    unrealizedUnavailableReason?: string;
  }[];
  realizedPnl?: number;
  unrealizedPnl?: number | null;
  unrealizedUnavailableReason?: string | null;
  instrumentsWithoutMark?: readonly string[];
  headRef?: string | null;
  asOfCaveat?: string | null;
  equityCurve?: {
    status: string;
    finalEquity?: number | null;
    definedLevelCount?: number;
    receiptsAfterLastMark?: number;
    meanSampleSpacingSeconds?: number | null;
    levels?: readonly number[];
    levelTimestamps?: readonly string[];
  };
};

async function read(tool: AnyAgentTool, args: Record<string, unknown> = {}): Promise<ReadPayload> {
  const result = await tool.execute("read-ledger", args);
  return result.details as ReadPayload;
}

describe("finance_position_ledger_read", () => {
  it("reports an absent ledger as a named failure rather than an empty portfolio", async () => {
    const directory = await storeDirectory();
    const tool = createFinancePositionLedgerReadTool({});
    const payload = await read(tool, { directory });

    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("absent");
    expect(payload.reason).toBe("finance_position_ledger_absent");
    // The whole point: an unreadable book must not be readable as "flat".
    expect(payload.action).toContain("not evidence of a flat book");
    expect(payload.ledgerDirectory).toBe(directory);
    expect(payload.resolvedFrom).toBe("explicit");
    // Asserted through the shared resolver, not a literal: the database filename is part of the
    // location, and a test that spells it out would drift the moment the generation suffix moves.
    expect(payload.databasePath).toBe(financePositionLedgerPath(directory));
  });

  it("reads a real book back with its positions, marks and PnL", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, fill());
    await appendFinancePositionMark(directory, { instrument: "AAPL", price: 120, at: MARK_LATER });

    const payload = await read(createFinancePositionLedgerReadTool({}), { directory });

    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("ready");
    expect(payload.boundary).toBe("finance_position_ledger_read_only");
    expect(payload.recordCount).toBe(2);
    expect(payload.paperFillCount).toBe(1);
    expect(payload.venueFillCount).toBe(0);
    expect(payload.positionCount).toBe(1);
    expect(payload.openPositionCount).toBe(1);
    expect(payload.realizedPnl).toBe(0);
    expect(payload.unrealizedPnl).toBe(200);
    expect(payload.positions?.[0]).toMatchObject({
      instrument: "AAPL",
      quantity: 10,
      averageCost: 100,
      markPrice: 120,
      unrealizedPnl: 200,
    });
  });

  it("counts a venue fill apart from a paper fill", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(
      directory,
      fill({ adapterId: "venue-x", adapterKind: "venue", venue: "venue-x" }),
    );

    const payload = await read(createFinancePositionLedgerReadTool({}), { directory });

    expect(payload.paperFillCount).toBe(0);
    expect(payload.venueFillCount).toBe(1);
  });

  it("refuses to total unrealized PnL when an open position has no mark", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, fill());

    const payload = await read(createFinancePositionLedgerReadTool({}), { directory });

    expect(payload.status).toBe("partial_no_mark");
    expect(payload.unrealizedPnl).toBeNull();
    expect(payload.unrealizedUnavailableReason).toContain("no usable mark");
    expect(payload.instrumentsWithoutMark).toEqual(["AAPL"]);
  });

  it("produces no equity curve unless initial capital is supplied", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, fill());

    const payload = await read(createFinancePositionLedgerReadTool({}), { directory });

    expect(payload.equityCurve).toEqual({ status: "not_requested" });
  });

  it("projects the equity curve from the same stream when initial capital is supplied", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, fill());
    await appendFinancePositionMark(directory, { instrument: "AAPL", price: 120, at: MARK_LATER });
    await appendFinancePositionMark(directory, { instrument: "AAPL", price: 90, at: MARK_LATEST });

    const payload = await read(createFinancePositionLedgerReadTool({}), {
      directory,
      initialCapital: 1000,
    });

    expect(payload.equityCurve?.status).toBe("computed");
    // 1000 + 0 realized + (90 - 100) * 10 unrealized at the latest mark.
    expect(payload.equityCurve?.finalEquity).toBe(900);
    expect(payload.equityCurve?.definedLevelCount).toBe(2);
    expect(payload.equityCurve?.meanSampleSpacingSeconds).toBe(3600);
    expect(payload.equityCurve?.levels).toBeUndefined();
  });

  it("includes the level series only when explicitly asked", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, fill());
    await appendFinancePositionMark(directory, { instrument: "AAPL", price: 120, at: MARK_LATER });
    await appendFinancePositionMark(directory, { instrument: "AAPL", price: 90, at: MARK_LATEST });

    const payload = await read(createFinancePositionLedgerReadTool({}), {
      directory,
      initialCapital: 1000,
      includeCurveLevels: true,
    });

    expect(payload.equityCurve?.levels).toEqual([1200, 900]);
    expect(payload.equityCurve?.levelTimestamps).toEqual([MARK_LATER, MARK_LATEST]);
  });

  it("names the as-of view's limit instead of implying fills are filtered too", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, fill());
    await appendFinancePositionMark(directory, { instrument: "AAPL", price: 120, at: MARK_LATER });

    const payload = await read(createFinancePositionLedgerReadTool({}), {
      directory,
      asOf: MARK_LATER,
    });

    expect(payload.ok).toBe(true);
    expect(payload.asOfCaveat).toContain("only marks are limited to asOf");
  });

  it("rejects a malformed as-of instant and a non-positive initial capital by name", async () => {
    const directory = await storeDirectory();
    const tool = createFinancePositionLedgerReadTool({});

    const badAsOf = await read(tool, { directory, asOf: "yesterday" });
    expect(badAsOf.ok).toBe(false);
    expect(badAsOf.reason).toBe("finance_position_ledger_as_of_invalid");

    const badCapital = await read(tool, { directory, initialCapital: 0 });
    expect(badCapital.ok).toBe(false);
    expect(badCapital.reason).toBe("finance_position_ledger_initial_capital_invalid");
  });

  it("resolves the environment variable when no directory is passed", async () => {
    const directory = await storeDirectory();
    const previous = process.env[FINANCE_STATE_DIR_ENV];
    process.env[FINANCE_STATE_DIR_ENV] = directory;
    try {
      const payload = await read(createFinancePositionLedgerReadTool({}), {});
      expect(payload.ledgerDirectory).toBe(directory);
      expect(payload.resolvedFrom).toBe("env");
    } finally {
      if (previous === undefined) {
        delete process.env[FINANCE_STATE_DIR_ENV];
      } else {
        process.env[FINANCE_STATE_DIR_ENV] = previous;
      }
    }
  });

  it("never mutates the ledger it reads", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, fill());
    await appendFinancePositionMark(directory, { instrument: "AAPL", price: 120, at: MARK_LATER });
    const database = financePositionLedgerPath(directory);
    const before = await fs.stat(database);
    const beforeLedger = await readFinancePositionLedger(directory);

    const tool = createFinancePositionLedgerReadTool({});
    await read(tool, { directory, initialCapital: 1000, includeCurveLevels: true });
    await read(tool, { directory, asOf: MARK_LATER });

    const after = await fs.stat(database);
    const afterLedger = await readFinancePositionLedger(directory);
    expect(after.size).toBe(before.size);
    expect(afterLedger.recordCount).toBe(beforeLedger.recordCount);
    expect(afterLedger.headRef).toBe(beforeLedger.headRef);
  });
});
