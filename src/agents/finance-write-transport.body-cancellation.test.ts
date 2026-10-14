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
import { createFinanceUncachedFetch } from "./finance-write-transport.js";

afterEach(() => {
  http.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

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
