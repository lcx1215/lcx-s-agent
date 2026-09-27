import { brokerSymbol } from "./finance-broker-reconciliation.js";
import {
  readFinanceBrokerHistoryRecords,
  readFinanceLatestBrokerReconciliations,
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
  const lots = new Map<string, { quantity: number; price: number }[]>();
  let buys = 0,
    sells = 0,
    matches = 0,
    gross = 0;
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
    const book = lots.get(instrument) ?? [];
    lots.set(instrument, book);
    if (row.side === "buy") {
      buys++;
      book.push({ quantity, price });
      continue;
    }
    sells++;
    let remaining = quantity;
    while (remaining > 1e-10 && book.length) {
      const lot = book[0],
        matched = Math.min(remaining, lot.quantity);
      gross += matched * (price - lot.price);
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
  if (fees) {
    issues.add("fees_not_allocated_to_closed_lots");
  }
  return {
    basis: "broker_fill_fifo_usd_not_strategy_attribution",
    buyFills: buys,
    sellFills: sells,
    matchedLotCount: matches,
    openLotCount: [...lots.values()].reduce((sum, book) => sum + book.length, 0),
    grossMatchedPnl: gross,
    netMatchedPnl: matches > 0 && issues.size === 0 ? gross : null,
    feeActivityCount: fees,
    status: matches === 0 ? "no_closed_matches" : issues.size ? "net_profit_unverified" : "matched",
    issues: [...issues],
    costScope: "broker_reported_activities_only_excludes_tax_fx_and_external_costs",
  };
}

export async function readFinanceBrokerProfitFeedback(directory: string, asOf: string) {
  try {
    const latest = await readFinanceLatestBrokerReconciliations(directory);
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
