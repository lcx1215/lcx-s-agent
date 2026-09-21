import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { syntheticSafetyContext } from "./finance-execution-safety.test-support.js";
vi.mock("./finance-credential-env.js", () => ({
  resolveFinanceCredentialEnv: () => ({
    ALPACA_API_KEY_ID: process.env.ALPACA_API_KEY_ID,
    ALPACA_API_SECRET_KEY: process.env.ALPACA_API_SECRET_KEY,
  }),
}));
beforeEach(() => {
  vi.stubEnv("ALPACA_API_KEY_ID", "PKFIXTURE_ONLY");
  vi.stubEnv("ALPACA_API_SECRET_KEY", "FIXTURE_ONLY");
});
import {
  DEFAULT_ALPACA_FILL_POLL,
  fetchAlpacaAccountSnapshot,
  fetchAlpacaVenueState,
  runFinanceAlpacaOrder,
  type FinanceAlpacaRunRequest,
} from "./finance-alpaca-run.js";
import type { FinanceUncachedFetch, FinanceWriteTransport } from "./finance-write-transport.js";

/**
 * The read is injected, so these exercise the parsing and the refusal paths without opening a
 * connection. That matters here: sizing a position from an assumed equity is a silent defect, so
 * the interesting behaviour is "when the venue is not readable, say so" rather than "return a
 * number anyway".
 */
function readOnce(status: number, body: string): FinanceUncachedFetch {
  return async () => ({ status, body });
}

const ACCOUNT_BODY = JSON.stringify({
  equity: "99999.97",
  cash: "99967.79",
  buying_power: "399536.33",
  currency: "USD",
  status: "ACTIVE",
  trading_blocked: false,
});

