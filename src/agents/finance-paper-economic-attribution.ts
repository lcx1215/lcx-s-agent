import { z } from "zod";
import { summarizeFinanceBrokerFills } from "./finance-broker-profit-feedback.js";
import { brokerSymbol } from "./finance-broker-reconciliation.js";
import { financeEtClock } from "./finance-cycle-schedule.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { readFinanceIntradayDecisions } from "./finance-intraday-control-ledger.js";
import {
  readFinanceBrokerHistoryActivities,
  readFinancePositionLedger,
  reduceFinanceBrokerHistoryRecords,
} from "./finance-position-ledger.js";

const Numeric = z
  .union([z.number(), z.string().min(1)])
  .transform(Number)
  .pipe(z.number().finite());
const Snapshot = z.object({
  status: z.literal("reconciled"),
  observedAt: z.string().datetime(),
  feesInterpreted: z.boolean(),
  accountObservation: z.object({
    accountId: z.string(),
    currency: z.literal("USD"),
    equity: z.number().finite(),
    observedAt: z.string().datetime(),
    accruedFees: z.number().finite().nullable().optional(),
    pendingRegTafFees: z.number().finite().nullable().optional(),
  }),
  positions: z.array(
    z.object({
      symbol: z.string(),
      qty: Numeric,
      market_value: Numeric,
    }),
  ),
});
type Snapshot = z.infer<typeof Snapshot>;
type OriginalDecision = Awaited<ReturnType<typeof readFinanceIntradayDecisions>>[number];
type Decision = Pick<OriginalDecision, "ref" | "recordedAt"> & {
  input: Pick<OriginalDecision["input"], "signalId" | "instrument" | "action" | "strategyRule"> & {
    strategyBinding?: Pick<
      NonNullable<OriginalDecision["input"]["strategyBinding"]>,
      "declarationRef" | "activationRef"
    >;
  };
};
type Anchor = { at: string; equity: number; ref: string };
type Cohort = "inheritedPositions" | "newDecisions" | "unlinkedPostAnchorEntries";

function positionMap(snapshot: Snapshot) {
  const result = new Map<string, { quantity: number; price: number }>();
  for (const p of snapshot.positions) {
    const symbol = brokerSymbol(p.symbol);
    if (result.has(symbol) || p.qty <= 0 || p.market_value <= 0) {
      throw new Error("unsupported_or_duplicate_position");
    }
    result.set(symbol, { quantity: p.qty, price: p.market_value / p.qty });
  }
  return result;
}

