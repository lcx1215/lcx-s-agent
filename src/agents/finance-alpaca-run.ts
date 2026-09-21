import { createAlpacaExecutionAdapter } from "./finance-alpaca-execution-adapter.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import {
  placeFinanceOrder,
  type FinanceExecutionReceipt,
  type FinanceRiskBudget,
} from "./finance-execution-adapter.js";
import type { FinanceExecutionSafetyContextFactory } from "./finance-execution-safety.js";
import {
  compileExecutionIntent,
  type FinanceResearchConclusion,
} from "./finance-intent-compiler.js";
import type { FinanceStrategyClass } from "./finance-mandate.js";
import {
  createFinanceUncachedFetch,
  createFinanceWriteTransport,
  type FinanceUncachedFetch,
  type FinanceWriteTransport,
} from "./finance-write-transport.js";

/**
 * The venue call site: conclusion -> compiled intent -> Alpaca order -> receipt.
 *
 * Same shape as `runFinancePaperOrder` and same gates (the compiler still sizes from a declared
 * stop, the placement guard still enforces the declared budget). The only difference is the
 * adapter: fills come from the venue, and it is the venue that decides whether they happen.
 *
 * Two deliberate constraints:
 *
 * 1. **Paper is the default.** Live has to be asked for with `mode: "live"`, and the adapter
 *    refuses a `PK` key against the live host instead of surfacing an opaque 401.
 * 2. **Nothing is invented.** An accepted-but-unfilled order reports zero filled. Polling is
 *    therefore on by default (`DEFAULT_ALPACA_FILL_POLL`): the submit response of a market
 *    order usually says `filled_qty: 0` and fills seconds later, and recording that snapshot
 *    would hide a real position from the ledger — the next cycle would then buy again what
 *    the book already owns. `fillPoll: false` is the explicit opt-out.
 *
 * Egress goes through `createFinanceWriteTransport`, so the proxy decision is the declared one
 * (`decideFinanceProxy`) rather than whatever the ambient environment happens to export.
 *
 * No model call, no market data, no prediction: this module only executes a decision.
 */

export const FINANCE_ALPACA_ADAPTER_ID = "alpaca-venue";

/**
 * How long to wait for the venue to report a fill before refusing.
 *
 * A refusal is deliberate: an order that was submitted but whose state is unknown is not an
 * unfilled order, and a zero recorded for it would silently delete a position.
 */
export const DEFAULT_ALPACA_FILL_POLL = Object.freeze({
  timeoutMs: 15_000,
  intervalMs: 500,
});

/** Sizing from a guessed equity is a defect, so the real number is read rather than assumed. */
export type AlpacaAccountSnapshot = Readonly<{
  equity: number;
  cash: number;
  buyingPower: number;
  currency: string;
  status: string;
  tradingBlocked: boolean;
}>;

export async function fetchAlpacaAccountSnapshot(
  options: { read?: FinanceUncachedFetch } = {},
): Promise<{ ok: true; account: AlpacaAccountSnapshot } | { ok: false; reason: string }> {
  const env = resolveFinanceCredentialEnv(process.env) as Record<string, unknown>;
  const keyId = typeof env.ALPACA_API_KEY_ID === "string" ? env.ALPACA_API_KEY_ID.trim() : "";
  const secret =
    typeof env.ALPACA_API_SECRET_KEY === "string" ? env.ALPACA_API_SECRET_KEY.trim() : "";
  if (!keyId || !secret) {
    return { ok: false, reason: "Alpaca credentials are not configured" };
  }

  const read = options.read ?? createFinanceUncachedFetch();
  try {
    const response = await read("https://paper-api.alpaca.markets/v2/account", {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200) {
      return {
        ok: false,
        reason: `account read returned ${response.status}: ${response.body.slice(0, 200)}`,
      };
    }
    const parsed: unknown = JSON.parse(response.body);
    const record = (parsed ?? {}) as Record<string, unknown>;
    const number = (key: string): number => {
      const value = Number(record[key]);
      return Number.isFinite(value) ? value : Number.NaN;
    };
    const equity = number("equity");
    if (!Number.isFinite(equity)) {
      return { ok: false, reason: "account read returned no usable equity" };
    }
    if (typeof record.trading_blocked !== "boolean") {
      return { ok: false, reason: "account read returned no explicit trading_blocked boolean" };
    }
    return {
      ok: true,
      account: Object.freeze({
        equity,
        cash: number("cash"),
        buyingPower: number("buying_power"),
        currency: typeof record.currency === "string" ? record.currency : "USD",
        status: typeof record.status === "string" ? record.status : "UNKNOWN",
        tradingBlocked: record.trading_blocked,
      }),
    };
  } catch (error) {
    return { ok: false, reason: String(error instanceof Error ? error.message : error) };
  }
}

/**
 * What the venue says it currently holds: unfilled orders and open positions, by symbol.
 *
 * This is the answer to "did my last order actually fill?", and asking is the whole point: a
 * ledger that missed a fill cannot answer it, and a guessed answer is how one instrument gets
 * bought twice.
 */
/**
 * An order the venue has finished with.
 *
 * Reading only open orders makes a cancelled or rejected order indistinguishable
 * from one that was never sent - the system believed fifteen orders had been
 * placed while the venue had cancelled every one of them, and nothing could see
 * it. A person at the computer would notice; this is what lets the system.
 */
export type AlpacaVenueOrder = Readonly<{
  symbol: string;
  side: string;
  qty: number;
  status: string;
  filledQty: number;
  filledAvgPrice: number | null;
  submittedAt: string;
  terminalAt: string | null;
}>;

export type AlpacaVenueState = Readonly<{
  /** Unfilled order count per symbol. */
  openOrders: ReadonlyMap<string, number>;
  /** Signed position quantity per symbol; absent means flat there. */
  positions: ReadonlyMap<string, number>;
  /** Recently closed orders, newest first. The record of what actually happened. */
  recentOrders: readonly AlpacaVenueOrder[];
}>;

function parseVenueArray(text: string, what: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`${what} read did not return a list`);
  }
  return parsed;
}

