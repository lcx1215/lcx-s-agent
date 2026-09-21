/**
 * Alpaca venue execution adapter.
 *
 * Implements the same `FinanceExecutionAdapter` contract as the paper adapter.
 * Unlike the paper adapter it touches a real venue, so three rules are enforced
 * here rather than left to the caller:
 *
 * 1. **Paper is the default.** `kind` is still `"venue"` (this really places an
 *    order), but the default endpoint is Alpaca's *paper* host. Live trading has
 *    to be asked for explicitly with `mode: "live"`, and a live request with a
 *    paper key is refused instead of being sent to fail with an opaque 401.
 * 2. **The key prefix is checked.** Alpaca paper keys start with `PK` and live
 *    keys with `AK`. Sending a `PK` key to the live host can only ever 401, so it
 *    is rejected locally with a readable message.
 * 3. **No fill is invented.** The reported quantity and price come from the venue
 *    response (`filled_qty` / `filled_avg_price`). An order that is accepted but
 *    not filled reports zero filled — never an assumed fill price.
 *
 * Credentials are resolved through `resolveFinanceCredentialEnv`, the same path
 * every other finance source uses. This adapter never logs or returns them.
 */

import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import type {
  FinanceExecutionAdapter,
  FinanceExecutionFill,
  FinanceExecutionIntent,
  FinanceOrderType,
} from "./finance-execution-adapter.js";
import type { FetchImpl } from "./finance-live-market-source.js";
import {
  createFinanceUncachedFetch,
  type FinanceUncachedFetch,
} from "./finance-write-transport.js";

const PAPER_HOST = "https://paper-api.alpaca.markets";
const LIVE_HOST = "https://api.alpaca.markets";

export type AlpacaExecutionAdapterOptions = {
  id?: string;
  instruments: readonly string[];
  orderTypes?: readonly FinanceOrderType[];
  /** `"paper"` (default) or `"live"`. Live must be asked for explicitly. */
  mode?: "paper" | "live";
  fetchImpl?: FetchImpl;
  /** Time in force passed to the venue. Defaults to `day`. */
  timeInForce?: "day" | "gtc" | "ioc" | "fok";
  /**
   * Write-capable transport for order placement. Required, because the shared
   * finance fetch seam is GET-only and the egress decision belongs to the caller.
   */
  postJson?: (
    url: string,
    init: { headers: Record<string, string>; body: string; signal: AbortSignal },
  ) => Promise<{ status: number; body: string }>;
  /**
   * Uncached read used to poll a submitted order. Injectable because the default
   * opens a real connection, which a unit test must not do.
   */
  statusFetch?: FinanceUncachedFetch;
  /**
   * Opt in to waiting for the real fill. Without it the submit response is
   * returned as-is, which reports zero for a fill that completes asynchronously.
   */
  fillPoll?: { timeoutMs?: number; intervalMs?: number };
};

type AlpacaOrderResponse = {
  id?: unknown;
  status?: unknown;
  filled_qty?: unknown;
  filled_avg_price?: unknown;
  symbol?: unknown;
  message?: unknown;
  client_order_id?: unknown;
  time_in_force?: unknown;
  order_class?: unknown;
  legs?: unknown;
  side?: unknown;
  qty?: unknown;
  type?: unknown;
  limit_price?: unknown;
  filled_at?: unknown;
  updated_at?: unknown;
};

function normalizeInstrument(value: string): string {
  return value.trim().toUpperCase();
}

