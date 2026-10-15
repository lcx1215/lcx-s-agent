import { isAlpacaTradeExecutionType } from "./finance-alpaca-activity-contract.js";
import { brokerSymbol } from "./finance-broker-reconciliation.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { FinanceBrokerExitFeedbackSchema } from "./finance-expectation-gap.js";
import { readFinanceIntradayDecisions } from "./finance-intraday-control-ledger.js";
import { readFinanceOwnedProtectionExitFacts } from "./finance-owned-protection-exits.js";
import {
  readFinanceBrokerHistoryActivities,
  reduceFinanceBrokerHistoryRecords,
  type BrokerHistoryRecord,
  readFinanceLatestBrokerReconciliations,
  readFinancePositionLedger,
} from "./finance-position-ledger.js";
import type { FinanceBrokerReconciliationObservation } from "./finance-position-management-feedback.js";
import type { FinancePositionLedgerObservation } from "./finance-rule-readiness-state.js";

function uniqueBrokerActivities(activities: readonly Record<string, unknown>[]) {
  const identities = new Map<string, Record<string, unknown>>();
  for (const row of activities) {
    if (typeof row.id !== "string" || !row.id) {
      throw new Error("missing activity identity");
    }
    const previous = identities.get(row.id);
    if (previous && caseflowFingerprint(previous) !== caseflowFingerprint(row)) {
      throw new Error("conflicting activity identity");
    }
    identities.set(row.id, row);
  }
  return [...identities.values()];
}

function brokerFillOrderScopes(activities: readonly Record<string, unknown>[]) {
  const orders = new Map<string, { instrument: string; side: unknown }>();
  for (const row of activities) {
    if (row.activity_type !== "FILL") {
      continue;
    }
    const instrument = brokerSymbol(row.symbol);
    if (
      (instrument.includes("/") && (!instrument.split("/")[0] || !instrument.endsWith("/USD"))) ||
      (row.currency !== undefined && row.currency !== "USD")
    ) {
      throw new Error("unsupported non-USD fill price unit");
    }
    if (typeof row.order_id !== "string" || !row.order_id.trim()) {
      continue;
    }
    const previous = orders.get(row.order_id);
    if (previous && (previous.instrument !== instrument || previous.side !== row.side)) {
      throw new Error("conflicting order instrument or side");
    }
    orders.set(row.order_id, { instrument, side: row.side });
  }
  for (const row of activities) {
    if (row.activity_type !== "CFEE" && row.activity_type !== "FEE") {
      continue;
    }
    const linked = typeof row.order_id === "string" ? orders.get(row.order_id) : undefined;
    if (
      linked &&
      typeof row.symbol === "string" &&
      row.symbol !== "USD" &&
      brokerSymbol(row.symbol) !== linked.instrument
    ) {
      throw new Error("conflicting fee order instrument");
    }
  }
  return orders;
}

function reportedAssetFeeValuation(activities: readonly Record<string, unknown>[]) {
  const finite = (value: unknown) => {
    const number =
      typeof value === "number" || (typeof value === "string" && value.trim().length > 0)
        ? Number(value)
        : NaN;
    return Number.isFinite(number) ? number : NaN;
  };
  let usdValue = 0;
  let activityCount = 0;
  for (const row of activities) {
    if (row.activity_type !== "CFEE" && row.activity_type !== "FEE") {
      continue;
    }
    const quantity = row.qty === undefined ? 0 : finite(row.qty);
    const cash = finite(row.net_amount);
    const executedUsd = row.status === "executed" && row.currency === "USD";
    if (executedUsd && quantity === 0 && Number.isFinite(cash) && cash <= 0) {
      continue;
    }
    if (row.activity_type !== "CFEE" && quantity === 0) {
      continue;
    }
    if (row.activity_type !== "CFEE") {
      return null;
    }
    const price = finite(row.price);
    if (!executedUsd || !(quantity < 0) || !(price > 0) || cash !== 0) {
      return null;
    }
    let instrument: string;
    try {
      instrument = brokerSymbol(row.symbol);
    } catch {
      return null;
    }
    if (!instrument.split("/")[0] || !instrument.endsWith("/USD")) {
      return null;
    }
    const value = -quantity * price;
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    usdValue += value;
    if (!Number.isFinite(usdValue)) {
      return null;
    }
    activityCount++;
  }
  return activityCount
    ? {
        usdValue,
        activityCount,
        basis: "broker_qty_x_price_not_cash_or_closed_lot_cost" as const,
      }
    : null;
}

