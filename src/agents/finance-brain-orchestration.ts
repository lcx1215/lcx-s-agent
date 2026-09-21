import type { LcxOntologyModuleId } from "../shared/lcx-ontology.js";
import type { FinanceDecisionMode } from "./finance-decision-policy.js";

export type FinanceBrainModuleId = LcxOntologyModuleId;

type FinanceBrainModuleDefinition = {
  id: FinanceBrainModuleId;
  role: string;
  requiredTools: string[];
  triggerPatterns: RegExp[];
};

export type FinanceModuleSelection = Readonly<{
  moduleIds: readonly FinanceBrainModuleId[];
  rationale: string;
}>;

export type FinanceBrainOrchestrationInput = {
  text: string;
  hasHoldingsOrPortfolioContext?: boolean;
  hasLocalMathInputs?: boolean;
  highStakesConclusion?: boolean;
  writesDurableMemory?: boolean;
  decisionMode?: FinanceDecisionMode;
  moduleSelection?: FinanceModuleSelection;
};

export type FinanceBrainOrchestrationPlan = {
  primaryModules: FinanceBrainModuleId[];
  supportingModules: FinanceBrainModuleId[];
  moduleContracts: Array<Pick<FinanceBrainModuleDefinition, "id" | "role" | "requiredTools">>;
  selectionTrace: {
    financeTask: boolean;
    selectionSource: "rules" | "caller_proposal";
    ruleSuggestedModules: FinanceBrainModuleId[];
    requiredModules: FinanceBrainModuleId[];
    proposal?: FinanceModuleSelection;
    rawMatchedModules: FinanceBrainModuleId[];
    suppressedModules: Array<{ id: FinanceBrainModuleId; reason: string }>;
    focus: "none" | "focused" | "broad";
    dataGatewayReason: string;
  };
  requiredTools: string[];
  reviewTools: string[];
  handoffOrder: string[];
  boundaries: string[];
};

