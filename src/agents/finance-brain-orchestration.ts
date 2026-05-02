import type { FinanceFrameworkCoreDomain } from "../hooks/bundled/lobster-brain-registry.js";

export type FinanceBrainModuleId =
  | FinanceFrameworkCoreDomain
  | "technical_timing"
  | "quant_math"
  | "finance_learning_memory";

type FinanceBrainModuleDefinition = {
  id: FinanceBrainModuleId;
  role: string;
  requiredTools: string[];
  triggerPatterns: RegExp[];
};

export type FinanceBrainOrchestrationInput = {
  text: string;
  hasHoldingsOrPortfolioContext?: boolean;
  hasLocalMathInputs?: boolean;
  highStakesConclusion?: boolean;
  writesDurableMemory?: boolean;
};

export type FinanceBrainOrchestrationPlan = {
  primaryModules: FinanceBrainModuleId[];
  supportingModules: FinanceBrainModuleId[];
  requiredTools: string[];
  reviewTools: string[];
  handoffOrder: string[];
  boundaries: string[];
};

export const FINANCE_BRAIN_MODULES = [
  {
    id: "macro_rates_inflation",
    role: "Read regime pressure from rates, inflation, central-bank path, duration, and real-yield evidence.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_macro_rates_inflation_producer",
    ],
    triggerPatterns: [
      /\b(?:macro|rates?|interest|inflation|fed|fomc|cpi|ppi|real yield|yield curve|duration)\b/u,
      /宏观|利率|通胀|美联储|央行|收益率曲线|久期/u,
    ],
  },
  {
    id: "etf_regime",
    role: "Map ETF, sector, index, breadth, flow, and rotation signals into a low-frequency regime view.",
    requiredTools: ["finance_framework_core_inspect", "finance_framework_etf_regime_producer"],
    triggerPatterns: [
      /\b(?:etf|index|sector|breadth|flow|rotation|spy|qqq|tlt|iwm)\b/u,
      /指数|板块|轮动|宽基|行业/u,
    ],
  },
  {
    id: "company_fundamentals_value",
    role: "Inspect business quality, earnings, cash flow, balance sheet, valuation, moat, and thesis durability.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_company_fundamentals_value_producer",
    ],
    triggerPatterns: [
      /\b(?:fundamentals?|earnings?|revenue|margin|cash flow|valuation|moat|balance sheet|guidance|nvda|aapl|msft|tsla)\b/u,
      /基本面|财报|收入|利润率|现金流|估值|护城河|资产负债|业绩/u,
    ],
  },
  {
    id: "technical_timing",
    role: "Translate trend, momentum, levels, invalidation, and timing discipline into non-execution timing context.",
    requiredTools: ["finance_learning_capability_apply"],
    triggerPatterns: [
      /\b(?:technical|timing|trend|momentum|moving average|rsi|breakout|entry|exit|support|resistance)\b/u,
      /技术|择时|趋势|动量|均线|突破|入场|出场|支撑|阻力/u,
    ],
  },
  {
    id: "portfolio_risk_gates",
    role: "Check sizing language, exposure, drawdown, concentration, correlation, risk budget, and survival gates.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_portfolio_risk_gates_producer",
    ],
    triggerPatterns: [
      /\b(?:portfolio|holdings?|position|sizing|exposure|drawdown|risk budget|correlation|rebalance|add|reduce|buy|sell)\b/u,
      /组合|持仓|仓位|加仓|减仓|买|卖|风险预算|回撤|相关性|再平衡/u,
    ],
  },
  {
    id: "quant_math",
    role: "Do deterministic calculations locally for beta, volatility, covariance, drawdown, ratio, duration, and risk contribution.",
    requiredTools: ["quant_math"],
    triggerPatterns: [
      /\b(?:math|calculate|beta|volatility|covariance|regression|sharpe|sortino|calmar|var|black-scholes|risk contribution)\b/u,
      /数学|计算|波动率|协方差|回归|夏普|回撤|风险贡献|久期/u,
    ],
  },
  {
    id: "options_volatility",
    role: "Read options, implied volatility, skew, gamma, vega, and event-volatility context.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_options_volatility_producer",
    ],
    triggerPatterns: [
      /\b(?:options?|iv|implied vol|skew|gamma|vega|volatility)\b/u,
      /期权|隐含波动率|偏斜|伽马|vega|波动/u,
    ],
  },
  {
    id: "credit_liquidity",
    role: "Check credit spreads, funding stress, market liquidity, HY/IG pressure, and liquidity transmission.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_credit_liquidity_producer",
    ],
    triggerPatterns: [
      /\b(?:credit|spread|liquidity|funding|hy|ig|stress|debt|bank lending)\b/u,
      /信用|利差|流动性|融资|债务|压力/u,
    ],
  },
  {
    id: "commodities_oil_gold",
    role: "Connect oil, gold, commodities, inflation hedge, energy, and terms-of-trade evidence.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_commodities_oil_gold_producer",
    ],
    triggerPatterns: [
      /\b(?:commodity|commodities|oil|gold|energy|copper|inflation hedge)\b/u,
      /商品|原油|黄金|能源|铜/u,
    ],
  },
  {
    id: "fx_dollar",
    role: "Connect dollar, FX, DXY, currency translation, liquidity, and cross-border pressure.",
    requiredTools: ["finance_framework_core_inspect", "finance_framework_fx_dollar_producer"],
    triggerPatterns: [
      /\b(?:fx|foreign exchange|currency|dollar|dxy|usd|yen|euro)\b/u,
      /外汇|美元|汇率|日元|欧元/u,
    ],
  },
  {
    id: "event_driven",
    role: "Handle catalysts, earnings windows, policy events, geopolitical shocks, and event follow-up timing.",
    requiredTools: ["finance_framework_core_inspect", "finance_framework_event_driven_producer"],
    triggerPatterns: [
      /\b(?:event|catalyst|earnings|policy|meeting|geopolitical|headline|shock)\b/u,
      /事件|催化|财报日|政策|会议|地缘|突发/u,
    ],
  },
  {
    id: "causal_map",
    role: "Force causal chain, alternative explanation, falsifier, and red-team invalidation before conclusion.",
    requiredTools: ["finance_framework_core_inspect", "finance_framework_causal_map_producer"],
    triggerPatterns: [
      /\b(?:why|cause|causal|mechanism|transmission|scenario|invalidate|red[- ]?team)\b/u,
      /为什么|因果|机制|传导|情景|证伪|反驳/u,
    ],
  },
  {
    id: "finance_learning_memory",
    role: "Retrieve retained finance capability cards, lessons, correction notes, and reusable rules before drafting.",
    requiredTools: ["finance_learning_capability_apply", "finance_learning_retrieval_review"],
    triggerPatterns: [
      /\b(?:learn|lesson|capability|memory|previous|reuse|strategy|framework)\b|\bapply\b.*\brule\b/u,
      /学习|以前|记忆|规则|能力|复用|策略|框架/u,
    ],
  },
] as const satisfies readonly FinanceBrainModuleDefinition[];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function moduleMatches(module: FinanceBrainModuleDefinition, text: string): boolean {
  return module.triggerPatterns.some((pattern) => pattern.test(text));
}

