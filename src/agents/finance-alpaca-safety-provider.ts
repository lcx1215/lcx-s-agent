import { randomUUID } from "node:crypto";
import {
  financeReadFailureDiagnostic,
  isSafeFinanceReadFailure,
  type FinanceReadFailureDiagnostic,
} from "./finance-alpaca-safety-transport.js";
import type { FinanceExecutionSafetyFacts } from "./finance-execution-safety.js";
import { FinanceHttpBodyAbortError } from "./finance-http-body.js";
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
type BoundAlpacaSafetyQuote = {
  instrument: string;
  side: "buy" | "sell";
  feed: "iex" | "sip";
  bp: number;
  ap: number;
  t: string;
  expiresAt: number;
};
const quotes = new WeakMap<AlpacaSafetyQuoteBinding, BoundAlpacaSafetyQuote>();
export type AlpacaSafetyProviderOptions = Readonly<{
  accountId: string;
  instrument: string;
  side: "buy" | "sell";
  stockFeed: "iex" | "sip";
  credentials: Readonly<{ keyId: string; secret: string }>;
  evidence: AlpacaSafetyControllerEvidence;
  read: FinanceUncachedFetch;
  /** Opt in to a fixed, non-sensitive refusal stage for controller diagnostics. */
  diagnostics?: boolean;
  /** Previously observed quote only; account state is always fetched again. */
  boundQuote?: AlpacaSafetyQuoteBinding;
  timeoutMs: number;
  maxAgeMs: number;
}>;
export const ALPACA_SAFETY_FAILURE_CODES = [
  "alpaca_safety_controller_evidence_or_parameters_invalid",
  "alpaca_safety_controller_evidence_expired",
  "alpaca_safety_cancelled_or_timed_out",
  "alpaca_safety_snapshot_read_unavailable",
  "alpaca_safety_snapshot_response_invalid",
  "alpaca_safety_facts_inconsistent",
  "alpaca_safety_quote_parameters_invalid",
  "alpaca_safety_quote_binding_invalid",
  "alpaca_safety_quote_expired",
] as const;
export type AlpacaSafetyFailureCode = (typeof ALPACA_SAFETY_FAILURE_CODES)[number];
const QUOTE_REFUSAL_STAGES = [
  "quote_payload_invalid",
  "quote_bid_invalid",
  "quote_ask_invalid",
  "quote_timestamp_missing",
  "quote_bid_non_positive",
  "quote_ask_below_bid",
  "quote_timestamp_invalid",
  "quote_timestamp_future",
  "quote_age_exceeded",
  "quote_read_duration_exceeded",
] as const;
type QuoteRefusalStage = (typeof QUOTE_REFUSAL_STAGES)[number];
export const ALPACA_SAFETY_DIAGNOSTIC_STAGES = [
  "account_snapshot",
  "account_status",
  "position_snapshot",
  "open_order_snapshot",
  "open_order_limit",
  "instrument_asset_snapshot",
  "instrument_asset_status",
  "instrument_asset_class",
  "instrument_asset_identity",
  "account_currency",
  "account_values",
  "position_values",
  "protective_order_classification",
  "account_arithmetic",
  "quote_binding",
  "quote_snapshot",
  "quote_values",
  "quote_freshness",
  ...QUOTE_REFUSAL_STAGES,
  "controller_evidence_freshness",
] as const;
export type AlpacaSafetyDiagnosticStage = (typeof ALPACA_SAFETY_DIAGNOSTIC_STAGES)[number];

export const ALPACA_SAFETY_ACCOUNT_ARITHMETIC_CONDITIONS = [
  "equity_non_positive",
  "negative_cash",
  "nonzero_short_value",
  "gross_above_equity",
  "gross_valuation_drift",
  "cash_equity_mismatch",
  "untracked_equity_high",
] as const;

