/**
 * Tests for the execution owner entry.
 *
 * This entry had no tests before it gained `--write-ledger`, which is how the durable book and the
 * execution seam stayed two disconnected surfaces: the entry could place a paper order and the
 * ledger could store a fill, but nothing asserted that one run made the other happen.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFinanceLiveExecutionPayload as buildWithoutController,
  parseArgs,
  type Options,
} from "../../scripts/operator/lcx-finance-live-execution.ts";
import * as alpacaAdapters from "../../src/agents/finance-alpaca-execution-adapter.js";
import {
  DEFAULT_FINANCE_RISK_BUDGET,
  FINANCE_RISK_BUDGET_ANY_INSTRUMENT,
} from "../../src/agents/finance-execution-adapter.ts";
import * as executionAdapters from "../../src/agents/finance-execution-adapter.ts";
import { syntheticSafetyContext } from "../../src/agents/finance-execution-safety.test-support.js";
import { financePositionLedgerPath } from "../../src/agents/finance-state-dir.ts";
import { createFinancePositionLedgerReadTool } from "../../src/agents/tools/finance-position-ledger-read-tool.ts";

// Existing operator behavior fixtures explicitly authorize a synthetic funded account.
const buildFinanceLiveExecutionPayload = (input: Options) =>
  buildWithoutController(input, { createSafetyContext: syntheticSafetyContext });

/** Safely in the past, so the ledger's future-observation guard is never what a test measures. */
const AS_OF = new Date(Date.now() - 1_000).toISOString();
const MARK_AT = new Date(Date.now() - 500).toISOString();

const directories: string[] = [];

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-live-execution-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function options(overrides: Partial<Options> = {}): Options {
  return {
    instrument: "AAPL",
    assetClass: "us_equity",
    riskPct: 0.5,
    drawdownPct: 0,
    hasStructure: true,
    stopPrice: 225,
    side: "buy",
    orderType: "market",
    quantity: 10,
    referencePrice: 231.4,
    asOf: AS_OF,
    runAuthorization: "run-test-1",
    rationale: "test",
    allowInstruments: [],
    marks: [],
    budget: {
      ...DEFAULT_FINANCE_RISK_BUDGET,
      maxOrderNotional: 500_000,
      maxInstrumentNotional: 1_000_000,
      maxOrdersPerRun: 10,
    },
    writeLedger: false,
    json: true,
    ...overrides,
  };
}

