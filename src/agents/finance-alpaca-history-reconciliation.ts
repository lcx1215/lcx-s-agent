import { readFinanceBrokerHistory } from "./finance-alpaca-history-sync.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { readFinancePositionRecords } from "./finance-position-ledger.js";

type Fact = Readonly<{ stream: string; fact: Record<string, unknown> }>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(candidate) ? candidate : undefined;
}

function positive(value: unknown): number | undefined {
  const candidate = number(value);
  return candidate !== undefined && candidate > 0 ? candidate : undefined;
}

function normalizeInstrument(value: string): string {
  const instrument = value.trim().toUpperCase();
  return /^[A-Z0-9]+USD$/u.test(instrument) && !instrument.includes("/")
    ? `${instrument.slice(0, -3)}/USD`
    : instrument;
}

function baseAsset(instrument: string): string | undefined {
  const [asset] = instrument.split("/");
  return asset && asset.length > 0 ? asset : undefined;
}

function timestamp(fact: Record<string, unknown>, allowDate: boolean): string | undefined {
  const transaction = text(fact.transaction_time);
  if (transaction && Number.isFinite(Date.parse(transaction))) {
    return new Date(transaction).toISOString();
  }
  const date = text(fact.date);
  if (allowDate && date && /^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    const parsed = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date) {
      return `${date}T00:00:00.000Z`;
    }
  }
  return undefined;
}

export type FinanceBrokerFillObservation = Readonly<{
  activityId: string;
  orderId: string;
  instrument: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  occurredAt: string;
  sourceFactRef: string;
}>;

export type FinanceBrokerFeeObservation = Readonly<{
  activityId: string;
  activityType: "FEE" | "CFEE";
  orderId?: string;
  instrument?: string;
  amount: number;
  currency: string;
  occurredAt: string;
  sourceFactRef: string;
}>;

export type FinanceBrokerPosition = Readonly<{
  instrument: string;
  quantity: number;
  averageCost: number;
  realizedPnl: number;
  appliedUsdFees: number;
}>;

export type FinanceBrokerHistoryReconciliation = Readonly<{
  accountId: string;
  venue: "alpaca:paper";
  historyStatus: "missing" | "incomplete" | "reconciled";
  positionsReconciled: boolean;
  /** True when fills and filled-order coverage are complete, even if a fee needs later allocation. */
  positionBaselineUsable: boolean;
  feesInterpreted: boolean;
  brokerFillCount: number;
  brokerFeeCount: number;
  invalidFillCount: number;
  invalidFeeCount: number;
  orderCount: number;
  filledOrderCount: number;
  ordersMissingFillActivityCount: number;
  matchedReceiptCount: number;
  unmatchedFillCount: number;
  appliedFeeCount: number;
  unappliedFeeCount: number;
  /** Fees deterministically applied to the net position baseline without an order id. */
  baselineAppliedFeeCount: number;
  /** Fees applied through an explicit order id and a matching fill. */
  orderAllocatedFeeCount: number;
  /** Instruments whose net quantity includes a deterministic account-scoped asset-fee adjustment. */
  assetFeeAdjustedInstruments: readonly string[];
  feeTotals: readonly Readonly<{ currency: string; amount: number }>[];
  positions: readonly FinanceBrokerPosition[];
  fills: readonly FinanceBrokerFillObservation[];
  fees: readonly FinanceBrokerFeeObservation[];
  warnings: readonly string[];
}>;

