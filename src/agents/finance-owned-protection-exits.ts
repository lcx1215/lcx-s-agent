import { clientOrderIdentity } from "./finance-alpaca-execution-adapter.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  buildFinanceExecutionReceipt,
  type FinanceExecutionReceipt,
} from "./finance-execution-adapter.js";
import { readFinanceExecutionSafetyClaims } from "./finance-execution-safety.js";
import {
  reduceFinanceBrokerHistoryRecords,
  type BrokerHistoryRecord,
} from "./finance-position-ledger.js";

export type FinanceOwnedProtectionExitFill = Readonly<{
  activityId: string;
  quantity: number;
  price: number;
  occurredAt: string;
  /** Hash of the validated raw fact body, independent of its enclosing history page. */
  sourceFactRef: string;
  /** Durable append-only broker-history row containing the activity observation. */
  historyRef: string;
}>;

/**
 * A verified broker-native OTO stop exit attributed to one specific LCX entry receipt.
 * This is projection evidence only; it is never appended or converted into an execution receipt.
 */
export type FinanceOwnedProtectionExitFact = Readonly<{
  accountId: string;
  venue: "alpaca:paper";
  instrument: string;
  entryReceiptId: string;
  entryIntentId: string;
  parentOrderId: string;
  childOrderId: string;
  entryFilledQuantity: number;
  filledQuantity: number;
  parentOrderHistoryRef: string;
  childOrderHistoryRefs: readonly string[];
  fills: readonly FinanceOwnedProtectionExitFill[];
  /** Verified original execution journal record linking a restored stop to this entry. */
  restorationClaimRef?: string;
}>;

export class FinanceOwnedProtectionExitEvidenceError extends Error {
  constructor(
    readonly code:
      | "oto_parent_identity_mismatch"
      | "oto_child_link_ambiguous"
      | "oto_child_identity_mismatch"
      | "oto_child_fill_evidence_invalid"
      | "oto_child_fill_quantity_mismatch"
      | "oto_child_fill_outside_entry_window"
      | "oto_child_claimed_by_multiple_entries",
    readonly entryReceiptId: string,
    readonly childOrderId?: string,
  ) {
    super(`${code}:${entryReceiptId}${childOrderId ? `:${childOrderId}` : ""}`);
    this.name = "FinanceOwnedProtectionExitEvidenceError";
  }
}

type BrokerFact = Readonly<{
  stream: "orders" | "activities";
  fact: Record<string, unknown>;
  historyRef: string;
}>;

type ParentCandidate = Readonly<{
  receipt: FinanceExecutionReceipt;
  parentOrderId: string;
  parent: BrokerFact;
  child: Record<string, unknown>;
  childOrderId: string;
  protectionQuantity?: number;
  restorationClaimRef?: string;
}>;

const QUANTITY_EPSILON = 0.000000001;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(candidate) ? candidate : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const candidate = finiteNumber(value);
  return candidate !== undefined && candidate > 0 ? candidate : undefined;
}

function normalizedInstrument(value: unknown): string | undefined {
  const raw = text(value)?.toUpperCase();
  if (!raw) {
    return undefined;
  }
  return /^[A-Z0-9]+USD$/u.test(raw) && !raw.includes("/") ? `${raw.slice(0, -3)}/USD` : raw;
}

