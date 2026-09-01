import {
  LOCAL_BRAIN_MODULE_TAXONOMY,
  LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS,
  LOCAL_BRAIN_RISK_BOUNDARIES,
  selectLocalBrainContractHints,
} from "./local-brain-taxonomy.js";

/**
 * One prompt contract for every local-brain training row.
 *
 * Provenance belongs in the JSONL meta/receipt, not in the model-visible
 * prompt.  The distinction matters: a teacher or a receipt may know the
 * answer-bearing label, but the student must infer the contract from the
 * natural-language task and survive a neutral/holdout evaluation.
 */
export const LOCAL_BRAIN_TRAINING_PROMPT_VERSION =
  "local_brain_training_contract_v2_no_answer_bearing_source_summary";

const OUTPUT_FIELD_NAMES = [
  "task_family",
  "primary_modules",
  "supporting_modules",
  "required_tools",
  "missing_data",
  "risk_boundaries",
  "next_step",
  "rejected_context",
  "source_kind",
  "source_summary",
  "user_message",
  "candidate_text",
] as const;

const CONTRACT_LABELS = new Set<string>([
  ...LOCAL_BRAIN_MODULE_TAXONOMY,
  ...LOCAL_BRAIN_RISK_BOUNDARIES,
  ...OUTPUT_FIELD_NAMES,
]);

const ANSWER_BEARING_PREFIXES = new Set<string>([
  "acceptance",
  "case",
  "eval",
  "failure",
  "focus",
  "lark",
  "live",
  "minimax",
  "om",
  "receipt",
  "reply",
  "sync",
]);
const REDACTION_PLACEHOLDER_LABELS = new Set<string>([
  "withheld_case_label",
  "withheld_contract_id",
]);

const GENERIC_CONTRACT_ID_CHECK_PATTERN = /^\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b$/u;
const CONTRACT_TOKEN_PATTERN = /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/giu;
const CASE_LABEL_PATTERN = /\b(?:case|eval|id)\s*[:=]\s*[a-z0-9][a-z0-9_-]*/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeContractLabel(value: string): string {
  return value.toLowerCase().replace(/-/gu, "_");
}

/**
 * Return true for a token that can act as an answer-bearing contract label.
 *
 * Known taxonomy/output labels and legacy snake_case identifiers retain the
 * previous behavior.  Hyphenated prose is only withheld when it is clearly a
 * code-like token (an answer-bearing prefix or a digit-bearing multi-segment
 * identifier), so ordinary terms such as "high-level" remain readable.
 */
export function isAnswerBearingContractToken(value: string): boolean {
  const normalized = normalizeContractLabel(value);
  if (REDACTION_PLACEHOLDER_LABELS.has(normalized)) {
    return false;
  }
  if (CONTRACT_LABELS.has(normalized) || GENERIC_CONTRACT_ID_CHECK_PATTERN.test(value)) {
    return true;
  }
  const segments = normalized.split("_");
  return (
    segments.length >= 2 && (/[0-9]/u.test(value) || ANSWER_BEARING_PREFIXES.has(segments[0] ?? ""))
  );
}

/**
 * Find unique answer-bearing contract tokens in a model-visible text field.
 * This is shared by prompt redaction and the read-only dataset audit so the
 * two surfaces cannot silently disagree about hyphenated acceptance codes.
 */
export function findAnswerBearingContractTokens(input: string): string[] {
  const matches = input.match(CONTRACT_TOKEN_PATTERN) ?? [];
  return [...new Set(matches.filter(isAnswerBearingContractToken))];
}

/**
 * Remove answer-bearing identifiers from a teacher/student input while
 * retaining ordinary Chinese/English task semantics.  This is intentionally
 * conservative about prose: only known contract labels, legacy
 * multi-segment snake_case identifiers, and clearly code-like hyphenated
 * acceptance labels are withheld.
 */