/** Original FIFO lots, rebased to original broker marks; no new execution/ledger authority. */
export function attributeFinancePaperEconomics(params: {
  accountId: string;
  anchor: Anchor;
  opening: unknown;
  closing: unknown;
  closingRef: string;
  activities: readonly Record<string, unknown>[];
  receipts: readonly FinanceExecutionReceipt[];
  decisions: readonly Decision[];
}) {
  const start = Snapshot.parse(params.opening),
    end = Snapshot.parse(params.closing);
  const from = Date.parse(start.observedAt),
    through = Date.parse(end.observedAt);
  if (
    start.accountObservation.accountId !== params.accountId ||
    end.accountObservation.accountId !== params.accountId ||
    start.observedAt !== params.anchor.at ||
    start.accountObservation.equity !== params.anchor.equity ||
    through < from ||
    Date.parse(start.accountObservation.observedAt) > from ||
    Date.parse(end.accountObservation.observedAt) > through
  ) {
    throw new Error("account_anchor_or_cutoff_mismatch");
  }
  const issues = new Set<string>();
  // The sealed reconciliation bounds all activities; explicit fill times must also fit.
  const activities = params.activities.filter((r) => {
    if (r.activity_type !== "FILL") {
      return true;
    }
    const t = typeof r.transaction_time === "string" ? Date.parse(r.transaction_time) : NaN;
    if (!Number.isFinite(t) || t > through) {
      throw new Error("fill_outside_reconciliation");
    }
    return true;
  });
  const openingFills = activities.filter(
    (r) => r.activity_type === "FILL" && Date.parse(String(r.transaction_time)) <= from,
  );
  const openingBook = summarizeFinanceBrokerFills(openingFills, false, { includeOpenLots: true });
  const fifo = summarizeFinanceBrokerFills(activities, end.feesInterpreted, {
    includeMatchedLots: true,
    includeOpenLots: true,
  });
  const openingMarks = positionMap(start),
    closingMarks = positionMap(end);
  const openLots = fifo.openLots ?? [];
  const openingLots = openingBook.openLots ?? [];
  const invalid = new Set<string>();
  const historicalResidualSymbols = new Set<string>();
  const postFillSymbols = new Set(
    activities
      .filter((r) => r.activity_type === "FILL" && Date.parse(String(r.transaction_time)) > from)
      .map((r) => brokerSymbol(r.symbol)),
  );
  const symbols = new Set([
    ...openingMarks.keys(),
    ...closingMarks.keys(),
    ...openingLots.map((l) => l.instrument),
    ...openLots.map((l) => l.instrument),
  ]);
  for (const symbol of symbols) {
    // A reconciled flat position at both endpoints cannot carry old FIFO dust into this window.
    // Keep the legacy mismatch visible without inventing an opening economic exposure.
    if (!openingMarks.has(symbol) && !closingMarks.has(symbol) && !postFillSymbols.has(symbol)) {
      historicalResidualSymbols.add(symbol);
      continue;
    }
    const initial = openingLots
      .filter((l) => l.instrument === symbol)
      .reduce((s, l) => s + l.quantity, 0);
    const final = openLots
      .filter((l) => l.instrument === symbol)
      .reduce((s, l) => s + l.quantity, 0);
    if (
      Math.abs(initial - (openingMarks.get(symbol)?.quantity ?? 0)) > 1e-10 ||
      Math.abs(final - (closingMarks.get(symbol)?.quantity ?? 0)) > 1e-10
    ) {
      invalid.add(symbol);
      issues.add(`fifo_position_quantity_mismatch:${symbol}`);
    }
  }
  const ambiguousFifo = fifo.issues.some(
    (i) => i === "ambiguous_same_time_fill_order" || i === "unmatched_sell_or_short_position",
  );
  if (ambiguousFifo) {
    issues.add("fifo_match_order_or_history_incomplete");
  }
  const orderQuantity = new Map<string, number>();
  const activityIds = new Set<string>();
  for (const r of activities) {
    if (r.activity_type === "FILL" && !activityIds.has(String(r.id))) {
      activityIds.add(String(r.id));
      const id = String(r.order_id);
      orderQuantity.set(id, (orderQuantity.get(id) ?? 0) + Number(r.qty));
    }
  }
  function decisionFor(orderId: string, instrument: string, side: string, fillAt: string) {
    const receipts = params.receipts.filter(
      (r) =>
        r.accountId === params.accountId &&
        r.venue === "alpaca:paper" &&
        r.adapterKind === "venue" &&
        r.instrument === instrument &&
        r.side === side &&
        r.fill.venueRef === `alpaca:paper:${orderId}` &&
        r.fill.terminalOrderIdentity?.terminal === true &&
        r.fill.terminalOrderIdentity.orderId === orderId &&
        Math.abs(r.fill.filledQuantity - (orderQuantity.get(orderId) ?? NaN)) <= 1e-10 &&
        Date.parse(r.recordedAt) <= through,
    );
    if (receipts.length !== 1) {
      return null;
    }
    const receipt = receipts[0];
    const matches = params.decisions.filter(
      (d) =>
        receipt.decisionRef?.source === "intraday_signal" &&
        receipt.decisionRef.id === d.input.signalId &&
        receipt.intentId === `intent:${d.input.signalId}` &&
        d.input.instrument === instrument &&
        d.input.action === side &&
        Date.parse(d.recordedAt) > from &&
        Date.parse(d.recordedAt) <= Date.parse(fillAt) &&
        d.input.strategyBinding,
    );
    if (matches.length !== 1) {
      return null;
    }
    return {
      decisionRef: matches[0].ref,
      receiptId: receipt.receiptId,
      ruleId: matches[0].input.strategyRule,
      binding: {
        declarationRef: matches[0].input.strategyBinding!.declarationRef,
        activationRef: matches[0].input.strategyBinding!.activationRef,
      },
    };
  }
  const cohorts = {
    inheritedPositions: { realizedGrossPnl: 0, unrealizedGrossPnl: 0, lotCount: 0 },
    newDecisions: { realizedGrossPnl: 0, unrealizedGrossPnl: 0, lotCount: 0 },
    unlinkedPostAnchorEntries: { realizedGrossPnl: 0, unrealizedGrossPnl: 0, lotCount: 0 },
  };
  const evidence: {
    instrument: string;
    entryActivityId: string;
    exitActivityId: string | null;
    entryOrderId: string;
    exitOrderId: string | null;
    quantity: number;
    cohort: Cohort;
    kind: "realized" | "unrealized";
    grossPnl: number | null;
    entryDecision: ReturnType<typeof decisionFor>;
    exitDecision: ReturnType<typeof decisionFor>;
  }[] = [];
  let inheritedExitByNewDecision = 0;
  function add(lot: {
    instrument: string;
    entryAt: string;
    entryOrderId: string;
    entryActivityId: string;
    entryPrice: number;
    quantity: number;
    exitAt?: string;
    exitOrderId?: string;
    exitActivityId?: string;
    exitPrice?: number;
  }) {
    const inherited = Date.parse(lot.entryAt) <= from;
    const entryDecision = inherited
      ? null
      : decisionFor(lot.entryOrderId, lot.instrument, "buy", lot.entryAt);
    const exitDecision =
      lot.exitOrderId && lot.exitAt
        ? decisionFor(lot.exitOrderId, lot.instrument, "sell", lot.exitAt)
        : null;
    const cohort: Cohort = inherited
      ? "inheritedPositions"
      : entryDecision
        ? "newDecisions"
        : "unlinkedPostAnchorEntries";
    if (!inherited && !entryDecision) {
      issues.add("post_anchor_entry_decision_unverified");
    }
    const basis = inherited ? openingMarks.get(lot.instrument)?.price : lot.entryPrice;
    const mark = lot.exitPrice ?? closingMarks.get(lot.instrument)?.price;
    const grossPnl =
      basis !== undefined && mark !== undefined && !invalid.has(lot.instrument) && !ambiguousFifo
        ? lot.quantity * (mark - basis)
        : null;
    const kind = lot.exitAt ? "realized" : "unrealized";
    if (grossPnl === null) {
      issues.add(`lot_valuation_unavailable:${lot.instrument}`);
    } else {
      cohorts[cohort][kind === "realized" ? "realizedGrossPnl" : "unrealizedGrossPnl"] += grossPnl;
      if (inherited && exitDecision) {
        inheritedExitByNewDecision += grossPnl;
      }
    }
    cohorts[cohort].lotCount++;
    evidence.push({
      instrument: lot.instrument,
      entryActivityId: lot.entryActivityId,
      exitActivityId: lot.exitActivityId ?? null,
      entryOrderId: lot.entryOrderId,
      exitOrderId: lot.exitOrderId ?? null,
      quantity: lot.quantity,
      cohort,
      kind,
      grossPnl,
      entryDecision,
      exitDecision,
    });
  }
  for (const lot of fifo.matchedLots ?? []) {
    if (Date.parse(lot.exitAt) > from) {
      add(lot);
    }
  }
  for (const lot of openLots) {
    if (historicalResidualSymbols.has(lot.instrument)) {
      continue;
    }
    add({
      instrument: lot.instrument,
      entryAt: lot.at,
      entryOrderId: lot.orderId,
      entryActivityId: lot.activityId,
      entryPrice: lot.price,
      quantity: lot.quantity,
    });
  }
  const gross = Object.values(cohorts).reduce(
    (sum, c) => sum + c.realizedGrossPnl + c.unrealizedGrossPnl,
    0,
  );
  const equityChange = end.accountObservation.equity - start.accountObservation.equity;
  const feeTimesUnknown: string[] = [];
  const startDay = financeEtClock(new Date(from)).date,
    endDay = financeEtClock(new Date(through)).date;
  const periodActivities = activities.filter((row) => {
    if (row.activity_type === "FILL") {
      return true;
    }
    if (row.activity_type !== "FEE" && row.activity_type !== "CFEE") {
      return false;
    }
    const time =
      typeof row.transaction_time === "string" &&
      /T.*(?:Z|[+-]\d\d:\d\d)$/.test(row.transaction_time)
        ? Date.parse(row.transaction_time)
        : NaN;
    if (Number.isFinite(time)) {
      return time > from && time <= through;
    }
    if (typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      if (row.date < startDay || row.date > endDay) {
        return false;
      }
      if (row.date > startDay && row.date < endDay) {
        return true;
      }
    }
    feeTimesUnknown.push(String(row.id));
    return false;
  });
  const periodFees = summarizeFinanceBrokerFills(periodActivities, false);
  const feeEvidence = [
    ...new Map(
      activities
        .filter((r) => r.activity_type === "FEE" || r.activity_type === "CFEE")
        .map((r) => [
          String(r.id),
          {
            activityId: String(r.id),
            type: r.activity_type,
            date: r.date ?? null,
            transactionTime: r.transaction_time ?? null,
            orderId: r.order_id ?? null,
            status: r.status ?? null,
            currency: r.currency ?? null,
            netAmount: r.net_amount ?? null,
            quantity: r.qty ?? null,
            price: r.price ?? null,
          },
        ]),
    ).values(),
  ];
  return {
    status: issues.size ? "partially_attributed" : "gross_price_contributions_attributed",
    basis: "broker_reconciliation_marks_and_original_FIFO; not_close_return_or_code_causal_effect",
    openingRef: params.anchor.ref,
    closingRef: params.closingRef,
    from: start.observedAt,
    through: end.observedAt,
    accountEquityChange: equityChange,
    cohorts: Object.fromEntries(
      Object.entries(cohorts).map(([key, value]) => [
        key,
        {
          lotCount: value.lotCount,
          realizedGrossPnl: evidence.some(
            (e) => e.cohort === key && e.kind === "realized" && e.grossPnl === null,
          )
            ? null
            : value.realizedGrossPnl,
          unrealizedGrossPnl: evidence.some(
            (e) => e.cohort === key && e.kind === "unrealized" && e.grossPnl === null,
          )
            ? null
            : value.unrealizedGrossPnl,
          knownGrossPnl: value.realizedGrossPnl + value.unrealizedGrossPnl,
          grossPnl: evidence.some((e) => e.cohort === key && e.grossPnl === null)
            ? null
            : value.realizedGrossPnl + value.unrealizedGrossPnl,
          unknownLotCount: evidence.filter((e) => e.cohort === key && e.grossPnl === null).length,
        },
      ]),
    ),
    inheritedExitsByNewDecision: {
      grossPnl: evidence.some(
        (e) => e.cohort === "inheritedPositions" && e.exitDecision && e.grossPnl === null,
      )
        ? null
        : inheritedExitByNewDecision,
      boundary: "subset_of_inherited_realized_not_additive; not_counterfactual_decision_alpha",
    },
    unresolvedPositionSymbols: [...invalid],
    preAnchorFifoResiduals: {
      symbols: [...historicalResidualSymbols],
      ignoredLotCount: openLots.filter((l) => historicalResidualSymbols.has(l.instrument)).length,
      boundary:
        "reconciled_flat_at_both_endpoints_and_no_window_fills; historical_FIFO_not_rewritten",
    },
    attributedGrossPnl: gross,
    unallocatedPnl: equityChange - gross,
    residualMeaning:
      "equity_change_minus_known_gross; includes_cashflows_fees_income_corporate_actions_unvalued_lots_and_snapshot_skew; not_profit",
    fees: {
      periodConfirmedReportedCashFees: periodFees.reportedCashFeeAmount,
      periodAssetFeeValuation: periodFees.reportedAssetFeeValuation,
      periodTimeAmbiguousActivityIds: [...new Set(feeTimesUnknown)],
      historicalFeeActivityCount: fifo.feeActivityCount,
      historicalReportedCashFees: fifo.reportedCashFeeAmount,
      historicalCashFeesAllocatedToClosedLots: fifo.allocatedClosedCashFees,
      historicalUnallocatedCashFees: fifo.unallocatedCashFeeAmount,
      historicalAssetFeeValuation: fifo.reportedAssetFeeValuation,
      unpricedOrNonCashFeeActivityCount: fifo.unpricedFeeActivityCount,
      feeEvidence,
      feesInterpreted: end.feesInterpreted,
      accountAccruedFees: end.accountObservation.accruedFees ?? null,
      accountPendingRegTafFees: end.accountObservation.pendingRegTafFees ?? null,
      pendingFeesCompleteness: "unknown; vendor_reported_balances_not_final_bill",
      treatment: "already_in_account_equity; do_not_subtract_again; gross_cohorts_not_net",
    },
    modelBill: null,
    issues: [...issues],
    evidence,
  };
}

