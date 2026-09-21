import { describe, expect, it } from "vitest";
import {
  FINANCE_BRAIN_MODULES,
  financeBrainModuleCatalog,
  parseFinanceModuleSelection,
  planFinanceBrainOrchestration,
} from "./finance-brain-orchestration.js";

describe("planFinanceBrainOrchestration", () => {
  it("fans complex holdings research into finance, math, risk, and review modules", () => {
    const plan = planFinanceBrainOrchestration({
      text: "帮我判断 NVDA 和 TLT 组合要不要加仓，结合基本面、利率、ETF、期权波动、信用流动性、技术择时、风险预算和因果证伪，不要交易。",
      hasHoldingsOrPortfolioContext: true,
      hasLocalMathInputs: true,
      highStakesConclusion: true,
    });

    expect(plan.primaryModules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "macro_rates_inflation",
        "etf_regime",
        "options_volatility",
        "credit_liquidity",
        "technical_timing",
        "portfolio_risk_gates",
        "quant_math",
        "causal_map",
      ]),
    );
    expect(plan.supportingModules).toContain("finance_learning_memory");
    expect(plan.requiredTools).toEqual(
      expect.arrayContaining([
        "finance_framework_core_inspect",
        "finance_learning_capability_apply",
        "finance_data_gateway_snapshot",
        "quant_math",
        "review_tier",
        "review_panel",
      ]),
    );
    expect(plan.boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority", "no_model_math_guessing"]),
    );
  });

  it("uses retained learning and timing modules for learned ETF strategy application", () => {
    const plan = planFinanceBrainOrchestration({
      text: "把以前学过的因子择时规则应用到 ETF 轮动，给我一个 research-only 框架。",
    });

    expect(plan.primaryModules).toEqual(
      expect.arrayContaining(["etf_regime", "technical_timing", "causal_map"]),
    );
    expect(plan.supportingModules).toEqual(["finance_learning_memory"]);
    expect(plan.requiredTools).toContain("finance_learning_capability_apply");
    expect(plan.boundaries).toContain("no_execution_authority");
  });

  it("routes K-line learning into technical timing instead of dropping finance orchestration", () => {
    const plan = planFinanceBrainOrchestration({
      text: "学k线图分析技术",
    });

    expect(plan.primaryModules).toEqual(expect.arrayContaining(["technical_timing", "causal_map"]));
    expect(plan.supportingModules).toContain("finance_learning_memory");
    expect(plan.requiredTools).toContain("finance_learning_capability_apply");
    expect(plan.boundaries).toContain("research_only");
  });

  it("makes the relaxed finance mode explicit without removing execution separation", () => {
    const plan = planFinanceBrainOrchestration({
      text: "给出一个带条件的 NVDA 买入候选",
      decisionMode: "conditional_trade_candidate",
      highStakesConclusion: true,
    });

    expect(plan.boundaries).toEqual(
      expect.arrayContaining(["conditional_trade_candidate", "no_execution_authority"]),
    );
    expect(plan.boundaries).not.toContain("no_trade_advice");
  });

  it("routes advanced chart-line learning into technical timing", () => {
    const plan = planFinanceBrainOrchestration({
      text: "学习高级图线分析技术",
    });

    expect(plan.primaryModules).toEqual(expect.arrayContaining(["technical_timing", "causal_map"]));
    expect(plan.supportingModules).toContain("finance_learning_memory");
    expect(plan.requiredTools).toContain("finance_learning_capability_apply");
  });

  it("keeps cross-market modules available at runtime without fake producer tools", () => {
    const plan = planFinanceBrainOrchestration({
      text: "美元流动性和人民币汇率变化时，我想同时看美股、A股、全球指数、BTC、稳定币、QQQ 和高 beta 科技股的跨资产风险偏好外溢，research-only。",
      hasHoldingsOrPortfolioContext: true,
      highStakesConclusion: true,
    });

    expect(plan.primaryModules).toEqual(
      expect.arrayContaining([
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "global_index_regime",
        "crypto_market_structure",
        "portfolio_risk_gates",
        "quant_math",
        "causal_map",
      ]),
    );
    expect(plan.supportingModules).toContain("finance_learning_memory");
    expect(plan.requiredTools).toEqual(
      expect.arrayContaining([
        "finance_framework_core_inspect",
        "finance_framework_fx_dollar_producer",
        "finance_data_gateway_snapshot",
        "finance_learning_capability_apply",
        "review_panel",
      ]),
    );
    expect(plan.requiredTools).not.toContain("finance_framework_crypto_market_structure_producer");
    expect(plan.requiredTools).not.toContain("finance_framework_cross_asset_liquidity_producer");
  });

  it.each([
    "分析未来半年美股和加密货币的市场情绪，考虑美国中期选举的影响。",
    "展望未来六个月美股和比特币的风险偏好，以及美国中期选举和政策变化。",
    "Assess market sentiment for US equities and crypto over the next six months, considering US midterm elections.",
    "Assess risk appetite for U.S. stocks and Bitcoin over a six-month horizon, including US midterms.",
  ])("routes sentiment and election outlooks through existing finance lanes: %s", (text) => {
    const plan = planFinanceBrainOrchestration({ text });

    expect(plan.primaryModules).toEqual(
      expect.arrayContaining([
        "global_index_regime",
        "us_equity_market_structure",
        "crypto_market_structure",
        "cross_asset_liquidity",
        "event_driven",
        "causal_map",
      ]),
    );
    expect(plan.supportingModules).toEqual(["finance_learning_memory"]);
    expect(plan.requiredTools).toEqual(
      expect.arrayContaining([
        "finance_framework_event_driven_producer",
        "finance_framework_causal_map_producer",
        "finance_learning_capability_apply",
        "finance_learning_retrieval_review",
      ]),
    );
    expect(plan.boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority", "evidence_required"]),
    );
  });

  it.each([
    "分析市场情绪。",
    "分析投资者情绪。",
    "Assess market sentiment.",
    "Assess investor sentiment.",
  ])("routes sentiment without requiring an explicit risk-appetite keyword: %s", (text) => {
    const plan = planFinanceBrainOrchestration({ text });

    expect(plan.primaryModules).toContain("cross_asset_liquidity");
  });

  it("does not treat an investment horizon alone as an event catalyst", () => {
    const plan = planFinanceBrainOrchestration({
      text: "展望未来半年美股和加密货币的风险偏好。",
    });

    expect(plan.primaryModules).toContain("cross_asset_liquidity");
    expect(plan.primaryModules).not.toContain("event_driven");
  });

  it.each([
    "帮我整理未来半年的学习计划和情绪日记。",
    "解释美国中期选举的投票流程。",
    "Explain voting procedures for US midterm elections over the next six months.",
    "Summarize sentiment in customer feedback and plan our next six-month marketing campaign.",
  ])("keeps non-finance horizons, sentiment, and elections unselected: %s", (text) => {
    const plan = planFinanceBrainOrchestration({ text });

    expect(plan.selectionTrace.financeTask).toBe(false);
    expect(plan.primaryModules).toEqual([]);
    expect(plan.supportingModules).toEqual([]);
    expect(plan.requiredTools).toEqual(["review_tier"]);
  });

  it("connects Treasury supply and term premium to rates, credit, ETF, math, risk, and review", () => {
    const plan = planFinanceBrainOrchestration({
      text: "美债再融资和财政赤字导致 Treasury supply 上来，term premium 抬升时，TLT、QQQ 和我的组合风险怎么拆？research-only。",
      hasHoldingsOrPortfolioContext: true,
      hasLocalMathInputs: true,
      highStakesConclusion: true,
    });

    expect(plan.primaryModules).toEqual(
      expect.arrayContaining([
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "quant_math",
        "portfolio_risk_gates",
        "causal_map",
      ]),
    );
    expect(plan.requiredTools).toEqual(
      expect.arrayContaining([
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_data_gateway_snapshot",
        "review_panel",
      ]),
    );
  });

  it("routes private-credit and nonbank leverage stress through liquidity and risk gates", () => {
    const plan = planFinanceBrainOrchestration({
      text: "private credit、NBFI、leveraged loans 和半流动基金如果出赎回压力，会不会通过非银杠杆和 forced deleveraging 影响 HYG、QQQ 和风险偏好？",
      hasHoldingsOrPortfolioContext: true,
      highStakesConclusion: true,
    });

    expect(plan.primaryModules).toEqual(
      expect.arrayContaining([
        "credit_liquidity",
        "cross_asset_liquidity",
        "etf_regime",
        "portfolio_risk_gates",
        "quant_math",
        "causal_map",
      ]),
    );
    expect(plan.requiredTools).toEqual(expect.arrayContaining(["finance_data_gateway_snapshot"]));
  });

  it("links AI capex concentration to fundamentals, supply chain, index regime, and portfolio risk", () => {
    const plan = planFinanceBrainOrchestration({
      text: "AI capex、hyperscaler 预算、数据中心电力瓶颈和 HBM 供应链如果变化，会怎么影响 NVDA、QQQ 指数集中度和我的科技仓？",
      hasHoldingsOrPortfolioContext: true,
      highStakesConclusion: true,
    });

    expect(plan.primaryModules).toEqual(
      expect.arrayContaining([
        "company_fundamentals_value",
        "global_index_regime",
        "event_driven",
        "portfolio_risk_gates",
        "quant_math",
        "causal_map",
      ]),
    );
  });

  it("connects oil supply shocks to inflation, FX, cross-asset, ETF, and portfolio risk", () => {
    const plan = planFinanceBrainOrchestration({
      text: "霍尔木兹和 OPEC 供给冲击让 oil inventory 下降、能源通胀上来时，美元、TLT、QQQ、股债相关性可能失效和组合风险怎么连？",
      hasHoldingsOrPortfolioContext: true,
      highStakesConclusion: true,
    });

    expect(plan.primaryModules).toEqual(
      expect.arrayContaining([
        "commodities_oil_gold",
        "macro_rates_inflation",
        "fx_currency_liquidity",
        "cross_asset_liquidity",
        "etf_regime",
        "portfolio_risk_gates",
        "causal_map",
      ]),
    );
  });

  it("keeps ordinary currency requests from fanning into two overlapping FX owners", () => {
    const plan = planFinanceBrainOrchestration({
      text: "美元流动性变化会怎样影响我的组合？",
      hasHoldingsOrPortfolioContext: true,
    });

    expect(plan.primaryModules).toContain("fx_currency_liquidity");
    expect(plan.primaryModules).not.toContain("fx_dollar");
    expect(plan.selectionTrace.suppressedModules).toEqual([
      expect.objectContaining({ id: "fx_dollar" }),
    ]);
    expect(plan.selectionTrace.dataGatewayReason).toBe("holdings_or_portfolio_context");
  });

  it("does not invent a heavy finance plan for non-finance text", () => {
    const plan = planFinanceBrainOrchestration({
      text: "帮我整理一下今天的 marketing meeting 标题和 security risk 待办。",
    });

    expect(plan.primaryModules).toEqual([]);
    expect(plan.supportingModules).toEqual([]);
    expect(plan.requiredTools).toEqual(["review_tier"]);
    expect(plan.reviewTools).toEqual(["review_tier"]);
  });

  it("does not mistake live learning audit identifiers for earnings or IV finance signals", () => {
    const plan = planFinanceBrainOrchestration({
      text: "只复盘 external-live-learning-20260502-2 的结果，不重新学习，必须可见 handoff receipt 和 audit_handoff_ready。",
    });

    expect(plan.primaryModules).toEqual([]);
    expect(plan.supportingModules).toEqual([]);
    expect(plan.requiredTools).toEqual(["review_tier"]);
  });
});