export type FinanceBrokerMatchedLot = {
  instrument: string;
  entryActivityId: string;
  exitActivityId: string;
  entryOrderId: string;
  exitOrderId: string;
  entryAt: string;
  exitAt: string;
  quantity: number;
  grossPnl: number;
  allocatedCashFees: number;
};

/** FIFO accounting diagnostic; never a strategy attribution or an execution gate. */
export function summarizeFinanceBrokerFills(
  activities: readonly Record<string, unknown>[],
  costsVerified: boolean,
  options: { includeMatchedLots?: boolean } = {},
) {
  const matchedLots: FinanceBrokerMatchedLot[] = [];
  const unique = uniqueBrokerActivities(activities);
  const orderScopes = brokerFillOrderScopes(unique);
  const lots = new Map<
    string,
    {
      quantity: number;
      price: number;
      feePerUnit: number;
      activityId: string;
      orderId: string;
      at: string;
    }[]
  >();
  let buys = 0,
    sells = 0,
    matches = 0,
    gross = 0,
    allocatedFees = 0;
  let fees = 0;
  const issues = new Set<string>();
  const numeric = (v: unknown) => {
    if (
      (typeof v !== "number" && typeof v !== "string") ||
      String(v).trim() === "" ||
      !Number.isFinite(Number(v))
    ) {
      throw new Error("invalid activity number");
    }
    return Number(v);
  };
  const fills = unique.filter((row) => {
    if (row.activity_type === "CFEE" || row.activity_type === "FEE") {
      fees++;
    }
    return row.activity_type === "FILL";
  });
  if (
    fills.some(
      (row) =>
        typeof row.transaction_time !== "string" ||
        !Number.isFinite(Date.parse(row.transaction_time)),
    )
  ) {
    throw new Error("missing fill time");
  }
  const orderQuantities = new Map<string, number>();
  for (const row of fills) {
    if (typeof row.order_id === "string" && orderScopes.has(row.order_id)) {
      orderQuantities.set(
        row.order_id,
        (orderQuantities.get(row.order_id) ?? 0) + numeric(row.qty),
      );
    }
  }
  const orderFees = new Map<string, number>();
  let unallocatedFees = 0;
  let unallocatedCashFeeAmount = 0;
  let unpricedFeeActivityCount = 0;
  for (const row of unique) {
    if (row.activity_type !== "CFEE" && row.activity_type !== "FEE") {
      continue;
    }
    const order = typeof row.order_id === "string" ? row.order_id : "";
    const feeNumber = (value: unknown) => {
      try {
        return numeric(value);
      } catch {
        return NaN;
      }
    };
    const cash = feeNumber(row.net_amount);
    if (
      row.status !== "executed" ||
      row.currency !== "USD" ||
      !Number.isFinite(cash) ||
      cash > 0 ||
      (row.qty !== undefined && feeNumber(row.qty) !== 0)
    ) {
      unallocatedFees++;
      unpricedFeeActivityCount++;
      continue;
    }
    if (!orderQuantities.has(order)) {
      unallocatedFees++;
      unallocatedCashFeeAmount -= cash;
      continue;
    }
    orderFees.set(order, (orderFees.get(order) ?? 0) - cash);
  }
  if (
    !Number.isFinite(unallocatedCashFeeAmount) ||
    [...orderQuantities.values(), ...orderFees.values()].some((value) => !Number.isFinite(value))
  ) {
    throw new Error("nonfinite fee pool or order quantity");
  }
  fills.sort(
    (a, b) =>
      Date.parse(String(a.transaction_time)) - Date.parse(String(b.transaction_time)) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const timestamps = new Map<string, string>();
  for (const row of fills) {
    const key = `${brokerSymbol(row.symbol)}:${Date.parse(String(row.transaction_time))}`;
    const previousSide = timestamps.get(key);
    if (previousSide && previousSide !== row.side) {
      issues.add("ambiguous_same_time_fill_order");
    }
    timestamps.set(key, String(row.side));
    if (!isAlpacaTradeExecutionType(row.type) || !["buy", "sell"].includes(String(row.side))) {
      throw new Error("unsupported fill correction or short side");
    }
    const instrument = brokerSymbol(row.symbol),
      quantity = numeric(row.qty),
      price = numeric(row.price);
    if (quantity <= 0 || price <= 0) {
      throw new Error("nonpositive fill");
    }
    const order = typeof row.order_id === "string" ? row.order_id : "";
    const feePerUnit = (orderFees.get(order) ?? 0) / (orderQuantities.get(order) ?? quantity);
    const book = lots.get(instrument) ?? [];
    lots.set(instrument, book);
    if (row.side === "buy") {
      buys++;
      book.push({
        quantity,
        price,
        feePerUnit,
        activityId: String(row.id),
        orderId: order,
        at: String(row.transaction_time),
      });
      continue;
    }
    sells++;
    let remaining = quantity;
    while (remaining > 1e-10 && book.length) {
      const lot = book[0],
        matched = Math.min(remaining, lot.quantity);
      if (options.includeMatchedLots) {
        matchedLots.push({
          instrument,
          entryActivityId: lot.activityId,
          exitActivityId: String(row.id),
          entryOrderId: lot.orderId,
          exitOrderId: order,
          entryAt: lot.at,
          exitAt: String(row.transaction_time),
          quantity: matched,
          grossPnl: matched * (price - lot.price),
          allocatedCashFees: matched * (lot.feePerUnit + feePerUnit),
        });
      }
      gross += matched * (price - lot.price);
      allocatedFees += matched * (lot.feePerUnit + feePerUnit);
      matches++;
      remaining -= matched;
      lot.quantity -= matched;
      if (lot.quantity <= 1e-10) {
        book.shift();
      }
    }
    if (remaining > 1e-10) {
      issues.add("unmatched_sell_or_short_position");
    }
  }
  if (!costsVerified) {
    issues.add("history_or_cost_reconciliation_unverified");
  }
  if (unallocatedFees) {
    issues.add("fees_not_allocated_to_closed_lots");
  }
  const upper = gross - allocatedFees;
  const lower = upper - unallocatedCashFeeAmount;
  const recordedCashFeePnlBounds =
    matches > 0 &&
    costsVerified &&
    unpricedFeeActivityCount === 0 &&
    [...issues].every((issue) => issue === "fees_not_allocated_to_closed_lots") &&
    Number.isFinite(lower) &&
    Number.isFinite(upper) &&
    lower <= upper
      ? { lower, upper }
      : null;
  return {
    basis: "broker_fill_fifo_usd_not_strategy_attribution",
    ...(options.includeMatchedLots ? { matchedLots } : {}),
    buyFills: buys,
    sellFills: sells,
    matchedLotCount: matches,
    openLotCount: [...lots.values()].reduce((sum, book) => sum + book.length, 0),
    grossMatchedPnl: gross,
    netMatchedPnl: matches > 0 && issues.size === 0 ? gross - allocatedFees : null,
    allocatedClosedCashFees: allocatedFees,
    unallocatedFeeActivityCount: unallocatedFees,
    unallocatedCashFeeAmount,
    unpricedFeeActivityCount,
    // Source valuation does not allocate these asset fees into closed FIFO lots.
    reportedAssetFeeValuation: reportedAssetFeeValuation(unique),
    recordedCashFeePnlBounds,
    cashFeeAllocationBoundary:
      "recorded_cash_fees_only_not_exact_net_nonadditive_across_instruments",
    feeActivityCount: fees,
    status: matches === 0 ? "no_closed_matches" : issues.size ? "net_profit_unverified" : "matched",
    issues: [...issues],
    costScope: "broker_reported_activities_only_excludes_tax_fx_and_external_costs",
  };
}

/** Attribute original FIFO matches by the actual entry order, never by ticker or a model label. */
export function attributeFinanceBrokerMatchedLots(params: {
  lots: readonly FinanceBrokerMatchedLot[];
  receipts: readonly FinanceExecutionReceipt[];
  decisions: readonly {
    ref: string;
    recordedAt: string;
    input: {
      signalId: string;
      instrument: string;
      action: string;
      strategyRule: string;
      strategyBinding?: { declarationRef: string; activationRef: string };
    };
  }[];
  accountId: string;
  asOf: string;
  costsVerified: boolean;
}) {
  const methods = new Map<
    string,
    {
      ruleId: string;
      declarationRef: string;
      activationRef: string;
      matchedLotCount: number;
      matchedQuantity: number;
      grossMatchedPnl: number;
      allocatedCashFees: number;
      firstEntryAt: string;
      lastExitAt: string;
      entries: Map<string, { quantity: number; filledQuantity: number; decisionRef: string }>;
    }
  >();
  let attributed = 0;
  const cutoff = Date.parse(params.asOf);
  if (!Number.isFinite(cutoff)) {
    throw new Error("invalid method performance cutoff");
  }
  const inScope = params.lots.filter(
    (lot) =>
      Number.isFinite(Date.parse(lot.entryAt)) &&
      Number.isFinite(Date.parse(lot.exitAt)) &&
      Date.parse(lot.exitAt) <= cutoff &&
      Date.parse(lot.entryAt) <= Date.parse(lot.exitAt),
  );
  const matchedByOrder = new Map<string, number>();
  for (const lot of inScope) {
    matchedByOrder.set(
      lot.entryOrderId,
      (matchedByOrder.get(lot.entryOrderId) ?? 0) + lot.quantity,
    );
  }
  for (const lot of inScope) {
    const receipts = params.receipts.filter(
      (r) =>
        r.accountId === params.accountId &&
        r.venue === "alpaca:paper" &&
        r.adapterKind === "venue" &&
        r.side === "buy" &&
        r.instrument === lot.instrument &&
        r.fill.venueRef === `alpaca:paper:${lot.entryOrderId}` &&
        r.fill.filledQuantity + 1e-6 >=
          (matchedByOrder.get(lot.entryOrderId) ?? Number.POSITIVE_INFINITY) &&
        r.fill.terminalOrderIdentity?.terminal === true &&
        r.fill.terminalOrderIdentity.orderId === lot.entryOrderId &&
        Date.parse(r.recordedAt) <= cutoff,
    );
    if (receipts.length !== 1) {
      continue;
    }
    const receipt = receipts[0];
    const decisions = params.decisions.filter(
      (d) =>
        d.input.action === "buy" &&
        d.input.instrument === lot.instrument &&
        receipt.intentId === `intent:${d.input.signalId}` &&
        receipt.decisionRef?.source === "intraday_signal" &&
        receipt.decisionRef.id === d.input.signalId &&
        Date.parse(d.recordedAt) <= Date.parse(lot.entryAt) &&
        d.input.strategyBinding,
    );
    if (decisions.length !== 1) {
      continue;
    }
    const decision = decisions[0],
      binding = decision.input.strategyBinding;
    if (
      !binding ||
      !/^[a-f0-9]{64}$/u.test(binding.declarationRef) ||
      !/^[a-f0-9]{64}$/u.test(binding.activationRef)
    ) {
      continue;
    }
    const key = JSON.stringify([
      decision.input.strategyRule,
      binding.declarationRef,
      binding.activationRef,
    ]);
    const method = methods.get(key) ?? {
      ruleId: decision.input.strategyRule,
      declarationRef: binding.declarationRef,
      activationRef: binding.activationRef,
      matchedLotCount: 0,
      matchedQuantity: 0,
      grossMatchedPnl: 0,
      allocatedCashFees: 0,
      firstEntryAt: lot.entryAt,
      lastExitAt: lot.exitAt,
      entries: new Map<string, { quantity: number; filledQuantity: number; decisionRef: string }>(),
    };
    method.matchedLotCount++;
    method.matchedQuantity += lot.quantity;
    method.grossMatchedPnl += lot.grossPnl;
    method.allocatedCashFees += lot.allocatedCashFees;
    if (Date.parse(lot.entryAt) < Date.parse(method.firstEntryAt)) {
      method.firstEntryAt = lot.entryAt;
    }
    if (Date.parse(lot.exitAt) > Date.parse(method.lastExitAt)) {
      method.lastExitAt = lot.exitAt;
    }
    const entry = method.entries.get(receipt.receiptId) ?? {
      quantity: 0,
      filledQuantity: receipt.fill.filledQuantity,
      decisionRef: decision.ref,
    };
    entry.quantity += lot.quantity;
    method.entries.set(receipt.receiptId, entry);
    methods.set(key, method);
    attributed++;
  }
  return {
    boundary: "entry_rule_attributed_broker_fifo_matches_not_alpha_or_account_return",
    asOf: params.asOf,
    matchedLotCount: inScope.length,
    omittedOutsideCutoffOrInvalidLots: params.lots.length - inScope.length,
    attributedMatchedLotCount: attributed,
    unattributedMatchedLotCount: inScope.length - attributed,
    methods: [...methods.values()].map(({ entries, ...method }) => ({
      ...method,
      entryCount: entries.size,
      fullyClosedEntryCount: [...entries.values()].filter(
        (e) => Math.abs(e.quantity - e.filledQuantity) <= 1e-6,
      ).length,
      entryDecisionRefs: [...new Set([...entries.values()].map((e) => e.decisionRef))].slice(0, 4),
      omittedEntryDecisionRefs: Math.max(
        0,
        new Set([...entries.values()].map((e) => e.decisionRef)).size - 4,
      ),
      netMatchedPnl: params.costsVerified
        ? method.grossMatchedPnl - method.allocatedCashFees
        : null,
      costStatus: params.costsVerified ? "broker_reported_costs_only" : "net_unverified",
      costScope: "broker_reported_cash_fees_only_excludes_external_llm_tax_fx_costs",
      sampleBoundary:
        "partial FIFO matches are not independent trades or evidence of predictive skill",
    })),
  };
}

/** Match only account-bound execution receipts; a matching ticker is not ownership. */
export function attributeFinanceBrokerFills(
  activities: readonly Record<string, unknown>[],
  receipts: readonly FinanceExecutionReceipt[],
  decisions: readonly {
    input: { signalId: string; instrument: string; action: string; strategyRule: string };
  }[],
  accountId: string,
) {
  const fills = new Map(
    activities
      .filter((row) => row.activity_type === "FILL" && isAlpacaTradeExecutionType(row.type))
      .map((row) => [row.id, row]),
  );
  let attributed = 0;
  let dailyCycleSourceBound = 0;
  let dailyCycleSourceUnknown = 0;
  const rules = new Map<string, number>();
  for (const fill of fills.values()) {
    const matching = receipts.filter(
      (receipt) =>
        receipt.accountId === accountId &&
        receipt.adapterKind === "venue" &&
        receipt.fill?.venueRef === `alpaca:paper:${String(fill.order_id)}` &&
        receipt.instrument === brokerSymbol(fill.symbol) &&
        receipt.side === fill.side,
    );
    const candidates = new Set(
      matching.flatMap((receipt) =>
        decisions
          .filter(
            (decision) =>
              receipt.intentId === `intent:${decision.input.signalId}` &&
              decision.input.instrument === receipt.instrument &&
              decision.input.action === receipt.side,
          )
          .map((decision) => decision.input.strategyRule),
      ),
    );
    // Daily-cycle candidates have no intraday decision row. Preserve their
    // decision-reference lineage separately; this is source bookkeeping, not
    // strategy ownership or performance attribution.
    if (matching.length === 1 && matching[0]?.decisionRef?.source === "daily_cycle_candidate") {
      dailyCycleSourceBound++;
    } else if (candidates.size !== 1 && (matching.length !== 0 || candidates.size === 0)) {
      dailyCycleSourceUnknown++;
    }
    if (candidates.size === 1) {
      attributed++;
      const rule = [...candidates][0];
      rules.set(rule, (rules.get(rule) ?? 0) + 1);
    }
  }
  return {
    attributedFillCount: attributed,
    unattributedFillCount: fills.size - attributed,
    strategies: [...rules].map(([strategyRule, fillCount]) => ({ strategyRule, fillCount })),
    boundary: "receipt_and_decision_binding_not_strategy_pnl_or_position_ownership_transfer",
    decisionSourceLineage: {
      dailyCycleCandidateFillCount: dailyCycleSourceBound,
      unknownOrAmbiguousSourceFillCount: dailyCycleSourceUnknown,
      boundary:
        "decision_source_receipt_lineage_only_not_research_alpha_execution_alpha_or_strategy_pnl",
    },
  };
}

export function summarizeFinanceBrokerFillsByInstrument(
  activities: readonly Record<string, unknown>[],
  costsVerified: boolean,
) {
  const unique = uniqueBrokerActivities(activities);
  const symbols = [
    ...new Set(
      unique.filter((row) => row.activity_type === "FILL").map((row) => brokerSymbol(row.symbol)),
    ),
  ];
  const orders = brokerFillOrderScopes(unique);
  return symbols.map((instrument) => ({
    instrument,
    ...summarizeFinanceBrokerFills(
      unique.filter((row) => {
        if (row.activity_type === "FILL") {
          return brokerSymbol(row.symbol) === instrument;
        }
        if (row.activity_type !== "CFEE" && row.activity_type !== "FEE") {
          return false;
        }
        const linked = typeof row.order_id === "string" ? orders.get(row.order_id) : undefined;
        // A symbol-less, unlinked fee remains an uncertainty for every instrument.
        return linked
          ? linked.instrument === instrument
          : typeof row.symbol !== "string" ||
              (row.symbol === "USD" && (row.qty === undefined || Number(row.qty) === 0)) ||
              brokerSymbol(row.symbol) === instrument;
      }),
      costsVerified,
    ),
  }));
}

export async function readFinanceBrokerProfitFeedback(
  directory: string,
  asOf: string,
  observations: {
    positionObservation?: FinancePositionLedgerObservation;
    reconciliationObservation?: FinanceBrokerReconciliationObservation;
  } = {},
) {
  try {
    const [latest, positions, decisions] = await Promise.all([
      observations.reconciliationObservation?.directory === directory &&
      observations.reconciliationObservation.asOf === asOf
        ? observations.reconciliationObservation.read()
        : readFinanceLatestBrokerReconciliations(directory),
      observations.positionObservation?.directory === directory &&
      observations.positionObservation.asOf === asOf
        ? observations.positionObservation.read()
        : readFinancePositionLedger(directory, { asOf }),
      readFinanceIntradayDecisions(directory),
    ]);
    const accounts = await Promise.all(
      latest.records.map(async (record) => {
        const snapshot = record.snapshot;
        const at = typeof snapshot?.observedAt === "string" ? snapshot.observedAt : "";
        const age = Date.parse(asOf) - Date.parse(at);
        if (!Number.isFinite(age) || age < 0) {
          return {
            accountId: record.accountId,
            venue: record.venue,
            snapshotRef: record.ref,
            status: "snapshot_outside_cutoff",
          };
        }
        const history = await readFinanceBrokerHistoryActivities(
          directory,
          record.accountId,
          record.venue,
          record.sequence,
        );
        const activities = history.activities;
        const fifo = summarizeFinanceBrokerFills(
          activities,
          snapshot.status === "reconciled" && snapshot.feesInterpreted === true,
          { includeMatchedLots: true },
        );
        const { matchedLots, ...fifoSummary } = fifo;
        const methodPerformance = attributeFinanceBrokerMatchedLots({
          lots: matchedLots ?? [],
          receipts: positions.receipts,
          decisions,
          accountId: record.accountId,
          asOf,
          costsVerified: fifo.netMatchedPnl !== null,
        });
        return {
          accountId: record.accountId,
          venue: record.venue,
          snapshotRef: record.ref,
          observedAt: at,
          freshness: age <= 300_000 && !record.superseded ? "fresh" : "stale",
          strategyAttribution: attributeFinanceBrokerFills(
            activities,
            positions.receipts,
            decisions.filter((decision) => Date.parse(decision.recordedAt) <= Date.parse(asOf)),
            record.accountId,
          ),
          instruments: summarizeFinanceBrokerFillsByInstrument(
            activities,
            snapshot.status === "reconciled" && snapshot.feesInterpreted === true,
          ),
          ...fifoSummary,
          methodPerformance,
        };
      }),
    );
    return {
      status: accounts.length ? "present" : "absent",
      accounts,
      omittedAccounts: latest.omittedAccounts,
      executionAuthority: "none",
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      executionAuthority: "none",
    };
  }
}

/** Sealed, account-bound FIFO research evidence; never strategy performance or authority. */
export async function readFinanceBrokerInstrumentFeedback(options: {
  directory: string;
  accountId: string;
  instrument: string;
  asOf: string;
}) {
  const scope = {
    accountId: options.accountId,
    venue: "alpaca:paper" as const,
    instrument: options.instrument,
  };
  const base = {
    scope,
    asOf: options.asOf,
    boundary: "broker_fifo_instrument_not_strategy_pnl_or_account_return" as const,
    executionAuthority: "none" as const,
  };
  let historyHeadRef: string | null = null;
  const unavailable = (reason: string) => ({
    ...base,
    status: "unavailable" as const,
    freshness: "unknown" as const,
    historyHeadRef,
    reason,
  });
  const time = (value: unknown): number => {
    if (typeof value !== "string") {
      return NaN;
    }
    const date = value.slice(0, 10);
    const day = /^\d{4}-\d{2}-\d{2}$/u.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) {
      return NaN;
    }
    return value === date
      ? day
      : /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
        ? Date.parse(value)
        : NaN;
  };
  try {
    const cutoff = time(options.asOf);
    if (
      !options.accountId.trim() ||
      !/^[A-Z0-9][A-Z0-9./-]{0,31}$/u.test(options.instrument) ||
      !Number.isFinite(cutoff) ||
      options.asOf.length <= 10
    ) {
      return unavailable("invalid_scope_or_cutoff");
    }
    const history = await reduceFinanceBrokerHistoryRecords(
      options.directory,
      options.accountId,
      scope.venue,
      { selected: undefined as BrokerHistoryRecord | undefined, invalidTime: false },
      (state, record) => {
        if (record.body.query.startsWith("reconciliation:")) {
          const at = time(record.body.payload[0]?.observedAt);
          if (!Number.isFinite(at)) {
            state.invalidTime = true;
          } else if (at <= cutoff) {
            state.selected = record;
          }
        }
        return state;
      },
    );
    historyHeadRef = history.headRef;
    if (history.value.invalidTime) {
      return unavailable("snapshot_time_unverified");
    }
    const selected = history.value.selected;
    if (!selected) {
      return unavailable("missing_snapshot_at_cutoff");
    }
    const snapshot = selected.body.payload[0];
    const observedAt = snapshot.observedAt as string;
    if (cutoff - time(observedAt) > 300_000) {
      return unavailable("snapshot_stale");
    }
    if (
      snapshot.status !== "reconciled" ||
      snapshot.feesInterpreted !== true ||
      !Array.isArray(snapshot.issues) ||
      snapshot.issues.length ||
      !Array.isArray(snapshot.differences) ||
      snapshot.differences.length ||
      typeof snapshot.cashDifference !== "number" ||
      !Number.isFinite(snapshot.cashDifference) ||
      Math.abs(snapshot.cashDifference) > 0.01
    ) {
      return unavailable("snapshot_reconciliation_unverified");
    }
    const identities = new Map<string, string>();
    const collected = await reduceFinanceBrokerHistoryRecords(
      options.directory,
      options.accountId,
      scope.venue,
      { activities: [] as Record<string, unknown>[], reason: undefined as string | undefined },
      (state, record) => {
        if (
          state.reason ||
          record.sequence > selected.sequence ||
          !record.body.query.startsWith("activities:")
        ) {
          return state;
        }
        for (const row of record.body.payload) {
          if (typeof row.id !== "string" || !row.id) {
            return { ...state, reason: "activity_identity_unverified" };
          }
          const fingerprint = caseflowFingerprint(row);
          const previous = identities.get(row.id);
          if (previous !== undefined) {
            if (previous !== fingerprint) {
              return { ...state, reason: "conflicting_activity_identity" };
            }
            continue;
          }
          identities.set(row.id, fingerprint);
          const occurred = row.transaction_time ?? row.created_at ?? row.date;
          if (
            row.activity_type === "FILL" ||
            row.activity_type === "CFEE" ||
            row.activity_type === "FEE" ||
            occurred !== undefined
          ) {
            const at = time(occurred);
            if (!Number.isFinite(at) || at > time(observedAt) || at > cutoff) {
              return { ...state, reason: "activity_time_unverified_or_future" };
            }
          }
          state.activities.push(row);
        }
        return state;
      },
    );
    if (collected.value.reason) {
      return unavailable(collected.value.reason);
    }
    const activities = collected.value.activities;
    const economics = summarizeFinanceBrokerFillsByInstrument(activities, true).find(
      (row) => row.instrument === options.instrument,
    ) ?? { instrument: options.instrument, ...summarizeFinanceBrokerFills([], true) };
    if (
      Object.values(economics).some((value) => typeof value === "number" && !Number.isFinite(value))
    ) {
      return unavailable("nonfinite_economics");
    }
    return {
      ...base,
      status: "present" as const,
      freshness: "fresh" as const,
      observedAt,
      snapshotRef: selected.ref,
      historyHeadRef,
      sealedSequence: selected.sequence,
      observationBoundary:
        "snapshot_observedAt_and_sequence_only_no_per_record_capture_time" as const,
      economics,
    };
  } catch {
    return unavailable("broker_history_or_economics_unavailable");
  }
}

