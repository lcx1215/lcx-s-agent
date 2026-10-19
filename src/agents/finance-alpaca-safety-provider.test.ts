import { expect, it, vi } from "vitest";
import {
  readAlpacaPaperSafetyQuote,
  AlpacaSafetyQuoteReadError,
  readAlpacaPaperSafetyFacts,
  type AlpacaSafetyProviderOptions,
} from "./finance-alpaca-safety-provider.js";
import { readBoundedFinanceResponseText } from "./finance-http-body.js";
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
      valuationRetry: {
        firstGrossDrift: expect.closeTo(0.0545, 8),
        retryGrossDrift: expect.closeTo(0.0545, 8),
        firstCoherentTolerance: expect.closeTo(0.048018, 8),
        retryCoherentTolerance: expect.closeTo(0.048018, 8),
        cashStable: true,
        quantitiesStable: true,
      },
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
it("retains the first failed sample when the retry drift alone fits the coherent bound", async () => {
  const f = fixture();
  f.account.equity = "30000";
  f.account.cash = "10000";
  f.account.long_market_value = "20000";
  f.options = {
    ...f.options,
    diagnostics: true,
    evidence: { ...f.options.evidence, peakEquity: 30000 },
  };
  const baseRead = f.read.getMockImplementation()!;
  let positionReads = 0;
  f.read.mockImplementation(async (url, init) => {
    if (url.includes("/positions")) {
      return {
        status: 200,
        body: JSON.stringify([
          { ...f.positions[0], market_value: positionReads++ === 0 ? "19999" : "19999.9" },
        ]),
      };
    }
    return baseRead(url, init);
  });
  const result = await readAlpacaPaperSafetyFacts(f.options);
  expect(result).toMatchObject({
    ok: false,
    diagnostic: "account_arithmetic",
    accountArithmetic: {
      failedConditions: ["gross_valuation_drift"],
      values: { grossDrift: expect.closeTo(0.1, 8), grossDriftTolerance: 0.6 },
      valuationRetry: {
        firstGrossDrift: 1,
        retryGrossDrift: expect.closeTo(0.1, 8),
        firstCoherentTolerance: 0.6,
        retryCoherentTolerance: 0.6,
        cashStable: true,
        quantitiesStable: true,
      },
    },
  });
});

it("parallel independent order and asset reads fit the original observation lease", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const baseRead = f.read.getMockImplementation()!;
    const start = Date.now();
    const quoteReadAges: number[] = [];
    f.read.mockImplementation(async (url, init) => {
      if (url.includes("/orders?") || url.includes("/assets/")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
      }
      if (url.includes("/quotes/latest")) {
        quoteReadAges.push(Date.now() - start);
      }
      return baseRead(url, init);
    });
    const result = readAlpacaPaperSafetyFacts({ ...f.options, maxAgeMs: 75 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).ok).toBe(true);
    expect(quoteReadAges).toEqual([40]);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["orders", "asset", "both"] as const)(
  "keeps endpoint-specific failures while parallel sampling: %s",
  async (failure) => {
    const f = fixture();
    const baseRead = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (url, init) => {
      if (
        ((failure === "orders" || failure === "both") && url.includes("/orders?")) ||
        ((failure === "asset" || failure === "both") && url.includes("/assets/"))
      ) {
        return { status: 503, body: "PRIVATE_RESPONSE" };
      }
      return baseRead(url, init);
    });
    expect(await readAlpacaPaperSafetyFacts({ ...f.options, diagnostics: true })).toEqual({
      ok: false,
      reason: "alpaca_safety_snapshot_read_unavailable",
      diagnostic: failure === "asset" ? "instrument_asset_snapshot" : "open_order_snapshot",
    });
    expect(f.read.mock.calls.some(([url]) => url.includes("/quotes/latest"))).toBe(false);
  },
);
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

