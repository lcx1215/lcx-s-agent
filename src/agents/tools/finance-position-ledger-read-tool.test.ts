import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as accountBook from "../finance-account-trading-book.js";
import {
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  type FinanceExecutionReceipt,
} from "../finance-execution-adapter.js";
import {
  appendFinanceBrokerHistory,
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  readFinancePositionLedger,
} from "../finance-position-ledger.js";
import * as positionStore from "../finance-position-ledger.js";
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

it("rejects a cancelled ledger read before touching the filesystem", async () => {
  const controller = new AbortController();
  const reason = new Error("ledger cancelled before access");
  controller.abort(reason);
  const access = vi.spyOn(fs, "access");
  try {
    await expect(
      createFinancePositionLedgerReadTool({ workspaceDir: "/unused-fixture" }).execute(
        "cancel",
        {},
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(access).not.toHaveBeenCalled();
  } finally {
    access.mockRestore();
  }
});

it("skips the duplicate raw-record scan when curve and receipt history are not requested", async () => {
  const directory = await storeDirectory();
  await appendFinancePositionMark(directory, { instrument: "SPY", at: PAST, price: 100 });
  const raw = vi.spyOn(positionStore, "readFinancePositionRecords");
  try {
    const result = await createFinancePositionLedgerReadTool().execute("default-read", {
      directory,
    });
    expect(result.details).toMatchObject({ ok: true, recordCount: 1 });
    expect(raw).not.toHaveBeenCalled();
  } finally {
    raw.mockRestore();
  }
});

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
  history?: unknown;
  brokerSnapshot?: unknown;
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

it.each([
  { brokerSnapshotOnly: true },
  { brokerSnapshotCursor: "cursor" },
  { brokerAccountId: "fixture", brokerSnapshotOnly: true, initialCapital: 100 },
  { brokerAccountId: "fixture", brokerSnapshotOnly: true, includeBehaviour: true },
])("rejects incompatible snapshot-only arguments before opening the book: %j", async (args) => {
  const access = vi.spyOn(fs, "access");
  try {
    const result = await createFinancePositionLedgerReadTool().execute("invalid-snapshot", args);
    expect(result.details).toMatchObject({ ok: false, status: "invalid_scope" });
    expect(access).not.toHaveBeenCalled();
  } finally {
    access.mockRestore();
  }
});

it("reads a retained holdings page without reconstructing unrelated execution history", async () => {
  const directory = await storeDirectory();
  const observedAt = new Date().toISOString();
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId: "page-account",
    venue: "alpaca:paper",
    query: `reconciliation:${observedAt}`,
    cursor: "",
    payload: [
      {
        observedAt,
        positions: Array.from({ length: 9 }, (_, index) => ({ symbol: `FIX${index}`, qty: "1" })),
        openOrders: [],
      },
    ],
  });
  const accountRead = vi.spyOn(accountBook, "readFinanceAccountTradingBook");
  const ledgerRead = vi.spyOn(positionStore, "readFinancePositionLedger");
  try {
    const tool = createFinancePositionLedgerReadTool();
    const result = await tool.execute("snapshot-page", {
      directory,
      brokerAccountId: "page-account",
      brokerSnapshotOnly: true,
    });
    const data = result.details as {
      brokerSnapshot: {
        accounts: { holdingsPage: { nextCursor: string }; holdings: { instrument: string }[] }[];
      };
    };
    expect(accountRead).not.toHaveBeenCalled();
    expect(ledgerRead).not.toHaveBeenCalled();
    expect(data.brokerSnapshot.accounts[0].holdingsPage.nextCursor).toBeTypeOf("string");
    const next = await tool.execute("snapshot-next", {
      directory,
      brokerAccountId: "page-account",
      brokerSnapshotOnly: true,
      brokerSnapshotCursor: data.brokerSnapshot.accounts[0].holdingsPage.nextCursor,
    });
    expect(
      (next.details as typeof data).brokerSnapshot.accounts[0].holdings[0].instrument,
    ).not.toBe(data.brokerSnapshot.accounts[0].holdings[0].instrument);
  } finally {
    accountRead.mockRestore();
    ledgerRead.mockRestore();
  }
});