/** Existing owned-stop owner -> original entry/activation -> measured feedback; no receipt writes. */
export async function readFinanceBrokerExitFeedback(
  directory: string,
  params: {
    accountId: string;
    instrument: string;
    ruleId: string;
    activationRef: string;
    asOf: string;
  },
) {
  const cutoff = Date.parse(params.asOf);
  if (!Number.isFinite(cutoff)) {
    throw new Error("invalid exit feedback cutoff");
  }
  const [ledger, decisions] = await Promise.all([
    readFinancePositionLedger(directory, { asOf: params.asOf }),
    readFinanceIntradayDecisions(directory, { asOf: params.asOf }),
  ]);
  const eligibleSignals = new Set(
    decisions
      .filter(
        (d) =>
          d.input.action === "buy" &&
          d.input.strategyRule === params.ruleId &&
          d.input.strategyBinding?.activationRef === params.activationRef,
      )
      .map((d) => d.input.signalId),
  );
  const receipts = ledger.receipts.filter(
    (r) =>
      r.accountId === params.accountId &&
      r.venue === "alpaca:paper" &&
      r.decisionRef?.source === "intraday_signal" &&
      eligibleSignals.has(r.decisionRef.id) &&
      Date.parse(r.recordedAt) <= cutoff &&
      Date.parse(r.fill.filledAt) <= cutoff,
  );
  const exits = await readFinanceOwnedProtectionExitFacts({
    directory,
    accountId: params.accountId,
    venue: "alpaca:paper",
    receipts,
    asOf: params.asOf,
  });
  const entries = [];
  for (const exit of exits) {
    const receipt = receipts.find((r) => r.receiptId === exit.entryReceiptId);
    if (!receipt || receipt.decisionRef?.source !== "intraday_signal") {
      continue;
    }
    const matches = decisions.filter(
      (d) =>
        d.input.signalId === receipt.decisionRef!.id &&
        receipt.intentId === `intent:${d.input.signalId}` &&
        d.input.action === "buy" &&
        d.input.instrument === receipt.instrument &&
        d.input.strategyRule === params.ruleId &&
        d.input.strategyBinding?.activationRef === params.activationRef &&
        Date.parse(d.recordedAt) <= Date.parse(receipt.fill.filledAt),
    );
    if (matches.length !== 1) {
      continue;
    }
    const decision = matches[0],
      cash = exit.fills.reduce((sum, f) => sum + f.quantity * f.price, 0);
    const basis = {
      instrument: exit.instrument,
      signalId: decision.input.signalId,
      decisionRef: decision.ref,
      receiptId: receipt.receiptId,
      entryOrderId: exit.parentOrderId,
      exitOrderId: exit.childOrderId,
      ...(exit.restorationClaimRef ? { restorationClaimRef: exit.restorationClaimRef } : {}),
      entryPrice: receipt.fill.fillPrice,
      entryQuantity: receipt.fill.filledQuantity,
      exitQuantity: exit.filledQuantity,
      exitAveragePrice: cash / exit.filledQuantity,
      grossPnl: cash - exit.filledQuantity * receipt.fill.fillPrice,
      lastFillAt: exit.fills
        .map((f) => f.occurredAt)
        .toSorted()
        .at(-1)!,
      partialFillCount: exit.fills.length,
      exitActivityRefs: exit.fills.slice(0, 8).map((f) => f.sourceFactRef),
      omittedActivityRefCount: Math.max(0, exit.fills.length - 8),
      sourceHistoryRefs: [
        ...new Set([
          exit.parentOrderHistoryRef,
          ...exit.childOrderHistoryRefs,
          ...exit.fills.map((f) => f.historyRef),
        ]),
      ].slice(0, 10),
      fees: "not_attributed" as const,
      netPnl: null,
    };
    entries.push({
      ...basis,
      feedbackId: caseflowFingerprint({
        accountId: params.accountId,
        ruleId: params.ruleId,
        activationRef: params.activationRef,
        entryReceiptId: exit.entryReceiptId,
        decisionRef: decision.ref,
        entryOrderId: exit.parentOrderId,
        exitOrderId: exit.childOrderId,
        entryPrice: receipt.fill.fillPrice,
        fillFactRefs: exit.fills.map((fill) => fill.sourceFactRef),
      }),
      historyRef: exit.parentOrderHistoryRef,
    });
  }
  const selected = entries
    .toSorted(
      (a, b) =>
        Number(b.instrument === params.instrument) - Number(a.instrument === params.instrument) ||
        b.lastFillAt.localeCompare(a.lastFillAt),
    )
    .slice(0, 2);
  if (!selected.length) {
    return undefined;
  }
  return FinanceBrokerExitFeedbackSchema.parse({
    ...params,
    historyRef: selected[0].historyRef,
    methodSummary: {
      sourceRef: caseflowFingerprint({
        accountId: params.accountId,
        ruleId: params.ruleId,
        activationRef: params.activationRef,
        feedbackIds: entries.map((entry) => entry.feedbackId).toSorted(),
      }),
      observedExitCount: entries.length,
      instrumentCount: new Set(entries.map((entry) => entry.instrument)).size,
      partialExitCount: entries.filter((entry) => entry.exitQuantity < entry.entryQuantity).length,
      grossPnl: entries.reduce((sum, entry) => sum + entry.grossPnl, 0),
      netPnl: null,
      fees: "not_attributed",
      boundary: "owned_protective_exits_only_not_all_method_trades_or_independent_trials",
    },
    entries: selected.map(({ historyRef: _historyRef, ...entry }) => entry),
    boundary: "broker_parent_leg_entry_binding_not_new_execution_receipt_or_strategy_alpha",
  });
}
