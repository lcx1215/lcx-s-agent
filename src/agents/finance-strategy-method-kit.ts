import {
  buildFinanceStrategyCatalogPrompt,
  FINANCE_STRATEGY_METHOD_CATALOG,
  FINANCE_STRATEGY_METHOD_CONTRACTS,
  FINANCE_STRATEGY_METHODS,
  STRATEGY_METHOD_IDS,
  type StrategyMethodId,
} from "./finance-strategy-method-catalog.js";

/**
 * Compact, executable form of the trader-strategy-lab material.
 *
 * This is a research contract for model prompts and review gates. It is not a
 * trading signal, a broker instruction, or a claim about any manager's private
 * process.
 */

export const FINANCE_STRATEGY_METHOD_KIT_SCHEMA_VERSION =
  "lcx_finance_strategy_method_kit_v2" as const;

export type FinanceStrategyMethodKit = Readonly<{
  schemaVersion: typeof FINANCE_STRATEGY_METHOD_KIT_SCHEMA_VERSION;
  selectedModules: readonly StrategyMethodId[];
  taskScope: "research" | "backtest";
  rules: Readonly<Partial<Record<StrategyMethodId, readonly string[]>>>;
  requiredOutputChecks: readonly string[];
  catalog: typeof FINANCE_STRATEGY_METHOD_CATALOG;
  prompt: string;
}>;

const M01_RULES = Object.freeze([
  "Freeze the question, universe, horizon and information cutoff; freeze baseline and costs when testing a strategy.",
  "Use point-in-time evidence and report source timestamps; do not fill missing values with a convenient proxy.",
  "When testing a strategy, separate train/validation/out-of-sample windows and record failed or neutral trials; do not select parameters after seeing the full result.",
  "Treat a local receipt or a plausible explanation as method evidence, not as proof of alpha or model learning.",
  "Track platform, data, model/token, commission, spread/slippage and financing costs separately; without a complete realized net-cost ledger, do not claim operating-cost or living-expense coverage.",
] as const);

const M02_RULES = Object.freeze([
  "For a transparent trend diagnostic, use the prior completed close versus a fixed 200-session moving average; apply the decision on the next session.",
  "Keep same-universe buy-and-hold as the core baseline; compare any lower-turnover trend overlay against buy-and-hold and cash with the same entry, exit, and turnover costs.",
  "Report CAGR, volatility, maximum drawdown, turnover, worst daily loss, and results by at least three non-overlapping periods.",
  "Stress cost and parameter ranges; a result that survives only one asset, period, or optimistic cost stays research-only.",
] as const);

const M12_RULES = Object.freeze([
  "Check common factor exposure and breadth before treating several assets as independent diversification.",
  "Use a simple risk gate when breadth weakens; explain the trade-off between drawdown reduction and missed rebound rather than calling it a hedge.",
  "Surface concentration, liquidity, financing, borrow, gap, and exit-day limits even when the test is long-only and unlevered.",
] as const);

const REQUIRED_OUTPUT_CHECKS = Object.freeze([
  "source facts versus research inference",
  "current data timestamp and coverage",
  "thesis and counter-thesis",
  "catalyst or observable follow-up",
  "invalidation and stop conditions",
  "net-cost result versus a simple baseline",
  "uncertainties, missing evidence, and research-only boundary",
] as const);

const METHOD_MATCHERS: readonly Readonly<{
  method: StrategyMethodId;
  pattern: RegExp;
}>[] = Object.freeze([
  { method: "M02", pattern: /趋势|均线|动量|突破|trend|moving average|momentum/iu },
  {
    method: "M03",
    pattern:
      /宏观|增长|通胀|通货膨胀|利率|收益率曲线|汇率|外汇|macro|inflation|yield|fx|currency/iu,
  },
  {
    method: "M04",
    pattern: /复制|产品筛选|跟踪误差|基金暴露|replicat|tracking error|fund exposure/iu,
  },
  {
    method: "M05",
    pattern:
      /股票多空|相对价值|质量|价值|基本面|财报|分析师|多头|空头|equity long|fundamental|relative value/iu,
  },
  {
    method: "M06",
    pattern:
      /短期反向|短期反转|反向|流动性冲击|盘口|订单流|短线|reversal|order flow|liquidity shock/iu,
  },
  {
    method: "M07",
    pattern: /封闭式基金|折价|NAV|净值折价|催化剂|回购|要约|清算|closed-end|discount|catalyst/iu,
  },
  {
    method: "M08",
    pattern: /信用|可转债|资本结构|回收率|违约|credit|convertible|capital structure|recovery/iu,
  },
  {
    method: "M09",
    pattern:
      /指数事件|指数调入|调入调出|成分|ETF|交易所基金|公司行动|指数|index event|rebalance|corporate action/iu,
  },
  {
    method: "M10",
    pattern: /尾部|保险预算|尾部保护|期权|期权保护|保护成本|tail risk|insurance|put hedge/iu,
  },
  {
    method: "M11",
    pattern: /波动率|隐含波动|波动率曲面|Greeks|希腊值|动态对冲|volatility|implied vol|surface/iu,
  },
  {
    method: "M12",
    pattern:
      /暴露|敞口|广度|分散|组合|风险|回撤|拥挤|融资|保证金|流动性|exposure|breadth|diversif|portfolio|risk|drawdown|crowding|financing/iu,
  },
]);