export type AlpacaSafetyAccountArithmeticDiagnostic = {
  failedConditions: (typeof ALPACA_SAFETY_ACCOUNT_ARITHMETIC_CONDITIONS)[number][];
  values: Record<
    | "equity"
    | "cash"
    | "shortMarketValue"
    | "positionGross"
    | "longMarketValue"
    | "accountGross"
    | "grossDrift"
    | "grossDriftTolerance"
    | "cashEquityResidual"
    | "cashEquityTolerance"
    | "controllerPeakEquity",
    number | null
  >;
  trackNewHigh: boolean;
  /** The two samples used by the existing bounded valuation-only retry. */
  valuationRetry?: {
    firstGrossDrift: number | null;
    retryGrossDrift: number | null;
    firstCoherentTolerance: number;
    retryCoherentTolerance: number;
    cashStable: boolean;
    quantitiesStable: boolean;
  };
};

export function isAlpacaSafetyFailureCode(value: unknown): value is AlpacaSafetyFailureCode {
  return (
    typeof value === "string" &&
    ALPACA_SAFETY_FAILURE_CODES.includes(value as AlpacaSafetyFailureCode)
  );
}

export const ALPACA_SAFETY_QUOTE_DIAGNOSTIC_STAGES = [
  "quote_snapshot",
  "quote_values",
  "quote_freshness",
  ...QUOTE_REFUSAL_STAGES,
] as const;
export type AlpacaSafetyQuoteTiming = Readonly<{
  quoteAtMs: number;
  checkedAtMs: number;
  aheadMs: number;
}>;
export function isSafeAlpacaQuoteTiming(value: unknown): value is AlpacaSafetyQuoteTiming {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Object.keys(value).some((key) => !["quoteAtMs", "checkedAtMs", "aheadMs"].includes(key))) {
    return false;
  }
  const timing = value as Partial<AlpacaSafetyQuoteTiming>;
  return (
    Number.isSafeInteger(timing.quoteAtMs) &&
    Number.isSafeInteger(timing.checkedAtMs) &&
    Number.isSafeInteger(timing.aheadMs) &&
    timing.quoteAtMs! >= 0 &&
    timing.checkedAtMs! >= 0 &&
    timing.aheadMs === timing.quoteAtMs! - timing.checkedAtMs!
  );
}
export type AlpacaSafetyQuoteDiagnostic = Readonly<{
  stage: (typeof ALPACA_SAFETY_QUOTE_DIAGNOSTIC_STAGES)[number];
  httpStatus?: number;
  quoteTiming?: AlpacaSafetyQuoteTiming;
  transport?: FinanceReadFailureDiagnostic;
}>;

