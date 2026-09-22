import {
  syncAlpacaPaperHistory,
  type AlpacaHistoryOptions,
} from "./finance-alpaca-history-sync.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  appendFinanceBrokerHistory,
  readFinanceBrokerHistoryRecords,
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

/** Economic events, not order snapshots: never count both receipts and broker fills. */
export function reconcileFinanceBrokerActivities(input: {
  activities: readonly Record<string, unknown>[];
  positions: readonly Record<string, unknown>[];
  cash: number;
  completeFromInception: boolean;
}) {
  const quantities = new Map<string, number>();
  const identities = new Map<string, string>();
  const issues: string[] = [];
  const fees: { id: string; instrument?: string; quantity: number; cash: number }[] = [];
  let cash = 0;
  const add = (symbol: string, qty: number) =>
    quantities.set(symbol, (quantities.get(symbol) ?? 0) + qty);
  for (const row of input.activities) {
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
        continue;
      }
      identities.set(row.id, fingerprint);
      if (row.activity_type === "FILL") {
        if (row.type !== "fill" || !["buy", "sell"].includes(String(row.side))) {
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
      } else if (row.activity_type === "CFEE" || row.activity_type === "FEE") {
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
        fees.push({ id: row.id, instrument, quantity, cash: amount });
      } else if (["JNLC", "CSD", "CSW", "DIV", "INT"].includes(String(row.activity_type))) {
        if (
          row.status !== "executed" ||
          (row.currency !== undefined && row.currency !== "USD") ||
          (row.qty !== undefined && number(row.qty) !== 0)
        ) {
          throw new Error("unsupported cash activity");
        }
        cash += number(row.net_amount);
      } else {
        throw new Error("unsupported activity type");
      }
    } catch {
      issues.push(`unsupported_activity:${typeof row.id === "string" ? row.id : "missing"}`);
    }
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
    cashFromActivities: cash,
    brokerCash: input.cash,
    cashDifference,
    differences,
    issues,
    // A quantity gap is not evidence of a fee, even when it matches a published rate.
    feesInterpreted: issues.length === 0 && differences.length === 0,
  };
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
  let feesComplete = true;
  for (const type of ["CFEE", "FEE"]) {
    let cursor = "";
    const seen = new Set<string>();
    let complete = false;
    for (let page = 0; page < (options.maxPages ?? 100); page++) {
      const query = new URLSearchParams({
        direction: "asc",
        page_size: "100",
        after: options.after,
        until: options.until,
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
      await appendFinanceBrokerHistory(options.directory, {
        kind: "broker_history",
        accountId: options.accountId,
        venue: "alpaca:paper",
        query: `activities:${type}:${options.after}:${options.until}`,
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
  const positions = await get("/v2/positions");
  const orders = await get("/v2/orders?status=open&limit=500&nested=true");
  const last = (await get("/v2/account")) as Record<string, unknown>;
  if (
    last.id !== options.accountId ||
    last.currency !== "USD" ||
    !Array.isArray(positions) ||
    !Array.isArray(orders)
  ) {
    throw new Error("invalid broker snapshot");
  }
  const rawHistory = await readFinanceBrokerHistoryRecords(
    options.directory,
    options.accountId,
    "alpaca:paper",
  );
  const result = reconcileFinanceBrokerActivities({
    activities: rawHistory.records
      .filter((record) => record.body.query.startsWith("activities:"))
      .flatMap((record) => record.body.payload),
    positions,
    cash: number(last.cash),
    completeFromInception:
      synced.status === "raw_history_synced" &&
      feesComplete &&
      typeof first.created_at === "string" &&
      Date.parse(options.after) <= Date.parse(first.created_at) &&
      first.cash === last.cash,
  });
  const protection = classifyFinanceProtectionOrders(
    orders,
    new Map(positions.map((row) => [brokerSymbol(row.symbol), number(row.qty)])),
  );
  const snapshot = {
    ...result,
    protection: { protective: protection.protective, unresolved: protection.unresolved },
    observedAt: new Date().toISOString(),
    positions,
    openOrders: orders,
    historyHeadRef: rawHistory.headRef,
  };
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
  const records = await readFinanceBrokerHistoryRecords(directory, accountId, "alpaca:paper");
  const latest = records.records
    .filter((record) => record.body.query.startsWith("reconciliation:"))
    .at(-1);
  const snapshot = latest?.body.payload[0];
  if (!snapshot || typeof snapshot.observedAt !== "string") {
    return { ok: false, reason: "missing", snapshot: undefined } as const;
  }
  const age = now - Date.parse(snapshot.observedAt);
  const fresh =
    Number.isFinite(age) && age >= 0 && age <= 300_000 && latest?.ref === records.headRef;
  return {
    ok: fresh && snapshot.status === "reconciled",
    reason: fresh ? snapshot.status : "stale",
    snapshot,
  } as const;
}
