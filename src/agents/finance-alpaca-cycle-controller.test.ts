import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFinanceAlpacaCycleController } from "./finance-alpaca-cycle-controller.js";
import {
  placeFinanceOrder,
  type FinanceExecutionAdapter,
  type FinanceExecutionIntent,
} from "./finance-execution-adapter.js";
import { readFinanceAccountPositionLedger } from "./finance-position-ledger.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cycle-controller-"));
  directories.push(directory);
  vi.stubEnv("ALPACA_API_KEY_ID", "PK_SYNTHETIC");
  vi.stubEnv("ALPACA_API_SECRET_KEY", "SYNTHETIC");
  const accountId = path.basename(directory);
  const at = new Date(Date.now() - 1000).toISOString();
  const account = {
    id: accountId,
    created_at: "2020-01-01T00:00:00Z",
    status: "ACTIVE",
    currency: "USD",
    trading_blocked: false,
    account_blocked: false,
    trade_suspended_by_user: false,
    equity: "1000",
    cash: "900",
    long_market_value: "100",
    short_market_value: "0",
  };
  const positions = [
    { symbol: "SPY", qty: "1", market_value: "100", side: "long", asset_class: "us_equity" },
  ];
  const activities: Record<string, unknown>[] = [
    {
      id: "deposit",
      activity_type: "JNLC",
      status: "executed",
      net_amount: "1000",
      date: "2020-01-01",
    },
    {
      id: "initial",
      activity_type: "FILL",
      type: "fill",
      side: "buy",
      symbol: "SPY",
      qty: "1",
      price: "100",
      transaction_time: at,
    },
  ];
  const orders: Record<string, unknown>[] = [];
  const openOrders: Record<string, unknown>[] = [];
  const read = vi.fn<FinanceUncachedFetch>(async (url) => {
    const parsed = new URL(url);
    let body: unknown;
    if (parsed.pathname === "/v2/account") {
      body = account;
    } else if (parsed.pathname === "/v2/positions") {
      body = positions;
    } else if (parsed.pathname === "/v2/account/activities") {
      body = activities;
    } else if (/\/activities\/(CFEE|FEE)$/.test(parsed.pathname)) {
      body = [];
    } else if (parsed.pathname === "/v2/orders") {
      body = parsed.searchParams.get("status") === "open" ? openOrders : orders;
    } else if (parsed.pathname === "/v2/orders:by_client_order_id") {
      body = orders.find(
        (order) => order.client_order_id === parsed.searchParams.get("client_order_id"),
      );
      if (!body) {
        return { status: 404, body: "{}" };
      }
    } else if (parsed.pathname === "/v2/assets/SPY") {
      body = { symbol: "SPY", status: "active", tradable: true, class: "us_equity" };
    } else if (parsed.pathname === "/v2/stocks/SPY/quotes/latest") {
      body = { quote: { bp: 100, ap: 100, t: new Date().toISOString() } };
    } else {
      throw new Error(`unexpected fixture request ${parsed.pathname}`);
    }
    return { status: 200, body: JSON.stringify(body) };
  });
  const policy = {
    schemaVersion: "lcx_alpaca_cycle_policy_v1",
    accountId,
    planId: "test",
    revision: "1",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    peakEquity: 1000,
    peakScope: "test-account",
    unhedged: true,
    maxPortfolioDrawdownFraction: 0.2,
    maxGrossExposure: 1000,
  };
  const options = {
    directory,
    policy,
    instruments: ["SPY"],
    feed: "iex" as const,
    maxAgeMs: 60000,
    read,
  };
  const controller = createFinanceAlpacaCycleController(options);
  const budget = {
    automation: "unattended" as const,
    allowedInstruments: ["SPY"],
    maxOrderNotional: 200,
    maxInstrumentNotional: 500,
    maxOrdersPerRun: 3,
  };
  const execute = vi.fn<FinanceExecutionAdapter["execute"]>(async (intent) => {
    const id = `order-${orders.length + 1}`;
    const filledAt = new Date().toISOString();
    const clientId = `lcx-${createHash("sha256")
      .update(JSON.stringify(["paper", intent.runAuthorizationId, intent.intentId]))
      .digest("hex")
      .slice(0, 40)}`;
    orders.push({
      id,
      client_order_id: clientId,
      symbol: intent.instrument,
      side: intent.side,
      qty: String(intent.quantity),
      type: intent.orderType,
      time_in_force: "day",
      status: "filled",
      filled_qty: String(intent.quantity),
      filled_avg_price: "100",
      filled_at: filledAt,
      submitted_at: filledAt,
    });
    positions[0].qty = String(Number(positions[0].qty) + intent.quantity);
    positions[0].market_value = String(Number(positions[0].qty) * 100);
    account.cash = String(Number(account.cash) - intent.quantity * 100);
    account.long_market_value = String(
      positions.reduce((sum, position) => sum + Number(position.market_value), 0),
    );
    activities.push({
      id,
      activity_type: "FILL",
      type: "fill",
      side: intent.side,
      symbol: "SPY",
      qty: String(intent.quantity),
      price: "100",
      transaction_time: filledAt,
    });
    return {
      filledQuantity: intent.quantity,
      fillPrice: 100,
      filledAt,
      venueRef: `alpaca:paper:${id}`,
      terminalOrderIdentity: { orderId: id, terminal: true },
    };
  });
  const adapter: FinanceExecutionAdapter = {
    id: "alpaca-venue",
    venue: "alpaca:paper",
    kind: "venue",
    instruments: ["SPY"],
    orderTypes: ["market"],
    credentialsAuthority: "external",
    execute,
  };
  async function place(id: string, use = controller) {
    const quote = await use.executionQuoteProvider(
      { instrument: "SPY", side: "buy", assetClass: "us_equity" },
      AbortSignal.timeout(5000),
    );
    const intent: FinanceExecutionIntent = {
      intentId: id,
      instrument: "SPY",
      side: "buy",
      quantity: 1,
      orderType: "market",
      referencePrice: quote.referencePrice,
      referencePriceAt: quote.referencePriceAt,
      runAuthorizationId: "test-run",
      rationale: "synthetic",
    };
    const result = await placeFinanceOrder({
      mode: "live_execution",
      committedInstrumentNotional: orders.length * 100,
      ordersPlacedThisRun: orders.length,
      executionAdapterId: adapter.id,
      adapters: [adapter],
      intent,
      budget,
      safetyContext: use.createSafetyContext({
        intent,
        budget,
        adapterId: adapter.id,
        venue: adapter.venue,
      }),
    });
    if (result.status === "refused") {
      throw new Error(result.refusalReasons.join(","));
    }
    return result;
  }
  return {
    directory,
    account,
    positions,
    activities,
    orders,
    openOrders,
    read,
    policy,
    options,
    controller,
    execute,
    place,
    accountId,
  };
}