function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/** Safe GET quote evidence; never an order rejection or an execution attempt. */
export class AlpacaSafetyQuoteReadError extends Error {
  readonly reason: AlpacaSafetyFailureCode;
  readonly diagnostic?: AlpacaSafetyQuoteDiagnostic;
  constructor(reason: AlpacaSafetyFailureCode, diagnostic?: AlpacaSafetyQuoteDiagnostic) {
    const safeReason = isAlpacaSafetyFailureCode(reason)
      ? reason
      : "alpaca_safety_facts_inconsistent";
    super(safeReason);
    this.name = "AlpacaSafetyQuoteReadError";
    this.reason = safeReason;
    if (diagnostic && ALPACA_SAFETY_QUOTE_DIAGNOSTIC_STAGES.includes(diagnostic.stage)) {
      const httpStatus = safeHttpStatus(diagnostic.httpStatus);
      this.diagnostic = Object.freeze({
        stage: diagnostic.stage,
        ...(isSafeFinanceReadFailure(diagnostic.transport)
          ? { transport: { ...diagnostic.transport } }
          : {}),
        ...(isSafeAlpacaQuoteTiming(diagnostic.quoteTiming)
          ? { quoteTiming: { ...diagnostic.quoteTiming } }
          : {}),
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
    }
  }
}

class AlpacaSafetyProviderFailure extends Error {
  constructor(
    readonly code: AlpacaSafetyFailureCode,
    readonly httpStatus?: number,
    readonly quoteFailureStage?: QuoteRefusalStage,
    readonly quoteTiming?: AlpacaSafetyQuoteTiming,
    readonly transport?: FinanceReadFailureDiagnostic,
  ) {
    super(code);
    this.name = "AlpacaSafetyProviderFailure";
  }
}

function refuse(
  code: AlpacaSafetyFailureCode,
  httpStatus?: number,
  quoteFailureStage?: QuoteRefusalStage,
  quoteTiming?: AlpacaSafetyQuoteTiming,
): never {
  throw new AlpacaSafetyProviderFailure(
    code,
    safeHttpStatus(httpStatus),
    quoteFailureStage,
    quoteTiming,
  );
}

const PAPER = "https://paper-api.alpaca.markets";
const DATA = "https://data.alpaca.markets";
const MAX_GROSS_VALUATION_DRIFT_USD = 0.05;
const GROSS_VALUATION_DRIFT_RATE = 0.00005;
const MAX_COHERENT_GROSS_SKEW_USD = 0.6;
const COHERENT_GROSS_SKEW_RATE = 0.00006;

function sameCashToCent(left: number, right: number): boolean {
  return Math.round(left * 100) === Math.round(right * 100);
}

function samePositionQuantities(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
) {
  return (
    left.size === right.size &&
    [...left].every(([instrument, quantity]) => right.get(instrument) === quantity)
  );
}

function safetyHeaders(credentials: Readonly<{ keyId: string; secret: string }>) {
  return {
    "APCA-API-KEY-ID": credentials.keyId,
    "APCA-API-SECRET-KEY": credentials.secret,
    accept: "application/json",
  };
}

function trackSafetyReads(read: FinanceUncachedFetch, signal: AbortSignal) {
  const active = new Set<ReturnType<FinanceUncachedFetch>>();
  const cleanup: ("confirmed" | "unconfirmed")[] = [];
  const tracked: FinanceUncachedFetch = (url, init) => {
    const task = read(url, init);
    active.add(task);
    void task.then(
      () => {
        active.delete(task);
        if (signal.aborted) {
          cleanup.push("unconfirmed");
        }
      },
      (error: unknown) => {
        active.delete(task);
        if (signal.aborted) {
          cleanup.push(
            error instanceof FinanceHttpBodyAbortError ? error.cleanupStatus : "unconfirmed",
          );
        }
      },
    );
    return task;
  };
  return { read: tracked, active, cleanup };
}

/** Every in-flight read must acknowledge cleanup; late outcomes cannot become evidence. */
async function observeCancelledRead(
  run: Promise<unknown>,
  fallback: unknown,
  reads: ReturnType<typeof trackSafetyReads>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const failure = await Promise.race([
      Promise.allSettled(reads.active).then(() =>
        run.then(
          () => fallback,
          (error: unknown) => error,
        ),
      ),
      new Promise<unknown>((resolve) => {
        timer = setTimeout(() => resolve(fallback), 2000);
      }),
    ]);
    return {
      failure,
      cleanupStatus:
        reads.active.size === 0 &&
        reads.cleanup.length > 0 &&
        reads.cleanup.every((status) => status === "confirmed")
          ? ("confirmed" as const)
          : ("unconfirmed" as const),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function readJson(
  read: FinanceUncachedFetch,
  url: string,
  headers: ReturnType<typeof safetyHeaders>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  let response: Awaited<ReturnType<FinanceUncachedFetch>>;
  try {
    response = await read(url, { headers: { ...headers }, signal });
  } catch (error) {
    throw new AlpacaSafetyProviderFailure(
      "alpaca_safety_snapshot_read_unavailable",
      undefined,
      undefined,
      undefined,
      financeReadFailureDiagnostic(error),
    );
  }
  signal.throwIfAborted();
  if (response.status !== 200) {
    refuse("alpaca_safety_snapshot_read_unavailable", response.status);
  }
  if (Buffer.byteLength(response.body) > 2 * 1024 * 1024) {
    refuse("alpaca_safety_snapshot_response_invalid");
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    refuse("alpaca_safety_snapshot_response_invalid");
  }
}

function assertFreshQuote(
  bid: number,
  ask: number,
  quoteAt: string,
  start: number,
  now: number,
  maxAgeMs: number,
) {
  const quoteAtMs = Date.parse(quoteAt);
  if (bid <= 0) {
    refuse("alpaca_safety_facts_inconsistent", undefined, "quote_bid_non_positive");
  }
  if (ask < bid) {
    refuse("alpaca_safety_facts_inconsistent", undefined, "quote_ask_below_bid");
  }
  if (!Number.isFinite(quoteAtMs)) {
    refuse("alpaca_safety_facts_inconsistent", undefined, "quote_timestamp_invalid");
  }
  if (quoteAtMs > now) {
    refuse("alpaca_safety_facts_inconsistent", undefined, "quote_timestamp_future", {
      quoteAtMs,
      checkedAtMs: now,
      aheadMs: quoteAtMs - now,
    });
  }
  if (now - quoteAtMs > maxAgeMs) {
    refuse("alpaca_safety_quote_expired", undefined, "quote_age_exceeded");
  }
  if (now - start > maxAgeMs) {
    refuse("alpaca_safety_quote_expired", undefined, "quote_read_duration_exceeded");
  }
}

function createBoundQuote(
  instrument: string,
  side: "buy" | "sell",
  feed: "iex" | "sip",
  bp: number,
  ap: number,
  t: string,
  maxAgeMs: number,
): AlpacaSafetyQuoteBinding {
  const binding = Object.freeze({ kind: "alpaca_safety_quote" as const });
  quotes.set(binding, {
    instrument,
    side,
    feed,
    bp,
    ap,
    t,
    expiresAt: Date.parse(t) + maxAgeMs,
  });
  return binding;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("alpaca_safety_facts_inconsistent");
  }
  return value as Record<string, unknown>;
}
function numeric(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) {
    refuse("alpaca_safety_facts_inconsistent");
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    refuse("alpaca_safety_facts_inconsistent");
  }
  return n;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    refuse("alpaca_safety_facts_inconsistent");
  }
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    refuse("alpaca_safety_facts_inconsistent");
  }
  return value;
}
function recent(at: string, now: number, age: number): boolean {
  const time = Date.parse(at);
  return Number.isFinite(time) && time <= now && now - time <= age;
}