/** Read the venue's own open orders and positions. Injected read keeps this testable. */
export async function fetchAlpacaVenueState(
  options: { read?: FinanceUncachedFetch } = {},
): Promise<{ ok: true; state: AlpacaVenueState } | { ok: false; reason: string }> {
  const env = resolveFinanceCredentialEnv(process.env) as Record<string, unknown>;
  const keyId = typeof env.ALPACA_API_KEY_ID === "string" ? env.ALPACA_API_KEY_ID.trim() : "";
  const secret =
    typeof env.ALPACA_API_SECRET_KEY === "string" ? env.ALPACA_API_SECRET_KEY.trim() : "";
  if (!keyId || !secret) {
    return { ok: false, reason: "Alpaca credentials are not configured" };
  }

  const read = options.read ?? createFinanceUncachedFetch();
  const headers = {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secret,
    accept: "application/json",
  };
  try {
    const [orders, positions, closed] = await Promise.all([
      read("https://paper-api.alpaca.markets/v2/orders?status=open&limit=100", { headers }),
      read("https://paper-api.alpaca.markets/v2/positions", { headers }),
      // Closed orders are the record of what happened. Without them a cancelled
      // order and an order that was never sent look identical from here.
      read("https://paper-api.alpaca.markets/v2/orders?status=closed&limit=100&direction=desc", {
        headers,
      }),
    ]);
    if (orders.status !== 200) {
      return { ok: false, reason: `open orders read returned ${orders.status}` };
    }
    if (positions.status !== 200) {
      return { ok: false, reason: `positions read returned ${positions.status}` };
    }
    if (closed.status !== 200) {
      return { ok: false, reason: `closed orders read returned ${closed.status}` };
    }

    const recentOrders: AlpacaVenueOrder[] = parseVenueArray(closed.body, "closed orders").flatMap(
      (row) => {
        const record = row as Record<string, unknown>;
        const symbol = typeof record.symbol === "string" ? record.symbol : "";
        if (symbol.length === 0) {
          return [];
        }
        const filledAvgPrice = Number(record.filled_avg_price);
        return [
          {
            symbol,
            side: typeof record.side === "string" ? record.side : "",
            qty: Number(record.qty),
            status: typeof record.status === "string" ? record.status : "",
            filledQty: Number(record.filled_qty),
            filledAvgPrice: Number.isFinite(filledAvgPrice) ? filledAvgPrice : null,
            submittedAt: typeof record.submitted_at === "string" ? record.submitted_at : "",
            terminalAt:
              typeof record.canceled_at === "string"
                ? record.canceled_at
                : typeof record.filled_at === "string"
                  ? record.filled_at
                  : null,
          },
        ];
      },
    );

    const openOrders = new Map<string, number>();
    for (const row of parseVenueArray(orders.body, "open orders")) {
      const symbol =
        typeof (row as { symbol?: unknown }).symbol === "string"
          ? (row as { symbol: string }).symbol
          : "";
      if (symbol.length === 0) {
        continue;
      }
      const key = symbol.toUpperCase();
      openOrders.set(key, (openOrders.get(key) ?? 0) + 1);
    }

    const held = new Map<string, number>();
    for (const row of parseVenueArray(positions.body, "positions")) {
      const record = row as { symbol?: unknown; qty?: unknown };
      const symbol = typeof record.symbol === "string" ? record.symbol : "";
      const qty = Number(record.qty);
      if (symbol.length === 0 || !Number.isFinite(qty)) {
        continue;
      }
      held.set(symbol.toUpperCase(), qty);
    }

    return { ok: true, state: Object.freeze({ openOrders, positions: held, recentOrders }) };
  } catch (error) {
    return { ok: false, reason: String(error instanceof Error ? error.message : error) };
  }
}

