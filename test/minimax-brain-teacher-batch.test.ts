import { describe, expect, it } from "vitest";
import {
  extractJson,
  extractMiniMaxTeacherTextFromResponse,
  hardenTeacherPlanForPrompt,
  normalizeTeacherPlan,
} from "../scripts/dev/minimax-brain-teacher-batch.js";

describe("minimax brain teacher batch parsing", () => {
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
});
