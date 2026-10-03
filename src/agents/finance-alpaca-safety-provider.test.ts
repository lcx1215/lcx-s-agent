import { expect, it, vi } from "vitest";
import {
  readAlpacaPaperSafetyQuote,
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
    side: "buy",
    stockFeed: "iex",
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
it("accepts bounded cross-snapshot valuation drift and budgets against the higher gross", async () => {
  const f = fixture();
  f.account.cash = "199.73";
  f.account.long_market_value = "800.27";
  f.positions.splice(
    0,
    1,
    {
      symbol: "BTCUSD",
      side: "long",
      qty: "0.000399",
      market_value: "33.3555",
      asset_class: "crypto",
    },
    {
      symbol: "SPY",
      side: "long",
      qty: "1",
      market_value: "766.89",
      asset_class: "us_equity",
    },
  );
  const result = await readAlpacaPaperSafetyFacts(f.options);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.facts.account.grossExposure).toBe(800.27);
  }
});
it("accepts the observed bounded skew only after a stable second account-position pair", async () => {
  const f = fixture();
  f.account.equity = "10000";
  f.account.cash = "340";
  f.account.long_market_value = "9660";
  f.options = {
    ...f.options,
    evidence: { ...f.options.evidence, peakEquity: 10000 },
  };
  f.positions.splice(
    0,
    1,
    {
      symbol: "BTCUSD",
      side: "long",
      qty: "0.000399",
      market_value: "33.3555",
      asset_class: "crypto",
    },
    {
      symbol: "SPY",
      side: "long",
      qty: "1",
      market_value: "9626.0986",
      asset_class: "us_equity",
    },
  );

  const result = await readAlpacaPaperSafetyFacts(f.options);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.facts.account.grossExposure).toBe(9660);
    expect(f.read.mock.calls.filter(([url]) => url.includes("/account"))).toHaveLength(2);
    expect(f.read.mock.calls.filter(([url]) => url.includes("/positions"))).toHaveLength(2);
  }
});
it("retries one valuation-only skew and keeps the maximum sampled gross", async () => {
  const f = fixture();
  f.orders.push({
    id: "latest-protective-stop",
    symbol: "SPY",
    qty: "1",
    filled_qty: "0",
    stop_price: "90",
    type: "stop",
    side: "sell",
    status: "new",
    time_in_force: "gtc",
  });
  const firstAccount = { ...f.account, cash: "199.7", long_market_value: "800.3" };
  const secondAccount = { ...f.account, cash: "199.75", long_market_value: "800.25" };
  const firstPositions = [
    {
      symbol: "BTCUSD",
      side: "long",
      qty: "0.000399",
      market_value: "33.3555",
      asset_class: "crypto",
    },
    {
      symbol: "SPY",
      side: "long",
      qty: "1",
      market_value: "766.89",
      asset_class: "us_equity",
    },
  ];
  const secondPositions = [firstPositions[0], { ...firstPositions[1], market_value: "766.8945" }];
  let accountReads = 0;
  let positionReads = 0;
  let orderReads = 0;
  f.read.mockImplementation(async (url) => {
    const body = url.includes("/account")
      ? [firstAccount, secondAccount][Math.min(accountReads++, 1)]
      : url.includes("/positions")
        ? [firstPositions, secondPositions][Math.min(positionReads++, 1)]
        : url.includes("/orders?")
          ? (() => {
              expect(accountReads).toBe(2);
              expect(positionReads).toBe(2);
              orderReads += 1;
              return f.orders;
            })()
          : url.includes("/assets/")
            ? {
                symbol: "SPY",
                class: "us_equity",
                status: "active",
                tradable: true,
                marginable: true,
              }
            : { quote: f.quote };
    return { status: 200, body: JSON.stringify(body) };
  });

  const result = await readAlpacaPaperSafetyFacts(f.options);
  expect(result.ok).toBe(true);
  expect(accountReads).toBe(2);
  expect(positionReads).toBe(2);
  expect(orderReads).toBe(1);
  if (result.ok) {
    expect(result.facts.account.grossExposure).toBe(800.3);
    expect(result.facts.reservedSellQuantity).toBe(1);
    expect(
      result.positions.reduce((total, position) => total + position.marketValue, 0),
    ).toBeCloseTo(800.25, 8);
  }
});
it("refuses account valuation drift above the bounded tolerance", async () => {
  const f = fixture();
  f.options = { ...f.options, diagnostics: true };
  f.account.cash = "199.70";
  f.account.long_market_value = "800.30";
  f.positions.splice(
    0,
    1,
    {
      symbol: "BTCUSD",
      side: "long",
      qty: "0.000399",
      market_value: "33.3555",
      asset_class: "crypto",
    },
    {
      symbol: "SPY",
      side: "long",
      qty: "1",
      market_value: "766.89",
      asset_class: "us_equity",
    },
  );
  expect(await readAlpacaPaperSafetyFacts(f.options)).toEqual({
    ok: false,
    reason: "alpaca_safety_facts_inconsistent",
    diagnostic: "account_arithmetic",
    accountArithmetic: {
      failedConditions: ["gross_valuation_drift"],
      values: {
        equity: 1000,
        cash: 199.7,
        shortMarketValue: 0,
        positionGross: 800.2455,
        longMarketValue: 800.3,
        accountGross: 800.3,
        grossDrift: expect.closeTo(0.0545, 8),
        grossDriftTolerance: expect.closeTo(0.048018, 8),
        cashEquityResidual: 0,
        cashEquityTolerance: 0.01,
        controllerPeakEquity: 1100,
      },
      trackNewHigh: false,
    },
  });
  expect(f.read.mock.calls.filter(([url]) => url.includes("/account"))).toHaveLength(2);
  expect(f.read.mock.calls.filter(([url]) => url.includes("/positions"))).toHaveLength(2);
});
it("refuses persistent soft-bounded skew when position quantity changes", async () => {
  const f = fixture();
  f.account.cash = "199.7";
  f.account.long_market_value = "800.3";
  const firstPositions = [
    {
      symbol: "BTCUSD",
      side: "long",
      qty: "0.000399",
      market_value: "33.3555",
      asset_class: "crypto",
    },
    {
      symbol: "SPY",
      side: "long",
      qty: "1",
      market_value: "766.8995",
      asset_class: "us_equity",
    },
  ];
  const changedPositions = [firstPositions[0], { ...firstPositions[1], qty: "1.001" }];
  let positionReads = 0;
  f.read.mockImplementation(async (url) => {
    const body = url.includes("/account")
      ? f.account
      : url.includes("/positions")
        ? [firstPositions, changedPositions][Math.min(positionReads++, 1)]
        : url.includes("/orders?")
          ? f.orders
          : url.includes("/assets/")
            ? {
                symbol: "SPY",
                class: "us_equity",
                status: "active",
                tradable: true,
                marginable: true,
              }
            : { quote: f.quote };
    return { status: 200, body: JSON.stringify(body) };
  });

  const result = await readAlpacaPaperSafetyFacts({ ...f.options, diagnostics: true });
  expect(result).toMatchObject({
    ok: false,
    reason: "alpaca_safety_facts_inconsistent",
    diagnostic: "account_arithmetic",
    accountArithmetic: {
      failedConditions: ["gross_valuation_drift"],
      values: { grossDriftTolerance: expect.closeTo(0.040015, 8) },
    },
  });
  expect(positionReads).toBe(2);
});
it("keeps the absolute gross-drift ceiling at sixty cents", async () => {
  const f = fixture();
  f.account.equity = "30000";
  f.account.cash = "10000";
  f.account.long_market_value = "20000";
  f.options = {
    ...f.options,
    diagnostics: true,
    evidence: { ...f.options.evidence, peakEquity: 30000 },
  };
  f.positions.splice(
    0,
    1,
    {
      symbol: "BTCUSD",
      side: "long",
      qty: "0.000399",
      market_value: "33.3555",
      asset_class: "crypto",
    },
    {
      symbol: "SPY",
      side: "long",
      qty: "1",
      market_value: "19965.9945",
      asset_class: "us_equity",
    },
  );

  const result = await readAlpacaPaperSafetyFacts(f.options);
  expect(result).toMatchObject({
    ok: false,
    reason: "alpaca_safety_facts_inconsistent",
    diagnostic: "account_arithmetic",
    accountArithmetic: {
      failedConditions: ["gross_valuation_drift"],
      values: {
        grossDrift: expect.closeTo(0.65, 8),
        grossDriftTolerance: 0.6,
      },
    },
  });
});
it.each([
  ["null-cash", "alpaca_safety_facts_inconsistent"],
  ["blocked-type", "alpaca_safety_facts_inconsistent"],
  ["borrowed", "alpaca_safety_facts_inconsistent"],
  ["short", "alpaca_safety_facts_inconsistent"],
  ["unknown-asset", "alpaca_safety_facts_inconsistent"],
  ["bad-position", "alpaca_safety_facts_inconsistent"],
  ["pending", "alpaca_safety_facts_inconsistent"],
  ["future-quote", "alpaca_safety_facts_inconsistent"],
  ["old-quote", "alpaca_safety_quote_expired"],
  ["currency", "alpaca_safety_facts_inconsistent"],
  ["missing-peak", "alpaca_safety_controller_evidence_or_parameters_invalid"],
  ["unknown-order", "alpaca_safety_controller_evidence_or_parameters_invalid"],
])("refuses %s with a stable code", async (kind, reason) => {
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
  expect(await readAlpacaPaperSafetyFacts({ ...f.options, evidence })).toEqual({
    ok: false,
    reason,
  });
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
it.each([false, true])(
  "routes spot crypto=%s quotes and reuses the binding for final safety facts",
  async (crypto) => {
    const f = fixture(crypto);
    const quote = await readAlpacaPaperSafetyQuote({
      instrument: f.options.instrument,
      side: "sell",
      stockFeed: "sip",
      credentials: f.options.credentials,
      read: f.options.read,
      timeoutMs: f.options.timeoutMs,
      maxAgeMs: f.options.maxAgeMs,
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) {
      return;
    }
    expect(quote).toMatchObject({ bidPrice: 99, askPrice: 100, referencePrice: 99 });
    expect(f.read).toHaveBeenCalledTimes(1);
    const quoteUrl = new URL(f.read.mock.calls[0][0]);
    expect(quoteUrl.hostname).toBe("data.alpaca.markets");
    expect(quoteUrl.pathname).toBe(
      crypto ? "/v1beta3/crypto/us/latest/quotes" : "/v2/stocks/SPY/quotes/latest",
    );
    expect(quoteUrl.searchParams.get(crypto ? "symbols" : "feed")).toBe(crypto ? "BTC/USD" : "sip");
    expect(quote.source).toContain(crypto ? "feed=crypto-us" : "feed=sip");

    const final = await readAlpacaPaperSafetyFacts({
      ...f.options,
      side: "sell",
      stockFeed: "sip",
      boundQuote: quote.boundQuote,
    });
    expect(final.ok).toBe(true);
    const finalUrls = f.read.mock.calls.slice(1).map(([url]) => new URL(url));
    expect(finalUrls.map((url) => url.pathname)).toEqual([
      "/v2/account",
      "/v2/positions",
      "/v2/orders",
      crypto ? "/v2/assets/BTC%2FUSD" : "/v2/assets/SPY",
    ]);
  },
);

it("refuses a non-USD crypto quote before reading a provider", async () => {
  const f = fixture(true);
  expect(await readAlpacaPaperSafetyQuote({ ...f.options, instrument: "BTC/EUR" })).toEqual({
    ok: false,
    reason: "alpaca_safety_quote_parameters_invalid",
  });
  expect(f.read).not.toHaveBeenCalled();
});

it("rejects expired and mismatched opaque quote bindings", async () => {
  const f = fixture();
  const quote = await readAlpacaPaperSafetyQuote({
    instrument: f.options.instrument,
    side: f.options.side,
    stockFeed: f.options.stockFeed,
    credentials: f.options.credentials,
    read: f.options.read,
    timeoutMs: f.options.timeoutMs,
    maxAgeMs: f.options.maxAgeMs,
  });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  const wrongBinding = await readAlpacaPaperSafetyFacts({
    ...f.options,
    side: "sell",
    boundQuote: quote.boundQuote,
  });
  expect(wrongBinding).toEqual({ ok: false, reason: "alpaca_safety_quote_binding_invalid" });
  const wrongFeedBinding = await readAlpacaPaperSafetyFacts({
    ...f.options,
    stockFeed: "sip",
    boundQuote: quote.boundQuote,
  });
  expect(wrongFeedBinding).toEqual({ ok: false, reason: "alpaca_safety_quote_binding_invalid" });

  const now = Date.now();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(now + f.options.maxAgeMs + 1);
    const expired = await readAlpacaPaperSafetyFacts({
      ...f.options,
      evidence: {
        ...f.options.evidence,
        observedAt: new Date(Date.now()).toISOString(),
        expiresAt: new Date(Date.now() + f.options.maxAgeMs).toISOString(),
      },
      boundQuote: quote.boundQuote,
    });
    expect(expired).toEqual({ ok: false, reason: "alpaca_safety_quote_expired" });
  } finally {
    vi.useRealTimers();
  }
});

it("rejects a stale quote before creating an execution binding", async () => {
  const f = fixture();
  f.quote.t = "2020-01-01T00:00:00Z";
  const quote = await readAlpacaPaperSafetyQuote({
    instrument: f.options.instrument,
    side: f.options.side,
    stockFeed: f.options.stockFeed,
    credentials: f.options.credentials,
    read: f.options.read,
    timeoutMs: f.options.timeoutMs,
    maxAgeMs: f.options.maxAgeMs,
  });
  expect(quote).toEqual({ ok: false, reason: "alpaca_safety_quote_expired" });
});

it.each(["zero-bid", "crossed-market"])("rejects invalid quote prices: %s", async (kind) => {
  const f = fixture();
  if (kind === "zero-bid") {
    f.quote.bp = 0;
  } else {
    f.quote.bp = 101;
  }
  const quote = await readAlpacaPaperSafetyQuote({
    instrument: f.options.instrument,
    side: f.options.side,
    stockFeed: f.options.stockFeed,
    credentials: f.options.credentials,
    read: f.options.read,
    timeoutMs: f.options.timeoutMs,
    maxAgeMs: f.options.maxAgeMs,
  });
  expect(quote).toEqual({ ok: false, reason: "alpaca_safety_facts_inconsistent" });
});

it("rejects an invalid quote side before reading the data endpoint", async () => {
  const f = fixture();
  const quote = await readAlpacaPaperSafetyQuote({
    instrument: f.options.instrument,
    side: "hold" as "buy",
    stockFeed: f.options.stockFeed,
    credentials: f.options.credentials,
    read: f.options.read,
    timeoutMs: f.options.timeoutMs,
    maxAgeMs: f.options.maxAgeMs,
  });
  expect(quote).toEqual({
    ok: false,
    reason: "alpaca_safety_quote_parameters_invalid",
  });
  expect(f.read).not.toHaveBeenCalled();
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
  expect(await readAlpacaPaperSafetyFacts(f.options, controller.signal)).toEqual({
    ok: false,
    reason: "alpaca_safety_cancelled_or_timed_out",
  });
  expect(f.read).not.toHaveBeenCalled();
});
it("classifies snapshot read failures without leaking transport or response details", async () => {
  const transport = fixture();
  transport.read.mockRejectedValue(
    new Error(
      "GET https://user:pass@example.test/v2/account?token=SECRET credential=FAKE account=paper-account",
    ),
  );
  const readFailure = await readAlpacaPaperSafetyFacts(transport.options);
  expect(readFailure).toEqual({
    ok: false,
    reason: "alpaca_safety_snapshot_read_unavailable",
  });
  expect(JSON.stringify(readFailure)).not.toMatch(/SECRET|FAKE|paper-account|user:pass/);

  const httpFailure = fixture();
  httpFailure.read.mockResolvedValue({ status: 503, body: "account=paper-account token=SECRET" });
  expect(await readAlpacaPaperSafetyFacts(httpFailure.options)).toEqual({
    ok: false,
    reason: "alpaca_safety_snapshot_read_unavailable",
  });

  const malformed = fixture();
  malformed.read.mockResolvedValue({ status: 200, body: "secret malformed account=paper-account" });
  const responseFailure = await readAlpacaPaperSafetyFacts(malformed.options);
  expect(responseFailure).toEqual({
    ok: false,
    reason: "alpaca_safety_snapshot_response_invalid",
  });
  expect(JSON.stringify(responseFailure)).not.toMatch(/secret|paper-account/);
});

it("classifies a successfully read but inconsistent snapshot separately", async () => {
  const f = fixture();
  f.account.id = "different-account";
  const failure = await readAlpacaPaperSafetyFacts(f.options);
  expect(failure).toEqual({ ok: false, reason: "alpaca_safety_facts_inconsistent" });
  expect(JSON.stringify(failure)).not.toContain("different-account");
});

it("binds sell bid and explicit stock feed", async () => {
  const f = fixture();
  const result = await readAlpacaPaperSafetyFacts({ ...f.options, side: "sell", stockFeed: "sip" });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("fixture");
  }
  expect(result.facts.quote.price).toBe(99);
  expect(result.facts.quote.source).toContain("feed=sip;latest-quote-bid");
  expect(f.read.mock.calls.some(([url]) => url.endsWith("quotes/latest?feed=sip"))).toBe(true);
  expect(
    (await readAlpacaPaperSafetyFacts({ ...f.options, boundQuote: result.boundQuote })).ok,
  ).toBe(false);
});

it.each(["true", 1, null, false])("rejects non-explicit unhedged evidence %s", async (unhedged) => {
  const f = fixture();
  const evidence = { ...f.options.evidence };
  Object.assign(evidence, { unhedged });
  expect((await readAlpacaPaperSafetyFacts({ ...f.options, evidence })).ok).toBe(false);
  expect(f.read).not.toHaveBeenCalled();
});

it("preserves the controller reconciliation watermark while reading fresh broker facts", async () => {
  const f = fixture(false);
  const result = await readAlpacaPaperSafetyFacts({
    ...f.options,
    evidence: { ...f.options.evidence, reconciledThroughClaimId: "confirmed-claim" },
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.facts.reconciledThroughClaimId).toBe("confirmed-claim");
  }
});
it("rejects an empty reconciliation watermark", async () => {
  const f = fixture(false);
  const result = await readAlpacaPaperSafetyFacts({
    ...f.options,
    evidence: { ...f.options.evidence, reconciledThroughClaimId: " " },
  });
  expect(result.ok).toBe(false);
});
it("classifies a standing protective stop and preserves its reserved inventory", async () => {
  const f = fixture(false);
  f.orders.push({
    id: "stop",
    symbol: "SPY",
    qty: "1",
    filled_qty: "0",
    stop_price: "90",
    type: "stop",
    side: "sell",
    status: "new",
    time_in_force: "gtc",
  });
  const result = await readAlpacaPaperSafetyFacts(f.options);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.facts.reservedSellQuantity).toBe(1);
    expect(result.facts.protectiveOrderIds).toEqual(["stop"]);
  }
});