describe("finance live execution operator entry", () => {
  it("takes --write-ledger and --ledger-dir, and defaults to not writing", () => {
    const parsed = parseArgs([]);
    expect(parsed.writeLedger).toBe(false);
    expect(parsed.ledgerDirectory).toBeUndefined();

    const written = parseArgs(["--write-ledger", "--ledger-dir", "/book"]);
    expect(written.writeLedger).toBe(true);
    expect(written.ledgerDirectory).toBe("/book");
  });

  it("writes no execution ledger without --write-ledger (safety claims are separate)", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(options({ ledgerDirectory: directory }));

    expect(payload.nodes.order_placement.status).toBe("placed");
    expect(payload.durableLedger.written).toBe(false);
    expect(payload.durableLedger.reason).toBe(
      "pass --write-ledger to append this run to the durable book",
    );
    expect(payload.claims.databaseWritten).toBe(false);
    // The ledger node must stay empty: a run that left no trace must not report the waterflow's
    // terminal node as reached.
    expect(payload.nodes.position_ledger).toBeNull();
    // And nothing may exist on disk, including the database file itself.
    await expect(fs.access(financePositionLedgerPath(directory))).rejects.toThrow();
  });

  it("records the receipt and marks once --write-ledger is given", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(
      options({
        ledgerDirectory: directory,
        writeLedger: true,
        marks: [{ instrument: "AAPL", price: 233.1, at: MARK_AT }],
      }),
    );

    expect(payload.durableLedger.written).toBe(true);
    expect(payload.durableLedger.beforeRecordCount).toBe(0);
    expect(payload.durableLedger.recordCount).toBe(2);
    expect(payload.durableLedger.recordCountDelta).toBe(2);
    expect(payload.durableLedger.receiptRecordCount).toBe(1);
    expect(payload.durableLedger.markRecordCount).toBe(1);
    expect(payload.durableLedger.appended.receipt?.appended).toBe(true);
    expect(payload.durableLedger.appended.marks.map((item) => item.appended)).toEqual([true]);
    expect(payload.claims.databaseWritten).toBe(true);
    expect(payload.nodes.position_ledger).not.toBeNull();
    expect(payload.nodes.position_ledger?.recordCount).toBe(2);
    // A fresh placement mints a fresh receipt id, so the second run of the same command is a
    // second fill rather than a replay. The payload has to say so, or it reads as double counting.
    expect(payload.durableLedger.replayNote).toContain("places a new order");
  });

  it("records nothing when the order is refused", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(
      options({
        ledgerDirectory: directory,
        writeLedger: true,
        runAuthorization: "",
        marks: [{ instrument: "AAPL", price: 233.1, at: MARK_AT }],
      }),
    );

    expect(payload.nodes.order_placement.status).toBe("refused");
    expect(payload.nodes.order_placement.refusalReasons).toContain(
      "explicit_run_authorization_required",
    );
    expect(payload.durableLedger.written).toBe(false);
    expect(payload.durableLedger.reason).toBe("order_refused_so_nothing_was_recorded");
    expect(payload.durableLedger.recordCountDelta).toBe(0);
    expect(payload.durableLedger.replayNote).toBeNull();
    await expect(fs.access(financePositionLedgerPath(directory))).rejects.toThrow();
  });

  it("routes the explicit Alpaca adapter instead of silently falling back to paper", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(
      options({ adapter: "alpaca", runAuthorization: "", ledgerDirectory: directory }),
    );

    expect(payload.nodes.declared_execution_adapter.adapterId).toBe("alpaca-venue");
    expect(payload.nodes.order_placement.refusalReasons).toContain(
      "explicit_run_authorization_required",
    );
    expect(payload.nodes.order_placement.refusalReasons).not.toContain(
      "declared_execution_adapter_required",
    );
    expect(payload.claims.paperAdapterOnly).toBe(false);
  });

  it("announces a write into a location the operator did not name", async () => {
    const directory = await storeDirectory();
    const previous = process.env.LCX_FINANCE_STATE_DIR;
    process.env.LCX_FINANCE_STATE_DIR = directory;
    try {
      const payload = await buildFinanceLiveExecutionPayload(options({ writeLedger: true }));

      expect(payload.durableLedger.written).toBe(true);
      expect(payload.durableLedger.directory).toBe(directory);
      expect(payload.durableLedger.directorySource).toBe("env");
      expect(payload.durableLedger.directorySourceNotice).toContain(
        "rather than one named with --ledger-dir",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.LCX_FINANCE_STATE_DIR;
      } else {
        process.env.LCX_FINANCE_STATE_DIR = previous;
      }
    }
  });

  it("closes the loop: an order this entry placed is a position the agent can read", async () => {
    const directory = await storeDirectory();
    await buildFinanceLiveExecutionPayload(
      options({
        ledgerDirectory: directory,
        writeLedger: true,
        marks: [{ instrument: "AAPL", price: 233.1, at: MARK_AT }],
      }),
    );

    const tool = createFinancePositionLedgerReadTool({});
    const read = (await tool.execute("read-ledger", { directory })).details as Record<
      string,
      unknown
    >;

    expect(read.ok).toBe(true);
    expect(read.status).toBe("ready");
    expect(read.positionCount).toBe(1);
    expect(read.positions).toMatchObject([
      { instrument: "AAPL", quantity: 10, averageCost: 231.4 },
    ]);
    // (233.1 - 231.4) * 10: the number the model reports is the one the stored stream implies.
    expect(read.unrealizedPnl).toBe(17);
    expect(read.realizedPnl).toBe(0);
  });
});

/**
 * The allowlist contract as this *entry* translates it.
 *
 * The adapter's own tests cover the budget semantics, but they cannot reach this file's
 * translation: an operator who names no instrument gets the explicit any-instrument token, not
 * an empty list. That translation is the difference between a run that is open by instrument and
 * one that is refused, so it is asserted here rather than assumed from the adapter.
 */
