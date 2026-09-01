import { describe, expect, it } from "vitest";
import { hardenLocalBrainPlanForAsk } from "../scripts/operator/local-brain-contracts.js";

describe("hardenLocalBrainPlanForAsk", () => {
  it("expands short recent-market asks into scoped research preflight", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "分析最近股市。",
      },
    );

    expect(plan.task_family).toBe("plain_recent_stock_market_brief_preflight");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "macro_rates_inflation",
        "credit_liquidity",
        "global_index_regime",
        "us_equity_market_structure",
        "etf_regime",
        "company_fundamentals_value",
        "technical_timing",
        "portfolio_risk_gates",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "market_scope_and_time_window",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "price_volume_breadth_and_technical_regime_inputs",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["no_unverified_current_market_data", "no_trade_advice"]),
    );
    expect(plan.rejected_context).toContain("generic_market_commentary_without_scope_or_sources");
  });

  it("turns short position-sizing wording into input-gated research planning", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "关注 NVDA 持仓多少。",
      },
    );

    expect(plan.task_family).toBe("plain_single_stock_position_sizing_preflight");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "quant_math",
        "technical_timing",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "current_total_assets_and_position_size",
        "position_weights_cost_basis_and_risk_limits",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ]),
    );
    expect(plan.risk_boundaries).toContain(
      "position_sizing_requires_user_constraints_and_risk_budget",
    );
    expect(plan.rejected_context).toContain("invented_position_percentage");
  });

  it("converts short buy-or-hold wording into research-only boundary planning", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "NVDA 还能不能拿，要不要买一点？",
      },
    );

    expect(plan.task_family).toBe("plain_buy_hold_research_boundary");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "macro_rates_inflation",
        "technical_timing",
        "source_registry",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "user_objective_time_horizon_and_current_position",
        "position_weights_cost_basis_and_risk_limits",
        "latest_company_fundamental_inputs",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["convert_trade_question_to_research_preflight", "no_trade_advice"]),
    );
    expect(plan.rejected_context).toContain("direct_buy_sell_answer");
  });

  it("routes synthetic single-stock curve analysis to technical timing without trade advice", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "纯合成单个股60日OHLCV曲线测试，不涉及实时行情：前20天价格缓慢上行但成交量递减；第25天放量跳空上破前高，三天后回补缺口；第35天反弹但未创新高；第45天跌破20日均线后缩量横盘；第55天放量长下影线守住前低。请判断趋势阶段、量价背离、支撑阻力、假突破、二次确认、失效条件、还缺哪些OHLCV字段和均线/波动率输入，并说明技术面只能作为 timing，必须接基本面和组合风险门；禁止买卖建议。",
      },
    );

    expect(plan.task_family).toBe("single_stock_curve_technical_timing_preflight");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "technical_timing",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "source_registry",
        "data_provenance_quality",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "single_stock_ohlcv_price_volume_series",
        "moving_average_volatility_and_gap_inputs",
        "price_volume_breadth_and_technical_regime_inputs",
        "latest_company_fundamental_inputs",
        "position_weights_cost_basis_and_risk_limits",
        "invalidation_condition_for_timing_signal",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "technical_timing_not_standalone_alpha",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ]),
    );
    expect(plan.rejected_context).toEqual(
      expect.arrayContaining(["direct_buy_sell_answer", "technical_timing_as_standalone_alpha"]),
    );
  });

  it("turns potential-stock asks into opportunity research without becoming a buy list", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "帮我找未来 6-18 个月潜在好股，不止半导体，也看能源、医疗、金融、工业和小中盘，研究胆子要大但别直接喊买。",
      },
    );

    expect(plan.task_family).toBe("offensive_stock_opportunity_research");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "technical_timing",
        "portfolio_risk_gates",
        "source_registry",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "candidate_universe_and_exclusion_rules",
        "sector_scope_and_style_bucket",
        "latest_company_fundamental_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "upside_driver_and_market_mispricing_hypothesis",
        "red_team_invalidation_evidence",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "opportunity_ranking_not_buy_list",
        "small_position_trial_requires_user_constraints",
        "red_team_invalidation_required",
        "no_trade_advice",
      ]),
    );
    expect(plan.rejected_context).toEqual(
      expect.arrayContaining([
        "overly_conservative_refusal_only",
        "direct_buy_list_without_sources",
      ]),
    );
  });

  it("expands broad finance asks into dedicated module coverage", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "金融模块还不够。以后我要看美股、A股、指数、ETF、加密币、原油、黄金、美元、期权波动率、事件风险、技术择时、公司基本面、组合风险和量化。请先做完整模块地图，别把所有东西塞进宏观/ETF/组合三个桶。",
      },
    );

    expect(plan.task_family).toBe("broad_finance_module_taxonomy_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "fx_dollar",
        "etf_regime",
        "global_index_regime",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "crypto_market_structure",
        "commodities_oil_gold",
        "options_volatility",
        "event_driven",
        "technical_timing",
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "data_provenance_quality",
        "research_artifact_qc",
        "quant_math",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.supporting_modules).toEqual(
      expect.arrayContaining([
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "commodity_curve_roll_yield_and_inventory_inputs",
        "options_iv_skew_gamma_and_event_calendar",
        "price_volume_breadth_and_technical_regime_inputs",
        "latest_company_fundamental_inputs",
        "model_assumptions_sensitivity_and_audit_inputs",
        "thesis_catalyst_calendar_and_invalidation_evidence",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "research_artifact_qc_and_number_provenance_checklist",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "technical_timing_not_standalone_alpha",
        "sentiment_signal_not_standalone_alpha",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ]),
    );
    expect(plan.rejected_context).toContain("single_bucket_finance_routing");
  });

  it("keeps FOMC and CPI event-risk asks on the macro event preflight contract", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "FOMC 和 CPI 前，我持有 QQQ、TLT、NVDA。请先拆事件风险研究链路：宏观利率、美元流动性、ETF regime、仓位风险、技术面和反方证据，不要预测当天涨跌。",
      },
    );

    expect(plan.task_family).toBe("macro_event_risk_research_preflight");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "event_driven",
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "technical_timing",
        "portfolio_risk_gates",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "current_rates_and_inflation_inputs",
        "current_credit_and_liquidity_inputs",
        "target_etf_price_and_regime_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ]),
    );
    expect(plan.risk_boundaries).toContain("no_same_day_price_prediction");
    expect(plan.rejected_context).toContain("same_day_price_prediction");
  });

  it("keeps learned-rule cross-market prompts out of the missing-source gate", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "User will watch US equities, China A-shares, global indices, and crypto. Use local memory and learned rules first, decompose internal modules, produce research-only output, avoid trade advice, and identify missing inputs before conclusion.",
      },
    );

    expect(plan.task_family).toBe("cross_market_finance_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(plan.supporting_modules).toEqual(
      expect.arrayContaining([
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "fresh_market_data_snapshot",
        "index_constituents_weights_and_technical_regime_inputs",
        "china_a_share_policy_liquidity_and_northbound_inputs",
        "crypto_liquidity_volatility_custody_and_regulatory_inputs",
        "fx_dollar_yuan_and_global_liquidity_inputs",
        "position_weights_and_return_series",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "research_only",
        "no_execution_authority",
        "no_high_leverage_crypto",
      ]),
    );
    expect(plan.next_step).toBe(
      "recall_local_finance_rules_then_build_cross_market_causal_map_collect_fresh_inputs_run_quant_and_review_before_control_room_summary",
    );
  });

  it("hardens Mag7 concentration prompts with breadth, valuation, index, and portfolio inputs", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "纳指和标普如果越来越集中在 Mag7，我持有 QQQ 和 NVDA 时，怎么拆指数权重、市场宽度、估值、组合暴露和反方论证？",
      },
    );

    expect(plan.task_family).toBe("cross_market_finance_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "us_equity_market_structure",
        "global_index_regime",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "us_equity_breadth_earnings_and_valuation_inputs",
        "index_constituents_weights_and_technical_regime_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_trade_advice"]),
    );
  });

  it("canonicalizes case-variant Mag7 missing-data identifiers before eval", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {
        missing_data: [
          "US_equity_breadth_earnings_and_valuation_inputs",
          "INDEX-CONSTITUENTS/WEIGHTS and TECHNICAL REGIME INPUTS",
        ],
      },
      {
        ask: "纳指和标普如果越来越集中在 Mag7，我持有 QQQ 和 NVDA 时，怎么拆指数权重、市场宽度、估值、组合暴露和反方论证？",
        sourceSummary:
          "index concentration and mega-cap exposure research loop for QQQ/NVDA portfolio.",
      },
    );

    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "us_equity_breadth_earnings_and_valuation_inputs",
        "index_constituents_weights_and_technical_regime_inputs",
      ]),
    );
    expect(plan.missing_data).not.toContain("US_equity_breadth_earnings_and_valuation_inputs");
  });

  it("canonicalizes weak high-leverage crypto boundary variants", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {
        risk_boundaries: [
          "research_only",
          "no_execution_authority",
          "no_high_leverage_crypto_reference",
          "no_crypto_leverage_trade_recommendation",
          "no_leverage_on_crypto",
          "no_high_leverage",
        ],
      },
      {
        ask: "User will watch US equities, China A-shares, global indices, and crypto; keep it research-only.",
      },
    );

    expect(
      plan.risk_boundaries.filter((entry) => entry === "no_high_leverage_crypto"),
    ).toHaveLength(1);
    expect(plan.risk_boundaries).not.toContain("no_high_leverage_crypto_reference");
    expect(plan.risk_boundaries).not.toContain("no_crypto_leverage_trade_recommendation");
    expect(plan.risk_boundaries).not.toContain("no_leverage_on_crypto");
    expect(plan.risk_boundaries).not.toContain("no_high_leverage");
  });

  it("canonicalizes fragmented position and return-series missing data", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {
        missing_data: ["current_position_weights", "return_series_or_price_history"],
      },
      {
        ask: "我想做组合回撤和相关性，但只给了当前仓位和历史价格，先拆数据缺口。",
      },
    );

    expect(plan.missing_data).toContain("position_weights_and_return_series");
  });

  it("does not misroute cross-market data-gap prompts into source audit", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "未来我会同时看美股、A股、全球指数、ETF、主要资产和加密币。请用本地记忆和已学规则，拆出宏观利率、信用流动性、跨资产流动性、美元/人民币流动性、美股市场结构、A股政策资金面、全球指数状态、加密币市场结构、量化数学、组合风险门、数据缺口和反方审阅；research-only，不要交易建议。",
      },
    );

    expect(plan.task_family).toBe("cross_market_finance_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "fresh_market_data_snapshot",
        "china_a_share_policy_liquidity_and_northbound_inputs",
        "index_constituents_weights_and_technical_regime_inputs",
        "crypto_liquidity_volatility_custody_and_regulatory_inputs",
        "fx_dollar_yuan_and_global_liquidity_inputs",
        "position_weights_and_return_series",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_unverified_cross_market_claims"]),
    );
  });

  it("still blocks real external-source learning when the source is missing", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "去学习这篇金融论文并沉淀成规则，但我还没给链接或本地文件。",
      },
    );

    expect(plan.task_family).toBe("external_source_learning_missing_source");
    expect(plan.primary_modules).toEqual(["finance_learning_memory", "source_registry"]);
    expect(plan.missing_data).toContain("source_url_or_local_source_path");
  });

  it("hardens full-stack finance stress prompts with red-team and data gaps", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "我要做完整金融研究拆解：组合有 QQQ、NVDA 和现金，同时看 NVDA 财报、AI capex 指引、Fed 利率路径、美元流动性、仓位权重、技术面趋势和成交量，还要反方论证和数据缺口，research-only，不要交易建议。",
      },
    );

    expect(plan.task_family).toBe("full_stack_finance_stress_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "global_index_regime",
        "etf_regime",
        "quant_math",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.supporting_modules).toEqual(
      expect.arrayContaining([
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "latest_10q_10k_or_earnings_release",
        "guidance_revision_margin_revenue_and_valuation_inputs",
        "current_rates_inflation_fed_path_and_liquidity_inputs",
        "position_weights_cost_basis_and_risk_limits",
        "price_volume_breadth_and_technical_regime_inputs",
        "red_team_invalidation_evidence",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "research_only",
        "no_execution_authority",
        "no_model_math_guessing",
        "no_unverified_current_market_data",
        "red_team_invalidation_required",
        "no_trade_advice",
      ]),
    );
  });

  it("does not misroute full-stack finance stress prompts into source audit", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "我要做完整金融研究拆解：组合有 QQQ、NVDA、现金和一点 BTC，同时看 NVDA 财报、AI capex 指引、Fed 利率路径、美元流动性、A股政策资金面、全球指数权重、仓位权重、技术面趋势和成交量，还要反方论证和数据缺口，research-only，不要交易建议。",
      },
    );

    expect(plan.task_family).toBe("full_stack_finance_stress_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "global_index_regime",
        "etf_regime",
        "quant_math",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "latest_10q_10k_or_earnings_release",
        "current_rates_inflation_fed_path_and_liquidity_inputs",
        "position_weights_cost_basis_and_risk_limits",
        "price_volume_breadth_and_technical_regime_inputs",
        "red_team_invalidation_evidence",
        "fresh_market_data_snapshot",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "research_only",
        "no_unverified_current_market_data",
        "red_team_invalidation_required",
        "no_trade_advice",
      ]),
    );
  });

  it("does not let crypto boundary fallback override a full-stack finance stress ask", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {
        task_family: "crypto_leverage_research_boundary",
        primary_modules: [
          "crypto_market_structure",
          "cross_asset_liquidity",
          "portfolio_risk_gates",
          "review_panel",
        ],
        supporting_modules: ["finance_learning_memory", "source_registry", "control_room_summary"],
        required_tools: [
          "finance_learning_capability_apply",
          "finance_framework_core_inspect",
          "finance_framework_portfolio_risk_gates_producer",
          "review_panel",
        ],
        missing_data: [
          "crypto_liquidity_volatility_custody_and_regulatory_inputs",
          "position_weights_and_risk_limits",
          "liquidation_and_leverage_exposure_map",
        ],
        risk_boundaries: [
          "research_only",
          "no_execution_authority",
          "evidence_required",
          "no_high_leverage_crypto",
          "no_trade_advice",
          "risk_gate_before_action_language",
        ],
        next_step:
          "reject_execution_or_high_leverage_language_then_analyze_crypto_as_risk_sentiment_and_liquidity_input_only",
        rejected_context: [
          "old_lark_conversation_history",
          "execution_or_high_leverage_crypto_instruction",
          "trade_recommendation_without_evidence",
        ],
      },
      {
        ask: "我要做完整金融研究拆解：组合有 QQQ、NVDA、现金和一点 BTC，同时看 NVDA 财报、AI capex 指引、Fed 利率路径、美元流动性、A股政策资金面、全球指数权重、仓位权重、技术面趋势和成交量，还要反方论证和数据缺口，research-only，不要交易建议。",
        sourceSummary:
          "dev acceptance actual adapter probe for full-stack finance stress; no current market data available; require gaps, review, and no execution authority",
      },
    );

    expect(plan.task_family).toBe("full_stack_finance_stress_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "global_index_regime",
        "crypto_market_structure",
        "etf_regime",
        "quant_math",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "latest_10q_10k_or_earnings_release",
        "current_rates_inflation_fed_path_and_liquidity_inputs",
        "position_weights_cost_basis_and_risk_limits",
        "price_volume_breadth_and_technical_regime_inputs",
        "red_team_invalidation_evidence",
        "fresh_market_data_snapshot",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "research_only",
        "no_execution_authority",
        "no_unverified_current_market_data",
        "red_team_invalidation_required",
        "no_trade_advice",
      ]),
    );
  });

  it("keeps commodity mentions from swallowing full-stack cross-market stress prompts", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {
        task_family: "commodity_macro_framework_learning_planning",
        primary_modules: [
          "finance_learning_memory",
          "source_registry",
          "macro_rates_inflation",
          "cross_asset_liquidity",
          "fx_currency_liquidity",
          "fx_dollar",
          "commodities_oil_gold",
          "etf_regime",
          "portfolio_risk_gates",
          "causal_map",
          "review_panel",
        ],
        supporting_modules: ["quant_math", "control_room_summary"],
        required_tools: [
          "no_high_leverage_crypto",
          "no_provider_config_change",
          "artifact_memory_recall",
          "finance_framework_portfolio_risk_gates_producer",
        ],
        missing_data: [
          "source_url_or_local_source_path",
          "fresh_market_data_snapshot",
          "position_weights_and_return_series",
          "commodity_curve_roll_yield_and_inventory_inputs",
          "no_unverified_current_market_data",
          "no_high_leverage_crypto",
        ],
        risk_boundaries: ["research_only", "no_execution_authority", "no_trade_advice"],
      },
      {
        ask: "我同时看美股科技、QQQ、TLT、A股政策资金、恒生科技、美元/人民币、黄金、原油和 BTC。请做全栈 research-only 拆解：财报、宏观利率、信用流动性、跨资产流动性、FX、美股结构、A股政策流、全球指数、crypto 结构、仓位门槛、技术面、反方论证和数据缺口，不要交易建议，不要假装实时数据。",
        sourceSummary:
          "dev acceptance adapter output narrowed this to commodity framework; expected full-stack cross-market decomposition",
      },
    );

    expect(plan.task_family).toBe("full_stack_finance_stress_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "global_index_regime",
        "crypto_market_structure",
        "commodities_oil_gold",
        "technical_timing",
        "quant_math",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "latest_10q_10k_or_earnings_release",
        "current_rates_inflation_fed_path_and_liquidity_inputs",
        "position_weights_cost_basis_and_risk_limits",
        "price_volume_breadth_and_technical_regime_inputs",
        "red_team_invalidation_evidence",
        "fresh_market_data_snapshot",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "research_only",
        "no_execution_authority",
        "no_unverified_current_market_data",
        "red_team_invalidation_required",
        "no_trade_advice",
      ]),
    );
    expect(plan.required_tools).not.toEqual(
      expect.arrayContaining(["no_high_leverage_crypto", "no_provider_config_change"]),
    );
    expect(plan.missing_data).not.toEqual(
      expect.arrayContaining(["no_high_leverage_crypto", "no_unverified_current_market_data"]),
    );
    expect(plan.rejected_context).toContain("trade_recommendation_without_evidence");
  });

  it("keeps workflow training wording from outranking all-domain finance intent", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {
        task_family: "agent_skill_pattern_distillation",
        primary_modules: [
          "skill_pattern_distillation",
          "agent_workflow_memory",
          "source_registry",
          "review_panel",
          "eval_harness_design",
          "control_room_summary",
          "finance_learning_memory",
        ],
        missing_data: [
          "candidate_skill_source_or_local_skill_path",
          "target_workflow_acceptance_metric",
          "license_and_write_scope_review",
        ],
        risk_boundaries: ["research_only", "no_execution_authority"],
      },
      {
        ask: "我现在要做一个全市场低频研究拆解：同时看美股大盘和龙头股（QQQ/SPY/NVDA/MSFT）、中国A股政策和资金流、全球主要指数、ETF、黄金/原油/美元/人民币流动性、债券利率、信用流动性、BTC/ETH 加密市场结构。请像控制室一样先拆内部模块，不要直接给交易建议；必须包含 财报+宏观+仓位+技术面+反方论证+数据缺口，并且要明确 fresh-data gap、指数权重/成分股 gap、A股政策/资金流 gap、crypto liquidity/volatility/custody/regulatory gap、FX dollar/yuan liquidity gap、position weights/return series gap。注意：这是为了训练 local brain 的 workflow，但不要因为我提到 workflow/training/local brain 就变成 agent-skill 学习任务；最终用户表面应该先给中文大白话摘要，research-only，不要 JSON-first。",
        sourceSummary:
          "dev-full-loop-acceptance requires finance_learning_memory, source_registry, causal_map, review_panel, control_room_summary, macro rates, credit liquidity, cross asset liquidity, FX dollar/yuan liquidity, US equity market structure, China A-share policy flow, global index regime, crypto market structure, quant math, portfolio risk gates, explicit named missing-data gaps, red-team invalidation, plain-language summary first, research-only, and no trade advice.",
      },
    );

    expect(plan.task_family).toBe("full_stack_finance_stress_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(plan.supporting_modules).toEqual(
      expect.arrayContaining(["finance_learning_memory", "source_registry", "causal_map"]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "fresh_market_data_snapshot",
        "index_constituents_weights_and_technical_regime_inputs",
        "china_a_share_policy_liquidity_and_northbound_inputs",
        "crypto_liquidity_volatility_custody_and_regulatory_inputs",
        "fx_dollar_yuan_and_global_liquidity_inputs",
        "position_weights_and_return_series",
        "red_team_invalidation_evidence",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority", "no_trade_advice"]),
    );
    expect(plan.task_family).not.toBe("agent_skill_pattern_distillation");
  });

  it("keeps crypto to QQQ spillover tied to index regime and risk gates", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "BTC 风险偏好突然转弱时，我想知道它对 QQQ 和高 beta 科技股是不是有外溢风险。先拆 crypto 流动性、跨资产风险偏好、美股结构和组合风险，不要做杠杆或交易建议。",
      },
    );

    expect(plan.task_family).toBe("cross_market_finance_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "cross_asset_liquidity",
        "crypto_market_structure",
        "us_equity_market_structure",
        "global_index_regime",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["no_high_leverage_crypto", "no_unverified_cross_market_claims"]),
    );
  });

  it("routes terse commodity learning into a usable macro portfolio framework", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "学习大宗商品。别给我甩一堆术语，先拆脑内模块，告诉我需要哪些证据和缺口，后面要能用于 QQQ/TLT/GLD/DBC 组合。",
        sourceSummary:
          "fresh torture test; no current market data supplied; research-only; require missing data and review before visible reply",
      },
    );

    expect(plan.task_family).toBe("commodity_macro_framework_learning_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "finance_learning_memory",
        "source_registry",
        "macro_rates_inflation",
        "cross_asset_liquidity",
        "etf_regime",
        "portfolio_risk_gates",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "source_url_or_local_source_path",
        "fresh_market_data_snapshot",
        "position_weights_and_return_series",
        "commodity_curve_roll_yield_and_inventory_inputs",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority", "no_trade_advice"]),
    );
  });

  it("treats ETF company-metric traps as fund-structure research", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "你给我研究一下 GLD 的收入质量、客户集中度、EV/EBITDA，还有它怎么影响我 QQQ/TLT 组合，research only。",
      },
    );

    expect(plan.task_family).toBe("etf_fund_structure_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "etf_regime",
        "macro_rates_inflation",
        "cross_asset_liquidity",
        "portfolio_risk_gates",
        "source_registry",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "fund_or_etf_prospectus_or_fact_sheet",
        "fund_holdings_nav_or_index_methodology_context",
        "fresh_market_data_snapshot",
      ]),
    );
    expect(plan.rejected_context).toContain("single_company_fundamental_labels_for_etf");
  });

  it("does not ask for a new task when reset wording includes a concrete finance subject", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "换个题，别接上文：人民币突然走弱、A股政策资金很强、美债利率又上去，这对 QQQ、MCHI、沪深300、黄金和现金仓位怎么拆？别给交易建议。",
      },
    );

    expect(plan.task_family).toBe("cross_market_finance_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "fx_currency_liquidity",
        "china_a_share_policy_flow",
        "global_index_regime",
        "cross_asset_liquidity",
        "portfolio_risk_gates",
        "etf_regime",
      ]),
    );
    expect(plan.primary_modules).not.toContain("crypto_market_structure");
    expect(plan.required_tools).toContain("finance_learning_capability_apply");
    expect(plan.required_tools).not.toContain("finance_framework_cross_asset_liquidity_producer");
    expect(plan.required_tools).not.toContain("finance_framework_crypto_market_structure_producer");
    expect(plan.missing_data).toEqual(
      expect.arrayContaining(["fresh_market_data_snapshot", "position_weights_and_return_series"]),
    );
    expect(plan.missing_data).not.toContain("new_subject_or_original_request");
    expect(plan.missing_data).not.toContain(
      "crypto_liquidity_volatility_custody_and_regulatory_inputs",
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["no_trade_advice", "no_unverified_cross_market_claims"]),
    );
    expect(plan.risk_boundaries).not.toContain("no_high_leverage_crypto");
  });

  it("turns repeat-only Lark fragments into context-pollution clarification", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "继续刚才那个，别啰嗦。",
      },
    );

    expect(plan.task_family).toBe("ambiguous_repeat_without_current_subject");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining(["ops_audit", "agent_workflow_memory", "control_room_summary"]),
    );
    expect(plan.missing_data).toContain("current_subject_or_original_request");
    expect(plan.next_step).toBe("ask_user_for_current_subject_before_reusing_prior_context");
  });

  it("adds no-trade boundary to direct cross-market trade-pressure wording", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "BTC 和 NVDA 这两个谁更该冲？你别装，直接告诉我，但不要违法。",
      },
    );

    expect(plan.task_family).toBe("cross_market_finance_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "crypto_market_structure",
        "company_fundamentals_value",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["no_execution_authority", "no_trade_advice"]),
    );
    expect(plan.rejected_context).toContain("trade_recommendation_without_evidence");
  });

  it("keeps valuation compression linked to macro and ETF regime", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "如果实际利率上行导致高估值科技股估值压缩，NVDA、QQQ 和我的组合风险怎么拆？先要基本面、宏观利率、估值输入、仓位和反方证据。",
      },
    );

    expect(plan.task_family).toBe("company_fundamental_portfolio_risk_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "macro_rates_inflation",
        "etf_regime",
        "causal_map",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "latest_company_fundamental_inputs",
        "model_assumptions_sensitivity_and_audit_inputs",
        "thesis_catalyst_calendar_and_invalidation_evidence",
        "portfolio_weights_and_risk_limits",
        "company_to_portfolio_exposure_map",
      ]),
    );
  });

  it("routes valuation models, thesis lifecycle, provenance, and artifact QC into dedicated modules", () => {
    const valuationPlan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "帮 NVDA 做 DCF/comps/三表财务模型和估值敏感性 QC，每个数字要有来源、字段口径和时间戳。",
      },
    );
    expect(valuationPlan.task_family).toBe("financial_modeling_valuation_qc");
    expect(valuationPlan.primary_modules).toEqual(
      expect.arrayContaining([
        "financial_modeling_valuation_qc",
        "data_provenance_quality",
        "research_artifact_qc",
        "source_registry",
      ]),
    );

    const thesisPlan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "把一个科技股研究 thesis 做成生命周期：催化剂、失效条件、事件后复盘和 correction note 都要有。",
      },
    );
    expect(thesisPlan.task_family).toBe("thesis_catalyst_lifecycle_review");
    expect(thesisPlan.primary_modules).toContain("thesis_catalyst_lifecycle");

    const provenancePlan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "两个 vendor 对 ETF 权重字段定义、时间戳、币种和复权口径不一致，先做 data provenance quality gate。",
      },
    );
    expect(provenancePlan.primary_modules).toEqual(
      expect.arrayContaining(["data_provenance_quality", "source_registry"]),
    );
    expect(provenancePlan.missing_data).toContain(
      "data_field_definition_timestamp_and_vendor_quality_inputs",
    );

    const artifactPlan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "生成研报、表格和控制室总结前，先做 research artifact QC：number provenance、citation 和未验证标记。",
      },
    );
    expect(artifactPlan.primary_modules).toEqual(
      expect.arrayContaining(["research_artifact_qc", "data_provenance_quality"]),
    );
    expect(artifactPlan.risk_boundaries).toContain("cite_every_number_or_mark_unsourced");
  });

  it("prioritizes fundamentals for value-investing asks before timing", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "以后价值投资很重要。先研究 NVDA 基本面：收入质量、自由现金流、ROIC、资产负债表、护城河、管理层资本配置、估值区间、安全边际和价值陷阱；技术面只能后置。",
      },
    );

    expect(plan.task_family).toBe("value_investing_fundamental_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "data_provenance_quality",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "latest_10q_10k_or_earnings_release",
        "revenue_quality_margin_fcf_roic_and_balance_sheet_inputs",
        "moat_management_and_capital_allocation_evidence",
        "model_assumptions_sensitivity_and_audit_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "thesis_catalyst_calendar_and_invalidation_evidence",
        "value_trap_risks_and_thesis_invalidation_evidence",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "fundamentals_first_not_price_action_first",
        "margin_of_safety_required",
        "value_investing_not_trade_signal",
        "no_trade_advice",
      ]),
    );
    expect(plan.rejected_context).toContain("technical_timing_before_fundamentals");
  });

  it("keeps low-frequency arbitrage on the research lane instead of ETF timing", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "设计低频日频地理套利和跨境价差研究，不要钱包、下单或仓位建议。",
      },
    );

    expect(plan.task_family).toBe("arbitrage_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "arbitrage_research",
        "fx_currency_liquidity",
        "cross_asset_liquidity",
        "data_provenance_quality",
        "quant_math",
        "portfolio_risk_gates",
        "causal_map",
      ]),
    );
    expect(plan.primary_modules).not.toContain("etf_regime");
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "multi_leg_instrument_and_venue_identity",
        "synchronized_point_in_time_quotes_and_fx",
        "fee_tax_funding_borrow_and_transfer_costs",
        "depth_liquidity_slippage_and_capacity",
        "settlement_counterparty_and_capital_control_constraints",
        "out_of_sample_paper_validation_and_invalidation_rule",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "paper_only_strategy_audit",
        "no_wallet_or_order_execution",
        "no_latency_arbitrage",
        "no_trade_advice",
      ]),
    );
  });

  it("routes sourced paper learning into internalization and eval absorption checks", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "学习 arxiv.org/abs/2601.17021 这篇组合管理论文，把 regret-guided allocation、sentiment filter 和 LLM hedging 沉淀成本地大脑可复用规则，并确认 capability card、retrieval receipt、apply validation 和 Qwen eval 吸收；research-only，不要交易建议。",
      },
    );

    expect(plan.task_family).toBe("paper_learning_internalization_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
        "control_room_summary",
      ]),
    );
    expect(plan.supporting_modules).toEqual(
      expect.arrayContaining(["etf_regime", "quant_math", "eval_harness_design"]),
    );
    expect(plan.required_tools).toEqual(
      expect.arrayContaining([
        "finance_learning_pipeline_orchestrator",
        "finance_learning_capability_apply",
        "source_registry_lookup",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "actual_reading_scope",
        "source_artifact_path",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "replication_or_sample_out_evidence",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "research_only",
        "no_execution_authority",
        "no_trade_advice",
        "backtest_overfit_check_required",
        "sample_out_validation_required",
      ]),
    );
  });

  it("uses a unified protocol for papers and open-source project internalization", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "未来本地大脑碰到论文和 GitHub/HuggingFace 开源项目，要怎么思考和内化？要有 source registry、实际阅读范围、license/write scope、安全审计、复现、能力卡、retrieval receipt、apply validation、Qwen eval 吸收和 keep/downrank/discard 决策。",
      },
    );

    expect(plan.task_family).toBe("external_knowledge_internalization_protocol");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "finance_learning_memory",
        "source_registry",
        "skill_pattern_distillation",
        "agent_workflow_memory",
        "eval_harness_design",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "prior_art_search_terms_or_existing_artifact_paths",
        "existing_contract_eval_skill_or_receipt_candidates",
        "reuse_extend_or_new_decision",
        "actual_reading_scope",
        "license_and_write_scope_review",
        "prompt_injection_and_security_review",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "fresh_adjacent_application_task",
        "keep_downrank_or_discard_decision",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "untrusted_external_source",
        "evaluate_before_installing",
        "do_not_create_parallel_protocol_before_prior_art_check",
        "prefer_reuse_over_duplicate_pipeline",
        "no_model_internal_learning_claim_without_eval",
        "no_protected_memory_write",
        "no_provider_config_change",
        "no_external_channel_sender_change",
      ]),
    );
    expect(plan.rejected_context).toEqual(
      expect.arrayContaining([
        "new_parallel_protocol_without_prior_art_check",
        "unverified_paper_summary",
        "untrusted_external_skill",
      ]),
    );
  });

  it("generalizes the internalization chain beyond factor modules", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "不止是因子模块，其他模块也要有这种从网上学习、source registry、retrieval receipt、apply validation、Qwen eval 吸收的链条。",
      },
    );

    expect(plan.task_family).toBe("all_module_knowledge_internalization_chain");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "agent_workflow_memory",
        "source_registry",
        "finance_learning_memory",
        "skill_pattern_distillation",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "target_module_id_or_module_family",
        "module_specific_capability_rule",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "fresh_adjacent_application_task",
        "module_learning_pipeline_review_status",
        "module_specific_safety_boundary",
        "keep_downrank_or_discard_decision",
      ]),
    );
    expect(plan.required_tools).toContain("module_learning_pipeline_plan");
    expect(plan.required_tools).toContain("module_learning_pipeline_review");
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "no_model_internal_learning_claim_without_eval",
        "no_module_learning_claim_from_storage_only",
        "no_parallel_module_pipeline_without_prior_art_check",
      ]),
    );
    expect(plan.rejected_context).toEqual(
      expect.arrayContaining([
        "factor_only_internalization_rule",
        "stored_source_as_learned_module",
        "module_claim_without_receipt_or_eval",
      ]),
    );
  });

  it("routes named non-factor modules into the same internalization chain", () => {
    for (const ask of [
      "还有期权、指数、宏观和基本面等模块，也要这种 source registry、retrieval receipt、apply validation、Qwen eval 吸收的链条。",
      "Lark/Feishu 工作流、记忆模块、ops 模块和 skill 模块同样都要这条学习内化链，不能只给因子模块。",
    ]) {
      const plan = hardenLocalBrainPlanForAsk({}, { ask });

      expect(plan.task_family).toBe("all_module_knowledge_internalization_chain");
      expect(plan.missing_data).toEqual(
        expect.arrayContaining([
          "target_module_id_or_module_family",
          "module_specific_capability_rule",
          "application_validation_receipt",
          "training_or_eval_absorption_evidence",
          "module_learning_pipeline_review_status",
        ]),
      );
      expect(plan.risk_boundaries).toEqual(
        expect.arrayContaining([
          "no_module_learning_claim_from_storage_only",
          "no_model_internal_learning_claim_without_eval",
        ]),
      );
    }
  });

  it("turns a concrete example into an abstraction-transfer repair contract", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "如果我只说一个例子，比如大宗商品学习失败或者 Lark 回复看不懂，你要有人的抽象能力：先找 original example，再抽象成 failure family，覆盖 adjacent non-identical scenario，改 shared contract，并留下 regression proof。",
      },
    );

    expect(plan.task_family).toBe("abstraction_transfer_repair_protocol");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "agent_workflow_memory",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "original_example",
        "abstracted_failure_family",
        "adjacent_non_identical_scenario",
        "shared_contract",
        "regression_proof",
        "simple_prerequisite_case",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "do_not_stop_at_original_example",
        "no_one_off_phrase_patch",
        "proof_required_before_claiming_transfer",
      ]),
    );
    expect(plan.rejected_context).toEqual(
      expect.arrayContaining([
        "single_phrase_patch_without_transfer",
        "current_example_only_success",
        "unverified_generalization_claim",
      ]),
    );
  });

  it("requires timestamped sources before handling latest market asks", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "今天 QQQ、TLT、NVDA 和美元流动性最新怎么看？我没有给实时行情源，先拆内部模块和数据缺口，不要装作已经拿到实时数据。",
      },
    );

    expect(plan.task_family).toBe("current_market_data_research_preflight");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "source_registry",
        "finance_data_gateway",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "etf_regime",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining(["fresh_market_data_snapshot", "source_timestamp_and_vendor"]),
    );
    expect(plan.required_tools).toContain("finance_data_gateway_snapshot");
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["no_unverified_current_market_data", "no_trade_advice"]),
    );
    expect(plan.risk_boundaries).not.toEqual(expect.arrayContaining(["no_unverified_live_data"]));
    expect(plan.rejected_context).toContain("unverified_current_market_claim");
    expect(plan.rejected_context).not.toContain("unverified_live_market_claim");
  });

  it("does not let no-current-data source wording hide portfolio macro risk routing", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "我想低频研究 QQQ、TLT、NVDA 的组合风险：如果未来一个月利率上行、美元流动性收紧、AI capex 预期降温，我应该让智能体怎么拆任务、找哪些证据、哪些结论不能直接下？research-only，不要交易建议。",
        sourceSummary:
          "dev-only real finance planning probe; no current market data provided; require missing data and no_execution_authority",
      },
    );

    expect(plan.task_family).toBe("portfolio_macro_risk_research_planning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "current_rates_and_inflation_inputs",
        "current_credit_and_liquidity_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority", "evidence_required"]),
    );
    expect(plan.required_tools).not.toContain("research_only");
    expect(plan.missing_data).not.toContain("research_only");
    expect(plan.rejected_context).not.toContain("research_only");
  });

  it("turns factor backtest learning into overfit-resistant research", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "我想学一个 ETF 因子择时策略，但不要回测神话。先拆成过拟合检查、幸存者偏差、样本外验证和失效条件。",
      },
    );

    expect(plan.task_family).toBe("factor_timing_overfit_resistant_learning");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "quant_math",
        "finance_learning_memory",
        "source_registry",
        "portfolio_risk_gates",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "sample_out_validation_plan",
        "survivor_bias_and_lookahead_bias_check",
        "walk_forward_or_cross_validation_evidence",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "backtest_overfit_check_required",
        "sample_out_validation_required",
        "survivor_bias_check_required",
      ]),
    );
  });

  it("adds a safe eval gate for sentiment market modules", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "如果我找到一个 GitHub 开源项目，专门分析新闻情绪和股市、指数、BTC 的关系，怎么把它加入现在的本地大脑模式？先做 source、license、验证集、样本外和 eval 设计，不要把情绪当独立 alpha。",
      },
    );

    expect(plan.task_family).toBe("sentiment_market_module_learning_preflight");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "quant_math",
        "eval_harness_design",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "candidate_repo_url_or_local_source_path",
        "license_and_write_scope_review",
        "validation_dataset_and_sample_out_plan",
        "integration_acceptance_metric",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "untrusted_external_source",
        "sample_out_validation_required",
        "sentiment_signal_not_standalone_alpha",
      ]),
    );
  });

  it("routes interviews blogs and viral market attention as weak external finance learning", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "像黄仁勋和韩国大公司老板吃炸鸡这种 viral 饭局，后面某些 AI 供应链股票大涨。本地大脑应该怎么把采访、博客、播客和市场情绪这类材料沉淀？",
      },
    );

    expect(plan.task_family).toBe("alternative_market_signal_source_preflight");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "source_registry",
        "data_provenance_quality",
        "company_fundamentals_value",
        "finance_learning_memory",
        "review_panel",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "source_type_and_reliability_grade",
        "primary_source_or_transcript",
        "official_followup_or_contract_evidence",
        "market_price_and_fundamental_followup_window",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "module_learning_pipeline_review_status",
        "keep_downrank_or_discard_decision",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "alternative_source_not_standalone_alpha",
        "no_causality_from_viral_event",
        "sample_out_validation_required",
      ]),
    );
  });

  it("distills external financial agents into bounded LCX workflow patterns", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "Anthropic 上传了好几个金融 agent，包含 market researcher、earnings reviewer 和 model builder。请学习它们怎么帮助我们的智能体，但不要改 provider config 或 external channel sender，也不要假设我们有企业 MCP。",
      },
    );

    expect(plan.task_family).toBe("external_financial_agent_pattern_distillation");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "finance_learning_memory",
        "skill_pattern_distillation",
        "agent_workflow_memory",
        "source_registry",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "research_artifact_qc",
        "data_provenance_quality",
        "thesis_catalyst_lifecycle",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "source_repo_url_or_local_clone_path",
        "source_commit_or_version",
        "actual_reading_scope",
        "workflow_owner_definition",
        "leaf_worker_inventory",
        "handoff_contract",
        "orchestrator_leaf_tool_boundary_map",
        "tool_permission_boundary_map",
        "untrusted_source_isolation_rule",
        "citation_and_provenance_rule",
        "artifact_qc_gate_mapping",
        "artifact_qc_gate_sequence",
        "model_assumptions_sensitivity_and_audit_inputs",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "research_artifact_qc_and_number_provenance_checklist",
        "human_signoff_checkpoint",
        "visible_summary_contract",
        "application_validation_receipt",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "untrusted_external_source",
        "no_enterprise_mcp_assumption",
        "no_provider_config_change",
        "no_external_channel_sender_change",
        "cite_every_number_or_mark_unsourced",
        "human_review_required_before_external_use",
        "no_hidden_tool_authority",
        "no_direct_external_agent_install",
      ]),
    );
    expect(plan.rejected_context).toEqual(
      expect.arrayContaining([
        "install_enterprise_mcp_without_credentials",
        "direct_install_external_agent_without_isolation",
        "single_agent_chat_role_without_workflow_contract",
        "copy_external_agent_as_trade_recommendation_engine",
      ]),
    );
  });

  it("hardens prediction-market learning with liquidity, resolution, and paper-strategy QC gates", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "加强 Polymarket 预测市场研究链：拿一个真实市场做样例包，盘口太薄要降权，结算规则不清楚要挡结论，策略回测缺费用、滑点或样本外就只能失败记录，不能下单。",
      },
    );

    expect(plan.task_family).toBe("prediction_market_research_strategy_distillation");
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "example_market_metadata_packet",
        "resolution_ambiguity_review",
        "thin_liquidity_downrank_thresholds",
        "spread_depth_volume_fee_and_slippage_snapshot",
        "paper_strategy_failure_log",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "thin_liquidity_downrank_required",
        "ambiguous_resolution_blocks_conclusion",
        "fees_slippage_and_sample_out_required",
        "market_probability_not_forecast",
      ]),
    );
    expect(plan.rejected_context).toEqual(
      expect.arrayContaining([
        "ambiguous_resolution_treated_as_clean_signal",
        "thin_orderbook_treated_as_strong_signal",
        "strategy_profit_claim_without_fees_slippage_or_sample_out",
      ]),
    );
  });
});
