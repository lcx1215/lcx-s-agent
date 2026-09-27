import { brokerSymbol } from "./finance-broker-reconciliation.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { readFinanceIntradayDecisions } from "./finance-intraday-control-ledger.js";
import {
  readFinanceBrokerHistoryRecords,
  readFinanceLatestBrokerReconciliations,
  readFinancePositionLedger,
} from "./finance-position-ledger.js";

/** FIFO accounting diagnostic; never a strategy attribution or an execution gate. */
export function summarizeFinanceBrokerFills(
  activities: readonly Record<string, unknown>[],
  costsVerified: boolean,
) {
  const identities = new Map<string, Record<string, unknown>>();
  for (const row of activities) {
    if (typeof row.id !== "string" || !row.id) {
      throw new Error("missing activity identity");
    }
    identities.set(row.id, row);
  }
  const lots = new Map<string, { quantity: number; price: number; feePerUnit: number }[]>();
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
  const fills = [...identities.values()].filter((row) => {
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
    if (typeof row.order_id === "string") {
      orderQuantities.set(
        row.order_id,
        (orderQuantities.get(row.order_id) ?? 0) + numeric(row.qty),
      );
    }
  }
  const orderFees = new Map<string, number>();
  let unallocatedFees = 0;
  for (const row of identities.values()) {
    if (row.activity_type !== "CFEE" && row.activity_type !== "FEE") {
      continue;
    }
    const order = typeof row.order_id === "string" ? row.order_id : "";
    const cash =
      typeof row.net_amount === "string" || typeof row.net_amount === "number"
        ? numeric(row.net_amount)
        : NaN;
    if (
      row.status !== "executed" ||
      row.currency !== "USD" ||
      !Number.isFinite(cash) ||
      cash > 0 ||
      (row.qty !== undefined && numeric(row.qty) !== 0) ||
      !orderQuantities.has(order)
    ) {
      unallocatedFees++;
      continue;
    }
    orderFees.set(order, (orderFees.get(order) ?? 0) - cash);
  }
  fills.sort(
    (a, b) =>
      Date.parse(String(a.transaction_time)) - Date.parse(String(b.transaction_time)) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const timestamps = new Map<string, string>();
  for (const row of fills) {
    const key = `${String(row.symbol)}:${String(row.transaction_time)}`;
    const previousSide = timestamps.get(key);
    if (previousSide && previousSide !== row.side) {
      issues.add("ambiguous_same_time_fill_order");
    }
    timestamps.set(key, String(row.side));
    if (row.type !== "fill" || !["buy", "sell"].includes(String(row.side))) {
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
      book.push({ quantity, price, feePerUnit });
      continue;
    }
    sells++;
    let remaining = quantity;
    while (remaining > 1e-10 && book.length) {
      const lot = book[0],
        matched = Math.min(remaining, lot.quantity);
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
  return {
    basis: "broker_fill_fifo_usd_not_strategy_attribution",
    buyFills: buys,
    sellFills: sells,
    matchedLotCount: matches,
    openLotCount: [...lots.values()].reduce((sum, book) => sum + book.length, 0),
    grossMatchedPnl: gross,
    netMatchedPnl: matches > 0 && issues.size === 0 ? gross - allocatedFees : null,
    allocatedClosedCashFees: allocatedFees,
    unallocatedFeeActivityCount: unallocatedFees,
    feeActivityCount: fees,
    status: matches === 0 ? "no_closed_matches" : issues.size ? "net_profit_unverified" : "matched",
    issues: [...issues],
    costScope: "broker_reported_activities_only_excludes_tax_fx_and_external_costs",
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
    activities.filter((row) => row.activity_type === "FILL").map((row) => [row.id, row]),
  );
  let attributed = 0;
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
  };
}

export function summarizeFinanceBrokerFillsByInstrument(
  activities: readonly Record<string, unknown>[],
  costsVerified: boolean,
) {
  const unique = [...new Map(activities.map((row) => [row.id, row])).values()];
  const symbols = [
    ...new Set(
      unique.filter((row) => row.activity_type === "FILL").map((row) => brokerSymbol(row.symbol)),
    ),
  ];
  const orders = new Map(
    unique
      .filter((row) => row.activity_type === "FILL" && typeof row.order_id === "string")
      .map((row) => [row.order_id, brokerSymbol(row.symbol)]),
  );
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
        const linked = orders.get(row.order_id);
        // A symbol-less, unlinked fee remains an uncertainty for every instrument.
        return linked
          ? linked === instrument
          : typeof row.symbol !== "string" || brokerSymbol(row.symbol) === instrument;
      }),
      costsVerified,
    ),
  }));
}

export async function readFinanceBrokerProfitFeedback(directory: string, asOf: string) {
  try {
    const [latest, positions, decisions] = await Promise.all([
      readFinanceLatestBrokerReconciliations(directory),
      readFinancePositionLedger(directory, { asOf }),
      readFinanceIntradayDecisions(directory),
    ]);
    const accounts = await Promise.all(
      latest.records.map(async (record) => {
        const snapshot = record.snapshot;
        const at = typeof snapshot?.observedAt === "string" ? snapshot.observedAt : "";
        const age = Date.parse(asOf) - Date.parse(at);
        if (!Number.isFinite(age) || age < 0) {
          return { snapshotRef: record.ref, status: "snapshot_outside_cutoff" };
        }
        const history = await readFinanceBrokerHistoryRecords(
          directory,
          record.accountId,
          record.venue,
        );
        const activities = history.records
          .filter(
            (row) => row.sequence <= record.sequence && row.body.query.startsWith("activities:"),
          )
          .flatMap((row) => row.body.payload);
        return {
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
          ...summarizeFinanceBrokerFills(
            activities,
            snapshot.status === "reconciled" && snapshot.feesInterpreted === true,
          ),
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
