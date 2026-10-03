import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runFinanceHistoricalPositionMaintenance } from "./finance-historical-position-maintenance.js";

const mocks = vi.hoisted(() => ({
  book: vi.fn(),
  strategies: vi.fn(),
  reconciliation: vi.fn(),
  controller: vi.fn(),
  claims: vi.fn(),
  adapter: vi.fn(),
  place: vi.fn(),
  append: vi.fn(),
  calendar: vi.fn(),
  calendarIssue: vi.fn(),
}));
vi.mock("./finance-alpaca-market-calendar.js", () => ({
  createFinanceAlpacaMarketSessionResolver: () => mocks.calendar,
  financeAlpacaMarketSessionIssue: mocks.calendarIssue,
}));
vi.mock("./finance-account-trading-book.js", () => ({ readFinanceAccountTradingBook: mocks.book }));
vi.mock("./finance-strategy-rule-ledger.js", () => ({
  readFinanceStrategyRuleLedger: mocks.strategies,
}));
vi.mock("./finance-broker-reconciliation.js", () => ({
  readFinanceBrokerReconciliation: mocks.reconciliation,
}));
vi.mock("./finance-execution-safety.js", () => ({
  readFinanceExecutionSafetyClaims: mocks.claims,
}));
vi.mock("./finance-alpaca-cycle-controller.js", async (original) => ({
  ...(await original<typeof import("./finance-alpaca-cycle-controller.js")>()),
  createFinanceAlpacaCycleController: mocks.controller,
}));
vi.mock("./finance-alpaca-execution-adapter.js", () => ({
  createAlpacaExecutionAdapter: mocks.adapter,
}));
vi.mock("./finance-execution-adapter.js", async (original) => ({
  ...(await original<typeof import("./finance-execution-adapter.js")>()),
  placeFinanceOrder: mocks.place,
}));
vi.mock("./finance-position-ledger.js", () => ({ appendFinanceExecutionReceipt: mocks.append }));
const directories: string[] = [];
const policy = {
  schemaVersion: "lcx_alpaca_cycle_policy_v1",
  accountId: "fixture",
  planId: "resident-paper",
  revision: "3",
  peakEquity: 100000,
  peakScope: "fixture",
  unhedged: true,
  maxPortfolioDrawdownFraction: 0.05,
  maxGrossExposure: 10000,
  authorizationMode: "until_revoked",
};
const budget = {
  automation: "unattended" as const,
  allowedInstruments: ["*"],
  maxOrderNotional: 1000,
  maxInstrumentNotional: 5000,
  maxOrdersPerRun: 8,
};
const fill = {
  activityId: "old-buy",
  orderId: "old-order",
  side: "buy",
  instrument: "BTC/USD",
  sourceFactRef: "fill-proof",
};
function book() {
  return {
    accountId: "fixture",
    venue: "alpaca:paper",
    brokerBaselineUsable: true,
    historicalOnlyInstruments: ["BTC/USD"],
    positions: [{ instrument: "BTC/USD", quantity: 0.000399 }],
    execution: { receipts: [] },
    brokerHistory: { fills: [fill], fees: [], assetFeeAdjustedInstruments: ["BTC/USD"] },
  };
}
function snapshot() {
  return {
    observedAt: new Date().toISOString(),
    accountObservation: {
      accountId: "fixture",
      source: "https://paper-api.alpaca.markets/v2/account",
    },
    openOrders: [],
    protection: {
      unresolved: [],
      coverage: [
        {
          instrument: "BTC/USD",
          positionQuantity: 0.000399,
          recognizedStopQuantity: 0,
          uncoveredQuantity: 0.000399,
          status: "no_recognized_stop",
        },
      ],
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.calendar.mockResolvedValue(null);
  mocks.calendarIssue.mockReturnValue(undefined);
  mocks.book.mockResolvedValue(book());
  mocks.strategies.mockResolvedValue({ ledger: { rules: [] } });
  mocks.reconciliation.mockResolvedValue({ ok: true, snapshot: snapshot() });
  mocks.claims.mockResolvedValue([]);
  mocks.controller.mockReturnValue({
    accountBookProvider: vi.fn().mockResolvedValue({
      reconciliation: { status: "ready" },
      positions: [{ instrument: "BTC/USD", quantity: 0.000399 }],
    }),
    prepareExecutionQuote: vi.fn().mockResolvedValue({
      bidPrice: 80000,
      referencePrice: 80000,
      referencePriceAt: new Date().toISOString(),
    }),
    createSafetyContext: vi.fn().mockReturnValue({ kind: "controller_execution_safety" }),
  });
  mocks.adapter.mockReturnValue({ id: "alpaca-venue", venue: "alpaca:paper" });
  mocks.place.mockResolvedValue({
    status: "placed",
    refusalReasons: [],
    receipt: { receiptId: "true-venue-sell", fill: { filledQuantity: 0.000399 } },
  });
  mocks.append.mockResolvedValue({});
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "historical-maintenance-"));
  directories.push(directory);
  const result = await runFinanceHistoricalPositionMaintenance({
    directory,
    policy,
    budget,
    feed: "iex",
    maxAgeMs: 30000,
    signal: new AbortController().signal,
    transport: vi.fn(),
  });
  return { directory, result };
}
it("exits fee-adjusted unowned long inventory through the existing Paper controller and shared gate", async () => {
  mocks.place.mockImplementation(async (request) => {
    const dir = directories.at(-1)!;
    const files = await fs.readdir(path.join(dir, "historical-position-maintenance"));
    const proof = await fs.readFile(
      path.join(dir, "historical-position-maintenance", files[0]),
      "utf8",
    );
    expect(proof).toContain('"phase":"dispatch_ready"');
    expect(request.intent).toMatchObject({
      side: "sell",
      quantity: 0.000399,
      orderType: "market",
      decisionRef: { source: "account_position_maintenance" },
    });
    expect(request.budget).toEqual(budget);
    return {
      status: "placed",
      refusalReasons: [],
      receipt: { receiptId: "true-venue-sell", fill: { filledQuantity: 0.000399 } },
    };
  });
  const { result } = await run();
  expect(result).toMatchObject({
    status: "completed",
    decisions: [{ status: "placed", receiptId: "true-venue-sell" }],
  });
  expect(mocks.controller).toHaveBeenCalledWith(
    expect.objectContaining({ allowCrypto: true, policy, instruments: ["BTC/USD"] }),
  );
  expect(mocks.append).toHaveBeenCalledOnce();
  expect(mocks.adapter).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "paper", timeInForce: "gtc" }),
  );
});
it.each([
  "active_strategy",
  "lcx_entry",
  "protected",
  "partial_protection",
  "open_order",
  "missing_provenance",
  "short",
  "empty",
])("does not adopt ineligible inventory: %s", async (reason) => {
  const currentBook = book();
  const currentSnapshot = snapshot();
  if (reason === "active_strategy") {
    mocks.strategies.mockResolvedValue({
      ledger: { rules: [{ state: "active", instruments: ["BTC/USD"] }] },
    });
  }
  if (reason === "lcx_entry") {
    mocks.book.mockResolvedValue({
      ...currentBook,
      execution: {
        receipts: [{ instrument: "BTC/USD", side: "buy", fill: { filledQuantity: 0.0004 } }],
      },
    });
  }
  if (reason === "protected" || reason === "partial_protection") {
    mocks.reconciliation.mockResolvedValue({
      ok: true,
      snapshot: {
        ...currentSnapshot,
        protection: {
          ...currentSnapshot.protection,
          coverage: [
            {
              ...currentSnapshot.protection.coverage[0],
              status: reason === "protected" ? "covered" : "partial",
            },
          ],
        },
      },
    });
  }
  if (reason === "open_order") {
    mocks.reconciliation.mockResolvedValue({
      ok: true,
      snapshot: { ...currentSnapshot, openOrders: [{ symbol: "BTCUSD" }] },
    });
  }
  if (reason === "missing_provenance") {
    mocks.book.mockResolvedValue({
      ...currentBook,
      brokerHistory: { ...currentBook.brokerHistory, fills: [{ ...fill, sourceFactRef: "" }] },
    });
  }
  if (reason === "short" || reason === "empty") {
    mocks.book.mockResolvedValue({
      ...currentBook,
      positions: [{ instrument: "BTC/USD", quantity: reason === "short" ? -1 : 0 }],
    });
  }
  expect((await run()).result.status).toBe("idle");
  expect(mocks.place).not.toHaveBeenCalled();
});
it.each(["unreconciled", "stale", "wrong_account", "live", "unresolved", "unusable_baseline"])(
  "blocks invalid account facts: %s",
  async (reason) => {
    const s = snapshot();
    if (reason === "unreconciled") {
      mocks.reconciliation.mockResolvedValue({ ok: false });
    }
    if (reason === "stale") {
      mocks.reconciliation.mockResolvedValue({
        ok: true,
        snapshot: { ...s, observedAt: "2020-01-01T00:00:00Z" },
      });
    }
    if (reason === "wrong_account" || reason === "live") {
      mocks.reconciliation.mockResolvedValue({
        ok: true,
        snapshot: {
          ...s,
          accountObservation: {
            ...s.accountObservation,
            ...(reason === "wrong_account"
              ? { accountId: "other" }
              : { source: "https://api.alpaca.markets/v2/account" }),
          },
        },
      });
    }
    if (reason === "unresolved") {
      mocks.reconciliation.mockResolvedValue({
        ok: true,
        snapshot: { ...s, protection: { ...s.protection, unresolved: ["ambiguous"] } },
      });
    }
    if (reason === "unusable_baseline") {
      mocks.book.mockResolvedValue({ ...book(), brokerBaselineUsable: false });
    }
    expect((await run()).result.status).toBe("blocked");
    expect(mocks.place).not.toHaveBeenCalled();
  },
);
it("blocks when inventory changes during account recovery", async () => {
  mocks.controller().accountBookProvider.mockResolvedValue({
    reconciliation: { status: "ready" },
    positions: [{ instrument: "BTC/USD", quantity: 0.000398 }],
  });
  expect((await run()).result.status).toBe("blocked");
  expect(mocks.place).not.toHaveBeenCalled();
});
it("preserves shared gate cap refusals and never records an invented fill", async () => {
  mocks.place.mockResolvedValue({
    status: "refused",
    refusalReasons: ["risk_budget_order_notional_exceeded"],
  });
  expect((await run()).result).toMatchObject({
    status: "blocked",
    decisions: [{ status: "refused", reasons: ["risk_budget_order_notional_exceeded"] }],
  });
  expect(mocks.append).not.toHaveBeenCalled();
});
it("uses stable identities across fresh reconciliation times and blocks an existing claim", async () => {
  const first = await run();
  const id = first.result.decisions[0].id;
  mocks.claims.mockResolvedValue([
    {
      run: `historical-maintenance:resident-paper:${id}`,
      status: "unknown",
      binding: { intent: { intentId: `historical-maintenance:${id}:attempt:0` } },
    },
  ]);
  mocks.place.mockClear();
  const second = await run();
  expect(second.result.decisions[0].id).toBe(id);
  expect(second.result.status).toBe("blocked");
  expect(mocks.place).not.toHaveBeenCalled();
});
it("retains an unknown dispatch outcome for shared journal recovery rather than resubmitting", async () => {
  mocks.place.mockImplementation(async (request) => {
    mocks.claims.mockResolvedValue([
      {
        status: "unknown",
        run: request.intent.runAuthorizationId,
        binding: { intent: request.intent },
      },
    ]);
    throw new Error("offline uncertainty");
  });
  expect((await run()).result).toMatchObject({
    status: "blocked",
    decisions: [{ status: "unknown" }],
  });
  expect(mocks.append).not.toHaveBeenCalled();
});

