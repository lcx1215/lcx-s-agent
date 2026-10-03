import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFinanceAlpacaCycleController } from "./finance-alpaca-cycle-controller.js";
import { readFinanceBrokerReconciliation } from "./finance-broker-reconciliation.js";
import {
  placeFinanceOrder,
  type FinanceExecutionAdapter,
  type FinanceExecutionIntent,
} from "./finance-execution-adapter.js";
import {
  FinanceExecutionSafetyDispatchError,
  readFinanceExecutionSafetyClaims,
  retireFinancePaperExecutionClaim,
} from "./finance-execution-safety.js";
import { readFinanceAccountPositionLedger } from "./finance-position-ledger.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(standing = false) {
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
    ...(standing
      ? { authorizationMode: "until_revoked" }
      : { expiresAt: new Date(Date.now() + 600000).toISOString() }),
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
  async function place(
    id: string,
    use = controller,
    quoteOverride?: Awaited<ReturnType<typeof controller.executionQuoteProvider>>,
  ) {
    const quote =
      quoteOverride ??
      (await use.executionQuoteProvider(
        { instrument: "SPY", side: "buy", assetClass: "us_equity" },
        AbortSignal.timeout(5000),
      ));
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

it("keeps standing Paper permission after multiple days but issues a finite order capability", async () => {
  const f = await fixture(true);
  expect(f.controller.executionPolicyAuthorizationMode).toBe("until_revoked");
  expect(f.controller.executionPolicyExpiresAt).toBeNull();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * 86400000);
  const issuedAt = Date.now();

  expect((await f.place("standing-after-days")).status).toBe("placed");
  const claims = await readFinanceExecutionSafetyClaims({
    stateDir: f.directory,
    accountId: f.accountId,
    venue: "alpaca:paper",
  });
  expect(claims[0].binding?.policy.expiresAt).toBe(new Date(issuedAt + 120000).toISOString());
  expect(claims[0].binding?.policy.maxGrossExposure).toBe(f.policy.maxGrossExposure);
  expect(claims[0].binding?.venue).toBe("alpaca:paper");
});

