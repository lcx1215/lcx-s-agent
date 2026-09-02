import { describe, expect, it } from "vitest";
import { planFinanceBrainOrchestration } from "./finance-brain-orchestration.js";

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
