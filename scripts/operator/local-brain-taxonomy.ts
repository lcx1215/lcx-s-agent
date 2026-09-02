import {
  LCX_ONTOLOGY_CORE_RISK_BOUNDARY_IDS,
  LCX_ONTOLOGY_MODULE_ALIASES,
  LCX_ONTOLOGY_MODULE_IDS,
  LCX_ONTOLOGY_REQUIRED_FINANCE_MODULE_IDS,
} from "../../src/shared/lcx-ontology.js";

export const LOCAL_BRAIN_MODULE_TAXONOMY = LCX_ONTOLOGY_MODULE_IDS;

export type LocalBrainModuleId = (typeof LOCAL_BRAIN_MODULE_TAXONOMY)[number];

const LOCAL_BRAIN_MODULE_ID_SET = new Set<string>(LOCAL_BRAIN_MODULE_TAXONOMY);

export type LocalBrainModuleFieldCaps = {
  primary: number;
  supporting: number;
  requiredTools: number;
};

const DEFAULT_MODULE_FIELD_CAPS: LocalBrainModuleFieldCaps = {
  primary: 8,
  supporting: 6,
  requiredTools: 6,
};

const LEGACY_TOOL_TO_MODULE = LCX_ONTOLOGY_MODULE_ALIASES;

export function normalizeLocalBrainModuleId(value: string): LocalBrainModuleId | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (LOCAL_BRAIN_MODULE_ID_SET.has(normalized)) {
    return normalized as LocalBrainModuleId;
  }
  const legacyToolModule = LEGACY_TOOL_TO_MODULE[normalized];
  if (legacyToolModule) {
    return legacyToolModule;
  }
  const financeProducer = /^finance_framework_(.+?)_producer$/u.exec(normalized)?.[1];
  if (financeProducer && LOCAL_BRAIN_MODULE_ID_SET.has(financeProducer)) {
    return financeProducer as LocalBrainModuleId;
  }
  return undefined;
}

export function normalizeLocalBrainModuleList(values: readonly string[]): LocalBrainModuleId[] {
  const seen = new Set<LocalBrainModuleId>();
  const modules: LocalBrainModuleId[] = [];
  for (const value of values) {
    const module = normalizeLocalBrainModuleId(value);
    if (!module || seen.has(module)) {
      continue;
    }
    if (module === "fx_dollar" && seen.has("fx_currency_liquidity")) {
      continue;
    }
    seen.add(module);
    modules.push(module);
  }
  return modules;
}

export function packLocalBrainModuleFields(
  primaryModules: readonly string[],
  supportingModules: readonly string[],
  requiredTools: readonly string[],
  caps: LocalBrainModuleFieldCaps = DEFAULT_MODULE_FIELD_CAPS,
): {
  primary_modules: LocalBrainModuleId[];
  supporting_modules: LocalBrainModuleId[];
  required_tools: LocalBrainModuleId[];
} {
  const ordered = normalizeLocalBrainModuleList([
    ...primaryModules,
    ...supportingModules,
    ...requiredTools,
  ]);
  const primary_modules = ordered.slice(0, caps.primary);
  const supporting_modules = ordered.slice(caps.primary, caps.primary + caps.supporting);
  const required_tools = ordered.slice(
    caps.primary + caps.supporting,
    caps.primary + caps.supporting + caps.requiredTools,
  );
  return {
    primary_modules,
    supporting_modules,
    required_tools,
  };
}

export const LOCAL_BRAIN_REQUIRED_FINANCE_MODULES = LCX_ONTOLOGY_REQUIRED_FINANCE_MODULE_IDS;

export const LOCAL_BRAIN_RISK_BOUNDARIES = LCX_ONTOLOGY_CORE_RISK_BOUNDARY_IDS;

export const LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS = [
  "Output one single-line JSON object only; no pretty printing, markdown, or prose outside JSON.",
  "Hard output budget: primary_modules <= 8, supporting_modules <= 6, required_tools <= 6, missing_data <= 8, risk_boundaries <= 6, rejected_context <= 3.",
  "Do not copy or enumerate the full module taxonomy; choose only the few module ids directly needed for this task.",
  "Every array item must be a compact snake_case id from the allowed vocabulary; prefer fewer ids over long prose, invented ids, or an unclosed JSON object.",
  "If the task is complex, compress by selecting only the highest-signal module ids; never explain the module map inside JSON values.",
] as const;

