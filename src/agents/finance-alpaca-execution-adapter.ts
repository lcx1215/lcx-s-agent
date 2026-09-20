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
};

function normalizeInstrument(value: string): string {
  return value.trim().toUpperCase();
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createAlpacaExecutionAdapter(
  options: AlpacaExecutionAdapterOptions,
): FinanceExecutionAdapter {
  const id = options.id?.trim() || "alpaca-venue";
  const mode = options.mode ?? "paper";
  const host = mode === "live" ? LIVE_HOST : PAPER_HOST;
  const orderTypes = options.orderTypes ?? (["market", "limit"] as const);
  const timeInForce = options.timeInForce ?? "day";
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
      const symbol = normalizeInstrument(intent.instrument);
      if (instruments.length > 0 && !instruments.includes(symbol)) {
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
        symbol,
        qty: String(intent.quantity),
        side: intent.side,
        type: intent.orderType,
        time_in_force: timeInForce,
      };
      if (intent.orderType === "limit") {
        body.limit_price = String(intent.limitPrice);
      }
      if (intent.stopPrice !== undefined) {
        // Sizing assumes a stop exists; the order has to carry it or the
        // assumption is fiction.
        body.order_class = "bracket";
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
      const response = await options.postJson(`${host}/v2/orders`, {
        headers: {
          "APCA-API-KEY-ID": keyId,
          "APCA-API-SECRET-KEY": secret,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      const text = response.body;
      let payload: AlpacaOrderResponse = {};
      try {
        payload = JSON.parse(text) as AlpacaOrderResponse;
      } catch {
        throw new Error(`Alpaca returned a non-JSON response (http ${response.status})`);
      }

      if (response.status < 200 || response.status >= 300) {
        const message = typeof payload.message === "string" ? payload.message : text.slice(0, 160);
        throw new Error(`Alpaca order rejected (http ${response.status}): ${message}`);
      }

      const orderId = typeof payload.id === "string" ? payload.id : "unknown-order-id";
      // Provenance carries the venue host so a paper fill can never be read as a
      // live market observation, and the order stays traceable.
      const venueRef = `alpaca:${mode}:${orderId}`;

      // The submit response is not the outcome. Alpaca fills asynchronously: a
      // paper crypto market order was observed returning filled_qty 0 here and
      // then filling seconds later. Reporting that snapshot as "unfilled" would
      // hide a real position from the position ledger, so when the caller opts in
      // the order is polled until it reaches a terminal state.
      if (options.fillPoll) {
        const timeoutMs = options.fillPoll.timeoutMs ?? 10_000;
        const intervalMs = options.fillPoll.intervalMs ?? 200;
        const statusFetch = options.statusFetch ?? createFinanceUncachedFetch();
        const authHeaders = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const statusResponse = await statusFetch(`${host}/v2/orders/${orderId}`, {
            headers: authHeaders,
            signal,
          });
          let status = "";
          let polledQty = 0;
          let polledPrice = 0;
          try {
            const parsed = JSON.parse(statusResponse.body) as AlpacaOrderResponse;
            status = typeof parsed.status === "string" ? parsed.status : "";
            polledQty = asFiniteNumber(parsed.filled_qty) ?? 0;
            polledPrice = asFiniteNumber(parsed.filled_avg_price) ?? 0;
          } catch {
            throw new Error(`Alpaca order ${orderId} returned a non-JSON status response`);
          }
          if (polledQty > 0 && polledPrice > 0) {
            return Object.freeze({
              filledQuantity: polledQty,
              fillPrice: polledPrice,
              filledAt: new Date().toISOString(),
              venueRef,
            });
          }
          if (status === "canceled" || status === "expired" || status === "rejected") {
            // A genuinely unfilled order: zero here is true, not assumed.
            return Object.freeze({
              filledQuantity: 0,
              fillPrice: 0,
              filledAt: new Date().toISOString(),
              venueRef,
            });
          }
          if (Date.now() >= deadline) {
            // Unknown is not unfilled, and the fill contract has no slot for
            // "unknown", so refuse rather than let a caller record a zero.
            throw new Error(
              `Alpaca order ${orderId} was submitted but its fill state is unknown after ${timeoutMs}ms; refusing to report a fill`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }

      const filledQuantity = asFiniteNumber(payload.filled_qty) ?? 0;
      const fillPrice = asFiniteNumber(payload.filled_avg_price) ?? 0;

      return Object.freeze({
        filledQuantity,
        fillPrice,
        filledAt: new Date().toISOString(),
        venueRef,
      });
    },
  });
}
