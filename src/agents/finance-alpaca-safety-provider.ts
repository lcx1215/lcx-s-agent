import { randomUUID } from "node:crypto";
import type { FinanceExecutionSafetyFacts } from "./finance-execution-safety.js";
import { classifyFinanceProtectionOrders } from "./finance-protection-coordination.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

/** Controller evidence, never inferred from model text or current equity. */
export type AlpacaSafetyControllerEvidence = Readonly<{
  accountId: string;
  currency: string;
  source: string;
  observedAt: string;
  expiresAt: string;
  peakEquity: number;
  /** Controller persists any newly observed high before issuing execution facts. */
  trackNewHigh?: boolean;
  peakScope: string;
  /** Explicit evidence that the account has no external/derivative hedge dependencies. */
  unhedged: boolean;
  /** Controller journal reconciliation; empty broker open orders alone is insufficient. */
  unresolvedOrderIds: readonly string[];
  /** Last confirmed claim covered by controller reconciliation, never inferred from open orders. */
  reconciledThroughClaimId?: string;
}>;
export type AlpacaSafetyQuoteBinding = Readonly<{ kind: "alpaca_safety_quote" }>;
const quotes = new WeakMap<
  AlpacaSafetyQuoteBinding,
  {
    instrument: string;
    side: "buy" | "sell";
    feed: "iex" | "sip";
    bp: number;
    ap: number;
    t: string;
    expiresAt: number;
  }
>();
export type AlpacaSafetyProviderOptions = Readonly<{
  accountId: string;
  instrument: string;
  side: "buy" | "sell";
  stockFeed: "iex" | "sip";
  credentials: Readonly<{ keyId: string; secret: string }>;
  evidence: AlpacaSafetyControllerEvidence;
  read: FinanceUncachedFetch;
  /** Previously observed quote only; account state is always fetched again. */
  boundQuote?: AlpacaSafetyQuoteBinding;
  timeoutMs: number;
  maxAgeMs: number;
}>;
const PAPER = "https://paper-api.alpaca.markets";
const DATA = "https://data.alpaca.markets";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record");
  }
  return value as Record<string, unknown>;
}
function numeric(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) {
    throw new Error("number");
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error("number");
  }
  return n;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("string");
  }
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("array");
  }
  return value;
}
function recent(at: string, now: number, age: number): boolean {
  const time = Date.parse(at);
  return Number.isFinite(time) && time <= now && now - time <= age;
}
/**
 * GET-only paper-account snapshot. No credential resolution, signing, execution or reconciliation.
 * Quotes retain venue timestamps. Multiple reads are not an atomic broker snapshot: pending orders,
 * inconsistent account totals and unsupported positions refuse facts. A controller must bind the
 * returned quote to its intent within this snapshot's validity; do not substitute a newer quote.
 */
export async function readAlpacaPaperSafetyFacts(
  options: AlpacaSafetyProviderOptions,
  callerSignal?: AbortSignal,
): Promise<
  | {
      ok: true;
      facts: FinanceExecutionSafetyFacts;
      peakScope: string;
      boundQuote: AlpacaSafetyQuoteBinding;
      bidPrice: number;
      askPrice: number;
      positions: readonly { instrument: string; quantity: number; marketValue: number }[];
    }
  | { ok: false; reason: string }