describe("finance live execution entry allowlist translation", () => {
  it("opens by instrument when none is named, and declares that instead of the empty flag", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(options({ ledgerDirectory: directory }));

    expect(payload.nodes.order_placement.status).toBe("placed");
    expect(payload.riskBudget.allowedInstruments).toEqual([FINANCE_RISK_BUDGET_ANY_INSTRUMENT]);
    // The raw flag was empty. Reporting the flag here would contradict the placement that just
    // succeeded, so the payload must report what the adapter actually declares.
    expect(payload.nodes.declared_execution_adapter.declaredInstruments).toEqual([
      FINANCE_RISK_BUDGET_ANY_INSTRUMENT,
    ]);
  });

  it("refuses at both layers when the run is narrowed to a different instrument", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(
      options({ ledgerDirectory: directory, writeLedger: true, allowInstruments: ["MSFT"] }),
    );

    expect(payload.nodes.order_placement.status).toBe("refused");
    // Both checks must still fire: narrowing is not a single gate. An adapter that declares only
    // MSFT and a budget that admits only MSFT are two separate statements, and both are crossed.
    expect(payload.nodes.order_placement.refusalReasons).toContain(
      "declared_adapter_instrument_unsupported",
    );
    expect(payload.nodes.order_placement.refusalReasons).toContain(
      "risk_budget_instrument_not_allowed",
    );
    expect(payload.nodes.declared_execution_adapter.declaredInstruments).toEqual(["MSFT"]);
    expect(payload.durableLedger.written).toBe(false);
    await expect(fs.access(financePositionLedgerPath(directory))).rejects.toThrow();
  });

  it("admits the named instrument, and the narrowing is what the payload reports", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(
      options({
        ledgerDirectory: directory,
        writeLedger: true,
        allowInstruments: ["AAPL"],
        marks: [{ instrument: "AAPL", price: 233.1, at: MARK_AT }],
      }),
    );

    expect(payload.nodes.order_placement.status).toBe("placed");
    expect(payload.nodes.order_placement.refusalReasons).toEqual([]);
    expect(payload.riskBudget.allowedInstruments).toEqual(["AAPL"]);
    expect(payload.nodes.declared_execution_adapter.declaredInstruments).toEqual(["AAPL"]);
    expect(payload.nodes.position_ledger?.recordCount).toBe(2);
  });

  it("refuses a risk increase when the attended entry declares no cap", async () => {
    const directory = await storeDirectory();
    // 1000 x 231.4 = 231,400. With no --max-* declared there is no boundary to cross, so this is
    // an ordinary paper fill. A cap nobody declared is not a control, it is a surprise.
    const payload = await buildFinanceLiveExecutionPayload(
      options({ ledgerDirectory: directory, quantity: 1000, budget: DEFAULT_FINANCE_RISK_BUDGET }),
    );

    expect(payload.nodes.order_placement.status).toBe("refused");
    expect(payload.nodes.order_placement.refusalReasons).toContain(
      "execution_safety_increase_requires_complete_budget",
    );
  });

  it("still enforces a cap once the run declares one", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(
      options({
        ledgerDirectory: directory,
        quantity: 1000,
        budget: {
          ...DEFAULT_FINANCE_RISK_BUDGET,
          maxOrderNotional: 10_000,
          maxInstrumentNotional: 25_000,
        },
      }),
    );

    expect(payload.nodes.order_placement.status).toBe("refused");
    expect(payload.nodes.order_placement.refusalReasons).toContain(
      "risk_budget_order_notional_exceeded",
    );
    expect(payload.nodes.order_placement.refusalReasons).toContain(
      "risk_budget_instrument_notional_exceeded",
    );
  });
});