function latestQuoteUrl(instrument: string, stockFeed: "iex" | "sip"): string {
  return instrument.includes("/")
    ? `${DATA}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(instrument)}`
    : `${DATA}/v2/stocks/${encodeURIComponent(instrument)}/quotes/latest?feed=${stockFeed}`;
}

function latestQuote(value: unknown, instrument: string): Record<string, unknown> {
  try {
    const envelope = record(value);
    return record(instrument.includes("/") ? record(envelope.quotes)[instrument] : envelope.quote);
  } catch {
    refuse("alpaca_safety_facts_inconsistent", undefined, "quote_payload_invalid");
  }
}

function quoteValues(quote: Record<string, unknown>) {
  const price = (value: unknown, stage: "quote_bid_invalid" | "quote_ask_invalid") => {
    try {
      return numeric(value);
    } catch {
      refuse("alpaca_safety_facts_inconsistent", undefined, stage);
    }
  };
  const bid = price(quote.bp, "quote_bid_invalid");
  const ask = price(quote.ap, "quote_ask_invalid");
  let at: string;
  try {
    at = string(quote.t);
  } catch {
    refuse("alpaca_safety_facts_inconsistent", undefined, "quote_timestamp_missing");
  }
  return { bid, ask, at };
}

/** Reads and binds a fresh spot quote without reading any account or instrument facts. */
export async function readAlpacaPaperSafetyQuote(
  options: Pick<
    AlpacaSafetyProviderOptions,
    | "instrument"
    | "side"
    | "stockFeed"
    | "credentials"
    | "read"
    | "timeoutMs"
    | "maxAgeMs"
    | "diagnostics"
  >,
  callerSignal?: AbortSignal,
): Promise<
  | {
      ok: true;
      boundQuote: AlpacaSafetyQuoteBinding;
      bidPrice: number;
      askPrice: number;
      referencePrice: number;
      observedAt: string;
      source: string;
    }
  | { ok: false; reason: AlpacaSafetyFailureCode; diagnostic?: AlpacaSafetyQuoteDiagnostic }
