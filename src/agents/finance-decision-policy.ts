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
 * Research maturity stages as the trader-strategy-lab skill names them.
 *
 * They are not a second copy of the modes: a stage says how far a method has been verified,
 * while a mode says what an answer is allowed to say. Keeping them separate is the point —
 * a method that only reached `paper_candidate` must not be written up as a conditional trade.
 *
 * The mapping is a single source of truth so the two cannot drift. It lives here, next to the
 * modes, because this module is what enforces it.
 */
export const FINANCE_STRATEGY_STAGES = [
  "method_only",
  "research_candidate",
  "paper_candidate",
  "conditional_trade_candidate",
] as const;

export type FinanceStrategyStage = (typeof FINANCE_STRATEGY_STAGES)[number];

/**
 * Modes a stage may be written up in.
 *
 * `paper_candidate` maps only to `strategy_candidate` because this system has no paper stage:
 * a paper record belongs in the decision packet, not in a mode that claims more than it has.
 */
export const FINANCE_STAGE_ALLOWED_MODES: Readonly<
  Record<FinanceStrategyStage, readonly FinanceDecisionMode[]>
> = Object.freeze({
  method_only: Object.freeze(["research_only"] as const),
  research_candidate: Object.freeze(["research_only", "strategy_candidate"] as const),
  paper_candidate: Object.freeze(["strategy_candidate"] as const),
  conditional_trade_candidate: Object.freeze(["conditional_trade_candidate"] as const),
});

export const FINANCE_STAGE_MODE_REFUSAL = "finance_strategy_stage_mode_mismatch" as const;

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
/**
 * What has to follow an action verb for the phrase to be an instruction rather than a word.
 *
 * Both action patterns below share it so the two cannot drift, and it is an explicit list because
 * the obvious shorthand -- "the verb, then any Chinese character" -- degenerates into "the verb
 * appears somewhere". Measured: in `strategy_candidate`, whose contract forbids a direct asset
 * action, every one of these rule-stating sentences was refused as an instruction --
 * "配置：仓位上限 20%，减仓理由必须写清…", "策略：加仓资格取决于 thesis…",
 * "方案：清仓理由与失效条件需同时记录。", "组合：平仓条件写在规则里…",
 * "策略：减仓理由、触发条件、失效条件都要写。" -- because 减仓/加仓/清仓/平仓 were followed by
 * 理由 / 资格 / 条件. The noun compound names the action; it does not instruct it.
 *
 * A measure word may sit between the verb and the ticker (建仓一只 NVDA) because the measure word is
 * part of the object phrase. Nothing else may: allowing arbitrary Chinese there is what re-opened
 * the hole, so "建仓时用 AI 选股" (verb + 时用 + AI) stays out on purpose.
 */
const ASSET_OR_AMOUNT_TAIL =
  "(?:(?:一只|两只|几只|一些|部分|更多|少量|若干)?\\s*[A-Z]{2,6}|(?:到|至)?\\s*\\d|(?:到|至)?\\s*(?:一半|全部|全仓|半仓|满仓|三成|两成|一成|几成|百分之)|股票|标的|头寸)";

/**
 * Whether the answer binds an action verb to an asset. `strategy_candidate` forbids it;
 * `conditional_trade_candidate` requires it when the ask asked for one.
 *
 * The measured hole is the ordinary wording: 建仓 / 加码 (open or add to a position) were absent
 * from the Chinese side and `accumulate` / `build a position in` from the English side. So
 * "配置：建仓 NVDA，权重 10%。" -- a direct position instruction -- was admitted in the one mode
 * whose contract forbids a direct position instruction, while the synonymous "买入 NVDA" was caught.
 *
 * NOTE, deliberately left as-is: the `i` flag makes `[A-Z]` case-insensitive, so the English branch
 * means "verb + the following token", not "verb + a ticker" -- measured, it matches the "more" in
 * "buy more NVDA". Tightening it to a real ticker would let a ticker-less instruction
 * ("Buy more shares.") through in `strategy_candidate`, which is the unsafe direction; this branch
 * is used as "a verb bound to something", not as ticker detection.
 */