function hasFinanceTaskSignal(text: string): boolean {
  return /\b(finance|market|stock|equity|etf|portfolio|macro|earnings|valuation|quant|trading|investing|investment)\b|金融|市场|股票|基金|组合|持仓|宏观|财报|估值|量化|投资/u.test(
    text,
  );
}

export function planFinanceBrainOrchestration(
  input: FinanceBrainOrchestrationInput,
): FinanceBrainOrchestrationPlan {
  const text = normalize(input.text);
  const rawMatched = FINANCE_BRAIN_MODULES.filter((module) => moduleMatches(module, text)).map(
    (module) => module.id,
  );
  const financeTask =
    hasFinanceTaskSignal(text) ||
    rawMatched.some(
      (id) =>
        !["event_driven", "causal_map", "technical_timing", "finance_learning_memory"].includes(id),
    );
  const matched = financeTask ? rawMatched : [];
  const seeded = financeTask ? unique<FinanceBrainModuleId>([...matched, "causal_map"]) : matched;

  if (input.hasHoldingsOrPortfolioContext && !seeded.includes("portfolio_risk_gates")) {
    seeded.push("portfolio_risk_gates");
  }
  if (
    (input.hasLocalMathInputs || seeded.includes("portfolio_risk_gates")) &&
    !seeded.includes("quant_math")
  ) {
    seeded.push("quant_math");
  }
  if (financeTask && !seeded.includes("finance_learning_memory")) {
    seeded.push("finance_learning_memory");
  }

  const primaryModules = seeded.filter((id) => id !== "finance_learning_memory");
  const supportingModules = seeded.filter((id) => id === "finance_learning_memory");
  const moduleById = new Map(FINANCE_BRAIN_MODULES.map((module) => [module.id, module]));
  const moduleTools: string[] = seeded.flatMap((id) => moduleById.get(id)?.requiredTools ?? []);
  const requiredTools = unique([...moduleTools, "review_tier"]);
  const needsPanel =
    input.highStakesConclusion ||
    input.writesDurableMemory ||
    primaryModules.includes("portfolio_risk_gates") ||
    primaryModules.includes("quant_math");
  const reviewTools = needsPanel ? ["review_tier", "review_panel"] : ["review_tier"];

  return {
    primaryModules,
    supportingModules,
    requiredTools: unique([...requiredTools, ...reviewTools]),
    reviewTools,
    handoffOrder: [
      "language_intake",
      "finance_learning_memory",
      "finance_framework_core_inspect",
      "domain_modules",
      "quant_math_when_needed",
      "portfolio_risk_gates",
      "causal_map_red_team",
      "review_tier_or_panel",
      "control_room_summary",
    ],
    boundaries: [
      "research_only",
      "no_execution_authority",
      "evidence_required",
      "no_model_math_guessing",
      "risk_gate_before_action_language",
    ],
  };
}