> {
  options = { ...options, credentials: { ...options.credentials } };
  const start = Date.now();
  const evidence = structuredClone(options.evidence);
  if (
    !["buy", "sell"].includes(options.side) ||
    !["iex", "sip"].includes(options.stockFeed) ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 120000 ||
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs <= 0 ||
    !options.credentials.keyId ||
    !options.credentials.secret ||
    !/^[A-Z0-9.]+(?:\/[A-Z0-9]+)?$/.test(options.instrument) ||
    evidence.accountId !== options.accountId ||
    !evidence.source?.trim() ||
    !evidence.peakScope?.trim() ||
    typeof evidence.unhedged !== "boolean" ||
    !evidence.unhedged ||
    !Array.isArray(evidence.unresolvedOrderIds) ||
    evidence.unresolvedOrderIds.length !== 0 ||
    (evidence.reconciledThroughClaimId !== undefined &&
      (typeof evidence.reconciledThroughClaimId !== "string" ||
        !evidence.reconciledThroughClaimId.trim())) ||
    !Number.isFinite(evidence.peakEquity) ||
    evidence.peakEquity <= 0 ||
    !recent(evidence.observedAt, start, options.maxAgeMs) ||
    !(Date.parse(evidence.expiresAt) > start)
  ) {
    return { ok: false, reason: "alpaca_safety_controller_evidence_or_parameters_invalid" };
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs),
    ...(callerSignal ? [callerSignal] : []),
  ]);
  const headers = {
    "APCA-API-KEY-ID": options.credentials.keyId,
    "APCA-API-SECRET-KEY": options.credentials.secret,
    accept: "application/json",
  };
  const get = async (url: string): Promise<unknown> => {
    signal.throwIfAborted();
    const response = await options.read(url, { headers: { ...headers }, signal });
    signal.throwIfAborted();
    if (response.status !== 200) {
      throw new Error("status");
    }
    if (Buffer.byteLength(response.body) > 2 * 1024 * 1024) {
      throw new Error("size");
    }
    return JSON.parse(response.body) as unknown;
  };
  const run = async () => {
    const account = record(await get(`${PAPER}/v2/account`));
    const positions = array(await get(`${PAPER}/v2/positions`));
    const orders = array(await get(`${PAPER}/v2/orders?status=open&limit=500&nested=true`));
    const asset = record(await get(`${PAPER}/v2/assets/${encodeURIComponent(options.instrument)}`));
    if (
      account.id !== options.accountId ||
      account.status !== "ACTIVE" ||
      account.trading_blocked !== false ||
      account.account_blocked !== false ||
      account.trade_suspended_by_user !== false ||
      orders.length >= 500 ||
      asset.symbol !== options.instrument ||
      asset.status !== "active" ||
      asset.tradable !== true ||
      !["us_equity", "crypto"].includes(string(asset.class))
    ) {
      throw new Error("unsupported");
    }
    const crypto = asset.class === "crypto";
    if (crypto !== options.instrument.includes("/")) {
      throw new Error("asset");
    }
    const currency = string(account.currency);
    if (
      currency !== "USD" ||
      currency !== evidence.currency ||
      (crypto && !options.instrument.endsWith("/USD"))
    ) {
      throw new Error("currency");
    }
    const equity = numeric(account.equity),
      cash = numeric(account.cash);
    const longValue = numeric(account.long_market_value),
      shortValue = numeric(account.short_market_value);
    let gross = 0,
      quantity = 0;
    const seen = new Set<string>();
    const quantities = new Map<string, number>();
    const accountPositions: { instrument: string; quantity: number; marketValue: number }[] = [];
    for (const value of positions) {
      const position = record(value);
      const rawSymbol = string(position.symbol);
      const symbol =
        position.asset_class === "crypto" && /^[A-Z0-9]+USD$/.test(rawSymbol)
          ? `${rawSymbol.slice(0, -3)}/USD`
          : rawSymbol;
      const qty = numeric(position.qty),
        marketValue = numeric(position.market_value);
      if (
        seen.has(symbol) ||
        position.side !== "long" ||
        !["us_equity", "crypto"].includes(string(position.asset_class)) ||
        qty <= 0 ||
        marketValue < 0
      ) {
        throw new Error("position");
      }
      seen.add(symbol);
      quantities.set(symbol, qty);
      accountPositions.push({ instrument: symbol, quantity: qty, marketValue });
      gross += marketValue;
      if (symbol === options.instrument) {
        quantity = qty;
      }
    }
    const protection = classifyFinanceProtectionOrders(orders.map(record), quantities);
    if (protection.unresolved.length) {
      throw new Error("orders require reconciliation");
    }
    // Margin capability/buying_power is deliberately unused. These facts prove no current borrowing.
    if (
      equity <= 0 ||
      cash < 0 ||
      shortValue !== 0 ||
      gross > equity ||
      Math.abs(gross - longValue) > 0.01 ||
      Math.abs(cash + longValue - equity) > 0.01 ||
      (!evidence.trackNewHigh && evidence.peakEquity < equity)
    ) {
      throw new Error("funding");
    }
    let quote: Record<string, unknown>;
    let boundQuote = options.boundQuote;
    if (boundQuote) {
      const bound = quotes.get(boundQuote);
      if (
        !bound ||
        bound.instrument !== options.instrument ||
        bound.side !== options.side ||
        bound.feed !== options.stockFeed ||
        bound.expiresAt <= Date.now()
      ) {
        throw new Error("quote binding");
      }
      quote = bound;
    } else {
      const quoteEnvelope = record(
        await get(
          crypto
            ? `${DATA}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(options.instrument)}`
            : `${DATA}/v2/stocks/${encodeURIComponent(options.instrument)}/quotes/latest?feed=${options.stockFeed}`,
        ),
      );
      quote = record(
        crypto ? record(quoteEnvelope.quotes)[options.instrument] : quoteEnvelope.quote,
      );
    }
    const bid = numeric(quote.bp),
      ask = numeric(quote.ap),
      quoteAt = string(quote.t);
    const now = Date.now();
    if (
      bid <= 0 ||
      ask < bid ||
      !recent(quoteAt, now, options.maxAgeMs) ||
      now - start > options.maxAgeMs ||
      !recent(evidence.observedAt, now, options.maxAgeMs) ||
      Date.parse(evidence.expiresAt) <= now
    ) {
      throw new Error("stale");
    }
    if (!boundQuote) {
      boundQuote = Object.freeze({ kind: "alpaca_safety_quote" });
      quotes.set(boundQuote, {
        instrument: options.instrument,
        side: options.side,
        feed: options.stockFeed,
        bp: bid,
        ap: ask,
        t: quoteAt,
        expiresAt: Date.parse(quoteAt) + options.maxAgeMs,
      });
    }
    const expiresAt = new Date(
      Math.min(start + options.maxAgeMs, Date.parse(evidence.expiresAt)),
    ).toISOString();
    return {
      ok: true as const,
      peakScope: evidence.peakScope,
      boundQuote,
      bidPrice: bid,
      askPrice: ask,
      positions: accountPositions,
      facts: {
        accountId: options.accountId,
        adapterId: "alpaca-venue",
        venue: "alpaca:paper",
        instrument: options.instrument,
        snapshotId: randomUUID(),
        source: `${PAPER}/v2/account;controller:${evidence.source}`,
        observedAt: new Date(start).toISOString(),
        expiresAt,
        positionQuantity: quantity,
        reservedSellQuantity: protection.reserved.get(options.instrument) ?? 0,
        protectiveOrderIds: protection.protective.map((order) => order.id),
        protectiveOrders: protection.protective.filter(
          (order) => order.instrument === options.instrument,
        ),
        openOrderIds: [],
        unresolvedOrderIds: [],
        ...(evidence.reconciledThroughClaimId === undefined
          ? {}
          : {
              reconciledThroughClaimId: evidence.reconciledThroughClaimId,
            }),
        instrumentEvidence: {
          source: `${PAPER}/v2/assets;controller:${evidence.source}`,
          observedAt: new Date(start).toISOString(),
          assetType: crypto ? ("spot_crypto" as const) : ("spot_equity" as const),
          fullyPaid: true,
          marginEnabled: false,
          hedged: false,
        },
        account: {
          status: "ACTIVE",
          tradingBlocked: false,
          equity,
          availableCash: cash,
          peakEquity: Math.max(evidence.peakEquity, equity),
          currency,
          grossExposure: gross,
        },
        quote: {
          source: `${DATA};feed=${crypto ? "crypto-us" : options.stockFeed};latest-quote-${options.side === "buy" ? "ask" : "bid"}`,
          price: options.side === "buy" ? ask : bid,
          observedAt: quoteAt,
          expiresAt: new Date(
            Math.min(Date.parse(quoteAt) + options.maxAgeMs, quotes.get(boundQuote)!.expiresAt),
          ).toISOString(),
          currency,
        },
      },
    };
  };
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      }),
    ]);
  } catch {
    return {
      ok: false,
      reason: signal.aborted
        ? "alpaca_safety_cancelled_or_timed_out"
        : "alpaca_safety_facts_unavailable_or_inconsistent",
    };
  } finally {
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}