it("reads scoped retained native protection separately from the receipt book", async () => {
  const directory = await storeDirectory();
  await appendFinanceExecutionReceipt(directory, fill());
  const observedAt = new Date().toISOString();
  const append = async (accountId: string) =>
    appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: `reconciliation:${observedAt}`,
      cursor: "",
      payload: [{ observedAt, positions: [{ symbol: "TLT", qty: "130" }], openOrders: [] }],
    });
  const record = await append("requested-account");
  for (const accountId of ["other-1", "other-2", "other-3", "other-4"]) {
    await append(accountId);
  }
  const tool = createFinancePositionLedgerReadTool();
  const ordinary = await read(tool, { directory });
  expect(ordinary.brokerSnapshot).toBeUndefined();
  const scoped = await read(tool, { directory, brokerAccountId: "requested-account" });
  expect(scoped.positions).toEqual(ordinary.positions);
  expect(scoped.brokerSnapshot).toMatchObject({
    status: "present",
    accounts: [
      {
        accountId: "requested-account",
        venue: "alpaca:paper",
        snapshotRef: record.record.ref,
        observedAt,
        freshness: "fresh",
        positionCount: 1,
        uncoveredCount: 1,
        holdings: [{ instrument: "TLT", positionQuantity: 130, status: "no_recognized_stop" }],
      },
    ],
  });
  const snapshot = scoped.brokerSnapshot as { accounts: Record<string, unknown>[] };
  expect(snapshot.accounts).toHaveLength(1);
  expect(snapshot.accounts[0]).not.toHaveProperty("outsideActiveRuleCount");
  expect(snapshot.accounts[0]).not.toHaveProperty("needsInspection");
  expect((snapshot.accounts[0].holdings as Record<string, unknown>[])[0]).not.toHaveProperty(
    "activeRuleIds",
  );
});

it("reports malformed retained native snapshots without claiming a flat account", async () => {
  const directory = await storeDirectory();
  const observedAt = new Date().toISOString();
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId: "requested-account",
    venue: "alpaca:paper",
    query: `reconciliation:${observedAt}`,
    cursor: "",
    payload: [{ observedAt, positions: [{ symbol: "TLT", qty: "unknown" }], openOrders: [] }],
  });
  const result = await read(createFinancePositionLedgerReadTool(), {
    directory,
    brokerAccountId: "requested-account",
  });
  expect(result.brokerSnapshot).toMatchObject({
    status: "unavailable",
    reason: expect.any(String),
  });
  expect(result.brokerSnapshot).not.toHaveProperty("accounts");
});

