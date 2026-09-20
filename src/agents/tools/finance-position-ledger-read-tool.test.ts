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
import {
  FINANCE_STATE_DIR_ENV,
  financeBehaviourThresholdsPath,
  financePositionLedgerPath,
} from "../finance-state-dir.js";
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
  behaviour?: {
    status: string;
    thresholdsFile?: string;
    thresholdsDeclared?: boolean;
    thresholdsError?: string | null;
    profile?: {
      receiptCount: number;
      paperFillCount: number;
      venueFillCount: number;
      advice: boolean;
      dimensions: readonly {
        dimension: string;
        label: { id: string; statement: string } | null;
        unavailableReason: string | null;
      }[];
      declaredThresholds: Record<string, number | null>;
    };
  };
};

/**
 * Three paper buys at round prices. Round levels are the cheapest stream that reaches a label:
 * `anchoring` needs three measurable fills and no marks at all.
 */
async function appendRoundLevelFills(directory: string, prices: readonly number[]): Promise<void> {
  for (const price of prices) {
    await appendFinanceExecutionReceipt(
      directory,
      fill({
        fill: { filledQuantity: 10, fillPrice: price, filledAt: PAST, venueRef: "paper" },
      }),
    );
  }
}

async function declareThresholds(directory: string, value: unknown): Promise<string> {
  const file = financeBehaviourThresholdsPath(directory);
  await fs.writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

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
    await read(tool, { directory, includeBehaviour: true });

    const after = await fs.stat(database);
    const afterLedger = await readFinancePositionLedger(directory);
    expect(after.size).toBe(before.size);
    expect(afterLedger.recordCount).toBe(beforeLedger.recordCount);
    expect(afterLedger.headRef).toBe(beforeLedger.headRef);
  });

  describe("behaviour", () => {
    it("does not build a behaviour profile unless it is asked for", async () => {
      const directory = await storeDirectory();
      await appendRoundLevelFills(directory, [100, 200, 300]);

      const payload = await read(createFinancePositionLedgerReadTool({}), { directory });

      expect(payload.behaviour?.status).toBe("not_requested");
      expect(payload.behaviour?.profile).toBeUndefined();
    });

    it("reports measured numbers with no labels when the owner has declared no thresholds", async () => {
      const directory = await storeDirectory();
      await appendRoundLevelFills(directory, [100, 200, 300]);

      const payload = await read(createFinancePositionLedgerReadTool({}), {
        directory,
        includeBehaviour: true,
      });
      const behaviour = payload.behaviour;

      expect(behaviour?.status).toBe("computed");
      expect(behaviour?.thresholdsDeclared).toBe(false);
      expect(behaviour?.thresholdsError).toBeNull();
      expect(behaviour?.thresholdsFile).toBe(financeBehaviourThresholdsPath(directory));
      // The measurement happened either way; only the reading waits for a declared boundary.
      expect(behaviour?.profile?.receiptCount).toBe(3);
      expect(behaviour?.profile?.dimensions).toHaveLength(4);
      expect(behaviour?.profile?.dimensions.every((item) => item.label === null)).toBe(true);
      expect(behaviour?.profile?.advice).toBe(false);
      const anchoring = behaviour?.profile?.dimensions.find(
        (item) => item.dimension === "anchoring",
      );
      expect(anchoring?.unavailableReason).toContain("thresholds.roundLevelTolerancePercent");
    });

    it("labels a dimension against the owner's declaration, not the caller's", async () => {
      const directory = await storeDirectory();
      await appendRoundLevelFills(directory, [100, 200, 300]);
      await declareThresholds(directory, {
        roundLevelTolerancePercent: 0.5,
        anchorShareThreshold: 0.6,
      });

      const payload = await read(createFinancePositionLedgerReadTool({}), {
        directory,
        includeBehaviour: true,
      });
      const behaviour = payload.behaviour;

      expect(behaviour?.thresholdsDeclared).toBe(true);
      expect(behaviour?.thresholdsError).toBeNull();
      const anchoring = behaviour?.profile?.dimensions.find(
        (item) => item.dimension === "anchoring",
      );
      expect(anchoring?.label?.id).toBe("fills_cluster_on_round_levels");
      // The boundary the caller is held to is the one written in the file.
      expect(behaviour?.profile?.declaredThresholds.roundLevelTolerancePercent).toBe(0.5);
      expect(behaviour?.profile?.declaredThresholds.maxFillsPerDay).toBeNull();
    });

    it("still returns the book when the declaration exists but does not parse", async () => {
      const directory = await storeDirectory();
      await appendRoundLevelFills(directory, [100, 200, 300]);
      // `dispositionGap` is not a threshold this module knows. Ignoring it would silently hold
      // the reader to a boundary nobody declared, so it is reported instead.
      await declareThresholds(directory, { dispositionGap: 0.1 });

      const payload = await read(createFinancePositionLedgerReadTool({}), {
        directory,
        includeBehaviour: true,
      });

      // The positions are still the answer to the question that was asked.
      expect(payload.ok).toBe(true);
      expect(payload.status).not.toBe("absent");
      expect(payload.positionCount).toBe(1);
      expect(payload.behaviour?.thresholdsError).toContain("unknown behaviour threshold key");
      expect(payload.behaviour?.thresholdsDeclared).toBe(false);
      // Nothing was silently labelled against the unusable declaration.
      expect(payload.behaviour?.profile?.dimensions.every((item) => item.label === null)).toBe(
        true,
      );
    });

    it("reports a declaration file that is not JSON at all", async () => {
      const directory = await storeDirectory();
      await appendRoundLevelFills(directory, [100, 200, 300]);
      await fs.writeFile(financeBehaviourThresholdsPath(directory), "{ not json", "utf8");

      const payload = await read(createFinancePositionLedgerReadTool({}), {
        directory,
        includeBehaviour: true,
      });

      expect(payload.ok).toBe(true);
      expect(payload.behaviour?.thresholdsError).toContain("is not valid JSON");
    });

    it("builds the profile over the same stream the positions came from", async () => {
      const directory = await storeDirectory();
      await appendRoundLevelFills(directory, [100, 200, 300]);

      const payload = await read(createFinancePositionLedgerReadTool({}), {
        directory,
        includeBehaviour: true,
      });

      expect(payload.behaviour?.profile?.receiptCount).toBe(payload.recordCount);
      expect(payload.behaviour?.profile?.paperFillCount).toBe(payload.paperFillCount);
      expect(payload.behaviour?.profile?.venueFillCount).toBe(payload.venueFillCount);
    });
  });
});