function terminalFill(
  payload: AlpacaOrderResponse,
  orderId: string,
  venueRef: string,
  quantity: number,
): FinanceExecutionFill | undefined {
  if (!["filled", "canceled", "expired", "rejected"].includes(String(payload.status))) {
    return undefined;
  }
  const filledQuantity = asFiniteNumber(payload.filled_qty);
  const fillPrice = asFiniteNumber(payload.filled_avg_price) ?? 0;
  if (
    filledQuantity === undefined ||
    filledQuantity < 0 ||
    filledQuantity > quantity ||
    (filledQuantity > 0 && fillPrice <= 0) ||
    (payload.status === "filled" && filledQuantity !== quantity)
  ) {
    throw new Error("invalid terminal fill quantity or price");
  }
  const timestamp = payload.filled_at ?? payload.updated_at;
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("terminal fill requires venue event timestamp");
  }
  return Object.freeze({
    filledQuantity,
    fillPrice: filledQuantity === 0 ? 0 : fillPrice,
    filledAt: new Date(timestamp).toISOString(),
    venueRef,
    terminalOrderIdentity: { orderId, terminal: true as const },
  });
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class AlpacaOrderUncertainError extends Error {
  readonly code = "alpaca_order_uncertain";
  constructor(
    readonly clientOrderId: string,
    readonly orderId: string | undefined,
    cause: unknown,
  ) {
    super(
      `Alpaca order ${orderId ?? clientOrderId} was submitted but its fill state is unknown; refusing to report a fill`,
      { cause },
    );
    this.name = "AlpacaOrderUncertainError";
  }
}
export function isAlpacaOrderUncertain(error: unknown): error is AlpacaOrderUncertainError {
  return error instanceof AlpacaOrderUncertainError;
}
function bounded<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Alpaca request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createAlpacaExecutionAdapter(
  options: AlpacaExecutionAdapterOptions,
): FinanceExecutionAdapter {
  const id = options.id?.trim() || "alpaca-venue";
  const mode = options.mode ?? "paper";
  const host = mode === "live" ? LIVE_HOST : PAPER_HOST;
  const orderTypes = options.orderTypes ?? (["market", "limit"] as const);

  const instruments = Object.freeze(options.instruments.map(normalizeInstrument));

  return Object.freeze({
    id,
    venue: `alpaca:${mode}`,
    kind: "venue" as const,
    orderTypes: Object.freeze([...orderTypes]),
    instruments,
    credentialsAuthority: "external" as const,

    execute: async (
      intent: FinanceExecutionIntent,
      signal: AbortSignal,
    ): Promise<FinanceExecutionFill> => {
      signal.throwIfAborted();
      const timeoutMs = options.fillPoll?.timeoutMs ?? 30_000;
      const intervalMs = options.fillPoll?.intervalMs ?? 200;
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs < 0 ||
        !Number.isFinite(intervalMs) ||
        intervalMs < 0
      ) {
        throw new Error("fillPoll requires a finite non-negative timeoutMs and intervalMs");
      }
      if (!intent.intentId.trim() || !intent.runAuthorizationId.trim()) {
        throw new Error("Alpaca order requires intent identity and explicit run authorization");
      }
      const clientOrderId = `lcx-${createHash("sha256")
        .update(JSON.stringify([mode, intent.runAuthorizationId, intent.intentId]))
        .digest("hex")
        .slice(0, 40)}`;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("Alpaca execution deadline exceeded")),
        Math.min(timeoutMs, 2_147_483_647),
      );
      signal = AbortSignal.any([signal, controller.signal]);
      let submitted = false;
      let knownOrderId: string | undefined;
      try {
        const symbol = normalizeInstrument(intent.instrument);
        const isCrypto = symbol.includes("/");
        const timeInForce = options.timeInForce ?? (isCrypto ? "gtc" : "day");
        if (isCrypto && timeInForce !== "gtc" && timeInForce !== "ioc") {
          throw new Error("Alpaca crypto requires gtc or ioc time_in_force");
        }
        if (isCrypto && intent.side === "buy" && intent.stopPrice !== undefined) {
          throw new Error(
            "Alpaca crypto does not support the declared OTO protective stop; refusing unprotected entry",
          );
        }
        // The shared contract declares this field as "Instruments this adapter accepts. Empty accepts
        // nothing", and `admitsInstrument` in `finance-execution-adapter.ts` implements exactly that.
        // This check was written as `instruments.length > 0 && !instruments.includes(symbol)`, so an
        // empty list accepted *every* symbol -- the opposite of the contract, and in the widening
        // direction. `placeFinanceOrder` masks it because it refuses first, but `execute` belongs to the
        // exported adapter object and both real callers pass a caller-supplied list straight through, so
        // `instruments: []` reaching here meant "trade anything".
        if (!instruments.includes(symbol)) {
          throw new Error(`Alpaca adapter is not declared for instrument ${symbol}`);
        }
        if (!orderTypes.includes(intent.orderType)) {
          throw new Error(`Alpaca adapter does not accept order type ${intent.orderType}`);
        }
        if (intent.orderType === "limit" && intent.limitPrice === undefined) {
          throw new Error("a limit order requires limitPrice; refusing to infer one");
        }

        const env = resolveFinanceCredentialEnv(process.env) as Record<string, unknown>;
        const keyId = typeof env.ALPACA_API_KEY_ID === "string" ? env.ALPACA_API_KEY_ID.trim() : "";
        const secret =
          typeof env.ALPACA_API_SECRET_KEY === "string" ? env.ALPACA_API_SECRET_KEY.trim() : "";
        if (!keyId || !secret) {
          throw new Error("Alpaca credentials are not configured");
        }

        // A `PK` key can only ever 401 against the live host; refuse locally so the
        // failure is readable instead of an opaque authentication error.
        if (mode === "live" && keyId.toUpperCase().startsWith("PK")) {
          throw new Error(
            "refusing live order: ALPACA_API_KEY_ID is a paper key (PK…); a funded live key (AK…) is required",
          );
        }
        if (mode === "paper" && keyId.toUpperCase().startsWith("AK")) {
          throw new Error(
            'refusing paper order: ALPACA_API_KEY_ID is a live key (AK…); pass mode: "live" if that is intended',
          );
        }

        const body: Record<string, unknown> = {
          client_order_id: clientOrderId,
          symbol,
          qty: String(intent.quantity),
          side: intent.side,
          type: intent.orderType,
          time_in_force: timeInForce,
        };
        if (intent.orderType === "limit") {
          body.limit_price = String(intent.limitPrice);
        }
        // A bracket protects an ENTRY. Sizing already assumed a stop and used it, so the stop
        // has done its real job before this line; whether the order carries one is a different
        // question.
        //
        // For a sell it must not. Two independent reasons: Alpaca requires a sell's `stop_loss`
        // to sit ABOVE the market (below is a 422), and a sell here is a reduction — the legs
        // would be acting on a position the order just flattened. Sending it anyway would turn
        // the exit path into a guaranteed rejection, i.e. a book that can enter and never leave.
        //
        // This system declares no short selling, so "sell" means "reduce". If shorting is ever
        // admitted, that needs its own flag on the intent, not a bracket inferred from a side.
        if (intent.stopPrice !== undefined && intent.side === "buy") {
          // Alpaca's `bracket` requires BOTH exit legs, and it rejects one with only a stop:
          // "bracket orders require take_profit.limit_price". A take-profit is a price target,
          // and this system has no business inventing one — the rule declares an invalidation
          // level and no upside target, and a threshold the caller did not state is exactly what
          // "the model must not carry its own thresholds" forbids.
          //
          // `oto` is the construct that matches what was actually declared: fill the entry, then
          // place the stop. Nothing is guessed, and the entry still carries its protection.
          body.order_class = "oto";
          body.stop_loss = { stop_price: String(intent.stopPrice) };
        }

        // The shared finance fetch seam (`FetchImpl = ApiFetch`) is GET-only: it
        // exists to read market data, and it owns the egress guard every finance
        // adapter must go through. Order placement needs a write, so the write path
        // is injected by the caller instead of being smuggled around that seam.
        // Keeping it a required option means "who may open an outbound order
        // connection" stays an explicit, caller-owned decision.
        if (!options.postJson) {
          throw new Error("Alpaca adapter requires a postJson transport for order placement");
        }
        const headers = {
          "APCA-API-KEY-ID": keyId,
          "APCA-API-SECRET-KEY": secret,
          "content-type": "application/json",
        };
        const statusFetch = options.statusFetch ?? createFinanceUncachedFetch();
        async function recover(cause: unknown): Promise<AlpacaOrderResponse> {
          try {
            const response = await bounded(
              () =>
                statusFetch(
                  `${host}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
                  { headers, signal },
                ),
              signal,
            );
            if (response.status !== 200) {
              throw new Error(`reconciliation returned http ${response.status}`);
            }
            const found = JSON.parse(response.body) as AlpacaOrderResponse;
            if (
              found.client_order_id !== clientOrderId ||
              found.symbol !== symbol ||
              found.side !== intent.side ||
              Number(found.qty) !== intent.quantity ||
              found.type !== intent.orderType ||
              found.time_in_force !== timeInForce ||
              (body.order_class === "oto" &&
                (found.order_class !== "oto" ||
                  !Array.isArray(found.legs) ||
                  !found.legs.some(
                    (leg: unknown) =>
                      typeof leg === "object" &&
                      leg !== null &&
                      "stop_price" in leg &&
                      asFiniteNumber(leg.stop_price) === intent.stopPrice,
                  ))) ||
              (intent.orderType === "limit" && Number(found.limit_price) !== intent.limitPrice) ||
              typeof found.id !== "string" ||
              !found.id
            ) {
              throw new Error("reconciled order does not match authorized intent");
            }
            return found;
          } catch (error) {
            throw new AlpacaOrderUncertainError(
              clientOrderId,
              knownOrderId,
              new AggregateError([cause, error], "submission reconciliation failed"),
            );
          }
        }
        let payload: AlpacaOrderResponse;
        let response: { status: number; body: string };
        try {
          response = await bounded(() => {
            submitted = true;
            return options.postJson!(`${host}/v2/orders`, {
              headers,
              body: JSON.stringify(body),
              signal,
            });
          }, signal);
        } catch (error) {
          if (!submitted) {
            throw error;
          }
          payload = await recover(error);
          response = { status: 200, body: JSON.stringify(payload) };
        }
        try {
          payload = JSON.parse(response.body) as AlpacaOrderResponse;
        } catch (error) {
          throw new AlpacaOrderUncertainError(clientOrderId, knownOrderId, error);
        }
        if (response.status < 200 || response.status >= 300) {
          const message =
            typeof payload.message === "string" ? payload.message : response.body.slice(0, 160);
          if (
            response.status >= 500 ||
            ((response.status === 409 || response.status === 422) &&
              /client_order_id/i.test(message))
          ) {
            payload = await recover(new Error(`Alpaca submission http ${response.status}`));
          } else {
            submitted = false;
            throw new Error(`Alpaca order rejected (http ${response.status}): ${message}`);
          }
        }
        const orderId = typeof payload.id === "string" && payload.id ? payload.id : undefined;
        if (!orderId) {
          throw new AlpacaOrderUncertainError(
            clientOrderId,
            undefined,
            new Error("missing order identity"),
          );
        }
        knownOrderId = orderId;
        // Provenance carries the venue host so a paper fill can never be read as a
        // live market observation, and the order stays traceable.
        const venueRef = `alpaca:${mode}:${orderId}`;

        // The submit response is not the outcome. Alpaca fills asynchronously: a
        // paper crypto market order was observed returning filled_qty 0 here and
        // then filling seconds later. Reporting that snapshot as "unfilled" would
        // hide a real position from the position ledger, so when the caller opts in
        // the order is polled until it reaches a terminal state.
        if (options.fillPoll) {
          const authHeaders = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
          for (;;) {
            const statusResponse = await bounded(
              () =>
                statusFetch(`${host}/v2/orders/${encodeURIComponent(orderId)}`, {
                  headers: authHeaders,
                  signal,
                }),
              signal,
            );
            if (statusResponse.status !== 200) {
              throw new Error(`order status returned http ${statusResponse.status}`);
            }
            const parsed = JSON.parse(statusResponse.body) as AlpacaOrderResponse;
            if (typeof parsed.id === "string" && parsed.id !== orderId) {
              throw new Error("order status identity mismatch");
            }
            const terminal = terminalFill(parsed, orderId, venueRef, intent.quantity);
            if (terminal) {
              return terminal;
            }
            await bounded(() => delay(intervalMs, undefined, { signal }), signal);
          }
        }

        const terminal = terminalFill(payload, orderId, venueRef, intent.quantity);
        if (terminal) {
          return terminal;
        }
        const filledQuantity = asFiniteNumber(payload.filled_qty) ?? 0;
        const fillPrice = asFiniteNumber(payload.filled_avg_price) ?? 0;

        return Object.freeze({
          filledQuantity,
          fillPrice,
          filledAt: new Date().toISOString(),
          venueRef,
        });
      } catch (error) {
        if (submitted && !(error instanceof AlpacaOrderUncertainError)) {
          throw new AlpacaOrderUncertainError(clientOrderId, knownOrderId, error);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
