import type { FinanceStrategyRule } from "./finance-strategy-rule-ledger.js";

/** Bind the existing daily trend engine, not a dispatcher for arbitrary rule bodies. */
export function bindFinanceDailyStrategy(
  rules: readonly Pick<
    FinanceStrategyRule,
    "ruleId" | "state" | "form" | "formVersion" | "emits" | "schedule" | "body" | "instruments"
  >[],
) {
  const active = rules.filter((rule) => rule.state === "active");
  if (active.length !== 1) {
    throw new Error(
      "daily trend execution requires exactly one active strategy; multiple strategies need an explicit portfolio composition",
    );
  }
  const rule = active[0];
  if (
    rule.form !== "cross_asset_trend" ||
    rule.formVersion !== "1" ||
    rule.emits !== "target_weights"
  ) {
    throw new Error(
      `strategy ${rule.ruleId}: no daily executor for ${rule.form}/${rule.formVersion}; refusing to substitute trend logic`,
    );
  }
  const frozen = rule.body.frozenRule;
  const lookback =
    frozen && typeof frozen === "object" && "lookbackMonths" in frozen
      ? frozen.lookbackMonths
      : undefined;
  if (
    typeof lookback !== "number" ||
    !Number.isSafeInteger(lookback) ||
    lookback < 1 ||
    lookback > 120
  ) {
    throw new Error(
      `strategy ${rule.ruleId}: lookbackMonths must be an explicit integer from 1 to 120`,
    );
  }
  if (
    rule.schedule.kind !== "monthly" ||
    rule.schedule.at !== "last_trading_day" ||
    rule.schedule.timezone !== "America/New_York"
  ) {
    throw new Error(
      `strategy ${rule.ruleId}: daily trend executor requires New York month-end signal timing`,
    );
  }
  return {
    ruleId: rule.ruleId,
    form: rule.form,
    formVersion: rule.formVersion,
    lookbackMonths: lookback,
    instruments: [...rule.instruments],
  };
}

/** A missing month is missing evidence, not permission to use a different horizon. */
export function financeMonthlyTrendReturn(
  months: readonly { date: string; close: number }[],
  anchor: { date: string; close: number },
  lookbackMonths: number,
): number | undefined {
  if (!Number.isSafeInteger(lookbackMonths) || lookbackMonths < 1 || lookbackMonths > 120) {
    throw new Error("invalid monthly trend lookback");
  }
  const target = new Date(`${anchor.date.slice(0, 7)}-01T00:00:00Z`);
  target.setUTCMonth(target.getUTCMonth() - lookbackMonths);
  const month = target.toISOString().slice(0, 7);
  const prior = months.find((row) => row.date.slice(0, 7) === month);
  if (
    !prior ||
    !Number.isFinite(prior.close) ||
    prior.close <= 0 ||
    !Number.isFinite(anchor.close) ||
    anchor.close <= 0
  ) {
    return undefined;
  }
  return anchor.close / prior.close - 1;
}