const BASE_RULES: Partial<Record<StrategyMethodId, readonly string[]>> = Object.freeze({
  M01: M01_RULES,
  M02: M02_RULES,
  M12: M12_RULES,
});

export function selectFinanceStrategyMethodIds(ask: string): readonly StrategyMethodId[] {
  const backtest = /回测|策略测试|策略检验|backtest|strategy test/iu.test(ask);
  const selected = new Set<StrategyMethodId>(["M01"]);
  if (backtest) {
    selected.add("M02");
    selected.add("M12");
  }
  for (const matcher of METHOD_MATCHERS) {
    if (matcher.pattern.test(ask)) {
      selected.add(matcher.method);
    }
  }
  return Object.freeze(STRATEGY_METHOD_IDS.filter((method) => selected.has(method)));
}

function buildMethodRules(method: StrategyMethodId): readonly string[] {
  const contract = FINANCE_STRATEGY_METHOD_CONTRACTS[method];
  return Object.freeze([
    ...(BASE_RULES[method] ?? []),
    `Mechanism: ${contract.mechanism}`,
    `Inputs: ${contract.inputs.join("; ")}`,
    `Workflow: ${contract.workflow.join("; ")}`,
    `Trigger: ${contract.trigger}`,
    `Invalidation: ${contract.invalidation.join("; ")}`,
    `Minimum evidence: ${contract.minimumEvidence.join("; ")}`,
  ]);
}

export function buildFinanceStrategyMethodKit(ask: string): FinanceStrategyMethodKit {
  const backtest = /回测|策略测试|策略检验|backtest|strategy test/iu.test(ask);
  const selectedModules = selectFinanceStrategyMethodIds(ask);
  const checks = backtest
    ? REQUIRED_OUTPUT_CHECKS
    : REQUIRED_OUTPUT_CHECKS.filter(
        (check) => check !== "net-cost result versus a simple baseline",
      );
  const rules = Object.freeze(
    Object.fromEntries(selectedModules.map((method) => [method, buildMethodRules(method)])),
  ) as Partial<Record<StrategyMethodId, readonly string[]>>;
  const prompt = [
    "Apply the executable trader-strategy method kit below as a review discipline, not as a promise of returns.",
    buildFinanceStrategyCatalogPrompt(),
    "Foreground method contracts for this task:",
    ...selectedModules.flatMap((method) => [
      `${method} ${FINANCE_STRATEGY_METHODS.find((item) => item.id === method)?.name ?? method}:`,
      ...(rules[method] ?? []).map((rule) => `- ${rule}`),
    ]),
    "Apply strategy metrics, cost tests and validation windows only when actually testing a strategy. Missing optional analyses must not block a factual answer.",
    "For analytical conclusions, use the applicable checks below; factual extraction does not require inventing a thesis, catalyst or forecast:",
    ...checks.map((check) => `- ${check}`),
    "Keep executionAuthority=none and do not turn a backtest or candidate into an order.",
  ].join("\n");
  return Object.freeze({
    schemaVersion: FINANCE_STRATEGY_METHOD_KIT_SCHEMA_VERSION,
    selectedModules,
    taskScope: backtest ? "backtest" : "research",
    rules,
    requiredOutputChecks: Object.freeze(checks),
    catalog: FINANCE_STRATEGY_METHOD_CATALOG,
    prompt,
  });
}
