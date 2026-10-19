import { z } from "zod";
import {
  createFinanceCashMergerCollector,
  isAlpacaTradeExecutionType,
} from "./finance-alpaca-activity-contract.js";
import {
  syncAlpacaPaperHistory,
  type AlpacaHistoryOptions,
} from "./finance-alpaca-history-sync.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  financeBrokerHistoryCoverage,
  financeHistoryInstant,
} from "./finance-history-sync-coverage.js";
import {
  appendFinanceBrokerHistory,
  reduceFinanceBrokerHistoryRecords,
  readFinanceLatestBrokerReconciliations,
} from "./finance-position-ledger.js";
import { classifyFinanceProtectionOrders } from "./finance-protection-coordination.js";

const host = "https://paper-api.alpaca.markets";
const number = (value: unknown): number => {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && !value.trim())
  ) {
    throw new Error("missing broker number");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("invalid broker number");
  }
  return parsed;
};
export function brokerSymbol(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9.]+(?:\/[A-Z]+)?$/.test(value)) {
    throw new Error("invalid broker symbol");
  }
  return value.endsWith("USD") && !value.includes("/") ? `${value.slice(0, -3)}/USD` : value;
}

type BrokerSnapshotFacts = {
  positions: readonly Record<string, unknown>[];
  cash: number;
  completeFromInception: boolean;
};

/** Economic events, not order snapshots: never count both receipts and broker fills. */
export function reconcileFinanceBrokerActivities(
  input: BrokerSnapshotFacts & {
    activities: readonly Record<string, unknown>[];
    asOf?: string;
  },
) {
  const accumulator = createBrokerActivityAccumulator(input.asOf);
  for (const row of input.activities) {
    accumulator.observe(row);
  }
  return accumulator.finish(input);
}

