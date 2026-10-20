import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const http = vi.hoisted(() => vi.fn());
vi.mock("undici", () => {
  class Agent {
    close() {
      return Promise.resolve();
    }
  }
  return { fetch: http, Agent, EnvHttpProxyAgent: Agent };
});
import { createFinanceAlpacaCycleController } from "./finance-alpaca-cycle-controller.js";
import { createAlpacaExecutionAdapter } from "./finance-alpaca-execution-adapter.js";
import { financeReadFailureDiagnostic } from "./finance-alpaca-safety-transport.js";
import type { FinanceExecutionIntent } from "./finance-execution-adapter.js";
import {
  createFinanceUncachedFetch,
  createFinanceWriteTransport,
} from "./finance-write-transport.js";

afterEach(() => {
  http.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each(["POST", "DELETE"] as const)(
  "bounds %s response cleanup after the caller cancels an uncertain write",
  async (method) => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    http.mockResolvedValue(response);
    const caller = new AbortController();
    const pending = createFinanceWriteTransport()({
      url: "https://paper-api.alpaca.markets/v2/orders",
      headers: {},
      body: "{}",
      method,
      signal: caller.signal,
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(true);
    await expect(pending).rejects.toMatchObject({ cleanupStatus: "unconfirmed" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(http).toHaveBeenCalledOnce();
    expect(http.mock.calls[0][1]).toMatchObject({ method, signal: caller.signal });
  },
);

it.each(["confirmed", "unconfirmed"] as const)(
  "cancels the resident uncached GET body: %s",
  async (cleanupStatus) => {
    vi.useFakeTimers();
    const cancel = vi.fn(() =>
      cleanupStatus === "confirmed" ? Promise.resolve() : new Promise<void>(() => {}),
    );
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    http.mockResolvedValue(response);
    const caller = new AbortController();
    const pending = createFinanceUncachedFetch()("https://paper-api.alpaca.markets/v2/account", {
      headers: {},
      signal: caller.signal,
    });
    const check = expect(pending).rejects.toMatchObject({ cleanupStatus });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(1500);
    await check;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(http).toHaveBeenCalledOnce();
    expect(http.mock.calls[0][1]).toMatchObject({ method: "GET", signal: caller.signal });
  },
);

it("propagates cancellation cleanup through the original controller account reader", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "account-body-cancel-"));
  try {
    vi.stubEnv("ALPACA_API_KEY_ID", "PK_SYNTHETIC");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "SYNTHETIC");
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    http.mockImplementation(async () => {
      arrived();
      return response;
    });
    const controller = createFinanceAlpacaCycleController({
      directory,
      instruments: ["SPY"],
      feed: "iex",
      maxAgeMs: 60000,
      policy: {
        schemaVersion: "lcx_alpaca_cycle_policy_v1",
        accountId: "paper-account",
        planId: "fixture",
        revision: "1",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        peakEquity: 1000,
        peakScope: "fixture",
        unhedged: true,
        maxPortfolioDrawdownFraction: 0.2,
        maxGrossExposure: 1000,
      },
    });
    const caller = new AbortController();
    const pending = controller.accountBookProvider(caller.signal);
    const check = expect(pending).rejects.toMatchObject({
      diagnostic: { stage: "broker_reconciliation", cleanupStatus: "confirmed" },
    });
    await reached;
    caller.abort();
    await check;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(http).toHaveBeenCalledOnce();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("preserves bounded endpoint/cause/phase through resident reconciliation without leaking raw details or retrying", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-read-cause-"));
  try {
    vi.stubEnv("ALPACA_API_KEY_ID", "PK_SYNTHETIC");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "SYNTHETIC");
    http.mockRejectedValue(
      new Error("headers=SECRET https://secret.invalid/raw", {
        cause: Object.assign(new Error("private body"), { code: "ECONNRESET" }),
      }),
    );
    const controller = createFinanceAlpacaCycleController({
      directory: root,
      instruments: ["SPY"],
      feed: "iex",
      maxAgeMs: 60000,
      policy: {
        schemaVersion: "lcx_alpaca_cycle_policy_v1",
        accountId: "paper-account",
        planId: "fixture",
        revision: "1",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        peakEquity: 1000,
        peakScope: "fixture",
        unhedged: true,
        maxPortfolioDrawdownFraction: 0.2,
        maxGrossExposure: 1000,
      },
    });
    let failure: unknown;
    try {
      await controller.inspectReconciliation(AbortSignal.timeout(5000));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      diagnostic: {
        stage: "broker_reconciliation",
        code: "ECONNRESET",
        request: {
          endpoint: "account",
          phase: "request",
          code: "ECONNRESET",
          elapsedMs: expect.any(Number),
        },
      },
    });
    const diagnostic = JSON.stringify((failure as { diagnostic: unknown }).diagnostic);
    expect(diagnostic).not.toMatch(/SECRET|secret.invalid|private body/);
    expect(http).toHaveBeenCalledOnce();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const writeIntent: FinanceExecutionIntent = {
  intentId: "body-cancellation",
  instrument: "AAPL",
  side: "buy",
  orderType: "market",
  quantity: 1,
  referencePrice: 100,
  referencePriceAt: "2026-10-20T00:00:00Z",
  runAuthorizationId: "fixture-authorization",
  rationale: "fixture",
};

it.each([
  ["POST", "confirmed"],
  ["POST", "unconfirmed"],
  ["DELETE", "confirmed"],
  ["DELETE", "unconfirmed"],
] as const)("joins original adapter %s body cleanup: %s", async (method, cleanupStatus) => {
  vi.useFakeTimers();
  vi.stubEnv("ALPACA_API_KEY_ID", "PK_SYNTHETIC");
  vi.stubEnv("ALPACA_API_SECRET_KEY", "SYNTHETIC");
  const cancel = vi.fn(() =>
    cleanupStatus === "confirmed"
      ? new Promise<void>((resolve) => setTimeout(resolve, 200))
      : new Promise<void>(() => {}),
  );
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
  http.mockResolvedValue(response);
  const write = createFinanceWriteTransport();
  const postJson = vi.fn(
    (url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) =>
      write({ url, ...init }),
  );
  const statusFetch = vi.fn(async (url: string) => ({
    status: 200,
    body: JSON.stringify(
      url.endsWith("/account")
        ? { id: "account" }
        : {
            id: "old-stop",
            symbol: "AAPL",
            qty: "2",
            filled_qty: "0",
            stop_price: "90",
            type: "stop",
            side: "sell",
            time_in_force: "gtc",
            status: "new",
          },
    ),
  }));
  const adapter = createAlpacaExecutionAdapter({
    instruments: ["AAPL"],
    postJson,
    statusFetch,
    cancelOrder: (url, init) => write({ url, ...init, body: "", method: "DELETE" }),
  });
  const caller = new AbortController();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const pending = adapter.execute(
    { ...writeIntent, side: method === "DELETE" ? "sell" : "buy" },
    caller.signal,
    method === "DELETE"
      ? {
          accountId: "account",
          adapterId: "alpaca-venue",
          venue: "alpaca:paper",
          instrument: "AAPL",
          snapshotId: "fixture",
          source: "fixture",
          observedAt: now,
          expiresAt,
          positionQuantity: 2,
          reservedSellQuantity: 2,
          protectiveOrders: [{ id: "old-stop", quantity: 2, stopPrice: 90, orderType: "stop" }],
          openOrderIds: [],
          unresolvedOrderIds: [],
          instrumentEvidence: {
            source: "fixture",
            observedAt: now,
            assetType: "spot_equity",
            fullyPaid: true,
            marginEnabled: false,
            hedged: false,
          },
          account: {
            status: "ACTIVE",
            tradingBlocked: false,
            equity: 1000,
            availableCash: 800,
            peakEquity: 1000,
            currency: "USD",
            grossExposure: 200,
          },
          quote: { source: "fixture", price: 100, observedAt: now, expiresAt, currency: "USD" },
        }
      : undefined,
  );
  let settled = false;
  const failure = pending.then(
    () => {
      throw new Error("unexpected fill");
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(http).toHaveBeenCalledOnce();
  caller.abort();
  await vi.advanceTimersByTimeAsync(199);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(cleanupStatus === "confirmed" ? 1 : 1301);
  expect(settled).toBe(true);
  const error = await failure;
  expect(financeReadFailureDiagnostic(error)).toMatchObject({ cleanupStatus });
  if (method === "POST") {
    expect(error).toMatchObject({ code: "alpaca_order_uncertain" });
    expect(postJson).toHaveBeenCalledOnce();
    expect(statusFetch).not.toHaveBeenCalled();
  } else {
    expect(error).toMatchObject({
      diagnostic: {
        stage: "cancel_protection",
        cancellationConfirmed: false,
        sellExecutionEntered: false,
        readFailure: { cleanupStatus },
        cancelled: true,
      },
    });
    expect(postJson).not.toHaveBeenCalled();
    expect(statusFetch).toHaveBeenCalledTimes(2);
  }
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
  expect(http).toHaveBeenCalledOnce();
});