it.each([
  ["equity_non_positive", { equity: "0" }],
  ["negative_cash", { cash: "-1" }],
  ["nonzero_short_value", { short_market_value: "1" }],
  ["gross_above_equity", { equity: "99", cash: "0" }],
  ["cash_equity_mismatch", { cash: "899" }],
  ["untracked_equity_high", {}],
])(
  "reports arithmetic subcondition %s without identity or credentials",
  async (condition, patch) => {
    const f = fixture();
    Object.assign(f.account, patch);
    const options = {
      ...f.options,
      diagnostics: true,
      evidence: {
        ...f.options.evidence,
        peakEquity: condition === "untracked_equity_high" ? 999 : f.options.evidence.peakEquity,
      },
    };
    const result = await readAlpacaPaperSafetyFacts(options);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.diagnostic).toBe("account_arithmetic");
    expect(result.accountArithmetic?.failedConditions).toContain(condition);
    expect(result.accountArithmetic?.values.equity).toBe(Number(f.account.equity));
    expect(JSON.stringify(result)).not.toMatch(
      /paper-account|FAKE|authorized-session|controller-ledger/,
    );
    expect(await readAlpacaPaperSafetyFacts({ ...options, diagnostics: false })).toEqual({
      ok: false,
      reason: "alpaca_safety_facts_inconsistent",
    });
  },
);
it("keeps tracked equity highs admissible with diagnostics enabled", async () => {
  const f = fixture();
  expect(
    (
      await readAlpacaPaperSafetyFacts({
        ...f.options,
        diagnostics: true,
        evidence: { ...f.options.evidence, peakEquity: 999, trackNewHigh: true },
      })
    ).ok,
  ).toBe(true);
});
it("reports overflowed aggregate values explicitly as null", async () => {
  const f = fixture();
  f.account.equity = "1e308";
  f.account.cash = "0";
  f.account.long_market_value = "1e308";
  f.positions[0].market_value = "1e308";
  f.positions.push({ ...f.positions[0], symbol: "QQQ" });
  const result = await readAlpacaPaperSafetyFacts({
    ...f.options,
    diagnostics: true,
    evidence: { ...f.options.evidence, peakEquity: 1e308 },
  });
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.accountArithmetic?.values.positionGross).toBeNull();
  expect(result.accountArithmetic?.values.accountGross).toBeNull();
  expect(result.accountArithmetic?.failedConditions).toContain("gross_above_equity");
});