it("sizes from native positions, executes twice through the shared gate and recovers confirmed receipts on restart", async () => {
  const f = await fixture();
  const book = await f.controller.accountBookProvider(AbortSignal.timeout(5000));
  expect(book.positions).toEqual([{ instrument: "SPY", quantity: 1, marketValue: 100 }]);
  expect((await f.place("first")).status).toBe("placed");
  expect((await f.place("second")).status).toBe("placed");
  expect(f.execute).toHaveBeenCalledTimes(2);
  const restart = createFinanceAlpacaCycleController(f.options);
  expect((await restart.accountBookProvider(AbortSignal.timeout(5000))).positions[0].quantity).toBe(
    3,
  );
  const ledger = await readFinanceAccountPositionLedger(f.directory, {
    accountId: f.accountId,
    venue: "alpaca:paper",
  });
  expect(ledger.receipts).toHaveLength(2);
  expect(f.execute).toHaveBeenCalledTimes(2);
});

it("does not fill an unexplained quantity gap with invented fees", async () => {
  const f = await fixture();
  f.positions[0].qty = "0.999";
  await expect(f.controller.accountBookProvider(AbortSignal.timeout(5000))).rejects.toThrow(
    "economics",
  );
  expect(f.execute).not.toHaveBeenCalled();
});

