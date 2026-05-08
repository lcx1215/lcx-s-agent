import { describe, expect, it } from "vitest";
import { hardenLocalBrainPlanForAsk } from "../scripts/dev/local-brain-contracts.js";

describe("hardenLocalBrainPlanForAsk", () => {
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
        "no_unverified_live_data",
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
        "no_unverified_live_data",
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
          "dev acceptance actual adapter probe for full-stack finance stress; no live data available; require gaps, review, and no execution authority",
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
        "no_unverified_live_data",
        "red_team_invalidation_required",
        "no_trade_advice",
      ]),
    );
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
          "fresh torture test; no live market data supplied; research-only; require missing data and review before visible reply",
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
        "macro_rates_inflation",
        "etf_regime",
        "causal_map",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "latest_company_fundamental_inputs",
        "portfolio_weights_and_risk_limits",
        "company_to_portfolio_exposure_map",
      ]),
    );
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
        "valuation_range_and_margin_of_safety_inputs",
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
        "no_live_sender_change",
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

    expect(plan.task_family).toBe("unverified_live_market_data_research_preflight");
    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "source_registry",
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
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining(["no_unverified_live_data", "no_trade_advice"]),
    );
  });

  it("does not let no-live-data source wording hide portfolio macro risk routing", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "我想低频研究 QQQ、TLT、NVDA 的组合风险：如果未来一个月利率上行、美元流动性收紧、AI capex 预期降温，我应该让智能体怎么拆任务、找哪些证据、哪些结论不能直接下？research-only，不要交易建议。",
        sourceSummary:
          "dev-only real finance planning probe; no live market data provided; require missing data and no_execution_authority",
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

  it("distills external financial agents into bounded LCX workflow patterns", () => {
    const plan = hardenLocalBrainPlanForAsk(
      {},
      {
        ask: "Anthropic 上传了好几个金融 agent，包含 market researcher、earnings reviewer 和 model builder。请学习它们怎么帮助我们的智能体，但不要改 provider config 或 live sender，也不要假设我们有企业 MCP。",
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
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "source_repo_url_or_local_clone_path",
        "source_commit_or_version",
        "actual_reading_scope",
        "orchestrator_leaf_tool_boundary_map",
        "untrusted_source_isolation_rule",
        "artifact_qc_gate_mapping",
        "application_validation_receipt",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "untrusted_external_source",
        "no_enterprise_mcp_assumption",
        "no_provider_config_change",
        "no_live_sender_change",
        "cite_every_number_or_mark_unsourced",
        "human_review_required_before_external_use",
      ]),
    );
    expect(plan.rejected_context).toEqual(
      expect.arrayContaining([
        "install_enterprise_mcp_without_credentials",
        "copy_external_agent_as_trade_recommendation_engine",
      ]),
    );
  });
});
