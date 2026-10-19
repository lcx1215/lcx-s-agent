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
import { FinanceHttpBodyAbortError } from "./finance-http-body.js";
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
  "preserves successful %s response handling",
  async (method) => {
    http.mockResolvedValue(new Response('{"id":"fixture-order"}', { status: 200 }));
    await expect(
      createFinanceWriteTransport()({
        url: "https://paper-api.alpaca.markets/v2/orders",
        headers: {},
        body: "{}",
        method,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: 200, body: '{"id":"fixture-order"}' });
  },
);

it.each(["POST", "DELETE"] as const)(
  "releases the %s body after confirmed cancellation",
  async (method) => {
    for (const rejectCancel of [false, true]) {
      const cancel = vi.fn(() =>
        rejectCancel ? Promise.reject(new Error("stream already errored")) : Promise.resolve(),
      );
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
      const check = expect(pending).rejects.toMatchObject({ cleanupStatus: "confirmed" });
      await Promise.resolve();
      caller.abort();
      await check;
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    }
  },
);

it.each(["POST", "DELETE"] as const)(
  "bounds %s body cancellation even when the stream never settles",
  async (method) => {
    vi.useFakeTimers();
    for (const oversized of [false, true]) {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: oversized ? { "content-length": "3145728" } : {},
      });
      http.mockResolvedValue(response);
      const caller = new AbortController();
      let outcome: unknown;
      void createFinanceWriteTransport()({
        url: "https://paper-api.alpaca.markets/v2/orders",
        headers: {},
        body: "{}",
        method,
        signal: caller.signal,
      }).then(
        (value) => {
          outcome = value;
        },
        (error) => {
          outcome = error;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      caller.abort();
      await vi.advanceTimersByTimeAsync(1700);
      expect(outcome).toBeInstanceOf(FinanceHttpBodyAbortError);
      expect(outcome).toMatchObject({ cleanupStatus: "unconfirmed" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
      expect(http.mock.lastCall?.[1]).toMatchObject({ method, signal: caller.signal });
      expect(http.mock.lastCall?.[1].body).toBe(method === "DELETE" ? undefined : "{}");
    }
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
