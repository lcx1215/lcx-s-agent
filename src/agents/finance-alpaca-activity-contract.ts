export type AlpacaTradeExecutionType = "fill" | "partial_fill";

export function isAlpacaTradeExecutionType(value: unknown): value is AlpacaTradeExecutionType {
  return value === "fill" || value === "partial_fill";
}

export type FinanceCashMerger = Readonly<{
  type: "CMA";
  groupId: string;
  corporateActionId: string;
  instrument: string;
  activityIds: readonly string[];
  sourceFactRefs: readonly string[];
  quantity: number;
  cash: number;
  observedAt: string;
  occurredAt?: string;
  businessDate?: string;
}>;

/** One parser for executed USD cash-merger pairs, never an order or a synthetic fill. */
export function createFinanceCashMergerCollector(asOf?: string) {
  type Leg = {
    id: string;
    ref: string;
    quantity: number;
    cash: number;
    observedAt: number;
    occurredAt?: number;
    businessDate?: string;
  };
  const groups = new Map<
    string,
    { groupId: string; corporateActionId: string; instrument: string; cash?: Leg; shares?: Leg }
  >();
  const identities = new Map<string, string>();
  const numeric = (value: unknown) => {
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      value === "" ||
      (typeof value === "string" && !value.trim()) ||
      !Number.isFinite(Number(value))
    ) {
      throw new Error("invalid merger number");
    }
    return Number(value);
  };
  const time = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
      throw new Error("merger timestamp missing");
    }
    const date = value.slice(0, 10),
      day = Date.parse(date + "T00:00:00Z"),
      parsed = Date.parse(value);
    if (
      !Number.isFinite(day) ||
      new Date(day).toISOString().slice(0, 10) !== date ||
      !Number.isFinite(parsed)
    ) {
      throw new Error("invalid merger timestamp");
    }
    return parsed;
  };
  const observe = (row: Record<string, unknown>, sourceFactRef: string) => {
    if (
      row.activity_type !== "MA" ||
      row.activity_sub_type !== "CMA" ||
      row.status !== "executed" ||
      row.currency !== "USD" ||
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.group_id !== "string" ||
      !row.group_id ||
      typeof row.corporate_action_id !== "string" ||
      !row.corporate_action_id ||
      typeof row.symbol !== "string" ||
      !/^[A-Z0-9.]+$/u.test(row.symbol)
    ) {
      throw new Error("cash merger identity or settlement unavailable");
    }
    const previous = identities.get(row.id);
    if (previous) {
      if (previous !== sourceFactRef) {
        throw new Error("cash merger activity conflict");
      }
      return;
    }
    const observedAt = time(row.transaction_time ?? row.created_at);
    if (
      asOf !== undefined &&
      (!Number.isFinite(Date.parse(asOf)) || observedAt > Date.parse(asOf))
    ) {
      throw new Error("cash merger outside cutoff");
    }
    const businessDate = typeof row.date === "string" ? row.date : undefined;
    if (
      businessDate !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate) ||
        new Date(time(businessDate + "T00:00:00Z")).toISOString().slice(0, 10) !== businessDate)
    ) {
      throw new Error("invalid merger business date");
    }
    const leg: Leg = {
      id: row.id,
      ref: sourceFactRef,
      quantity: row.qty === undefined ? 0 : numeric(row.qty),
      cash: numeric(row.net_amount),
      observedAt,
      ...(row.transaction_time !== undefined ? { occurredAt: time(row.transaction_time) } : {}),
      ...(businessDate ? { businessDate } : {}),
    };
    const key = JSON.stringify([row.group_id, row.corporate_action_id]);
    const group = groups.get(key) ?? {
      groupId: row.group_id,
      corporateActionId: row.corporate_action_id,
      instrument: row.symbol,
    };
    if (group.instrument !== row.symbol) {
      throw new Error("cash merger symbol conflict");
    }
    if (leg.quantity === 0 && leg.cash > 0 && !group.cash) {
      group.cash = leg;
    } else if (leg.quantity < 0 && leg.cash === 0 && !group.shares) {
      group.shares = leg;
    } else {
      throw new Error("unsupported cash merger leg or correction");
    }
    identities.set(row.id, sourceFactRef);
    groups.set(key, group);
  };
  const finish = () => {
    const events: FinanceCashMerger[] = [];
    const issues: string[] = [];
    for (const [key, group] of groups) {
      const { cash, shares } = group;
      if (!cash || !shares) {
        issues.push(`incomplete_cash_merger:${key}`);
        continue;
      }
      if (cash.businessDate !== shares.businessDate) {
        issues.push(`cash_merger_date_conflict:${key}`);
        continue;
      }
      events.push({
        type: "CMA",
        groupId: group.groupId,
        corporateActionId: group.corporateActionId,
        instrument: group.instrument,
        activityIds: [cash.id, shares.id],
        sourceFactRefs: [cash.ref, shares.ref],
        quantity: shares.quantity,
        cash: cash.cash,
        observedAt: new Date(Math.max(cash.observedAt, shares.observedAt)).toISOString(),
        ...(cash.occurredAt !== undefined && shares.occurredAt !== undefined
          ? { occurredAt: new Date(Math.max(cash.occurredAt, shares.occurredAt)).toISOString() }
          : {}),
        ...(cash.businessDate ? { businessDate: cash.businessDate } : {}),
      });
    }
    return { events, issues };
  };
  return { observe, finish };
}