it("preserves stale and absent native snapshot status without inventing current protection", async () => {
  const directory = await storeDirectory();
  await appendFinanceExecutionReceipt(directory, fill());
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId: "requested-account",
    venue: "alpaca:paper",
    query: `reconciliation:${PAST}`,
    cursor: "",
    payload: [{ observedAt: PAST, positions: [{ symbol: "TLT", qty: "130" }], openOrders: [] }],
  });
  const tool = createFinancePositionLedgerReadTool();
  const stale = await read(tool, { directory, brokerAccountId: "requested-account" });
  expect(stale.brokerSnapshot).toMatchObject({
    status: "present",
    accounts: [{ freshness: "stale", observedAt: PAST, uncoveredCount: 1 }],
  });
  const missing = await read(tool, { directory, brokerAccountId: "missing-account" });
  expect(missing.brokerSnapshot).toMatchObject({ status: "absent", accounts: [] });
});

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

  it("pages account-scoped receipts without gaps, rejects stale cursors, and leaves storage unchanged", async () => {
    const directory = await storeDirectory();
    for (let index = 0; index < 3; index += 1) {
      await appendFinanceExecutionReceipt(
        directory,
        fill({
          accountId: "acct-a",
          venue: "paper",
          receiptId: `page-${index}`,
          recordedAt: `2026-09-10T00:0${index}:00.000Z`,
        }),
      );
    }
    await appendFinanceExecutionReceipt(
      directory,
      fill({ accountId: "acct-b", venue: "paper", receiptId: "other-account" }),
    );
    const tool = createFinancePositionLedgerReadTool({});
    const args = {
      directory,
      historyKind: "receipt",
      historyAccountId: "acct-a",
      historyVenue: "paper",
      historyLimit: 2,
    };
    const first = await read(tool, args);
    const firstPage = first.history as {
      items: { receiptId: string }[];
      nextCursor: string;
      headRef: string;
    };
    expect(firstPage.items.map((row) => row.receiptId)).toEqual(["page-0", "page-1"]);
    const wrongScope = await read(tool, {
      ...args,
      historyInstrument: "MSFT",
      historyCursor: firstPage.nextCursor,
    });
    expect((wrongScope.history as { status: string }).status).toBe("stale_cursor");
    const beforeRead = await fs.stat(financePositionLedgerPath(directory));
    const second = await read(tool, { ...args, historyCursor: firstPage.nextCursor });
    expect(
      (second.history as { items: { receiptId: string }[] }).items.map((row) => row.receiptId),
    ).toEqual(["page-2"]);
    const afterRead = await fs.stat(financePositionLedgerPath(directory));
    expect(afterRead.size).toBe(beforeRead.size);
    expect(afterRead.mtimeMs).toBe(beforeRead.mtimeMs);
    await appendFinanceExecutionReceipt(
      directory,
      fill({ accountId: "acct-a", venue: "paper", receiptId: "new-head" }),
    );
    const stale = await read(tool, { ...args, historyCursor: firstPage.nextCursor });
    expect((stale.history as { status: string }).status).toBe("stale_cursor");
    expect(await fs.readFile(financePositionLedgerPath(directory))).toBeTruthy();
  });

  it("rejects missing history scope and marks stored order observations unreconciled", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(directory, fill({ accountId: "acct-a" }));
    const tool = createFinancePositionLedgerReadTool({});
    expect((await read(tool, { directory, historyKind: "receipt" })).status).toBe("invalid_scope");
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId: "acct-a",
      venue: "alpaca:paper",
      query: "orders:old",
      cursor: "",
      payload: [
        {
          id: "order-1",
          client_order_id: "client-1",
          symbol: "AAPL",
          side: "buy",
          status: "new",
          qty: "2",
          created_at: "2026-09-10T00:00:00Z",
          updated_at: "2026-09-10T00:00:00Z",
          message: "private raw field",
        },
      ],
    });
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId: "acct-a",
      venue: "alpaca:paper",
      query: "orders:new",
      cursor: "",
      payload: [
        {
          id: "order-1",
          client_order_id: "client-1",
          symbol: "AAPL",
          side: "buy",
          status: "filled",
          qty: "2",
          filled_qty: "2",
          created_at: "2026-09-10T00:00:00Z",
          updated_at: "2026-09-10T01:00:00Z",
          message: "private raw field",
        },
      ],
    });
    const broker = await read(tool, {
      directory,
      historyKind: "order",
      historyAccountId: "acct-a",
      historyVenue: "alpaca:paper",
    });
    const history = broker.history as {
      status: string;
      sourceStatus: string;
      items: Record<string, unknown>[];
    };
    expect(history.status).toBe("raw_observations_only");
    expect(history.sourceStatus).toBe("raw_observations_only");
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      orderId: "order-1",
      status: "filled",
      filledQuantity: 2,
    });
    expect(history.items[0]).not.toHaveProperty("message");
  });

  it("reports an oversized single receipt by reference instead of an empty completed page", async () => {
    const directory = await storeDirectory();
    await appendFinanceExecutionReceipt(
      directory,
      fill({
        accountId: "acct-large",
        venue: "paper",
        receiptId: "receipt-large",
        intentId: "x".repeat(4_000),
      }),
    );
    const page = await read(createFinancePositionLedgerReadTool({}), {
      directory,
      historyKind: "receipt",
      historyAccountId: "acct-large",
      historyVenue: "paper",
      historyLimit: 1,
    });
    expect(page.history).toMatchObject({ status: "item_too_large", items: [], nextCursor: null });
    expect((page.history as { omittedRef: string }).omittedRef).toBeTruthy();
  });

  it("pages normalized broker fills and fees with account/head-bound cursors", async () => {
    const directory = await storeDirectory();
    const accountId = "acct-history";
    const appendFacts = (payload: Record<string, unknown>[], query: string) =>
      appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId,
        venue: "alpaca:paper",
        query,
        cursor: "",
        payload,
      });
    await appendFacts(
      [
        {
          id: "fill-1",
          activity_type: "FILL",
          type: "fill",
          order_id: "o-1",
          symbol: "AAPL",
          side: "buy",
          qty: "1",
          price: "100",
          transaction_time: "2026-09-10T00:00:00Z",
        },
        {
          id: "fill-2",
          activity_type: "FILL",
          type: "fill",
          order_id: "o-2",
          symbol: "AAPL",
          side: "buy",
          qty: "2",
          price: "101",
          transaction_time: "2026-09-10T01:00:00Z",
        },
        {
          id: "fee-1",
          activity_type: "FEE",
          order_id: "o-1",
          symbol: "AAPL",
          currency: "USD",
          net_amount: "-1.25",
          date: "2026-09-10",
        },
      ],
      "activities:fixture",
    );
    const tool = createFinancePositionLedgerReadTool({});
    const scope = {
      directory,
      historyAccountId: accountId,
      historyVenue: "alpaca:paper",
      historyLimit: 1,
    };
    const first = await read(tool, { ...scope, historyKind: "fill" });
    const firstHistory = first.history as {
      items: { activityId: string }[];
      nextCursor: string;
      headRef: string;
    };
    expect(firstHistory.items[0]?.activityId).toBe("fill-1");
    expect(firstHistory.headRef).toMatch(/^[a-f0-9]{64}$/u);
    const second = await read(tool, {
      ...scope,
      historyKind: "fill",
      historyCursor: firstHistory.nextCursor,
    });
    expect((second.history as { items: { activityId: string }[] }).items[0]?.activityId).toBe(
      "fill-2",
    );
    const fees = await read(tool, { ...scope, historyKind: "fee" });
    expect(
      (fees.history as { items: { activityId: string; amount: number }[] }).items[0],
    ).toMatchObject({ activityId: "fee-1", amount: 1.25 });
    await appendFacts(
      [
        {
          id: "fill-3",
          activity_type: "FILL",
          type: "fill",
          order_id: "o-3",
          symbol: "AAPL",
          side: "buy",
          qty: "1",
          price: "102",
          transaction_time: "2026-09-10T02:00:00Z",
        },
      ],
      "activities:next",
    );
    const stale = await read(tool, {
      ...scope,
      historyKind: "fill",
      historyCursor: firstHistory.nextCursor,
    });
    expect((stale.history as { status: string }).status).toBe("stale_cursor");
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
    expect(payload.asOfCaveat).toContain(
      "gross curve includes only receipts and marks recorded by asOf",
    );
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
