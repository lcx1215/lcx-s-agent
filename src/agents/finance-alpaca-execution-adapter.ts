import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
  FinanceExecutionProtection,
  FinanceOrderType,
} from "./finance-execution-adapter.js";
import {
  FinanceExecutionSafetyDispatchError,
  type FinanceExecutionSafetyFacts,
} from "./finance-execution-safety.js";
import type { FetchImpl } from "./finance-live-market-source.js";
import { executeFinanceProtectedReduction } from "./finance-protection-coordination.js";
import {
  isLegalUsEquityPrice,
  isValidAlpacaLongStopDistance,
} from "./finance-us-equity-price-normalization.js";
import {
  createFinanceUncachedFetch,
  type FinanceUncachedFetch,
} from "./finance-write-transport.js";

const PAPER_HOST = "https://paper-api.alpaca.markets";
const LIVE_HOST = "https://api.alpaca.markets";

export type AlpacaExecutionAdapterOptions = {
  /** Controller-owned book; credential reads must use the same root as safety facts. */
  credentialStateDirectory?: string;
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
  cancelOrder?: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{ status: number; body: string }>;
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
  code?: unknown;
  client_order_id?: unknown;
  time_in_force?: unknown;
  order_class?: unknown;
  legs?: unknown;
  side?: unknown;
  qty?: unknown;
  type?: unknown;
  limit_price?: unknown;
  stop_price?: unknown;
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

export class AlpacaOrderRejectedError extends FinanceExecutionSafetyDispatchError {
  constructor(
    params:
      | string
      | {
          executionStage: "pre_dispatch" | "venue_response" | "unclassified";
          httpStatus?: number;
          brokerCode?: number;
          cause?: unknown;
        },
  ) {
    super(typeof params === "string" ? { executionStage: "unclassified" } : params);
    this.name = "AlpacaOrderRejectedError";
  }
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

export class AlpacaProtectionUncertainError extends Error {
  readonly code = "alpaca_protection_uncertain";
  constructor(
    readonly clientOrderId: string,
    readonly orderId: string | undefined,
    cause: unknown,
  ) {
    super(
      `Alpaca entry filled but protective order ${orderId ?? clientOrderId} is not confirmed; refusing to report a fill`,
      { cause },
    );
    this.name = "AlpacaProtectionUncertainError";
  }
}

export function isAlpacaProtectionUncertain(
  error: unknown,
): error is AlpacaProtectionUncertainError {
  return error instanceof AlpacaProtectionUncertainError;
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

function clientOrderIdentity(mode: "paper" | "live", intent: FinanceExecutionIntent): string {
  return `lcx-${createHash("sha256")
    .update(JSON.stringify([mode, intent.runAuthorizationId, intent.intentId]))
    .digest("hex")
    .slice(0, 40)}`;
}

function validateRecoveredOrder(
  found: AlpacaOrderResponse,
  intent: FinanceExecutionIntent,
  clientOrderId: string,
  timeInForce?: string,
): void {
  if (
    found.client_order_id !== clientOrderId ||
    found.symbol !== normalizeInstrument(intent.instrument) ||
    found.side !== intent.side ||
    Number(found.qty) !== intent.quantity ||
    found.type !== intent.orderType ||
    typeof found.time_in_force !== "string" ||
    !["day", "gtc", "ioc", "fok"].includes(found.time_in_force) ||
    (timeInForce !== undefined && found.time_in_force !== timeInForce) ||
    (intent.side === "buy" &&
      intent.stopPrice !== undefined &&
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
}

/** Read-only restart recovery; 404 and nonterminal states never authorize resubmission. */
export async function readAlpacaPaperTerminalOrder(options: {
  accountId: string;
  intent: FinanceExecutionIntent;
  credentials: { keyId: string; secret: string };
  read: FinanceUncachedFetch;
  signal: AbortSignal;
  timeInForce?: "day" | "gtc" | "ioc" | "fok";
}): Promise<FinanceExecutionFill | undefined> {
  const { intent, signal } = options;
  const headers = {
    "APCA-API-KEY-ID": options.credentials.keyId,
    "APCA-API-SECRET-KEY": options.credentials.secret,
  };
  if (
    !options.accountId.trim() ||
    !options.credentials.keyId.startsWith("PK") ||
    !options.credentials.secret
  ) {
    throw new Error("paper reconciliation binding invalid");
  }
  const account = await bounded(
    () => options.read(`${PAPER_HOST}/v2/account`, { headers, signal }),
    signal,
  );
  if (account.status !== 200 || JSON.parse(account.body).id !== options.accountId) {
    throw new Error("paper reconciliation account mismatch");
  }
  const clientOrderId = clientOrderIdentity("paper", intent);
  const response = await bounded(
    () =>
      options.read(
        `${PAPER_HOST}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
        { headers, signal },
      ),
    signal,
  );
  if (response.status === 404) {
    return undefined;
  }
  if (response.status !== 200) {
    throw new Error("paper reconciliation order unavailable");
  }
  const found = JSON.parse(response.body) as AlpacaOrderResponse;
  // Legacy claims do not persist transport time-in-force. Verify it when supplied;
  // otherwise reconcile the actual matching broker order without inventing a default.
  validateRecoveredOrder(found, intent, clientOrderId, options.timeInForce);
  const orderId = found.id as string;
  return terminalFill(found, orderId, `alpaca:paper:${orderId}`, intent.quantity);
}

export async function restoreAlpacaPaperProtection(options: {
  intent: FinanceExecutionIntent;
  quantity: number;
  stopPrice: number;
  /** Omitted only for legacy stop protection claims. */
  orderType?: "stop" | "stop_limit";
  limitPrice?: number;
  headers: Record<string, string>;
  signal: AbortSignal;
  read: FinanceUncachedFetch;
  postJson: NonNullable<AlpacaExecutionAdapterOptions["postJson"]>;
}) {
  const { intent, quantity, stopPrice, headers, signal, read } = options;
  const orderType = options.orderType ?? "stop";
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(stopPrice) ||
    stopPrice <= 0 ||
    !["stop", "stop_limit"].includes(orderType) ||
    (orderType === "stop" && options.limitPrice !== undefined) ||
    (orderType === "stop_limit" &&
      (!Number.isFinite(options.limitPrice) ||
        options.limitPrice! <= 0 ||
        options.limitPrice! > stopPrice))
  ) {
    throw new Error("invalid protective order restoration intent");
  }
  const clientId = `${clientOrderIdentity("paper", intent)}-protect`;
  const matchesProtection = (stop: Record<string, unknown>) =>
    stop.client_order_id === clientId &&
    stop.symbol === intent.instrument &&
    stop.side === "sell" &&
    stop.type === orderType &&
    stop.time_in_force === "gtc" &&
    asFiniteNumber(stop.qty) === quantity &&
    asFiniteNumber(stop.stop_price) === stopPrice &&
    (orderType === "stop_limit"
      ? asFiniteNumber(stop.limit_price) === options.limitPrice
      : stop.limit_price === undefined || stop.limit_price === null) &&
    stop.status === "new" &&
    asFiniteNumber(stop.filled_qty) === 0 &&
    typeof stop.id === "string" &&
    !!stop.id;
  const lookup = () =>
    bounded(
      () =>
        read(
          `${PAPER_HOST}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientId)}`,
          { headers, signal },
        ),
      signal,
    );
  let response = await lookup();
  if (response.status === 404) {
    try {
      response = await bounded(
        () =>
          options.postJson(`${PAPER_HOST}/v2/orders`, {
            headers,
            signal,
            body: JSON.stringify({
              client_order_id: clientId,
              symbol: intent.instrument,
              side: "sell",
              type: orderType,
              time_in_force: "gtc",
              qty: String(quantity),
              stop_price: String(stopPrice),
              ...(orderType === "stop_limit" ? { limit_price: String(options.limitPrice) } : {}),
            }),
          }),
        signal,
      );
    } catch {
      response = await lookup();
    }
    if (response.status === 409 || response.status === 422) {
      response = await lookup();
    }
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error("remaining protection not confirmed");
  }
  let stop = JSON.parse(response.body) as Record<string, unknown>;
  while (["accepted", "pending_new"].includes(typeof stop.status === "string" ? stop.status : "")) {
    await bounded(() => delay(100, undefined, { signal }), signal);
    response = await lookup();
    if (response.status !== 200) {
      throw new Error("remaining protection status unavailable");
    }
    stop = JSON.parse(response.body) as Record<string, unknown>;
  }
  if (!matchesProtection(stop)) {
    throw new Error("remaining protection identity or state mismatch");
  }
}

/** Called by the original pending resolver while it owns the shared account lock.
 * A missing/nonterminal sell never authorizes restoration or a repeated sell. */
export async function recoverAlpacaPaperProtectedReduction(options: {
  accountId: string;
  intent: FinanceExecutionIntent;
  positionQuantity: number;
  protection: NonNullable<FinanceExecutionSafetyFacts["protectiveOrders"]>[number];
  credentials: { keyId: string; secret: string };
  read: FinanceUncachedFetch;
  signal: AbortSignal;
  postJson: NonNullable<AlpacaExecutionAdapterOptions["postJson"]>;
}): Promise<FinanceExecutionFill | undefined> {
  const { intent, protection, positionQuantity, signal, read } = options;
  if (
    intent.side !== "sell" ||
    !Number.isFinite(positionQuantity) ||
    positionQuantity <= 0 ||
    protection.quantity !== positionQuantity ||
    intent.quantity > positionQuantity
  ) {
    throw new Error("invalid protected reduction recovery binding");
  }
  const fill = await readAlpacaPaperTerminalOrder(options);
  if (!fill) {
    return undefined;
  }
  const headers = {
    "APCA-API-KEY-ID": options.credentials.keyId,
    "APCA-API-SECRET-KEY": options.credentials.secret,
    "content-type": "application/json",
  };
  const get = (pathname: string) =>
    bounded(() => read(`${PAPER_HOST}${pathname}`, { headers, signal }), signal);
  const prior = await get(`/v2/orders/${encodeURIComponent(protection.id)}`);
  if (prior.status !== 200) {
    throw new Error("original protection recovery read unavailable");
  }
  const old = JSON.parse(prior.body) as Record<string, unknown>;
  const orderType = protection.orderType ?? "stop";
  if (
    old.id !== protection.id ||
    old.symbol !== intent.instrument ||
    old.side !== "sell" ||
    old.type !== orderType ||
    old.time_in_force !== "gtc" ||
    old.status !== "canceled" ||
    asFiniteNumber(old.qty) !== protection.quantity ||
    asFiniteNumber(old.filled_qty) !== 0 ||
    asFiniteNumber(old.stop_price) !== protection.stopPrice ||
    (orderType === "stop_limit"
      ? asFiniteNumber(old.limit_price) !== protection.limitPrice
      : old.limit_price !== undefined && old.limit_price !== null)
  ) {
    throw new Error("original protection recovery identity or terminal state mismatch");
  }
  const remaining = positionQuantity - fill.filledQuantity;
  const verifyPosition = async () => {
    const response = await get(`/v2/positions/${encodeURIComponent(intent.instrument)}`);
    if (response.status === 404 && remaining === 0) {
      return;
    }
    if (response.status !== 200) {
      throw new Error("protected recovery position unavailable");
    }
    const position = JSON.parse(response.body) as Record<string, unknown>;
    if (
      position.symbol !== intent.instrument ||
      position.side !== "long" ||
      asFiniteNumber(position.qty) !== remaining
    ) {
      throw new Error("protected recovery position changed");
    }
  };
  await verifyPosition();
  const response = await get(
    `/v2/orders?status=open&symbols=${encodeURIComponent(intent.instrument)}&limit=100&nested=true`,
  );
  if (response.status !== 200) {
    throw new Error("protected recovery open orders unavailable");
  }
  const open: unknown = JSON.parse(response.body);
  const clientId = `${clientOrderIdentity("paper", intent)}-protect`;
  if (
    !Array.isArray(open) ||
    open.length > 1 ||
    open.some(
      (order: Record<string, unknown>) =>
        remaining === 0 ||
        !order ||
        typeof order !== "object" ||
        order.client_order_id !== clientId ||
        order.symbol !== intent.instrument,
    )
  ) {
    throw new Error("protected recovery has competing open orders");
  }
  if (remaining > 0) {
    await restoreAlpacaPaperProtection({
      intent,
      quantity: remaining,
      stopPrice: protection.stopPrice,
      orderType,
      ...(protection.limitPrice === undefined ? {} : { limitPrice: protection.limitPrice }),
      headers,
      signal,
      read,
      postJson: options.postJson,
    });
    await verifyPosition();
  }
  return fill;
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
    supportsProtectedReduction: mode === "paper" && !!options.cancelOrder && !!options.postJson,

    execute: async (
      intent: FinanceExecutionIntent,
      signal: AbortSignal,
      facts?: FinanceExecutionSafetyFacts,
    ): Promise<FinanceExecutionFill> => {
      signal.throwIfAborted();
      if (
        mode === "paper" &&
        intent.side === "sell" &&
        facts?.protectiveOrders?.length === 1 &&
        intent.quantity > facts.positionQuantity - (facts.reservedSellQuantity ?? 0)
      ) {
        if (!options.cancelOrder || !options.postJson) {
          throw new Error("protected reduction transport unavailable");
        }
        const authorityRemainingMs = Date.parse(facts.expiresAt) - Date.now();
        if (!Number.isFinite(authorityRemainingMs) || authorityRemainingMs <= 0) {
          throw new AlpacaOrderRejectedError({ executionStage: "pre_dispatch" });
        }
        // The fill poll bound starts when the sell is submitted. Verification,
        // cancellation and protection restoration share the existing authority
        // deadline, rather than consuming the sell's terminal-fill budget.
        const reductionSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(authorityRemainingMs, 2_147_483_647)),
        ]);
        const env = resolveFinanceCredentialEnv({
          ...process.env,
          ...(options.credentialStateDirectory
            ? { LCX_FINANCE_STATE_DIR: options.credentialStateDirectory }
            : {}),
        });
        const key = env.ALPACA_API_KEY_ID,
          secret = env.ALPACA_API_SECRET_KEY;
        if (!key?.startsWith("PK") || !secret) {
          throw new Error("protected reduction requires paper credentials");
        }
        const headers = {
          "APCA-API-KEY-ID": key,
          "APCA-API-SECRET-KEY": secret,
          "content-type": "application/json",
        };
        const read =
          options.statusFetch ??
          createFinanceUncachedFetch({ directory: options.credentialStateDirectory });
        const get = async (path: string) => {
          const response = await bounded(
            () => read(`${PAPER_HOST}${path}`, { headers, signal: reductionSignal }),
            reductionSignal,
          );
          if (response.status !== 200) {
            throw new Error("protected reduction read unavailable");
          }
          return JSON.parse(response.body) as Record<string, unknown>;
        };
        const account = await get("/v2/account");
        if (account.id !== facts.accountId) {
          throw new Error("protected reduction account mismatch");
        }
        const protection = facts.protectiveOrders[0];
        const protectionType = protection.orderType ?? "stop";
        return executeFinanceProtectedReduction({
          instrument: intent.instrument,
          positionQuantity: facts.positionQuantity,
          sellQuantity: intent.quantity,
          protection,
          signal: reductionSignal,
          readStop: async () => {
            const order = await get(`/v2/orders/${encodeURIComponent(protection.id)}`);
            if (
              order.type !== protectionType ||
              order.side !== "sell" ||
              order.time_in_force !== "gtc" ||
              [order.qty, order.stop_price, order.filled_qty].some(
                (value) => asFiniteNumber(value) === undefined,
              ) ||
              (protectionType === "stop_limit"
                ? asFiniteNumber(order.limit_price) !== protection.limitPrice
                : order.limit_price !== undefined && order.limit_price !== null)
            ) {
              throw new Error("protection identity mismatch");
            }
            return {
              id: String(order.id),
              instrument: String(order.symbol),
              status: String(order.status),
              quantity: Number(order.qty),
              filledQuantity: Number(order.filled_qty),
              stopPrice: Number(order.stop_price),
              orderType: order.type === "stop_limit" ? "stop_limit" : "stop",
              ...(order.type === "stop_limit"
                ? { limitPrice: asFiniteNumber(order.limit_price) }
                : {}),
            };
          },
          cancelStop: async () => {
            const response = await bounded(
              () =>
                options.cancelOrder!(
                  `${PAPER_HOST}/v2/orders/${encodeURIComponent(protection.id)}`,
                  { headers, signal: reductionSignal },
                ),
              reductionSignal,
            );
            if (![200, 204].includes(response.status)) {
              throw new Error("protective cancellation unacknowledged");
            }
          },
          readPosition: async () => {
            const response = await bounded(
              () =>
                read(`${PAPER_HOST}/v2/positions/${encodeURIComponent(intent.instrument)}`, {
                  headers,
                  signal: reductionSignal,
                }),
              reductionSignal,
            );
            if (response.status === 404) {
              return 0;
            }
            if (response.status !== 200) {
              throw new Error("protected position unavailable");
            }
            const position = JSON.parse(response.body) as Record<string, unknown>;
            if (position.symbol !== intent.instrument || position.side !== "long") {
              throw new Error("protected position identity mismatch");
            }
            return Number(position.qty);
          },
          isDefinitelyRejected: (error) => error instanceof AlpacaOrderRejectedError,
          execute: () => {
            if (
              Date.parse(facts.expiresAt) <= Date.now() ||
              Date.parse(facts.quote.expiresAt) <= Date.now()
            ) {
              throw new AlpacaOrderRejectedError({ executionStage: "pre_dispatch" });
            }
            return createAlpacaExecutionAdapter({
              ...options,
              fillPoll: options.fillPoll ?? { timeoutMs: 30_000 },
            }).execute(intent, reductionSignal);
          },
          restoreProtection: async (quantity, stopPrice, orderType, limitPrice) => {
            await restoreAlpacaPaperProtection({
              intent,
              quantity,
              stopPrice,
              orderType,
              ...(limitPrice === undefined ? {} : { limitPrice }),
              headers,
              signal: reductionSignal,
              read,
              postJson: options.postJson!,
            });
          },
        });
      }
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
      const clientOrderId = clientOrderIdentity(mode, intent);
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
        if (!isCrypto && /^[A-Z][A-Z0-9.-]{0,9}$/u.test(symbol)) {
          const invalidTick =
            intent.side === "buy" &&
            intent.stopPrice !== undefined &&
            !isLegalUsEquityPrice(intent.stopPrice);
          if (
            invalidTick ||
            (intent.stopPrice !== undefined &&
              intent.side === "buy" &&
              !isValidAlpacaLongStopDistance(intent.stopPrice, intent.referencePrice))
          ) {
            throw new AlpacaOrderRejectedError({ executionStage: "pre_dispatch" });
          }
        }
        const timeInForce = options.timeInForce ?? (isCrypto ? "gtc" : "day");
        if (isCrypto && timeInForce !== "gtc" && timeInForce !== "ioc") {
          throw new Error("Alpaca crypto requires gtc or ioc time_in_force");
        }
        const protectedCryptoBuy =
          isCrypto && intent.side === "buy" && intent.stopPrice !== undefined;
        if (isCrypto && intent.side === "buy" && intent.protectionLimitPrice !== undefined) {
          if (intent.stopPrice === undefined) {
            throw new Error("crypto protectionLimitPrice requires an explicit stopPrice");
          }
          if (
            !Number.isFinite(intent.protectionLimitPrice) ||
            intent.protectionLimitPrice <= 0 ||
            intent.protectionLimitPrice > intent.stopPrice
          ) {
            throw new Error(
              "crypto protectionLimitPrice must be positive and at or below stopPrice",
            );
          }
        }
        if (protectedCryptoBuy && intent.protectionLimitPrice === undefined) {
          throw new Error(
            "Alpaca crypto protected buy requires an explicit stop-limit protection limitPrice; refusing unprotected entry",
          );
        }
        if (!isCrypto && intent.protectionLimitPrice !== undefined) {
          throw new Error("crypto stop-limit protection is only supported for crypto instruments");
        }
        if (protectedCryptoBuy && options.fillPoll === undefined) {
          throw new Error("Alpaca crypto protected buy requires confirmed fill polling");
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

        const env = resolveFinanceCredentialEnv({
          ...process.env,
          ...(options.credentialStateDirectory
            ? { LCX_FINANCE_STATE_DIR: options.credentialStateDirectory }
            : {}),
        }) as Record<string, unknown>;
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

        if (facts) {
          const read =
            options.statusFetch ??
            createFinanceUncachedFetch({ directory: options.credentialStateDirectory });
          const checked = await bounded(
            () =>
              read(`${host}/v2/account`, {
                headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret },
                signal,
              }),
            signal,
          );
          if (
            facts.venue !== `alpaca:${mode}` ||
            checked.status !== 200 ||
            JSON.parse(checked.body).id !== facts.accountId
          ) {
            throw new Error("execution account differs from controller account");
          }
          if (
            Date.parse(facts.expiresAt) <= Date.now() ||
            Date.parse(facts.quote.expiresAt) <= Date.now()
          ) {
            throw new Error("controller facts expired before submission");
          }
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
        if (intent.stopPrice !== undefined && intent.side === "buy" && !isCrypto) {
          // OTO attaches the declared stop without inventing a take-profit threshold.
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
        const statusFetch =
          options.statusFetch ??
          createFinanceUncachedFetch({ directory: options.credentialStateDirectory });
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
            validateRecoveredOrder(found, intent, clientOrderId, timeInForce);
            return found;
          } catch (error) {
            throw new AlpacaOrderUncertainError(
              clientOrderId,
              knownOrderId,
              new AggregateError([cause, error], "submission reconciliation failed"),
            );
          }
        }

        async function placeCryptoProtection(
          entryFill: FinanceExecutionFill,
        ): Promise<FinanceExecutionProtection> {
          if (
            !isCrypto ||
            intent.side !== "buy" ||
            intent.stopPrice === undefined ||
            intent.protectionLimitPrice === undefined
          ) {
            throw new Error("crypto protection was requested without a complete stop-limit intent");
          }
          const entryOrderId = entryFill.terminalOrderIdentity?.orderId;
          if (!entryOrderId || entryFill.filledQuantity <= 0) {
            throw new Error("crypto protection requires a positive confirmed entry fill");
          }
          const protectionClientOrderId = `lcx-${createHash("sha256")
            .update(
              JSON.stringify([
                mode,
                intent.runAuthorizationId,
                intent.intentId,
                entryOrderId,
                "protection",
              ]),
            )
            .digest("hex")
            .slice(0, 40)}`;
          const protectionBody: Record<string, unknown> = {
            client_order_id: protectionClientOrderId,
            symbol,
            qty: String(entryFill.filledQuantity),
            side: "sell",
            type: "stop_limit",
            time_in_force: "gtc",
            stop_price: String(intent.stopPrice),
            limit_price: String(intent.protectionLimitPrice),
          };
          let knownProtectionOrderId: string | undefined;

          const matchesProtectionIntent = (candidate: AlpacaOrderResponse): boolean =>
            candidate.client_order_id === protectionClientOrderId &&
            candidate.symbol === symbol &&
            candidate.side === "sell" &&
            Number(candidate.qty) === entryFill.filledQuantity &&
            candidate.type === "stop_limit" &&
            candidate.time_in_force === "gtc" &&
            asFiniteNumber(candidate.stop_price) === intent.stopPrice &&
            asFiniteNumber(candidate.limit_price) === intent.protectionLimitPrice &&
            typeof candidate.id === "string" &&
            candidate.id.length > 0;

          const recoverProtection = async (cause: unknown): Promise<AlpacaOrderResponse> => {
            try {
              const response = await bounded(
                () =>
                  statusFetch(
                    `${host}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(protectionClientOrderId)}`,
                    { headers, signal },
                  ),
                signal,
              );
              if (response.status !== 200) {
                throw new Error(`protection reconciliation returned http ${response.status}`);
              }
              const found = JSON.parse(response.body) as AlpacaOrderResponse;
              if (!matchesProtectionIntent(found)) {
                throw new Error("reconciled protective order does not match authorized intent");
              }
              return found;
            } catch (error) {
              throw new AlpacaProtectionUncertainError(
                protectionClientOrderId,
                knownProtectionOrderId,
                new AggregateError([cause, error], "protective order reconciliation failed"),
              );
            }
          };

          try {
            let payload: AlpacaOrderResponse;
            let response: { status: number; body: string };
            try {
              response = await bounded(
                () =>
                  options.postJson!(`${host}/v2/orders`, {
                    headers,
                    body: JSON.stringify(protectionBody),
                    signal,
                  }),
                signal,
              );
            } catch (error) {
              payload = await recoverProtection(error);
              response = { status: 200, body: JSON.stringify(payload) };
            }
            try {
              payload = JSON.parse(response.body) as AlpacaOrderResponse;
            } catch (error) {
              throw new Error("protective order response was not valid JSON", { cause: error });
            }
            if (response.status < 200 || response.status >= 300) {
              const message =
                typeof payload.message === "string" ? payload.message : response.body.slice(0, 160);
              if (
                response.status >= 500 ||
                ((response.status === 409 || response.status === 422) &&
                  /client_order_id/i.test(message))
              ) {
                payload = await recoverProtection(
                  new Error(`protective order submission http ${response.status}`),
                );
              } else {
                throw new Error(`protective order rejected (http ${response.status}): ${message}`);
              }
            }
            if (!matchesProtectionIntent(payload)) {
              throw new Error("protective order response does not match authorized intent");
            }
            const orderId = String(payload.id);
            knownProtectionOrderId = orderId;
            const status = typeof payload.status === "string" ? payload.status : "";
            if (
              ![
                "new",
                "accepted",
                "pending_new",
                "partially_filled",
                "filled",
                "calculated",
              ].includes(status)
            ) {
              throw new Error(
                `protective order returned unsupported status ${status || "missing"}`,
              );
            }
            return Object.freeze({
              orderId,
              clientOrderId: protectionClientOrderId,
              side: "sell" as const,
              orderType: "stop_limit" as const,
              quantity: entryFill.filledQuantity,
              timeInForce: "gtc" as const,
              stopPrice: intent.stopPrice,
              limitPrice: intent.protectionLimitPrice,
              status,
              venueRef: `alpaca:${mode}:${orderId}`,
            });
          } catch (error) {
            if (error instanceof AlpacaProtectionUncertainError) {
              throw error;
            }
            throw new AlpacaProtectionUncertainError(
              protectionClientOrderId,
              knownProtectionOrderId,
              error,
            );
          }
        }

        const attachCryptoProtection = async (
          entryFill: FinanceExecutionFill,
        ): Promise<FinanceExecutionFill> => {
          if (!protectedCryptoBuy || entryFill.filledQuantity === 0) {
            return entryFill;
          }
          const protectionOrder = await placeCryptoProtection(entryFill);
          return Object.freeze({ ...entryFill, protectionOrder });
        };

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
            response.status === 408 ||
            response.status === 409 ||
            response.status === 499 ||
            (response.status === 422 && /client_order_id/i.test(message))
          ) {
            payload = await recover(new Error(`Alpaca submission http ${response.status}`));
          } else {
            submitted = false;
            throw new AlpacaOrderRejectedError({
              executionStage: "venue_response",
              httpStatus: response.status,
              ...(typeof payload.code === "number" && Number.isSafeInteger(payload.code)
                ? { brokerCode: payload.code }
                : {}),
            });
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
            if (parsed.id !== orderId) {
              throw new Error("order status identity mismatch");
            }
            const terminal = terminalFill(parsed, orderId, venueRef, intent.quantity);
            if (terminal) {
              return await attachCryptoProtection(terminal);
            }
            await bounded(() => delay(intervalMs, undefined, { signal }), signal);
          }
        }

        const terminal = terminalFill(payload, orderId, venueRef, intent.quantity);
        if (terminal) {
          return await attachCryptoProtection(terminal);
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
        if (
          submitted &&
          !(error instanceof AlpacaOrderUncertainError) &&
          !(error instanceof AlpacaProtectionUncertainError)
        ) {
          throw new AlpacaOrderUncertainError(clientOrderId, knownOrderId, error);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