export const FINANCE_BRAIN_MODULES = [
  {
    id: "macro_rates_inflation",
    role: "Read regime pressure from rates, inflation, central-bank path, Treasury supply, term premium, duration, and real-yield evidence.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_macro_rates_inflation_producer",
    ],
    triggerPatterns: [
      /\b(?:macro|rates?|interest|inflation|fed|fomc|cpi|ppi|real yield|yield curve|duration|treasury supply|issuance|refunding|term premium|fiscal deficit)\b/u,
      /宏观|利率|通胀|美联储|央行|收益率曲线|久期|国债供给|美债供给|发债|再融资|期限溢价|财政赤字/u,
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
    id: "cross_asset_liquidity",
    role: "Connect liquidity, hedging breakdown, forced deleveraging, and risk appetite across equities, rates, FX, commodities, and crypto without treating one market as a standalone signal.",
    requiredTools: ["finance_framework_core_inspect", "finance_learning_capability_apply"],
    triggerPatterns: [
      /\b(?:cross[- ]asset|risk appetite|market sentiment|investor sentiment|liquidity transmission|spillover|correlation regime|global liquidity|equity[- ]bond correlation|simultaneous selloff|forced deleveraging)\b/u,
      /跨资产|风险偏好|市场情绪|投资者情绪|流动性传导|外溢|相关性 regime|全球流动性|股债同跌|股债相关性|相关性失效|被迫去杠杆/u,
    ],
  },
  {
    id: "fx_currency_liquidity",
    role: "Track USD, CNY, DXY, currency funding, and FX liquidity as cross-market transmission inputs.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_fx_dollar_producer",
      "finance_learning_capability_apply",
    ],
    triggerPatterns: [
      /\b(?:usd|dxy|cny|cnh|fx|currency|dollar liquidity|yuan|yen carry)\b/u,
      /美元|人民币|汇率|外汇|美元流动性|离岸人民币|套息/u,
    ],
  },
  {
    id: "global_index_regime",
    role: "Read index concentration, AI/mega-cap crowding, breadth, constituents, weights, and major-index regime context.",
    requiredTools: ["finance_framework_core_inspect", "finance_learning_capability_apply"],
    triggerPatterns: [
      /\b(?:index concentration|ai concentration|mag7|mega[- ]cap|breadth|nasdaq|s&p|spx|u\.?s\.? (?:equities|stocks)|global index|constituents?|weights?)\b/u,
      /股市|股票市场|权益市场|美股|大盘|全球指数|指数集中度|AI集中度|权重|成分股|市场宽度|纳指|标普|巨头|宽度|MSCI/u,
    ],
  },
  {
    id: "us_equity_market_structure",
    role: "Separate US equity market structure, sector leadership, breadth, positioning, and risk appetite from single-company fundamentals.",
    requiredTools: ["finance_framework_core_inspect", "finance_learning_capability_apply"],
    triggerPatterns: [
      /\b(?:u\.?s\.? (?:equities|stocks)|nasdaq|s&p|spx|qqq|spy|iwm|sector leadership|market breadth)\b/u,
      /美股|纳斯达克|标普|罗素|行业领导|市场宽度|高 beta 科技/u,
    ],
  },
  {
    id: "china_a_share_policy_flow",
    role: "Handle China A-share policy, liquidity, northbound flow, RMB pressure, and policy-market transmission.",
    requiredTools: ["finance_framework_core_inspect", "finance_learning_capability_apply"],
    triggerPatterns: [
      /\b(?:a[- ]shares?|china policy|northbound|csi300|shanghai composite|rmb assets?)\b/u,
      /A股|a股|沪深|上证|深证|北向|政策资金|人民币资产|中国权益/u,
    ],
  },
  {
    id: "crypto_market_structure",
    role: "Treat BTC, ETH, stablecoins, exchange reserves, custody, and crypto liquidity as research-only market-structure inputs.",
    requiredTools: ["finance_framework_core_inspect", "finance_learning_capability_apply"],
    triggerPatterns: [
      /\b(?:crypto|bitcoin|btc|ethereum|eth|stablecoin|usdt|exchange reserves?|on[- ]chain)\b/u,
      /加密|比特币|BTC|以太坊|ETH|稳定币|链上|交易所储备/u,
    ],
  },
  {
    id: "company_fundamentals_value",
    role: "Inspect business quality, earnings, cash flow, balance sheet, valuation, moat, capex conversion, power/supply-chain constraints, and thesis durability.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_company_fundamentals_value_producer",
    ],
    triggerPatterns: [
      /\b(?:fundamentals?|earnings?|revenue|margin|cash flow|valuation|moat|balance sheet|guidance|capex|hyperscaler|data center|power grid|electricity demand|hbm|nvda|aapl|msft|tsla)\b/u,
      /基本面|财报|收入|利润率|现金流|估值|护城河|资产负债|业绩|资本开支|云厂商|数据中心|电力|电网|HBM|供应链/u,
    ],
  },
  {
    id: "technical_timing",
    role: "Translate trend, momentum, levels, invalidation, and timing discipline into non-execution timing context.",
    requiredTools: ["finance_learning_capability_apply"],
    triggerPatterns: [
      /\b(?:technical|timing|trend|momentum|moving average|rsi|breakout|entry|exit|support|resistance)\b/u,
      /技术|技术分析|图表分析|K线|k线|图线|蜡烛图|择时|趋势|动量|均线|突破|入场|出场|支撑|阻力/u,
    ],
  },
  {
    id: "portfolio_risk_gates",
    role: "Check sizing language, exposure, drawdown, leverage, concentration, correlation, risk budget, forced-deleveraging, and survival gates.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_portfolio_risk_gates_producer",
    ],
    triggerPatterns: [
      /\b(?:portfolio|holdings?|position|sizing|exposure|drawdown|risk budget|correlation|rebalance|leverage|margin|redemption|forced deleveraging|add|reduce|buy|sell)\b/u,
      /组合|持仓|仓位|加仓|减仓|买|卖|风险预算|回撤|相关性|再平衡|杠杆|保证金|赎回|被迫去杠杆/u,
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
    role: "Check credit spreads, funding stress, nonbank/private-credit leverage, market liquidity, HY/IG pressure, and liquidity transmission.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_credit_liquidity_producer",
    ],
    triggerPatterns: [
      /\b(?:credit|spread|liquidity|funding|hy|ig|stress|debt|bank lending|private credit|nonbank|nbfi|leveraged loan|semiliquid|basis trade|hedge fund)\b/u,
      /信用|利差|流动性|融资|债务|压力|私募信用|非银|杠杆贷款|半流动|基差交易|对冲基金/u,
    ],
  },
  {
    id: "commodities_oil_gold",
    role: "Connect oil, gold, commodities, inventory, supply shocks, inflation hedge, energy, and terms-of-trade evidence.",
    requiredTools: [
      "finance_framework_core_inspect",
      "finance_framework_commodities_oil_gold_producer",
    ],
    triggerPatterns: [
      /\b(?:commodity|commodities|oil|gold|energy|copper|inventory|supply shock|strait of hormuz|opec|spr|inflation hedge)\b/u,
      /商品|原油|黄金|能源|铜|库存|供给冲击|霍尔木兹|OPEC|战略储备/u,
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
      /\b(?:event|catalyst|earnings|guidance|budget revision|policy|meeting|geopolitical|headline|shock|elections?|midterms?)\b/u,
      /事件|催化|财报日|指引|预算|预算变化|政策|会议|地缘|突发|选举/u,
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

/** Descriptions come from the existing module registry, never a second catalog. */
export function financeBrainModuleCatalog() {
  return FINANCE_BRAIN_MODULES.map(({ id, role, requiredTools }) => ({
    id,
    role,
    requiredTools: [...requiredTools],
  }));
}

/** Runtime validation also covers direct callers that bypass the agent tool schema. */
export function parseFinanceModuleSelection(value: unknown): FinanceModuleSelection | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("moduleSelection must contain moduleIds and rationale");
  }
  const proposal = value as Record<string, unknown>;
  if (Object.keys(proposal).some((key) => key !== "moduleIds" && key !== "rationale")) {
    throw new Error("moduleSelection cannot override gates or execution authority");
  }
  if (
    !Array.isArray(proposal.moduleIds) ||
    proposal.moduleIds.length === 0 ||
    proposal.moduleIds.length > FINANCE_BRAIN_MODULES.length ||
    typeof proposal.rationale !== "string" ||
    !proposal.rationale.trim() ||
    proposal.rationale.length > 2000
  ) {
    throw new Error(
      "moduleSelection requires a bounded nonempty moduleIds list and rationale (max 2000 characters)",
    );
  }
  const moduleIds = Array.from(proposal.moduleIds, (id: unknown) => {
    const definition = FINANCE_BRAIN_MODULES.find((module) => module.id === id);
    if (!definition) {
      throw new Error("moduleSelection contains an unknown finance module");
    }
    return definition.id;
  });
  if (new Set(moduleIds).size !== moduleIds.length) {
    throw new Error("moduleSelection contains duplicate moduleIds");
  }
  return Object.freeze({
    moduleIds: Object.freeze(moduleIds),
    rationale: proposal.rationale.trim(),
  });
}

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
  // `shares?` and `holdings?` were missing, so "how many shares do I own" was not a finance task at
  // all and therefore never reached the data-gateway condition below, which is gated on financeTask.
  return /\b(finance|market|stock|shares?|holdings?|equity|etf|portfolio|macro|earnings|valuation|quant|trading|investing|investment|candlestick)\b|金融|市场|股市|股票|美股|A股|a股|指数|基金|组合|持仓|宏观|财报|估值|量化|投资|K线|k线|图线|蜡烛图/u.test(
    text,
  );
}

