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
});
