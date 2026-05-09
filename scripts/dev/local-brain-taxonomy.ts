export const LOCAL_BRAIN_MODULE_TAXONOMY = [
  "macro_rates_inflation",
  "credit_liquidity",
  "cross_asset_liquidity",
  "fx_currency_liquidity",
  "etf_regime",
  "global_index_regime",
  "us_equity_market_structure",
  "china_a_share_policy_flow",
  "crypto_market_structure",
  "technical_timing",
  "options_volatility",
  "commodities_oil_gold",
  "fx_dollar",
  "event_driven",
  "company_fundamentals_value",
  "quant_math",
  "portfolio_risk_gates",
  "causal_map",
  "finance_learning_memory",
  "source_registry",
  "skill_pattern_distillation",
  "agent_workflow_memory",
  "eval_harness_design",
  "review_panel",
  "control_room_summary",
  "ops_audit",
] as const;

export type LocalBrainModuleId = (typeof LOCAL_BRAIN_MODULE_TAXONOMY)[number];

export const LOCAL_BRAIN_REQUIRED_FINANCE_MODULES = [
  "macro_rates_inflation",
  "credit_liquidity",
  "etf_regime",
  "company_fundamentals_value",
  "portfolio_risk_gates",
] as const satisfies readonly LocalBrainModuleId[];

export const LOCAL_BRAIN_RISK_BOUNDARIES = [
  "research_only",
  "no_execution_authority",
  "evidence_required",
  "no_model_math_guessing",
  "risk_gate_before_action_language",
  "no_high_leverage_crypto",
  "no_unverified_cross_market_claims",
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
  "All-domain finance learning must make company fundamentals and value-investing judgment a core anchor, then connect macro rates, credit, FX, cross-asset liquidity, US equities, A-shares, global indices, ETFs, commodities, options volatility, crypto, technical timing, quant validation, event risk, sentiment validation, portfolio risk gates, source registry, and review panel; do not let a harder task bypass simpler prerequisite modules.",
  "Cross-market finance tasks spanning US equities, A-shares, indices, or crypto must include the concrete market-structure modules, cross_asset_liquidity, risk gates, fresh data gaps, and no_high_leverage_crypto.",
  "Options, commodities, FX, event risk, and technical timing must use their dedicated modules when mentioned; do not collapse them into generic macro or ETF labels.",
  "External knowledge internalization from papers or open-source projects must first check prior_art_search_terms_or_existing_artifact_paths and existing_contract_eval_skill_or_receipt_candidates, then choose reuse_extend_or_new_decision before creating a new path; it must use source_registry, actual_reading_scope, license_and_write_scope_review when code is involved, prompt-injection/security review, capability_card_or_retrieval_receipt, application_validation_receipt, training_or_eval_absorption_evidence, fresh adjacent application, and a keep/downrank/discard decision before claiming learning.",
  "Agent skill learning tasks must include skill_pattern_distillation, agent_workflow_memory, source_registry, eval_harness_design, review_panel, and no_protected_memory_write.",
  "External financial agent frameworks such as Anthropic financial-services must be learned as reusable workflow architecture, not installed as live authority: require source repo or local clone path, source commit/version, license review, actual reading scope, workflow_owner_definition, leaf_worker_inventory, handoff_contract, tool_permission_boundary_map, untrusted-source isolation rule, citation/provenance rule, artifact QC gate sequence, human signoff checkpoint, visible_summary_contract, application validation, fresh adjacent application, and keep/downrank/discard decision.",
] as const;

const BASE_CONTRACT_HINT_INDEXES = [0, 1, 2, 3, 4, 5] as const;

const CONTRACT_HINT_SELECTORS: Array<{
  indexes: readonly number[];
  pattern: RegExp;
}> = [
  {
    indexes: [6, 7],
    pattern:
      /短|口语|看不懂|lark|feishu|飞书|最近股市|持仓|拿|买|卖|大宗商品|plain|recent stock|buy|hold|position sizing|visible reply/iu,
  },
  {
    indexes: [8, 9, 10],
    pattern:
      /美股|a股|指数|加密|期权|大宗|商品|黄金|原油|美元|外汇|事件|技术|跨市场|crypto|option|commodity|gold|oil|dollar|fx|event|technical|cross-market/iu,
  },
  {
    indexes: [11, 12],
    pattern:
      /论文|arxiv|ssrn|github|huggingface|开源|source|capability|receipt|skill|paper|open-source|framework|dataset|eval/iu,
  },
  {
    indexes: [13],
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
