import { LOCAL_BRAIN_MODULE_TAXONOMY } from "./local-brain-taxonomy.js";

export type LocalBrainContractInput = {
  ask: string;
  sourceSummary?: string;
};

const MODULE_IDS = LOCAL_BRAIN_MODULE_TAXONOMY;

const MODULE_ID_SET = new Set<string>(MODULE_IDS);

function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function mergeUnique(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of groups.flat()) {
    const normalized = item.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function withoutValues(values: string[], blockedValues: readonly string[]): string[] {
  const blocked = new Set(blockedValues.map((value) => value.toLowerCase()));
  return values.filter((value) => !blocked.has(value.toLowerCase()));
}

function cleanRiskBoundaries(value: unknown): string[] {
  const blocked = new Set([
    ...MODULE_IDS,
    "language_routing_only",
    "language_routing_required",
    "risk_boundaries",
    "next_step",
    "rejected_context",
  ]);
  return arrayValue(value).filter((entry) => !blocked.has(entry));
}

function cleanModuleList(value: unknown): string[] {
  return arrayValue(value).filter((entry) => MODULE_ID_SET.has(entry));
}

function cleanMissingData(value: unknown): string[] {
  const blocked = new Set([...MODULE_IDS, "missing_data", "risk_boundaries", "next_step"]);
  return arrayValue(value).filter((entry) => !blocked.has(entry));
}

function basePlan(plan: Record<string, unknown>): Record<string, unknown> {
  return {
    ...plan,
    primary_modules: cleanModuleList(plan.primary_modules),
    supporting_modules: cleanModuleList(plan.supporting_modules),
    missing_data: cleanMissingData(plan.missing_data),
    risk_boundaries: mergeUnique(cleanRiskBoundaries(plan.risk_boundaries), [
      "research_only",
      "no_execution_authority",
      "evidence_required",
      "no_model_math_guessing",
    ]),
    rejected_context: mergeUnique(arrayValue(plan.rejected_context), [
      "old_lark_conversation_history",
      "language_routing_candidate_artifacts",
      "unsupported_execution_language",
    ]),
  };
}

function textOf(input: LocalBrainContractInput): string {
  return `${input.ask}\n${input.sourceSummary ?? ""}`;
}

function looksLikeAmbiguousRepeatOnly(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return /^(重新来一遍|重来一遍|再来一遍|从头来|从头开始|继续刚才那个|继续上次那个|接着刚才那个|接着上次那个|刚才那个|上面那个|上一条|继续|接着|redo|restart|again)(?:，?别啰嗦|，?简单点|，?快点)?[。.!！?？\s]*$/iu.test(
    normalized,
  );
}

function looksLikeContextReset(text: string): boolean {
  return /(清除上下文|清空上下文|别接上个任务|不要接上个任务|换个题|fresh start|reset context|new task)/iu.test(
    text,
  );
}

function looksLikeContextResetWithNewSubject(text: string): boolean {
  const match =
    /(清除上下文|清空上下文|别接上个任务|不要接上个任务|别接上文|换个题|fresh start|reset context|new task)[：:，,。\s-]*(.+)$/iu.exec(
      text.trim(),
    );
  const subject = match?.[2]?.trim() ?? "";
  return (
    subject.length >= 8 &&
    /(qqq|spy|tlt|nvda|mchi|gld|dbc|美股|a股|沪深|指数|人民币|汇率|美元|利率|黄金|现金|仓位|组合|portfolio|risk|风险|宏观|流动性)/iu.test(
      subject,
    )
  );
}

function looksLikeExternalMissingSource(text: string): boolean {
  const asksToLearnSource =
    /(学习|learn|读|吸收|沉淀|论文|paper|网页|article|source|url|链接|本地文件|local file)/iu.test(
      text,
    );
  const namesSourceObject = /(论文|paper|网页|article|source|url|链接|本地文件|local file)/iu.test(
    text,
  );
  const sourceIsAbsent =
    /(没给|没有给|还没给|未提供|缺少|missing|without|no)\s*(?:url|link|source|local file|paper|article)/iu.test(
      text,
    ) ||
    /(没给|没有给|还没给|未提供|缺少).{0,12}(链接|网址|来源|源文件|本地文件|论文|文章)/iu.test(
      text,
    );
  return asksToLearnSource && namesSourceObject && sourceIsAbsent;
}

function looksLikeExternalCoverage(text: string): boolean {
  return (
    /(google scholar|scholar|ssrn|nber|arxiv|working paper|preprint|literature review|公开课程|顶级大学|高校|syllabus|论文|paper)/iu.test(
      text,
    ) &&
    /(覆盖|coverage|sample limits?|sampling limits?|实际读过|读过哪些|what was actually read|不要说全覆盖|别说全覆盖|未覆盖范围|source limits?|全覆盖|完整覆盖|exhaustive|comprehensive)/iu.test(
      text,
    )
  );
}

function looksLikeCommodityFrameworkLearning(text: string): boolean {
  return (
    !looksLikeEtfAsCompanyFundamentalTrap(text) &&
    !looksLikePaperLearningWithSource(text) &&
    /(大宗商品|commodity|commodities|原油|石油|crude|oil|黄金|gold|铜|copper|gld|dbc|uso|dba)/iu.test(
      text,
    ) &&
    /(学习|学会|框架|模块|证据|缺口|research framework|应用|内化|沉淀)/iu.test(text)
  );
}

function looksLikeBroadFinanceModuleCoverage(text: string): boolean {
  const asksForModuleMap =
    /(金融模块|金融能力|模块地图|模块体系|能力层|module taxonomy|finance module|模块还不够|还不够.{0,12}模块|全部.{0,12}模块|所有.{0,12}模块|扩充.{0,12}模块)/iu.test(
      text,
    );
  const hasFinanceScope =
    /(金融|finance|market|市场|美股|a股|指数|etf|股票|组合|宏观|利率|美元|流动性|商品|期权|波动率|技术面|事件|财报|crypto|btc|量化|风控)/iu.test(
      text,
    );
  const namesMultipleLayers = [
    /(宏观|利率|通胀|macro|rates?|inflation)/iu.test(text),
    /(美元|外汇|fx|dxy|currency|liquidity|流动性)/iu.test(text),
    /(商品|原油|黄金|铜|commodit|oil|gold|copper)/iu.test(text),
    /(期权|iv|volatility|gamma|skew|波动率)/iu.test(text),
    /(技术面|technical|timing|择时|趋势|breadth|momentum)/iu.test(text),
    /(事件|财报|fomc|cpi|event|earnings|catalyst)/iu.test(text),
    /(基本面|fundamental|valuation|估值|现金流|利润率)/iu.test(text),
    /(组合|仓位|portfolio|risk|风险|quant|量化)/iu.test(text),
  ].filter(Boolean).length;
  return asksForModuleMap && hasFinanceScope && namesMultipleLayers >= 2;
}

function looksLikeEtfAsCompanyFundamentalTrap(text: string): boolean {
  return (
    /\b(GLD|QQQ|SPY|TLT|IEF|IWM|XLK|XLF|HYG|UUP|MCHI|DBC|USO|DBA)\b/iu.test(text) &&
    /(收入质量|客户集中度|revenue quality|customer concentration|client concentration|ev\/ebitda|毛利率|利润率|13f holder|filing|10-q|10-k)/iu.test(
      text,
    )
  );
}

function looksLikeCompanyToPortfolioRisk(text: string): boolean {
  return (
    /(公司|基本面|fundamental|capex|revenue|margin|earnings|估值|收入质量|客户集中度)/iu.test(
      text,
    ) && /(组合|持仓|仓位|科技仓|etf sleeve|portfolio|sleeve|risk|风险|传导|连接|影响)/iu.test(text)
  );
}

function looksLikePortfolioMathMissingInputs(text: string): boolean {
  return (
    /(数学|量化|波动|相关|回撤|var|dv01|beta|correlation|volatility|drawdown|利率敏感)/iu.test(
      text,
    ) &&
    /(没给|没有给|还没给|未提供|缺|missing|without|权重|价格序列|return series|weights)/iu.test(
      text,
    )
  );
}

function looksLikePortfolioMacroRisk(text: string): boolean {
  return (
    /(qqq|tlt|nvda|持仓|组合|portfolio)/iu.test(text) &&
    /(利率|ai capex|美元流动性|流动性|通胀|credit|macro|未来两周|风险)/iu.test(text)
  );
}

function looksLikeEtfTimingFramework(text: string): boolean {
  return /(低频|daily|weekly|etf|择时|timing|框架|framework)/iu.test(text);
}

function looksLikeOpsContextAudit(text: string): boolean {
  return /(上下文污染|串到旧任务|旧任务|lark.*污染|lark.*审计|上下文.*审计|旧任务.*审计|context pollution|不要继续金融分析|ops audit)/iu.test(
    text,
  );
}

function looksLikeSourceGroundingAudit(text: string): boolean {
  return (
    !looksLikeCrossMarketFinance(text) &&
    !looksLikeFullStackFinanceStressTest(text) &&
    !looksLikeExternalCoverage(text) &&
    !looksLikeFilingResearchMissingEvidence(text) &&
    !looksLikeSentimentMarketModuleLearning(text) &&
    !looksLikeUnverifiedLiveMarketData(text) &&
    !looksLikeDataConflictReconciliation(text) &&
    /(哪来的|来源|source|artifact|receipt|citation|证据|unverified|未验证|出处|根据什么)/iu.test(
      text,
    ) &&
    /(claim|说法|结论|判断|纳指|qqq|spy|tlt|nvda|美元流动性|市场|宏观|指数|股市)/iu.test(text) &&
    /(没有|无|缺|missing|unverified|标)/iu.test(text)
  );
}

function looksLikeDataConflictReconciliation(text: string): boolean {
  return (
    !looksLikeUnverifiedLiveMarketData(text) &&
    !looksLikePaperLearningWithSource(text) &&
    /(不同数据源|数据源.*不一致|vendor|data source|conflict|冲突|口径|时间戳|timestamp)/iu.test(
      text,
    ) &&
    /(etf|成分|权重|成交量|情绪|sentiment|行情|market data|source registry|审阅|review)/iu.test(
      text,
    )
  );
}

function looksLikeConflictingMemoryLiveModelReview(text: string): boolean {
  const hasMemoryLayer =
    /(本地记忆|旧规则|过期记忆|memory|learned rule|已学规则|历史沉淀|旧结论)/iu.test(text);
  const hasLiveOrFreshLayer =
    /(今天|最新|实时|当前|fresh|latest|right now|市场快照|行情源|数据源)/iu.test(text);
  const hasModelOrSourceConflict =
    /(minimax|kimi|deepseek|多模型|模型.{0,12}(分歧|不一致)|分歧|不一致|不同数据源|vendor|口径|source conflict|数据冲突)/iu.test(
      text,
    );
  const hasFinanceScope =
    /(qqq|spy|tlt|nvda|btc|a股|美股|指数|仓位|组合|portfolio|风险|宏观|流动性|技术面|财报)/iu.test(
      text,
    );
  return hasMemoryLayer && hasLiveOrFreshLayer && hasModelOrSourceConflict && hasFinanceScope;
}

function looksLikeOptionsIvEventRisk(text: string): boolean {
  return (
    /(期权|\boptions?\b|\biv\b|implied vol|隐含波动|gamma|delta|skew|波动率曲面)/iu.test(text) &&
    /(财报|earnings|fomc|cpi|事件|event|qqq|spy|nvda|tlt|仓位|portfolio|组合)/iu.test(text)
  );
}

function looksLikeScenarioProbabilityMissingInputs(text: string): boolean {
  return (
    /(场景|scenario|软着陆|再通胀|衰退|概率|probability|probabilities)/iu.test(text) &&
    /(qqq|spy|tlt|nvda|仓位|组合|portfolio|风险)/iu.test(text) &&
    /(没给|没有给|还没给|未提供|缺少|缺乏|不要.*编|不要.*猜|no model math|随便编概率)/iu.test(text)
  );
}

function looksLikeTaxResearchBoundary(text: string): boolean {
  return /(税务|tax|wash sale|亏损仓位|tax loss|年底|再平衡.*税|税务建议|专业意见)/iu.test(text);
}

function looksLikePostMortemCorrection(text: string): boolean {
  return (
    /(判断错|错了|复盘|post[- ]?mortem|correction note|纠错|降权|改写|过期记忆)/iu.test(text) &&
    /(qqq|tlt|nvda|宏观|技术面|仓位|市场|规则|记忆|memory)/iu.test(text)
  );
}

function looksLikeAnalystReportLearning(text: string): boolean {
  return (
    /(券商研报|研报|analyst report|目标价|price target|sell[- ]?side|评级|rating)/iu.test(text) &&
    /(学习|拆|source quality|假设|估值|组合风险|内化|沉淀)/iu.test(text)
  );
}

function looksLikeModelReviewDisagreement(text: string): boolean {
  return (
    /(minimax|kimi|deepseek|多模型|模型.{0,12}(分歧|不一致)|分歧|不一致|disagreement)/iu.test(
      text,
    ) &&
    /(qqq|tlt|nvda|组合|portfolio|风险|证据|本地规则|control room|控制室)/iu.test(text) &&
    /(不要直接选|不要.*当答案|找分歧|比较|证据|回忆本地规则|本地大脑)/iu.test(text)
  );
}

function looksLikeMacroEventRiskPreflight(text: string): boolean {
  return (
    !looksLikeFullStackFinanceStressTest(text) &&
    /(fomc|cpi|fed|议息|通胀数据|利率决议|事件风险|event risk)/iu.test(text) &&
    /(qqq|tlt|nvda|持有|组合|portfolio|仓位|etf|技术面)/iu.test(text) &&
    /(不要预测|不要.*涨跌|preflight|先拆|研究链路|research-only)/iu.test(text)
  );
}

function looksLikeRebalanceExecutionBoundary(text: string): boolean {
  return (
    /(调仓|再平衡|rebalance|仓位调一下|把.*仓位.*调|下单|order entry)/iu.test(text) &&
    /(qqq|tlt|nvda|仓位|持仓|组合|portfolio|risk|风险)/iu.test(text) &&
    /(不要执行|不要给下单|research-only|研究|风险分析|没有执行权限)/iu.test(text)
  );
}

function looksLikeLocalKnowledgeActivation(text: string): boolean {
  return (
    /(复杂|拆解|拆分|分析|研究|任务|人类|human|analyst|framework|plan|planning|decompose|reason)/iu.test(
      text,
    ) &&
    /(本地|local|大脑|brain|记忆|memory|知识|knowledge|已学|learned|规则|lessons?|沉淀|artifact|receipt|历史|复盘)/iu.test(
      text,
    )
  );
}

function looksLikeCrossMarketFinance(text: string): boolean {
  const groups = [
    /(美股|us equities|us stocks?|nasdaq|s&p|spx|spy|qqq|iwm|nvda|msft|aapl)/iu.test(text),
    /(a股|a-share|沪深|上证|深证|创业板|科创|北向|人民币资产|中国权益)/iu.test(text),
    /(指数|indices|index|沪深300|中证|纳指|道指|标普|恒生|msci|russell)/iu.test(text),
    /(加密|crypto|bitcoin|btc|ethereum|eth|stablecoin|usdt|链上|交易所储备)/iu.test(text),
  ].filter(Boolean).length;
  return (
    groups >= 2 &&
    /(连贯|跨市场|一起|全局|整体|框架|拆解|怎么拆|decompose|analysis|research|分析|研究|风险|未来|仓位|portfolio|asset allocation|资产|谁更该冲|哪个更该冲|直接告诉|买哪个|卖哪个|该买|该卖|冲不冲)/iu.test(
      text,
    )
  );
}

function looksLikeFullStackFinanceStressTest(text: string): boolean {
  const hasFundamentalLayer =
    /(财报|10-q|10-k|earnings|filing|guidance|margin|revenue|收入|利润率|指引|估值|基本面|fundamental)/iu.test(
      text,
    );
  const hasMacroLayer = /(宏观|利率|通胀|fed|美元|流动性|credit|信用|liquidity|fx|人民币)/iu.test(
    text,
  );
  const hasPortfolioLayer =
    /(仓位|持仓|组合|权重|cost basis|portfolio|position|risk limit|回撤预算)/iu.test(text);
  const hasTechnicalLayer =
    /(技术面|趋势|均线|成交量|breadth|momentum|price volume|technical|regime|支撑|阻力)/iu.test(
      text,
    );
  const hasRedTeamLayer =
    /(反方|反证|红队|red[-_ ]?team|invalidation|证伪|如果错了|错在哪里|falsify)/iu.test(text);
  const hasDataGapLayer =
    /(数据缺口|缺什么数据|哪些数据|需要哪些数据|证伪.*数据|missing|缺失|没给|未提供|fresh data|data gap)/iu.test(
      text,
    );
  return (
    [
      hasFundamentalLayer,
      hasMacroLayer,
      hasPortfolioLayer,
      hasTechnicalLayer,
      hasRedTeamLayer,
    ].filter(Boolean).length >= 4 && hasDataGapLayer
  );
}

function looksLikeAgentSkillLearning(text: string): boolean {
  return (
    /(skill|skills|skill\.md|agent skill|microagent|openhands|hugging face|agent结构|本地agent|本地 agent|技能|工作流|workflow|harness|hermes)/iu.test(
      text,
    ) &&
    /(找|加上|安装|学习|学会|吸收|沉淀|训练|teach|learn|harvest|distill|convert|应用|接入)/iu.test(
      text,
    )
  );
}

function looksLikePaperLearningWithSource(text: string): boolean {
  const asksToLearn =
    /(学习|learn|读|吸收|沉淀|内化|论文|paper|preprint|arxiv|working paper|article)/iu.test(text);
  const hasSource =
    /(arxiv\.org\/(?:abs|html|pdf)\/\d{4}\.\d{4,5}|https?:\/\/|本地文件|local file|source artifact|receipt|capability card)/iu.test(
      text,
    );
  const wantsReusableKnowledge =
    /(规则|能力|capability|retrieval|apply validation|可复用|本地大脑|qwen|训练|eval|测评|risk gate|风险门|portfolio|组合|etf|量化|sentiment|情绪)/iu.test(
      text,
    );
  return asksToLearn && hasSource && wantsReusableKnowledge;
}

function looksLikeUnverifiedLiveMarketData(text: string): boolean {
  const asksForLiveMarketData =
    /(今天|最新|实时|当前行情|当前市场|this morning|today|latest|real[- ]?time|right now)/iu.test(
      text,
    ) || /现在.{0,16}(怎么看|走势|涨跌|价格|行情|market|price)/iu.test(text);
  return (
    asksForLiveMarketData &&
    !looksLikeFilingResearchMissingEvidence(text) &&
    /(qqq|spy|tlt|nvda|a股|指数|btc|crypto|利率|美元|市场|走势|涨跌|价格|成交量|财报|宏观)/iu.test(
      text,
    )
  );
}

function looksLikeBacktestOverfitStrategyLearning(text: string): boolean {
  return (
    !looksLikeSentimentMarketModuleLearning(text) &&
    !looksLikeTechnicalTimingNotStandalone(text) &&
    /(因子|factor|择时|timing|策略|strategy|signal|alpha|回测|backtest|历史胜率|win rate)/iu.test(
      text,
    ) &&
    /(过拟合|overfit|样本外|out[- ]?of[- ]?sample|survivor|幸存者|失效|invalidation|walk[- ]?forward|cross[- ]?validation|不要.*神话|神话)/iu.test(
      text,
    )
  );
}

function looksLikeCryptoLeverageBoundary(text: string): boolean {
  return (
    !looksLikeFullStackFinanceStressTest(text) &&
    /(加密|crypto|btc|bitcoin|eth|ethereum|永续|perp|perpetual|杠杆|leverage|合约|期货)/iu.test(
      text,
    ) &&
    /(高杠杆|high leverage|10x|20x|50x|100x|爆仓|liquidation|做多|做空|开仓|下单|execution|自动交易)/iu.test(
      text,
    )
  );
}

function mentionsCryptoMarket(text: string): boolean {
  return /(加密|crypto|bitcoin|btc|ethereum|eth|stablecoin|usdt|链上|交易所储备)/iu.test(text);
}

function looksLikeSentimentMarketModuleLearning(text: string): boolean {
  return (
    /(情绪|sentiment|news sentiment|social sentiment|舆情|twitter|x.com|reddit|新闻情绪)/iu.test(
      text,
    ) &&
    /(股市|market|stocks?|美股|a股|指数|crypto|btc|项目|github|开源|repo|module|模块|接入|学习|加入|框架)/iu.test(
      text,
    )
  );
}

function looksLikeFilingResearchMissingEvidence(text: string): boolean {
  return (
    /(财报|10-q|10-k|filing|earnings|指引|guidance|margin|revenue|收入|利润率|现金流|基本面)/iu.test(
      text,
    ) &&
    (/(没给|没有给|还没给|未提供).{0,24}(10-q|10-k|filing|earnings|release|来源|source|原文|财报|指引)/iu.test(
      text,
    ) ||
      /(没有原文|没有来源|no filing|no source|without filing|without source|missing filing|missing source)/iu.test(
        text,
      ))
  );
}

function looksLikeTechnicalTimingNotStandalone(text: string): boolean {
  return (
    !looksLikeFullStackFinanceStressTest(text) &&
    !looksLikeCrossMarketFinance(text) &&
    /(技术面|technical|均线|ma\b|rsi|macd|趋势|trend|支撑|阻力|成交量|volume|breadth|动量|momentum)/iu.test(
      text,
    ) &&
    /(单独|只看|only|standalone|独立|alpha|预测|择时|timing|入场|出场|买点|卖点)/iu.test(text)
  );
}

export function hardenLocalBrainPlanForAsk(
  plan: Record<string, unknown>,
  input: LocalBrainContractInput,
): Record<string, unknown> {
  const text = textOf(input);
  const safe = basePlan(plan);

  if (looksLikeAmbiguousRepeatOnly(input.ask)) {
    return {
      ...safe,
      task_family: "ambiguous_repeat_without_current_subject",
      primary_modules: ["ops_audit", "agent_workflow_memory", "control_room_summary"],
      supporting_modules: ["review_panel"],
      required_tools: ["review_panel"],
      missing_data: ["current_subject_or_original_request"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "ask_user_for_current_subject_before_reusing_prior_context",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }

  if (looksLikeContextReset(text) && !looksLikeContextResetWithNewSubject(input.ask)) {
    return {
      ...safe,
      task_family: "context_reset_new_subject_required",
      primary_modules: ["control_room_summary"],
      supporting_modules: ["ops_audit"],
      required_tools: ["review_panel"],
      missing_data: ["new_subject_or_original_request"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "acknowledge_context_reset_then_ask_for_new_task_subject",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }

  if (looksLikeOpsContextAudit(text)) {
    return {
      ...safe,
      task_family: "lark_context_pollution_audit",
      primary_modules: ["ops_audit"],
      supporting_modules: ["control_room_summary", "review_panel"],
      required_tools: ["lark_loop_diagnose", "sessions_history", "review_panel"],
      missing_data: ["fresh_lark_message_id_or_visible_reply_text"],
      risk_boundaries: ["no_execution_authority", "evidence_required"],
      next_step: "inspect_lark_session_store_and_candidate_replay_before_claiming_live_fixed",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }

  if (looksLikeConflictingMemoryLiveModelReview(text)) {
    return {
      ...safe,
      task_family: "conflicting_memory_live_model_review_governance",
      primary_modules: [
        "finance_learning_memory",
        "source_registry",
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
        "causal_map",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["cross_asset_liquidity", "us_equity_market_structure", "ops_audit"],
      required_tools: [
        "artifact_memory_recall",
        "source_registry_lookup",
        "data_timestamp_and_vendor_compare",
        "finance_learning_capability_apply",
        "quant_math",
        "review_panel",
      ],
      missing_data: [
        "memory_recall_scope_or_relevant_receipts",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "model_review_claims_and_assumptions",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_live_data",
        "do_not_pick_model_answer_without_evidence",
        "do_not_promote_unverified_memory_claims",
        "no_model_math_guessing",
        "no_trade_advice",
      ],
      next_step:
        "separate_memory_claims_live_data_and_model_opinions_then_resolve_by_source_timestamp_assumptions_quant_checks_and_review_before_summary",
      rejected_context: [
        "old_lark_conversation_history",
        "stale_memory_rule_as_current_fact",
        "single_model_authority_claim",
        "single_vendor_unverified_claim",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeBroadFinanceModuleCoverage(text)) {
    return {
      ...safe,
      task_family: "broad_finance_module_taxonomy_planning",
      primary_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "fx_dollar",
        "etf_regime",
        "global_index_regime",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "crypto_market_structure",
        "commodities_oil_gold",
        "options_volatility",
        "event_driven",
        "technical_timing",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
      ],
      supporting_modules: [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      required_tools: [
        "finance_framework_core_inspect",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "quant_math",
        "review_panel",
      ],
      missing_data: [
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
        "macro_rates_inflation_credit_fx_inputs",
        "commodity_curve_roll_yield_and_inventory_inputs",
        "options_iv_skew_gamma_and_event_calendar",
        "price_volume_breadth_and_technical_regime_inputs",
        "latest_company_fundamental_inputs",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_model_math_guessing",
        "no_unverified_live_data",
        "technical_timing_not_standalone_alpha",
        "sentiment_signal_not_standalone_alpha",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ],
      next_step:
        "build_a_layered_finance_module_map_then_select_only_relevant_modules_per_user_task_before_review_and_control_room_summary",
      rejected_context: [
        "old_lark_conversation_history",
        "single_bucket_finance_routing",
        "module_name_dump_without_task_selection",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeScenarioProbabilityMissingInputs(text)) {
    return {
      ...safe,
      task_family: "scenario_probability_missing_inputs_research_preflight",
      primary_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "review_panel",
      ],
      supporting_modules: ["control_room_summary"],
      required_tools: [
        "artifact_memory_recall",
        "source_registry_lookup",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
        "current_rates_and_inflation_inputs",
        "scenario_base_rates_and_sample_window",
        "fresh_market_data_snapshot",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_model_math_guessing",
        "no_trade_advice",
      ],
      next_step:
        "request_scenario_base_rates_sample_window_macro_inputs_and_portfolio_series_before_assigning_probabilities",
      rejected_context: [
        "old_lark_conversation_history",
        "model_invented_scenario_probability",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeCommodityFrameworkLearning(text)) {
    return {
      ...safe,
      task_family: "commodity_macro_framework_learning_planning",
      primary_modules: [
        "finance_learning_memory",
        "source_registry",
        "macro_rates_inflation",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "fx_dollar",
        "commodities_oil_gold",
        "etf_regime",
        "portfolio_risk_gates",
        "causal_map",
        "review_panel",
      ],
      supporting_modules: ["quant_math", "control_room_summary"],
      required_tools: [
        "artifact_memory_recall",
        "source_registry_lookup",
        "finance_learning_capability_apply",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_cross_asset_liquidity_producer",
        "finance_framework_fx_currency_liquidity_producer",
        "finance_framework_fx_dollar_producer",
        "finance_framework_commodities_oil_gold_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "source_url_or_local_source_path",
        "actual_reading_scope_receipt",
        "fresh_market_data_snapshot",
        "position_weights_and_return_series",
        "commodity_curve_roll_yield_and_inventory_inputs",
        "regime_specificity_and_invalidation_evidence",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_live_data",
        "commodity_framework_not_trade_signal",
        "no_trade_advice",
      ],
      next_step:
        "treat_commodities_as_macro_supply_demand_curve_and_portfolio_risk_framework_require_sources_fresh_inputs_roll_yield_and_review_before_summary",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "commodity_term_dump_without_application_path",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeSourceGroundingAudit(text)) {
    return {
      ...safe,
      task_family: "source_grounding_claim_audit",
      primary_modules: ["source_registry", "finance_learning_memory", "review_panel"],
      supporting_modules: ["control_room_summary", "ops_audit"],
      required_tools: ["source_registry_lookup", "artifact_memory_recall", "review_panel"],
      missing_data: ["source_url_or_local_source_path"],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_live_data",
      ],
      next_step: "mark_claim_unverified_until_source_artifact_or_receipt_is_found",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unverified_market_claim",
      ],
    };
  }

  if (looksLikeDataConflictReconciliation(text)) {
    return {
      ...safe,
      task_family: "data_vendor_conflict_reconciliation",
      primary_modules: [
        "source_registry",
        "quant_math",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["finance_learning_memory", "causal_map", "portfolio_risk_gates"],
      required_tools: [
        "source_registry_lookup",
        "data_timestamp_and_vendor_compare",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "source_timestamp_and_vendor",
        "index_constituents_weights_and_technical_regime_inputs",
        "validation_dataset_and_sample_out_plan",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_live_data",
      ],
      next_step:
        "compare_vendor_timestamps_definitions_and_missing_fields_before_promoting_any_market_claim",
      rejected_context: [
        "old_lark_conversation_history",
        "single_vendor_unverified_claim",
        "stale_market_data_snapshot",
      ],
    };
  }

  if (looksLikeTaxResearchBoundary(text)) {
    return {
      ...safe,
      task_family: "tax_loss_rebalance_research_boundary",
      primary_modules: [
        "quant_math",
        "portfolio_risk_gates",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
      ],
      supporting_modules: ["control_room_summary"],
      required_tools: ["source_registry_lookup", "quant_math", "review_panel"],
      missing_data: [
        "position_weights_and_return_series",
        "source_url_or_local_source_path",
        "tax_or_professional_advice_source",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "not_tax_advice",
        "no_trade_advice",
      ],
      next_step:
        "separate_portfolio_math_from_tax_or_professional_advice_and_request_authoritative_sources",
      rejected_context: [
        "old_lark_conversation_history",
        "tax_advice_claim",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeOptionsIvEventRisk(text)) {
    return {
      ...safe,
      task_family: "options_iv_event_risk_research_boundary",
      primary_modules: [
        "source_registry",
        "options_volatility",
        "event_driven",
        "company_fundamentals_value",
        "macro_rates_inflation",
        "etf_regime",
        "quant_math",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: ["finance_learning_memory", "causal_map", "control_room_summary"],
      required_tools: [
        "source_registry_lookup",
        "finance_framework_options_volatility_producer",
        "finance_framework_event_driven_producer",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "options_iv_skew_gamma_and_event_calendar",
        "latest_filing_or_event_source",
        "target_etf_price_and_regime_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_options_trade_advice",
        "no_model_math_guessing",
        "risk_gate_before_action_language",
      ],
      next_step:
        "treat_options_iv_as_event_risk_context_require_event_source_iv_inputs_position_exposure_and_review_not_trade_instruction",
      rejected_context: [
        "old_lark_conversation_history",
        "options_strategy_recommendation",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeExternalMissingSource(text)) {
    return {
      ...safe,
      task_family: "external_source_learning_missing_source",
      primary_modules: ["finance_learning_memory", "source_registry"],
      supporting_modules: ["review_panel", "control_room_summary"],
      required_tools: [
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "review_panel",
      ],
      missing_data: ["source_url_or_local_source_path"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "return_source_required_failed_reason_and_ask_for_link_or_local_file",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }

  if (looksLikeExternalCoverage(text)) {
    return {
      ...safe,
      task_family: "external_source_coverage_honesty",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "source_registry",
        "finance_learning_memory",
        "causal_map",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "finance_learning_retrieval_review",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "source_url_or_local_source_path",
        "actual_reading_scope",
        "source_coverage_limits",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "evidence_required",
        "do_not_claim_exhaustive_coverage",
        "no_execution_authority",
      ]),
      next_step:
        "collect_or_verify_source_list_then_report_actual_reading_scope_before_any_learning_claim",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "unverified_full_coverage_claim",
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ]),
    };
  }

  if (looksLikeAgentSkillLearning(text)) {
    return {
      ...safe,
      task_family: "agent_skill_pattern_distillation",
      primary_modules: [
        "skill_pattern_distillation",
        "agent_workflow_memory",
        "source_registry",
        "review_panel",
      ],
      supporting_modules: [
        "eval_harness_design",
        "control_room_summary",
        "finance_learning_memory",
      ],
      required_tools: [
        "skill_harvester",
        "source_registry_lookup",
        "skill_isolation_review",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "candidate_skill_source_or_local_skill_path",
        "target_workflow_acceptance_metric",
        "license_and_write_scope_review",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "untrusted_external_skill",
        "evaluate_before_installing",
        "no_protected_memory_write",
        "no_provider_config_change",
        "no_live_sender_change",
        "no_trading_execution_skill",
      ],
      next_step:
        "collect_candidate_skill_sources_review_license_and_write_scope_then_distill_safe_workflow_into_local_skill_and_eval_case",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
        "cloud_skill_sharing_by_default",
        "market_alpha_claim_without_source",
      ],
    };
  }

  if (looksLikePaperLearningWithSource(text)) {
    return {
      ...safe,
      task_family: "paper_learning_internalization_planning",
      primary_modules: [
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "etf_regime",
        "quant_math",
        "eval_harness_design",
      ]),
      required_tools: [
        "finance_learning_pipeline_orchestrator",
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "review_panel",
      ],
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "actual_reading_scope",
        "source_artifact_path",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "replication_or_sample_out_evidence",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_trade_advice",
        "no_doctrine_mutation",
        "no_model_internal_learning_claim_without_eval",
        "do_not_promote_unverified_memory_claims",
        "backtest_overfit_check_required",
        "sample_out_validation_required",
      ]),
      next_step:
        "verify_source_registry_and_reading_scope_then_attach_capability_run_apply_validation_and_add_eval_or_training_absorption_case",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "unverified_paper_summary",
        "paper_backtest_as_trade_rule",
        "model_internal_learning_claim_without_training_eval_evidence",
        "old_lark_conversation_history",
      ]),
    };
  }

  if (looksLikeUnverifiedLiveMarketData(text)) {
    return {
      ...safe,
      task_family: "unverified_live_market_data_research_preflight",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "source_registry",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "etf_regime",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "source_registry_lookup",
        "fresh_market_data_collection_preflight",
        "artifact_memory_recall",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "memory_recall_scope_or_relevant_receipts",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_live_data",
        "no_trade_advice",
      ]),
      next_step:
        "mark_live_market_claims_unverified_until_source_timestamp_and_fresh_data_snapshot_are_available_then_run_review",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "unverified_live_market_claim",
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "trade_recommendation_without_evidence",
      ]),
    };
  }

  if (looksLikeBacktestOverfitStrategyLearning(text)) {
    return {
      ...safe,
      task_family: "factor_timing_overfit_resistant_learning",
      primary_modules: [
        "quant_math",
        "finance_learning_memory",
        "source_registry",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: ["causal_map", "etf_regime", "control_room_summary"],
      required_tools: [
        "finance_learning_pipeline_orchestrator",
        "source_registry_lookup",
        "quant_math",
        "review_panel",
      ],
      missing_data: [
        "strategy_source_or_research_note",
        "sample_out_validation_plan",
        "survivor_bias_and_lookahead_bias_check",
        "walk_forward_or_cross_validation_evidence",
        "failure_regime_and_invalidation_condition",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_trade_advice",
        "backtest_overfit_check_required",
        "sample_out_validation_required",
        "survivor_bias_check_required",
      ],
      next_step:
        "convert_strategy_into_hypothesis_with_bias_checks_sample_out_plan_failure_regime_and_review_before_any_reusable_rule",
      rejected_context: [
        "old_lark_conversation_history",
        "backtest_as_profit_claim",
        "single_sample_factor_myth",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeCryptoLeverageBoundary(text)) {
    return {
      ...safe,
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
    };
  }

  if (looksLikeSentimentMarketModuleLearning(text)) {
    return {
      ...safe,
      task_family: "sentiment_market_module_learning_preflight",
      primary_modules: [
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "quant_math",
        "eval_harness_design",
        "review_panel",
      ],
      supporting_modules: [
        "us_equity_market_structure",
        "global_index_regime",
        "crypto_market_structure",
        "portfolio_risk_gates",
        "control_room_summary",
      ],
      required_tools: [
        "skill_harvester",
        "source_registry_lookup",
        "license_and_write_scope_review",
        "finance_learning_capability_apply",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "candidate_repo_url_or_local_source_path",
        "license_and_write_scope_review",
        "sentiment_data_source_and_timestamp_policy",
        "validation_dataset_and_sample_out_plan",
        "integration_acceptance_metric",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "untrusted_external_source",
        "backtest_overfit_check_required",
        "sample_out_validation_required",
        "sentiment_signal_not_standalone_alpha",
        "no_trade_advice",
      ],
      next_step:
        "review_repo_license_data_sources_and_validation_plan_then_distill_sentiment_as_one_evidence_layer_with_eval_gate",
      rejected_context: [
        "old_lark_conversation_history",
        "market_alpha_claim_without_source",
        "sentiment_as_standalone_trade_signal",
        "cloud_skill_sharing_by_default",
      ],
    };
  }

  if (looksLikeFilingResearchMissingEvidence(text)) {
    return {
      ...safe,
      task_family: "company_filing_missing_evidence_preflight",
      primary_modules: ["company_fundamentals_value", "source_registry", "portfolio_risk_gates"],
      supporting_modules: [
        "causal_map",
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ],
      required_tools: [
        "finance_framework_company_fundamentals_value_producer",
        "source_registry_lookup",
        "review_panel",
      ],
      missing_data: [
        "latest_10q_10k_or_earnings_release",
        "guidance_revision_margin_revenue_and_valuation_inputs",
        "source_timestamp_and_vendor",
        "portfolio_exposure_context_if_relevant",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_filing_claims",
        "no_trade_advice",
      ],
      next_step:
        "request_or_collect_filing_source_before_stating_fundamental_claims_then_route_to_review_panel",
      rejected_context: [
        "old_lark_conversation_history",
        "unverified_filing_summary",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeModelReviewDisagreement(text)) {
    return {
      ...safe,
      task_family: "model_review_disagreement_resolution",
      primary_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["quant_math", "ops_audit"],
      required_tools: [
        "artifact_memory_recall",
        "source_registry_lookup",
        "finance_learning_capability_apply",
        "review_panel",
      ],
      missing_data: ["memory_recall_scope_or_relevant_receipts", "fresh_task_inputs"],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "do_not_pick_model_answer_without_evidence",
        "no_trade_advice",
      ],
      next_step:
        "recall_local_rules_then_compare_model_claims_by_source_assumption_and_missing_data_before_control_room_summary",
      rejected_context: [
        "old_lark_conversation_history",
        "single_model_authority_claim",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeMacroEventRiskPreflight(text)) {
    return {
      ...safe,
      task_family: "macro_event_risk_research_preflight",
      primary_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: [
        "cross_asset_liquidity",
        "us_equity_market_structure",
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "control_room_summary",
      ],
      required_tools: [
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "current_rates_and_inflation_inputs",
        "current_credit_and_liquidity_inputs",
        "target_etf_price_and_regime_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_same_day_price_prediction",
        "risk_gate_before_action_language",
      ],
      next_step:
        "frame_event_risk_as_preflight_scenarios_then_collect_macro_liquidity_etf_position_and_review_inputs",
      rejected_context: [
        "old_lark_conversation_history",
        "same_day_price_prediction",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeRebalanceExecutionBoundary(text)) {
    return {
      ...safe,
      task_family: "portfolio_rebalance_execution_boundary",
      primary_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: ["finance_learning_memory", "source_registry", "control_room_summary"],
      required_tools: [
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: ["position_weights_and_return_series", "portfolio_weights_and_risk_limits"],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ],
      next_step:
        "convert_rebalance_wording_into_research_only_portfolio_risk_analysis_and_request_weights_limits",
      rejected_context: [
        "old_lark_conversation_history",
        "execution_instruction",
        "order_entry_language",
      ],
    };
  }

  if (looksLikeTechnicalTimingNotStandalone(text)) {
    return {
      ...safe,
      task_family: "technical_timing_not_standalone_alpha",
      primary_modules: [
        "etf_regime",
        "us_equity_market_structure",
        "quant_math",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "causal_map",
        "finance_learning_memory",
        "control_room_summary",
      ],
      required_tools: [
        "finance_framework_etf_regime_producer",
        "finance_framework_us_equity_market_structure_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "price_volume_breadth_and_technical_regime_inputs",
        "macro_liquidity_context_inputs",
        "position_weights_and_risk_limits",
        "invalidation_condition_for_timing_signal",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "technical_timing_not_standalone_alpha",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ],
      next_step:
        "use_technical_inputs_only_for_timing_context_after_macro_liquidity_and_risk_gate_review",
      rejected_context: [
        "old_lark_conversation_history",
        "single_factor_technical_story",
        "technical_pattern_as_trade_recommendation",
      ],
    };
  }

  if (looksLikeFullStackFinanceStressTest(text)) {
    return {
      ...safe,
      task_family: "full_stack_finance_stress_research_planning",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        ...inferFinanceModulesFromLocalKnowledgeText(text),
        "company_fundamentals_value",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "fx_dollar",
        "us_equity_market_structure",
        "global_index_regime",
        "etf_regime",
        "technical_timing",
        "quant_math",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "artifact_memory_recall",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_cross_asset_liquidity_producer",
        "finance_framework_fx_currency_liquidity_producer",
        "finance_framework_fx_dollar_producer",
        "finance_framework_us_equity_market_structure_producer",
        "finance_framework_global_index_regime_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "memory_recall_scope_or_relevant_receipts",
        "latest_10q_10k_or_earnings_release",
        "guidance_revision_margin_revenue_and_valuation_inputs",
        "current_rates_inflation_fed_path_and_liquidity_inputs",
        "position_weights_cost_basis_and_risk_limits",
        "price_volume_breadth_and_technical_regime_inputs",
        "portfolio_weights_and_risk_limits",
        "red_team_invalidation_evidence",
        "fresh_market_data_snapshot",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_model_math_guessing",
        "no_unverified_live_data",
        "red_team_invalidation_required",
        "no_trade_advice",
      ]),
      next_step:
        "recall_local_finance_rules_then_collect_fundamental_macro_position_technical_inputs_build_causal_map_run_quant_risk_gates_and_red_team_review_before_control_room_summary",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
        "single_factor_technical_story",
        "unverified_live_market_claim",
        "trade_recommendation_without_evidence",
      ]),
    };
  }

  if (looksLikeEtfAsCompanyFundamentalTrap(text)) {
    return {
      ...safe,
      task_family: "etf_fund_structure_research_planning",
      primary_modules: [
        "etf_regime",
        "macro_rates_inflation",
        "fx_dollar",
        "fx_currency_liquidity",
        "commodities_oil_gold",
        "cross_asset_liquidity",
        "portfolio_risk_gates",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["finance_learning_memory", "causal_map", "quant_math"],
      required_tools: [
        "source_registry_lookup",
        "finance_framework_etf_regime_producer",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_fx_dollar_producer",
        "finance_framework_commodities_oil_gold_producer",
        "finance_framework_cross_asset_liquidity_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "fund_or_etf_prospectus_or_fact_sheet",
        "fund_holdings_nav_or_index_methodology_context",
        "fresh_market_data_snapshot",
        "current_position_weights",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_live_data",
        "no_trade_advice",
      ],
      next_step:
        "treat_the_symbol_as_fund_or_etf_structure_research_require_fact_sheet_holdings_nav_or_methodology_context_and_reject_company_fundamental_labels",
      rejected_context: [
        "old_lark_conversation_history",
        "single_company_fundamental_labels_for_etf",
        "company_revenue_quality_for_fund",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikePostMortemCorrection(text)) {
    return {
      ...safe,
      task_family: "finance_post_mortem_correction_learning",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        ...inferFinanceModulesFromLocalKnowledgeText(text),
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "control_room_summary",
        "ops_audit",
      ]),
      required_tools: [
        "artifact_memory_recall",
        "source_registry_lookup",
        "finance_learning_capability_apply",
        "review_panel",
      ],
      missing_data: ["memory_recall_scope_or_relevant_receipts", "fresh_task_inputs"],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "do_not_promote_unverified_memory_claims",
        "correction_note_required",
      ],
      next_step:
        "identify_wrong_premise_stale_data_or_risk_gate_failure_then_write_correction_note_before_new_rule",
      rejected_context: [
        "old_lark_conversation_history",
        "silent_memory_rewrite",
        "unverified_new_rule",
      ],
    };
  }

  if (looksLikeAnalystReportLearning(text)) {
    return {
      ...safe,
      task_family: "analyst_report_learning_source_quality_review",
      primary_modules: [
        "company_fundamentals_value",
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: ["control_room_summary"],
      required_tools: [
        "source_registry_lookup",
        "finance_framework_company_fundamentals_value_producer",
        "finance_learning_capability_apply",
        "review_panel",
      ],
      missing_data: [
        "source_url_or_local_source_path",
        "latest_company_fundamental_inputs",
        "portfolio_weights_and_risk_limits",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_trade_advice",
        "do_not_promote_unverified_memory_claims",
      ],
      next_step:
        "extract_report_assumptions_source_quality_and_sensitivity_then_red_team_before_learning",
      rejected_context: [
        "old_lark_conversation_history",
        "analyst_price_target_as_fact",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeCrossMarketFinance(text)) {
    return {
      ...safe,
      task_family: "cross_market_finance_research_planning",
      primary_modules: mergeUnique(
        mentionsCryptoMarket(input.ask)
          ? arrayValue(safe.primary_modules)
          : withoutValues(arrayValue(safe.primary_modules), ["crypto_market_structure"]),
        [
          "macro_rates_inflation",
          "credit_liquidity",
          "cross_asset_liquidity",
          "fx_currency_liquidity",
          ...inferCrossMarketFinanceModules(input.ask),
          "quant_math",
          "portfolio_risk_gates",
        ],
      ),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(
        mentionsCryptoMarket(input.ask)
          ? arrayValue(safe.required_tools)
          : withoutValues(arrayValue(safe.required_tools), [
              "finance_framework_crypto_market_structure_producer",
            ]),
        [
          "artifact_memory_recall",
          "finance_learning_capability_apply",
          "source_registry_lookup",
          "finance_framework_macro_rates_inflation_producer",
          "finance_framework_credit_liquidity_producer",
          "finance_framework_cross_asset_liquidity_producer",
          "finance_framework_fx_currency_liquidity_producer",
          "finance_framework_us_equity_market_structure_producer",
          "finance_framework_china_a_share_policy_flow_producer",
          "finance_framework_global_index_regime_producer",
          ...(mentionsCryptoMarket(input.ask)
            ? ["finance_framework_crypto_market_structure_producer"]
            : []),
          "quant_math",
          "finance_framework_portfolio_risk_gates_producer",
          "review_panel",
        ],
      ),
      missing_data: mergeUnique(
        withoutValues(arrayValue(safe.missing_data), [
          "new_subject_or_original_request",
          "current_subject_or_original_request",
          ...(mentionsCryptoMarket(input.ask)
            ? []
            : ["crypto_liquidity_volatility_custody_and_regulatory_inputs"]),
        ]),
        [
          "memory_recall_scope_or_relevant_receipts",
          "fresh_market_data_snapshot",
          "us_equity_breadth_earnings_and_valuation_inputs",
          "china_a_share_policy_liquidity_and_northbound_inputs",
          "index_constituents_weights_and_technical_regime_inputs",
          ...(mentionsCryptoMarket(input.ask)
            ? ["crypto_liquidity_volatility_custody_and_regulatory_inputs"]
            : []),
          "fx_dollar_yuan_and_global_liquidity_inputs",
          "position_weights_and_return_series",
          "portfolio_weights_and_risk_limits",
        ],
      ),
      risk_boundaries: mergeUnique(
        mentionsCryptoMarket(input.ask)
          ? cleanRiskBoundaries(safe.risk_boundaries)
          : withoutValues(cleanRiskBoundaries(safe.risk_boundaries), ["no_high_leverage_crypto"]),
        [
          "research_only",
          "no_execution_authority",
          "evidence_required",
          "no_model_math_guessing",
          ...(mentionsCryptoMarket(input.ask) ? ["no_high_leverage_crypto"] : []),
          "no_unverified_cross_market_claims",
          "do_not_promote_unverified_memory_claims",
          "risk_gate_before_action_language",
          "no_trade_advice",
        ],
      ),
      next_step:
        "recall_local_finance_rules_then_build_cross_market_causal_map_collect_fresh_inputs_run_quant_and_review_before_control_room_summary",
      rejected_context: mergeUnique(
        mentionsCryptoMarket(input.ask)
          ? arrayValue(safe.rejected_context)
          : withoutValues(arrayValue(safe.rejected_context), [
              "execution_or_high_leverage_crypto_instruction",
            ]),
        [
          "old_lark_conversation_history",
          "language_routing_candidate_artifacts",
          "unsupported_execution_language",
          ...(mentionsCryptoMarket(input.ask)
            ? ["execution_or_high_leverage_crypto_instruction"]
            : []),
          "trade_recommendation_without_evidence",
        ],
      ),
    };
  }

  if (looksLikeLocalKnowledgeActivation(text)) {
    return {
      ...safe,
      task_family: "local_memory_knowledge_activated_research_planning",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        ...inferFinanceModulesFromLocalKnowledgeText(text),
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "artifact_memory_recall",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "memory_recall_scope_or_relevant_receipts",
        "fresh_task_inputs",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "do_not_promote_unverified_memory_claims",
      ]),
      next_step:
        "recall_relevant_local_memory_and_rules_then_decompose_modules_before_model_review",
    };
  }

  if (looksLikeCompanyToPortfolioRisk(text)) {
    return {
      ...safe,
      task_family: "company_fundamental_portfolio_risk_planning",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        ...inferFinanceModulesFromLocalKnowledgeText(text),
        "company_fundamentals_value",
        "causal_map",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_causal_map_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "latest_company_fundamental_inputs",
        "portfolio_weights_and_risk_limits",
        "company_to_portfolio_exposure_map",
      ]),
      next_step: "build_company_to_portfolio_causal_plan_then_require_fresh_evidence",
    };
  }

  if (looksLikePortfolioMathMissingInputs(text)) {
    return {
      ...safe,
      task_family: "portfolio_quant_math_missing_inputs",
      primary_modules: mergeUnique(
        withoutValues(arrayValue(safe.primary_modules), [
          "company_fundamentals_value",
          "causal_map",
        ]),
        ["quant_math", "portfolio_risk_gates", "etf_regime", "macro_rates_inflation"],
      ),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_macro_rates_inflation_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "position_weights_and_return_series",
      ]),
      next_step: "request_position_weights_and_return_series_before_any_local_math",
    };
  }

  if (looksLikePortfolioMacroRisk(text)) {
    return {
      ...safe,
      task_family: "portfolio_macro_risk_research_planning",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "control_room_summary",
        "review_panel",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "current_rates_and_inflation_inputs",
        "current_credit_and_liquidity_inputs",
        "target_etf_price_and_regime_inputs",
        "latest_company_fundamental_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ]),
      next_step: "request_fresh_inputs_then_route_to_concrete_finance_modules",
    };
  }

  if (looksLikeEtfTimingFramework(text)) {
    return {
      ...safe,
      task_family: "low_frequency_etf_timing_planning",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "quant_math",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "control_room_summary",
        "review_panel",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "position_weights_and_return_series",
      ]),
      next_step: "route_to_macro_liquidity_etf_math_risk_modules_before_visible_summary",
    };
  }

  return safe;
}

function inferFinanceModulesFromLocalKnowledgeText(text: string): string[] {
  const modules: string[] = [];
  if (/(利率|通胀|real yield|yield|fed|tlt|duration|macro)/iu.test(text)) {
    modules.push("macro_rates_inflation");
  }
  if (/(流动性|美元|dollar|liquidity|credit|信用)/iu.test(text)) {
    modules.push("credit_liquidity");
  }
  if (/(etf|qqq|spy|tlt|iwm|择时|timing|regime)/iu.test(text)) {
    modules.push("etf_regime");
  }
  if (
    /(技术面|technical|均线|rsi|macd|趋势|trend|动量|momentum|breadth|择时|timing)/iu.test(text)
  ) {
    modules.push("technical_timing");
  }
  if (/(期权|options?|iv\b|implied vol|隐含波动|gamma|skew|vega|波动率曲面)/iu.test(text)) {
    modules.push("options_volatility");
  }
  if (
    /(大宗商品|commodity|commodities|原油|石油|crude|oil|黄金|gold|铜|copper|gld|dbc|uso|dba)/iu.test(
      text,
    )
  ) {
    modules.push("commodities_oil_gold");
  }
  if (/(美元|外汇|汇率|fx|dxy|uup|usd|cnh|cny|yen|日元|euro|欧元)/iu.test(text)) {
    modules.push("fx_dollar");
  }
  if (/(事件|催化|财报日|fomc|cpi|ppi|earnings|event|catalyst|policy|地缘|突发)/iu.test(text)) {
    modules.push("event_driven");
  }
  if (/(美股|us equities|us stocks?|nasdaq|s&p|spx|spy|qqq|iwm|nvda|msft|aapl)/iu.test(text)) {
    modules.push("us_equity_market_structure");
  }
  if (/(a股|a-share|沪深|上证|深证|创业板|科创|北向|人民币资产|中国权益)/iu.test(text)) {
    modules.push("china_a_share_policy_flow");
  }
  if (
    /(指数|indices|index|沪深300|中证|纳指|道指|标普|恒生|msci|russell|qqq|spy|iwm|nasdaq|s&p|spx)/iu.test(
      text,
    )
  ) {
    modules.push("global_index_regime");
  }
  if (mentionsCryptoMarket(text)) {
    modules.push("crypto_market_structure");
  }
  if (/(nvda|公司|基本面|fundamental|capex|估值|revenue|earnings|ai capex)/iu.test(text)) {
    modules.push("company_fundamentals_value");
  }
  if (/(数学|量化|波动|相关|回撤|correlation|volatility|drawdown)/iu.test(text)) {
    modules.push("quant_math");
  }
  return modules;
}

function inferCrossMarketFinanceModules(text: string): string[] {
  const modules = inferFinanceModulesFromLocalKnowledgeText(text);
  if (/(美元|人民币|汇率|fx|dxy|uup|usd|cnh|cny|yen|日元|套息|carry)/iu.test(text)) {
    modules.push("fx_currency_liquidity");
  }
  if (/(流动性|liquidity|credit|美元|stablecoin|资金|risk appetite|风险偏好|跨资产)/iu.test(text)) {
    modules.push("cross_asset_liquidity");
  }
  return mergeUnique(modules);
}