describe("finance live execution unattended ceiling gate", () => {
  it("parses --automation and refuses any other value", () => {
    expect(parseArgs(["--automation", "unattended"]).budget.automation).toBe("unattended");
    expect(parseArgs(["--automation", "attended"]).budget.automation).toBe("attended");
    expect(() => parseArgs(["--automation", "yolo"])).toThrow(/attended or unattended/);
  });

  it("refuses an unattended run and names the ceilings it still owes", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(
      options({
        ledgerDirectory: directory,
        budget: { ...DEFAULT_FINANCE_RISK_BUDGET, automation: "unattended" },
      }),
    );

    expect(payload.nodes.order_placement.status).toBe("refused");
    expect(payload.nodes.order_placement.refusalReasons).toEqual([
      "risk_budget_unattended_requires_max_order_notional",
      "risk_budget_unattended_requires_max_instrument_notional",
      "risk_budget_unattended_requires_max_orders_per_run",
    ]);
    // The cap names, not the refusal codes: the operator should be told which number to go get.
    expect(payload.nodes.unattended_requires_caps).toEqual([
      "maxOrderNotional",
      "maxInstrumentNotional",
      "maxOrdersPerRun",
    ]);
  });

  it("places an unattended run once every ceiling is declared", async () => {
    const directory = await storeDirectory();
    const payload = await buildFinanceLiveExecutionPayload(
      options({
        ledgerDirectory: directory,
        budget: {
          ...DEFAULT_FINANCE_RISK_BUDGET,
          automation: "unattended",
          maxOrderNotional: 10_000,
          maxInstrumentNotional: 25_000,
          maxOrdersPerRun: 2,
        },
      }),
    );

    expect(payload.nodes.order_placement.status).toBe("placed");
    expect(payload.nodes.unattended_requires_caps).toBeUndefined();
  });

  it("does not let attended mode waive the final risk-increase budget", async () => {
    const directory = await storeDirectory();
    // Same absence of caps as the refused case above; the only difference is who is watching.
    const payload = await buildFinanceLiveExecutionPayload(
      options({ ledgerDirectory: directory, quantity: 1000, budget: DEFAULT_FINANCE_RISK_BUDGET }),
    );

    expect(DEFAULT_FINANCE_RISK_BUDGET.automation).toBe("attended");
    expect(payload.nodes.order_placement.status).toBe("refused");
    expect(payload.nodes.unattended_requires_caps).toBeUndefined();
  });
});

describe("mandatory owner-entry mandate and stop delivery", () => {
  it.each(["paper", "alpaca"] as const)(
    "rejects absent class before constructing %s adapter",
    async (adapter) => {
      const paperFactory = vi.spyOn(executionAdapters, "createPaperExecutionAdapter");
      const venueFactory = vi.spyOn(alpacaAdapters, "createAlpacaExecutionAdapter");
      await expect(
        buildFinanceLiveExecutionPayload(options({ adapter, assetClass: undefined })),
      ).rejects.toThrow("--asset-class is required");
      expect(paperFactory).not.toHaveBeenCalled();
      expect(venueFactory).not.toHaveBeenCalled();
    },
  );
  it.each(["paper", "alpaca"] as const)(
    "rejects missing drawdown before constructing %s adapter",
    async (adapter) => {
      const paperFactory = vi.spyOn(executionAdapters, "createPaperExecutionAdapter");
      const venueFactory = vi.spyOn(alpacaAdapters, "createAlpacaExecutionAdapter");
      await expect(
        buildFinanceLiveExecutionPayload(options({ adapter, drawdownPct: undefined })),
      ).rejects.toThrow("missing drawdown is unknown, not zero");
      expect(paperFactory).not.toHaveBeenCalled();
      expect(venueFactory).not.toHaveBeenCalled();
    },
  );
  it("delivers the same stop approved by mandate to the venue adapter", async () => {
    const directory = await storeDirectory();
    const execute = vi.fn(async () => ({
      filledQuantity: 10,
      fillPrice: 231.4,
      filledAt: AS_OF,
      venueRef: "synthetic:never-sent",
      terminalOrderIdentity: { orderId: "synthetic-terminal", terminal: true as const },
    }));
    vi.spyOn(alpacaAdapters, "createAlpacaExecutionAdapter").mockReturnValue({
      id: "alpaca-venue",
      venue: "fixture",
      kind: "venue",
      orderTypes: ["market"],
      instruments: ["AAPL"],
      credentialsAuthority: "external",
      execute,
    });
    await buildFinanceLiveExecutionPayload(
      options({ adapter: "alpaca", ledgerDirectory: directory, stopPrice: 225 }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ stopPrice: 225 }),
      expect.any(AbortSignal),
      expect.objectContaining({
        adapterId: "alpaca-venue",
        instrument: "AAPL",
        quote: expect.objectContaining({ price: 231.4 }),
      }),
    );
  });
});

it("does not treat CLI labels and attended flags as controller authorization", async () => {
  const factory = vi.spyOn(alpacaAdapters, "createAlpacaExecutionAdapter");
  await expect(buildWithoutController(options({ adapter: "alpaca" }))).rejects.toThrow(
    "execution_safety_context_required",
  );
  expect(factory).not.toHaveBeenCalled();
});