describe("caller module composition within fixed gates", () => {
  it("builds a bounded default DAG instead of an unbounded module chain", () => {
    const plan = planFinanceBrainOrchestration({
      text: "检查持仓风险和期权波动",
      hasHoldingsOrPortfolioContext: true,
      highStakesConclusion: true,
    });
    expect(plan.composition.schemaVersion).toBe("lcx_finance_module_composition_v1");
    expect(plan.composition.nodes.length).toBe(
      plan.primaryModules.length + plan.supportingModules.length,
    );
    expect(plan.composition.maxDepth).toBeLessThanOrEqual(8);
    expect(plan.composition.topologicalOrder).toEqual(
      expect.arrayContaining(["finance_learning_memory", "causal_map", "portfolio_risk_gates"]),
    );
  });

  it("accepts a caller DAG while preserving required modules and rejecting cycles", () => {
    const plan = planFinanceBrainOrchestration({
      text: "研究一个市场假设",
      moduleSelection: {
        moduleIds: ["technical_timing", "credit_liquidity"],
        rationale: "Test price behavior against funding transmission.",
        composition: {
          nodes: [
            { id: "timing", moduleId: "technical_timing", dependsOn: [] },
            { id: "credit", moduleId: "credit_liquidity", dependsOn: ["timing"] },
          ],
          maxReplans: 1,
        },
      },
    });
    expect(plan.composition.maxReplans).toBe(1);
    expect(plan.composition.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(["timing", "credit", "causal_map", "finance_learning_memory"]),
    );
    expect(() =>
      parseFinanceModuleSelection({
        moduleIds: ["technical_timing"],
        rationale: "cycle",
        composition: {
          nodes: [{ id: "timing", moduleId: "technical_timing", dependsOn: ["timing"] }],
        },
      }),
    ).toThrow("composition");
  });

  it("can replace a rule-suggested domain and select a module absent from the keywords", () => {
    const text = "研究宏观利率变化";
    const baseline = planFinanceBrainOrchestration({ text });
    const plan = planFinanceBrainOrchestration({
      text,
      moduleSelection: {
        moduleIds: ["technical_timing", "credit_liquidity"],
        rationale:
          "Use observed price behavior and credit transmission to test the initial hypothesis.",
      },
    });
    expect(baseline.primaryModules).toContain("macro_rates_inflation");
    expect(plan.primaryModules.slice(0, 2)).toEqual(["technical_timing", "credit_liquidity"]);
    expect(plan.primaryModules).not.toContain("macro_rates_inflation");
    expect(plan.primaryModules).toContain("causal_map");
    expect(plan.supportingModules).toEqual(["finance_learning_memory"]);
    expect(plan.selectionTrace).toMatchObject({
      selectionSource: "caller_proposal",
      ruleSuggestedModules: expect.arrayContaining(["macro_rates_inflation"]),
    });
    expect(plan.requiredTools).toContain("finance_framework_credit_liquidity_producer");
  });

  it("retains portfolio, math, source, review and authority boundaries despite a narrower proposal", () => {
    const plan = planFinanceBrainOrchestration({
      text: "现在应该买入还是减仓，计算我的持仓风险",
      decisionMode: "conditional_trade_candidate",
      moduleSelection: { moduleIds: ["technical_timing"], rationale: "Focus the analytical lens." },
    });
    expect(plan.primaryModules).toEqual(
      expect.arrayContaining([
        "technical_timing",
        "portfolio_risk_gates",
        "quant_math",
        "causal_map",
      ]),
    );
    expect(plan.requiredTools).toEqual(
      expect.arrayContaining(["finance_data_gateway_snapshot", "review_panel", "quant_math"]),
    );
    expect(plan.boundaries).toEqual(
      expect.arrayContaining([
        "conditional_trade_candidate",
        "no_execution_authority",
        "evidence_required",
      ]),
    );
    expect(plan.selectionTrace.requiredModules).toEqual(
      expect.arrayContaining(["portfolio_risk_gates", "quant_math"]),
    );
  });

  it("accepts explicit task context without fabricating a keyword match", () => {
    const plan = planFinanceBrainOrchestration({
      text: "再检查一下这个假设",
      moduleSelection: {
        moduleIds: ["credit_liquidity"],
        rationale: "The preceding evidence concerns funding stress.",
      },
    });
    expect(plan.selectionTrace.financeTask).toBe(true);
    expect(plan.selectionTrace.rawMatchedModules).not.toContain("credit_liquidity");
    expect(plan.primaryModules).toContain("credit_liquidity");
  });

  it("derives the model-visible catalog from the existing registry", () => {
    expect(financeBrainModuleCatalog().map((module) => module.id)).toEqual(
      FINANCE_BRAIN_MODULES.map((module) => module.id),
    );
    const catalog = financeBrainModuleCatalog();
    catalog[0].requiredTools.length = 0;
    expect(financeBrainModuleCatalog()[0].requiredTools.length).toBeGreaterThan(0);
  });

  it.each([
    null,
    "credit_liquidity",
    {},
    { moduleIds: [], rationale: "empty" },
    { moduleIds: ["not_registered"], rationale: "unknown" },
    { moduleIds: ["credit_liquidity", "credit_liquidity"], rationale: "duplicate" },
    { moduleIds: ["credit_liquidity"], rationale: " " },
    { moduleIds: ["credit_liquidity"], rationale: "x".repeat(2001) },
    { moduleIds: ["credit_liquidity"], rationale: "override", skipRisk: true },
  ])("rejects malformed or authority-changing proposals", (value) => {
    expect(() => parseFinanceModuleSelection(value)).toThrow("moduleSelection");
  });

  it("copies and freezes a validated caller proposal", () => {
    const raw = { moduleIds: ["credit_liquidity"], rationale: "  bounded selection  " };
    const proposal = parseFinanceModuleSelection(raw);
    raw.moduleIds[0] = "event_driven";
    expect(proposal).toEqual({ moduleIds: ["credit_liquidity"], rationale: "bounded selection" });
    expect(Object.isFrozen(proposal?.moduleIds)).toBe(true);
  });
});