export type FinanceAlpacaRunRequest = Readonly<{
  createSafetyContext?: FinanceExecutionSafetyContextFactory;
  conclusion: FinanceResearchConclusion;
  signal?: AbortSignal;
  /** Observed price and the time it belongs to. "Now" is never assumed. */
  market: { referencePrice: number; referencePriceAt: string };
  /** Account equity in the same currency as the reference price. */
  equity: number;
  /** The explicit authorization that admitted this run. Empty is refused. */
  runAuthorizationId: string;
  /** Required, never defaulted. An `unattended` budget must declare every cap. */
  budget: FinanceRiskBudget;
  /** Instruments the adapter admits. An empty list admits nothing. */
  instruments: readonly string[];
  strategyClass?: FinanceStrategyClass;
  minConviction?: number;
  committedInstrumentNotional?: number;
  ordersPlacedThisRun?: number;
  recordedAt?: string;
  /** `"paper"` (default) or `"live"`. Live must be asked for explicitly. */
  mode?: "paper" | "live";
  timeInForce?: "day" | "gtc" | "ioc" | "fok";
  /**
   * Polling the venue for the real fill is on by default; `false` opts out and reports the
   * submit response as-is. Off by default would trade a real position for a zero.
   */
  fillPoll?: { timeoutMs?: number; intervalMs?: number } | false;
  /**
   * The write transport and the status read are injectable, and both default to the real
   * declared-egress ones: a caller who says nothing still reaches the venue.
   */
  transport?: FinanceWriteTransport;
  read?: FinanceUncachedFetch;
}>;

export type FinanceAlpacaRunResult = Readonly<
  | { ok: true; receipt: FinanceExecutionReceipt; notes: readonly string[] }
  | { ok: false; stage: "compile" | "place"; refusals: readonly string[] }
>;

export async function runFinanceAlpacaOrder(
  request: FinanceAlpacaRunRequest,
): Promise<FinanceAlpacaRunResult> {
  if (request.conclusion.conclusionId.trim().length === 0) {
    return {
      ok: false,
      stage: "compile",
      refusals: Object.freeze(["refuse: conclusion needs an id; the intent id derives from it"]),
    };
  }

  if (!request.createSafetyContext) {
    return {
      ok: false,
      stage: "place",
      refusals: ["execution_safety_context_required: trusted controller facts unavailable"],
    };
  }

  const compiled = compileExecutionIntent({
    conclusion: request.conclusion,
    market: request.market,
    equity: request.equity,
    runAuthorizationId: request.runAuthorizationId,
    ...(request.strategyClass === undefined ? {} : { strategyClass: request.strategyClass }),
    ...(request.minConviction === undefined ? {} : { minConviction: request.minConviction }),
  });
  if (!compiled.ok) {
    return Object.freeze({ ok: false, stage: "compile", refusals: compiled.refusals });
  }

  const fillPoll =
    request.fillPoll === false ? undefined : (request.fillPoll ?? DEFAULT_ALPACA_FILL_POLL);

  // A DAY OTO stop expires at the close even when its bought shares remain held.
  // Preserve explicit caller time-in-force and the adapter's crypto/fractional rules.
  const timeInForce =
    request.timeInForce ??
    (request.conclusion.assetClass?.trim().toLowerCase() === "us_equity" &&
    compiled.intent.side === "buy" &&
    Number.isInteger(compiled.intent.quantity) &&
    compiled.intent.stopPrice !== undefined
      ? "gtc"
      : undefined);
  const transport = request.transport ?? createFinanceWriteTransport();
  const adapter = createAlpacaExecutionAdapter({
    id: FINANCE_ALPACA_ADAPTER_ID,
    instruments: request.instruments,
    ...(request.mode === undefined ? {} : { mode: request.mode }),
    postJson: (url, init) =>
      transport({ url, headers: init.headers, body: init.body, signal: init.signal }),
    statusFetch: request.read ?? createFinanceUncachedFetch(),
    ...(timeInForce === undefined ? {} : { timeInForce }),
    ...(fillPoll === undefined ? {} : { fillPoll }),
  });

  const placed = await placeFinanceOrder({
    mode: "live_execution",
    safetyContext: request.createSafetyContext?.({
      intent: compiled.intent,
      budget: request.budget,
      adapterId: adapter.id,
      venue: adapter.venue,
    }),
    signal: request.signal,
    intent: compiled.intent,
    budget: request.budget,
    adapters: [adapter],
    executionAdapterId: adapter.id,
    committedInstrumentNotional: request.committedInstrumentNotional ?? 0,
    ordersPlacedThisRun: request.ordersPlacedThisRun ?? 0,
    ...(request.recordedAt === undefined ? {} : { recordedAt: request.recordedAt }),
  });

  if (placed.status !== "placed" || placed.receipt === undefined) {
    return Object.freeze({ ok: false, stage: "place", refusals: placed.refusalReasons });
  }

  return Object.freeze({ ok: true, receipt: placed.receipt, notes: compiled.notes });
}
