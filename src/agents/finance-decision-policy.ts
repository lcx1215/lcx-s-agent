/**
 * Finance answer authority is intentionally separate from broker/execution
 * authority. A candidate may contain a conditional buy/sell view, but it must
 * carry the evidence and invalidation context needed to be reviewable.
 *
 * The `live_execution` mode is the single exception: it is the only mode that may
 * leave `executionAuthority: "none"`, and only when the caller names the declared
 * execution adapter it will use. This module still never places an order itself —
 * it only reports the authority a caller has already been granted.
 */

export const FINANCE_DECISION_MODES = [
  "research_only",
  "strategy_candidate",
  "conditional_trade_candidate",
  "live_execution",
] as const;

export type FinanceDecisionMode = (typeof FINANCE_DECISION_MODES)[number];

/**
 * Only `live_execution` can produce anything other than `"none"`, and even then it
 * reports `"declared_execution_adapter_required"` so the caller must name the adapter
 * that owns the order path. Research and candidate modes never gain execution authority.
 */
export type FinanceExecutionAuthority = "none" | "declared_execution_adapter_required";

export type FinanceDecisionCandidateContext = Readonly<{
  evidence: readonly Readonly<{ id: string; text: string }>[];
  claims: readonly Readonly<{
    status: "supported" | "uncertain";
    evidenceIds: readonly string[];
  }>[];
  supportingAnalysis?: Readonly<Record<string, unknown>>;
}>;

export type FinanceDecisionPolicyResult = Readonly<{
  mode: FinanceDecisionMode;
  allowed: boolean;
  candidateLanguageAllowed: boolean;
  executionAuthority: FinanceExecutionAuthority;
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
  /已下单|下单成功|已经买入|已经卖出|已开仓|已平仓|交易已完成|转账成功|order filled|order placed|position opened|position closed|funds transferred|(?:\b(?:your|the|an?)\s+)?[A-Z][A-Z0-9.-]{1,9}\s+order\b.{0,24}\b(?:executed|filled|placed|completed)\b|\b(?:i|we)\s+(?:bought|sold|purchased|opened|closed|exited)\b/iu;

function hasCitedSupportingEvidence(context: FinanceDecisionCandidateContext): boolean {
  const evidenceIds = new Set(
    context.evidence
      .filter((evidence) => evidence.id.trim().length > 0 && evidence.text.trim().length > 0)
      .map((evidence) => evidence.id),
  );
  return context.claims.some(
    (claim) =>
      claim.status === "supported" &&
      claim.evidenceIds.length > 0 &&
      claim.evidenceIds.every(
        (evidenceId) => evidenceId.trim().length > 0 && evidenceIds.has(evidenceId),
      ),
  );
}

function hasStructuredRiskAndInvalidation(
  context: FinanceDecisionCandidateContext | undefined,
): boolean {
  if (
    !context ||
    !context.supportingAnalysis ||
    !Array.isArray(context.supportingAnalysis.scenarios)
  ) {
    return false;
  }
  const evidenceIds = new Set(
    context.evidence
      .filter((evidence) => evidence.id.trim().length > 0 && evidence.text.trim().length > 0)
      .map((evidence) => evidence.id),
  );
  return context.supportingAnalysis.scenarios.some((scenario) => {
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
      return false;
    }
    const value = scenario as { evidenceIds?: unknown; invalidation?: unknown };
    const invalidation = typeof value.invalidation === "string" ? value.invalidation.trim() : "";
    return (
      Array.isArray(value.evidenceIds) &&
      value.evidenceIds.length > 0 &&
      value.evidenceIds.every(
        (evidenceId) => typeof evidenceId === "string" && evidenceIds.has(evidenceId),
      ) &&
      invalidation.length > 0 &&
      !/^(?:evidence|risk|source|data)\s+(?:missing|unknown|unavailable|not available)$/iu.test(
        invalidation,
      ) &&
      !/^(?:证据缺失|风险未知|来源缺失|数据缺失|待核验|未知)$/u.test(invalidation)
    );
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Validate visible finance language against an explicitly selected answer
 * mode. This function never grants an external side effect; for `live_execution`
 * it only confirms that a declared execution adapter was named.
 */
export function evaluateFinanceDecisionPolicy(params: {
  mode?: FinanceDecisionMode;
  ask: string;
  answer: string;
  candidateContext?: FinanceDecisionCandidateContext;
  /** Declared adapter that owns the order path. Required by `live_execution`. */
  executionAdapter?: string;
}): FinanceDecisionPolicyResult {
  const mode = params.mode ?? "research_only";
  const ask = params.ask.trim();
  const answer = params.answer.trim();
  const executionAdapter = params.executionAdapter?.trim() ?? "";
  const asksForAction = CANDIDATE_ACTION_PATTERN.test(ask);
  const hasAction = ASSET_ACTION_PATTERN.test(answer);
  const failedReasons: string[] = [];
  const requiredEvidence: string[] = [];

  if (EXECUTION_CLAIM_PATTERN.test(answer) && mode !== "live_execution") {
    failedReasons.push("finance_execution_claim_forbidden");
  }

  if (mode === "live_execution") {
    // The only mode that may leave "none": an order path is authorised solely by naming
    // the declared execution adapter, so the caller cannot silently become an executor.
    if (executionAdapter.length === 0) {
      failedReasons.push("live_execution_requires_declared_execution_adapter");
      requiredEvidence.push("declared_execution_adapter");
    }
    return Object.freeze({
      mode,
      allowed: failedReasons.length === 0,
      candidateLanguageAllowed: failedReasons.length === 0,
      executionAuthority:
        failedReasons.length === 0 ? "declared_execution_adapter_required" : "none",
      failedReasons: Object.freeze(unique(failedReasons)),
      requiredEvidence: Object.freeze(requiredEvidence),
    });
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
  if (
    params.candidateContext === undefined ||
    !hasCitedSupportingEvidence(params.candidateContext)
  ) {
    requiredEvidence.push("cited_supporting_evidence");
  }
  if (!hasStructuredRiskAndInvalidation(params.candidateContext)) {
    requiredEvidence.push("structured_risk_and_invalidation");
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