type MutableBrokerPosition = {
  instrument: string;
  quantity: number;
  averageCost: number;
  realizedPnl: number;
  appliedUsdFees: number;
};

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function applyFill(
  position: MutableBrokerPosition,
  signedQuantity: number,
  price: number,
  usdFee: number,
): void {
  const openQuantity = position.quantity;
  const fillQuantity = Math.abs(signedQuantity);
  const closing =
    Math.sign(openQuantity) === Math.sign(signedQuantity)
      ? 0
      : Math.min(Math.abs(openQuantity), Math.abs(signedQuantity));
  const closingFee = fillQuantity === 0 ? 0 : (usdFee * closing) / fillQuantity;
  const openingFee = usdFee - closingFee;
  if (closing > 0) {
    position.realizedPnl +=
      closing * (price - position.averageCost) * Math.sign(openQuantity) - closingFee;
  }
  const nextQuantity = openQuantity + signedQuantity;
  const sameSide = Math.sign(nextQuantity) === Math.sign(openQuantity) && openQuantity !== 0;
  if (nextQuantity === 0) {
    position.averageCost = 0;
  } else if (closing > 0 && sameSide) {
    // A partial close does not change the cost of the remaining quantity.
  } else if (closing === 0 && sameSide) {
    position.averageCost =
      (Math.abs(openQuantity) * position.averageCost +
        Math.abs(signedQuantity) * price +
        Math.sign(signedQuantity) * openingFee) /
      (Math.abs(openQuantity) + Math.abs(signedQuantity));
  } else {
    position.averageCost =
      price + (Math.sign(signedQuantity) * openingFee) / Math.abs(nextQuantity);
  }
  position.quantity = nextQuantity;
  position.appliedUsdFees += usdFee;
}

function parseFill(fact: Record<string, unknown>): FinanceBrokerFillObservation {
  const activityId = text(fact.id);
  const orderId = text(fact.order_id);
  const instrument = text(fact.symbol);
  const side = text(fact.side);
  const quantity = positive(fact.qty);
  const price = positive(fact.price);
  const occurredAt = timestamp(fact, false);
  if (
    !activityId ||
    !orderId ||
    !instrument ||
    (side !== "buy" && side !== "sell") ||
    quantity === undefined ||
    price === undefined ||
    !occurredAt
  ) {
    throw new Error("FILL requires id, order_id, symbol, side, qty, price and transaction_time");
  }
  return {
    activityId,
    orderId,
    instrument: normalizeInstrument(instrument),
    side,
    quantity,
    price,
    occurredAt,
    sourceFactRef: caseflowFingerprint(fact),
  };
}

function parseFee(fact: Record<string, unknown>): FinanceBrokerFeeObservation {
  const activityId = text(fact.id);
  const activityType = text(fact.activity_type);
  const instrument = text(fact.symbol);
  const orderId = text(fact.order_id);
  const normalizedInstrument = instrument ? normalizeInstrument(instrument) : undefined;
  const description = text(fact.description)?.toLowerCase() ?? "";
  const rawQuantity = number(fact.qty);
  const nonUsdCryptoFee =
    activityType === "CFEE" && description.includes("non usd") && rawQuantity !== undefined;
  const rawAmount = number(fact.net_amount);
  const amount = nonUsdCryptoFee
    ? Math.abs(rawQuantity)
    : rawAmount === undefined
      ? undefined
      : Math.abs(rawAmount);
  const currency = nonUsdCryptoFee
    ? normalizedInstrument
      ? baseAsset(normalizedInstrument)
      : undefined
    : (text(fact.currency) ?? text(fact.asset));
  const occurredAt = timestamp(
    {
      ...fact,
      ...(fact.transaction_time === undefined && fact.created_at !== undefined
        ? { transaction_time: fact.created_at }
        : {}),
    },
    true,
  );
  if (
    !activityId ||
    (activityType !== "FEE" && activityType !== "CFEE") ||
    amount === undefined ||
    amount <= 0 ||
    !currency ||
    !occurredAt
  ) {
    throw new Error("fee requires id, net_amount, currency/asset and transaction_time/date");
  }
  return {
    activityId,
    activityType,
    ...(orderId ? { orderId } : {}),
    ...(normalizedInstrument ? { instrument: normalizedInstrument } : {}),
    amount,
    currency: currency.toUpperCase(),
    occurredAt,
    sourceFactRef: caseflowFingerprint(fact),
  };
}

