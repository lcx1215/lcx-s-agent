const prompt = process.argv.at(-1) ?? "";

const plan = prompt.includes("Lark 上下文污染")
  ? {
      task_family: "ops_audit",
      primary_modules: ["ops_audit"],
      supporting_modules: [],
      required_tools: [],
      missing_data: [],
      risk_boundaries: ["research_only"],
      next_step: "inspect_lark_context",
      rejected_context: ["old_lark_conversation_history"],
    }
  : {
      task_family: "cross_market_finance_research_planning",
      primary_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "global_index_regime",
        "crypto_market_structure",
        "quant_math",
        "portfolio_risk_gates",
        "skill_pattern_distillation",
        "agent_workflow_memory",
        "ops_audit",
      ],
      supporting_modules: [
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ],
      required_tools: [],
      missing_data: [
        "source_url_or_local_source_path",
        "memory_recall_scope_or_relevant_receipts",
        "fresh_market_data_snapshot",
        "us_equity_breadth_earnings_and_valuation_inputs",
        "china_a_share_policy_liquidity_and_northbound_inputs",
        "index_constituents_weights_and_technical_regime_inputs",
        "crypto_liquidity_volatility_custody_and_regulatory_inputs",
        "fx_dollar_yuan_and_global_liquidity_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
        "candidate_skill_source_or_local_skill_path",
        "target_workflow_acceptance_metric",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "no_high_leverage_crypto",
        "no_unverified_cross_market_claims",
        "untrusted_external_skill",
        "no_protected_memory_write",
        "no_provider_config_change",
        "no_live_sender_change",
      ],
      next_step: "review_plan",
      rejected_context: ["old_lark_conversation_history"],
    };

process.stdout.write(`${JSON.stringify(plan)}\n`);