it("rejects account changes and never retries a missing previously confirmed order", async () => {
  const f = await fixture();
  f.account.id = "another-account";
  await expect(f.controller.accountBookProvider(AbortSignal.timeout(5000))).rejects.toThrow(
    "account mismatch",
  );
  f.account.id = f.accountId;
  expect((await f.place("first")).status).toBe("placed");
  f.orders.splice(0);
  await expect(f.place("second")).rejects.toThrow("execution_safety_state_unavailable");
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("persists a newly observed equity high across controller recreation", async () => {
  const f = await fixture();
  f.account.equity = "1100";
  f.account.cash = "1000";
  await f.controller.executionQuoteProvider(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(5000),
  );
  const filename = (await fs.readdir(f.directory)).find((name) =>
    name.startsWith("account-peak-"),
  )!;
  expect(
    JSON.parse((await fs.readFile(path.join(f.directory, filename), "utf8")).trim()).peakEquity,
  ).toBe(1100);
  await fs.writeFile(path.join(f.directory, filename), "{broken");
  const restart = createFinanceAlpacaCycleController(f.options);
  await expect(
    restart.executionQuoteProvider(
      { instrument: "SPY", side: "buy", assetClass: "us_equity" },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow("incomplete account peak");
});

it("retains an unknown outcome and refuses another cycle without repeating the order", async () => {
  const f = await fixture();
  f.execute.mockRejectedValueOnce(new Error("connection lost after submit"));
  await expect(f.place("unknown")).rejects.toMatchObject({
    code: "finance_execution_safety_unknown",
  });
  const restart = createFinanceAlpacaCycleController(f.options);
  await expect(restart.accountBookProvider(AbortSignal.timeout(5000))).rejects.toThrow(
    "recovery incomplete",
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("uses persisted highs for the drawdown gate after a restart", async () => {
  const f = await fixture();
  f.account.equity = "1100";
  f.account.cash = "1000";
  await f.controller.executionQuoteProvider(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(5000),
  );
  f.account.equity = "1000";
  f.account.cash = "900";
  const restart = createFinanceAlpacaCycleController({
    ...f.options,
    policy: { ...f.policy, maxPortfolioDrawdownFraction: 0.05 },
  });
  await expect(f.place("drawdown", restart)).rejects.toThrow("drawdown");
  expect(f.execute).not.toHaveBeenCalled();
});

it("accepts an existing protective stop as a reservation rather than a duplicate working order", async () => {
  const f = await fixture();
  f.openOrders.push({
    id: "protection",
    symbol: "SPY",
    side: "sell",
    type: "stop",
    time_in_force: "gtc",
    status: "new",
    qty: "1",
    filled_qty: "0",
    stop_price: "90",
  });
  const book = await f.controller.accountBookProvider(AbortSignal.timeout(5000));
  expect(book.positions[0].quantity).toBe(1);
  expect(f.execute).not.toHaveBeenCalled();
});

it("resolves execution credentials from the controller's selected book", async () => {
  const f = await fixture();
  vi.stubEnv("ALPACA_API_KEY_ID", undefined);
  vi.stubEnv("ALPACA_API_SECRET_KEY", undefined);
  await fs.writeFile(
    path.join(f.directory, "credentials.env"),
    "ALPACA_API_KEY_ID=PK_LOCAL_FIXTURE\nALPACA_API_SECRET_KEY=LOCAL_FIXTURE\n",
  );
  const { createAlpacaExecutionAdapter } = await import("./finance-alpaca-execution-adapter.js");
  const postJson = vi.fn(async () => ({
    status: 200,
    body: JSON.stringify({
      id: "fixture-order",
      status: "filled",
      filled_qty: "1",
      filled_avg_price: "100",
      filled_at: new Date().toISOString(),
    }),
  }));
  const adapter = createAlpacaExecutionAdapter({
    instruments: ["SPY"],
    credentialStateDirectory: f.directory,
    postJson,
  });
  await adapter.execute(
    {
      intentId: "root",
      instrument: "SPY",
      side: "buy",
      quantity: 1,
      orderType: "market",
      referencePrice: 100,
      referencePriceAt: new Date().toISOString(),
      runAuthorizationId: "fixture",
      rationale: "fixture",
    },
    AbortSignal.timeout(1000),
  );
  expect(postJson).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.objectContaining({ "APCA-API-KEY-ID": "PK_LOCAL_FIXTURE" }),
    }),
  );
});

it("isolates a bounded BTC gap while unrelated executions and recovery retain unresolved history", async () => {
  const f = await fixture();
  f.positions.push({
    symbol: "BTCUSD",
    qty: "0.000399",
    market_value: "40",
    side: "long",
    asset_class: "crypto",
  });
  f.account.cash = "860";
  f.account.long_market_value = "140";
  f.activities.push({
    id: "btc-fill",
    activity_type: "FILL",
    type: "fill",
    side: "buy",
    symbol: "BTCUSD",
    qty: "0.0004",
    price: "100000",
    transaction_time: new Date(Date.now() - 1000).toISOString(),
  });
  expect(
    (await f.controller.inspectReconciliation(AbortSignal.timeout(5000))).readiness.status,
  ).toBe("blocked");
  const controller = createFinanceAlpacaCycleController({
    ...f.options,
    policy: {
      ...f.policy,
      quantityDifferenceIsolation: { instruments: ["BTC/USD"], maxUnexplainedNotional: 1 },
    },
  });
  const inspection = await controller.inspectReconciliation(AbortSignal.timeout(5000));
  expect(inspection.readiness).toMatchObject({
    status: "restricted",
    historyStatus: "unresolved",
    quarantinedInstruments: ["BTC/USD"],
  });
  expect(inspection.readiness.uncertaintyReserve).toBeGreaterThan(0.1);
  expect(f.read.mock.calls.some(([url]) => new URL(url).pathname.includes("quotes"))).toBe(false);
  const book = await controller.accountBookProvider(AbortSignal.timeout(5000));
  expect(book.reconciliation).toEqual(inspection.readiness);
  expect((await f.place("first", controller)).status).toBe("placed");
  expect((await f.place("second", controller)).status).toBe("placed");
  expect(
    (await controller.inspectReconciliation(AbortSignal.timeout(5000))).readiness.historyStatus,
  ).toBe("unresolved");
  expect(f.orders.map((order) => order.symbol)).toEqual(["SPY", "SPY"]);
  f.positions[1].market_value = "10000";
  await expect(controller.accountBookProvider(AbortSignal.timeout(5000))).rejects.toThrow(
    "economics",
  );
  expect(f.execute).toHaveBeenCalledTimes(2);
});

it("quarantines the affected execution instrument even inside the isolation budget", async () => {
  const f = await fixture();
  f.positions[0].qty = "0.999";
  const controller = createFinanceAlpacaCycleController({
    ...f.options,
    policy: {
      ...f.policy,
      quantityDifferenceIsolation: { instruments: ["SPY"], maxUnexplainedNotional: 1 },
    },
  });
  expect((await controller.inspectReconciliation(AbortSignal.timeout(5000))).readiness.status).toBe(
    "restricted",
  );
  await expect(f.place("quarantined", controller)).rejects.toThrow(
    "execution_safety_instrument_quarantined",
  );
  expect(f.execute).not.toHaveBeenCalled();
});