export function redactTeacherContractLabels(input: string): string {
  let redacted = input.replace(CONTRACT_TOKEN_PATTERN, (value) =>
    isAnswerBearingContractToken(value) ? "<withheld_contract_id>" : value,
  );
  for (const label of [...CONTRACT_LABELS].toSorted((left, right) => right.length - left.length)) {
    redacted = redacted.replace(
      new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(label)}(?![A-Za-z0-9_])`, "giu"),
      "<withheld_contract_id>",
    );
  }
  redacted = redacted.replace(CASE_LABEL_PATTERN, "<withheld_case_label>");
  return redacted
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\r?\n/gu, " ")
    .trim();
}

export type LocalBrainTrainingPromptInput = {
  userAsk: string;
};

export type LocalBrainCompletion = Record<string, unknown>;

export type LocalBrainSemanticContractAssessment = {
  alignment: "aligned" | "mismatch" | "unknown";
  expectedModules: string[];
  expectedMissingData: string[];
  expectedRiskBoundaries: string[];
  missingModules: string[];
  missingData: string[];
  missingRiskBoundaries: string[];
  reasonCodes: string[];
};

export const LOCAL_BRAIN_CURRICULUM_ARRAY_CAPS = {
  primary_modules: 8,
  supporting_modules: 6,
  required_tools: 6,
  missing_data: 8,
  risk_boundaries: 6,
  rejected_context: 3,
} as const;

export type LocalBrainCurriculumGate = {
  admitted: boolean;
  status: "admit" | "quarantine";
  reasonCodes: string[];
  shapeErrors: string[];
  semantic: LocalBrainSemanticContractAssessment;
};

function semanticStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? [value]
      : [];
}

function semanticToken(value: string): string {
  return value.trim().toLowerCase().replace(/-/gu, "_");
}

function compactTrainingContractHints(userAsk: string): string[] {
  const selected = selectLocalBrainContractHints(userAsk);
  const text = userAsk.toLowerCase();
  const ranked = selected
    .map((hint, index) => {
      const lowerHint = hint.toLowerCase();
      let score = index < 6 ? 1 : 0;
      if (
        /大宗商品|原油|黄金|commodity|oil|gold/iu.test(text) &&
        /commodit|oil|gold|库存|曲线/iu.test(lowerHint)
      ) {
        score += 6;
      }
      if (
        /(?:^|\b)a股|沪深|北向|a[- ]shares/iu.test(text) &&
        /a-share|政策|northbound|流动性/iu.test(lowerHint)
      ) {
        score += 6;
      }
      if (
        /技术面|量价|择时|technical|timing/iu.test(text) &&
        /technical|timing|量价/iu.test(lowerHint)
      ) {
        score += 6;
      }
      if (
        /学习|论文|开源|skill|learn|internaliz|github|arxiv/iu.test(text) &&
        /学习|internalization|source|skill|paper|receipt/iu.test(lowerHint)
      ) {
        score += 5;
      }
      if (
        /最新|当前|实时|价格|行情|latest|current|market data|timestamp/iu.test(text) &&
        /current market|data gateway|timestamp|source/iu.test(lowerHint)
      ) {
        score += 5;
      }
      if (
        /持有|仓位|组合|持仓|portfolio|position|exposure/iu.test(text) &&
        /portfolio|position|weight|组合/iu.test(lowerHint)
      ) {
        score += 5;
      }
      return { hint, index, score };
    })
    .toSorted((left, right) => right.score - left.score || left.index - right.index);
  const compact: string[] = [];
  let usedChars = 0;
  for (const entry of ranked) {
    if (compact.length >= 8 || (compact.length > 0 && usedChars + entry.hint.length > 3_200)) {
      continue;
    }
    compact.push(entry.hint);
    usedChars += entry.hint.length;
  }
  return compact.length > 0 ? compact : selected.slice(0, 2);
}

/**
 * Check only high-signal, shared task semantics.  This is deliberately not a
 * case-answer oracle: it never names a fixed eval id and it does not inject
 * labels into a prompt.  It is used to keep a shape-valid but obviously
 * misrouted teacher row out of the high-signal curriculum tier.
 */
export function assessLocalBrainSemanticContract(
  userAsk: string,
  completion: LocalBrainCompletion,
): LocalBrainSemanticContractAssessment {
  const text = userAsk.trim();
  if (!text) {
    return {
      alignment: "unknown",
      expectedModules: [],
      expectedMissingData: [],
      expectedRiskBoundaries: [],
      missingModules: [],
      missingData: [],
      missingRiskBoundaries: [],
      reasonCodes: ["missing_user_task"],
    };
  }
  const modules = new Set(
    [
      ...semanticStringArray(completion.primary_modules),
      ...semanticStringArray(completion.supporting_modules),
      ...semanticStringArray(completion.required_tools),
    ].map(semanticToken),
  );
  const missingData = new Set(semanticStringArray(completion.missing_data).map(semanticToken));
  const riskBoundaries = new Set(
    semanticStringArray(completion.risk_boundaries).map(semanticToken),
  );
  const expectedModules = new Set<string>();
  const expectedMissingData = new Set<string>();
  const expectedRiskBoundaries = new Set<string>();
  const lower = text.toLowerCase();
  const usEquity =
    /美股|纳斯达克|标普成分|美股科技|美国单一股票|us equities?|us stocks?|us tech names?|nvda|micron|hynix/iu.test(
      lower,
    );
  const commodity = /大宗商品|原油|黄金|工业金属|农产品|commodity|oil|gold/iu.test(lower);
  const aShare = /(?:^|\b)a股|沪深|北向|a[- ]shares/iu.test(lower);
  const index =
    /指数|指数权重|成分股|纳指|标普500|沪深300|global indices?|index regime|breadth/iu.test(lower);
  const etf =
    /\betf\b|\b(?:qqq|tlt|spy)\b|一篮子\s*etf|etf regime|基金(?:持仓|流量|跟踪|净值|组合|指数)/iu.test(
      lower,
    );
  const crypto = /比特币|加密币|加密资产|\b(?:btc|eth)\b|crypto/iu.test(lower);
  const fx = /美元|美元指数|人民币汇率|外汇|汇率|dollar|fx|currency/iu.test(lower);
  const options = /期权|隐含波动率|\b(?:iv|skew|gamma|option|options)\b/iu.test(lower);
  const bond = /债券|久期|长端利率|利率曲线|treasury|bond|duration|yield/iu.test(lower);
  const technical = /技术面|技术指标|量价|择时|technical|timing|price[- ]?volume/iu.test(lower);
  const portfolio = /持有|持仓|仓位|组合|我的资产|portfolio|exposure|position(?:s)?\b/iu.test(
    lower,
  );
  const marketData =
    /最新|当前|实时|价格|行情|报价|指数权重|成分股|today|latest|current|market data|fresh market data/iu.test(
      lower,
    );
  const learning = /学习|学会|内化|论文|开源|skill|learn|internaliz|github|arxiv/iu.test(lower);
  const sourceMissing =
    /(?:没有|未提供|缺少|缺).*?(?:来源|链接|文件)|(?:来源|链接)待补|no (?:url|link|source)|without (?:source)/iu.test(
      lower,
    );
  const sourceEvidence =
    /来源(?:已提供|已附上)|https?:\/\/|arxiv\.org|github(?:\.com)?|研报|\bpaper\b|\brepo\b|(?:^|\s)(?:\/users\/|\/tmp\/|\.\.?(?:\/|\\))/iu.test(
      lower,
    );
  const tradeProhibition =
    /(?:不要|不建议|不提供|不输出|禁止|避免|别|无需|不需要|do not|don't|no|without|never|avoid|not).{0,16}(?:交易建议|交易信号|买卖点|下单|买入|卖出|加仓|减仓|仓位比例|trade advice|trade signal|buy|sell|order|position size)/iu.test(
      lower,
    ) ||
    /(?:交易建议|交易信号|买卖点|下单|买入|卖出|加仓|减仓|仓位比例|trade advice|trade signal|buy|sell|order|position size).{0,16}(?:不要|不需要|无需|禁止|avoid|not needed|not required|not requested)/iu.test(
      lower,
    );
  const actionQuestion =
    /(?:要不要|是否|该不该|能不能|should|would you).{0,14}(?:买入|卖出|加仓|减仓|下单|仓位|buy|sell|position size|trade)/iu.test(
      lower,
    );
  const actionTerm =
    /(?:交易建议|交易信号|买卖点|买入|卖出|加仓|减仓|下单|仓位比例|trade advice|trade signal|position size|buy(?:ing)?|sell(?:ing)?|place an order|trade execution)/iu.test(
      lower,
    );
  const tradeWording = actionQuestion || (actionTerm && !tradeProhibition);
  const redTeam = /反方|反证|失效|证伪|red[- ]?team|invalidation|counter[- ]?thesis/iu.test(lower);
  const dataMissing =
    /(?:没有|未提供|暂未|暂无|缺少|缺|待补).{0,24}(?:带时间戳|时间戳|数据|输入|快照|价格|行情|报价|data|inputs?|snapshot|price|quote)/iu.test(
      lower,
    ) ||
    /(?:no|without|missing|lack(?:ing)?|unavailable|not provided|not supplied|not available|not yet).{0,24}(?:timestamped|timestamp|data|inputs?|snapshot|price|quote)/iu.test(
      lower,
    ) ||
    /(?:timestamped|timestamp|data|inputs?|snapshot|price|quote).{0,24}(?:missing|unavailable|not provided|not supplied|not available|absent)/iu.test(
      lower,
    );
  const dataSupplied =
    !dataMissing &&
    /(?:已有|已提供|提供了|附有).{0,24}(?:(?:带时间戳|时间戳|timestamped|fresh).{0,16}(?:数据|输入|快照|价格|行情|报价|data|snapshot|price|quote)|(?:数据|输入|快照|价格|行情|报价|data|snapshot|price|quote).{0,16}(?:时间戳|timestamp|fresh))|(?:fresh|timestamped|attached)\s+(?:market\s+)?(?:data|inputs?|snapshot|price|quote)(?: supplied| attached)?/iu.test(
      lower,
    );
  const marketFacing =
    usEquity ||
    commodity ||
    aShare ||
    index ||
    etf ||
    crypto ||
    fx ||
    options ||
    bond ||
    technical ||
    portfolio ||
    marketData;

  if (usEquity) {
    expectedModules.add("us_equity_market_structure");
    expectedModules.add("company_fundamentals_value");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("latest_company_fundamental_inputs");
  }
  if (commodity) {
    expectedModules.add("commodities_oil_gold");
    expectedModules.add("macro_rates_inflation");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("commodity_curve_roll_yield_and_inventory_inputs");
    expectedRiskBoundaries.add("commodity_framework_not_trade_signal");
  }
  if (aShare) {
    expectedModules.add("china_a_share_policy_flow");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("china_a_share_policy_liquidity_and_northbound_inputs");
  }
  if (index) {
    expectedModules.add("global_index_regime");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("index_constituents_weights_and_breadth_inputs");
  }
  if (etf) {
    expectedModules.add("etf_regime");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("etf_holdings_flows_and_tracking_inputs");
  }
  if (crypto) {
    expectedModules.add("crypto_market_structure");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("crypto_liquidity_volatility_custody_and_regulatory_inputs");
    expectedRiskBoundaries.add("no_high_leverage_crypto");
  }
  if (fx) {
    expectedModules.add("fx_currency_liquidity");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("fx_rate_dollar_liquidity_and_policy_inputs");
  }
  if (options) {
    expectedModules.add("options_volatility");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("options_iv_skew_gamma_and_event_calendar");
  }
  if (bond) {
    expectedModules.add("macro_rates_inflation");
    expectedModules.add("credit_liquidity");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("rates_curve_credit_spread_and_liquidity_inputs");
  }
  if (technical) {
    expectedModules.add("technical_timing");
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("price_volume_breadth_and_technical_regime_inputs");
  }
  if (portfolio) {
    expectedModules.add("portfolio_risk_gates");
    expectedModules.add("review_panel");
    expectedMissingData.add("position_weights_and_return_series");
  }
  if (aShare || technical || marketFacing) {
    expectedModules.add("finance_data_gateway");
    expectedModules.add("data_provenance_quality");
    if (!dataSupplied) {
      expectedMissingData.add("fresh_market_data_snapshot");
    }
  }
  if (learning) {
    expectedModules.add("finance_learning_memory");
    expectedModules.add("source_registry");
    expectedModules.add("eval_harness_design");
    expectedModules.add("review_panel");
    if (!sourceMissing && sourceEvidence) {
      expectedMissingData.add("actual_reading_scope");
    }
    if (sourceMissing || !sourceEvidence) {
      expectedMissingData.add("source_url_or_local_source_path");
    }
  }
  if (marketFacing || learning || tradeWording) {
    expectedRiskBoundaries.add("research_only");
  }
  if (marketFacing && !dataSupplied) {
    expectedRiskBoundaries.add("no_unverified_current_market_data");
  }
  if (tradeWording) {
    expectedRiskBoundaries.add("no_execution_authority");
    expectedRiskBoundaries.add("risk_gate_before_action_language");
    expectedRiskBoundaries.add("no_trade_advice");
  }
  if (redTeam) {
    expectedRiskBoundaries.add("red_team_invalidation_required");
    expectedMissingData.add("red_team_invalidation_evidence");
  }

  const missingModules = [...expectedModules].filter((entry) => !modules.has(entry));
  const missingExpectedData = [...expectedMissingData].filter((entry) => !missingData.has(entry));
  const missingExpectedRiskBoundaries = [...expectedRiskBoundaries].filter(
    (entry) => !riskBoundaries.has(entry),
  );
  const reasonCodes = [
    ...missingModules.map((entry) => `missing_module:${entry}`),
    ...missingExpectedData.map((entry) => `missing_data:${entry}`),
    ...missingExpectedRiskBoundaries.map((entry) => `missing_risk_boundary:${entry}`),
  ];
  const hasSignal =
    expectedModules.size > 0 || expectedMissingData.size > 0 || expectedRiskBoundaries.size > 0;
  return {
    alignment: !hasSignal ? "unknown" : reasonCodes.length === 0 ? "aligned" : "mismatch",
    expectedModules: [...expectedModules],
    expectedMissingData: [...expectedMissingData],
    expectedRiskBoundaries: [...expectedRiskBoundaries],
    missingModules,
    missingData: missingExpectedData,
    missingRiskBoundaries: missingExpectedRiskBoundaries,
    reasonCodes,
  };
}

const LOCAL_BRAIN_COMPLETION_ARRAY_FIELDS = [
  "primary_modules",
  "supporting_modules",
  "required_tools",
  "missing_data",
  "risk_boundaries",
  "rejected_context",
] as const;

const LOCAL_BRAIN_COMPLETION_SCALAR_FIELDS = ["task_family", "next_step"] as const;

const LOCAL_BRAIN_CURRICULUM_SCALAR_CAPS = {
  task_family: 120,
  next_step: 220,
} as const;

const LOCAL_BRAIN_ALLOWED_COMPLETION_KEYS = new Set<string>([
  ...LOCAL_BRAIN_COMPLETION_ARRAY_FIELDS,
  ...LOCAL_BRAIN_COMPLETION_SCALAR_FIELDS,
]);

const LOCAL_BRAIN_MODULE_ID_SET = new Set<string>(LOCAL_BRAIN_MODULE_TAXONOMY);

// Unknown task-specific safety ids may remain in receipts, but a completion
// that positively grants execution authority must never enter the shared
// curriculum. Keep this deny-list narrow so legitimate negative boundaries
// remain available to task-conditioned rows.
const UNSAFE_POSITIVE_RISK_BOUNDARY_TOKENS = new Set([
  "allow_trade_execution",
  "approve_trade_execution",
  "execute_trade",
  "order_placement",
  "place_order",
  "trade_execution",
  "buy_signal_allowed",
  "sell_signal_allowed",
  "position_sizing_allowed",
]);

function isUnsafePositiveRiskBoundary(value: string): boolean {
  const token = semanticToken(value);
  if (UNSAFE_POSITIVE_RISK_BOUNDARY_TOKENS.has(token)) {
    return true;
  }
  // Do not reject clearly negative boundaries such as
  // no_execution_authority or trade_execution_prohibited.
  if (/(?:^|_)(?:no|not|without|avoid|prohibit|prohibited|forbid|forbidden)(?:_|$)/u.test(token)) {
    return false;
  }
  return /(?:^|_)(?:allow|approve|enable|permit|execute|place_order|order_placement|sizing_allowed)(?:_|$)/u.test(
    token,
  );
}

// These fields are provenance, answer, or evaluator labels.  They belong in
// receipt/meta only; admitting them into a completion would teach the student
// to copy the target rather than infer a contract from the task.
const LOCAL_BRAIN_FORBIDDEN_COMPLETION_KEYS = new Set([
  "source_kind",
  "source_summary",
  "candidate_text",
  "user_message",
  "case_id",
  "eval_id",
  "acceptance",
  "answer",
  "answer_text",
]);

function curriculumShapeErrors(completion: LocalBrainCompletion): string[] {
  const errors: string[] = [];
  if (!completion || typeof completion !== "object" || Array.isArray(completion)) {
    return ["completion_invalid_object"];
  }
  for (const key of Object.keys(completion).toSorted()) {
    if (LOCAL_BRAIN_FORBIDDEN_COMPLETION_KEYS.has(key)) {
      errors.push(`forbidden_key:${key}`);
    } else if (!LOCAL_BRAIN_ALLOWED_COMPLETION_KEYS.has(key)) {
      errors.push(`unknown_key:${key}`);
    }
  }
  for (const field of LOCAL_BRAIN_COMPLETION_ARRAY_FIELDS) {
    const value = completion[field];
    if (!Array.isArray(value)) {
      errors.push(`array_missing_or_invalid:${field}`);
      continue;
    }
    const cap = LOCAL_BRAIN_CURRICULUM_ARRAY_CAPS[field];
    if (value.length > cap) {
      errors.push(`array_over_cap:${field}:${value.length}>${cap}`);
    }
    if (value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
      errors.push(`array_contains_non_string:${field}`);
    }
    if (
      field === "primary_modules" ||
      field === "supporting_modules" ||
      field === "required_tools"
    ) {
      for (const entry of value) {
        if (typeof entry === "string" && !LOCAL_BRAIN_MODULE_ID_SET.has(semanticToken(entry))) {
          errors.push(`unknown_module:${semanticToken(entry)}`);
        }
      }
    }
    if (field === "risk_boundaries") {
      for (const entry of value) {
        if (typeof entry === "string" && isUnsafePositiveRiskBoundary(entry)) {
          errors.push(`unsafe_risk_boundary:${semanticToken(entry)}`);
        }
      }
    }
  }
  for (const field of LOCAL_BRAIN_COMPLETION_SCALAR_FIELDS) {
    const value = completion[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`scalar_missing_or_invalid:${field}`);
    } else if (value.length > LOCAL_BRAIN_CURRICULUM_SCALAR_CAPS[field]) {
      errors.push(
        `scalar_over_cap:${field}:${value.length}>${LOCAL_BRAIN_CURRICULUM_SCALAR_CAPS[field]}`,
      );
    }
  }
  const riskBoundaries = semanticStringArray(completion.risk_boundaries).map(semanticToken);
  if (!riskBoundaries.includes("research_only")) {
    errors.push("research_only_boundary_missing");
  }
  const primaryModules = semanticStringArray(completion.primary_modules);
  const supportingModules = semanticStringArray(completion.supporting_modules);
  const requiredTools = semanticStringArray(completion.required_tools);
  if (primaryModules.length === 0) {
    errors.push("primary_modules_empty");
  }
  if (supportingModules.length === 0 && requiredTools.length === 0) {
    errors.push("supporting_or_required_tools_empty");
  }
  if (
    !semanticStringArray(completion.rejected_context).some(
      (entry) => semanticToken(entry) === "old_lark_conversation_history",
    )
  ) {
    errors.push("old_context_rejection_missing");
  }
  return errors;
}

/**
 * Shared teacher/student curriculum admission gate.
 *
 * The gate is intentionally fail-closed: shape-valid JSON is not enough.  A
 * row is admitted only when its redacted natural-language task is semantically
 * aligned with the completion.  This is a curriculum-quality decision only;
 * it is not model-learning, adapter-promotion, or user-visible evidence.
 */
export function evaluateLocalBrainCurriculumGate(
  userAsk: string,
  completion: LocalBrainCompletion,
): LocalBrainCurriculumGate {
  const shapeErrors = curriculumShapeErrors(completion);
  const safeUserAsk = redactTeacherContractLabels(userAsk);
  const semanticCompletion =
    completion && typeof completion === "object" && !Array.isArray(completion) ? completion : {};
  const semantic = assessLocalBrainSemanticContract(safeUserAsk, semanticCompletion);
  const reasonCodes = [
    ...shapeErrors.map((error) => `shape:${error}`),
    ...(semantic.alignment === "mismatch"
      ? semantic.reasonCodes.map((reason) => `semantic:${reason}`)
      : semantic.alignment === "unknown"
        ? ["semantic:unknown"]
        : []),
  ];
  const admitted = shapeErrors.length === 0 && semantic.alignment === "aligned";
  return {
    admitted,
    status: admitted ? "admit" : "quarantine",
    reasonCodes,
    shapeErrors,
    semantic,
  };
}

export function buildLocalBrainTrainingPrompt({ userAsk }: LocalBrainTrainingPromptInput): string {
  const safeUserAsk = redactTeacherContractLabels(userAsk);
  const contractHints = compactTrainingContractHints(safeUserAsk);
  const allowedRiskBoundaries = [...new Set(LOCAL_BRAIN_RISK_BOUNDARIES)];
  return [
    "You are the LCX Agent local auxiliary thought-flow model.",
    "Task: produce a concise control-room planning packet for the main agent.",
    "Do not answer the user's finance question directly.",
    "/no_think",
    "Do not emit chain-of-thought, markdown, or <think> blocks; output only the JSON object.",
    "Keep the JSON compact: short arrays, short next_step, no explanation inside or outside JSON.",
    `Output contract: ${LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS.join(" ")}`,
    'Use this exact compact shape: {"task_family":"snake_case","primary_modules":[],"supporting_modules":[],"required_tools":[],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"snake_case_action","rejected_context":["old_lark_conversation_history"]}',
    "Think like a careful human financial analyst: clarify objective, recall local memory and learned rules, split causal layers, identify missing evidence, route to review, then summarize for the control room.",
    "Do not invent current or timestamped market data, execution approval, or durable memory writes.",
    `Allowed module ids: ${LOCAL_BRAIN_MODULE_TAXONOMY.join(", ")}.`,
    `Canonical shared risk_boundary ids (use these when applicable; task-specific ids only when directly demanded by the natural-language task): ${allowedRiskBoundaries.join(", ")}.`,
    "For finance tasks, choose concrete module ids from the allowed list instead of generic finance labels.",
    `Core planning hints: ${contractHints.join(" ")}`,
    "Return only JSON with keys: task_family, primary_modules, supporting_modules, required_tools, missing_data, risk_boundaries, next_step, rejected_context.",
    `prompt_contract_version: ${LOCAL_BRAIN_TRAINING_PROMPT_VERSION}`,
    "Training provenance is withheld from the model-visible prompt; use only the natural-language task and keep provenance in meta/receipts.",
    `user_or_task: ${safeUserAsk}`,
    "Final output reminder: emit exactly one closed JSON object now; never continue with prose after the final brace.",
  ].join("\n");
}