it("rechecks newly activated strategy ownership inside the controller's locked facts guard", async () => {
  mocks.place.mockImplementation(async () => {
    const options = mocks.controller.mock.calls[0][0];
    mocks.strategies.mockResolvedValue({
      ledger: { rules: [{ state: "active", instruments: ["BTC/USD"] }] },
    });
    await options.validateFacts(
      {
        reconciliation: { status: "ready" },
        positionQuantity: 0.000399,
        reservedSellQuantity: 0,
        protectiveOrders: [],
        openOrderIds: [],
        unresolvedOrderIds: [],
      },
      new AbortController().signal,
    );
    throw new Error("must not reach placement");
  });
  expect((await run()).result.status).toBe("blocked");
  expect(mocks.append).not.toHaveBeenCalled();
});

it("retries terminal rejection only with a bounded journal-derived next attempt", async () => {
  const first = await run();
  const id = first.result.decisions[0].id;
  mocks.claims.mockResolvedValue([
    {
      status: "rejected",
      run: `historical-maintenance:resident-paper:${id}`,
      instrument: "BTC/USD",
      notional: 31.92,
      binding: { intent: { intentId: `historical-maintenance:${id}:attempt:0` } },
    },
  ]);
  mocks.place.mockClear();
  expect((await run()).result.status).toBe("completed");
  expect(mocks.place).toHaveBeenCalledWith(
    expect.objectContaining({
      intent: expect.objectContaining({ intentId: `historical-maintenance:${id}:attempt:1` }),
      ordersPlacedThisRun: 1,
    }),
  );
  mocks.claims.mockResolvedValue(
    Array.from({ length: 8 }, (_, ordinal) => ({
      status: "not_started",
      run: `historical-maintenance:resident-paper:${id}`,
      instrument: "BTC/USD",
      notional: 31.92,
      binding: { intent: { intentId: `historical-maintenance:${id}:attempt:${ordinal}` } },
    })),
  );
  mocks.place.mockClear();
  expect((await run()).result).toMatchObject({
    status: "blocked",
    decisions: [
      { status: "blocked", reasons: ["historical_maintenance_attempt_budget_exhausted"] },
    ],
  });
  expect(mocks.place).not.toHaveBeenCalled();
});
it("does not report complete inventory closure for a partial terminal fill", async () => {
  mocks.place.mockResolvedValue({
    status: "placed",
    refusalReasons: [],
    receipt: { receiptId: "partial", fill: { filledQuantity: 0.0002 } },
  });
  expect((await run()).result).toMatchObject({
    status: "blocked",
    decisions: [
      {
        status: "placed",
        filledQuantity: 0.0002,
        reasons: ["historical_reduction_not_fully_filled"],
      },
    ],
  });
});
it("uses the same historical maintenance contract for another supported instrument", async () => {
  const currentBook = JSON.parse(JSON.stringify(book()).replaceAll("BTC/USD", "ETH/USD"));
  mocks.book.mockResolvedValue(currentBook);
  mocks.reconciliation.mockResolvedValue({
    ok: true,
    snapshot: JSON.parse(JSON.stringify(snapshot()).replaceAll("BTC/USD", "ETH/USD")),
  });
  mocks.controller().accountBookProvider.mockResolvedValue({
    reconciliation: { status: "ready" },
    positions: [{ instrument: "ETH/USD", quantity: 0.000399 }],
  });
  expect((await run()).result).toMatchObject({
    status: "completed",
    decisions: [{ instrument: "ETH/USD" }],
  });
  expect(mocks.place).toHaveBeenCalledWith(
    expect.objectContaining({ intent: expect.objectContaining({ instrument: "ETH/USD" }) }),
  );
});

