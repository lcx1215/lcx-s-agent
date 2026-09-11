/**
 * Finance answer authority is intentionally separate from broker/execution
 * authority. A candidate may contain a conditional buy/sell view, but it must
 * carry the evidence and invalidation context needed to be reviewable.
 */

export const FINANCE_DECISION_MODES = [
  "research_only",
  "strategy_candidate",
  "conditional_trade_candidate",
] as const;

export type FinanceDecisionMode = (typeof FINANCE_DECISION_MODES)[number];

export type FinanceDecisionPolicyResult = Readonly<{
  mode: FinanceDecisionMode;
  allowed: boolean;
  candidateLanguageAllowed: boolean;
  executionAuthority: "none";
  failedReasons: readonly string[];
  requiredEvidence: readonly string[];
}>;

const CANDIDATE_ACTION_PATTERN =
  /\b(?:buy|sell|hold|wait|add|reduce|long|short|entry|exit)\b|买|卖|买入|卖出|持有|等待|加仓|减仓|做多|做空|入场|出场/iu;
const ASSET_ACTION_PATTERN =
  /\b(?:buy|sell|add|reduce|long|short)\s+[A-Z][A-Z0-9.-]{1,9}\b|(?:买入|卖出|买|卖|加仓|减仓|做多|做空).{0,12}(?:[A-Z]{2,6}|[\u3400-\u9fff]{1,8})/iu;
const DIRECT_ACTION_PATTERN =
  /\b(?:should|recommend|buy|sell|add|reduce|go long|go short|hold|wait)\b.{0,24}\b(?:buy|sell|add|reduce|hold|wait|position|shares?)\b|(?:应该|建议|可以|不要|别|先别|不建议).{0,18}(?:买|卖|买入|卖出|加仓|减仓|补仓|摊低|割肉|持有|等待|做多|做空)/iu;
const STRATEGY_PATTERN = /策略|方案|候选|配置|组合|strategy|thesis|allocation|candidate|scenario/iu;
const CONDITION_PATTERN =
  /如果|当|只有|触发|条件|在.+情况下|若|unless|if|when|trigger|condition|scenario/iu;
const EVIDENCE_PATTERN =
  /来源|时间戳|截至|数据|证据|财报|报价|行情|source|timestamp|as of|data|evidence|filing|quote/iu;
const RISK_PATTERN =
  /风险|回撤|波动|失效|反证|止损|最大损失|仓位上限|risk|drawdown|volatility|invalidate|invalidation|loss|position cap/iu;
const HORIZON_PATTERN =
  /短线|中线|长线|持有期|周期|期限|一周|一个月|季度|horizon|timeframe|term|week|month|quarter/iu;
const REVIEW_BOUNDARY_PATTERN =
  /仅候选|候选意见|需要确认|人工确认|不自动下单|不执行|执行前确认|仅供审阅|no automatic execution|human confirmation|review only|not execution/iu;
const EXECUTION_CLAIM_PATTERN =
  /已下单|下单成功|已经买入|已经卖出|已开仓|已平仓|交易已完成|转账成功|order filled|order placed|position opened|position closed|funds transferred/iu;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Validate visible finance language against an explicitly selected answer
 * mode. This function never grants an external side effect.
 */
export function evaluateFinanceDecisionPolicy(params: {
  mode?: FinanceDecisionMode;
  ask: string;
  answer: string;
}): FinanceDecisionPolicyResult {
  const mode = params.mode ?? "research_only";
  const ask = params.ask.trim();
  const answer = params.answer.trim();
  const asksForAction = CANDIDATE_ACTION_PATTERN.test(ask);
  const hasAction = ASSET_ACTION_PATTERN.test(answer);
  const failedReasons: string[] = [];
  const requiredEvidence: string[] = [];

  if (EXECUTION_CLAIM_PATTERN.test(answer)) {
    failedReasons.push("finance_execution_claim_forbidden");
  }

  if (mode === "research_only") {
    if (DIRECT_ACTION_PATTERN.test(answer)) {
      failedReasons.push("direct_trade_or_position_action_language");
    }
    return Object.freeze({
      mode,
      allowed: failedReasons.length === 0,
      candidateLanguageAllowed: false,
      executionAuthority: "none",
      failedReasons: Object.freeze(unique(failedReasons)),
      requiredEvidence: Object.freeze(requiredEvidence),
    });
  }

  if (!STRATEGY_PATTERN.test(answer)) {
    requiredEvidence.push("strategy_or_candidate_thesis");
  }
  if (!EVIDENCE_PATTERN.test(answer)) {
    requiredEvidence.push("source_and_timestamped_evidence");
  }
  if (!CONDITION_PATTERN.test(answer)) {
    requiredEvidence.push("conditional_trigger_or_scenario");
  }
  if (!RISK_PATTERN.test(answer)) {
    requiredEvidence.push("risk_and_invalidation");
  }
  if (!HORIZON_PATTERN.test(answer)) {
    requiredEvidence.push("time_horizon");
  }
  if (!REVIEW_BOUNDARY_PATTERN.test(answer)) {
    requiredEvidence.push("human_review_and_no_automatic_execution_boundary");
  }

  if (mode === "strategy_candidate" && hasAction) {
    failedReasons.push("strategy_candidate_must_not_be_asset_action");
  }
  if (mode === "conditional_trade_candidate" && !hasAction && asksForAction) {
    failedReasons.push("conditional_trade_candidate_missing_action_candidate");
  }
  if (requiredEvidence.length > 0) {
    failedReasons.push("finance_candidate_contract_incomplete");
  }

  return Object.freeze({
    mode,
    allowed: failedReasons.length === 0,
    candidateLanguageAllowed: failedReasons.length === 0,
    executionAuthority: "none",
    failedReasons: Object.freeze(unique(failedReasons)),
    requiredEvidence: Object.freeze(unique(requiredEvidence)),
  });
}
