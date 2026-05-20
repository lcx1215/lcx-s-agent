import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TeacherPrompt = {
  id: string;
  userMessage: string;
  sourceSummary: string;
};

type FailureCaseRecipe = {
  caseId: string;
  priority: number;
  userMessage: string;
  sourceSummary: string;
};

type FailureEvalSnapshot = {
  at: string;
  adapterPath: string;
  failedCaseIds: string[];
  parseRecoveredCaseIds: string[];
  passed: number;
  total: number;
  passRate: number;
};

export type FailureCurriculumOptions = {
  guardLogPath?: string;
  maxPrompts: number;
  startIndex?: number;
};

const HOME = process.env.HOME ?? os.homedir();
const DEFAULT_GUARD_LOG = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "logs",
  "minimax-brain-training-guard-medium.jsonl",
);

const FAILURE_CASE_RECIPES: FailureCaseRecipe[] = [
  {
    caseId: "core_options_event_boundary",
    priority: 101,
    userMessage:
      "训练本地大脑修复期权事件风险 eval 的输出稳定性：财报、IV、skew、gamma、ETF/仓位风险只能生成紧凑 planning JSON；必须包含 source_registry、options_volatility、event_driven、company_fundamentals_value、quant_math、portfolio_risk_gates、review_panel、options_iv_skew_gamma_and_event_calendar、latest_filing_or_event_source、position_weights_and_return_series、no_options_trade_advice 和 risk_gate_before_action_language；不要 markdown、不要解释、不要拖尾文本，JSON 必须闭合。",
    sourceSummary:
      "parse-recovered repair for options event-boundary eval family; trains compact valid JSON output plus required data gaps and no-options-trade boundary.",
  },
  {
    caseId: "core_thesis_catalyst_lifecycle",
    priority: 101,
    userMessage:
      "训练本地大脑修复 thesis/catalyst 生命周期 eval 的输出稳定性：只输出紧凑 planning JSON，覆盖 original_thesis_source_and_date、catalyst_calendar_and_event_outcome、invalidation_evidence_and_red_team_case、post_event_review_and_correction_note_scope、thesis_catalyst_lifecycle、company_fundamentals_value、causal_map、portfolio_risk_gates、finance_learning_memory、review_panel、red_team_invalidation_required 和 no_trade_advice；不要把新闻热度当结论，不要输出说明文字，JSON 必须闭合。",
    sourceSummary:
      "parse-recovered repair for thesis catalyst lifecycle eval family; trains compact valid JSON output plus lifecycle evidence gaps and red-team boundary.",
  },
  {
    caseId: "research_artifact_qc_expansion",
    priority: 100,
    userMessage:
      "训练本地大脑修复 research artifact QC eval 的输出稳定性：只输出紧凑 planning JSON，覆盖 research_artifact_qc、data_provenance_quality、source_registry、review_panel、control_room_summary、research_artifact_qc_and_number_provenance_checklist、source_timestamp_and_vendor、citation_and_provenance_rule、cite_every_number_or_mark_unsourced 和 human_review_required_before_external_use；不要 markdown、不要引用格式长解释、不要拖尾文本，JSON 必须闭合。",
    sourceSummary:
      "parse-recovered repair for research artifact QC eval family; trains compact valid JSON output plus number provenance and human-review boundary.",
  },
  {
    caseId: "short_lark_commodity_learning_intake",
    priority: 120,
    userMessage:
      "用户只说“学习大宗商品”。训练本地大脑先把短请求扩成通用学习回路：确认对象范围，调本地记忆，拆原油、黄金、工业金属、农产品、美元、通胀、库存、期限结构、ETF/期货工具和风险门；最后只给人类可读总结，不甩 JSON。",
    sourceSummary:
      "targeted repair for short commodity learning intake; simple prompt must route into general commodity curriculum instead of shallow prose.",
  },
  {
    caseId: "commodity_fx_inflation_inventory_portfolio_loop",
    priority: 118,
    userMessage:
      "训练本地大脑分析大宗商品时必须连贯覆盖美元、实际利率、通胀预期、库存/库销比、期货曲线、roll yield、供需冲击、地缘事件、相关 ETF/股票传导、组合风险和反方论证；缺数据就列缺口，不给交易建议。",
    sourceSummary:
      "targeted repair for commodity FX inflation inventory portfolio loop with evidence gaps and research-only boundary.",
  },
  {
    caseId: "human_brain_finance_decomposition",
    priority: 116,
    userMessage:
      "训练本地大脑像人类金融分析师拆复杂任务：先理解目标和时间尺度，再调本地记忆和已学规则，再拆宏观、流动性、基本面、市场结构、技术 timing、量化数学、风险门、数据缺口和 review panel，最后输出中文控制室总结。",
    sourceSummary:
      "targeted repair for human-like finance decomposition with memory activation, causal layers, missing data, review, and readable summary.",
  },
  {
    caseId: "local_memory_knowledge_activation",
    priority: 114,
    userMessage:
      "训练本地大脑遇到金融问题时先激活本地永久记忆和已学规则：查相关能力卡、历史 correction、risk view、source registry 和最近 eval 失败点；只把有证据的规则带入分析，过期或冲突记忆要降权并交给 review。",
    sourceSummary:
      "targeted repair for local memory activation and stale/conflicting memory handling before finance reasoning.",
  },
  {
    caseId: "scenario_probability_no_model_math_guessing",
    priority: 112,
    userMessage:
      "用户要情景概率时，本地大脑不能凭模型口感编概率。先拆情景树、驱动变量、观测数据、先验来源、校准方法、样本外检查和缺失输入；没有数据就只给定性排序和需要的数据，不给伪精确数字。",
    sourceSummary:
      "targeted repair for scenario probability discipline; no invented model math or fake precision.",
  },
  {
    caseId: "paper_learning_internalization_absorption",
    priority: 110,
    userMessage:
      "训练本地大脑学习论文时必须走 source artifact、actual reading scope、capability card、retrieval receipt、apply validation、eval absorption 和 future application path；不能把“存了文件”说成“已经内化”。",
    sourceSummary:
      "targeted repair for paper learning internalization chain and absorption evidence separation.",
  },
  {
    caseId: "all_module_knowledge_internalization_chain",
    priority: 109,
    userMessage:
      "训练本地大脑把网上学习内化链条推广到所有模块，不只因子模块，也包括期权、指数、宏观、基本面、Lark/Feishu 工作流、记忆、ops 和 skill 模块。每个目标模块都必须有 source registry、actual reading scope、模块专属能力规则、retrieval receipt、apply validation、eval/training absorption、fresh adjacent task、module_learning_pipeline_review 状态、安全边界和 keep/downrank/discard；不能把存档或 plan receipt 说成模块学会。",
    sourceSummary:
      "targeted repair for all-module internalization chain; prevents factor-only gates, plan-only gates, and storage-only module learning claims.",
  },
  {
    caseId: "a_share_policy_flow_us_tech_spillover",
    priority: 108,
    userMessage:
      "训练本地大脑分析 A 股政策资金面到美股科技的传导：国内政策、人民币/美元流动性、北向/南向资金、指数权重、产业链、ADR/半导体链条、风险偏好和数据缺口都要串起来；research-only。",
    sourceSummary:
      "targeted repair for A-share policy flow to US tech spillover and cross-market causal mapping.",
  },
  {
    caseId: "recession_soft_landing_scenario_tree",
    priority: 106,
    userMessage:
      "训练本地大脑做 recession/soft landing 情景树：就业、通胀、收益率曲线、信用利差、盈利修正、美元流动性、风险资产 breadth 和反方证据都要拆；不要直接预测结论，先给证据框架和失效条件。",
    sourceSummary:
      "targeted repair for macro scenario-tree reasoning with evidence and invalidation conditions.",
  },
  {
    caseId: "conflicting_memory_live_model_review_governance",
    priority: 104,
    userMessage:
      "训练本地大脑处理本地记忆和大模型 review 冲突：先列冲突点、来源时间、证据强弱和是否 stale；本地记忆只提供候选规则，最终要经过 source/eval/review，不允许把旧记忆硬写进结论。",
    sourceSummary: "targeted repair for conflicting memory and live model review governance.",
  },
  {
    caseId: "source_coverage_actual_reading_scope",
    priority: 102,
    userMessage:
      "训练本地大脑回答来源覆盖时必须区分实际读过、只发现、只存档、已应用和已进入 eval 的材料；不能说全覆盖，也不能把摘要当原文阅读。",
    sourceSummary: "targeted repair for source coverage honesty and actual reading scope.",
  },
  {
    caseId: "single_company_fundamental_risk",
    priority: 100,
    userMessage:
      "训练本地大脑分析单公司基本面风险时要先要 10-K/10-Q、earnings release、call transcript 或本地来源，再拆业务质量、收入质量、毛利率/经营杠杆、FCF、ROIC、资产负债表、护城河、管理层资本配置、估值区间、安全边际、价值陷阱和 thesis invalidation；缺来源就只列证据缺口，不编财报细节。",
    sourceSummary:
      "targeted repair for single-company fundamental risk with value-investing anchors and filing/source evidence gate.",
  },
  {
    caseId: "current_market_data_freshness_boundary",
    priority: 98,
    userMessage:
      "训练本地大脑遇到实时价格、最新财报、当前利率、美元流动性或新闻时必须标注未验证边界：没有 timestamped source 就不能说最新、当前、上涨下跌或具体数值；只能列需要的来源、数据时间戳、冲突处理和 research-only 下一步。",
    sourceSummary:
      "targeted repair for current market data freshness boundary; no current-market claims without timestamped evidence.",
  },
  {
    caseId: "data_provenance_quality_gate",
    priority: 97,
    userMessage:
      "训练本地大脑遇到价格、成交量、宏观序列、ETF 权重、期权 IV 或 vendor 数据冲突时，不能把结构化数据当文章抽取。必须先走 source registry，再进入 data_provenance_quality_review_input，核对 vendor、source timestamp、field definition、currency、adjustment、update cadence、异常值和冲突优先级；没过 review 前所有数字都标 unverified。",
    sourceSummary:
      "targeted repair for structured data provenance routing; prevents market or macro data snapshots from bypassing data_provenance_quality_review_input into article extraction.",
  },
  {
    caseId: "rate_shock_duration_equity_chain",
    priority: 96,
    userMessage:
      "训练本地大脑拆利率冲击到股票和债券的链条：名义利率、实际利率、通胀预期、期限溢价、duration、折现率、权益风险溢价、估值倍数、盈利预期、TLT/QQQ/NVDA 敞口和反方证据；缺 DV01、久期、权重或收益序列时必须列缺口，不做伪数学。",
    sourceSummary:
      "targeted repair for rate-shock duration equity transmission with portfolio math gaps and no fake precision.",
  },
  {
    caseId: "treasury_supply_term_premium_portfolio_risk",
    priority: 95,
    userMessage:
      "训练本地大脑把美债供给、Treasury refunding、财政赤字和期限溢价接进已有利率血管：先要拍卖/再融资日历、期限溢价、实际利率、收益率曲线、来源时间戳，再拆 TLT 久期、QQQ 估值、美元/信用流动性、组合权重和反方证据；不能把国债供给 headline 当单独交易信号。",
    sourceSummary:
      "targeted repair for Treasury supply and term-premium shock routing through macro rates, credit, FX, ETF, math, portfolio risk, data provenance, and review.",
  },
  {
    caseId: "private_credit_nonbank_leverage_stress_waterflow",
    priority: 95,
    userMessage:
      "训练本地大脑把 private credit、NBFI、leveraged loans、半流动基金赎回、basis trade 和 forced deleveraging 接进信用/跨资产/组合风险血管：先要 borrower stress、估值、赎回压力、信用利差、资金流动性、HYG/ETF 敞口和组合权重；不能把信用 headline 直接写成确定传染或交易建议。",
    sourceSummary:
      "targeted repair for private credit and nonbank leverage stress with liquidity mismatch, cross-asset transmission, risk gates, and review.",
  },
  {
    caseId: "nvda_capex_supplier_second_order_risk",
    priority: 94,
    userMessage:
      "训练本地大脑分析 NVDA 与 AI capex 二阶风险：先要原始财报/指引/客户 capex 来源，再拆客户集中度、云厂商预算、供应链瓶颈、GPU 交付、毛利率、库存、竞争、估值、QQQ 权重传导、供应商/客户二阶影响和反方证据；缺来源就不编细节。",
    sourceSummary:
      "targeted repair for NVDA AI capex second-order risk with source-gated fundamentals and portfolio transmission.",
  },
  {
    caseId: "ai_capex_power_grid_index_concentration_risk",
    priority: 93,
    userMessage:
      "训练本地大脑把 AI capex、hyperscaler 预算、数据中心电力瓶颈、HBM/GPU 供应链和 QQQ 指数集中度接成一条研究血管：先要财报/指引/预算/电力和供应链来源，再拆基本面、估值敏感性、事件催化、能源约束、指数权重、组合重叠、反方证据和 review；不能把 AI 热度当 alpha。",
    sourceSummary:
      "targeted repair for AI capex power-grid and index-concentration risk routing through fundamentals, valuation, event, commodity/energy, index, portfolio, data provenance, and review.",
  },
  {
    caseId: "index_concentration_mag7_portfolio_risk",
    priority: 92,
    userMessage:
      "训练本地大脑拆指数集中度和 Mag7 组合风险：先要指数权重、ETF 持仓、用户仓位、相关性、收益序列和估值分布，再拆 concentration、factor overlap、single-name shock、QQQ/SPY 传导、再平衡风险和缺口；不能没有权重就给仓位建议。",
    sourceSummary:
      "targeted repair for index concentration and mega-cap overlap risk with holdings and weights evidence gates.",
  },
  {
    caseId: "drawdown_budget_without_weights",
    priority: 90,
    userMessage:
      "训练本地大脑处理 drawdown budget 时必须先要仓位权重、资产收益序列、波动、相关性、时间窗口和最大回撤定义；没有这些输入时只能给风险预算框架和缺口清单，不能编百分比、止损线或建议卖买。",
    sourceSummary:
      "targeted repair for drawdown budget without weights; fail closed on missing portfolio inputs.",
  },
  {
    caseId: "data_vendor_conflict_reconciliation",
    priority: 88,
    userMessage:
      "训练本地大脑处理数据供应商冲突：先列供应商、字段定义、时间戳、复权口径、币种、更新频率、异常值、可信优先级和需要人工 review 的冲突；不能随便选一个数据源当真相，也不能把冲突数据写成确定结论。",
    sourceSummary:
      "targeted repair for data vendor conflict reconciliation with timestamp, definition, and review gates.",
  },
  {
    caseId: "energy_inflation_cross_asset_shock_risk",
    priority: 87,
    userMessage:
      "训练本地大脑把霍尔木兹、OPEC、原油库存、SPR、能源价格、CPI/PCE 通胀、美元、TLT、QQQ 和股债相关性接成一条冲击水路：先要官方或一手来源、供需/库存/备用产能、通胀预期、利率、美元流动性、ETF regime 和组合权重；必须说明供给冲击下股债对冲可能失效，不给交易建议。",
    sourceSummary:
      "targeted repair for energy inflation cross-asset shock with commodity supply data, inflation transmission, FX, equity-bond hedge failure, portfolio risk, and review.",
  },
];

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function evalSnapshotFromPayload(
  payload: Record<string, unknown>,
): FailureEvalSnapshot | undefined {
  if (payload.event !== "step_non_passing" && payload.event !== "step_ok") {
    return undefined;
  }
  if (payload.name !== "candidate_hardened_eval" && payload.name !== "stable_hardened_eval") {
    return undefined;
  }
  const result = payload.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const summary = (result as { summary?: unknown }).summary;
  const adapterPath = (result as { adapterPath?: unknown }).adapterPath;
  if (!summary || typeof summary !== "object" || typeof adapterPath !== "string") {
    return undefined;
  }
  const failedCaseIds = (summary as { failedCaseIds?: unknown }).failedCaseIds;
  const parseRecoveredCaseIds = (summary as { parseRecoveredCaseIds?: unknown })
    .parseRecoveredCaseIds;
  const filteredFailedCaseIds = Array.isArray(failedCaseIds)
    ? failedCaseIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const filteredParseRecoveredCaseIds = Array.isArray(parseRecoveredCaseIds)
    ? parseRecoveredCaseIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (filteredFailedCaseIds.length === 0 && filteredParseRecoveredCaseIds.length === 0) {
    return undefined;
  }
  const passed = (summary as { passed?: unknown }).passed;
  const total = (summary as { total?: unknown }).total;
  const passRate = (summary as { passRate?: unknown }).passRate;
  return {
    at: typeof payload.at === "string" ? payload.at : "",
    adapterPath,
    failedCaseIds: filteredFailedCaseIds,
    parseRecoveredCaseIds: filteredParseRecoveredCaseIds,
    passed: typeof passed === "number" ? passed : 0,
    total: typeof total === "number" ? total : 0,
    passRate: typeof passRate === "number" ? passRate : 0,
  };
}

