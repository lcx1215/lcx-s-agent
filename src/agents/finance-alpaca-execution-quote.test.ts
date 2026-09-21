import { describe, expect, it, vi } from "vitest";
import { createAlpacaExecutionQuoteProvider } from "./finance-alpaca-execution-quote.js";
const credentials = { apiKeyId: "synthetic-key", apiSecretKey: "synthetic-secret" };
const quote = { bp: 100, ap: 101, t: "2026-09-22T10:00:00.123456789Z" };
function fixture(change: Record<string, unknown> = {}) {
  const read = vi.fn(async () => ({
    status: 200,
    body: JSON.stringify({ quotes: { AAPL: { ...quote, ...change } } }),
  }));
  return {
    read,
    provider: createAlpacaExecutionQuoteProvider({
      credentials,
      read,
      feed: "iex",
      maxAgeMs: 2000,
    }),
  };
}
describe("strict Alpaca execution reference source", () => {
  it.each(["buy", "sell"] as const)(
    "preserves native bid/ask/time and uses %s side",
    async (side) => {
      const { read, provider } = fixture();
      const signal = new AbortController().signal;
      const result = await provider({ instrument: "AAPL", assetClass: "us_equity", side }, signal);
      expect(result).toMatchObject({
        bidPrice: 100,
        askPrice: 101,
        referencePrice: side === "buy" ? 101 : 100,
        referencePriceAt: quote.t,
        feed: "iex",
        maxAgeMs: 2000,
      });
      expect(read).toHaveBeenCalledWith(
        expect.stringContaining("feed=iex"),
        expect.objectContaining({ signal }),
      );
      await provider({ instrument: "AAPL", assetClass: "us_equity", side }, signal);
      expect(read).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    { t: undefined },
    { t: "invalid" },
    { bp: undefined },
    { ap: undefined },
    { bp: 102 },
    { bp: 0 },
    { ap: "101" },
  ])("rejects missing/malformed native evidence %j", async (change) => {
    await expect(
      fixture(change).provider(
        { instrument: "AAPL", assetClass: "us_equity", side: "buy" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("native timestamp");
  });
  it.each(["BTC/USD", "BTCUSD", "BTCUSDT"])(
    "does not send crypto symbol %s to stock endpoint",
    async (instrument) => {
      const { provider, read } = fixture();
      await expect(
        provider(
          { instrument, assetClass: "us_equity", side: "buy" },
          new AbortController().signal,
        ),
      ).rejects.toThrow("crypto quote capability unavailable");
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("returns on cancellation even if an injected read has not settled", async () => {
    const read = vi.fn(() => new Promise<{ status: number; body: string }>(() => {}));
    const provider = createAlpacaExecutionQuoteProvider({
      credentials,
      read,
      feed: "sip",
      maxAgeMs: 1000,
    });
    const controller = new AbortController();
    const result = provider(
      { instrument: "AAPL", assetClass: "us_equity", side: "buy" },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch an aborted request", async () => {
    const { provider, read } = fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      provider({ instrument: "AAPL", assetClass: "us_equity", side: "buy" }, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(read).not.toHaveBeenCalled();
  });
});