/** The same accounting reducer runs before the final broker snapshot freshness lease. */
function createBrokerActivityAccumulator(asOf?: string) {
  const quantities = new Map<string, number>();
  const identities = new Map<string, string>();
  const issues: string[] = [];
  const fees: { id: string; instrument?: string; quantity: number; cash: number }[] = [];
  const cashMergers = createFinanceCashMergerCollector(asOf);
  const corporateActions: {
    type: "CMA";
    groupId: string;
    corporateActionId: string;
    instrument: string;
    activityIds: string[];
    quantity: number;
    cash: number;
  }[] = [];
  let cash = 0;
  // Diagnostic decomposition of recognized cash flows; it grants no reconciliation authority.
  const cashComponents = { fillCash: 0, feeCash: 0, otherCash: 0 };
  const add = (symbol: string, qty: number) =>
    quantities.set(symbol, (quantities.get(symbol) ?? 0) + qty);
  const observe = (row: Record<string, unknown>) => {
    try {
      if (typeof row.id !== "string" || !row.id) {
        throw new Error("activity identity missing");
      }
      const fingerprint = caseflowFingerprint(row);
      const previous = identities.get(row.id);
      if (previous) {
        if (previous !== fingerprint) {
          issues.push(`conflicting_activity:${row.id}`);
        }
        return;
      }
      identities.set(row.id, fingerprint);
      if (row.activity_type === "FILL") {
        if (!isAlpacaTradeExecutionType(row.type) || !["buy", "sell"].includes(String(row.side))) {
          throw new Error("unsupported fill correction or side");
        }
        const qty = number(row.qty),
          price = number(row.price);
        if (qty <= 0 || price <= 0) {
          throw new Error("invalid fill");
        }
        const signed = row.side === "buy" ? qty : -qty;
        add(brokerSymbol(row.symbol), signed);
        cash -= signed * price;
        cashComponents.fillCash -= signed * price;
      } else if (row.activity_type === "CFEE" || row.activity_type === "FEE") {
        if (asOf !== undefined) {
          // Settlement dates may be future-dated even when the fee has already occurred.
          const occurredAt = row.transaction_time ?? row.created_at ?? row.date;
          const timestamp = (value: unknown, allowDate: boolean): number => {
            if (typeof value !== "string") {
              return NaN;
            }
            const date = value.slice(0, 10);
            const day = /^\d{4}-\d{2}-\d{2}$/u.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
            if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) {
              return NaN;
            }
            if (allowDate && value === date) {
              return day;
            }
            return /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
              ? Date.parse(value)
              : NaN;
          };
          const cutoff = timestamp(asOf, false);
          const occurred = timestamp(occurredAt, true);
          if (!Number.isFinite(cutoff) || !Number.isFinite(occurred) || occurred > cutoff) {
            throw new Error("fee occurrence outside cutoff or unknown");
          }
        }
        if (row.status !== "executed") {
          throw new Error("fee not executed");
        }
        const quantity = row.qty === undefined ? 0 : number(row.qty);
        const amount = number(row.net_amount);
        if (quantity > 0 || amount > 0) {
          throw new Error("unsupported fee correction");
        }
        const instrument = quantity !== 0 ? brokerSymbol(row.symbol) : undefined;
        if (instrument) {
          add(instrument, quantity);
        }
        if (row.currency !== undefined && row.currency !== "USD") {
          throw new Error("unsupported fee currency");
        }
        cash += amount;
        cashComponents.feeCash += amount;
        fees.push({ id: row.id, instrument, quantity, cash: amount });
      } else if (row.activity_type === "MA" && row.activity_sub_type === "CMA") {
        cashMergers.observe(row, fingerprint);
      } else if (["JNLC", "CSD", "CSW", "DIV", "INT"].includes(String(row.activity_type))) {
        if (
          row.status !== "executed" ||
          (row.currency !== undefined && row.currency !== "USD") ||
          (row.qty !== undefined && number(row.qty) !== 0)
        ) {
          throw new Error("unsupported cash activity");
        }
        const amount = number(row.net_amount);
        cash += amount;
        cashComponents.otherCash += amount;
      } else {
        throw new Error("unsupported activity type");
      }
    } catch {
      issues.push(`unsupported_activity:${typeof row.id === "string" ? row.id : "missing"}`);
    }
  };
  const finish = (input: BrokerSnapshotFacts) => {
    const mergers = cashMergers.finish();
    issues.push(...mergers.issues);
    for (const merger of mergers.events) {
      add(merger.instrument, merger.quantity);
      cash += merger.cash;
      cashComponents.otherCash += merger.cash;
      corporateActions.push({
        type: "CMA",
        groupId: merger.groupId,
        corporateActionId: merger.corporateActionId,
        instrument: merger.instrument,
        activityIds: [...merger.activityIds],
        quantity: merger.quantity,
        cash: merger.cash,
      });
    }
    const actual = new Map<string, number>();
    for (const row of input.positions) {
      const symbol = brokerSymbol(row.symbol);
      if (actual.has(symbol)) {
        throw new Error("duplicate broker position");
      }
      actual.set(symbol, number(row.qty));
    }
    const differences = [...new Set([...quantities.keys(), ...actual.keys()])]
      .map((instrument) => ({
        instrument,
        historicalQuantity: quantities.get(instrument) ?? 0,
        brokerQuantity: actual.get(instrument) ?? 0,
        unexplainedQuantity: (actual.get(instrument) ?? 0) - (quantities.get(instrument) ?? 0),
      }))
      .filter((row) => Math.abs(row.unexplainedQuantity) > 1e-10);
    const cashDifference = input.cash - cash;
    if (!input.completeFromInception) {
      issues.push("history_not_complete_from_inception");
    }
    if (!Number.isFinite(input.cash) || Math.abs(cashDifference) > 0.01) {
      issues.push("cash_difference");
    }
    return {
      status:
        issues.length === 0 && differences.length === 0
          ? ("reconciled" as const)
          : ("unresolved" as const),
      quantities: [...quantities].map(([instrument, quantity]) => ({ instrument, quantity })),
      fees,
      ...(corporateActions.length > 0 ? { corporateActions } : {}),
      cashFromActivities: cash,
      cashComponents,
      brokerCash: input.cash,
      cashDifference,
      differences,
      issues,
      // A quantity gap is not evidence of a fee, even when it matches a published rate.
      feesInterpreted: issues.length === 0 && differences.length === 0,
    };
  };
  return { observe, finish };
}