it.each(["open", "closed", "unknown"])(
  "retains the existing equity cash-session gate: %s",
  async (state) => {
    mocks.book.mockResolvedValue(JSON.parse(JSON.stringify(book()).replaceAll("BTC/USD", "SPY")));
    mocks.reconciliation.mockResolvedValue({
      ok: true,
      snapshot: JSON.parse(JSON.stringify(snapshot()).replaceAll("BTC/USD", "SPY")),
    });
    mocks.controller().accountBookProvider.mockResolvedValue({
      reconciliation: { status: "ready" },
      positions: [{ instrument: "SPY", quantity: 0.000399 }],
    });
    if (state === "open") {
      mocks.calendar.mockResolvedValue({
        openAt: new Date(Date.now() - 10000).toISOString(),
        closeAt: new Date(Date.now() + 10000).toISOString(),
      });
    }
    if (state === "unknown") {
      mocks.calendar.mockRejectedValue(new Error("offline calendar unavailable"));
    }
    const { result } = await run();
    if (state === "open") {
      expect(result.status).toBe("completed");
      expect(mocks.adapter).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "paper", timeInForce: "day" }),
      );
    } else {
      expect(result).toMatchObject({
        status: "blocked",
        decisions: [
          {
            status: "blocked",
            reasons: [
              state === "closed"
                ? "historical_maintenance_outside_cash_session"
                : "historical_maintenance_calendar_unavailable",
            ],
          },
        ],
      });
      expect(mocks.place).not.toHaveBeenCalled();
    }
  },
);