async function latestFailureSnapshot(logPath: string): Promise<FailureEvalSnapshot | undefined> {
  let raw = "";
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return undefined;
  }
  const snapshots = raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map(evalSnapshotFromPayload)
    .filter((entry): entry is FailureEvalSnapshot => Boolean(entry));
  return snapshots.toSorted((left, right) => right.at.localeCompare(left.at))[0];
}

function fallbackRecipe(caseId: string, priority: number): FailureCaseRecipe {
  return {
    caseId,
    priority,
    userMessage: `训练本地大脑修复 eval 失败项 ${caseId}：先复述失败能力边界，再拆需要的本地记忆、金融模块、证据缺口、风险门、review handoff 和人类可读总结；research-only，不要给交易建议，不要编实时数据。`,
    sourceSummary: `generic targeted repair for local-brain eval failure ${caseId}; requires module planning, evidence gaps, review, and research-only boundary.`,
  };
}

function recipeForCaseId(
  caseId: string,
  recipeByCaseId: Map<string, FailureCaseRecipe>,
  priority: number,
): FailureCaseRecipe {
  const exactRecipe = recipeByCaseId.get(caseId);
  if (exactRecipe) {
    return exactRecipe;
  }
  const prefixRecipe = Array.from(recipeByCaseId.entries()).find(
    ([recipeCaseId]) => recipeCaseId !== caseId && caseId.startsWith(`${recipeCaseId}_`),
  )?.[1];
  if (prefixRecipe) {
    return { ...prefixRecipe, caseId, priority: Math.max(priority, prefixRecipe.priority) };
  }
  return fallbackRecipe(caseId, priority);
}