export type FinanceQuantityDifferenceIsolation = Readonly<{
  instruments: readonly string[];
  maxUnexplainedNotional: number;
}>;

export type FinanceExecutionReconciliation = Readonly<{
  status: "ready" | "restricted" | "blocked";
  historyStatus: "reconciled" | "unresolved";
  quarantinedInstruments: readonly string[];
  uncertaintyReserve: number;
  reasons: readonly string[];
}>;

/** Historical completeness and current execution scope are distinct; never manufacture a fee. */
export function assessFinanceBrokerExecutionReadiness(input: {
  reconciliation: Pick<
    ReturnType<typeof reconcileFinanceBrokerActivities>,
    "status" | "differences" | "issues" | "cashDifference" | "brokerCash"
  >;
  positions: readonly { instrument: string; quantity: number; marketValue: number }[];
  isolation?: FinanceQuantityDifferenceIsolation;
}): FinanceExecutionReconciliation {
  const { reconciliation: r, isolation } = input;
  const blocked = (reason: string): FinanceExecutionReconciliation => ({
    status: "blocked",
    historyStatus: r.status,
    quarantinedInstruments: [],
    uncertaintyReserve: 0,
    reasons: [reason],
  });
  if (
    r.issues.length ||
    !Number.isFinite(r.brokerCash) ||
    r.brokerCash < 0 ||
    !Number.isFinite(r.cashDifference) ||
    Math.abs(r.cashDifference) > 0.01
  ) {
    return blocked("account_history_or_cash_unresolved");
  }
  if (r.status === "reconciled" && !r.differences.length) {
    return {
      status: "ready",
      historyStatus: r.status,
      quarantinedInstruments: [],
      uncertaintyReserve: 0,
      reasons: [],
    };
  }
  if (
    r.status !== "unresolved" ||
    !r.differences.length ||
    !isolation ||
    !Number.isFinite(isolation.maxUnexplainedNotional) ||
    isolation.maxUnexplainedNotional <= 0
  ) {
    return blocked("quantity_difference_requires_explicit_isolation_policy");
  }
  const positions = new Map(input.positions.map((p) => [p.instrument, p]));
  if (positions.size !== input.positions.length) {
    return blocked("duplicate_native_position");
  }
  const quarantined = new Set<string>();
  let notional = 0;
  for (const difference of r.differences) {
    const position = positions.get(difference.instrument);
    if (
      !isolation.instruments.includes(difference.instrument) ||
      quarantined.has(difference.instrument) ||
      !position ||
      !Number.isFinite(position.quantity) ||
      position.quantity <= 0 ||
      !Number.isFinite(position.marketValue) ||
      position.marketValue <= 0 ||
      !Number.isFinite(difference.historicalQuantity) ||
      difference.historicalQuantity <= 0 ||
      difference.brokerQuantity !== position.quantity ||
      !Number.isFinite(difference.unexplainedQuantity) ||
      difference.unexplainedQuantity >= 0 ||
      Math.abs(
        difference.brokerQuantity - difference.historicalQuantity - difference.unexplainedQuantity,
      ) > 1e-10
    ) {
      return blocked("quantity_difference_cannot_be_isolated");
    }
    notional +=
      (Math.abs(difference.unexplainedQuantity) * position.marketValue) / position.quantity;
    quarantined.add(difference.instrument);
  }
  // Reserve upward to the next account-currency cent, rather than rounding uncertainty away.
  const uncertaintyReserve = Math.ceil(notional * 100) / 100;
  if (
    !Number.isFinite(uncertaintyReserve) ||
    uncertaintyReserve <= 0 ||
    uncertaintyReserve > isolation.maxUnexplainedNotional
  ) {
    return blocked("quantity_difference_exceeds_isolation_budget");
  }
  return {
    status: "restricted",
    historyStatus: "unresolved",
    quarantinedInstruments: [...quarantined].toSorted(),
    uncertaintyReserve,
    reasons: ["historical_quantity_difference_isolated_not_reconciled"],
  };
}

