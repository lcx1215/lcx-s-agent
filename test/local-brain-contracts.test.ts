import { describe, expect, it } from "vitest";
import { hardenLocalBrainPlanForAsk } from "../scripts/dev/local-brain-contracts.js";

describe("hardenLocalBrainPlanForAsk", () => {
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
          "finance_framework_crypto_market_structure_producer",
          "finance_framework_cross_asset_liquidity_producer",
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
});