it("refuses an expired standing order capability and requires a newly issued context", async () => {
  const f = await fixture(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  const expiredContextController = {
    ...f.controller,
    createSafetyContext: (...args: Parameters<typeof f.controller.createSafetyContext>) => {
      const context = f.controller.createSafetyContext(...args);
      vi.setSystemTime(Date.now() + 120001);
      return context;
    },
  };
  await expect(f.place("standing-expired-token", expiredContextController)).rejects.toThrow(
    "execution_safety_authorized_plan_exceeded_or_expired",
  );
  expect(f.execute).not.toHaveBeenCalled();
  expect((await f.place("standing-fresh-token")).status).toBe("placed");
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("rejects ambiguous standing/expiry policies and preserves legacy expiry refusal", async () => {
  const f = await fixture();
  if (!("expiresAt" in f.policy)) {
    throw new Error("finite fixture required");
  }
  const { expiresAt, ...fields } = f.policy;
  for (const policy of [
    fields,
    { ...fields, authorizationMode: "until_revoked", expiresAt },
    { ...fields, authorizationMode: "unlimited" },
  ]) {
    expect(() => createFinanceAlpacaCycleController({ ...f.options, policy })).toThrow();
  }
  expect(() =>
    createFinanceAlpacaCycleController({
      ...f.options,
      policy: { ...f.policy, expiresAt: new Date(Date.now() - 1).toISOString() },
    }),
  ).toThrow("invalid or expired");
  expect(f.controller.executionPolicyAuthorizationMode).toBe("until_expiry");
  expect(f.controller.executionPolicyExpiresAt).toBe(expiresAt);
});

it("does not let standing permission bypass portfolio exposure limits or Paper credentials", async () => {
  const f = await fixture(true);
  const limited = createFinanceAlpacaCycleController({
    ...f.options,
    policy: { ...f.policy, maxGrossExposure: 150 },
  });
  await expect(f.place("standing-exposure", limited)).rejects.toThrow("exposure");
  expect(f.execute).not.toHaveBeenCalled();
  vi.stubEnv("ALPACA_API_KEY_ID", "AK_LIVE_SYNTHETIC");
  expect(() => createFinanceAlpacaCycleController(f.options)).toThrow(
    "requires configured paper credentials",
  );
});

it("reads one quote before review and re-reads broker facts at the final safety gate", async () => {
  const f = await fixture();
  const quote = await f.controller.executionQuoteProvider(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(5000),
  );
  expect(f.read).toHaveBeenCalledTimes(1);
  const quoteUrl = new URL(f.read.mock.calls[0][0]);
  expect(quoteUrl.hostname).toBe("data.alpaca.markets");
  expect(quoteUrl.pathname).toBe("/v2/stocks/SPY/quotes/latest");
  expect(quoteUrl.searchParams.get("feed")).toBe("iex");

  expect((await f.place("quote-only", f.controller, quote)).status).toBe("placed");
  const finalReads = f.read.mock.calls.slice(1).map(([url]) => new URL(url));
  expect(finalReads.slice(-4).map((url) => url.pathname)).toEqual([
    "/v2/account",
    "/v2/positions",
    "/v2/orders",
    "/v2/assets/SPY",
  ]);
  expect(finalReads.some((url) => url.pathname.includes("/quotes/"))).toBe(false);
});

it("persists the exact account arithmetic refusal from final broker facts", async () => {
  const f = await fixture();
  const quote = await f.controller.prepareExecutionQuote(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(5000),
  );
  // The reconciled snapshot was valid; the final account GET must catch this change.
  f.account.cash = "899";
  const intent: FinanceExecutionIntent = {
    intentId: "arithmetic-refusal",
    instrument: "SPY",
    side: "buy",
    quantity: 1,
    orderType: "market",
    referencePrice: quote.referencePrice,
    referencePriceAt: quote.referencePriceAt,
    runAuthorizationId: "test-run",
    rationale: "synthetic",
  };
  const budget = {
    automation: "unattended" as const,
    allowedInstruments: ["SPY"],
    maxOrderNotional: 200,
    maxInstrumentNotional: 500,
    maxOrdersPerRun: 3,
  };
  const result = await placeFinanceOrder({
    mode: "live_execution",
    committedInstrumentNotional: 0,
    ordersPlacedThisRun: 0,
    executionAdapterId: "alpaca-venue",
    adapters: [
      {
        id: "alpaca-venue",
        venue: "alpaca:paper",
        kind: "venue",
        instruments: ["SPY"],
        orderTypes: ["market"],
        credentialsAuthority: "external",
        execute: f.execute,
      },
    ],
    intent,
    budget,
    safetyContext: f.controller.createSafetyContext({
      intent,
      budget,
      adapterId: "alpaca-venue",
      venue: "alpaca:paper",
    }),
  });
  expect(result).toMatchObject({
    status: "refused",
    safetyFailure: {
      provider: {
        reason: "alpaca_safety_facts_inconsistent",
        stage: "account_arithmetic",
        accountArithmetic: {
          failedConditions: ["cash_equity_mismatch"],
          values: { cashEquityResidual: -1, cashEquityTolerance: 0.01 },
        },
      },
    },
  });
  expect(f.execute).not.toHaveBeenCalled();
});

it("classifies a broker reconciliation transport failure without dispatch or raw error leakage", async () => {
  const f = await fixture();
  const quote = await f.controller.executionQuoteProvider(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(5000),
  );
  f.read.mockRejectedValueOnce(new Error("fetch failed secret=do-not-persist"));
  await expect(f.place("failed-reconciliation", f.controller, quote)).rejects.toThrow(
    "execution_safety_broker_reconciliation_unavailable",
  );
  expect(f.execute).not.toHaveBeenCalled();
});

it("uses a newly bound quote after a slow review outlives the original quote", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T19:30:00.000Z"));
  const f = await fixture();
  const first = await f.controller.executionQuoteProvider(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(5000),
  );

  await vi.advanceTimersByTimeAsync(61_000);
  const refreshed = await f.controller.executionQuoteProvider(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(5000),
  );

  expect(Date.parse(first.referencePriceAt)).toBeLessThan(Date.parse(refreshed.referencePriceAt));
  expect((await f.place("slow-review-refresh", f.controller, refreshed)).status).toBe("placed");
  expect(
    f.read.mock.calls.filter(([url]) => new URL(url).pathname.includes("/quotes/")),
  ).toHaveLength(2);
});

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
    "broker_reconciliation_blocked",
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
  await expect(f.place("second")).rejects.toThrow("execution_safety_terminal_order_mismatch");
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("persists a newly observed equity high across controller recreation", async () => {
  const f = await fixture();
  f.account.equity = "1100";
  f.account.cash = "1000";
  f.activities.push({
    id: "high-deposit",
    activity_type: "JNLC",
    status: "executed",
    net_amount: "100",
    date: new Date().toISOString().slice(0, 10),
  });
  await f.controller.accountBookProvider(AbortSignal.timeout(5000));
  const filename = (await fs.readdir(f.directory)).find((name) =>
    name.startsWith("account-peak-"),
  )!;
  expect(
    JSON.parse((await fs.readFile(path.join(f.directory, filename), "utf8")).trim()).peakEquity,
  ).toBe(1100);
  await fs.writeFile(path.join(f.directory, filename), "{broken");
  const restart = createFinanceAlpacaCycleController(f.options);
  await expect(restart.accountBookProvider(AbortSignal.timeout(5000))).rejects.toThrow(
    "incomplete account peak",
  );
});

it("retains an unknown outcome and refuses another cycle without repeating the order", async () => {
  const f = await fixture();
  f.execute.mockRejectedValueOnce(new Error("connection lost after submit"));
  await expect(f.place("unknown")).rejects.toMatchObject({
    code: "finance_execution_safety_unknown",
  });
  const restart = createFinanceAlpacaCycleController(f.options);
  await expect(restart.accountBookProvider(AbortSignal.timeout(5000))).rejects.toThrow(
    "execution_recovery_incomplete",
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("allows a fresh controller cycle only after an explicitly retired Paper claim", async () => {
  const f = await fixture();
  f.execute.mockRejectedValueOnce(new Error("connection lost after submit"));
  await expect(f.place("unknown-before-retirement")).rejects.toMatchObject({
    code: "finance_execution_safety_unknown",
  });
  const before = await readFinanceExecutionSafetyClaims({
    stateDir: f.directory,
    accountId: f.accountId,
    venue: "alpaca:paper",
  });
  const unknown = before.at(-1)!;
  const raw = await fs.readFile(
    path.join(
      f.directory,
      `execution-safety-${createHash("sha256")
        .update(JSON.stringify(["alpaca:paper", f.accountId]))
        .digest("hex")}.jsonl`,
    ),
    "utf8",
  );
  await retireFinancePaperExecutionClaim({
    stateDir: f.directory,
    accountId: f.accountId,
    claimId: unknown.id,
    authorizationRef: "user-authorized-retirement-fixture",
    reason: "Fixture represents explicit operator authorization after broker observation.",
    brokerObservationRef: `sha256:${"b".repeat(64)}`,
    expectedJournalHash: createHash("sha256").update(raw).digest("hex"),
  });

  const restart = createFinanceAlpacaCycleController(f.options);
  await expect(restart.accountBookProvider(AbortSignal.timeout(5000))).resolves.toMatchObject({
    positions: [{ instrument: "SPY", quantity: 1 }],
  });
  expect((await f.place("fresh-after-retirement", restart)).status).toBe("placed");
  expect(f.execute).toHaveBeenCalledTimes(2);
  const after = await readFinanceExecutionSafetyClaims({
    stateDir: f.directory,
    accountId: f.accountId,
    venue: "alpaca:paper",
  });
  expect(after.at(0)).toMatchObject({ id: unknown.id, status: "operator_retired" });
  expect(after.at(0)?.fill).toBeUndefined();
  expect(after.at(0)?.receipt).toBeUndefined();
  expect(after.at(1)?.status).toBe("confirmed");
});

it("anchors snapshots to the latest rejected claim while verifying only confirmed fills", async () => {
  const f = await fixture();
  expect((await f.place("confirmed-before-rejection")).status).toBe("placed");
  f.execute.mockRejectedValueOnce(
    new FinanceExecutionSafetyDispatchError({
      executionStage: "venue_response",
      httpStatus: 422,
      brokerCode: 42210000,
    }),
  );
  await expect(f.place("rejected-order")).rejects.toMatchObject({ status: "rejected" });
  const claims = await readFinanceExecutionSafetyClaims({
    stateDir: f.directory,
    accountId: f.accountId,
    venue: "alpaca:paper",
  });
  expect(claims.at(-1)).toMatchObject({
    status: "rejected",
    failure: { phase: "execute", disposition: "definite_rejection" },
  });
  const restart = createFinanceAlpacaCycleController(f.options);
  await expect(restart.accountBookProvider(AbortSignal.timeout(5000))).resolves.toMatchObject({
    positions: [{ instrument: "SPY", quantity: 2 }],
  });
  expect((await f.place("after-rejection")).status).toBe("placed");
  expect(f.execute).toHaveBeenCalledTimes(3);
});

it.each([
  { status: "filled", quantity: "1", expectedReceipts: 1 },
  { status: "canceled", quantity: "0", expectedReceipts: 0 },
])(
  "reconciles a broker-terminal unknown $status claim without resubmitting",
  async ({ status, quantity, expectedReceipts }) => {
    const f = await fixture();
    f.execute.mockImplementationOnce(async (intent) => {
      const clientOrderId = `lcx-${createHash("sha256")
        .update(JSON.stringify(["paper", intent.runAuthorizationId, intent.intentId]))
        .digest("hex")
        .slice(0, 40)}`;
      const at = new Date().toISOString();
      f.orders.push({
        id: "broker-terminal",
        client_order_id: clientOrderId,
        symbol: intent.instrument,
        side: intent.side,
        qty: String(intent.quantity),
        type: intent.orderType,
        time_in_force: "day",
        status,
        filled_qty: quantity,
        filled_avg_price: quantity === "0" ? "0" : "100",
        filled_at: at,
        submitted_at: at,
        updated_at: at,
      });
      if (quantity !== "0") {
        f.positions[0].qty = String(Number(f.positions[0].qty) + Number(quantity));
        f.positions[0].market_value = String(Number(f.positions[0].qty) * 100);
        f.account.cash = String(Number(f.account.cash) - Number(quantity) * 100);
        f.account.long_market_value = String(Number(f.positions[0].market_value));
        f.activities.push({
          id: "broker-terminal",
          activity_type: "FILL",
          type: "fill",
          side: intent.side,
          symbol: intent.instrument,
          qty: quantity,
          price: "100",
          transaction_time: at,
        });
      }
      throw new Error("connection lost after broker accepted order");
    });
    await expect(f.place(`terminal-${status}`)).rejects.toMatchObject({
      code: "finance_execution_safety_unknown",
    });
    const executeCalls = f.execute.mock.calls.length;
    f.read.mockClear();

    const restart = createFinanceAlpacaCycleController(f.options);
    const inspection = await restart.inspectReconciliation(AbortSignal.timeout(5000));

    expect(inspection.readiness.status).toBe("ready");
    expect(
      f.read.mock.calls.some(([url]) => new URL(url).pathname === "/v2/orders:by_client_order_id"),
    ).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(executeCalls);
    const ledger = await readFinanceAccountPositionLedger(f.directory, {
      accountId: f.accountId,
      venue: "alpaca:paper",
    });
    expect(ledger.receipts).toHaveLength(expectedReceipts);
    if (expectedReceipts) {
      expect(ledger.ledger.positions[0].quantity).toBe(1);
    }
  },
);

it.each(["active", "missing", "wrong-identity"])(
  "keeps unknown execution blocked for %s broker order without resubmission",
  async (scenario) => {
    const f = await fixture();
    f.execute.mockImplementationOnce(async (intent) => {
      const clientOrderId = `lcx-${createHash("sha256")
        .update(JSON.stringify(["paper", intent.runAuthorizationId, intent.intentId]))
        .digest("hex")
        .slice(0, 40)}`;
      const at = new Date().toISOString();
      f.orders.push({
        id: "broker-original",
        client_order_id: clientOrderId,
        symbol: scenario === "wrong-identity" ? "MSFT" : intent.instrument,
        side: intent.side,
        qty: String(intent.quantity),
        type: intent.orderType,
        time_in_force: "day",
        status: scenario === "active" ? "new" : "filled",
        filled_qty: scenario === "active" ? "0" : String(intent.quantity),
        filled_avg_price: scenario === "active" ? "0" : "100",
        filled_at: at,
        submitted_at: at,
        updated_at: at,
      });
      if (scenario === "missing") {
        f.orders.splice(0);
      }
      throw new Error("connection lost after broker accepted order");
    });
    await expect(f.place(`blocked-${scenario}`)).rejects.toMatchObject({
      code: "finance_execution_safety_unknown",
    });
    const executeCalls = f.execute.mock.calls.length;
    f.read.mockClear();

    await expect(
      createFinanceAlpacaCycleController(f.options).inspectReconciliation(
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("execution_recovery_incomplete");

    expect(
      f.read.mock.calls.some(([url]) => new URL(url).pathname === "/v2/orders:by_client_order_id"),
    ).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(executeCalls);
    if (scenario === "missing") {
      const stored = await readFinanceBrokerReconciliation(f.directory, f.accountId);
      expect(stored.snapshot).toBeDefined();
      const observedAt = stored.snapshot?.observedAt;
      if (typeof observedAt !== "string") {
        throw new Error("broker snapshot observation time missing");
      }
      const ageMs = Date.now() - Date.parse(observedAt);
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThan(5000);
    }
  },
);

it("keeps a protected sell unknown pending until its original protection can be restored", async () => {
  const f = await fixture();
  f.openOrders.push({
    id: "original-protection",
    symbol: "SPY",
    side: "sell",
    type: "stop",
    time_in_force: "gtc",
    status: "new",
    qty: "1",
    filled_qty: "0",
    stop_price: "90",
  });
  const quote = await f.controller.executionQuoteProvider(
    { instrument: "SPY", side: "sell", assetClass: "us_equity" },
    AbortSignal.timeout(5000),
  );
  const intent: FinanceExecutionIntent = {
    intentId: "protected-unknown-sell",
    instrument: "SPY",
    side: "sell",
    quantity: 1,
    orderType: "market",
    referencePrice: quote.referencePrice,
    referencePriceAt: quote.referencePriceAt,
    runAuthorizationId: "test-run",
    rationale: "synthetic protected reduction",
  };
  const adapter: FinanceExecutionAdapter = {
    id: "alpaca-venue",
    venue: "alpaca:paper",
    kind: "venue",
    instruments: ["SPY"],
    orderTypes: ["market"],
    credentialsAuthority: "external",
    supportsProtectedReduction: true,
    execute: f.execute,
  };
  f.execute.mockRejectedValueOnce(new Error("connection lost after sell submit"));
  await expect(
    placeFinanceOrder({
      mode: "live_execution",
      committedInstrumentNotional: 0,
      ordersPlacedThisRun: 0,
      executionAdapterId: adapter.id,
      adapters: [adapter],
      intent,
      budget: {
        automation: "unattended",
        allowedInstruments: ["SPY"],
        maxOrderNotional: 200,
        maxInstrumentNotional: 500,
        maxOrdersPerRun: 3,
      },
      safetyContext: f.controller.createSafetyContext({
        intent,
        budget: {
          automation: "unattended",
          allowedInstruments: ["SPY"],
          maxOrderNotional: 200,
          maxInstrumentNotional: 500,
          maxOrdersPerRun: 3,
        },
        adapterId: adapter.id,
        venue: adapter.venue,
      }),
    }),
  ).rejects.toMatchObject({ code: "finance_execution_safety_unknown" });

  const claims = await readFinanceExecutionSafetyClaims({
    stateDir: f.directory,
    accountId: f.accountId,
    venue: "alpaca:paper",
  });
  expect(claims[0].status).toBe("unknown");
  expect(claims[0].binding?.protectiveOrders).toHaveLength(1);
  const executeCalls = f.execute.mock.calls.length;
  f.read.mockClear();

  await expect(
    createFinanceAlpacaCycleController(f.options).inspectReconciliation(AbortSignal.timeout(5000)),
  ).rejects.toThrow("execution_recovery_incomplete");

  expect(f.execute).toHaveBeenCalledTimes(executeCalls);
  expect(
    f.read.mock.calls.some(([url]) => new URL(url).pathname === "/v2/orders:by_client_order_id"),
  ).toBe(false);
});

it("uses persisted highs for the drawdown gate after a restart", async () => {
  const f = await fixture();
  f.account.equity = "1100";
  f.account.cash = "1000";
  f.activities.push({
    id: "high-deposit",
    activity_type: "JNLC",
    status: "executed",
    net_amount: "100",
    date: new Date().toISOString().slice(0, 10),
  });
  await f.controller.accountBookProvider(AbortSignal.timeout(5000));
  f.account.equity = "1000";
  f.account.cash = "900";
  f.activities.push({
    id: "high-withdrawal",
    activity_type: "CSW",
    status: "executed",
    net_amount: "-100",
    date: new Date().toISOString().slice(0, 10),
  });
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
  const inspection = await f.controller.inspectReconciliation(AbortSignal.timeout(5000));
  const stored = await readFinanceBrokerReconciliation(f.directory, f.policy.accountId);
  expect(stored.snapshot?.protection).toEqual(inspection.protection);
  expect(inspection.protection?.coverage).toEqual([
    {
      instrument: "SPY",
      positionQuantity: 1,
      recognizedStopQuantity: 1,
      uncoveredQuantity: 0,
      status: "covered",
    },
  ]);
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
  expect(inspection.protection?.coverage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ instrument: "BTC/USD", status: "no_recognized_stop" }),
    ]),
  );
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
    "broker_reconciliation_blocked",
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

it("prepares slow history before binding the 30-second execution quote", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T19:30:00.000Z"));
  const f = await fixture();
  const original = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (...args) => {
    if (new URL(args[0]).pathname === "/v2/account/activities") {
      vi.setSystemTime(Date.now() + 40_000);
    }
    return original(...args);
  });
  const controller = createFinanceAlpacaCycleController({ ...f.options, maxAgeMs: 30_000 });
  const quote = await controller.prepareExecutionQuote(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(120000),
  );
  const historyReads = f.read.mock.calls.filter(
    ([url]) => new URL(url).pathname === "/v2/account/activities",
  ).length;
  expect(Date.parse(quote.referencePriceAt)).toBe(Date.now());
  expect((await f.place("prepared-slow-history", controller, quote)).status).toBe("placed");
  expect(
    f.read.mock.calls.filter(([url]) => new URL(url).pathname === "/v2/account/activities"),
  ).toHaveLength(historyReads);
});

it("refuses an expired prepared quote without dispatch or a history retry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T19:30:00.000Z"));
  const f = await fixture();
  const controller = createFinanceAlpacaCycleController({ ...f.options, maxAgeMs: 30_000 });
  const quote = await controller.prepareExecutionQuote(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(120000),
  );
  vi.setSystemTime(Date.now() + 30_001);
  await expect(f.place("expired-prepared", controller, quote)).rejects.toThrow(
    "alpaca_safety_quote_expired",
  );
  expect(f.execute).not.toHaveBeenCalled();
});