function receiptOrderIds(receipts: readonly FinanceExecutionReceipt[]): Set<string> {
  return new Set(
    receipts.flatMap((receipt) => {
      const orderId = receipt.fill.terminalOrderIdentity?.orderId;
      return receipt.adapterKind === "venue" && orderId ? [orderId] : [];
    }),
  );
}

function syncWasComplete(facts: readonly Fact[]): boolean {
  const receipts = facts
    .filter(({ stream }) => stream === "sync_receipt")
    .map(({ fact }) => fact)
    .filter((fact) => fact.status === "raw_history_synced");
  return receipts.length > 0;
}

/**
 * Reconcile verified account-scoped Alpaca activities without turning them into execution
 * receipts. The projection is deliberately separate from the receipt chain: old fills have no
 * run authorization, but they are still useful for cost, fee and historical-position context.
 */
export async function reconcileFinanceBrokerHistory(
  directory: string,
  accountId: string,
): Promise<FinanceBrokerHistoryReconciliation> {
  const raw = await readFinanceBrokerHistory(directory, accountId);
  const activities = raw.facts.filter(({ stream }) => stream === "activities");
  const orders = raw.facts.filter(({ stream }) => stream === "orders");
  const fills: FinanceBrokerFillObservation[] = [];
  const fees: FinanceBrokerFeeObservation[] = [];
  let invalidFillCount = 0;
  let invalidFeeCount = 0;
  const warnings: string[] = [
    "Broker history is account-scoped Alpaca paper evidence; it is not current account equity and does not authorize orders.",
  ];
  for (const { fact } of activities) {
    const activityType = text(fact.activity_type);
    try {
      if (activityType === "FILL") {
        fills.push(parseFill(fact));
      } else if (activityType === "FEE" || activityType === "CFEE") {
        fees.push(parseFee(fact));
      }
    } catch (error) {
      if (activityType === "FILL") {
        invalidFillCount += 1;
      } else if (activityType === "FEE" || activityType === "CFEE") {
        invalidFeeCount += 1;
      }
      warnings.push(
        `${activityType || "unknown"} activity excluded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  fills.sort((left, right) =>
    left.occurredAt === right.occurredAt
      ? left.activityId.localeCompare(right.activityId)
      : left.occurredAt.localeCompare(right.occurredAt),
  );
  fees.sort((left, right) =>
    left.occurredAt === right.occurredAt
      ? left.activityId.localeCompare(right.activityId)
      : left.occurredAt.localeCompare(right.occurredAt),
  );

  const feeTotals = new Map<string, number>();
  for (const fee of fees) {
    feeTotals.set(fee.currency, (feeTotals.get(fee.currency) ?? 0) + fee.amount);
  }
  const usdFeesByOrder = new Map<string, FinanceBrokerFeeObservation[]>();
  const feesByOrder = new Map<string, FinanceBrokerFeeObservation[]>();
  for (const fee of fees) {
    if (fee.orderId) {
      feesByOrder.set(fee.orderId, [...(feesByOrder.get(fee.orderId) ?? []), fee]);
    }
    if (fee.currency === "USD" && fee.orderId) {
      usdFeesByOrder.set(fee.orderId, [...(usdFeesByOrder.get(fee.orderId) ?? []), fee]);
    }
  }
  const fillsByOrder = new Map<string, FinanceBrokerFillObservation[]>();
  for (const fill of fills) {
    fillsByOrder.set(fill.orderId, [...(fillsByOrder.get(fill.orderId) ?? []), fill]);
  }
  const appliedFeeIds = new Set<string>();
  const byInstrument = new Map<string, MutableBrokerPosition>();
  for (const fill of fills) {
    const position = byInstrument.get(fill.instrument) ?? {
      instrument: fill.instrument,
      quantity: 0,
      averageCost: 0,
      realizedPnl: 0,
      appliedUsdFees: 0,
    };
    const orderQuantity = (fillsByOrder.get(fill.orderId) ?? []).reduce(
      (sum, item) => sum + item.quantity,
      0,
    );
    const linkedFees = feesByOrder.get(fill.orderId) ?? [];
    for (const fee of linkedFees) {
      appliedFeeIds.add(fee.activityId);
    }
    const feeRatio = orderQuantity > 0 ? fill.quantity / orderQuantity : 0;
    const usdFee =
      (usdFeesByOrder.get(fill.orderId) ?? []).reduce((sum, fee) => sum + fee.amount, 0) * feeRatio;
    const asset = baseAsset(fill.instrument);
    const assetFee =
      asset === undefined
        ? 0
        : linkedFees
            .filter((fee) => fee.currency === asset)
            .reduce((sum, fee) => sum + fee.amount, 0) * feeRatio;
    const signedQuantity =
      fill.side === "buy" ? fill.quantity - assetFee : -(fill.quantity + assetFee);
    if (!Number.isFinite(signedQuantity) || signedQuantity === 0) {
      invalidFillCount += 1;
      warnings.push(`${fill.activityId} fill quantity is fully consumed by a linked asset fee`);
      continue;
    }
    // A fee paid in the traded base asset changes the net units received or delivered.
    // Preserve cash notional by adjusting the per-unit basis before applying USD fees.
    const effectivePrice = (fill.price * fill.quantity) / Math.abs(signedQuantity);
    applyFill(position, signedQuantity, effectivePrice, usdFee);
    byInstrument.set(fill.instrument, position);
  }

  // Alpaca CFEE rows can omit order_id while still identifying the traded symbol and the fee
  // asset. Apply those fees to the account-level quantity baseline only; preserve the missing
  // order-level linkage as an explicit warning instead of manufacturing an order id.
  const unlinkedAssetFees = new Map<
    string,
    { amount: number; count: number; activityIds: string[] }
  >();
  for (const fee of fees) {
    const asset = fee.instrument ? baseAsset(fee.instrument) : undefined;
    if (!fee.orderId && asset !== undefined && fee.currency === asset) {
      const previous = unlinkedAssetFees.get(fee.instrument!);
      unlinkedAssetFees.set(fee.instrument!, {
        amount: (previous?.amount ?? 0) + fee.amount,
        count: (previous?.count ?? 0) + 1,
        activityIds: [...(previous?.activityIds ?? []), fee.activityId],
      });
    }
  }
  const assetFeeAdjustedInstruments: string[] = [];
  for (const [instrument, fee] of unlinkedAssetFees) {
    const position = byInstrument.get(instrument);
    if (!position || position.quantity === 0) {
      warnings.push(
        `${fee.count} unlinked ${baseAsset(instrument) ?? "asset"} fee(s) could not adjust ${instrument}: no open quantity baseline`,
      );
      continue;
    }
    const adjusted = position.quantity - Math.sign(position.quantity) * fee.amount;
    if (!Number.isFinite(adjusted) || Math.sign(adjusted) !== Math.sign(position.quantity)) {
      warnings.push(
        `${fee.count} unlinked asset fee(s) could not adjust ${instrument}: fee exceeds the projected quantity`,
      );
      continue;
    }
    position.quantity = adjusted;
    for (const activityId of fee.activityIds) {
      appliedFeeIds.add(activityId);
    }
    assetFeeAdjustedInstruments.push(instrument);
    warnings.push(
      `${fee.count} unlinked asset fee(s) applied to the ${instrument} quantity baseline; order-level fee linkage remains unproven`,
    );
  }

  const records = await readFinancePositionRecords(directory);
  const scopedReceipts = records.receipts.filter(
    (receipt) => receipt.accountId === accountId && receipt.venue === "alpaca:paper",
  );
  const orderIds = receiptOrderIds(scopedReceipts);
  const matchedReceiptCount = fills.filter((fill) => orderIds.has(fill.orderId)).length;
  const unmatchedFillCount = fills.length - matchedReceiptCount;

  const filledOrderIds = new Set(
    orders.flatMap(({ fact }) => {
      const id = text(fact.id);
      const filledQuantity = number(fact.filled_qty);
      const status = text(fact.status);
      return id &&
        ((filledQuantity ?? 0) > 0 || status === "filled" || status === "partially_filled")
        ? [id]
        : [];
    }),
  );
  const fillOrderIds = new Set(fills.map((fill) => fill.orderId));
  const ordersMissingFillActivityCount = [...filledOrderIds].filter(
    (orderId) => !fillOrderIds.has(orderId),
  ).length;
  const feeTotalsResult = [...feeTotals]
    .map(([currency, amount]) => ({ currency, amount: round6(amount) }))
    .toSorted((left, right) => left.currency.localeCompare(right.currency));
  const positions = [...byInstrument.values()]
    .map((position) => ({
      instrument: position.instrument,
      quantity: round6(position.quantity),
      averageCost: round6(position.averageCost),
      realizedPnl: round6(position.realizedPnl),
      appliedUsdFees: round6(position.appliedUsdFees),
    }))
    .toSorted((left, right) => left.instrument.localeCompare(right.instrument));
  const appliedFeeCount = appliedFeeIds.size;
  const unappliedFeeCount = fees.length - appliedFeeCount;
  const baselineAppliedFeeCount = [...unlinkedAssetFees.values()].reduce(
    (sum, fee) =>
      sum + fee.activityIds.filter((activityId) => appliedFeeIds.has(activityId)).length,
    0,
  );
  const orderAllocatedFeeCount = fees.filter(
    (fee) => fee.orderId !== undefined && appliedFeeIds.has(fee.activityId),
  ).length;
  const complete = syncWasComplete(raw.facts);
  const historyStatus =
    raw.facts.filter(({ stream }) => stream !== "sync_receipt").length === 0
      ? "missing"
      : complete &&
          invalidFillCount === 0 &&
          invalidFeeCount === 0 &&
          ordersMissingFillActivityCount === 0 &&
          unappliedFeeCount === 0
        ? "reconciled"
        : "incomplete";
  const positionsReconciled = historyStatus === "reconciled";
  const positionBaselineUsable =
    complete && invalidFillCount === 0 && ordersMissingFillActivityCount === 0;
  const feesInterpreted = historyStatus === "reconciled" && unappliedFeeCount === 0;
  if (unmatchedFillCount > 0) {
    warnings.push(
      `${unmatchedFillCount} broker fill(s) have no matching durable execution receipt; they remain historical projection only`,
    );
  }
  if (unappliedFeeCount > 0) {
    warnings.push(`${unappliedFeeCount} fee(s) were totaled but not allocated to a USD order fill`);
  }
  if (ordersMissingFillActivityCount > 0) {
    warnings.push(
      `${ordersMissingFillActivityCount} filled/partially-filled order(s) have no FILL activity; position projection is incomplete`,
    );
  }
  return Object.freeze({
    accountId,
    venue: "alpaca:paper",
    historyStatus,
    positionsReconciled,
    positionBaselineUsable,
    feesInterpreted,
    brokerFillCount: fills.length,
    brokerFeeCount: fees.length,
    invalidFillCount,
    invalidFeeCount,
    orderCount: orders.length,
    filledOrderCount: filledOrderIds.size,
    ordersMissingFillActivityCount,
    matchedReceiptCount,
    unmatchedFillCount,
    appliedFeeCount,
    unappliedFeeCount,
    baselineAppliedFeeCount,
    orderAllocatedFeeCount,
    assetFeeAdjustedInstruments: Object.freeze(assetFeeAdjustedInstruments.toSorted()),
    feeTotals: Object.freeze(feeTotalsResult),
    positions: Object.freeze(positions),
    fills: Object.freeze(fills),
    fees: Object.freeze(fees),
    warnings: Object.freeze(warnings),
  });
}