> {
  options = { ...options, credentials: { ...options.credentials } };
  const start = Date.now();
  if (
    !["buy", "sell"].includes(options.side) ||
    !["iex", "sip"].includes(options.stockFeed) ||
    !/^[A-Z0-9.]+(?:\/[A-Z0-9]+)?$/.test(options.instrument) ||
    (options.instrument.includes("/") && !options.instrument.endsWith("/USD")) ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 120000 ||
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs <= 0 ||
    !options.credentials.keyId ||
    !options.credentials.secret
  ) {
    return { ok: false, reason: "alpaca_safety_quote_parameters_invalid" };
  }

  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs),
    ...(callerSignal ? [callerSignal] : []),
  ]);
  const headers = safetyHeaders(options.credentials);
  const reads = trackSafetyReads(options.read, signal);
  let failureStage: AlpacaSafetyQuoteDiagnostic["stage"] = "quote_snapshot";
  const run = async () => {
    const response = await readJson(
      reads.read,
      latestQuoteUrl(options.instrument, options.stockFeed),
      headers,
      signal,
    );
    failureStage = "quote_values";
    const quote = latestQuote(response, options.instrument);
    const { bid: bidPrice, ask: askPrice, at: observedAt } = quoteValues(quote);
    const now = Date.now();
    assertFreshQuote(bidPrice, askPrice, observedAt, start, now, options.maxAgeMs);
    const boundQuote = createBoundQuote(
      options.instrument,
      options.side,
      options.stockFeed,
      bidPrice,
      askPrice,
      observedAt,
      options.maxAgeMs,
    );
    return {
      ok: true as const,
      boundQuote,
      bidPrice,
      askPrice,
      referencePrice: options.side === "buy" ? askPrice : bidPrice,
      observedAt,
      source: `${DATA};feed=${options.instrument.includes("/") ? "crypto-us" : options.stockFeed};latest-quote-${options.side === "buy" ? "ask" : "bid"}`,
    };
  };

  let abort: (() => void) | undefined;
  const running = run();
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      }),
    ]);
  } catch (caught) {
    let error: unknown = caught;
    let cleanupStatus: "confirmed" | "unconfirmed" | undefined;
    if (signal.aborted) {
      const cancelled = await observeCancelledRead(running, error, reads);
      error = cancelled.failure;
      cleanupStatus = cancelled.cleanupStatus;
    }
    const transport = error instanceof AlpacaSafetyProviderFailure ? error.transport : undefined;
    const failureTransport = cleanupStatus
      ? { code: transport?.code ?? "transport_cause_unavailable", cleanupStatus }
      : transport;
    return {
      ok: false,
      reason: signal.aborted
        ? "alpaca_safety_cancelled_or_timed_out"
        : error instanceof AlpacaSafetyProviderFailure
          ? error.code
          : "alpaca_safety_facts_inconsistent",
      ...(options.diagnostics
        ? {
            diagnostic: {
              ...(failureTransport ? { transport: failureTransport } : {}),
              ...(error instanceof AlpacaSafetyProviderFailure && error.quoteTiming
                ? { quoteTiming: error.quoteTiming }
                : {}),
              stage:
                !signal.aborted && error instanceof AlpacaSafetyProviderFailure
                  ? (error.quoteFailureStage ??
                    (error.code === "alpaca_safety_quote_expired"
                      ? "quote_freshness"
                      : failureStage))
                  : failureStage,
              ...(!signal.aborted &&
              error instanceof AlpacaSafetyProviderFailure &&
              error.httpStatus !== undefined
                ? { httpStatus: error.httpStatus }
                : {}),
            },
          }
        : {}),
    };
  } finally {
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
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
  | {
      ok: false;
      reason: AlpacaSafetyFailureCode;
      diagnostic?: AlpacaSafetyDiagnosticStage;
      accountArithmetic?: AlpacaSafetyAccountArithmeticDiagnostic;
      quoteTiming?: AlpacaSafetyQuoteTiming;
      transport?: FinanceReadFailureDiagnostic;
    }
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
  const headers = safetyHeaders(options.credentials);
  const reads = trackSafetyReads(options.read, signal);
  const get = (url: string) => readJson(reads.read, url, headers, signal);
  let failureStage: AlpacaSafetyDiagnosticStage = "account_snapshot";
  let accountArithmetic: AlpacaSafetyAccountArithmeticDiagnostic | undefined;
  let valuationRetry: AlpacaSafetyAccountArithmeticDiagnostic["valuationRetry"];
  const run = async () => {
    const readAccountPositionSnapshot = async () => {
      // Start independent endpoints together to minimize sampling skew; this still is not
      // an atomic broker snapshot, so arithmetic is checked below and may get one retry.
      failureStage = "account_snapshot";
      const accountRead = get(`${PAPER}/v2/account`);
      failureStage = "position_snapshot";
      const positionsRead = get(`${PAPER}/v2/positions`);
      const [accountResult, positionsResult] = await Promise.allSettled([
        accountRead,
        positionsRead,
      ]);
      if (accountResult.status === "rejected") {
        failureStage = "account_snapshot";
        throw accountResult.reason;
      }
      if (positionsResult.status === "rejected") {
        failureStage = "position_snapshot";
        throw positionsResult.reason;
      }
      failureStage = "account_snapshot";
      const account = record(accountResult.value);
      failureStage = "position_snapshot";
      const positions = array(positionsResult.value);
      return { account, positions };
    };
    let { account, positions } = await readAccountPositionSnapshot();
    type AccountPositionSnapshot = {
      currency: string;
      equity: number;
      cash: number;
      longValue: number;
      shortValue: number;
      gross: number;
      quantity: number;
      quantities: Map<string, number>;
      accountPositions: { instrument: string; quantity: number; marketValue: number }[];
      accountGross: number;
      grossDriftTolerance: number;
      coherentDriftTolerance: number;
      cashEquityResidual: number;
      failedConditions: AlpacaSafetyAccountArithmeticDiagnostic["failedConditions"];
    };
    const inspectAccountPositionSnapshot = (): AccountPositionSnapshot => {
      failureStage = "account_status";
      if (
        account.id !== options.accountId ||
        account.status !== "ACTIVE" ||
        account.trading_blocked !== false ||
        account.account_blocked !== false ||
        account.trade_suspended_by_user !== false
      ) {
        refuse("alpaca_safety_facts_inconsistent");
      }
      failureStage = "account_currency";
      const currency = string(account.currency);
      if (currency !== "USD" || currency !== evidence.currency) {
        refuse("alpaca_safety_facts_inconsistent");
      }
      failureStage = "account_values";
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
        failureStage = "position_values";
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
          refuse("alpaca_safety_facts_inconsistent");
        }
        seen.add(symbol);
        quantities.set(symbol, qty);
        accountPositions.push({ instrument: symbol, quantity: qty, marketValue });
        gross += marketValue;
        if (symbol === options.instrument) {
          quantity = qty;
        }
      }
      failureStage = "account_arithmetic";
      // Endpoint snapshots are independent. The original cent-scale tolerance applies
      // to each read; a bounded coherent-skew tolerance is considered only after a
      // stable second snapshot proves cash and holdings stayed fixed.
      const accountGross = Math.max(gross, longValue);
      const grossDriftTolerance = Math.min(
        MAX_GROSS_VALUATION_DRIFT_USD,
        Math.max(0.01, accountGross * GROSS_VALUATION_DRIFT_RATE),
      );
      const coherentDriftTolerance = Math.min(
        MAX_COHERENT_GROSS_SKEW_USD,
        Math.max(0.01, accountGross * COHERENT_GROSS_SKEW_RATE),
      );
      const cashEquityResidual = cash + longValue - equity;
      const failedConditions: AlpacaSafetyAccountArithmeticDiagnostic["failedConditions"] = [];
      if (equity <= 0) {
        failedConditions.push("equity_non_positive");
      }
      if (cash < 0) {
        failedConditions.push("negative_cash");
      }
      if (shortValue !== 0) {
        failedConditions.push("nonzero_short_value");
      }
      if (accountGross > equity) {
        failedConditions.push("gross_above_equity");
      }
      if (Math.abs(gross - longValue) > grossDriftTolerance) {
        failedConditions.push("gross_valuation_drift");
      }
      if (Math.abs(cashEquityResidual) > 0.01) {
        failedConditions.push("cash_equity_mismatch");
      }
      if (!evidence.trackNewHigh && evidence.peakEquity < equity) {
        failedConditions.push("untracked_equity_high");
      }
      return {
        currency,
        equity,
        cash,
        longValue,
        shortValue,
        gross,
        quantity,
        quantities,
        accountPositions,
        accountGross,
        grossDriftTolerance,
        coherentDriftTolerance,
        cashEquityResidual,
        failedConditions,
      };
    };
    let snapshot = inspectAccountPositionSnapshot();
    let conservativeAccountGross = snapshot.accountGross;
    if (
      snapshot.failedConditions.length === 1 &&
      snapshot.failedConditions[0] === "gross_valuation_drift"
    ) {
      const firstSnapshot = snapshot;
      ({ account, positions } = await readAccountPositionSnapshot());
      let retrySnapshot = inspectAccountPositionSnapshot();
      conservativeAccountGross = Math.max(firstSnapshot.accountGross, retrySnapshot.accountGross);
      const firstGrossDrift = Math.abs(firstSnapshot.gross - firstSnapshot.longValue);
      const retryGrossDrift = Math.abs(retrySnapshot.gross - retrySnapshot.longValue);
      const cashStable = sameCashToCent(firstSnapshot.cash, retrySnapshot.cash);
      const quantitiesStable = samePositionQuantities(
        firstSnapshot.quantities,
        retrySnapshot.quantities,
      );
      valuationRetry = {
        firstGrossDrift: Number.isFinite(firstGrossDrift) ? firstGrossDrift : null,
        retryGrossDrift: Number.isFinite(retryGrossDrift) ? retryGrossDrift : null,
        firstCoherentTolerance: firstSnapshot.coherentDriftTolerance,
        retryCoherentTolerance: retrySnapshot.coherentDriftTolerance,
        cashStable,
        quantitiesStable,
      };
      const firstHasOnlyDrift =
        firstSnapshot.failedConditions.length === 1 &&
        firstSnapshot.failedConditions[0] === "gross_valuation_drift";
      const retryHasOnlyDrift =
        retrySnapshot.failedConditions.length === 1 &&
        retrySnapshot.failedConditions[0] === "gross_valuation_drift";
      if (firstHasOnlyDrift && retryHasOnlyDrift) {
        const coherentPair = cashStable && quantitiesStable;
        if (coherentPair) {
          retrySnapshot = {
            ...retrySnapshot,
            grossDriftTolerance: retrySnapshot.coherentDriftTolerance,
          };
          if (
            firstGrossDrift <= firstSnapshot.coherentDriftTolerance &&
            retryGrossDrift <= retrySnapshot.coherentDriftTolerance
          ) {
            retrySnapshot = {
              ...retrySnapshot,
              failedConditions: retrySnapshot.failedConditions.filter(
                (condition) => condition !== "gross_valuation_drift",
              ),
            };
          }
        }
      }
      snapshot = retrySnapshot;
      if (
        conservativeAccountGross > snapshot.equity &&
        !snapshot.failedConditions.includes("gross_above_equity")
      ) {
        snapshot = {
          ...snapshot,
          failedConditions: [...snapshot.failedConditions, "gross_above_equity"],
        };
      }
    }
    const { currency, equity, cash, longValue, shortValue, gross, quantity, quantities } = snapshot;
    if (snapshot.failedConditions.length > 0) {
      if (options.diagnostics) {
        const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);
        accountArithmetic = {
          failedConditions: snapshot.failedConditions,
          values: {
            equity,
            cash,
            shortMarketValue: shortValue,
            positionGross: finite(snapshot.gross),
            longMarketValue: longValue,
            accountGross: finite(conservativeAccountGross),
            grossDrift: finite(Math.abs(gross - longValue)),
            grossDriftTolerance: snapshot.grossDriftTolerance,
            cashEquityResidual: finite(snapshot.cashEquityResidual),
            cashEquityTolerance: 0.01,
            controllerPeakEquity: evidence.peakEquity,
          },
          trackNewHigh: evidence.trackNewHigh === true,
          ...(valuationRetry ? { valuationRetry } : {}),
        };
      }
      refuse("alpaca_safety_facts_inconsistent");
    }
    failureStage = "open_order_snapshot";
    // These independent GETs share the original observation deadline. Await both so
    // either endpoint's failure keeps its own stage and cannot leak a pending read.
    const [ordersResult, assetResult] = await Promise.allSettled([
      get(`${PAPER}/v2/orders?status=open&limit=500&nested=true`),
      get(`${PAPER}/v2/assets/${encodeURIComponent(options.instrument)}`),
    ]);
    if (ordersResult.status === "rejected") {
      throw ordersResult.reason;
    }
    const orders = array(ordersResult.value);
    failureStage = "instrument_asset_snapshot";
    if (assetResult.status === "rejected") {
      throw assetResult.reason;
    }
    const asset = record(assetResult.value);
    failureStage = "open_order_limit";
    if (orders.length >= 500) {
      refuse("alpaca_safety_facts_inconsistent");
    }
    failureStage = "instrument_asset_status";
    if (
      asset.symbol !== options.instrument ||
      asset.status !== "active" ||
      asset.tradable !== true
    ) {
      refuse("alpaca_safety_facts_inconsistent");
    }
    failureStage = "instrument_asset_class";
    if (!["us_equity", "crypto"].includes(string(asset.class))) {
      refuse("alpaca_safety_facts_inconsistent");
    }
    const crypto = asset.class === "crypto";
    failureStage = "instrument_asset_identity";
    if (crypto !== options.instrument.includes("/")) {
      refuse("alpaca_safety_facts_inconsistent");
    }
    if (crypto && !options.instrument.endsWith("/USD")) {
      failureStage = "instrument_asset_identity";
      refuse("alpaca_safety_facts_inconsistent");
    }
    failureStage = "protective_order_classification";
    const protection = classifyFinanceProtectionOrders(orders.map(record), quantities);
    if (protection.unresolved.length) {
      refuse("alpaca_safety_facts_inconsistent");
    }
    let quote: Record<string, unknown>;
    let boundQuote = options.boundQuote;
    if (boundQuote) {
      failureStage = "quote_binding";
      const bound = quotes.get(boundQuote);
      if (
        !bound ||
        bound.instrument !== options.instrument ||
        bound.side !== options.side ||
        bound.feed !== options.stockFeed
      ) {
        refuse("alpaca_safety_quote_binding_invalid");
      }
      if (bound.expiresAt <= Date.now()) {
        refuse("alpaca_safety_quote_expired");
      }
      quote = bound;
    } else {
      failureStage = "quote_snapshot";
      quote = latestQuote(
        await get(latestQuoteUrl(options.instrument, options.stockFeed)),
        options.instrument,
      );
    }
    failureStage = "quote_values";
    const { bid, ask, at: quoteAt } = quoteValues(quote);
    const now = Date.now();
    failureStage = "quote_freshness";
    assertFreshQuote(bid, ask, quoteAt, start, now, options.maxAgeMs);
    failureStage = "controller_evidence_freshness";
    if (
      !recent(evidence.observedAt, now, options.maxAgeMs) ||
      Date.parse(evidence.expiresAt) <= now
    ) {
      refuse("alpaca_safety_controller_evidence_expired");
    }
    if (!boundQuote) {
      boundQuote = createBoundQuote(
        options.instrument,
        options.side,
        options.stockFeed,
        bid,
        ask,
        quoteAt,
        options.maxAgeMs,
      );
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
      positions: snapshot.accountPositions,
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
          grossExposure: conservativeAccountGross,
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
  const running = run();
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      }),
    ]);
  } catch (caught) {
    let error: unknown = caught;
    let cleanupStatus: "confirmed" | "unconfirmed" | undefined;
    if (signal.aborted) {
      const cancelled = await observeCancelledRead(running, error, reads);
      error = cancelled.failure;
      cleanupStatus = cancelled.cleanupStatus;
    }
    const transport = error instanceof AlpacaSafetyProviderFailure ? error.transport : undefined;
    const failureTransport = cleanupStatus
      ? { code: transport?.code ?? "transport_cause_unavailable", cleanupStatus }
      : transport;
    return {
      ok: false,
      reason: signal.aborted
        ? "alpaca_safety_cancelled_or_timed_out"
        : error instanceof AlpacaSafetyProviderFailure
          ? error.code
          : "alpaca_safety_facts_inconsistent",
      ...(options.diagnostics
        ? {
            diagnostic:
              !signal.aborted && error instanceof AlpacaSafetyProviderFailure
                ? (error.quoteFailureStage ?? failureStage)
                : failureStage,
          }
        : {}),
      ...(options.diagnostics && accountArithmetic ? { accountArithmetic } : {}),
      ...(options.diagnostics && failureTransport ? { transport: failureTransport } : {}),
      ...(options.diagnostics && error instanceof AlpacaSafetyProviderFailure && error.quoteTiming
        ? { quoteTiming: error.quoteTiming }
        : {}),
    };
  } finally {
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}