const ASSET_ACTION_PATTERN = new RegExp(
  // `build` is bound to "a position in": a bare `build` would refuse "build the allocation", which
  // is exactly what a strategy candidate is for.
  // `g` is required by `matchAll` in `hasAssetAction`; it is only ever called there, never via
  // `.test()`, so `lastIndex` cannot leak between calls.
  "\\b(?:buy|sell|add|reduce|long|short|accumulate)\\s+[A-Za-z][A-Za-z0-9.-]{1,9}\\b|build\\s+a\\s+position\\s+in\\s+[A-Za-z][A-Za-z0-9.-]{1,9}\\b|(?:买入|卖出|买|卖|加仓|减仓|建仓|加码|减码|平仓|清仓|做多|做空)" +
    ASSET_OR_AMOUNT_TAIL,
  "giu",
);
const DIRECT_ACTION_PATTERN =
  /\b(?:should|recommend|buy|sell|add|reduce|go long|go short|hold|wait)\b.{0,24}\b(?:buy|sell|add|reduce|hold|wait|position|shares?)\b|(?:应该|建议|可以|不要|别|先别|不建议).{0,18}(?:买|卖|买入|卖出|加仓|减仓|补仓|摊低|割肉|持有|等待|做多|做空)/iu;
/**
 * A trade instruction binding an action verb to an asset: "买入 NVDA", "Buy NVDA now",
 * "I recommend buying NVDA here".
 *
 * `DIRECT_ACTION_PATTERN` misses all three, and in `research_only` it was the only check, so the
 * most direct form of trade instruction was the one that got through. Its English side needs two
 * keywords and requires an exact one, so `buying` never matched `\bbuy\b`; its Chinese side requires
 * a hedge prefix (建议|应该|可以), so a bare imperative never matched either.
 *
 * The verb must be followed by an asset or an amount, which is what separates an instruction from
 * research prose about buying and selling: "买卖价差" and "the bid-ask spread" have no verb from
 * this list, and "I would not buy here without data" has no ticker. Past tense is left out on
 * purpose so that "reduced NVDA exposure" is not read as an instruction to reduce it.
 *
 * The Chinese tail is the shared `ASSET_OR_AMOUNT_TAIL`, not "any Chinese character". Measured cost
 * of the loose version: the pipeline's own quality fuzzer's positive case for single-stock loss
 * recovery -- "风险结论：NVDA 亏 20% 本身不是补仓理由。默认风险门：补仓资格=未通过…" -- was refused
 * with `direct_trade_or_position_action_language`, i.e. a risk gate that *denies* top-up eligibility
 * was read as an instruction to top up. It matched on 补仓 + 资格. "补仓理由" and "买入 thesis"
 * matched the same way.
 */
const DIRECT_ASSET_ACTION_PATTERN = new RegExp(
  // No `i` flag: the ticker half must stay case-sensitive so that "Buy now" is not read as
  // "buy the ticker NOW". The verbs are written with character classes instead.
  "\\b(?:[Bb]uys?|[Bb]uying|[Ss]ells?|[Ss]elling|[Aa]dds?|[Aa]dding|[Rr]educes?|[Rr]educing|[Gg]o\\s+[Ll]ong|[Gg]o\\s+[Ss]hort)\\b[^.。!！?？\\n]{0,12}\\b[A-Z][A-Z0-9.-]{1,9}\\b|(?:买入|卖出|加仓|减仓|补仓|摊低|摊平|做多|做空|割肉|清仓)" +
    ASSET_OR_AMOUNT_TAIL,
  "gu",
);

/**
 * A negation sitting just before an action verb.
 *
 * Naming an action in order to refuse it is the opposite of instructing it. A candidate answer in
 * the scenario suite says "不能给加仓、减仓或期权方向" -- a research answer explicitly declining to
 * give position instructions -- and without this it was refused for exactly the thing it refused
 * to do.
 */
