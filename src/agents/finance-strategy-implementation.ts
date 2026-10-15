import { validateFinanceDailyStrategyDeclaration } from "./finance-daily-strategy.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  validateFinanceIntradayRuleDeclaration,
} from "./finance-intraday-paper.js";
import {
  activateFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
  type FinanceStrategyRule,
} from "./finance-strategy-rule-ledger.js";

/** Dispatch by implemented form, never by a frozen list of strategy identities. */
export function validateFinanceStrategyImplementation(rule: FinanceStrategyRule) {
  if (rule.form === FINANCE_INTRADAY_OPENING_RANGE_FORM) {
    return {
      owner: "finance-intraday-paper",
      contract: validateFinanceIntradayRuleDeclaration(rule),
      boundary: "native_contract_validation_not_replay_profitability_or_order_authority",
    };
  }
  if (rule.form === "cross_asset_trend") {
    return {
      owner: "finance-daily-strategy",
      contract: validateFinanceDailyStrategyDeclaration(rule),
      boundary: "native_contract_validation_not_replay_profitability_or_order_authority",
    };
  }
  throw new Error(
    `strategy ${rule.ruleId}: implementation missing for ${rule.form}/${rule.formVersion}; implement and validate its native execution owner before activation; no fallback to another method`,
  );
}

/** Original operator activation: validate the actual declaration, then append the existing event. */
export async function activateImplementedFinanceStrategyRule(directory: string, input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    !("ruleId" in input) ||
    typeof input.ruleId !== "string"
  ) {
    throw new Error("activation requires a declared rule identity");
  }
  const read = await readFinanceStrategyRuleLedger(directory);
  const rule = read.ledger.rules.find((item) => item.ruleId === input.ruleId);
  if (!rule || rule.state === "retired") {
    throw new Error("activation requires an existing non-retired declaration");
  }
  validateFinanceStrategyImplementation(rule);
  return activateFinanceStrategyRule(directory, input);
}