export const LOCAL_BRAIN_CONTRACT_HINTS = [
  "If source URL or local file is missing, include source_registry and missing_data source_url_or_local_source_path.",
  "If portfolio math inputs are missing, include missing_data position_weights_and_return_series exactly.",
  "If a company risk can affect a portfolio or ETF sleeve, include portfolio_risk_gates.",
  "Value-investing and fundamentals-first asks must prioritize company_fundamentals_value before technical timing: require filing/source evidence, business quality, revenue quality, margin durability, free cash flow, ROIC, balance sheet, moat, management capital allocation, valuation range, margin of safety, value-trap risk, and thesis invalidation.",
  "If the user asks to use local memory, learned rules, receipts, or prior knowledge, include finance_learning_memory, source_registry, causal_map, review_panel, and memory_recall_scope_or_relevant_receipts.",
  "Complex finance tasks should be decomposed like a careful human analyst: clarify objective, recall memory, split causal layers, identify missing evidence, run review, then summarize.",
  "Plain-language hidden-complexity intake is a generic failure family: when a user gives a short example, first identify original example, abstracted failure family, adjacent non-identical scenario, shared contract, and regression proof; expand the request into scope, evidence, modules, memory, review, and user-visible summary instead of answering only the literal phrase.",
  "Plain short finance asks such as analyzing recent stock market, deciding how much of a stock to hold, or asking whether to buy or keep holding are not simple answers: expand them into market scope, timestamped data, user constraints, fundamentals, valuation, technical timing, portfolio risk gates, source registry, review panel, and a plain research-only summary; never invent current market facts, position percentages, buy/sell points, or trade advice.",
  "Offensive stock-opportunity asks such as recommending stocks, finding potential winners, comparing Micron versus SK Hynix, or screening outside semiconductors should not collapse into a conservative refusal: build a cross-sector research-only watchlist with mispricing hypothesis, upside driver, fundamental/valuation evidence, catalyst path, technical timing context, red-team invalidation, and risk-gated opportunity tiering; do not output a buy list, position size, or execution instruction.",
  "All-domain finance learning must make company fundamentals and value-investing judgment a core anchor, then connect macro rates, credit, FX, cross-asset liquidity, US equities, A-shares, global indices, ETFs, commodities, options volatility, crypto, technical timing, quant validation, event risk, sentiment validation, portfolio risk gates, source registry, and review panel; do not let a harder task bypass simpler prerequisite modules.",
  "Current market, price, fundamental, macro, ETF, options, index-weight, vendor, or portfolio-risk numbers must go through finance_data_gateway before Qwen or External uses them: require primary source, cross-check source, official or issuer reference when applicable, source timestamp, timezone, field definition, unit/currency, adjusted status, and conflict routing to data_provenance_quality.",
  "Cross-market finance tasks spanning US equities, A-shares, indices, or crypto must include the concrete market-structure modules, cross_asset_liquidity, risk gates, fresh data gaps, and no_high_leverage_crypto.",
  "Options, commodities, FX, event risk, and technical timing must use their dedicated modules when mentioned; do not collapse them into generic macro or ETF labels.",
  "External knowledge internalization from papers or open-source projects must first check prior_art_search_terms_or_existing_artifact_paths and existing_contract_eval_skill_or_receipt_candidates, then choose reuse_extend_or_new_decision before creating a new path; it must use source_registry, actual_reading_scope, license_and_write_scope_review when code is involved, prompt-injection/security review, capability_card_or_retrieval_receipt, application_validation_receipt, training_or_eval_absorption_evidence, fresh adjacent application, and a keep/downrank/discard decision before claiming learning.",
  "Agent skill learning tasks must include skill_pattern_distillation, agent_workflow_memory, source_registry, eval_harness_design, review_panel, and no_protected_memory_write.",
  "External financial agent frameworks such as Anthropic financial-services must be learned as reusable workflow architecture, not installed as live authority: require source repo or local clone path, source commit/version, license review, actual reading scope, workflow_owner_definition, leaf_worker_inventory, handoff_contract, tool_permission_boundary_map, untrusted-source isolation rule, citation/provenance rule, artifact QC gate sequence, human signoff checkpoint, visible_summary_contract, application validation, fresh adjacent application, and keep/downrank/discard decision.",
  "All module learning uses the same internalization chain, not only factor modules: every target module needs source registry, actual reading scope, module-specific capability rule, retrieval receipt, application validation, local-brain eval or training absorption evidence, fresh adjacent task, module_learning_pipeline_review status, safety boundary, and keep/downrank/discard decision before anyone claims the module learned it.",
  "Advanced trader research chains must not stop at broad fundamentals: DCF/comps/modeling asks use financial_modeling_valuation_qc, thesis/catalyst/invalidation asks use thesis_catalyst_lifecycle, vendor/field/timestamp conflicts use data_provenance_quality, and reports/spreadsheets/tables/narrative artifacts use research_artifact_qc before a visible control-room summary.",
  "Prediction-market and Polymarket sources are research-only weak evidence: require market id or URL, real market metadata packet, resolution criteria, resolution ambiguity review, close date/timezone, orderbook/liquidity timestamp, thin-liquidity downrank thresholds, market microstructure warning, paper-only strategy audit, sample-out validation, slippage/fee assumptions, counterevidence, paper-strategy failure log, no wallet connection, no order placement, no copy trading, no forecast authority, and no latency arbitrage.",
] as const;