/** All evidence comes from existing hash-verified account ledgers, without network or writes. */
export async function readFinancePaperEconomicAttribution(
  directory: string,
  accountId: string,
  anchor: Anchor | null,
  asOf: string,
) {
  if (!anchor) {
    return { status: "unavailable", reason: "repair_anchor_missing" };
  }
  try {
    if (!Number.isFinite(Date.parse(asOf)) || Date.parse(asOf) < Date.parse(anchor.at)) {
      throw new Error("invalid_attribution_cutoff");
    }
    type Stored = { snapshot: Snapshot; ref: string; sequence: number };
    const snapshots = await reduceFinanceBrokerHistoryRecords(
      directory,
      accountId,
      "alpaca:paper",
      { opening: undefined as Stored | undefined, closing: undefined as Stored | undefined },
      (state, record) => {
        const parsed = Snapshot.safeParse(record.body.payload[0]);
        if (
          !parsed.success ||
          parsed.data.accountObservation.accountId !== accountId ||
          Date.parse(parsed.data.observedAt) > Date.parse(asOf)
        ) {
          return state;
        }
        const stored = { snapshot: parsed.data, ref: record.ref, sequence: record.sequence };
        if (record.ref === anchor.ref) {
          state.opening = stored;
        }
        if (!state.closing || parsed.data.observedAt > state.closing.snapshot.observedAt) {
          state.closing = stored;
        }
        return state;
      },
      { streams: ["reconciliation"] },
    );
    const { opening, closing } = snapshots.value;
    if (!opening || !closing) {
      throw new Error("reconciliation_attribution_snapshots_missing");
    }
    const [history, positions, decisions] = await Promise.all([
      readFinanceBrokerHistoryActivities(directory, accountId, "alpaca:paper", closing.sequence),
      readFinancePositionLedger(directory, { asOf: closing.snapshot.observedAt }),
      readFinanceIntradayDecisions(directory),
    ]);
    const result = attributeFinancePaperEconomics({
      accountId,
      anchor,
      opening: opening.snapshot,
      closing: closing.snapshot,
      closingRef: closing.ref,
      activities: history.activities,
      receipts: positions.receipts,
      decisions,
    });
    return {
      ...result,
      evidence: result.evidence.slice(0, 12),
      omittedEvidenceLots: Math.max(0, result.evidence.length - 12),
      fees: {
        ...result.fees,
        feeEvidence: result.fees.feeEvidence.slice(0, 8),
        omittedFeeEvidence: Math.max(0, result.fees.feeEvidence.length - 8),
      },
      evidenceBoundary:
        "all_lots_and_fees_aggregated_before_example_limits; references_resolve_original_ledger",
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "attribution_unverified",
    };
  }
}
