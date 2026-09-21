import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
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
  createAlpacaExecutionAdapter,
  AlpacaOrderUncertainError,
  type AlpacaExecutionAdapterOptions,
} from "./finance-alpaca-execution-adapter.js";
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

/** Captures what was actually sent, because the defect lives in the payload, not the URL. */
function capturingTransport(orderId: string) {
  const bodies: Record<string, unknown>[] = [];
  const fn = async (_url: string, init?: { body: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    return { status: 200, body: JSON.stringify({ id: orderId, status: "new", filled_qty: "0" }) };
  };
  return { fn, bodies };
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
            : {
                id: "ord-9",
                status: "filled",
                updated_at: "2026-09-20T00:00:00.000Z",
                filled_qty: "1",
                filled_avg_price: "101.25",
              },
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

  it("protects a buy with the stop as an oto, not a bracket", async () => {
    // Measured against the venue, not assumed: sending `order_class: "bracket"` with only a
    // `stop_loss` comes back `http 422: bracket orders require take_profit.limit_price`. A
    // take-profit is a price target the rule never declares, so the entry is sent as `oto` —
    // fill it, then place the stop — and nothing is invented to satisfy the venue.
    stubCredentials(PAPER);
    const t = capturingTransport("ord-12");
    const adapter = createAlpacaExecutionAdapter({ instruments: ["AAPL"], postJson: t.fn });
    await adapter.execute({ ...baseIntent, stopPrice: 90 }, new AbortController().signal);
    expect(t.bodies[0]?.order_class).toBe("oto");
    expect(t.bodies[0]?.stop_loss).toEqual({ stop_price: "90" });
    expect(t.bodies[0]?.take_profit).toBeUndefined();
  });

  it("sends a sell as a plain order, because a stop below the market would be rejected", async () => {
    stubCredentials(PAPER);
    const t = capturingTransport("ord-13");
    const adapter = createAlpacaExecutionAdapter({ instruments: ["AAPL"], postJson: t.fn });
    // Same stop, selling side: the venue requires a sell's stop_loss ABOVE the market, so a
    // bracket here is a guaranteed 422 — and the exit path is the one that must never fail.
    await adapter.execute(
      { ...baseIntent, side: "sell", stopPrice: 90 },
      new AbortController().signal,
    );
    expect(t.bodies[0]?.order_class).toBeUndefined();
    expect(t.bodies[0]?.stop_loss).toBeUndefined();
    expect(t.bodies[0]?.side).toBe("sell");
  });

  it("reports zero for an order that reaches a terminal unfilled state", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-11", status: "new", filled_qty: "0" });
    const statusFetch = async () => ({
      status: 200,
      body: JSON.stringify({
        id: "ord-11",
        status: "expired",
        updated_at: "2026-09-20T00:00:00.000Z",
        filled_qty: "0",
      }),
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

/**
 * The empty allowlist and a non-finite poll bound.
 *
 * The shared contract declares `instruments` as "Empty accepts nothing" and `admitsInstrument`
 * implements that, but this adapter read an empty list as "any": measured, `instruments: []` placed
 * an order for AAPL while `instruments: ["AAPL"]` refused MSFT. `placeFinanceOrder` masks it by
 * refusing first, and both real callers pass a caller-supplied list straight through.
 *
 * `fillPoll.timeoutMs: NaN` removed the deadline rather than shortening it (`Date.now() >= NaN` is
 * false forever), so the poll loop never reached its "unknown fill state" exit: with a status endpoint
 * that never turns terminal, `timeoutMs: 1` threw the intended error while `NaN` polled past 40
 * requests with no end.
 */
describe("an empty allowlist and a non-finite poll bound", () => {
  it("refuses an empty instrument list rather than reading it as any", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-20" });
    const adapter = createAlpacaExecutionAdapter({ instruments: [], postJson: t.fn });
    await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toThrow(
      /not declared for instrument AAPL/,
    );
    expect(t.calls).toHaveLength(0);
  });

  it("refuses a non-finite poll bound before polling the venue at all", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-21", status: "new", filled_qty: "0" });
    let polls = 0;
    const statusFetch = async () => {
      polls += 1;
      return {
        status: 200,
        body: JSON.stringify({ id: "ord-21", status: "new", filled_qty: "0" }),
      };
    };
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const adapter = createAlpacaExecutionAdapter({
        instruments: ["AAPL"],
        postJson: t.fn,
        fillPoll: { timeoutMs, intervalMs: 1 },
        statusFetch,
      });
      await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toThrow(
        /fillPoll requires a finite non-negative/,
      );
    }
    expect(polls).toBe(0);
  });

  it("still polls, and still gives up, with a finite bound", async () => {
    stubCredentials(PAPER);
    const t = transport({ id: "ord-22", status: "new", filled_qty: "0" });
    const adapter = createAlpacaExecutionAdapter({
      instruments: ["AAPL"],
      postJson: t.fn,
      fillPoll: { timeoutMs: 20, intervalMs: 1 },
      statusFetch: async () => ({
        status: 200,
        body: JSON.stringify({ id: "ord-22", status: "new", filled_qty: "0" }),
      }),
    });
    await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toThrow(
      /fill state is unknown/,
    );
  });
});

describe("submission identity and terminal fill safety", () => {
  it.each(["SPY", "BTC/USD", "ETH/USD"])(
    "recovers a lost response and duplicate submission for %s with one venue identity",
    async (instrument) => {
      const intent = { ...baseIntent, instrument };
      let stored: Record<string, unknown> | undefined;
      let created = 0;
      const ids: string[] = [];
      const adapter = createAlpacaExecutionAdapter({
        instruments: [instrument],
        postJson: async (_url, init) => {
          const body = JSON.parse(init.body);
          ids.push(body.client_order_id);
          if (!stored) {
            created++;
            stored = {
              ...body,
              id: "venue-one",
              status: "filled",
              filled_qty: body.qty,
              filled_avg_price: "100",
              filled_at: "2026-09-20T00:00:00Z",
            };
            throw new Error("response lost");
          }
          return {
            status: 422,
            body: JSON.stringify({ message: "client_order_id must be unique" }),
          };
        },
        statusFetch: async (url) => {
          expect(url).toContain("orders:by_client_order_id?client_order_id=");
          return { status: 200, body: JSON.stringify(stored) };
        },
      });
      const first = await adapter.execute(intent, new AbortController().signal);
      const second = await adapter.execute(intent, new AbortController().signal);
      expect(created).toBe(1);
      expect(ids[0]).toBe(ids[1]);
      expect(second).toEqual(first);
      expect(first.terminalOrderIdentity).toEqual({ orderId: "venue-one", terminal: true });
    },
  );
  it("does not reconcile a conflicting intent against an old client order", async () => {
    const adapter = createAlpacaExecutionAdapter({
      instruments: ["AAPL"],
      postJson: async () => {
        throw new Error("lost");
      },
      statusFetch: async () => ({
        status: 200,
        body: JSON.stringify({
          id: "other",
          client_order_id: "wrong",
          symbol: "AAPL",
          side: "buy",
          qty: "1",
          type: "market",
        }),
      }),
    });
    await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toBeInstanceOf(
      AlpacaOrderUncertainError,
    );
  });
  it.each(["filled", "canceled"])(
    "waits through partial fills until %s and keeps venue event time",
    async (status) => {
      let calls = 0;
      const adapter = createAlpacaExecutionAdapter({
        instruments: ["AAPL"],
        postJson: transport({ id: "partial" }).fn,
        fillPoll: { timeoutMs: 500, intervalMs: 0 },
        statusFetch: async () => ({
          status: 200,
          body: JSON.stringify(
            ++calls === 1
              ? { status: "partially_filled", filled_qty: "0.25", filled_avg_price: "100" }
              : {
                  status,
                  filled_qty: status === "filled" ? "1" : "0.25",
                  filled_avg_price: "101",
                  updated_at: "2026-09-20T01:00:00Z",
                },
          ),
        }),
      });
      const result = await adapter.execute(baseIntent, new AbortController().signal);
      expect(calls).toBe(2);
      expect(result.filledQuantity).toBe(status === "filled" ? 1 : 0.25);
      expect(result.filledAt).toBe("2026-09-20T01:00:00.000Z");
    },
  );
  it("invalid poll settings never submit an order", async () => {
    const postJson = vi.fn(transport({ id: "never" }).fn);
    const adapter = createAlpacaExecutionAdapter({
      instruments: ["AAPL"],
      postJson,
      fillPoll: { timeoutMs: NaN },
    });
    await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toThrow(
      "finite",
    );
    expect(postJson).not.toHaveBeenCalled();
  });
  it("bounds an uncooperative status read and preserves submitted identity", async () => {
    const adapter = createAlpacaExecutionAdapter({
      instruments: ["AAPL"],
      postJson: transport({ id: "hanging" }).fn,
      fillPoll: { timeoutMs: 20, intervalMs: 0 },
      statusFetch: () => new Promise(() => {}),
    });
    await expect(adapter.execute(baseIntent, new AbortController().signal)).rejects.toMatchObject({
      code: "alpaca_order_uncertain",
      orderId: "hanging",
      clientOrderId: expect.stringMatching(/^lcx-/),
    });
  });
  it("pre-cancelled execution sends no order", async () => {
    const postJson = vi.fn(transport({ id: "never" }).fn);
    const adapter = createAlpacaExecutionAdapter({ instruments: ["AAPL"], postJson });
    await expect(
      adapter.execute(baseIntent, AbortSignal.abort(new Error("cancelled"))),
    ).rejects.toThrow("cancelled");
    expect(postJson).not.toHaveBeenCalled();
  });
});

it.each(["BTC/USD", "ETH/USD"])(
  "uses crypto GTC and refuses unsupported protection/TIF for %s",
  async (instrument) => {
    const postJson = vi.fn<NonNullable<AlpacaExecutionAdapterOptions["postJson"]>>(
      async (_url, init) => {
        expect(JSON.parse(init.body).time_in_force).toBe("gtc");
        return {
          status: 200,
          body: JSON.stringify({ id: "crypto", status: "new", filled_qty: "0" }),
        };
      },
    );
    const intent = { ...baseIntent, instrument };
    await createAlpacaExecutionAdapter({ instruments: [instrument], postJson }).execute(
      intent,
      new AbortController().signal,
    );
    expect(postJson).toHaveBeenCalledTimes(1);
    postJson.mockClear();
    for (const timeInForce of ["day", "fok"] as const) {
      await expect(
        createAlpacaExecutionAdapter({ instruments: [instrument], postJson, timeInForce }).execute(
          intent,
          new AbortController().signal,
        ),
      ).rejects.toThrow("gtc or ioc");
    }
    await expect(
      createAlpacaExecutionAdapter({ instruments: [instrument], postJson }).execute(
        { ...intent, stopPrice: 90 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("refusing unprotected entry");
    expect(postJson).not.toHaveBeenCalled();
  },
);

it.each([null, "", " ", false, undefined, "broken", {}])(
  "rejects malformed terminal quantity %s as uncertain",
  async (filled_qty) => {
    for (const status of ["canceled", "expired", "rejected"]) {
      const adapter = createAlpacaExecutionAdapter({
        instruments: ["AAPL"],
        postJson: transport({
          id: "bad-fill",
          status,
          filled_qty,
          updated_at: "2026-09-20T00:00:00Z",
        }).fn,
      });
      await expect(
        adapter.execute(baseIntent, new AbortController().signal),
      ).rejects.toBeInstanceOf(AlpacaOrderUncertainError);
    }
  },
);