/**
 * Whether a live gateway snapshot is required before any number may be shown.
 *
 * The English side used to be a bare word list (price|quote|now|...), which silently missed the
 * ordinary ways an English ask requests a current number: "what is AAPL trading at", "how much is
 * Bitcoin worth", "what is my account balance", "how many shares do I own". The Chinese side never
 * missed those, so the same question was routed through the data gateway in Chinese and adopted
 * with no data requirement at all in English. The added patterns are phrase-level rather than bare
 * words on purpose: a bare `worth` also matches "is this worth it" and a bare `balance` also
 * matches "balance the risks", and over-triggering would demand a snapshot for asks that have no
 * number in them.
 */
function needsFinanceDataGateway(text: string): boolean {
  return /\b(?:current|latest|today|now|price|quote|market data|fresh|timestamp|vendor|as of|holdings?|position|portfolio|earnings?|financials?|options?|iv|index weights?|constituents?)\b|\b(?:trades?|trading) at\b|\bhow much\b[^.?]*\bworth\b|\b(?:account|my) balance\b|\bshares?\b[^.?]*\bown\b|\b(?:share|stock|market) (?:price|value)\b|\bnet worth\b|当前|最新|今天|现在|价格|行情|报价|市场数据|实时|时间戳|供应商|截至|持仓|仓位|财报|财务数据|期权|隐含波动率|指数权重|成分股/u.test(
    text,
  );
}

