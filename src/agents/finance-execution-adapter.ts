/**
 * Declared execution adapter seam for `finance_live_execution_waterflow`.
 *
 * The canonical ontology already declares this chain:
 *
 *   execution_intent -> explicit_run_authorization -> declared_execution_adapter
 *                    -> order_placement -> execution_receipt
 *
 * with the filters `explicit_run_authorization_required`,
 * `declared_execution_adapter_required`, `risk_budget_required` and
 * `execution_receipt_required` (`lcx-flow-graph.ts`). This module implements the last
 * three nodes; `finance-decision-policy.ts` owns the mode/authority decision that
 * precedes them.
 *
 * Three boundaries hold by construction:
 *
 * 1. This module never reads a credential, a key, a wallet, or an account balance, and
 *    never opens a network connection. Credentials, funding and account binding stay a
 *    separate authority owned by the caller's adapter.
 * 2. It never invents a price. `referencePrice` must carry its own timestamp, and a paper
 *    fill is reported as a stated assumption (`venueRef: "paper"`), not as an observation.
 * 3. An empty risk-budget allowlist allows nothing, so the default budget fails closed.
 *
 * A real venue adapter implements the same `FinanceExecutionAdapter` contract. This module
 * deliberately ships only the paper adapter so that "capability exists" is never claimed
 * from "a seam exists".
 */

import { createHash, randomUUID } from "node:crypto";
import type { LcxOntologyFinanceExecutionAuthority } from "../shared/lcx-ontology.js";
import type { FinanceDecisionMode } from "./finance-decision-policy.js";

export const FINANCE_EXECUTION_RECEIPT_SCHEMA = "lcx_finance_execution_receipt_v1" as const;

export type FinanceOrderSide = "buy" | "sell";
export type FinanceOrderType = "market" | "limit";

/** The `execution_intent` node. Every field is required: an order path is never inferred. */
export type FinanceExecutionIntent = Readonly<{
  intentId: string;
  instrument: string;
  side: FinanceOrderSide;
  orderType: FinanceOrderType;
  quantity: number;
  /** Required by `limit` and rejected by `market`; a silent default would change the order. */
  limitPrice?: number;
  /**
   * Protective stop to attach at the venue.
   *
   * Without it, a position sized from a stop distance has no protection: the
   * stop exists only as a number used for arithmetic and as a boolean that
   * satisfies the mandate gate. Sizing from a stop and then placing an order
   * with none is worse than not asking for one, because it looks controlled.
   */
  stopPrice?: number;
  /** Last observed price used for the notional checks. */
  referencePrice: number;
  /** ISO datetime the reference price belongs to. "Now" is never assumed. */
  referencePriceAt: string;
  /** The explicit run authorization that admitted this run. Empty means unauthorized. */
  runAuthorizationId: string;
  rationale: string;
}>;

/**
 * The explicit "any instrument" token for an instrument allowlist.
 *
 * An allowlist stays an allowlist and both checks below stay in force; this token only says
 * the list does not narrow by instrument. Naming it is deliberate: an **empty** list still
 * refuses everything, so a budget that is misconfigured to empty can never widen itself into
 * "allow all". Openness has to be written down, which is the opposite of an implicit default.
 */
export const FINANCE_RISK_BUDGET_ANY_INSTRUMENT = "*" as const;

/**
 * Whether a human is watching the run.
 *
 * This is the one fact about a run that only the caller can know and the ledger cannot infer.
 * It decides whether the caps below are optional or mandatory, so it is a required field: a
 * caller that forgets to say gets a compile error, not a silent run with no ceiling.
 *
 * - `attended` — someone is watching and can stop it. The caps stay opt-in narrowing.
 * - `unattended` — a scheduled or autonomous run with nobody to intervene. **Every cap must be
 *   declared.** See `missingUnattendedCaps`.
 */
export const FINANCE_RISK_AUTOMATIONS = ["attended", "unattended"] as const;

export type FinanceRiskAutomation = (typeof FINANCE_RISK_AUTOMATIONS)[number];

/** The caps an `unattended` budget must declare, in the order they are reported. */
export const FINANCE_RISK_UNATTENDED_REQUIRED_CAPS = [
  "maxOrderNotional",
  "maxInstrumentNotional",
  "maxOrdersPerRun",
] as const;

export type FinanceRiskCapKey = (typeof FINANCE_RISK_UNATTENDED_REQUIRED_CAPS)[number];

/**
 * Refusal code per missing cap. A literal map rather than a runtime transformation of the key:
 * the codes are part of the contract a caller asserts on, so they must be greppable.
 */
export const UNATTENDED_CAP_REFUSAL_CODES: Record<FinanceRiskCapKey, string> = {
  maxOrderNotional: "risk_budget_unattended_requires_max_order_notional",
  maxInstrumentNotional: "risk_budget_unattended_requires_max_instrument_notional",
  maxOrdersPerRun: "risk_budget_unattended_requires_max_orders_per_run",
};

