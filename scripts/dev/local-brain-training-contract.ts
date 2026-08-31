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

type CompletionValue = Record<string, unknown>;

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
  completion: CompletionValue,
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
  const etf = /\betf\b|qqq|tlt|spy|一篮子 etf|etf regime|基金/iu.test(lower);
  const crypto = /比特币|加密币|加密资产|btc|eth|crypto/iu.test(lower);
  const fx = /美元|美元指数|人民币汇率|外汇|汇率|dollar|fx|currency/iu.test(lower);
  const options = /期权|隐含波动率|\biv\b|skew|gamma|options?/iu.test(lower);
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
    /(?:不要|不建议|不提供|不输出|禁止|避免|别|无需|不需要).{0,12}(?:交易建议|买卖点|下单|买入|卖出|加仓|减仓|trade advice|trade signal|buy|sell|order)/iu.test(
      lower,
    );
  const actionQuestion =
    /(?:要不要|是否|该不该|能不能|should|would you).{0,14}(?:买入|卖出|加仓|减仓|下单|仓位|buy|sell|position size|trade)/iu.test(
      lower,
    );
  const actionTerm =
    /(?:买入|卖出|加仓|减仓|下单|仓位比例|position size|buy(?:ing)?|sell(?:ing)?|place an order|trade execution|trade signal)/iu.test(
      lower,
    );
  const tradeWording = actionQuestion || (actionTerm && !tradeProhibition);
  const redTeam = /反方|反证|失效|证伪|red[- ]?team|invalidation|counter[- ]?thesis/iu.test(lower);
  const dataMissing =
    /(?:没有|未提供|暂未|暂无|缺少|缺|待补).{0,16}(?:数据|输入|快照|时间戳|data|snapshot)/iu.test(
      lower,
    );
  const dataSupplied =
    !dataMissing &&
    /(?:已有|已提供|提供了|附有).{0,16}(?:带时间戳|时间戳|timestamp|fresh).{0,8}(?:数据|输入|快照|data|snapshot)|带时间戳(?:输入|数据|快照)|(?:fresh|timestamped|attached) (?:market )?data(?: supplied| attached)?/iu.test(
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
