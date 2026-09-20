import { afterEach, describe, expect, it, vi } from "vitest";
import { createAlpacaExecutionAdapter } from "./finance-alpaca-execution-adapter.js";
import type { FinanceExecutionIntent } from "./finance-execution-adapter.js";

const PAPER = "PKTESTKEYID0000000000";
const LIVE = "AKTESTKEYID0000000000";
const SECRET = "secretsecretsecretsecretsecret00";

const baseIntent: FinanceExecutionIntent = {
  intentId: "intent-1",
  instrument: "AAPL",
  side: "buy",
  orderType: "market",
  quantity: 1,
  referencePrice: 100,
  referencePriceAt: "2026-09-20T00:00:00.000Z",
  runAuthorizationId: "auth-1",
  rationale: "adapter test",
};

function transport(body: unknown, status = 200) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return { status, body: JSON.stringify(body) };
  };
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubCredentials(keyId: string) {
  vi.stubEnv("ALPACA_API_KEY_ID", keyId);
  vi.stubEnv("ALPACA_API_SECRET_KEY", SECRET);
}

describe("createAlpacaExecutionAdapter", () => {
  it("defaults to the paper host", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-1", status: "new", filled_qty: "0" });
    const adapter = createAlpacaExecutionAdapter({ instruments: ["AAPL"], postJson: t.fn });
    expect(adapter.venue).toBe("alpaca:paper");
    expect(adapter.kind).toBe("venue");
    await adapter.execute(baseIntent, new AbortController().signal);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toContain("paper-api.alpaca.markets");
  });

  it("refuses a live order when the key is a paper key, without calling the venue", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-1" });
    const adapter = createAlpacaExecutionAdapter({
      instruments: ["AAPL"],
      mode: "live",
      postJson: t.fn,
    });
    await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toThrow(
      /paper key/,
    );
    expect(t.calls).toHaveLength(0);
  });

  it("refuses a paper order when the key is a live key", async () => {
    stubCredentials(LIVE);
    const t = transport({ id: "ord-1" });
    const adapter = createAlpacaExecutionAdapter({ instruments: ["AAPL"], postJson: t.fn });
    await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toThrow(
      /live key/,
    );
    expect(t.calls).toHaveLength(0);
  });

  it("uses the live host when explicitly asked with a live key", async () => {
    stubCredentials(LIVE);
    const t = transport({ id: "ord-2", filled_qty: "1", filled_avg_price: "100.5" });
    const adapter = createAlpacaExecutionAdapter({
      instruments: ["AAPL"],
      mode: "live",
      postJson: t.fn,
    });
    const fill = await adapter.execute(baseIntent, new AbortController().signal);
    expect(t.calls[0]).toContain("https://api.alpaca.markets");
    expect(fill.filledQuantity).toBe(1);
    expect(fill.fillPrice).toBe(100.5);
    expect(fill.venueRef).toContain("alpaca:live:ord-2");
  });

  it("reports zero filled instead of inventing a fill for an unfilled order", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-3", status: "accepted" });
    const adapter = createAlpacaExecutionAdapter({ instruments: ["AAPL"], postJson: t.fn });
    const fill = await adapter.execute(baseIntent, new AbortController().signal);
    expect(fill.filledQuantity).toBe(0);
    expect(fill.fillPrice).toBe(0);
    expect(fill.venueRef).toContain("alpaca:paper:ord-3");
  });

  it("refuses an instrument it was not declared for", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-4" });
    const adapter = createAlpacaExecutionAdapter({ instruments: ["AAPL"], postJson: t.fn });
    await expect(
      adapter.execute({ ...baseIntent, instrument: "MSFT" }, new AbortController().signal),
    ).rejects.toThrow(/not declared for instrument MSFT/);
    expect(t.calls).toHaveLength(0);
  });

  it("refuses a limit order without a limit price", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-5" });
    const adapter = createAlpacaExecutionAdapter({ instruments: ["AAPL"], postJson: t.fn });
    await expect(
      adapter.execute(
        { ...baseIntent, orderType: "limit", limitPrice: undefined },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/limit order requires limitPrice/);
    expect(t.calls).toHaveLength(0);
  });

  it("refuses to place an order without a write transport", async () => {
    stubCredentials(PAPER);
    const adapter = createAlpacaExecutionAdapter({ instruments: ["AAPL"] });
    await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toThrow(
      /requires a postJson transport/,
    );
  });

  it("reports the real fill when the order fills asynchronously", async () => {
    stubCredentials(PAPER);
    // Submit says filled_qty 0 (the observed behaviour); the fill appears later.
    const t = transport({ id: "ord-9", status: "accepted", filled_qty: "0" });
    let polls = 0;
    const statusFetch = async () => {
      polls += 1;
      return {
        status: 200,
        body: JSON.stringify(
          polls < 2
            ? { id: "ord-9", status: "new", filled_qty: "0" }
            : { id: "ord-9", status: "filled", filled_qty: "1", filled_avg_price: "101.25" },
        ),
      };
    };
    const adapter = createAlpacaExecutionAdapter({
      instruments: ["AAPL"],
      postJson: t.fn,
      statusFetch,
      fillPoll: { timeoutMs: 3000, intervalMs: 10 },
    });
    const fill = await adapter.execute(baseIntent, new AbortController().signal);
    expect(fill.filledQuantity).toBe(1);
    expect(fill.fillPrice).toBe(101.25);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("refuses to report a fill when the state is still unknown at the deadline", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-10", status: "new", filled_qty: "0" });
    const statusFetch = async () => ({
      status: 200,
      body: JSON.stringify({ id: "ord-10", status: "new", filled_qty: "0" }),
    });
    const adapter = createAlpacaExecutionAdapter({
      instruments: ["AAPL"],
      postJson: t.fn,
      statusFetch,
      fillPoll: { timeoutMs: 60, intervalMs: 10 },
    });
    // The order id must survive the error: the caller needs it to reconcile.
    await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toThrow(
      /ord-10.*refusing to report a fill/,
    );
  });

  it("reports zero for an order that reaches a terminal unfilled state", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-11", status: "new", filled_qty: "0" });
    const statusFetch = async () => ({
      status: 200,
      body: JSON.stringify({ id: "ord-11", status: "expired", filled_qty: "0" }),
    });
    const adapter = createAlpacaExecutionAdapter({
      instruments: ["AAPL"],
      postJson: t.fn,
      statusFetch,
      fillPoll: { timeoutMs: 3000, intervalMs: 10 },
    });
    const fill = await adapter.execute(baseIntent, new AbortController().signal);
    expect(fill.filledQuantity).toBe(0);
    expect(fill.fillPrice).toBe(0);
  });
});
