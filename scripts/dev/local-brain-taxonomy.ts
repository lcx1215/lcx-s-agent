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
  "All-domain finance learning must make company fundamentals and value-investing judgment a core anchor, then connect macro rates, credit, FX, cross-asset liquidity, US equities, A-shares, global indices, ETFs, commodities, options volatility, crypto, technical timing, quant validation, event risk, sentiment validation, portfolio risk gates, source registry, and review panel; do not let a harder task bypass simpler prerequisite modules.",
  "Cross-market finance tasks spanning US equities, A-shares, indices, or crypto must include the concrete market-structure modules, cross_asset_liquidity, risk gates, fresh data gaps, and no_high_leverage_crypto.",
  "Options, commodities, FX, event risk, and technical timing must use their dedicated modules when mentioned; do not collapse them into generic macro or ETF labels.",
  "Agent skill learning tasks must include skill_pattern_distillation, agent_workflow_memory, source_registry, eval_harness_design, review_panel, and no_protected_memory_write.",
] as const;