export type FinanceRiskBudget = Readonly<{
  /** Required: only the caller knows whether anyone is watching. See `FinanceRiskAutomation`. */
  automation: FinanceRiskAutomation;
  /**
   * Optional caps. Omitting one leaves that dimension uncapped; declare it to narrow. Each cap
   * is still enforced whenever it is present, so a run that states a limit cannot exceed it.
   *
   * These were previously required fields carrying defaults, which meant every run was bounded
   * by a number the caller never chose and could only discover by reading this file. The caps
   * are now opt-in narrowing rather than imposed defaults: declaring one is what creates the
   * boundary. Nothing else about the checks changed.
   *
   * The one exception is `automation: "unattended"`, where an undeclared cap is refused. That
   * is not an imposed default — it is the caller's own choice to run unattended, and choosing
   * to run unattended while declining to name a boundary is declining to have one.
   */
  maxOrderNotional?: number;
  maxInstrumentNotional?: number;
  maxOrdersPerRun?: number;
  /**
   * Instruments this budget admits. The default is open via
   * `FINANCE_RISK_BUDGET_ANY_INSTRUMENT`; pass an explicit list to narrow. An empty list
   * still admits nothing.
   */
  allowedInstruments: readonly string[];
}>;

/**
 * The default budget is for an **attended** run: someone is watching, so the caps stay opt-in.
 *
 * An unattended run must not reuse this object. It has to be built explicitly with
 * `automation: "unattended"` and every cap, which is deliberate friction — going unattended
 * should be an act someone performs on purpose, not a default they inherit.
 */
export const DEFAULT_FINANCE_RISK_BUDGET: FinanceRiskBudget = Object.freeze({
  automation: "attended",
  allowedInstruments: Object.freeze([FINANCE_RISK_BUDGET_ANY_INSTRUMENT] as const),
});

export type FinanceExecutionFill = Readonly<{
  filledQuantity: number;
  fillPrice: number;
  filledAt: string;
  /** Adapter-declared provenance. A paper fill must never read as a market observation. */
  venueRef: string;
}>;

export type FinanceExecutionAdapter = Readonly<{
  id: string;
  venue: string;
  /** Honest declaration of the order path. `paper` touches no venue and no credential. */
  kind: "paper" | "venue";
  /** Order types this adapter actually accepts. Declared, never inferred from the intent. */
  orderTypes: readonly FinanceOrderType[];
  /** Instruments this adapter accepts. Empty accepts nothing. */
  instruments: readonly string[];
  /** Credentials, funding and account binding are a separate authority, never read here. */
  credentialsAuthority: "external";
  execute: (intent: FinanceExecutionIntent, signal: AbortSignal) => Promise<FinanceExecutionFill>;
}>;

export type FinanceExecutionReceipt = Readonly<{
  schemaVersion: typeof FINANCE_EXECUTION_RECEIPT_SCHEMA;
  receiptId: string;
  intentId: string;
  runAuthorizationId: string;
  adapterId: string;
  adapterKind: FinanceExecutionAdapter["kind"];
  venue: string;
  instrument: string;
  side: FinanceOrderSide;
  orderType: FinanceOrderType;
  quantity: number;
  limitPrice?: number;
  referencePrice: number;
  referencePriceAt: string;
  /** Computed from the reference price, never from the fill price. */
  notional: number;
  fill: FinanceExecutionFill;
  /** Naming the adapter is what authorized the path; the mode alone grants nothing. */
  executionAuthority: LcxOntologyFinanceExecutionAuthority;
  recordedAt: string;
}>;

export type FinanceOrderPlacementRequest = Readonly<{
  /** Must be `live_execution`; every other mode is refused before any adapter is called. */
  mode: FinanceDecisionMode;
  intent: FinanceExecutionIntent;
  budget: FinanceRiskBudget;
  adapters: readonly FinanceExecutionAdapter[];
  executionAdapterId: string;
  /** Notional already committed to this instrument in the current run. */
  committedInstrumentNotional: number;
  ordersPlacedThisRun: number;
  recordedAt?: string;
  signal?: AbortSignal;
}>;

export type FinanceOrderPlacementResult = Readonly<{
  status: "placed" | "refused";
  refusalReasons: readonly string[];
  receipt?: FinanceExecutionReceipt;
}>;

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeInstrument(instrument: string): string {
  return instrument.trim().toUpperCase();
}

/**
 * An allowlist admits an instrument when it names it, or when it names the explicit
 * any-instrument token. An empty list admits nothing: the narrowing path is never a widening.
 */
function admitsInstrument(allowlist: readonly string[], instrument: string): boolean {
  const declared = new Set(allowlist.map(normalizeInstrument));
  return (
    declared.has(FINANCE_RISK_BUDGET_ANY_INSTRUMENT) ||
    declared.has(normalizeInstrument(instrument))
  );
}

