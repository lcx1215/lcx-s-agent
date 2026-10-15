import type { FinanceStrategyRule } from "./finance-strategy-rule-ledger.js";

export const FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES = 253;

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
  return validateFinanceDailyStrategyDeclaration(rule);
}

/** Native form/body/timing validation; inspecting a draft does not activate it. */
export function validateFinanceDailyStrategyDeclaration(
  rule: Pick<
    FinanceStrategyRule,
    "ruleId" | "form" | "formVersion" | "emits" | "schedule" | "body" | "instruments"
  >,
) {
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

/** Shared with research evidence so review can inspect the same volatility the engine sizes on. */
export function annualisedVol(dailyCloses: readonly number[]): number {
  if (dailyCloses.length < 30) {
    return Number.NaN;
  }
  const returns: number[] = [];
  for (let index = 1; index < dailyCloses.length; index += 1) {
    const previous = dailyCloses[index - 1];
    const current = dailyCloses[index];
    if (previous && current && previous > 0) {
      returns.push(Math.log(current / previous));
    }
  }
  if (returns.length < 30) {
    return Number.NaN;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252);
}