it.each([401, 429, 503, 100, 599, 0, 600, 401.5, Number.NaN])(
  "retains only actual legal quote HTTP status %s",
  async (status) => {
    const f = fixture();
    f.read.mockResolvedValue({ status, body: "PRIVATE_BODY https://secret.invalid/token" });
    const result = await readAlpacaPaperSafetyQuote({ ...f.options, diagnostics: true });
    const valid = Number.isInteger(status) && status >= 100 && status <= 599;
    expect(result).toEqual({
      ok: false,
      reason: "alpaca_safety_snapshot_read_unavailable",
      diagnostic: { stage: "quote_snapshot", ...(valid ? { httpStatus: status } : {}) },
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_BODY|secret.invalid|token|FAKE/);
    expect(await readAlpacaPaperSafetyQuote({ ...f.options, diagnostics: false })).toEqual({
      ok: false,
      reason: "alpaca_safety_snapshot_read_unavailable",
    });
  },
);

it.each(["transport", "json", "oversize", "shape", "values", "future", "stale"] as const)(
  "reports bounded quote diagnostics without raw content (%s)",
  async (mode) => {
    const f = fixture();
    if (mode === "transport") {
      f.read.mockRejectedValue(
        Object.assign(new Error("PRIVATE_BODY https://secret.invalid/token"), {
          name: "AlpacaSafetyProviderFailure",
          code: "alpaca_safety_quote_expired",
          httpStatus: 429,
        }),
      );
    }
    if (mode === "json") {
      f.read.mockResolvedValue({ status: 200, body: "PRIVATE_BODY" });
    }
    if (mode === "oversize") {
      f.read.mockResolvedValue({ status: 200, body: "x".repeat(2 * 1024 * 1024 + 1) });
    }
    if (mode === "shape") {
      f.read.mockResolvedValue({ status: 200, body: "{}" });
    }
    if (mode === "values") {
      f.quote.bp = 0;
    }
    if (mode === "future") {
      f.quote.t = new Date(Date.now() + 60_000).toISOString();
    }
    if (mode === "stale") {
      f.quote.t = "2020-01-01T00:00:00Z";
    }
    const result = await readAlpacaPaperSafetyQuote({ ...f.options, diagnostics: true });
    expect(result).toEqual({
      ok: false,
      reason:
        mode === "transport"
          ? "alpaca_safety_snapshot_read_unavailable"
          : mode === "json" || mode === "oversize"
            ? "alpaca_safety_snapshot_response_invalid"
            : mode === "stale"
              ? "alpaca_safety_quote_expired"
              : "alpaca_safety_facts_inconsistent",
      diagnostic: {
        stage:
          mode === "transport" || mode === "json" || mode === "oversize"
            ? "quote_snapshot"
            : mode === "stale"
              ? "quote_age_exceeded"
              : mode === "future"
                ? "quote_timestamp_future"
                : mode === "values"
                  ? "quote_bid_non_positive"
                  : "quote_payload_invalid",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_BODY|secret.invalid|token|FAKE|429/);
  },
);

it("preserves an ignored-reader quote timeout and parent cancellation without retries", async () => {
  const f = fixture();
  const caller = new AbortController();
  const deadline = new AbortController();
  const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  f.read.mockImplementation(async () => new Promise(() => {}));
  try {
    const timeout = readAlpacaPaperSafetyQuote({ ...f.options, diagnostics: true });
    deadline.abort();
    expect(await timeout).toEqual({
      ok: false,
      reason: "alpaca_safety_cancelled_or_timed_out",
      diagnostic: {
        stage: "quote_snapshot",
        transport: { code: "transport_cause_unavailable", cleanupStatus: "unconfirmed" },
      },
    });
    const before = f.read.mock.calls.length;
    caller.abort(new Error("PRIVATE_BODY"));
    expect(
      await readAlpacaPaperSafetyQuote({ ...f.options, diagnostics: true }, caller.signal),
    ).toMatchObject({ ok: false, reason: "alpaca_safety_cancelled_or_timed_out" });
    expect(f.read).toHaveBeenCalledTimes(before);
  } finally {
    spy.mockRestore();
  }
});

it.each([
  { kind: "empty_payload", stage: "quote_payload_invalid" },
  { kind: "array_payload", stage: "quote_payload_invalid" },
  { kind: "null_bid", stage: "quote_bid_invalid" },
  { kind: "boolean_bid", stage: "quote_bid_invalid" },
  { kind: "blank_bid", stage: "quote_bid_invalid" },
  { kind: "missing_ask", stage: "quote_ask_invalid" },
  { kind: "nonfinite_ask", stage: "quote_ask_invalid" },
  { kind: "missing_timestamp", stage: "quote_timestamp_missing" },
  { kind: "blank_timestamp", stage: "quote_timestamp_missing" },
] as const)(
  "rejects malformed quote data with bounded field attribution on both readers: $kind",
  async ({ kind, stage }) => {
    for (const crypto of [false, true]) {
      for (const reader of [readAlpacaPaperSafetyQuote, readAlpacaPaperSafetyFacts]) {
        const f = fixture(crypto);
        const instrument = f.options.instrument;
        const quote: Record<string, unknown> = { ...f.quote };
        if (kind === "null_bid") {
          quote.bp = null;
        }
        if (kind === "boolean_bid") {
          quote.bp = true;
        }
        if (kind === "blank_bid") {
          quote.bp = " ";
        }
        if (kind === "missing_ask") {
          delete quote.ap;
        }
        if (kind === "nonfinite_ask") {
          quote.ap = "PRIVATE_BODY";
        }
        if (kind === "missing_timestamp") {
          delete quote.t;
        }
        if (kind === "blank_timestamp") {
          quote.t = " ";
        }
        const payload = kind === "empty_payload" ? {} : kind === "array_payload" ? [] : quote;
        const body =
          kind === "empty_payload"
            ? {}
            : crypto
              ? { quotes: { [instrument]: payload } }
              : { quote: payload };
        const original = f.read.getMockImplementation()!;
        f.read.mockImplementation(async (url, init) =>
          url.includes("quotes")
            ? { status: 200, body: JSON.stringify(body) }
            : original(url, init),
        );
        const result = await reader({ ...f.options, diagnostics: true });
        expect(result).toMatchObject({ ok: false, reason: "alpaca_safety_facts_inconsistent" });
        if (result.ok) {
          throw new Error("malformed quote accepted");
        }
        expect(
          typeof result.diagnostic === "string" ? result.diagnostic : result.diagnostic?.stage,
        ).toBe(stage);
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE_BODY|FAKE/);
        expect(await reader({ ...f.options, diagnostics: false })).toEqual({
          ok: false,
          reason: "alpaca_safety_facts_inconsistent",
        });
      }
    }
  },
);

it("sanitizes typed quote failure fields before host propagation", () => {
  const error = new AlpacaSafetyQuoteReadError("alpaca_safety_snapshot_read_unavailable", {
    stage: "quote_snapshot",
    httpStatus: 600,
    message: "PRIVATE_BODY",
  } as never);
  expect(error.reason).toBe("alpaca_safety_snapshot_read_unavailable");
  expect(error.diagnostic).toEqual({ stage: "quote_snapshot" });
  expect(JSON.stringify(error)).not.toContain("PRIVATE_BODY");
});

it.each([
  { kind: "non_positive", stage: "quote_bid_non_positive", expired: false },
  { kind: "crossed", stage: "quote_ask_below_bid", expired: false },
  { kind: "invalid_time", stage: "quote_timestamp_invalid", expired: false },
  { kind: "future", stage: "quote_timestamp_future", expired: false },
  { kind: "old", stage: "quote_age_exceeded", expired: true },
  { kind: "duration", stage: "quote_read_duration_exceeded", expired: true },
] as const)(
  "classifies quote refusal on both original readers without changing the gate ($kind)",
  async ({ kind, stage, expired }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    try {
      for (const reader of [readAlpacaPaperSafetyQuote, readAlpacaPaperSafetyFacts]) {
        const f = fixture();
        if (kind === "non_positive") {
          f.quote.bp = 0;
        }
        if (kind === "crossed") {
          f.quote.ap = 98;
        }
        if (kind === "invalid_time") {
          f.quote.t = "PRIVATE_BODY https://secret.invalid/token";
        }
        if (kind === "future") {
          f.quote.t = new Date(Date.now() + 1000).toISOString();
        }
        if (kind === "old") {
          f.quote.t = new Date(Date.now() - 60001).toISOString();
        }
        if (kind === "duration") {
          const original = f.read.getMockImplementation()!;
          f.read.mockImplementation(async (url, init) => {
            if (url.includes("quotes")) {
              vi.setSystemTime(new Date(Date.now() + 60001));
              f.quote.t = new Date().toISOString();
            }
            return original(url, init);
          });
        }
        const result = await reader({ ...f.options, diagnostics: true });
        expect(result).toMatchObject({
          ok: false,
          reason: expired ? "alpaca_safety_quote_expired" : "alpaca_safety_facts_inconsistent",
        });
        if (result.ok) {
          throw new Error("invalid quote accepted");
        }
        expect(
          typeof result.diagnostic === "string" ? result.diagnostic : result.diagnostic?.stage,
        ).toBe(stage);
        if (kind === "future") {
          const timing =
            typeof result.diagnostic === "string"
              ? (result as { quoteTiming?: unknown }).quoteTiming
              : result.diagnostic?.quoteTiming;
          expect(timing).toEqual({
            quoteAtMs: Date.now() + 1000,
            checkedAtMs: Date.now(),
            aheadMs: 1000,
          });
        }
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE_BODY|secret.invalid|token|FAKE/);
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

it("retains a safe socket cause from failed position facts", async () => {
  const f = fixture();
  const original = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (url, init) => {
    if (url.endsWith("/v2/positions")) {
      throw new TypeError("PRIVATE_URL_TOKEN", {
        cause: Object.assign(new Error("PRIVATE_BODY"), { code: "ECONNRESET" }),
      });
    }
    return original(url, init);
  });
  const result = await readAlpacaPaperSafetyFacts({ ...f.options, diagnostics: true });
  expect(result).toMatchObject({
    ok: false,
    reason: "alpaca_safety_snapshot_read_unavailable",
    diagnostic: "position_snapshot",
    transport: { code: "ECONNRESET" },
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  expect(f.read.mock.calls.filter(([url]) => url.endsWith("/v2/positions"))).toHaveLength(1);
});
it.each(["facts", "quote"] as const)(
  "waits for real body cancellation acknowledgement in %s",
  async (kind) => {
    const f = fixture();
    const caller = new AbortController();
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancel = vi.fn();
    const responses: Response[] = [];
    f.read.mockImplementation(async (_url, init) => {
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
      responses.push(response);
      const pending = readBoundedFinanceResponseText(response, { signal: init.signal });
      entered();
      return { status: 200, body: await pending };
    });
    const reader = kind === "facts" ? readAlpacaPaperSafetyFacts : readAlpacaPaperSafetyQuote;
    const pending = reader({ ...f.options, diagnostics: true }, caller.signal);
    await reached;
    const requestsAtCancellation = f.read.mock.calls.length;
    caller.abort(new Error("PRIVATE_BODY"));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, reason: "alpaca_safety_cancelled_or_timed_out" });
    if (result.ok) {
      throw new Error("cancelled read accepted");
    }
    const transport =
      typeof result.diagnostic === "string"
        ? "transport" in result
          ? result.transport
          : undefined
        : result.diagnostic?.transport;
    expect(transport).toMatchObject({ cleanupStatus: "confirmed" });
    expect(cancel).toHaveBeenCalledTimes(requestsAtCancellation);
    expect(responses.every((response) => !response.body?.locked)).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(requestsAtCancellation);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  },
);

it("keeps cleanup unconfirmed if one parallel account body cannot cancel", async () => {
  const f = fixture();
  const caller = new AbortController();
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.read.mockImplementation(async (url, init) => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () =>
          url.endsWith("/v2/positions") ? new Promise<void>(() => {}) : Promise.resolve(),
      }),
    );
    const body = readBoundedFinanceResponseText(response, { signal: init.signal });
    entered();
    return { status: 200, body: await body };
  });
  const pending = readAlpacaPaperSafetyFacts({ ...f.options, diagnostics: true }, caller.signal);
  await reached;
  const requestsAtCancellation = f.read.mock.calls.length;
  caller.abort();
  expect(await pending).toMatchObject({
    ok: false,
    reason: "alpaca_safety_cancelled_or_timed_out",
    transport: { cleanupStatus: "unconfirmed" },
  });
  expect(f.read).toHaveBeenCalledTimes(requestsAtCancellation);
});