/**
 * Which caps an `unattended` budget still owes, in declaration order.
 *
 * Pure and separately exported so an operator entry can say *which* number is missing instead
 * of making the caller read the refusal code backward. An `attended` budget owes nothing: the
 * caps are opt-in narrowing there, and imposing them would be refusing a run over a limit
 * nobody asked for.
 */
export function missingUnattendedCaps(budget: FinanceRiskBudget): readonly FinanceRiskCapKey[] {
  if (budget.automation !== "unattended") {
    return [];
  }
  const present: Record<FinanceRiskCapKey, boolean> = {
    maxOrderNotional: isPositiveFinite(budget.maxOrderNotional),
    maxInstrumentNotional: isPositiveFinite(budget.maxInstrumentNotional),
    maxOrdersPerRun: isPositiveFinite(budget.maxOrdersPerRun),
  };
  return FINANCE_RISK_UNATTENDED_REQUIRED_CAPS.filter((key) => !present[key]);
}

/**
 * Refusals are named codes and the list is ordered, so a caller can assert on the first
 * cause instead of parsing prose. Nothing is executed until every check has passed.
 */
function collectRefusalReasons(request: FinanceOrderPlacementRequest): string[] {
  const reasons: string[] = [];
  const { intent, budget } = request;

  if (request.mode !== "live_execution") {
    reasons.push("finance_execution_requires_live_execution_mode");
  }
  if (intent.runAuthorizationId.trim().length === 0) {
    reasons.push("explicit_run_authorization_required");
  }

  const adapter = request.adapters.find((item) => item.id === request.executionAdapterId);
  if (adapter === undefined) {
    reasons.push("declared_execution_adapter_required");
  }

  if (intent.intentId.trim().length === 0) {
    reasons.push("execution_intent_id_required");
  }
  if (intent.rationale.trim().length === 0) {
    reasons.push("execution_intent_rationale_required");
  }
  if (normalizeInstrument(intent.instrument).length === 0) {
    reasons.push("execution_intent_instrument_required");
  }
  if (!isPositiveFinite(intent.quantity)) {
    reasons.push("execution_intent_quantity_must_be_positive");
  }
  if (!isPositiveFinite(intent.referencePrice)) {
    reasons.push("execution_intent_reference_price_required");
  }
  if (intent.referencePriceAt.trim().length === 0) {
    reasons.push("execution_intent_reference_price_timestamp_required");
  }
  if (intent.orderType === "limit" && !isPositiveFinite(intent.limitPrice)) {
    reasons.push("execution_intent_limit_price_required");
  }
  if (intent.orderType === "market" && intent.limitPrice !== undefined) {
    reasons.push("execution_intent_limit_price_forbidden_for_market_order");
  }

  if (adapter !== undefined) {
    if (!adapter.orderTypes.includes(intent.orderType)) {
      reasons.push("declared_adapter_order_type_unsupported");
    }
    if (!admitsInstrument(adapter.instruments, intent.instrument)) {
      reasons.push("declared_adapter_instrument_unsupported");
    }
  }

  // The risk budget is checked even when earlier checks failed, so one run reports every
  // boundary it would have crossed rather than only the first.
  //
  // An undeclared cap is not a boundary. The three comparisons below are guarded by
  // `isPositiveFinite`, so a cap that is absent imposes nothing while a declared one is still
  // enforced in full. The former "cap must be declared" checks are deliberately gone: they
  // refused a run over a limit the caller never asked for, which is the opposite of a risk
  // control — a control has to be something someone chose.
  // An unattended run owes a declared ceiling on every dimension. Reported per cap rather than
  // as one code so a caller can fix all of them in one pass instead of playing whack-a-mole.
  for (const cap of missingUnattendedCaps(budget)) {
    reasons.push(UNATTENDED_CAP_REFUSAL_CODES[cap]);
  }

  if (!admitsInstrument(budget.allowedInstruments, intent.instrument)) {
    reasons.push("risk_budget_instrument_not_allowed");
  }
  if (
    isPositiveFinite(intent.referencePrice) &&
    isPositiveFinite(intent.quantity) &&
    isPositiveFinite(budget.maxOrderNotional) &&
    intent.referencePrice * intent.quantity > budget.maxOrderNotional
  ) {
    reasons.push("risk_budget_order_notional_exceeded");
  }
  if (
    isPositiveFinite(intent.referencePrice) &&
    isPositiveFinite(intent.quantity) &&
    isPositiveFinite(budget.maxInstrumentNotional) &&
    request.committedInstrumentNotional + intent.referencePrice * intent.quantity >
      budget.maxInstrumentNotional
  ) {
    reasons.push("risk_budget_instrument_notional_exceeded");
  }
  if (
    isPositiveFinite(budget.maxOrdersPerRun) &&
    request.ordersPlacedThisRun + 1 > budget.maxOrdersPerRun
  ) {
    reasons.push("risk_budget_order_count_exceeded");
  }

  return reasons;
}