const ACTION_NEGATION_PATTERN =
  /(?:不(?:能|会|要|给|做|是|建议|构成|等于)|不要|别|无法|没有|未|禁止|切勿|并非|而非|不是)|\b(?:not|never|avoid|avoided|don't|do\s+not|does\s+not|rather\s+than|instead\s+of)\b/iu;

/**
 * A bare negator sitting immediately in front of the verb.
 *
 * `ACTION_NEGATION_PATTERN` lists multi-character forms only (不能 / 不要 / 无法 …), so the plainest
 * negation in Chinese -- 不 + verb -- was read as the instruction it refuses: "不建仓" counted as
 * opening a position. The single character is only trusted when it is the last thing before the
 * match, which is what separates "不建仓" from "不是所有信号都要建仓".
 */
const ADJACENT_NEGATION_PATTERN = /[不未别莫]/u;

function hasUnnegatedMatch(answer: string, pattern: RegExp, lookBack: number): boolean {
  for (const match of answer.matchAll(pattern)) {
    const start = match.index ?? 0;
    const preceding = answer.slice(Math.max(0, start - lookBack), start);
    if (ACTION_NEGATION_PATTERN.test(preceding)) {
      continue;
    }
    if (ADJACENT_NEGATION_PATTERN.test(preceding.slice(-1))) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Same negation rule for `ASSET_ACTION_PATTERN`, with the preceding window widened to 12.
 *
 * "在缺乏时间戳证据前不建仓，先给框架。" refuses to open a position; without this it was counted as
 * the position action it declined to take, and `strategy_candidate` refused it for exactly the
 * thing the sentence said it would not do.
 */
function hasAssetAction(answer: string): boolean {
  return hasUnnegatedMatch(answer, ASSET_ACTION_PATTERN, 12);
}

function hasDirectAssetAction(answer: string): boolean {
  return hasUnnegatedMatch(answer, DIRECT_ASSET_ACTION_PATTERN, 8);
}

/**
 * Whether the answer states a candidate thesis, not merely uses a word that contains one.
 *
 * `thesis` was an unbounded substring, so "hypothesis" satisfied it: an answer that said
 * "Our hypothesis is that multiples compress" was treated as having stated a candidate thesis.
 * The English alternatives are word-bounded for that reason.
 */
const STRATEGY_PATTERN =
  /策略|方案|候选|配置|组合|\b(?:strategy|strategies|thesis|allocation|candidate|scenario)\b/iu;
/**
 * Whether the answer states a trigger, not merely uses a word that contains one.
 *
 * Two measured holes. English: `if` is a substring of "identify", "notify", "specific", "modify"
 * and "justify", so "We will identify the entry later" satisfied `conditional_trigger_or_scenario`
 * while stating no trigger at all. Chinese: `当` is a character of "当前" (current), so
 * "当前估值下买入 NVDA" -- no condition whatsoever -- satisfied the same requirement.
 *
 * The Chinese side therefore takes `当` only when it is not one of its common non-conditional
 * collocations (当前/当时/当日/当然/当地...), and English alternatives are word-bounded.
 */
const CONDITION_PATTERN =
  /如果|若|只有|一旦|除非|触发|条件|在.+情况下|当(?!前|时|日|然|地|中|下|面|局|选)|\b(?:unless|if|when|trigger|triggered|condition|conditions|scenario)\b/iu;
/**
 * Whether the answer names a source with a timestamp, not merely uses the word.
 *
 * The old pattern matched the bare nouns 数据 and 来源, so an answer that said "如果数据变化" or
 * "如果来源变化" satisfied `source_and_timestamped_evidence`. Measured in
 * `conditional_trade_candidate`: a candidate padded with six filler words
 * ("策略：如果数据变化就买入 NVDA，风险可控，周期一周，仅候选。") was allowed, while a genuine packet
 * naming CPI, a drawdown limit, an invalidation and a horizon was refused for missing evidence --
 * the padded answer passed on a word and the real one failed for not using it.
 *
 * This version requires a timestamp marker, a provenance construction, or a named source artefact.
 */
const EVIDENCE_PATTERN =
  /时间戳|截至|证据|财报|报价|行情|数据(?:来源|来自|截至)|来源(?:时间|数据|:|：)|\d{4}-\d{2}-\d{2}|\b(?:timestamp|evidence|filing|quote)\b|\bas\s+of\b|\bsource\s+and\s+timestamp|\btimestamped\s+evidence|\bdata\s+(?:from|as\s+of|source)/iu;
const RISK_PATTERN =
  /风险|回撤|波动|失效|反证|止损|最大损失|仓位上限|risk|drawdown|volatility|invalidate|invalidation|loss|position cap/iu;
/**
 * Whether the answer states a holding period, not merely uses a word that contains one.
 *
 * `term` was an unbounded substring, so "determine" satisfied it. The measured case is the worst
 * possible direction: a candidate that said "后续再 determine" -- the horizon is *not decided yet*
 * -- was the one that passed `time_horizon`. Word-bounded, and the plural is kept so that
 * "two weeks" and "long terms" still count.
 */
const HORIZON_PATTERN =
  /短线|中线|长线|持有期|周期|期限|一周|一个月|季度|\b(?:horizon|timeframe|terms?|weeks?|months?|quarters?)\b/iu;
const REVIEW_BOUNDARY_PATTERN =
  /仅候选|候选意见|需要确认|人工确认|不自动下单|不执行|执行前确认|仅供审阅|no automatic execution|human confirmation|review only|not execution/iu;
/**
 * Whether the answer claims an execution happened.
 *
 * Outside `live_execution` that is forbidden: only the declared execution adapter can produce a
 * fill, so an answer asserting one is asserting a side effect nobody performed.
 *
 * The measured hole is the ordinary wording. 已成交 / 已建仓 / 已执行 -- the standard Chinese way to
 * say a trade completed -- were absent, as was "Filled 100 NVDA at 180." (the English side needed
 * the literal word "order"). A claim of a fill written the normal way was therefore admitted in
 * every mode that forbids execution claims.
 *
 * 成交 alone is deliberately NOT matched: "成交额" (turnover) and "成交量" (volume) are market
 * commentary, not claims about a fill. Only the completed-claim constructions are matched, and
 * 已执行 is bound to a trade verb so that "该策略已执行回测" is not read as a fill.
 */
const EXECUTION_CLAIM_PATTERN =
  /已下单|下单成功|已经买入|已经卖出|已开仓|已平仓|交易已完成|转账成功|已(?:成交|建仓|加仓|减仓|清仓|交割|报单)|已委托[^。！？?\n]{0,6}(?:买入|卖出|下单|成交|交易)|(?:已|已经)[^。！？?\n]{0,8}成交(?!额|量)|已执行(?:买入|卖出|下单|交易|委托)|(?:交易|委托|订单|指令)已执行|(?:委托|订单|报单)已成交|成交完成|order filled|order placed|position opened|position closed|funds transferred|(?:\b(?:your|the|an?)\s+)?[A-Z][A-Z0-9.-]{1,9}\s+order\b.{0,24}\b(?:executed|filled|placed|completed)\b|\b(?:filled|executed)\b\s+(?:\d+|[A-Z][A-Z0-9.-]{1,9}\b)|\b(?:i|we)\s+(?:bought|sold|purchased|opened|closed|exited)\b/iu;

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
  /**
   * Research maturity stage, when the caller declares one. Omitting it asserts nothing: the
   * mode is then the only contract. Declaring it binds the mode, so a method that has only
   * reached `paper_candidate` cannot be written up as a conditional trade.
   */
  stage?: FinanceStrategyStage;
}): FinanceDecisionPolicyResult {
  const mode = params.mode ?? "research_only";
  const ask = params.ask.trim();
  const answer = params.answer.trim();
  const executionAdapter = params.executionAdapter?.trim() ?? "";
  const asksForAction = CANDIDATE_ACTION_PATTERN.test(ask);
  const hasAction = hasAssetAction(answer);
  const failedReasons: string[] = [];
  const requiredEvidence: string[] = [];

  if (EXECUTION_CLAIM_PATTERN.test(answer) && mode !== "live_execution") {
    failedReasons.push("finance_execution_claim_forbidden");
  }

  if (params.stage !== undefined && !FINANCE_STAGE_ALLOWED_MODES[params.stage].includes(mode)) {
    failedReasons.push(FINANCE_STAGE_MODE_REFUSAL);
    requiredEvidence.push(
      `stage_${params.stage}_allows_modes:${FINANCE_STAGE_ALLOWED_MODES[params.stage].join("|")}`,
    );
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
    if (DIRECT_ACTION_PATTERN.test(answer) || hasDirectAssetAction(answer)) {
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