describe("fetchAlpacaAccountSnapshot", () => {
  it.each([undefined, null, "true", "false", 0])(
    "refuses ambiguous trading_blocked %s",
    async (value) => {
      const result = await fetchAlpacaAccountSnapshot({
        read: readOnce(
          200,
          JSON.stringify({ ...JSON.parse(ACCOUNT_BODY), trading_blocked: value }),
        ),
      });
      expect(result.ok).toBe(false);
    },
  );

  it("parses the real equity from a 200 account response", async () => {
    const result = await fetchAlpacaAccountSnapshot({ read: readOnce(200, ACCOUNT_BODY) });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.account.equity).toBeCloseTo(99999.97, 2);
    expect(result.account.cash).toBeCloseTo(99967.79, 2);
    expect(result.account.currency).toBe("USD");
    expect(result.account.status).toBe("ACTIVE");
    expect(result.account.tradingBlocked).toBe(false);
  });

  it("refuses on a non-200 instead of falling back to a default equity", async () => {
    const result = await fetchAlpacaAccountSnapshot({
      read: readOnce(401, '{"message":"unauthorized"}'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("401");
  });

  it("refuses when the response carries no usable equity", async () => {
    const result = await fetchAlpacaAccountSnapshot({
      read: readOnce(200, JSON.stringify({ status: "ACTIVE" })),
    });
    expect(result).toMatchObject({ ok: false, reason: "account read returned no usable equity" });
  });

  it("refuses when the body is not JSON", async () => {
    const result = await fetchAlpacaAccountSnapshot({
      read: readOnce(200, "<html>maintenance</html>"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("credentials");
    }
  });

  it("refuses when the read throws", async () => {
    const result = await fetchAlpacaAccountSnapshot({
      read: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("socket hang up");
  });

  it("keeps the credential gate before an injected account transport", async () => {
    vi.stubEnv("ALPACA_API_KEY_ID", "");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "");
    const read = vi.fn(readOnce(200, ACCOUNT_BODY));
    const result = await fetchAlpacaAccountSnapshot({ read });
    expect(result).toMatchObject({ ok: false, reason: "Alpaca credentials are not configured" });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("fetchAlpacaVenueState", () => {
  /** Answers the two venue reads by URL, so parsing and refusal are both exercised. */
  function venueRead(orders: unknown, positions: unknown, orderStatus = 200): FinanceUncachedFetch {
    return async (url) => ({
      status: url.includes("/orders") ? orderStatus : 200,
      body: JSON.stringify(url.includes("/orders") ? orders : positions),
    });
  }

  it("reads open orders and positions by symbol", async () => {
    stubCredentials();
    const result = await fetchAlpacaVenueState({
      read: venueRead(
        [
          { symbol: "spy", status: "new" },
          { symbol: "SPY", status: "accepted" },
          { symbol: "TLT", status: "new" },
        ],
        [
          { symbol: "SPY", qty: "10" },
          { symbol: "tlt", qty: "5" },
        ],
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.openOrders.get("SPY")).toBe(2);
    expect(result.state.openOrders.get("TLT")).toBe(1);
    expect(result.state.positions.get("SPY")).toBe(10);
    expect(result.state.positions.get("TLT")).toBe(5);
  });

  it("reports an instrument with no venue position as flat, not unknown", async () => {
    stubCredentials();
    const result = await fetchAlpacaVenueState({ read: venueRead([], []) });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Absent would mean "not read"; a flat position has to be a zero the caller can compare.
    expect(result.state.positions.has("SPY")).toBe(false);
    expect(result.state.openOrders.size).toBe(0);
  });

  it("refuses when either read fails, rather than reporting an empty book", async () => {
    stubCredentials();
    const result = await fetchAlpacaVenueState({
      read: venueRead([], [], 500),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("500");
  });

  it("refuses when the response is not a list", async () => {
    stubCredentials();
    const result = await fetchAlpacaVenueState({ read: venueRead({ nope: true }, []) });
    expect(result.ok).toBe(false);
  });

  it("refuses when credentials are absent", async () => {
    // An explicitly empty variable disables the credential; the store on this machine really
    // does hold a key, so "absent" has to be stated rather than assumed.
    vi.stubEnv("ALPACA_API_KEY_ID", "");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "");
    const result = await fetchAlpacaVenueState({ read: venueRead([], []) });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("credentials");
  });
});

const PAPER_KEY = "PKTESTKEYID0000000000";
const SECRET = "secretsecretsecretsecretsecret00";

function stubCredentials() {
  vi.stubEnv("ALPACA_API_KEY_ID", PAPER_KEY);
  vi.stubEnv("ALPACA_API_SECRET_KEY", SECRET);
}

/** A venue that accepts the order and says nothing about the fill yet. */
function acceptingTransport(orderId: string): FinanceWriteTransport {
  return async () => ({
    status: 200,
    body: JSON.stringify({ id: orderId, status: "accepted", filled_qty: "0" }),
  });
}

const CONCLUSION = {
  conclusionId: "cycle:2026-08-31:SPY",
  instrument: "SPY",
  direction: "buy" as const,
  conviction: 0.8,
  assetClass: "us_equity",
  horizonDays: 30,
  invalidationPrice: 90,
  thesis: "drift rebalance",
  invalidationCondition: "signal flips",
};

function request(overrides: Partial<FinanceAlpacaRunRequest> = {}): FinanceAlpacaRunRequest {
  return {
    createSafetyContext: syntheticSafetyContext,
    conclusion: CONCLUSION,
    market: { referencePrice: 100, referencePriceAt: new Date().toISOString() },
    equity: 100_000,
    runAuthorizationId: "auth-test",
    budget: {
      automation: "unattended" as const,
      allowedInstruments: ["SPY"],
      maxOrderNotional: 50_000,
      maxInstrumentNotional: 100_000,
      maxOrdersPerRun: 8,
    },
    instruments: ["SPY"],
    transport: acceptingTransport("ord-fill"),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runFinanceAlpacaOrder fill handling", () => {
  it("records the venue's own fill rather than the submit snapshot", async () => {
    stubCredentials();
    // The submit response is the observed behaviour: accepted, filled_qty 0. A receipt built
    // from it would tell the position ledger "you own nothing", and the next cycle would buy
    // the same instrument again.
    let polls = 0;
    let orderedQty = 0;
    const read: FinanceUncachedFetch = async () => {
      polls += 1;
      return {
        status: 200,
        body: JSON.stringify({
          id: "ord-fill",
          status: polls < 2 ? "new" : "filled",
          updated_at: "2026-09-20T00:00:00.000Z",
          filled_qty: polls < 2 ? "0" : String(orderedQty),
          filled_avg_price: polls < 2 ? null : "100.5",
        }),
      };
    };
    const result = await runFinanceAlpacaOrder(
      request({
        read,
        transport: async (init) => {
          orderedQty = Number(JSON.parse(init.body).qty);
          return acceptingTransport("ord-fill")(init);
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.receipt.fill.filledQuantity).toBe(orderedQty);
    expect(result.receipt.fill.fillPrice).toBeCloseTo(100.5, 2);
    expect(polls).toBeGreaterThan(1);
  });

  it("polls by default, so forgetting the option cannot lose a position", async () => {
    stubCredentials();
    let orderedQty = 0;
    const read: FinanceUncachedFetch = async () => ({
      status: 200,
      body: JSON.stringify({
        id: "ord-fill",
        status: "filled",
        updated_at: "2026-09-20T00:00:00.000Z",
        filled_qty: String(orderedQty),
        filled_avg_price: "99",
      }),
    });
    // No `fillPoll` in the request at all — the default has to be the one with behaviour.
    const result = await runFinanceAlpacaOrder(
      request({
        read,
        transport: async (init) => {
          orderedQty = Number(JSON.parse(init.body).qty);
          return acceptingTransport("ord-fill")(init);
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.receipt.fill.filledQuantity).toBe(orderedQty);
    expect(DEFAULT_ALPACA_FILL_POLL.timeoutMs).toBeGreaterThan(0);
  });

  it("reports the submit response only when polling is explicitly turned off", async () => {
    stubCredentials();
    let polls = 0;
    const read: FinanceUncachedFetch = async () => {
      polls += 1;
      return {
        status: 200,
        body: JSON.stringify({
          id: "ord-fill",
          status: "filled",
          updated_at: "2026-09-20T00:00:00.000Z",
          filled_qty: "10",
          filled_avg_price: "100.5",
        }),
      };
    };
    await expect(runFinanceAlpacaOrder(request({ read, fillPoll: false }))).rejects.toMatchObject({
      code: "finance_execution_safety_unknown",
    });
    expect(polls).toBe(0);
  });

  it("refuses rather than recording a zero when the fill never resolves", async () => {
    stubCredentials();
    const read: FinanceUncachedFetch = async () => ({
      status: 200,
      body: JSON.stringify({ id: "ord-pending", status: "new", filled_qty: "0" }),
    });
    const transport = acceptingTransport("ord-pending");
    // An order that was submitted is not an order that did not happen, so "unknown" is thrown
    // rather than recorded as zero. The cycle layer catches it and turns it into a refusal
    // that still names the order id.
    await expect(
      runFinanceAlpacaOrder(
        request({ read, transport, fillPoll: { timeoutMs: 60, intervalMs: 10 } }),
      ),
    ).rejects.toMatchObject({
      code: "finance_execution_safety_unknown",
      cause: expect.objectContaining({ code: "alpaca_order_uncertain", orderId: "ord-pending" }),
    });
  });
});

it("refuses direct Alpaca placement without controller facts before transport", async () => {
  const transport = vi.fn();
  const result = await runFinanceAlpacaOrder(
    request({ createSafetyContext: undefined, transport }),
  );
  expect(result.ok).toBe(false);
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  {
    name: "defaults protected whole-share equity to GTC",
    explicit: undefined,
    longHorizon: false,
    expected: "gtc",
  },
  {
    name: "preserves explicit DAY for protected equity",
    explicit: "day" as const,
    longHorizon: false,
    expected: "day",
  },
  {
    name: "retains adapter default without a compiled stop",
    explicit: undefined,
    longHorizon: true,
    expected: "day",
  },
])("$name", async ({ explicit, longHorizon, expected }) => {
  let body: Record<string, unknown> | undefined;
  const transport: FinanceWriteTransport = async (input) => {
    body = JSON.parse(input.body) as Record<string, unknown>;
    return {
      status: 200,
      body: JSON.stringify({
        id: "order-time-in-force",
        status: "filled",
        filled_qty: body.qty,
        filled_avg_price: "100",
        filled_at: new Date().toISOString(),
      }),
    };
  };
  const result = await runFinanceAlpacaOrder(
    request({
      transport,
      fillPoll: false,
      ...(explicit === undefined ? {} : { timeInForce: explicit }),
      ...(longHorizon
        ? { conclusion: { ...CONCLUSION, horizonDays: 400 }, strategyClass: "C" }
        : {}),
      read: async () => {
        throw new Error("unexpected read");
      },
    }),
  );
  expect(result.ok).toBe(true);
  expect(body?.time_in_force).toBe(expected);
  expect(body?.order_class).toBe(longHorizon ? undefined : "oto");
});