const BASE_CONTRACT_HINT_INDEXES = [0, 1, 2, 3, 4, 5] as const;

const CONTRACT_HINT_SELECTORS: Array<{
  indexes: readonly number[];
  pattern: RegExp;
}> = [
  {
    indexes: [6, 7],
    pattern:
      /短|口语|看不懂|external|external|外部消息通道|最近股市|持仓|拿|买|卖|大宗商品|plain|recent stock|buy|hold|position sizing|visible reply/iu,
  },
  {
    indexes: [8, 9, 10, 11, 17],
    pattern:
      /美股|a股|指数|加密|期权|大宗|商品|黄金|原油|美元|外汇|事件|技术|跨市场|估值|DCF|comps|模型|财务模型|研报|口径|字段|时间戳|催化|失效|crypto|option|commodity|gold|oil|dollar|fx|event|technical|cross-market|valuation|modeling|thesis|catalyst|provenance|timestamp|artifact|spreadsheet|report/iu,
  },
  {
    indexes: [7, 8, 11, 17],
    pattern:
      /推荐股|好股|潜在.*股|选股|股票池|观察池|跨行业|全市场|行业轮动|watchlist|stock pick|stock screen|opportunity|mispricing|upside|弹性|前瞻|冒险|小仓位|美光|micron|mu\b|海力士|hynix|hbm|dram|nand|能源|油气|电力|医疗|医药|生物科技|金融|银行|保险|工业|军工|消费|软件|网络安全|小盘|中盘|周期股/iu,
  },
  {
    indexes: [10, 13, 18],
    pattern:
      /polymarket|polybench|polyswarm|polyclaw|polybot|polyseer|prediction market|预测市场|clob|orderbook|订单簿|market[- ]?making|paper trading/iu,
  },
  {
    indexes: [10],
    pattern:
      /当前|最新|今天|现在|价格|行情|报价|市场数据|实时|vendor|供应商|source timestamp|field definition|指数权重|成分股|current|latest|today|price|quote|market data|fresh data|index weight|constituent/iu,
  },
  {
    indexes: [13, 14, 16],
    pattern:
      /论文|arxiv|ssrn|github|huggingface|开源|source|capability|receipt|skill|paper|open-source|framework|dataset|eval|内化链条|学习链条|吸收链条|所有模块|其他模块|因子模块/iu,
  },
  {
    indexes: [15],
    pattern:
      /anthropic|financial agent|financial-services|hermes|harness|外部.*agent|金融.*agent|架构哲学/iu,
  },
];

export function selectLocalBrainContractHints(text: string): readonly string[] {
  const selected = new Set<number>(BASE_CONTRACT_HINT_INDEXES);
  for (const selector of CONTRACT_HINT_SELECTORS) {
    if (selector.pattern.test(text)) {
      for (const index of selector.indexes) {
        selected.add(index);
      }
    }
  }
  return [...selected]
    .toSorted((a, b) => a - b)
    .map((index) => LOCAL_BRAIN_CONTRACT_HINTS[index])
    .filter((hint): hint is string => Boolean(hint));
}