function arbitrateFinanceModules(text: string, rawMatched: FinanceBrainModuleId[]) {
  const suppressedModules: Array<{ id: FinanceBrainModuleId; reason: string }> = [];
  const broadTaxonomyRequest = rawMatched.length >= 15;
  const selected = [...rawMatched];
  // fx_currency_liquidity owns the common cross-market currency lane. Keep
  // the legacy fx_dollar module only for an explicitly broad taxonomy request;
  // otherwise one user phrase must not route the same evidence to two owners.
  if (
    !broadTaxonomyRequest &&
    selected.includes("fx_currency_liquidity") &&
    selected.includes("fx_dollar")
  ) {
    const index = selected.indexOf("fx_dollar");
    selected.splice(index, 1);
    suppressedModules.push({
      id: "fx_dollar",
      reason: "covered_by_fx_currency_liquidity_for_non_broad_request",
    });
  }
  return {
    selected,
    suppressedModules,
    focus: broadTaxonomyRequest
      ? ("broad" as const)
      : selected.length > 0
        ? ("focused" as const)
        : ("none" as const),
  };
}

export function planFinanceBrainOrchestration(
  input: FinanceBrainOrchestrationInput,
): FinanceBrainOrchestrationPlan {
  const moduleSelection = parseFinanceModuleSelection(input.moduleSelection);
  const text = normalize(input.text);
  const rawMatched = FINANCE_BRAIN_MODULES.filter((module) => moduleMatches(module, text)).map(
    (module) => module.id,
  );
  const financeTask =
    moduleSelection !== undefined ||
    hasFinanceTaskSignal(text) ||
    rawMatched.some(
      (id) =>
        !["event_driven", "causal_map", "technical_timing", "finance_learning_memory"].includes(id),
    );
  const arbitration = financeTask
    ? arbitrateFinanceModules(text, rawMatched)
    : { selected: [], suppressedModules: [], focus: "none" as const };
  const matched = financeTask ? arbitration.selected : [];
  // Domain lenses are replaceable. Required evidence/risk/math lanes survive a
  // caller proposal; choosing a module never grants permission to execute its tools.
  const requiredModules: FinanceBrainModuleId[] = financeTask ? ["causal_map"] : [];
  const selected = moduleSelection?.moduleIds ?? matched;
  if (
    input.hasHoldingsOrPortfolioContext ||
    matched.includes("portfolio_risk_gates") ||
    selected.includes("portfolio_risk_gates")
  ) {
    requiredModules.push("portfolio_risk_gates");
  }
  if (
    input.hasLocalMathInputs ||
    matched.includes("quant_math") ||
    requiredModules.includes("portfolio_risk_gates")
  ) {
    requiredModules.push("quant_math");
  }
  if (financeTask) {
    requiredModules.push("finance_learning_memory");
  }
  const seeded = unique<FinanceBrainModuleId>([...selected, ...requiredModules]);

  const primaryModules = seeded.filter((id) => id !== "finance_learning_memory");
  const supportingModules = seeded.filter((id) => id === "finance_learning_memory");
  const moduleById = new Map<FinanceBrainModuleId, FinanceBrainModuleDefinition>();
  for (const module of FINANCE_BRAIN_MODULES) {
    moduleById.set(module.id, module);
  }
  const moduleTools: string[] = seeded.flatMap((id) => moduleById.get(id)?.requiredTools ?? []);
  const dataGatewayTools =
    financeTask &&
    (needsFinanceDataGateway(text) ||
      input.hasHoldingsOrPortfolioContext === true ||
      input.highStakesConclusion === true)
      ? ["finance_data_gateway_snapshot"]
      : [];
  const dataGatewayReason = !financeTask
    ? "not_a_finance_task"
    : dataGatewayTools.length > 0
      ? input.hasHoldingsOrPortfolioContext === true
        ? "holdings_or_portfolio_context"
        : input.highStakesConclusion === true
          ? "high_stakes_conclusion"
          : "fresh_or_vendor_number_signal"
      : "no_fresh_number_or_portfolio_signal";
  const requiredTools = unique([...moduleTools, ...dataGatewayTools, "review_tier"]);
  const needsPanel =
    input.highStakesConclusion ||
    input.writesDurableMemory ||
    primaryModules.includes("portfolio_risk_gates") ||
    primaryModules.includes("quant_math");
  const reviewTools = needsPanel ? ["review_tier", "review_panel"] : ["review_tier"];
  const decisionMode = input.decisionMode ?? "research_only";
  const boundaries = [
    decisionMode,
    "no_execution_authority",
    "evidence_required",
    "no_model_math_guessing",
    "risk_gate_before_action_language",
    ...(decisionMode === "research_only" ? ["no_trade_advice"] : []),
  ];

  return {
    primaryModules,
    supportingModules,
    moduleContracts: seeded.flatMap((id) => {
      const module = moduleById.get(id);
      return module ? [{ id, role: module.role, requiredTools: [...module.requiredTools] }] : [];
    }),
    selectionTrace: {
      financeTask,
      selectionSource: moduleSelection ? "caller_proposal" : "rules",
      ruleSuggestedModules: unique([...matched, ...requiredModules]),
      requiredModules,
      ...(moduleSelection ? { proposal: moduleSelection } : {}),
      rawMatchedModules: rawMatched,
      suppressedModules: moduleSelection
        ? unique([...matched, ...arbitration.suppressedModules.map(({ id }) => id)])
            .filter((id) => !seeded.includes(id))
            .map((id) => ({ id, reason: "not_selected_by_caller_proposal" }))
        : arbitration.suppressedModules,
      focus: moduleSelection ? (seeded.length >= 15 ? "broad" : "focused") : arbitration.focus,
      dataGatewayReason,
    },
    requiredTools: unique([...requiredTools, ...reviewTools]),
    reviewTools,
    handoffOrder: [
      "language_intake",
      "finance_learning_memory",
      "finance_data_gateway_snapshot_when_fresh_or_vendor_numbers_are_needed",
      "finance_framework_core_inspect",
      "domain_modules",
      "quant_math_when_needed",
      "portfolio_risk_gates",
      "causal_map_red_team",
      "review_tier_or_panel",
      "control_room_summary",
    ],
    boundaries,
  };
}
