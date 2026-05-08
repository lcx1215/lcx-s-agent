import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  buildTeacherSystemPrompt,
  extractJson,
  extractMiniMaxTeacherTextFromResponse,
  hardenTeacherPlanForPrompt,
  isProviderPayloadMissingFailure,
  normalizeTeacherPlan,
} from "../scripts/dev/minimax-brain-teacher-batch.js";

describe("minimax brain teacher batch parsing", () => {
  it("asks MiniMax for compact machine-parseable teacher JSON", () => {
    const prompt = buildPrompt({
      id: "compact_json_contract",
      userMessage: "学习大宗商品，但不要输出给用户，先给本地大脑做任务拆解。",
      sourceSummary: "short commodity learning request.",
    });

    expect(prompt).toContain("compact machine-parseable JSON only");
    expect(prompt).toContain("no markdown fences");
    expect(prompt).toContain("no trailing commas");
    expect(prompt).toContain("never copy the full user prompt into JSON values");
    expect(prompt).toContain("prefer 3-8 items per array");
  });

  it("keeps MiniMax direct API instructions in system prompt form", () => {
    const systemPrompt = buildTeacherSystemPrompt();

    expect(systemPrompt).toContain("Return one strict JSON object and no prose");
    expect(systemPrompt).toContain("Required JSON keys");
    expect(systemPrompt).not.toContain("user_message:");
    expect(systemPrompt).not.toContain("source_summary:");
  });

  it("uses JSON-bearing MiniMax thinking content when text content is missing", () => {
    const response = JSON.stringify({
      content: [
        {
          type: "thinking",
          thinking: JSON.stringify({
            task_family: "cross_market_finance_research_planning",
            primary_modules: ["macro_rates_inflation"],
            supporting_modules: ["review_panel"],
            required_tools: ["review_panel"],
            missing_data: ["fresh_market_data_snapshot"],
            risk_boundaries: ["research_only"],
            next_step: "review_then_summarize",
            rejected_context: ["old_lark_conversation_history"],
          }),
        },
      ],
    });

    const text = extractMiniMaxTeacherTextFromResponse(response);
    expect(extractJson(text).task_family).toBe("cross_market_finance_research_planning");
  });

  it("uses OpenAI-shaped response content when MiniMax returns choices", () => {
    const response = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              task_family: "openai_shaped_teacher_response",
              primary_modules: ["finance_learning_memory"],
              supporting_modules: ["review_panel"],
              required_tools: ["review_panel"],
              missing_data: ["fresh_market_data_snapshot"],
              risk_boundaries: ["research_only"],
              next_step: "review_then_summarize",
              rejected_context: ["old_lark_conversation_history"],
            }),
          },
        },
      ],
    });

    const text = extractMiniMaxTeacherTextFromResponse(response);
    expect(extractJson(text).task_family).toBe("openai_shaped_teacher_response");
  });

  it("treats missing MiniMax text content as provider payload instability", () => {
    expect(
      isProviderPayloadMissingFailure({
        error: "Error: MiniMax teacher response missing text content: thinking-only payload",
      }),
    ).toBe(true);
    expect(
      isProviderPayloadMissingFailure({
        error: "Error: OpenClaw agent output missing payload text: {}",
      }),
    ).toBe(true);
    expect(
      isProviderPayloadMissingFailure({
        error: "SyntaxError: Expected ',' or ']' after array element in JSON",
      }),
    ).toBe(false);
  });

  it("extracts the first balanced JSON object from fenced or noisy output", () => {
    const plan = extractJson(`
      extra prose
      \`\`\`json
      {
        "task_family": "portfolio_risk",
        "primary_modules": ["portfolio_risk_gates", "unknown_module",],
        "supporting_modules": ["review_panel"],
        "required_tools": ["review_panel"],
        "missing_data": [],
        "risk_boundaries": ["evidence_required"],
        "next_step": "review",
        "rejected_context": ["old_lark_conversation_history"]
      }
      \`\`\`
      extra trailing prose
    `);

    const normalized = normalizeTeacherPlan(plan);
    expect(normalized.primary_modules).toEqual(["portfolio_risk_gates"]);
    expect(normalized.risk_boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority", "evidence_required"]),
    );
  });

  it("repairs missing commas in otherwise valid teacher JSON", () => {
    const plan = extractJson(`{
      "task_family": "missing_comma_repair"
      "primary_modules": [
        "macro_rates_inflation"
        "portfolio_risk_gates"
      ],
      "supporting_modules": ["review_panel"],
      "required_tools": ["review_panel"],
      "missing_data": ["fresh_market_data_snapshot"],
      "risk_boundaries": ["research_only"],
      "next_step": "review",
      "rejected_context": ["old_lark_conversation_history"]
    }`);

    expect(plan.task_family).toBe("missing_comma_repair");
    expect(plan.primary_modules).toEqual(["macro_rates_inflation", "portfolio_risk_gates"]);
  });

  it("repairs MiniMax placeholder arrays before teacher-plan hardening", () => {
    const plan = normalizeTeacherPlan(
      extractJson(`{
        "task_family": "cross_market",
        "primary_modules": [...],
        "supporting_modules": ["review_panel"],
        "required_tools": [...],
        "missing_data": [],
        "risk_boundaries": ["research_only"],
        "next_step": "review",
        "rejected_context": ["old_lark_conversation_history"]
      }`),
    );

    expect(plan.primary_modules).toEqual([]);
    expect(plan.required_tools).toEqual([]);
    expect(plan.supporting_modules).toEqual(["review_panel"]);
  });

  it("keeps ambiguous context-reset teacher samples out of broad finance fanout", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "quota_context_reset_guard_00000",
        userMessage:
          "重新来一遍，但这次别串到旧的 volatility risk premium 任务；如果我没说清楚，就先问我要当前对象。",
        sourceSummary:
          "ambiguous repeat requiring current subject instead of old Lark context reuse.",
      },
      normalizeTeacherPlan({
        task_family: "research_planning",
        primary_modules: [
          "macro_rates_inflation",
          "credit_liquidity",
          "cross_asset_liquidity",
          "fx_currency_liquidity",
          "etf_regime",
          "global_index_regime",
          "us_equity_market_structure",
          "china_a_share_policy_flow",
          "crypto_market_structure",
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
        ],
        supporting_modules: [],
        required_tools: [],
        missing_data: [],
        risk_boundaries: ["research_only"],
        next_step: "decompose finance task",
        rejected_context: [],
      }),
    );

    expect(plan.primary_modules).toEqual([
      "ops_audit",
      "agent_workflow_memory",
      "control_room_summary",
    ]);
    expect(plan.missing_data).toContain("current_subject_or_original_request");
    expect(plan.rejected_context).toContain("old_lark_conversation_history");
    expect(plan.risk_boundaries).toContain("ops_audit_must_not_become_finance_analysis");
  });

  it("adds missing quant and cross-market data gaps to accepted teacher plans", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "quota_cross_market_us_a_index_crypto_00000",
        userMessage:
          "未来我要同时看 SPY、IEF、MSFT，覆盖美股、A股、指数和加密币。训练本地大脑做连贯分析：先调本地记忆和已学规则，再拆宏观利率、美元/人民币流动性、市场结构、指数权重、加密币流动性、量化验证和风险门；research-only，不要交易建议。",
        sourceSummary: "cross-market finance planning.",
      },
      normalizeTeacherPlan({
        task_family: "cross_market",
        primary_modules: [],
        supporting_modules: [],
        required_tools: [],
        missing_data: [],
        risk_boundaries: [],
        next_step: "review",
        rejected_context: [],
      }),
    );

    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "global_index_regime",
        "crypto_market_structure",
        "fx_currency_liquidity",
        "cross_asset_liquidity",
        "portfolio_risk_gates",
      ]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "fresh_market_data_snapshot",
        "cross_asset_liquidity_inputs",
        "position_weights_and_return_series",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "research_only",
        "no_execution_authority",
        "no_high_leverage_crypto",
        "no_unverified_cross_market_claims",
      ]),
    );
  });

  it("adds exact position and return series gap for split quant input labels", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "quota_missing_quant_inputs_00000",
        userMessage:
          "我有 QQQ、TLT、NVDA 三个仓位，想算波动、相关性、回撤，但只提了权重和价格序列，先拆模块不要胡算。",
        sourceSummary: "quant math planning with missing weights and return series.",
      },
      normalizeTeacherPlan({
        task_family: "portfolio_math",
        primary_modules: ["quant_math"],
        supporting_modules: [],
        required_tools: ["review_panel"],
        missing_data: ["position_weights", "return_series_or_price_history"],
        risk_boundaries: ["research_only"],
        next_step: "review",
        rejected_context: [],
      }),
    );

    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "position_weights_and_return_series",
        "position_weights",
        "return_series_or_price_history",
      ]),
    );
    expect(plan.risk_boundaries).toContain("no_model_fabricated_portfolio_math");
  });

  it("turns all-domain finance prompts into broad research loops", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "all_domain_finance_research_loop",
        userMessage:
          "训练本地 Qwen 教本地大脑做全领域金融研究：美股、A股、指数、ETF、公司基本面、宏观利率、信用、美元/人民币流动性、大宗商品、期权波动率、加密币、情绪、事件风险、技术择时、量化验证、组合风险、source registry 和 review panel 都要连起来；research-only。",
        sourceSummary: "all-domain finance research loop.",
      },
      normalizeTeacherPlan({
        task_family: "finance",
        primary_modules: [],
        supporting_modules: [],
        required_tools: [],
        missing_data: [],
        risk_boundaries: [],
        next_step: "review",
        rejected_context: [],
      }),
    );

    expect(plan.primary_modules).toEqual(
      expect.arrayContaining([
        "macro_rates_inflation",
        "credit_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "global_index_regime",
        "etf_regime",
        "company_fundamentals_value",
        "commodities_oil_gold",
        "options_volatility",
        "crypto_market_structure",
        "quant_math",
        "portfolio_risk_gates",
      ]),
    );
    const modules = [...plan.primary_modules, ...plan.supporting_modules, ...plan.required_tools];
    expect(modules).toEqual(
      expect.arrayContaining(["finance_learning_memory", "source_registry", "review_panel"]),
    );
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "memory_recall_scope_or_relevant_receipts",
        "revenue_quality_margin_fcf_roic_and_balance_sheet_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "value_trap_risks_and_thesis_invalidation_evidence",
        "commodity_curve_roll_yield_and_inventory_inputs",
        "options_iv_skew_gamma_and_event_calendar",
        "position_weights_and_return_series",
      ]),
    );
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "no_model_math_guessing",
        "no_unverified_cross_market_claims",
        "no_high_leverage_crypto",
        "sentiment_signal_not_standalone_alpha",
        "no_trade_advice",
      ]),
    );
    expect(plan.rejected_context).toContain("simple_prerequisite_skipped");
  });

  it("keeps value-investing prompts fundamentals-first", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "value_investing_fundamental_core",
        userMessage:
          "以后价值投资很重要。训练本地大脑先做企业基本面和内在价值判断：收入质量、自由现金流、ROIC、资产负债表、护城河、管理层资本配置、估值区间、安全边际、价值陷阱、反方证据和组合风险都要拆清楚；技术面只能后置。",
        sourceSummary: "fundamentals-first value-investing loop.",
      },
      normalizeTeacherPlan({
        task_family: "finance",
        primary_modules: [],
        supporting_modules: [],
        required_tools: [],
        missing_data: [],
        risk_boundaries: [],
        next_step: "review",
        rejected_context: [],
      }),
    );

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

  it("rewrites live market data collection overclaims in teacher next steps", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "quota_portfolio_regime_risk_00000",
        userMessage:
          "未来一个月担心利率、美元流动性、ETH 和美股风险偏好，先拆研究模块，不要给交易建议。",
        sourceSummary: "live-style macro and liquidity request with no supplied data.",
      },
      normalizeTeacherPlan({
        task_family: "portfolio_regime",
        primary_modules: ["macro_rates_inflation", "portfolio_risk_gates"],
        supporting_modules: ["review_panel"],
        required_tools: ["review_panel"],
        missing_data: ["fresh_market_data_snapshot"],
        risk_boundaries: ["research_only"],
        next_step:
          "Pull latest Fed rate expectations, USD liquidity indicators, ETF flow data, and ETH market structure metrics, then summarize without buy/sell recommendations.",
        rejected_context: [],
      }),
    );

    expect(plan.next_step).not.toMatch(/pull latest|ETF flow data|ETH market structure metrics/i);
    expect(plan.next_step).toContain("list missing source and data gaps");
    expect(plan.rejected_context).toContain("unsupported_data_fetch_or_memory_write_instruction");
  });

  it("canonicalizes risk boundaries and drops overclaimed external tools", () => {
    const plan = normalizeTeacherPlan({
      task_family: "portfolio_regime",
      primary_modules: ["portfolio_risk_gates"],
      supporting_modules: ["review_panel"],
      required_tools: ["Bloomberg Terminal data feed", "pandas", "source_registry", "review_panel"],
      missing_data: [],
      risk_boundaries: [
        "Research only; no execution authority",
        "No high-leverage crypto positions",
        "No live market claims",
      ],
      next_step: "review",
      rejected_context: [],
    });

    expect(plan.required_tools).toEqual(["source_registry", "review_panel"]);
    expect(plan.risk_boundaries).toEqual(
      expect.arrayContaining([
        "research_only",
        "no_execution_authority",
        "no_high_leverage_crypto",
        "no_unverified_live_market_data_claims",
      ]),
    );
  });

  it("converts ETF-as-company bad samples into fund-structure research plans", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "quota_single_company_transmission_00000",
        userMessage:
          "研究 GLD 的基本面风险：收入质量、估值、客户集中度和宏观传导，只输出 research-only 风险图。",
        sourceSummary:
          "single company fundamentals with portfolio transmission, no trade recommendation.",
      },
      normalizeTeacherPlan({
        task_family: "fundamental_risk_research",
        primary_modules: ["company_fundamentals_value"],
        supporting_modules: ["review_panel"],
        required_tools: ["SEC EDGAR API", "Bloomberg data feed", "financial_statement_parser"],
        missing_data: [],
        risk_boundaries: ["research_only"],
        next_step:
          "Parse revenue streams, compute NAV and EV/EBITDA, and extract client concentration.",
        rejected_context: [],
      }),
    );

    expect(plan.primary_modules).toEqual([
      "etf_regime",
      "macro_rates_inflation",
      "fx_currency_liquidity",
      "cross_asset_liquidity",
      "portfolio_risk_gates",
      "source_registry",
      "review_panel",
      "control_room_summary",
    ]);
    expect(plan.required_tools).toEqual(["source_registry", "review_panel"]);
    expect(plan.missing_data).toEqual(
      expect.arrayContaining([
        "fund_or_etf_prospectus_or_fact_sheet",
        "fresh_market_data_snapshot",
        "current_position_weights",
      ]),
    );
    expect(plan.rejected_context).toContain("single_company_fundamental_labels_for_etf");
    expect(plan.next_step).toContain("do not infer company revenue quality");
  });

  it("sanitizes accepted source-gated plans that overclaim search and durable writes", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "quota_source_gated_learning_00022",
        userMessage:
          "去学习一篇关于 FX dollar yuan liquidity transmission 的高质量金融论文，沉淀成可复用规则，但我没有给 URL 或本地文件。",
        sourceSummary: "finance learning intake without safe local source path or URL.",
      },
      normalizeTeacherPlan({
        task_family: "paper_learning",
        primary_modules: ["finance_learning_memory", "source_registry", "review_panel"],
        supporting_modules: [],
        required_tools: ["internet_search_engine", "source_registry", "review_panel"],
        missing_data: [],
        risk_boundaries: ["research_only"],
        next_step:
          "Invoke internet_search_engine to find papers, update finance_learning_memory, update source_registry, and store in agent_workflow_memory.",
        rejected_context: [],
      }),
    );

    expect(plan.required_tools).toEqual(["source_registry", "review_panel"]);
    expect(plan.missing_data).toEqual(
      expect.arrayContaining(["source_url_or_local_source_path", "actual_reading_scope_receipt"]),
    );
    expect(plan.rejected_context).toContain("unsupported_data_fetch_or_memory_write_instruction");
    expect(plan.next_step).not.toMatch(
      /internet_search_engine|update finance_learning_memory|store in agent_workflow_memory/i,
    );
    expect(plan.next_step).toContain("require a source URL or local source path");
  });

  it("keeps paper and open-source internalization evidence-gated", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "external_knowledge_internalization_protocol",
        userMessage:
          "未来本地大脑碰到论文和 GitHub/HuggingFace 开源项目，要怎么思考和内化？要有 source registry、实际阅读范围、license/write scope、安全审计、复现、能力卡、retrieval receipt、apply validation、Qwen eval 吸收和 keep/downrank/discard 决策。",
        sourceSummary: "unified paper and open-source project internalization protocol.",
      },
      normalizeTeacherPlan({
        task_family: "external_learning",
        primary_modules: [],
        supporting_modules: [],
        required_tools: [],
        missing_data: [],
        risk_boundaries: [],
        next_step: "learn it",
        rejected_context: [],
      }),
    );

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
        "replication_or_sample_out_evidence",
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
      expect.arrayContaining(["unverified_paper_summary", "untrusted_external_skill"]),
    );
  });

  it("hardens abstraction-transfer samples beyond the original example", () => {
    const plan = hardenTeacherPlanForPrompt(
      {
        id: "abstraction_transfer_repair_protocol",
        userMessage:
          "训练本地大脑具备人类抽象能力：我给一个例子，比如 Lark 回复看不懂、大宗商品学习失败、论文内化没证据，不能只修这一句。必须抽象成问题族，并留下 original example、abstracted failure family、adjacent non-identical scenario、shared contract、regression proof。",
        sourceSummary: "abstraction-transfer repair protocol.",
      },
      normalizeTeacherPlan({
        task_family: "example_patch",
        primary_modules: [],
        supporting_modules: [],
        required_tools: [],
        missing_data: [],
        risk_boundaries: [],
        next_step: "fix this phrase",
        rejected_context: [],
      }),
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
});