/** Persist source observations and reconciliation in the existing broker history chain. GET only. */
export async function syncFinanceBrokerReconciliation(
  options: AlpacaHistoryOptions & { read: NonNullable<AlpacaHistoryOptions["read"]> },
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const get = async (path: string) => {
    signal.throwIfAborted();
    const result = await options.read(`${host}${path}`, {
      headers: {
        "APCA-API-KEY-ID": options.credentials.keyId,
        "APCA-API-SECRET-KEY": options.credentials.secretKey,
      },
      signal,
    });
    signal.throwIfAborted();
    if (result.status !== 200) {
      throw new Error("broker reconciliation GET unavailable");
    }
    return JSON.parse(result.body) as unknown;
  };
  const first = (await get("/v2/account")) as Record<string, unknown>;
  if (first.id !== options.accountId || first.currency !== "USD") {
    throw new Error("broker reconciliation account mismatch");
  }
  const synced = await syncAlpacaPaperHistory({ ...options, signal });
  signal.throwIfAborted();
  let feesComplete = true;
  for (const type of ["CFEE", "FEE"]) {
    let cursor = "";
    const seen = new Set<string>();
    let complete = false;
    for (let page = 0; page < (options.maxPages ?? 100); page++) {
      const query = new URLSearchParams({
        direction: "asc",
        page_size: "100",
        ...(cursor ? { page_token: cursor } : {}),
      });
      const raw = await get(`/v2/account/activities/${type}?${query}`);
      if (
        !Array.isArray(raw) ||
        raw.some(
          (row) =>
            !row ||
            typeof row !== "object" ||
            row.activity_type !== type ||
            typeof row.id !== "string",
        )
      ) {
        throw new Error("invalid fee page");
      }
      signal.throwIfAborted();
      await appendFinanceBrokerHistory(options.directory, {
        kind: "broker_history",
        accountId: options.accountId,
        venue: "alpaca:paper",
        query: `activities:${type}:observed_fee:${new Date().toISOString()}`,
        cursor,
        payload: raw,
      });
      if (raw.length < 100) {
        complete = true;
        break;
      }
      const next = raw.at(-1).id as string;
      if (seen.has(next)) {
        break;
      }
      seen.add(next);
      cursor = next;
    }
    feesComplete &&= complete;
  }
  // Validate the durable history before sampling the final account snapshot so
  // local replay work does not consume the short account-fact freshness lease.
  let earliestHistoryEvent = Infinity;
  let latestHistoryEvent = -Infinity;
  let invalidHistoryEventTime = false;
  const history = await reduceFinanceBrokerHistoryRecords(
    options.directory,
    options.accountId,
    "alpaca:paper",
    createBrokerActivityAccumulator(options.until),
    (accumulator, record) => {
      if (record.body.query.startsWith("activities:")) {
        for (const activity of record.body.payload) {
          if (["FILL", "CFEE", "MA"].includes(String(activity.activity_type))) {
            const value =
              activity.transaction_time ??
              (activity.activity_type !== "FILL" ? activity.created_at : undefined) ??
              activity.date;
            const encoded =
              typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
                ? `${value}T23:59:59.999Z`
                : value;
            const time = financeHistoryInstant(encoded);
            invalidHistoryEventTime ||= !Number.isFinite(time);
            earliestHistoryEvent = Math.min(earliestHistoryEvent, time);
            latestHistoryEvent = Math.max(latestHistoryEvent, time);
          }
          accumulator.observe(activity);
        }
      }
      return accumulator;
    },
    { streams: ["activities"], signal },
  );
  const positions = await get("/v2/positions");
  const orders = await get("/v2/orders?status=open&limit=500&nested=true");
  const last = (await get("/v2/account")) as Record<string, unknown>;
  const accountObservedAt = new Date().toISOString();
  if (
    last.id !== options.accountId ||
    last.currency !== "USD" ||
    !Array.isArray(positions) ||
    !Array.isArray(orders)
  ) {
    throw new Error("invalid broker snapshot");
  }
  const result = history.value.finish({
    positions,
    cash: number(last.cash),
    completeFromInception:
      feesComplete &&
      !invalidHistoryEventTime &&
      financeBrokerHistoryCoverage(
        {
          ...synced,
          accountId: options.accountId,
          venue: "alpaca:paper",
          after: options.after,
          until: options.until,
          accountCreatedAt: first.created_at,
        },
        options.accountId,
        earliestHistoryEvent === Infinity
          ? []
          : [
              new Date(earliestHistoryEvent).toISOString(),
              new Date(latestHistoryEvent).toISOString(),
            ],
        options.until,
      ) !== undefined &&
      first.cash === last.cash,
  });
  const protection = classifyFinanceProtectionOrders(
    orders,
    new Map(positions.map((row) => [brokerSymbol(row.symbol), number(row.qty)])),
  );
  const optionalAccountNumber = (value: unknown): number | null => {
    if (typeof value !== "number" && typeof value !== "string") {
      return null;
    }
    if (
      typeof value === "string" &&
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value.trim())
    ) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  // Optional in the receipt contract so older snapshots and adapters remain readable.
  const balanceDiagnostics: {
    balanceAsOf?: string | null;
    accruedFees?: number | null;
    pendingRegTafFees?: number | null;
    intradayAdjustments?: number | null;
  } = {
    balanceAsOf: z.iso.date().safeParse(last.balance_asof).data ?? null,
    accruedFees: optionalAccountNumber(last.accrued_fees),
    pendingRegTafFees: optionalAccountNumber(last.pending_reg_taf_fees),
    intradayAdjustments: optionalAccountNumber(last.intraday_adjustments),
  };
  const accountObservation = {
    accountId: options.accountId,
    currency: "USD" as const,
    source: `${host}/v2/account`,
    observedAt: accountObservedAt,
    equity: optionalAccountNumber(last.equity),
    cash: optionalAccountNumber(last.cash),
    buyingPower: optionalAccountNumber(last.buying_power),
    portfolioValue: optionalAccountNumber(last.portfolio_value),
    ...balanceDiagnostics,
    boundary: "observed_account_values_not_execution_authority; buying_power_is_not_cash" as const,
    unknownValueMeaning: "missing_or_invalid" as const,
  };
  const snapshot = {
    ...result,
    accountObservation,
    protection: {
      protective: protection.protective,
      unresolved: protection.unresolved,
      coverage: protection.coverage,
      coverageBasis: "recognized_working_sell_stops" as const,
    },
    observedAt: new Date().toISOString(),
    positions,
    openOrders: orders,
    historyHeadRef: history.headRef,
  };
  signal.throwIfAborted();
  await appendFinanceBrokerHistory(options.directory, {
    kind: "broker_history",
    accountId: options.accountId,
    venue: "alpaca:paper",
    query: `reconciliation:${snapshot.observedAt}`,
    cursor: "",
    payload: [snapshot],
  });
  return { ...snapshot, historySync: synced };
}

export async function readFinanceBrokerReconciliation(
  directory: string,
  accountId: string,
  now = Date.now(),
) {
  const records = await readFinanceLatestBrokerReconciliations(directory, {
    scope: { accountId, venue: "alpaca:paper" },
  });
  const latest = records.records[0];
  const snapshot = latest?.snapshot;
  if (!snapshot || typeof snapshot.observedAt !== "string") {
    return { ok: false, reason: "missing", snapshot: undefined } as const;
  }
  const age = now - Date.parse(snapshot.observedAt);
  const fresh = Number.isFinite(age) && age >= 0 && age <= 300_000 && !latest?.superseded;
  return {
    ok: fresh && snapshot.status === "reconciled",
    reason: fresh ? snapshot.status : "stale",
    snapshot,
  } as const;
}
