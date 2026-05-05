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
      expect.arrayContaining(["fresh_market_data_snapshot", "cross_asset_liquidity_inputs"]),
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
});