it("refuses a changed execution journal after preparation even when quotes remain fresh", async () => {
  const f = await fixture();
  const quote = await f.controller.prepareExecutionQuote(
    { instrument: "SPY", side: "buy", assetClass: "us_equity" },
    AbortSignal.timeout(5000),
  );
  const file = path.join(
    f.directory,
    `execution-safety-${createHash("sha256")
      .update(JSON.stringify(["alpaca:paper", f.accountId]))
      .digest("hex")}.jsonl`,
  );
  await fs.appendFile(
    file,
    JSON.stringify({
      id: "new-terminal-claim",
      run: "other-run",
      instrument: "SPY",
      notional: 100,
      snapshotId: "other",
      at: new Date().toISOString(),
      status: "confirmed",
    }) + "\n",
  );
  await expect(f.place("changed-prepared", f.controller, quote)).rejects.toThrow(
    "broker_reconciliation_unavailable",
  );
  expect(f.execute).not.toHaveBeenCalled();
});

it("requires explicit crypto capability while preserving the default equities-only universe", async () => {
  const f = await fixture(true);
  expect(() =>
    createFinanceAlpacaCycleController({ ...f.options, instruments: ["BTC/USD"] }),
  ).toThrow("invalid or expired Alpaca daily controller configuration");
  const read: FinanceUncachedFetch = async (url, init) => {
    if (new URL(url).pathname === "/v1beta3/crypto/us/latest/quotes") {
      return {
        status: 200,
        body: JSON.stringify({
          quotes: { "BTC/USD": { bp: 80000, ap: 80001, t: new Date().toISOString() } },
        }),
      };
    }
    return f.read(url, init);
  };
  const controller = createFinanceAlpacaCycleController({
    ...f.options,
    instruments: ["BTC/USD"],
    allowCrypto: true,
    read,
  });
  await expect(
    controller.executionQuoteProvider(
      { instrument: "BTC/USD", assetClass: "crypto", side: "sell" },
      AbortSignal.timeout(5000),
    ),
  ).resolves.toMatchObject({ referencePrice: 80000, bidPrice: 80000, askPrice: 80001 });
  await expect(
    controller.executionQuoteProvider(
      { instrument: "BTC/USD", assetClass: "us_equity", side: "sell" },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow("daily controller asset class outside explicit capability");
});

it("runs the controller ownership guard inside the shared safety facts path before dispatch", async () => {
  const f = await fixture(true);
  const validateFacts = vi.fn(async () => {
    const locks = await fs.readdir(f.directory);
    expect(
      locks.some((name) => name.startsWith("execution-safety-") && name.endsWith(".jsonl.lock")),
    ).toBe(true);
    throw new Error("ownership changed before dispatch");
  });
  const controller = createFinanceAlpacaCycleController({ ...f.options, validateFacts });
  await expect(f.place("ownership-guard", controller)).rejects.toThrow(
    "execution_safety_facts_unavailable",
  );
  expect(validateFacts).toHaveBeenCalledOnce();
  expect(f.execute).not.toHaveBeenCalled();
});
