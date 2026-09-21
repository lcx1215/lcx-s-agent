import { expect, it, vi } from "vitest";
import {
  readAlpacaPaperSafetyFacts,
  type AlpacaSafetyProviderOptions,
} from "./finance-alpaca-safety-provider.js";
function fixture(crypto = false) {
  const at = new Date().toISOString();
  const instrument = crypto ? "BTC/USD" : "SPY";
  const account = {
    id: "paper-account",
    status: "ACTIVE",
    trading_blocked: false,
    account_blocked: false,
    trade_suspended_by_user: false,
    currency: "USD",
    equity: "1000",
    cash: "900",
    long_market_value: "100",
    short_market_value: "0",
    buying_power: "4000",
  };
  const positions = [
    {
      symbol: crypto ? "BTCUSD" : "SPY",
      side: "long",
      qty: "1",
      market_value: "100",
      asset_class: crypto ? "crypto" : "us_equity",
    },
  ];
  const orders: unknown[] = [];
  const quote = { bp: 99, ap: 100, t: at };
  const read = vi.fn<AlpacaSafetyProviderOptions["read"]>(async (url) => {
    const body = url.includes("/account")
      ? account
      : url.includes("/positions")
        ? positions
        : url.includes("/orders?")
          ? orders
          : url.includes("/assets/")
            ? {
                symbol: instrument,
                class: crypto ? "crypto" : "us_equity",
                status: "active",
                tradable: true,
                marginable: true,
              }
            : crypto
              ? { quotes: { [instrument]: quote } }
              : { quote };
    return { status: 200, body: JSON.stringify(body) };
  });
  const options: AlpacaSafetyProviderOptions = {
    accountId: "paper-account",
    instrument,
    credentials: { keyId: "FAKE", secret: "FAKE" },
    evidence: {
      accountId: "paper-account",
      currency: "USD",
      source: "controller-ledger",
      observedAt: at,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      peakEquity: 1100,
      peakScope: "authorized-session",
      unhedged: true,
      unresolvedOrderIds: [],
    },
    read,
    timeoutMs: 1000,
    maxAgeMs: 60000,
  };
  return { options, account, positions, orders, quote, read };
}
it.each([false, true])(
  "reads real numeric facts for spot crypto=%s without treating margin capability as borrowing",
  async (crypto) => {
    const f = fixture(crypto);
    const result = await readAlpacaPaperSafetyFacts(f.options);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.facts.account.availableCash).toBe(900);
    expect(result.facts.account.peakEquity).toBe(1100);
    expect(result.facts.positionQuantity).toBe(1);
    expect(result.facts.instrumentEvidence.marginEnabled).toBe(false);
    expect(result.facts.quote.observedAt).toBe(f.quote.t);
    expect(result.facts.reconciledThroughClaimId).toBeUndefined();
    expect(
      f.read.mock.calls.every(([url]) =>
        ["paper-api.alpaca.markets", "data.alpaca.markets"].includes(new URL(url).hostname),
      ),
    ).toBe(true);
  },
);
it.each([
  "null-cash",
  "blocked-type",
  "borrowed",
  "short",
  "unknown-asset",
  "bad-position",
  "pending",
  "future-quote",
  "old-quote",
  "currency",
  "missing-peak",
  "unknown-order",
])("refuses %s", async (kind) => {
  const f = fixture();
  if (kind === "null-cash") {
    Object.assign(f.account, { cash: null });
  }
  if (kind === "blocked-type") {
    Object.assign(f.account, { trading_blocked: "false" });
  }
  if (kind === "borrowed") {
    f.account.cash = "-1";
  }
  if (kind === "short") {
    f.positions[0].side = "short";
  }
  if (kind === "unknown-asset") {
    f.positions[0].asset_class = "option";
  }
  if (kind === "bad-position") {
    Object.assign(f.positions[0], { qty: null });
  }
  if (kind === "pending") {
    f.orders.push({ id: "pending" });
  }
  if (kind === "future-quote") {
    f.quote.t = new Date(Date.now() + 100000).toISOString();
  }
  if (kind === "old-quote") {
    f.quote.t = "2020-01-01T00:00:00Z";
  }
  if (kind === "currency") {
    f.account.currency = "EUR";
  }
  const evidence = {
    ...f.options.evidence,
    ...(kind === "missing-peak" ? { peakEquity: NaN } : {}),
    ...(kind === "unknown-order" ? { unresolvedOrderIds: ["unknown"] } : {}),
  };
  expect((await readAlpacaPaperSafetyFacts({ ...f.options, evidence })).ok).toBe(false);
});
it("reuses only bound quote and re-reads account facts, never claiming reconciliation", async () => {
  const f = fixture();
  const first = await readAlpacaPaperSafetyFacts(f.options);
  if (!first.ok) {
    throw new Error("fixture");
  }
  f.quote.ap = 101;
  const second = await readAlpacaPaperSafetyFacts({ ...f.options, boundQuote: first.boundQuote });
  expect(second.ok).toBe(true);
  if (second.ok) {
    expect(second.facts.quote.price).toBe(100);
  }
  expect(f.read.mock.calls.filter(([u]) => u.includes("/account"))).toHaveLength(2);
  expect(f.read.mock.calls.filter(([u]) => u.includes("quotes"))).toHaveLength(1);
  f.orders.push({ id: "new-order" });
  expect(
    (await readAlpacaPaperSafetyFacts({ ...f.options, boundQuote: first.boundQuote })).ok,
  ).toBe(false);
  expect(
    (
      await readAlpacaPaperSafetyFacts({
        ...f.options,
        boundQuote: { kind: "alpaca_safety_quote" },
      })
    ).ok,
  ).toBe(false);
});
it("bounds uncooperative transport without logging response or credentials", async () => {
  const f = fixture();
  const read = vi.fn<AlpacaSafetyProviderOptions["read"]>(() => new Promise(() => {}));
  const result = await readAlpacaPaperSafetyFacts({ ...f.options, read, timeoutMs: 10 });
  expect(result).toEqual({ ok: false, reason: "alpaca_safety_cancelled_or_timed_out" });
  expect(read.mock.calls[0][1].signal?.aborted).toBe(true);
});
it("honors cancellation before any request", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  expect((await readAlpacaPaperSafetyFacts(f.options, controller.signal)).ok).toBe(false);
  expect(f.read).not.toHaveBeenCalled();
});
it("sanitizes transport and malformed response failures", async () => {
  const f = fixture();
  f.read.mockResolvedValue({ status: 200, body: "secret malformed" });
  expect(JSON.stringify(await readAlpacaPaperSafetyFacts(f.options))).not.toContain("secret");
  f.read.mockRejectedValue(new Error("credential FAKE"));
  expect(JSON.stringify(await readAlpacaPaperSafetyFacts(f.options))).not.toContain("FAKE");
});