/**
 * Place one order through a declared adapter, or refuse with named reasons.
 *
 * The adapter is resolved from the caller's own list, so this module never hardcodes an
 * order path and a venue adapter can replace the paper one without touching this code.
 */
export async function placeFinanceOrder(
  request: FinanceOrderPlacementRequest,
): Promise<FinanceOrderPlacementResult> {
  const refusalReasons = collectRefusalReasons(request);
  if (refusalReasons.length > 0) {
    return Object.freeze({
      status: "refused" as const,
      refusalReasons: Object.freeze(refusalReasons),
    });
  }

  const adapter = request.adapters.find((item) => item.id === request.executionAdapterId);
  if (adapter === undefined) {
    // Unreachable: the check above already pushed a refusal. Kept so the type narrows.
    return Object.freeze({
      status: "refused" as const,
      refusalReasons: Object.freeze(["declared_execution_adapter_required"]),
    });
  }

  const { intent } = request;
  const fill = await adapter.execute(intent, request.signal ?? new AbortController().signal);
  const notional = intent.referencePrice * intent.quantity;
  const recordedAt = request.recordedAt ?? new Date().toISOString();
  const receiptId = `exec-${createHash("sha256")
    .update(
      [intent.intentId, intent.instrument, intent.side, String(intent.quantity), recordedAt].join(
        "|",
      ),
    )
    .digest("hex")
    .slice(0, 24)}`;

  return Object.freeze({
    status: "placed" as const,
    refusalReasons: Object.freeze([] as const),
    receipt: Object.freeze({
      schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
      receiptId,
      intentId: intent.intentId,
      runAuthorizationId: intent.runAuthorizationId,
      adapterId: adapter.id,
      adapterKind: adapter.kind,
      venue: adapter.venue,
      instrument: normalizeInstrument(intent.instrument),
      side: intent.side,
      orderType: intent.orderType,
      quantity: intent.quantity,
      ...(intent.limitPrice === undefined ? {} : { limitPrice: intent.limitPrice }),
      referencePrice: intent.referencePrice,
      referencePriceAt: intent.referencePriceAt,
      notional,
      fill,
      executionAuthority: "declared_execution_adapter_required",
      recordedAt,
    }),
  });
}

/**
 * The only adapter shipped here. It records a simulated fill at the intent's own reference
 * price plus a declared slippage, and labels it `venueRef: "paper"` so no downstream
 * consumer can mistake it for a market observation.
 */
export function createPaperExecutionAdapter(options: {
  id?: string;
  instruments: readonly string[];
  orderTypes?: readonly FinanceOrderType[];
  /** Declared assumption, in basis points. 0 means "assume a perfect fill". */
  slippageBps?: number;
}): FinanceExecutionAdapter {
  const id = options.id?.trim() || "paper";
  const slippageBps = options.slippageBps ?? 0;
  const orderTypes = options.orderTypes ?? (["market", "limit"] as const);
  return Object.freeze({
    id,
    venue: "paper",
    kind: "paper" as const,
    orderTypes: Object.freeze([...orderTypes]),
    instruments: Object.freeze(options.instruments.map(normalizeInstrument)),
    credentialsAuthority: "external" as const,
    execute: async (intent: FinanceExecutionIntent): Promise<FinanceExecutionFill> => {
      const slippage = intent.referencePrice * (slippageBps / 10_000);
      const direction = intent.side === "buy" ? 1 : -1;
      let fillPrice = intent.referencePrice + direction * slippage;
      if (intent.orderType === "limit" && intent.limitPrice !== undefined) {
        // A limit order never fills worse than its limit, in either direction.
        fillPrice =
          intent.side === "buy"
            ? Math.min(fillPrice, intent.limitPrice)
            : Math.max(fillPrice, intent.limitPrice);
      }
      return Object.freeze({
        filledQuantity: intent.quantity,
        fillPrice: Number(fillPrice.toFixed(6)),
        filledAt: new Date().toISOString(),
        venueRef: `paper:${id}:slippageBps=${slippageBps}`,
      });
    },
  });
}

/** Stable identity for a receipt set, so a ledger can state what it was derived from. */
export function fingerprintFinanceExecutionReceipts(
  receipts: readonly FinanceExecutionReceipt[],
): string {
  return createHash("sha256")
    .update(receipts.map((receipt) => receipt.receiptId).join("|"))
    .digest("hex");
}

/** Convenience for callers that need a fresh, collision-free intent id. */
export function createFinanceExecutionIntentId(): string {
  return `intent-${randomUUID()}`;
}