function instant(value: unknown): number | undefined {
  const candidate = text(value);
  if (!candidate) {
    return undefined;
  }
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberMatches(left: number, right: number): boolean {
  return Math.abs(left - right) <= QUANTITY_EPSILON;
}

function retainLatestBrokerFacts(
  facts: Map<string, BrokerFact>,
  record: BrokerHistoryRecord,
): Map<string, BrokerFact> {
  const stream = record.body.query.split(":", 1)[0];
  if (stream !== "orders" && stream !== "activities") {
    return facts;
  }
  for (const fact of record.body.payload) {
    const id = text(fact.id);
    if (!id) {
      continue;
    }
    const key = `${stream}:id:${id}`;
    const previous = facts.get(key);
    const previousUpdatedAt = instant(previous?.fact.updated_at);
    const nextUpdatedAt = instant(fact.updated_at);
    // Match the broker-history reader's rule: a stale revision cannot replace a newer one.
    if (
      previousUpdatedAt !== undefined &&
      (nextUpdatedAt === undefined || nextUpdatedAt < previousUpdatedAt)
    ) {
      continue;
    }
    facts.delete(key);
    facts.set(key, {
      stream,
      fact,
      historyRef: record.ref,
    });
  }
  return facts;
}

function brokerOrderId(fact: Record<string, unknown>): string | undefined {
  return text(fact.id);
}

function stopChildFromParent(
  parent: BrokerFact,
  receipt: FinanceExecutionReceipt,
  instrument: string,
): Record<string, unknown> | undefined {
  if (parent.fact.order_class !== "oto") {
    return undefined;
  }
  const legs = parent.fact.legs;
  if (!Array.isArray(legs)) {
    return undefined;
  }
  const stopLegs = legs.filter((leg): leg is Record<string, unknown> => {
    if (!leg || typeof leg !== "object" || Array.isArray(leg)) {
      return false;
    }
    const orderType = text(leg.type) ?? text(leg.order_type);
    return orderType === "stop";
  });
  if (stopLegs.length !== 1) {
    throw new FinanceOwnedProtectionExitEvidenceError(
      "oto_child_link_ambiguous",
      receipt.receiptId,
    );
  }
  const child = stopLegs[0];
  const childOrderId = brokerOrderId(child);
  if (
    !childOrderId ||
    child.side !== "sell" ||
    normalizedInstrument(child.symbol ?? parent.fact.symbol) !== instrument ||
    (child.parent_order_id !== undefined && child.parent_order_id !== brokerOrderId(parent.fact))
  ) {
    throw new FinanceOwnedProtectionExitEvidenceError(
      "oto_child_identity_mismatch",
      receipt.receiptId,
      childOrderId,
    );
  }
  return child;
}

/**
 * Read exact broker-native stop fills for the supplied strategy-owned entry receipts.
 * Callers must first restrict `receipts` to one strategy binding; this helper then binds each
 * entry to its actual OTO parent, its declared stop child, and the child's raw FILL activities.
 * Missing relationship evidence yields no fact. Contradictory or multiply-owned evidence throws.
 */
export async function readFinanceOwnedProtectionExitFacts(params: {
  directory: string;
  accountId: string;
  venue: "alpaca:paper";
  receipts: readonly FinanceExecutionReceipt[];
  asOf?: string;
}): Promise<readonly FinanceOwnedProtectionExitFact[]> {
  if (!params.accountId.trim() || params.venue !== "alpaca:paper") {
    throw new Error("owned protection exits require an exact Alpaca paper account and venue");
  }
  const cutoff = params.asOf === undefined ? undefined : Date.parse(params.asOf);
  if (cutoff !== undefined && !Number.isFinite(cutoff)) {
    throw new Error("invalid owned exit cutoff");
  }
  // Without an entry receipt no broker stop can be attributed. Account and
  // cutoff validation still precede this; the controller owns account safety.
  if (params.receipts.length === 0) {
    return [];
  }
  const history = await reduceFinanceBrokerHistoryRecords(
    params.directory,
    params.accountId,
    params.venue,
    new Map<string, BrokerFact>(),
    (facts, record) => {
      if (cutoff !== undefined) {
        const observed = record.body.query.match(
          /:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/u,
        )?.[1];
        if (!observed || Date.parse(observed) > cutoff) {
          return facts;
        }
      }
      return retainLatestBrokerFacts(facts, record);
    },
    { streams: ["orders", "activities"] },
  );
  const observations = [...history.value.values()];
  const orders = new Map(
    observations
      .filter((observation) => observation.stream === "orders")
      .flatMap((observation) => {
        const id = brokerOrderId(observation.fact);
        return id ? [[id, observation] as const] : [];
      }),
  );
  const byChild = new Map<string, ParentCandidate>();
  const seenReceiptIds = new Set<string>();

  for (const receipt of params.receipts) {
    if (seenReceiptIds.has(receipt.receiptId)) {
      continue;
    }
    seenReceiptIds.add(receipt.receiptId);
    if (
      receipt.accountId !== params.accountId ||
      receipt.venue !== params.venue ||
      receipt.adapterKind !== "venue" ||
      receipt.side !== "buy" ||
      receipt.fill.filledQuantity <= 0 ||
      receipt.fill.terminalOrderIdentity?.terminal !== true
    ) {
      continue;
    }
    const parentOrderId = receipt.fill.terminalOrderIdentity.orderId;
    const parent = orders.get(parentOrderId);
    if (!parent || parent.fact.order_class !== "oto") {
      continue;
    }
    const instrument = normalizedInstrument(receipt.instrument);
    const parentFilledQuantity = positiveNumber(parent.fact.filled_qty);
    const parentFilledAt = instant(parent.fact.filled_at);
    if (
      !instrument ||
      parent.fact.side !== "buy" ||
      normalizedInstrument(parent.fact.symbol) !== instrument ||
      parentFilledQuantity === undefined ||
      !numberMatches(parentFilledQuantity, receipt.fill.filledQuantity) ||
      parentFilledAt === undefined
    ) {
      throw new FinanceOwnedProtectionExitEvidenceError(
        "oto_parent_identity_mismatch",
        receipt.receiptId,
      );
    }
    const entryFilledAt = instant(receipt.fill.filledAt);
    if (entryFilledAt === undefined || parentFilledAt > entryFilledAt) {
      throw new FinanceOwnedProtectionExitEvidenceError(
        "oto_parent_identity_mismatch",
        receipt.receiptId,
      );
    }
    const child = stopChildFromParent(parent, receipt, instrument);
    if (!child) {
      continue;
    }
    const childOrderId = brokerOrderId(child)!;
    const candidate = Object.freeze({ receipt, parentOrderId, parent, child, childOrderId });
    const previous = byChild.get(childOrderId);
    if (previous && previous.receipt.receiptId !== receipt.receiptId) {
      throw new FinanceOwnedProtectionExitEvidenceError(
        "oto_child_claimed_by_multiple_entries",
        receipt.receiptId,
        childOrderId,
      );
    }
    byChild.set(childOrderId, candidate);
  }

  // Restored standalone stops are not OTO legs. Their ownership comes from the
  // original account journal + exact canceled child, never from a matching symbol.
  if ([...orders.values()].some(({ fact }) => text(fact.client_order_id)?.endsWith("-protect"))) {
    const claims = await readFinanceExecutionSafetyClaims({
      stateDir: params.directory,
      accountId: params.accountId,
      venue: params.venue,
    });
    for (const original of byChild.values()) {
      const canceled = orders.get(original.childOrderId)?.fact ?? original.child;
      if (canceled.status !== "canceled" || finiteNumber(canceled.filled_qty) !== 0) {
        continue;
      }
      for (const claim of claims) {
        const binding = claim.binding;
        if (
          !binding ||
          binding.accountId !== params.accountId ||
          binding.venue !== params.venue ||
          binding.adapterId !== "alpaca-venue" ||
          binding.intent.side !== "sell" ||
          binding.intent.instrument !== original.receipt.instrument ||
          (cutoff !== undefined && Date.parse(claim.at) > cutoff) ||
          (claim.status !== "confirmed" && claim.status !== "operator_retired") ||
          binding.protectiveOrders?.length !== 1 ||
          binding.protectiveOrders[0].id !== original.childOrderId ||
          !numberMatches(
            binding.positionQuantity ?? 0,
            original.protectionQuantity ?? original.receipt.fill.filledQuantity,
          ) ||
          !numberMatches(binding.protectiveOrders[0].quantity, binding.positionQuantity ?? 0)
        ) {
          continue;
        }
        if (
          claim.status === "confirmed" &&
          (claim.fill?.terminalOrderIdentity?.terminal !== true ||
            claim.adapterKind !== "venue" ||
            !claim.receipt ||
            claim.receipt.accountId !== params.accountId)
        ) {
          continue;
        }
        if (
          claim.id !==
          caseflowFingerprint([
            binding.accountId,
            binding.venue,
            binding.intent.runAuthorizationId,
            binding.intent.intentId,
          ])
        ) {
          continue;
        }
        if (claim.status === "confirmed") {
          const expected = buildFinanceExecutionReceipt({
            intent: binding.intent,
            adapter: { id: binding.adapterId, venue: binding.venue, kind: "venue" },
            fill: claim.fill!,
            recordedAt: claim.receipt!.recordedAt,
            accountId: binding.accountId,
            identityVersion: claim.receiptIdentityVersion ?? "legacy",
          });
          if (caseflowFingerprint(expected) !== caseflowFingerprint(claim.receipt)) {
            continue;
          }
        }
        const quantity =
          (binding.positionQuantity ?? 0) -
          (claim.status === "confirmed" ? claim.fill!.filledQuantity : 0);
        if (
          !Number.isFinite(quantity) ||
          quantity <= 0 ||
          quantity > original.receipt.fill.filledQuantity
        ) {
          continue;
        }
        if (
          canceled.side !== "sell" ||
          canceled.type !== "stop" ||
          canceled.time_in_force !== "gtc" ||
          normalizedInstrument(canceled.symbol) !== original.receipt.instrument ||
          finiteNumber(canceled.qty) !== binding.positionQuantity ||
          finiteNumber(canceled.stop_price) !== binding.protectiveOrders[0].stopPrice
        ) {
          throw new FinanceOwnedProtectionExitEvidenceError(
            "oto_child_identity_mismatch",
            original.receipt.receiptId,
            original.childOrderId,
          );
        }
        const expectedClientId = `${clientOrderIdentity("paper", binding.intent)}-protect`;
        const matches = [...orders.values()].filter(
          ({ fact }) => fact.client_order_id === expectedClientId,
        );
        if (matches.length > 1) {
          throw new FinanceOwnedProtectionExitEvidenceError(
            "oto_child_link_ambiguous",
            original.receipt.receiptId,
          );
        }
        const restored = matches[0];
        if (!restored) {
          continue;
        }
        const order = restored.fact,
          protection = binding.protectiveOrders[0];
        if (
          order.symbol !== original.receipt.instrument ||
          order.side !== "sell" ||
          order.type !== "stop" ||
          order.time_in_force !== "gtc" ||
          !numberMatches(finiteNumber(order.qty) ?? 0, quantity) ||
          finiteNumber(order.stop_price) !== protection.stopPrice ||
          (order.limit_price !== null && order.limit_price !== undefined) ||
          (instant(order.submitted_at) ?? -Infinity) <
            (instant(binding.intent.referencePriceAt) ?? Infinity) ||
          (order.parent_order_id !== undefined && order.parent_order_id !== original.parentOrderId)
        ) {
          throw new FinanceOwnedProtectionExitEvidenceError(
            "oto_child_identity_mismatch",
            original.receipt.receiptId,
            brokerOrderId(order),
          );
        }
        const childOrderId = brokerOrderId(order)!;
        const prior = byChild.get(childOrderId);
        if (prior && prior.receipt.receiptId !== original.receipt.receiptId) {
          throw new FinanceOwnedProtectionExitEvidenceError(
            "oto_child_claimed_by_multiple_entries",
            original.receipt.receiptId,
            childOrderId,
          );
        }
        byChild.set(childOrderId, {
          ...original,
          child: order,
          childOrderId,
          protectionQuantity: quantity,
          restorationClaimRef: caseflowFingerprint(claim),
        });
      }
    }
  }

  const independentSellOrderIds = new Set(
    params.receipts.flatMap((receipt) => {
      const orderId = receipt.fill.terminalOrderIdentity?.orderId;
      return receipt.accountId === params.accountId &&
        receipt.venue === params.venue &&
        receipt.adapterKind === "venue" &&
        receipt.side === "sell" &&
        orderId
        ? [orderId]
        : [];
    }),
  );
  const activities = observations.filter((observation) => observation.stream === "activities");
  const facts: FinanceOwnedProtectionExitFact[] = [];

  for (const candidate of byChild.values()) {
    const { receipt, parentOrderId, parent, child, childOrderId } = candidate;
    if (independentSellOrderIds.has(childOrderId)) {
      continue;
    }
    const instrument = normalizedInstrument(receipt.instrument)!;
    const childOrder = orders.get(childOrderId);
    if (
      childOrder &&
      childOrder.fact.parent_order_id !== undefined &&
      childOrder.fact.parent_order_id !== parentOrderId
    ) {
      throw new FinanceOwnedProtectionExitEvidenceError(
        "oto_child_identity_mismatch",
        receipt.receiptId,
        childOrderId,
      );
    }
    const childSources = [child, ...(childOrder ? [childOrder.fact] : [])];
    for (const source of childSources) {
      const quantity = positiveNumber(source.qty);
      if (
        source.side !== "sell" ||
        (text(source.type) ?? text(source.order_type)) !== "stop" ||
        normalizedInstrument(source.symbol ?? parent.fact.symbol) !== instrument ||
        (quantity !== undefined &&
          !numberMatches(quantity, candidate.protectionQuantity ?? receipt.fill.filledQuantity))
      ) {
        throw new FinanceOwnedProtectionExitEvidenceError(
          "oto_child_identity_mismatch",
          receipt.receiptId,
          childOrderId,
        );
      }
    }
    const childActivities = activities
      .filter(({ fact }) => text(fact.order_id) === childOrderId && fact.activity_type === "FILL")
      .map(({ fact, historyRef }): FinanceOwnedProtectionExitFill => {
        const activityId = text(fact.id);
        const quantity = positiveNumber(fact.qty);
        const price = positiveNumber(fact.price);
        const occurredAt = instant(fact.transaction_time);
        const fillTime = instant(receipt.fill.filledAt);
        const parentTime = instant(parent.fact.filled_at);
        if (
          !activityId ||
          !["fill", "partial_fill"].includes(String(fact.type)) ||
          fact.side !== "sell" ||
          normalizedInstrument(fact.symbol) !== instrument ||
          quantity === undefined ||
          price === undefined ||
          occurredAt === undefined ||
          (cutoff !== undefined && occurredAt > cutoff)
        ) {
          throw new FinanceOwnedProtectionExitEvidenceError(
            "oto_child_fill_evidence_invalid",
            receipt.receiptId,
            childOrderId,
          );
        }
        if (
          fillTime === undefined ||
          parentTime === undefined ||
          occurredAt < fillTime ||
          occurredAt < parentTime
        ) {
          throw new FinanceOwnedProtectionExitEvidenceError(
            "oto_child_fill_outside_entry_window",
            receipt.receiptId,
            childOrderId,
          );
        }
        return Object.freeze({
          activityId,
          quantity,
          price,
          occurredAt: new Date(occurredAt).toISOString(),
          sourceFactRef: caseflowFingerprint(fact),
          historyRef,
        });
      })
      .toSorted((left, right) =>
        left.occurredAt === right.occurredAt
          ? left.activityId.localeCompare(right.activityId)
          : left.occurredAt.localeCompare(right.occurredAt),
      );
    if (childActivities.length === 0) {
      continue;
    }
    const filledQuantity = childActivities.reduce((sum, fill) => sum + fill.quantity, 0);
    const childFilledQuantities = childSources.map((source) => finiteNumber(source.filled_qty));
    if (
      childFilledQuantities.some((quantity) => quantity === undefined) ||
      childFilledQuantities.some((quantity) => !numberMatches(quantity!, filledQuantity)) ||
      filledQuantity >
        (candidate.protectionQuantity ?? receipt.fill.filledQuantity) + QUANTITY_EPSILON
    ) {
      throw new FinanceOwnedProtectionExitEvidenceError(
        "oto_child_fill_quantity_mismatch",
        receipt.receiptId,
        childOrderId,
      );
    }
    const childOrderHistoryRefs = Object.freeze([
      ...new Set(childOrder ? [childOrder.historyRef] : []),
    ]);
    facts.push(
      Object.freeze({
        accountId: params.accountId,
        venue: params.venue,
        instrument,
        entryReceiptId: receipt.receiptId,
        entryIntentId: receipt.intentId,
        parentOrderId,
        childOrderId,
        entryFilledQuantity: receipt.fill.filledQuantity,
        filledQuantity,
        parentOrderHistoryRef: parent.historyRef,
        childOrderHistoryRefs,
        fills: Object.freeze(childActivities),
        ...(candidate.restorationClaimRef
          ? { restorationClaimRef: candidate.restorationClaimRef }
          : {}),
      }),
    );
  }
  return Object.freeze(
    facts.toSorted((left, right) => left.entryReceiptId.localeCompare(right.entryReceiptId)),
  );
}