export async function buildFailureCurriculumPrompts(
  options: FailureCurriculumOptions,
): Promise<TeacherPrompt[]> {
  if (options.maxPrompts <= 0) {
    return [];
  }
  const snapshot = await latestFailureSnapshot(options.guardLogPath ?? DEFAULT_GUARD_LOG);
  if (!snapshot) {
    return [];
  }
  const recipeByCaseId = new Map(FAILURE_CASE_RECIPES.map((recipe) => [recipe.caseId, recipe]));
  const focusCaseIds = Array.from(
    new Set([...snapshot.failedCaseIds, ...snapshot.parseRecoveredCaseIds]),
  );
  const recipes = focusCaseIds
    .map((caseId, index) => recipeForCaseId(caseId, recipeByCaseId, 10 - index))
    .toSorted(
      (left, right) => right.priority - left.priority || left.caseId.localeCompare(right.caseId),
    )
    .slice(0, options.maxPrompts);
  const startIndex = options.startIndex ?? 0;
  return recipes.map((recipe, index) => ({
    id: `failure_focus_${recipe.caseId}_${String(startIndex + index).padStart(5, "0")}`,
    userMessage: `${recipe.userMessage} 验收码 minimax-failure-focus-${String(startIndex + index).padStart(5, "0")}`,
    sourceSummary: [
      recipe.sourceSummary,
      `Latest failed eval adapter ${path.basename(snapshot.adapterPath)} passed ${snapshot.passed}/${snapshot.total} (${snapshot.passRate}).`,
      snapshot.parseRecoveredCaseIds.includes(recipe.caseId)
        ? "This case passed acceptance only through parseRecovered; compact valid JSON is required before promotion."
        : undefined,
      "Writes brain distillation review only; no live sender, provider config, language corpus, protected memory, or finance doctrine change.",
    ]
      .filter((entry): entry is string => typeof entry === "string")
      .join(" "),
  }));
}

export const __test = {
  DEFAULT_GUARD_LOG,
  FAILURE_CASE_RECIPES,
};
