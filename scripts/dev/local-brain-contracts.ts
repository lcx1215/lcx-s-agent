import {
  LOCAL_BRAIN_MODULE_TAXONOMY,
  normalizeLocalBrainModuleList,
  packLocalBrainModuleFields,
} from "./local-brain-taxonomy.js";

export type LocalBrainContractInput = {
  ask: string;
  sourceSummary?: string;
};

const MODULE_IDS = LOCAL_BRAIN_MODULE_TAXONOMY;

const MODULE_ID_SET = new Set<string>(MODULE_IDS);
const CONTRACT_FIELD_TOKENS = [
  "research_only",
  "no_execution_authority",
  "evidence_required",
  "no_model_math_guessing",
  "no_unverified_current_market_data",
  "no_trade_advice",
  "missing_data",
  "risk_boundaries",
  "next_step",
  "rejected_context",
  "required_tools",
] as const;
const CONTRACT_BOUNDARY_TOKENS = [
  "do_not_promote_unverified_memory_claims",
  "no_high_leverage_crypto",
  "no_external_channel_sender_change",
  "no_model_math_guessing",
  "no_unverified_current_market_data",
  "no_unverified_current_market_data_claims",
  "no_protected_memory_write",
  "no_provider_config_change",
  "no_trade_advice",
  "no_unverified_live_data",
  "no_unverified_live_data_claims",
  "research_only",
  "risk_gate_before_action_language",
  "technical_timing_not_standalone_alpha",
] as const;

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

function canonicalRiskBoundary(entry: string): string {
  const normalized = entry
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (
    normalized.includes("no_high_leverage_crypto") ||
    normalized === "no_high_leverage" ||
    normalized === "no_leverage_on_crypto" ||
    normalized === "no_crypto_leverage_recommendation" ||
    normalized === "no_crypto_leverage" ||
    normalized === "crypto_no_leverage" ||
    normalized === "no_crypto_high_leverage" ||
    normalized === "do_not_execute_crypto_leverage" ||
    normalized === "no_crypto_leverage_trade_recommendation" ||
    normalized === "no_crypto_high_leverage_trading"
  ) {
    return "no_high_leverage_crypto";
  }
  if (
    // Backward compatibility for older receipts/prompts; canonical output uses current-market wording.
    normalized === "no_live_market_claims" ||
    normalized === "no_live_market_claim" ||
    normalized === "no_live_finance_advice" ||
    normalized === "no_unverified_live_data" ||
    normalized === "no_unverified_live_data_claims" ||
    normalized === "no_unverified_live_market_data_claims" ||
    normalized === "no_unverified_current_market_claims" ||
    normalized === "no_unverified_current_market_claim" ||
    normalized === "no_unverified_current_market_data_claims"
  ) {
    return "no_unverified_current_market_data";
  }
  return normalized || entry.trim();
}

function canonicalMissingData(entry: string): string {
  const normalized = entry
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (
    normalized.includes("position_weights_and_return_series") ||
    (/(^|_)position_weights?($|_)|current_position_weights|asset_position_weights|portfolio_weight/u.test(
      normalized,
    ) &&
      /return_series|price_history|return_history|price_series/u.test(normalized))
  ) {
    return "position_weights_and_return_series";
  }
  return entry.trim();
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
  return arrayValue(value)
    .map(canonicalRiskBoundary)
    .filter((entry) => !blocked.has(entry));
}

function cleanModuleList(value: unknown): string[] {
  return arrayValue(value).filter((entry) => MODULE_ID_SET.has(entry));
}

function cleanMissingData(value: unknown): string[] {
  const blocked = new Set([...MODULE_IDS, ...CONTRACT_FIELD_TOKENS, ...CONTRACT_BOUNDARY_TOKENS]);
  const normalized = arrayValue(value)
    .map(canonicalMissingData)
    .filter((entry) => !blocked.has(entry));
  const lowerValues = normalized.map((entry) => entry.toLowerCase());
  const hasPositionWeights = lowerValues.some((entry) =>
    /(^|_)position_weights?($|_)|current_position_weights|asset_position_weights|portfolio_weight/u.test(
      entry,
    ),
  );
  const hasReturnSeries = lowerValues.some((entry) =>
    /return_series|price_history|return_history|price_series/u.test(entry),
  );
  return mergeUnique(
    hasPositionWeights && hasReturnSeries ? ["position_weights_and_return_series"] : [],
    normalized,
  );
}

function cleanRequiredTools(value: unknown): string[] {
  const blocked = new Set([...CONTRACT_FIELD_TOKENS, ...CONTRACT_BOUNDARY_TOKENS]);
  return normalizeLocalBrainModuleList(arrayValue(value).filter((entry) => !blocked.has(entry)));
}

function cleanRejectedContext(value: unknown): string[] {
  const blocked = new Set(CONTRACT_FIELD_TOKENS);
  return arrayValue(value).filter((entry) => !blocked.has(entry));
}

function basePlan(plan: Record<string, unknown>): Record<string, unknown> {
  const packedModules = packLocalBrainModuleFields(
    cleanModuleList(plan.primary_modules),
    cleanModuleList(plan.supporting_modules),
    cleanRequiredTools(plan.required_tools),
  );
  return {
    ...plan,
    primary_modules: packedModules.primary_modules,
    supporting_modules: packedModules.supporting_modules,
    required_tools: packedModules.required_tools,
    missing_data: cleanMissingData(plan.missing_data),
    risk_boundaries: mergeUnique(cleanRiskBoundaries(plan.risk_boundaries), [
      "research_only",
      "no_execution_authority",
      "evidence_required",
      "no_model_math_guessing",
    ]),
    rejected_context: mergeUnique(cleanRejectedContext(plan.rejected_context), [
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
    !looksLikeEnergyInflationShockRisk(text) &&
    !looksLikeFullStackFinanceStressTest(text) &&
    !looksLikeCrossMarketFinance(text) &&
    !looksLikeEtfAsCompanyFundamentalTrap(text) &&
    !looksLikePaperLearningWithSource(text) &&
    /(大宗商品|commodity|commodities|原油|石油|crude|oil|黄金|gold|铜|copper|gld|dbc|uso|dba)/iu.test(
      text,
    ) &&
    /(学习|学会|框架|模块|证据|缺口|research framework|应用|内化|沉淀)/iu.test(text)
  );
}

function looksLikeBroadFinanceModuleCoverage(text: string): boolean {
  if (
    looksLikeFullStackFinanceStressTest(text) ||
    (looksLikeLocalKnowledgeActivation(text) &&
      !/(全领域|全部金融|完整金融|金融模块|模块地图|模块体系)/iu.test(text))
  ) {
    return false;
  }
  const asksForModuleMap =
    /(金融模块|金融能力|全领域.{0,8}金融|金融.{0,8}全领域|模块地图|模块体系|能力层|module taxonomy|finance module|模块还不够|还不够.{0,12}模块|全部.{0,12}模块|所有.{0,12}模块|扩充.{0,12}模块|source registry.*review panel)/iu.test(
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
    !looksLikeAiCapexPowerGridConcentrationRisk(text) &&
    /(公司|基本面|价值投资|value investing|fundamental|capex|revenue|margin|earnings|估值|收入质量|客户集中度)/iu.test(
      text,
    ) &&
    /(组合|持仓|仓位|科技仓|etf sleeve|portfolio|sleeve|risk|风险|传导|连接|影响)/iu.test(text)
  );
}

function looksLikeValueInvestingFundamentalCore(text: string): boolean {
  const asksForValueInvesting =
    /(价值投资|长期投资|基本面优先|fundamentals?[- ]?first|value investing|intrinsic value|内在价值|安全边际|margin of safety|护城河|moat)/iu.test(
      text,
    );
  const namesValueEvidence =
    /(自由现金流|free cash flow|fcf|roic|资产负债表|balance sheet|管理层|资本配置|capital allocation|安全边际|margin of safety|护城河|moat|价值陷阱|value trap|内在价值|intrinsic value)/iu.test(
      text,
    );
  return asksForValueInvesting || namesValueEvidence;
}

function looksLikeFinancialModelingValuationQc(text: string): boolean {
  if (looksLikeExternalFinancialAgentPatternLearning(text)) {
    return false;
  }
  if (/(research artifact|产物|研报|报告|控制室总结|visible summary)/iu.test(text)) {
    return false;
  }
  if (
    looksLikeFilingResearchMissingEvidence(text) ||
    looksLikeCompanyToPortfolioRisk(text) ||
    looksLikeTechnicalTimingNotStandalone(text) ||
    looksLikeModelReviewDisagreement(text) ||
    looksLikeSentimentMarketModuleLearning(text) ||
    looksLikePaperLearningWithSource(text) ||
    looksLikeExternalKnowledgeInternalizationProtocol(text)
  ) {
    return false;
  }
  return (
    /(dcf|comps?|三表|财务模型|估值模型|敏感性|sensitivity|valuation model|financial model|model builder|audit[- ]?xls|spreadsheet)/iu.test(
      text,
    ) &&
    /(估值|valuation|现金流|fcf|multiple|倍数|假设|assumption|source|来源|审计|qc|核对)/iu.test(
      text,
    )
  );
}

function looksLikeThesisCatalystLifecycle(text: string): boolean {
  if (
    looksLikeExternalFinancialAgentPatternLearning(text) ||
    looksLikeFullStackFinanceStressTest(text) ||
    looksLikeCrossMarketFinance(text) ||
    looksLikeMacroEventRiskPreflight(text) ||
    looksLikeTechnicalTimingNotStandalone(text) ||
    looksLikeBacktestOverfitStrategyLearning(text) ||
    looksLikeCompanyToPortfolioRisk(text) ||
    looksLikeTreasurySupplyTermPremiumRisk(text) ||
    looksLikePrivateCreditNonbankLeverageRisk(text) ||
    looksLikeAiCapexPowerGridConcentrationRisk(text) ||
    looksLikeEnergyInflationShockRisk(text) ||
    looksLikePostMortemCorrection(text)
  ) {
    return false;
  }
  return (
    /(thesis|投资论点|研究论点|催化|catalyst|失效|invalidation|反方|red[- ]?team|post[- ]?event|事件后|复盘|correction note)/iu.test(
      text,
    ) && /(基本面|valuation|估值|event|事件|财报|portfolio|组合|风险|学习|沉淀)/iu.test(text)
  );
}

function looksLikeDataProvenanceQuality(text: string): boolean {
  if (
    looksLikeExternalFinancialAgentPatternLearning(text) ||
    looksLikePredictionMarketResearchStrategyLearning(text)
  ) {
    return false;
  }
  if (
    looksLikeCurrentMarketDataFreshnessGap(text) ||
    looksLikeFilingResearchMissingEvidence(text) ||
    looksLikeAnalystReportLearning(text) ||
    looksLikeSentimentMarketModuleLearning(text) ||
    looksLikeTreasurySupplyTermPremiumRisk(text) ||
    looksLikePrivateCreditNonbankLeverageRisk(text) ||
    looksLikeAiCapexPowerGridConcentrationRisk(text) ||
    looksLikeEnergyInflationShockRisk(text)
  ) {
    return false;
  }
  return /(data provenance|vendor|供应商|字段定义|field definition|口径|时间戳|timestamp|币种|复权|adjusted|更新频率|source quality|数据质量|数据源.*质量)/iu.test(
    text,
  );
}

function looksLikeResearchArtifactQc(text: string): boolean {
  if (looksLikeExternalFinancialAgentPatternLearning(text)) {
    return false;
  }
  if (/(claim|未验证|unverified).{0,80}(哪来的|source|artifact|receipt|出处|根据)/iu.test(text)) {
    return false;
  }
  if (
    looksLikePredictionMarketResearchStrategyLearning(text) ||
    looksLikePaperLearningWithSource(text) ||
    looksLikeExternalKnowledgeInternalizationProtocol(text) ||
    looksLikeAnalystReportLearning(text) ||
    looksLikeTreasurySupplyTermPremiumRisk(text) ||
    looksLikePrivateCreditNonbankLeverageRisk(text) ||
    looksLikeAiCapexPowerGridConcentrationRisk(text) ||
    looksLikeEnergyInflationShockRisk(text)
  ) {
    return false;
  }
  return (
    /(artifact|产物|研报|报告|表格|spreadsheet|模型输出|model output|number provenance|数字来源|cite every number|citation|QC)/iu.test(
      text,
    ) &&
    /(金融|finance|market|估值|valuation|财报|source|来源|数字|number|模型|model|summary|总结)/iu.test(
      text,
    )
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
    /(利率|ai capex|美元流动性|流动性|通胀|credit|macro|未来两周|风险)/iu.test(text) &&
    /(tlt|美元流动性|流动性|credit|duration|久期|fed|通胀)/iu.test(text)
  );
}

function looksLikeTreasurySupplyTermPremiumRisk(text: string): boolean {
  return (
    /(treasury supply|treasury issuance|refunding|term premium|fiscal deficit|bill supply|coupon supply|auction|美债供给|国债供给|财政赤字|再融资|发债|期限溢价|拍卖)/iu.test(
      text,
    ) && /(tlt|qqq|spy|duration|久期|收益率|利率|估值|portfolio|组合|持仓|风险|risk)/iu.test(text)
  );
}

function looksLikePrivateCreditNonbankLeverageRisk(text: string): boolean {
  return (
    /(private credit|nonbank|nbfi|leveraged loans?|semiliquid|redemption|basis trade|hedge fund|forced deleveraging|私募信用|非银|杠杆贷款|半流动|赎回|基差交易|对冲基金|被迫去杠杆)/iu.test(
      text,
    ) &&
    /(credit|liquidity|hyg|lqd|qqq|spy|etf|risk appetite|portfolio|组合|风险|流动性|信用|利差)/iu.test(
      text,
    )
  );
}

function looksLikeAiCapexPowerGridConcentrationRisk(text: string): boolean {
  const hasSpecificAiInfrastructureCue =
    /(hyperscaler|data center|power grid|electricity demand|hbm|semiconductor equipment|gpu delivery|云厂商|数据中心|电力|电网|HBM|半导体设备|GPU交付)/iu.test(
      text,
    );
  return (
    /(ai capex|hyperscaler|data center|power grid|electricity demand|hbm|semiconductor equipment|gpu delivery|index concentration|mag7|云厂商|数据中心|电力|电网|HBM|半导体设备|GPU交付|指数集中度|AI集中度)/iu.test(
      text,
    ) &&
    hasSpecificAiInfrastructureCue &&
    /(nvda|qqq|soxx|smh|科技仓|基本面|估值|供应链|组合|portfolio|risk|风险|传导)/iu.test(text)
  );
}

function looksLikeEnergyInflationShockRisk(text: string): boolean {
  const hasEnergySupplyShockCue =
    /(opec|strait of hormuz|hormuz|spr|supply shock|gasoline|inventory shock|能源价格|油价|OPEC|霍尔木兹|战略储备|供给冲击|汽油|原油库存冲击)/iu.test(
      text,
    );
  return (
    hasEnergySupplyShockCue &&
    /(inflation|cpi|pce|rates|fed|dxy|美元|tlt|qqq|spy|portfolio|通胀|利率|美联储|组合|风险|股债同跌)/iu.test(
      text,
    )
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
    !looksLikePortfolioMacroRisk(text) &&
    !looksLikeCompanyToPortfolioRisk(text) &&
    !looksLikeResearchArtifactQc(text) &&
    !looksLikeExternalCoverage(text) &&
    !looksLikeFilingResearchMissingEvidence(text) &&
    !looksLikeSentimentMarketModuleLearning(text) &&
    !looksLikeCurrentMarketDataFreshnessGap(text) &&
    !looksLikeDataConflictReconciliation(text) &&
    /(哪来的|来源|source|artifact|receipt|citation|证据|unverified|未验证|出处|根据什么)/iu.test(
      text,
    ) &&
    /(claim|说法|结论|判断|纳指|qqq|spy|tlt|nvda|美元流动性|市场|宏观|指数|股市)/iu.test(text) &&
    /(没有|无|缺|missing|unverified|标)/iu.test(text)
  );
}

function looksLikeDataConflictReconciliation(text: string): boolean {
  if (looksLikePredictionMarketResearchStrategyLearning(text)) {
    return false;
  }
  if (
    /(采访|访谈|interview|博客|blog|substack|播客|podcast|饭局|晚餐|炸鸡|chimaek|kkanbu|viral)/iu.test(
      text,
    ) &&
    !/(不同数据源|数据源.*不一致|vendor|供应商|conflict|冲突|口径)/iu.test(text)
  ) {
    return false;
  }
  return (
    !looksLikeCurrentMarketDataFreshnessGap(text) &&
    !looksLikePaperLearningWithSource(text) &&
    !looksLikeFinancialModelingValuationQc(text) &&
    !looksLikeSentimentVendorConflictValidation(text) &&
    /(不同数据源|数据源.*不一致|vendor|data source|conflict|冲突|口径|时间戳|timestamp)/iu.test(
      text,
    ) &&
    /(etf|成分|权重|成交量|情绪|sentiment|行情|market data|source registry|审阅|review)/iu.test(
      text,
    )
  );
}

function looksLikeSentimentVendorConflictValidation(text: string): boolean {
  return (
    /(新闻情绪|社媒情绪|news sentiment|social sentiment|风险偏好)/iu.test(text) &&
    /(vendor|供应商|不同数据源|冲突|conflict|互相冲突|不一致)/iu.test(text) &&
    /(样本外|sample[- ]?out|standalone alpha|单独.*alpha|独立.*alpha|审阅|review|validation|验证)/iu.test(
      text,
    )
  );
}

function looksLikeAlternativeMarketSignalSource(text: string): boolean {
  return (
    !looksLikeSentimentVendorConflictValidation(text) &&
    !looksLikeSentimentMarketModuleLearning(text) &&
    !looksLikeDataConflictReconciliation(text) &&
    /(采访|访谈|interview|博客|blog|substack|播客|podcast|饭局|晚餐|炸鸡|chimaek|kkanbu|ceo.{0,12}(meeting|dinner)|社媒|舆情|market sentiment|情绪|viral|传闻|rumou?r)/iu.test(
      text,
    ) &&
    /(市场|股价|暴涨|供应链|hbm|ai|capex|三星|samsung|海力士|hynix|英伟达|nvidia|黄仁勋|jensen|公司|产业|fundamental|基本面|信号|线索|学习|沉淀)/iu.test(
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
    /(券商研报|analyst report|目标价|price target|sell[- ]?side|评级|rating)/iu.test(text) &&
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
    !looksLikeEnergyInflationShockRisk(text) &&
    /(fomc|cpi|议息|通胀数据|利率决议|事件风险|event risk)/iu.test(text) &&
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

function looksLikePlainLanguageHiddenComplexityIntake(text: string): boolean {
  const namesHiddenComplexity =
    /(短口语|表层请求|隐藏复杂|很短的话|hidden[-_ ]?complexity|按字面短答|literal short|plain[- ]language).{0,120}(问题族|failure family|工作流|workflow|shared contract|共享契约|regression proof|回归证明|抽象|模块|review panel|人话总结|user[- ]visible)/iu.test(
      text,
    ) ||
    /(问题族|failure family|工作流|workflow|shared contract|共享契约|regression proof|回归证明|抽象|模块|review panel|人话总结|user[- ]visible).{0,120}(短口语|表层请求|隐藏复杂|很短的话|hidden[-_ ]?complexity|按字面短答|literal short|plain[- ]language)/iu.test(
      text,
    );
  const givesShortExamples =
    /(分析最近股市|持仓多少|学习大宗商品|读这篇论文|lark 回复|回复看不懂|recent market|position sizing|learn commodities|read this paper)/iu.test(
      text,
    );
  return namesHiddenComplexity && givesShortExamples;
}

function looksLikePlainRecentMarketBrief(text: string): boolean {
  return (
    !looksLikeCurrentMarketDataFreshnessGap(text) &&
    !looksLikePaperLearningWithSource(text) &&
    /(最近|今天|这几天|近期|当前|now|recent|latest)/iu.test(text) &&
    /(股市|市场|大盘|美股|a股|指数|stock market|market|stocks?|equities|qqq|spy|纳指|标普)/iu.test(
      text,
    ) &&
    /(分析|怎么看|看法|brief|summary|研究|判断|怎么拆|复盘)/iu.test(text)
  );
}

function looksLikePlainPositionSizingPreflight(text: string): boolean {
  const namesPositionSizing =
    /(持仓多少|仓位多少|仓位该多少|配多少|加多少|减多少|position sizing|allocation|how much).{0,80}(股票|个股|qqq|spy|nvda|msft|aapl|tlt|etf|stock|position)?/iu.test(
      text,
    ) ||
    /(关注|持有|拿着|想买|想加|想减|watch|hold|buy|add|reduce).{0,60}(仓位|持仓|position|allocation|多少|比例|权重)/iu.test(
      text,
    );
  return (
    namesPositionSizing &&
    !looksLikePaperLearningWithSource(text) &&
    !looksLikeExternalKnowledgeInternalizationProtocol(text) &&
    !looksLikeMacroEventRiskPreflight(text) &&
    !looksLikeFullStackFinanceStressTest(text) &&
    !looksLikeCrossMarketFinance(text)
  );
}

function looksLikePlainBuyHoldBoundary(text: string): boolean {
  return (
    !looksLikePaperLearningWithSource(text) &&
    !looksLikeExternalKnowledgeInternalizationProtocol(text) &&
    !looksLikeOffensiveStockOpportunityResearch(text) &&
    !looksLikeMacroEventRiskPreflight(text) &&
    !looksLikeFullStackFinanceStressTest(text) &&
    !looksLikeCrossMarketFinance(text) &&
    /(还能不能拿|要不要买|该不该买|能不能买|要不要加|要不要减|该不该卖|要不要卖|should i buy|should i hold|should i sell|add to position|reduce position)/iu.test(
      text,
    ) &&
    /(股票|个股|qqq|spy|nvda|msft|aapl|tlt|etf|stock|position|仓位|持仓)?/iu.test(text)
  );
}

function looksLikeOffensiveStockOpportunityResearch(text: string): boolean {
  if (
    looksLikeFullStackFinanceStressTest(text) ||
    looksLikeBroadFinanceModuleCoverage(text) ||
    looksLikeCrossMarketFinance(text) ||
    looksLikeFinancialModelingValuationQc(text) ||
    looksLikeThesisCatalystLifecycle(text) ||
    looksLikeDataProvenanceQuality(text) ||
    looksLikeResearchArtifactQc(text) ||
    looksLikeExternalFinancialAgentPatternLearning(text)
  ) {
    return false;
  }
  const asksForOpportunity =
    /(推荐股|好股|潜在.{0,8}股|选股|股票池|观察池|跨行业|全市场|行业轮动|watchlist|stock pick|stock screen|opportunit|mispricing|upside|alpha candidate|被低估|低估|弹性|前瞻|冒险|小仓位|试错)/iu.test(
      text,
    );
  const namesThematicOpportunity =
    /(美光|micron|\bmu\b|sk\s*海力士|海力士|hynix|三星|samsung|hbm|dram|nand|存储|半导体|ai\s*supply chain|ai\s*供应链|能源|油气|电力|公用事业|医疗|医药|生物科技|金融|银行|保险|工业|军工|航空|消费|零售|软件|网络安全|小盘|中盘|周期股|commodity producer|energy|utility|healthcare|biotech|financials?|banks?|insurance|industrials?|defen[cs]e|consumer|software|cybersecurity|small caps?|mid caps?)/iu.test(
      text,
    ) &&
    /(对比|谁更好|谁更有弹性|机会|潜在|好股|选股|推荐|研究|估值|周期|前瞻|冒险|轮动|被低估|mispricing|upside)/iu.test(
      text,
    );
  return (
    !looksLikePaperLearningWithSource(text) &&
    !looksLikeExternalKnowledgeInternalizationProtocol(text) &&
    !looksLikePredictionMarketResearchStrategyLearning(text) &&
    (asksForOpportunity || namesThematicOpportunity) &&
    /(股票|个股|公司|美股|行业|板块|科技股|equity|stock|company|sector|candidate|watchlist|screen|研究|推荐|找|pick|idea|idea generation)/iu.test(
      text,
    )
  );
}

function looksLikeCrossMarketFinance(text: string): boolean {
  if (
    looksLikeTreasurySupplyTermPremiumRisk(text) ||
    looksLikePrivateCreditNonbankLeverageRisk(text) ||
    looksLikeAiCapexPowerGridConcentrationRisk(text) ||
    looksLikeEnergyInflationShockRisk(text)
  ) {
    return false;
  }
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
  if (
    looksLikeTreasurySupplyTermPremiumRisk(text) ||
    looksLikePrivateCreditNonbankLeverageRisk(text) ||
    looksLikeAiCapexPowerGridConcentrationRisk(text) ||
    looksLikeEnergyInflationShockRisk(text)
  ) {
    return false;
  }
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
  if (
    looksLikeFullStackFinanceStressTest(text) ||
    looksLikeCrossMarketFinance(text) ||
    looksLikeBroadFinanceModuleCoverage(text)
  ) {
    return false;
  }
  return (
    /(skill|skills|skill\.md|agent skill|microagent|openhands|hugging face|agent结构|本地agent|本地 agent|金融agent|金融 agent|financial agent|agent plugins?|managed agents?|智能体插件|技能|工作流|workflow|harness|hermes)/iu.test(
      text,
    ) &&
    /(找|加上|安装|学习|学会|吸收|沉淀|训练|teach|learn|harvest|distill|convert|应用|接入)/iu.test(
      text,
    )
  );
}

function looksLikeExternalFinancialAgentPatternLearning(text: string): boolean {
  const namesExternalAgent =
    /(anthropic|claude|github|开源|外部|上传|uploaded|repo|repository).{0,80}(金融|financial|finance|equity research|investment banking|wealth management|fund admin|market researcher|earnings reviewer).{0,80}(agent|agents|智能体|插件|plugins?|workflow|工作流)/iu.test(
      text,
    ) ||
    /(金融|financial|finance).{0,40}(agent|agents|智能体|插件|plugins?|workflow|工作流).{0,80}(anthropic|claude|github|开源|外部|上传|uploaded|repo|repository)/iu.test(
      text,
    );
  const asksToLearnOrApply =
    /(学习|学会|吸收|沉淀|内化|训练|帮助|应用|接入|借鉴|怎么帮|learn|distill|harvest|apply|adapt|internalize)/iu.test(
      text,
    );
  return namesExternalAgent && asksToLearnOrApply;
}

function looksLikePredictionMarketResearchStrategyLearning(text: string): boolean {
  const namesPredictionMarketSource =
    /(polymarket|polybench|polyswarm|polyclaw|polybot|polyseer|prediction market|预测市场|clob|orderbook|订单簿|market[- ]?making|paper trading)/iu.test(
      text,
    );
  const asksToLearnAuditOrApply =
    /(学习|吸收|沉淀|接入|做上|策略|strategy|audit|审计|回测|backtest|研究|research|intake|source|registry|内化|distill|learn)/iu.test(
      text,
    );
  return namesPredictionMarketSource && asksToLearnAuditOrApply;
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

function looksLikeExternalKnowledgeInternalizationProtocol(text: string): boolean {
  const hasPaper = /(论文|paper|preprint|arxiv|ssrn|nber|working paper|research article)/iu.test(
    text,
  );
  const hasOpenSource =
    /(开源项目|github|repo|repository|hugging ?face|代码|code|skill|skills|open[- ]?source project)/iu.test(
      text,
    );
  const asksToInternalize =
    /(内化|吸收|学进去|学习|沉淀|变成能力|可复用|框架|协议|怎么思考|internali[sz]e|absorb|distill|learn)/iu.test(
      text,
    );
  return hasPaper && hasOpenSource && asksToInternalize;
}

function looksLikeAllModuleKnowledgeInternalizationChain(text: string): boolean {
  if (
    looksLikeBroadFinanceModuleCoverage(text) ||
    looksLikeExternalKnowledgeInternalizationProtocol(text) ||
    looksLikeExternalFinancialAgentPatternLearning(text)
  ) {
    return false;
  }
  const namesConcreteNonFactorModule =
    /(期权|波动率|iv|gamma|skew|指数|index|indices|纳指|标普|沪深300|宏观|利率|基本面|财报|大宗商品|商品|原油|黄金|美元|外汇|fx|事件|event|技术面|technical|lark|feishu|飞书|记忆|memory|ops|skill|workflow)/iu.test(
      text,
    ) &&
    /(也要|同样|等等|等模块|都要|都有|同一条|这种链条|这条链|same chain|same pipeline)/iu.test(
      text,
    );
  const namesModuleScope =
    /(所有模块|全部模块|其他模块|每个模块|跨模块|全模块|not just factor|not only factor|all modules|every module|module-wide)/iu.test(
      text,
    ) ||
    (/(因子模块|factor module|factor modules)/iu.test(text) &&
      /(其他模块|不止|不是只有|不只是|也要|同样|same chain|same pipeline|same internalization)/iu.test(
        text,
      )) ||
    namesConcreteNonFactorModule;
  const namesInternalizationChain =
    /(链条|内化链|学习链|吸收链|same chain|same pipeline|source registry.{0,80}(retrieval|apply|eval)|retrieval receipt|apply validation|qwen eval|eval 吸收|评测吸收|训练吸收|capability card)/iu.test(
      text,
    );
  return namesModuleScope && namesInternalizationChain;
}

function looksLikeAbstractionTransferProtocol(text: string): boolean {
  const namesAbstraction =
    /(抽象能力|人类的抽象|抽象迁移|问题族|failure family|problem family|同类问题|同类接口|shared contract|共享契约|original example|regression proof)/iu.test(
      text,
    );
  const namesExampleTransfer =
    /(例子|比如|例如|example|seed).{0,80}(通用|抽象|迁移|相邻|adjacent|非同类|non[- ]?identical|回归|regression|证明|proof)|(?:大宗商品|lark wording|visible reply|论文|开源项目).{0,80}(不是.*边界|问题族|通用规则|同类|相邻)/iu.test(
      text,
    );
  return namesAbstraction || namesExampleTransfer;
}

function looksLikeCurrentMarketDataFreshnessGap(text: string): boolean {
  const asksForFreshMarketData =
    /(今天|最新|实时|当前行情|当前市场|this morning|today|latest|real[- ]?time|right now)/iu.test(
      text,
    ) || /现在.{0,16}(怎么看|走势|涨跌|价格|行情|market|price)/iu.test(text);
  return (
    asksForFreshMarketData &&
    !looksLikeSingleStockCurveTechnicalTiming(text) &&
    !looksLikeFullStackFinanceStressTest(text) &&
    !looksLikeCrossMarketFinance(text) &&
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
  if (
    /(采访|访谈|interview|博客|blog|substack|播客|podcast|饭局|晚餐|炸鸡|chimaek|kkanbu|viral)/iu.test(
      text,
    ) &&
    !/(github|开源|repo|module|模块|接入|框架|vendor|供应商|不同数据源|冲突)/iu.test(text)
  ) {
    return false;
  }
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
    (/(没给|没有给|还没给|未提供|没有最新|缺少).{0,24}(10-q|10-k|filing|earnings|release|来源|source|原文|财报|指引)/iu.test(
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

function looksLikeSingleStockCurveTechnicalTiming(text: string): boolean {
  const namesSingleStock =
    /(单个股|单只个股|个股|单只股票|single[-_ ]?stock|single[-_ ]?company|stock curve)/iu.test(
      text,
    );
  const namesCurveSurface =
    /(ohlcv|k线|蜡烛图|曲线|价量|量价|成交量|volume|均线|ma\b|20日线|20日均线|趋势|trend|支撑|阻力|support|resistance|跳空|缺口|gap|前高|前低|长下影|下影线|突破|breakout|回补|二次确认|假突破)/iu.test(
      text,
    );
  const asksForDiagnosis =
    /(考验|测试|判断|诊断|拆解|分析|趋势阶段|量价背离|支撑阻力|假突破|二次确认|失效条件|invalidation|failure condition)/iu.test(
      text,
    );
  return (
    !looksLikeFullStackFinanceStressTest(text) &&
    !looksLikeCrossMarketFinance(text) &&
    namesSingleStock &&
    namesCurveSurface &&
    asksForDiagnosis
  );
}

function looksLikeSeniorTraderRiskResearch(text: string): boolean {
  const namesSeniorTradingFrame =
    /(高级交易员|专业交易员|资深交易员|senior trader|pro trader|professional trader|trader[-_ ]?style|交易员式)/iu.test(
      text,
    );
  const namesRiskProcess =
    /(风险预算|risk budget|仓位调整|position sizing|position risk|回撤|drawdown|止损|stop[- ]?loss|对冲|hedg|期权|iv|skew|gamma|隔夜|跳空|gap risk|event risk|事件风险|流动性|liquidity|复盘|post[- ]?mortem|交易日志|trade journal)/iu.test(
      text,
    );
  const namesMarketSurface =
    /(qqq|spy|tlt|nvda|btc|crypto|a股|美股|指数|etf|股票|portfolio|组合|持仓|仓位|market)/iu.test(
      text,
    );
  return (
    !looksLikeCryptoLeverageBoundary(text) &&
    namesSeniorTradingFrame &&
    (namesRiskProcess || namesMarketSurface) &&
    /(训练|变成|水平|分析|研究|拆|框架|流程|怎么|preflight|review|不要|不能|research|risk)/iu.test(
      text,
    )
  );
}

function looksLikeSeniorTraderFailureFocus(text: string): boolean {
  return (
    /(promotion|candidate|失败族|没过|未过|失败样本|promotionReady)/iu.test(text) &&
    /(当前数据|行情新鲜度|freshness|财报|filing|nvda|capex|宽度|breadth|宏观 claim|模型分歧|旧记忆|stale memory|估值压缩|valuation compression|研报|analyst report|复盘|post[- ]?mortem|情绪|sentiment|vendor 冲突|vendor conflict)/iu.test(
      text,
    )
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

  if (looksLikePlainLanguageHiddenComplexityIntake(text)) {
    return {
      ...safe,
      task_family: "plain_language_hidden_complexity_intake",
      primary_modules: [
        "agent_workflow_memory",
        "eval_harness_design",
        "source_registry",
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["ops_audit", "causal_map", "portfolio_risk_gates"],
      required_tools: [
        "doctrine_consistency_doctor",
        "local_brain_eval",
        "source_registry_lookup",
        "artifact_memory_recall",
        "review_panel",
        "l5_regression_batterer",
      ],
      missing_data: [
        "original_example",
        "abstracted_failure_family",
        "adjacent_non_identical_scenario",
        "shared_contract",
        "regression_proof",
        "hidden_workflow_scope",
        "user_visible_summary_contract",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "do_not_answer_literal_short_phrase_only",
        "do_not_stop_at_original_example",
        "proof_required_before_claiming_transfer",
        "no_raw_json_visible_reply",
      ],
      next_step:
        "classify_short_utterance_as_hidden_complexity_family_then_prove_original_example_adjacent_scenario_shared_contract_and_regression_before_specialized_handling",
      rejected_context: [
        "old_lark_conversation_history",
        "literal_short_answer",
        "single_phrase_patch_without_transfer",
        "current_example_only_success",
        "raw_internal_json_visible_reply",
        "unverified_generalization_claim",
      ],
    };
  }

  if (looksLikeSeniorTraderRiskResearch(text) && !looksLikeSeniorTraderFailureFocus(text)) {
    return {
      ...safe,
      task_family: "senior_trader_research_risk_packet",
      primary_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "global_index_regime",
        "etf_regime",
        "company_fundamentals_value",
        "options_volatility",
        "technical_timing",
        "event_driven",
        "quant_math",
        "portfolio_risk_gates",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["causal_map", "finance_learning_memory", "eval_harness_design"],
      required_tools: [
        "source_registry_lookup",
        "finance_learning_capability_apply",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "current_positions_weights_cost_basis_and_time_horizon",
        "position_weights_cost_basis_and_risk_limits",
        "portfolio_weights_and_risk_limits",
        "position_weights_and_return_series",
        "risk_budget_drawdown_limit_and_liquidity_constraints",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "original_thesis_and_evidence_used",
        "price_volume_breadth_and_technical_regime_inputs",
        "options_iv_skew_gamma_and_event_calendar",
        "invalidation_condition_for_timing_signal",
        "red_team_invalidation_evidence",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
        "technical_timing_not_standalone_alpha",
        "risk_gate_before_action_language",
        "red_team_invalidation_required",
        "do_not_rewrite_past_mistakes",
        "no_trade_advice",
      ],
      next_step: "build_research_only_risk_packet_before_any_position_language",
      rejected_context: [
        "old_lark_conversation_history",
        "execution_or_order_instruction",
        "trade_recommendation_without_evidence",
        "model_guessed_position_size",
        "single_indicator_entry_or_exit_signal",
      ],
    };
  }

  if (looksLikeSeniorTraderFailureFocus(text)) {
    return {
      ...safe,
      task_family: "senior_trader_failure_focus_promotion_chain",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "source_registry",
        "finance_data_gateway",
        "data_provenance_quality",
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "macro_rates_inflation",
        "credit_liquidity",
        "us_equity_market_structure",
        "etf_regime",
        "technical_timing",
        "quant_math",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "finance_learning_memory",
        "causal_map",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_learning_capability_apply",
        "artifact_memory_recall",
        "local_brain_eval",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "latest_company_fundamental_inputs",
        "model_assumptions_sensitivity_and_audit_inputs",
        "price_volume_breadth_and_technical_regime_inputs",
        "memory_recall_scope_or_relevant_receipts",
        "validation_dataset_and_sample_out_plan",
        "portfolio_weights_and_risk_limits",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
        "no_unverified_filing_claims",
        "technical_timing_not_standalone_alpha",
        "do_not_promote_unverified_memory_claims",
        "sentiment_signal_not_standalone_alpha",
        "no_trade_advice",
      ]),
      next_step:
        "route_each_failed_family_through_source_gateway_capability_retrieval_apply_eval_training_and_review_before_any_promotion_claim",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "old_lark_conversation_history",
        "force_promote_candidate",
        "stored_source_as_learned_module",
        "unverified_current_market_claim",
        "unverified_filing_summary",
        "sentiment_as_standalone_trade_signal",
        "technical_pattern_as_trade_recommendation",
      ]),
    };
  }

  if (looksLikePlainRecentMarketBrief(text)) {
    return {
      ...safe,
      task_family: "plain_recent_stock_market_brief_preflight",
      primary_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "global_index_regime",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "etf_regime",
        "company_fundamentals_value",
        "technical_timing",
        "portfolio_risk_gates",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["causal_map", "finance_learning_memory", "quant_math"],
      required_tools: [
        "source_registry_lookup",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "market_scope_and_time_window",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "price_volume_breadth_and_technical_regime_inputs",
        "macro_rates_inflation_credit_fx_inputs",
        "latest_company_fundamental_inputs",
        "portfolio_weights_and_risk_limits",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
        "technical_timing_not_standalone_alpha",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ],
      next_step:
        "ask_for_market_scope_time_window_and_timestamped_sources_then_build_macro_breadth_fundamental_timing_risk_and_review_brief",
      rejected_context: [
        "old_lark_conversation_history",
        "generic_market_commentary_without_scope_or_sources",
        "unverified_current_market_claim",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeOffensiveStockOpportunityResearch(text)) {
    return {
      ...safe,
      task_family: "offensive_stock_opportunity_research",
      primary_modules: [
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "us_equity_market_structure",
        "technical_timing",
        "data_provenance_quality",
        "source_registry",
        "portfolio_risk_gates",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["finance_learning_memory", "causal_map", "event_driven", "quant_math"],
      required_tools: [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_learning_capability_apply",
        "review_panel",
        "local_brain_eval",
      ],
      missing_data: [
        "candidate_universe_and_exclusion_rules",
        "sector_scope_and_style_bucket",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "latest_company_fundamental_inputs",
        "revenue_quality_margin_fcf_roic_and_balance_sheet_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "thesis_catalyst_calendar_and_invalidation_evidence",
        "upside_driver_and_market_mispricing_hypothesis",
        "red_team_invalidation_evidence",
        "price_volume_breadth_and_technical_regime_inputs",
        "position_weights_cost_basis_and_risk_limits",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
        "opportunity_ranking_not_buy_list",
        "small_position_trial_requires_user_constraints",
        "technical_timing_not_standalone_alpha",
        "red_team_invalidation_required",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ],
      next_step: "build_watchlist_rank_opportunities_then_red_team_risk_gate_before_summary",
      rejected_context: [
        "old_lark_conversation_history",
        "overly_conservative_refusal_only",
        "direct_buy_list_without_sources",
        "lottery_ticket_story_without_fundamentals",
        "single_indicator_stock_pick",
        "model_guessed_position_size",
      ],
    };
  }

  if (looksLikePlainPositionSizingPreflight(text)) {
    return {
      ...safe,
      task_family: "plain_single_stock_position_sizing_preflight",
      primary_modules: [
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "quant_math",
        "technical_timing",
        "macro_rates_inflation",
        "etf_regime",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["causal_map", "finance_learning_memory"],
      required_tools: [
        "source_registry_lookup",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "current_total_assets_and_position_size",
        "position_weights_cost_basis_and_risk_limits",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
        "latest_company_fundamental_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_model_math_guessing",
        "risk_gate_before_action_language",
        "position_sizing_requires_user_constraints_and_risk_budget",
        "no_trade_advice",
      ],
      next_step:
        "request_current_position_cost_basis_total_assets_risk_budget_sources_and_return_series_before_any_position_size_language",
      rejected_context: [
        "old_lark_conversation_history",
        "invented_position_percentage",
        "single_stock_sizing_without_portfolio_context",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikePlainBuyHoldBoundary(text)) {
    return {
      ...safe,
      task_family: "plain_buy_hold_research_boundary",
      primary_modules: [
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "macro_rates_inflation",
        "etf_regime",
        "technical_timing",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["causal_map", "finance_learning_memory", "quant_math"],
      required_tools: [
        "source_registry_lookup",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "user_objective_time_horizon_and_current_position",
        "position_weights_cost_basis_and_risk_limits",
        "latest_company_fundamental_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "convert_trade_question_to_research_preflight",
        "technical_timing_not_standalone_alpha",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ],
      next_step:
        "convert_buy_hold_wording_into_research_preflight_then_request_position_fundamental_valuation_macro_timing_and_risk_inputs",
      rejected_context: [
        "old_lark_conversation_history",
        "direct_buy_sell_answer",
        "unverified_price_or_fundamental_claim",
        "trade_recommendation_without_evidence",
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
        "no_unverified_current_market_data",
        "do_not_pick_model_answer_without_evidence",
        "do_not_promote_unverified_memory_claims",
        "no_model_math_guessing",
        "no_trade_advice",
      ],
      next_step:
        "separate_memory_claims_current_data_and_model_opinions_then_resolve_by_source_timestamp_assumptions_quant_checks_and_review_before_summary",
      rejected_context: [
        "old_lark_conversation_history",
        "stale_memory_rule_as_current_fact",
        "single_model_authority_claim",
        "single_vendor_unverified_claim",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeAbstractionTransferProtocol(text)) {
    return {
      ...safe,
      task_family: "abstraction_transfer_repair_protocol",
      primary_modules: [
        "agent_workflow_memory",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["finance_learning_memory", "source_registry"],
      required_tools: [
        "doctrine_consistency_doctor",
        "local_brain_eval",
        "l5_regression_batterer",
        "receipt_or_patch_summary",
      ],
      missing_data: [
        "original_example",
        "abstracted_failure_family",
        "adjacent_non_identical_scenario",
        "shared_contract",
        "regression_proof",
        "simple_prerequisite_case",
        "hidden_workflow_scope",
        "user_visible_summary_contract",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "do_not_answer_literal_short_phrase_only",
        "do_not_stop_at_original_example",
        "no_one_off_phrase_patch",
        "proof_required_before_claiming_transfer",
        "no_raw_json_visible_reply",
        "no_protected_memory_write",
        "no_provider_config_change",
        "no_external_channel_sender_change",
      ],
      next_step:
        "write_original_example_abstract_failure_family_adjacent_non_identical_scenario_shared_contract_and_regression_proof_before_claiming_fix",
      rejected_context: [
        "single_phrase_patch_without_transfer",
        "current_example_only_success",
        "unverified_generalization_claim",
        "old_lark_conversation_history",
      ],
    };
  }

  if (looksLikeAllModuleKnowledgeInternalizationChain(text)) {
    return {
      ...safe,
      task_family: "all_module_knowledge_internalization_chain",
      primary_modules: [
        "agent_workflow_memory",
        "source_registry",
        "finance_learning_memory",
        "skill_pattern_distillation",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["causal_map", "ops_audit", "quant_math", "portfolio_risk_gates"],
      required_tools: [
        "module_learning_pipeline_plan",
        "module_learning_pipeline_review",
        "source_registry_lookup",
        "finance_learning_capability_apply",
        "artifact_memory_recall",
        "local_brain_eval",
        "l5_regression_batterer",
        "review_panel",
      ],
      missing_data: [
        "target_module_id_or_module_family",
        "source_url_or_local_source_path",
        "actual_reading_scope",
        "source_registry_record",
        "module_specific_capability_rule",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "fresh_adjacent_application_task",
        "module_learning_pipeline_review_status",
        "module_specific_safety_boundary",
        "keep_downrank_or_discard_decision",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_model_internal_learning_claim_without_eval",
        "no_module_learning_claim_from_storage_only",
        "no_parallel_module_pipeline_without_prior_art_check",
        "no_protected_memory_write",
        "no_provider_config_change",
        "no_external_channel_sender_change",
      ],
      next_step:
        "apply_source_registry_capability_retrieval_apply_eval_chain_then_review_each_target_module_before_claiming_internalized",
      rejected_context: [
        "old_lark_conversation_history",
        "factor_only_internalization_rule",
        "stored_source_as_learned_module",
        "module_claim_without_receipt_or_eval",
        "new_parallel_protocol_without_prior_art_check",
        "live_visible_claim_without_live_proof",
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
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "finance_data_gateway",
        "data_provenance_quality",
        "research_artifact_qc",
        "quant_math",
        "portfolio_risk_gates",
      ],
      supporting_modules: [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "finance_data_gateway",
        "data_provenance_quality",
        "review_panel",
        "control_room_summary",
      ],
      required_tools: [
        "finance_framework_core_inspect",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "quant_math",
        "review_panel",
      ],
      missing_data: [
        "memory_recall_scope_or_relevant_receipts",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
        "macro_rates_inflation_credit_fx_inputs",
        "commodity_curve_roll_yield_and_inventory_inputs",
        "options_iv_skew_gamma_and_event_calendar",
        "price_volume_breadth_and_technical_regime_inputs",
        "latest_company_fundamental_inputs",
        "revenue_quality_margin_fcf_roic_and_balance_sheet_inputs",
        "model_assumptions_sensitivity_and_audit_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "thesis_catalyst_calendar_and_invalidation_evidence",
        "value_trap_risks_and_thesis_invalidation_evidence",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "research_artifact_qc_and_number_provenance_checklist",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_model_math_guessing",
        "no_unverified_current_market_data",
        "cite_every_number_or_mark_unsourced",
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
        "event_driven",
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "technical_timing",
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
        "finance_framework_event_driven_producer",
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
        "finance_framework_core_inspect",
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
        "no_unverified_current_market_data",
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

  if (looksLikeAlternativeMarketSignalSource(text)) {
    return {
      ...safe,
      task_family: "alternative_market_signal_source_preflight",
      primary_modules: [
        "source_registry",
        "data_provenance_quality",
        "causal_map",
        "company_fundamentals_value",
        "event_driven",
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: [
        "us_equity_market_structure",
        "global_index_regime",
        "portfolio_risk_gates",
        "research_artifact_qc",
      ],
      required_tools: [
        "source_registry_lookup",
        "artifact_memory_recall",
        "data_timestamp_and_vendor_compare",
        "review_panel",
      ],
      missing_data: [
        "source_url_or_local_source_path",
        "source_timestamp_and_vendor",
        "primary_source_or_transcript",
        "source_type_and_reliability_grade",
        "official_followup_or_contract_evidence",
        "market_price_and_fundamental_followup_window",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "module_learning_pipeline_review_status",
        "keep_downrank_or_discard_decision",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
        "alternative_source_not_standalone_alpha",
        "no_causality_from_viral_event",
        "sample_out_validation_required",
      ],
      next_step:
        "register_source_type_timestamp_and_transcript_then_check_official_followup_fundamentals_price_window_and_review_before_any_lesson",
      rejected_context: [
        "old_lark_conversation_history",
        "viral_event_as_direct_causal_proof",
        "single_blog_or_interview_as_trade_signal",
        "unverified_market_claim",
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
        "no_unverified_current_market_data",
      ],
      next_step: "mark_claim_unverified_until_source_artifact_or_receipt_is_found",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unverified_market_claim",
      ],
    };
  }

  if (looksLikeSentimentVendorConflictValidation(text)) {
    return {
      ...safe,
      task_family: "sentiment_vendor_conflict_validation_loop",
      primary_modules: [
        "source_registry",
        "finance_data_gateway",
        "data_provenance_quality",
        "quant_math",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["finance_learning_memory", "causal_map", "portfolio_risk_gates"],
      required_tools: [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "data_timestamp_and_vendor_compare",
        "quant_math",
        "review_panel",
      ],
      missing_data: [
        "source_timestamp_and_vendor",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "index_constituents_weights_and_technical_regime_inputs",
        "validation_dataset_and_sample_out_plan",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
        "sentiment_signal_not_standalone_alpha",
        "sample_out_validation_required",
      ],
      next_step:
        "compare_sentiment_vendors_timestamps_and_sample_out_validation_before_any_risk_preference_claim",
      rejected_context: [
        "old_lark_conversation_history",
        "single_vendor_unverified_claim",
        "sentiment_as_standalone_trade_signal",
      ],
    };
  }

  if (looksLikeDataConflictReconciliation(text)) {
    return {
      ...safe,
      task_family: "data_vendor_conflict_reconciliation",
      primary_modules: [
        "data_provenance_quality",
        "source_registry",
        "quant_math",
        "research_artifact_qc",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["finance_learning_memory", "causal_map", "portfolio_risk_gates"],
      required_tools: [
        "source_registry_lookup",
        "data_provenance_quality_review_input",
        "data_timestamp_and_vendor_compare",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "source_timestamp_and_vendor",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "index_constituents_weights_and_technical_regime_inputs",
        "validation_dataset_and_sample_out_plan",
        "research_artifact_qc_and_number_provenance_checklist",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
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
        "thesis_catalyst_lifecycle",
        "company_fundamentals_value",
        "macro_rates_inflation",
        "etf_regime",
        "quant_math",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: [
        "finance_learning_memory",
        "causal_map",
        "data_provenance_quality",
        "control_room_summary",
      ],
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
        "thesis_catalyst_calendar_and_invalidation_evidence",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
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

  if (looksLikeFinancialModelingValuationQc(text)) {
    return {
      ...safe,
      task_family: "financial_modeling_valuation_qc",
      primary_modules: [
        "financial_modeling_valuation_qc",
        "company_fundamentals_value",
        "data_provenance_quality",
        "research_artifact_qc",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: [
        "thesis_catalyst_lifecycle",
        "causal_map",
        "portfolio_risk_gates",
        "finance_learning_memory",
      ],
      required_tools: [
        "source_registry_lookup",
        "finance_framework_company_fundamentals_value_producer",
        "review_panel",
      ],
      missing_data: [
        "latest_10q_10k_or_earnings_release",
        "model_assumptions_sensitivity_and_audit_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "research_artifact_qc_and_number_provenance_checklist",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_model_math_guessing",
        "no_unverified_filing_claims",
        "no_trade_advice",
      ],
      next_step:
        "collect filing sources model assumptions and provenance then audit valuation sensitivity before summary",
      rejected_context: [
        "old_lark_conversation_history",
        "valuation_without_source_evidence",
        "spreadsheet_number_without_provenance",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeThesisCatalystLifecycle(text)) {
    return {
      ...safe,
      task_family: "thesis_catalyst_lifecycle_review",
      primary_modules: [
        "thesis_catalyst_lifecycle",
        "event_driven",
        "company_fundamentals_value",
        "causal_map",
        "portfolio_risk_gates",
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["source_registry", "data_provenance_quality", "research_artifact_qc"],
      required_tools: ["source_registry_lookup", "artifact_memory_recall", "review_panel"],
      missing_data: [
        "original_thesis_source_and_date",
        "original_thesis_and_evidence_used",
        "catalyst_calendar_and_event_outcome",
        "thesis_catalyst_calendar_and_invalidation_evidence",
        "invalidation_evidence_and_red_team_case",
        "fresh_market_data_snapshot",
        "post_event_review_and_correction_note_scope",
        "post_event_correction_note",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "red_team_invalidation_required",
        "do_not_rewrite_past_mistakes",
        "no_trade_advice",
      ],
      next_step:
        "map thesis catalysts invalidation evidence and post-event correction path before any durable lesson",
      rejected_context: [
        "old_lark_conversation_history",
        "thesis_without_invalidation",
        "news_heat_as_conclusion",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikeDataProvenanceQuality(text)) {
    return {
      ...safe,
      task_family: "data_provenance_quality_gate",
      primary_modules: [
        "data_provenance_quality",
        "source_registry",
        "research_artifact_qc",
        "quant_math",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["finance_learning_memory", "causal_map", "portfolio_risk_gates"],
      required_tools: [
        "source_registry_lookup",
        "data_provenance_quality_review_input",
        "data_timestamp_and_vendor_compare",
        "review_panel",
      ],
      missing_data: [
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "source_timestamp_and_vendor",
        "validation_dataset_and_sample_out_plan",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
      ],
      next_step:
        "compare field definitions vendors timestamps and update policy before promoting any sourced number",
      rejected_context: [
        "old_lark_conversation_history",
        "single_vendor_unverified_claim",
        "field_definition_missing",
      ],
    };
  }

  if (looksLikeResearchArtifactQc(text)) {
    return {
      ...safe,
      task_family: "research_artifact_qc_gate",
      primary_modules: [
        "research_artifact_qc",
        "data_provenance_quality",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: [
        "financial_modeling_valuation_qc",
        "company_fundamentals_value",
        "finance_learning_memory",
      ],
      required_tools: ["source_registry_lookup", "review_panel"],
      missing_data: [
        "research_artifact_qc_and_number_provenance_checklist",
        "source_timestamp_and_vendor",
        "citation_and_provenance_rule",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "cite_every_number_or_mark_unsourced",
        "human_review_required_before_external_use",
      ],
      next_step:
        "audit every number source table model output and visible summary before artifact use",
      rejected_context: [
        "old_lark_conversation_history",
        "raw_artifact_without_qc",
        "number_without_provenance",
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

  if (looksLikeExternalKnowledgeInternalizationProtocol(text)) {
    return {
      ...safe,
      task_family: "external_knowledge_internalization_protocol",
      primary_modules: [
        "finance_learning_memory",
        "source_registry",
        "skill_pattern_distillation",
        "agent_workflow_memory",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["causal_map", "portfolio_risk_gates", "quant_math"],
      required_tools: [
        "source_registry_lookup",
        "finance_learning_pipeline_orchestrator",
        "skill_harvester",
        "license_and_write_scope_review",
        "skill_isolation_review",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "prior_art_search_terms_or_existing_artifact_paths",
        "existing_contract_eval_skill_or_receipt_candidates",
        "reuse_extend_or_new_decision",
        "source_url_or_local_source_path",
        "actual_reading_scope",
        "license_and_write_scope_review",
        "prompt_injection_and_security_review",
        "replication_or_sample_out_evidence",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "fresh_adjacent_application_task",
        "keep_downrank_or_discard_decision",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "untrusted_external_source",
        "evaluate_before_installing",
        "do_not_create_parallel_protocol_before_prior_art_check",
        "prefer_reuse_over_duplicate_pipeline",
        "no_model_internal_learning_claim_without_eval",
        "no_protected_memory_write",
        "no_provider_config_change",
        "no_external_channel_sender_change",
        "no_doctrine_mutation",
        "sample_out_validation_required",
        "no_trade_advice",
      ],
      next_step:
        "check_prior_art_then_classify_source_reuse_or_extend_existing_path_verify_license_security_reading_scope_replication_capability_card_retrieval_apply_eval_and_keep_or_downrank",
      rejected_context: [
        "old_lark_conversation_history",
        "new_parallel_protocol_without_prior_art_check",
        "unverified_paper_summary",
        "untrusted_external_skill",
        "model_internal_learning_claim_without_training_eval_evidence",
        "cloud_skill_sharing_by_default",
        "trade_recommendation_without_evidence",
      ],
    };
  }

  if (looksLikePredictionMarketResearchStrategyLearning(text)) {
    return {
      ...safe,
      task_family: "prediction_market_research_strategy_distillation",
      primary_modules: [
        "source_registry",
        "data_provenance_quality",
        "research_artifact_qc",
        "quant_math",
        "portfolio_risk_gates",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: [
        "finance_learning_memory",
        "skill_pattern_distillation",
        "agent_workflow_memory",
        "eval_harness_design",
        "causal_map",
      ],
      required_tools: [
        "source_registry_lookup",
        "finance_data_gateway",
        "license_and_write_scope_review",
        "strategy_experiment_audit",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "market_url_or_market_id",
        "example_market_metadata_packet",
        "resolution_criteria",
        "resolution_ambiguity_review",
        "close_date_and_timezone",
        "orderbook_or_liquidity_snapshot_timestamp",
        "thin_liquidity_downrank_thresholds",
        "spread_depth_volume_fee_and_slippage_snapshot",
        "source_url_or_local_source_path",
        "actual_reading_scope",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "sample_out_validation_plan",
        "slippage_liquidity_and_fees_assumptions",
        "counterevidence_and_resolution_risk",
        "paper_only_application_validation_receipt",
        "paper_strategy_failure_log",
        "keep_downrank_or_discard_decision",
      ],
      risk_boundaries: [
        "research_only",
        "no_trade_advice",
        "no_execution_authority",
        "no_wallet_connection",
        "no_order_placement",
        "no_copy_trading",
        "no_latency_arbitrage",
        "paper_only_backtest_required",
        "market_microstructure_warning_required",
        "thin_liquidity_downrank_required",
        "ambiguous_resolution_blocks_conclusion",
        "fees_slippage_and_sample_out_required",
        "market_probability_not_forecast",
        "sample_out_validation_required",
        "no_provider_config_change",
        "no_external_channel_sender_change",
        "no_protected_memory_write",
        "no_model_internal_learning_claim_without_eval",
      ],
      next_step:
        "collect_prediction_market_source_resolution_liquidity_timestamp_and_paper_only_strategy_audit_before_any_research_summary",
      rejected_context: [
        "wallet_or_private_key_connection",
        "order_execution_or_copy_trading",
        "latency_arbitrage_or_market_making_authority",
        "ambiguous_resolution_treated_as_clean_signal",
        "thin_orderbook_treated_as_strong_signal",
        "strategy_profit_claim_without_fees_slippage_or_sample_out",
        "same_day_price_prediction",
        "unverified_market_probability_as_truth",
        "old_lark_conversation_history",
      ],
    };
  }

  if (looksLikeExternalFinancialAgentPatternLearning(text)) {
    return {
      ...safe,
      task_family: "external_financial_agent_pattern_distillation",
      primary_modules: [
        "finance_learning_memory",
        "skill_pattern_distillation",
        "agent_workflow_memory",
        "source_registry",
        "eval_harness_design",
        "review_panel",
        "control_room_summary",
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "research_artifact_qc",
        "data_provenance_quality",
        "thesis_catalyst_lifecycle",
        "portfolio_risk_gates",
      ],
      supporting_modules: ["causal_map", "quant_math", "technical_timing"],
      required_tools: [
        "skill_harvester",
        "source_registry_lookup",
        "license_and_write_scope_review",
        "skill_isolation_review",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "source_repo_url_or_local_clone_path",
        "source_commit_or_version",
        "license_and_write_scope_review",
        "actual_reading_scope",
        "agent_pattern_inventory",
        "workflow_owner_definition",
        "leaf_worker_inventory",
        "handoff_contract",
        "orchestrator_leaf_tool_boundary_map",
        "tool_permission_boundary_map",
        "untrusted_source_isolation_rule",
        "citation_and_provenance_rule",
        "artifact_qc_gate_mapping",
        "artifact_qc_gate_sequence",
        "model_assumptions_sensitivity_and_audit_inputs",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "research_artifact_qc_and_number_provenance_checklist",
        "human_signoff_checkpoint",
        "visible_summary_contract",
        "application_validation_receipt",
        "fresh_adjacent_application_task",
        "keep_downrank_or_discard_decision",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "untrusted_external_source",
        "evaluate_before_installing",
        "no_enterprise_mcp_assumption",
        "no_provider_config_change",
        "no_external_channel_sender_change",
        "no_protected_memory_write",
        "no_distribution_or_publication",
        "cite_every_number_or_mark_unsourced",
        "human_review_required_before_external_use",
        "no_hidden_tool_authority",
        "no_direct_external_agent_install",
        "no_trade_advice",
      ],
      next_step:
        "read_source_at_pinned_commit_then_distill_workflow_owner_leaf_workers_handoff_contract_tool_boundaries_untrusted_source_isolation_qc_sequence_human_signoff_and_visible_summary_before_claiming_helpful",
      rejected_context: [
        "old_lark_conversation_history",
        "install_enterprise_mcp_without_credentials",
        "direct_install_external_agent_without_isolation",
        "single_agent_chat_role_without_workflow_contract",
        "copy_external_agent_as_trade_recommendation_engine",
        "publication_or_distribution_without_review",
        "model_internal_learning_claim_without_training_eval_evidence",
      ],
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
        "no_external_channel_sender_change",
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

  if (looksLikeCurrentMarketDataFreshnessGap(text)) {
    return {
      ...safe,
      task_family: "current_market_data_research_preflight",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "source_registry",
        "finance_data_gateway",
        "data_provenance_quality",
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
        "finance_data_gateway_snapshot",
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
        "no_unverified_current_market_data",
        "no_trade_advice",
      ]),
      next_step:
        "mark_current_market_claims_unverified_until_source_timestamp_and_fresh_data_snapshot_are_available_then_run_review",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "unverified_current_market_claim",
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
        "finance_learning_capability_apply",
        "finance_framework_core_inspect",
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
        "finance_data_gateway",
        "data_provenance_quality",
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
        "finance_data_gateway_snapshot",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "candidate_repo_url_or_local_source_path",
        "license_and_write_scope_review",
        "source_timestamp_and_vendor",
        "sentiment_data_source_and_timestamp_policy",
        "data_field_definition_timestamp_and_vendor_quality_inputs",
        "index_constituents_weights_and_technical_regime_inputs",
        "validation_dataset_and_sample_out_plan",
        "integration_acceptance_metric",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "untrusted_external_source",
        "no_unverified_current_market_data",
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
      primary_modules: [
        "company_fundamentals_value",
        "source_registry",
        "finance_data_gateway",
        "data_provenance_quality",
        "portfolio_risk_gates",
      ],
      supporting_modules: [
        "causal_map",
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ],
      required_tools: [
        "finance_framework_company_fundamentals_value_producer",
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
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

  if (looksLikeValueInvestingFundamentalCore(text) && !looksLikeEtfAsCompanyFundamentalTrap(text)) {
    return {
      ...safe,
      task_family: "value_investing_fundamental_research_planning",
      primary_modules: [
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "source_registry",
        "data_provenance_quality",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: [
        "finance_learning_memory",
        "macro_rates_inflation",
        "quant_math",
        "research_artifact_qc",
      ],
      required_tools: [
        "finance_framework_company_fundamentals_value_producer",
        "source_registry_lookup",
        "finance_learning_capability_apply",
        "review_panel",
      ],
      missing_data: [
        "latest_10q_10k_or_earnings_release",
        "revenue_quality_margin_fcf_roic_and_balance_sheet_inputs",
        "moat_management_and_capital_allocation_evidence",
        "model_assumptions_sensitivity_and_audit_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "thesis_catalyst_calendar_and_invalidation_evidence",
        "value_trap_risks_and_thesis_invalidation_evidence",
        "research_artifact_qc_and_number_provenance_checklist",
        "portfolio_weights_and_risk_limits",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "fundamentals_first_not_price_action_first",
        "margin_of_safety_required",
        "value_investing_not_trade_signal",
        "no_unverified_filing_claims",
        "no_trade_advice",
      ],
      next_step:
        "read_source_filings_first_then_score_business_quality_cash_flow_roic_balance_sheet_moat_valuation_safety_margin_value_trap_and_invalidation",
      rejected_context: [
        "old_lark_conversation_history",
        "technical_timing_before_fundamentals",
        "valuation_without_source_evidence",
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
        "finance_data_gateway",
        "data_provenance_quality",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["quant_math", "ops_audit"],
      required_tools: [
        "artifact_memory_recall",
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_learning_capability_apply",
        "review_panel",
      ],
      missing_data: [
        "memory_recall_scope_or_relevant_receipts",
        "fresh_task_inputs",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
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
        "event_driven",
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "technical_timing",
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
        "finance_framework_event_driven_producer",
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

  if (looksLikeSingleStockCurveTechnicalTiming(text)) {
    return {
      ...safe,
      task_family: "single_stock_curve_technical_timing_preflight",
      primary_modules: [
        "technical_timing",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "source_registry",
        "data_provenance_quality",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["causal_map", "finance_learning_memory", "quant_math"],
      required_tools: [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "single_stock_ohlcv_price_volume_series",
        "moving_average_volatility_and_gap_inputs",
        "price_volume_breadth_and_technical_regime_inputs",
        "latest_company_fundamental_inputs",
        "position_weights_cost_basis_and_risk_limits",
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
        "diagnose_single_stock_curve_as_timing_context_then_attach_fundamentals_portfolio_risk_and_review_before_summary",
      rejected_context: [
        "old_lark_conversation_history",
        "direct_buy_sell_answer",
        "technical_timing_as_standalone_alpha",
        "technical_pattern_as_trade_recommendation",
        "unverified_current_market_claim",
      ],
    };
  }

  if (looksLikeTechnicalTimingNotStandalone(text)) {
    return {
      ...safe,
      task_family: "technical_timing_not_standalone_alpha",
      primary_modules: [
        "technical_timing",
        "source_registry",
        "finance_data_gateway",
        "data_provenance_quality",
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
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_etf_regime_producer",
        "finance_learning_capability_apply",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "price_volume_breadth_and_technical_regime_inputs",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
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
    const nonFinanceMisrouteModules = [
      "skill_pattern_distillation",
      "agent_workflow_memory",
      "eval_harness_design",
    ];
    return {
      ...safe,
      task_family: "full_stack_finance_stress_research_planning",
      primary_modules: mergeUnique([
        "company_fundamentals_value",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "global_index_regime",
        "crypto_market_structure",
        "quant_math",
        "portfolio_risk_gates",
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
        "etf_regime",
        "technical_timing",
        "commodities_oil_gold",
        ...withoutValues(
          inferFinanceModulesFromLocalKnowledgeText(text),
          nonFinanceMisrouteModules,
        ),
        ...withoutValues(arrayValue(safe.primary_modules), nonFinanceMisrouteModules),
      ]),
      supporting_modules: mergeUnique(
        withoutValues(arrayValue(safe.supporting_modules), nonFinanceMisrouteModules),
        [
          "causal_map",
          "finance_learning_memory",
          "source_registry",
          "review_panel",
          "control_room_summary",
        ],
      ),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "artifact_memory_recall",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_core_inspect",
        "finance_framework_fx_dollar_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique([
        "memory_recall_scope_or_relevant_receipts",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "index_constituents_weights_and_technical_regime_inputs",
        "china_a_share_policy_liquidity_and_northbound_inputs",
        "crypto_liquidity_volatility_custody_and_regulatory_inputs",
        "fx_dollar_yuan_and_global_liquidity_inputs",
        "position_weights_and_return_series",
        "red_team_invalidation_evidence",
        "latest_10q_10k_or_earnings_release",
        "guidance_revision_margin_revenue_and_valuation_inputs",
        "current_rates_inflation_fed_path_and_liquidity_inputs",
        "position_weights_cost_basis_and_risk_limits",
        "price_volume_breadth_and_technical_regime_inputs",
        "portfolio_weights_and_risk_limits",
        ...arrayValue(safe.missing_data),
      ]),
      risk_boundaries: mergeUnique([
        "research_only",
        "no_execution_authority",
        "no_trade_advice",
        "evidence_required",
        "no_model_math_guessing",
        "no_unverified_current_market_data",
        "cite_every_number_or_mark_unsourced",
        "red_team_invalidation_required",
        ...cleanRiskBoundaries(safe.risk_boundaries),
      ]),
      next_step:
        "recall_local_finance_rules_then_collect_fundamental_macro_position_technical_inputs_build_causal_map_run_quant_risk_gates_and_red_team_review_before_control_room_summary",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
        "single_factor_technical_story",
        "unverified_current_market_claim",
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
        "finance_framework_core_inspect",
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
        "no_unverified_current_market_data",
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
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "quant_math",
        "finance_learning_memory",
        "source_registry",
        "finance_data_gateway",
        "data_provenance_quality",
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
        "finance_data_gateway_snapshot",
        "finance_learning_capability_apply",
        "review_panel",
      ],
      missing_data: [
        "memory_recall_scope_or_relevant_receipts",
        "fresh_task_inputs",
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
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
        "financial_modeling_valuation_qc",
        "finance_learning_memory",
        "source_registry",
        "finance_data_gateway",
        "data_provenance_quality",
        "research_artifact_qc",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: ["control_room_summary"],
      required_tools: [
        "source_registry_lookup",
        "finance_framework_company_fundamentals_value_producer",
        "finance_learning_capability_apply",
        "finance_data_gateway_snapshot",
        "review_panel",
      ],
      missing_data: [
        "source_url_or_local_source_path",
        "latest_company_fundamental_inputs",
        "model_assumptions_sensitivity_and_audit_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "value_trap_risks_and_thesis_invalidation_evidence",
        "research_artifact_qc_and_number_provenance_checklist",
        "portfolio_weights_and_risk_limits",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_trade_advice",
        "do_not_promote_unverified_memory_claims",
        "cite_every_number_or_mark_unsourced",
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
          : withoutValues(arrayValue(safe.required_tools), ["finance_learning_capability_apply"]),
        [
          "artifact_memory_recall",
          "finance_learning_capability_apply",
          "source_registry_lookup",
          "finance_framework_macro_rates_inflation_producer",
          "finance_framework_credit_liquidity_producer",
          "finance_framework_core_inspect",
          "finance_framework_fx_dollar_producer",
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

  if (looksLikeCompanyToPortfolioRisk(text) && !looksLikePortfolioMacroRisk(text)) {
    return {
      ...safe,
      task_family: "company_fundamental_portfolio_risk_planning",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        ...inferFinanceModulesFromLocalKnowledgeText(text),
        "source_registry",
        "finance_data_gateway",
        "data_provenance_quality",
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "causal_map",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "finance_learning_memory",
        "research_artifact_qc",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_causal_map_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "latest_10q_10k_or_earnings_release",
        "latest_company_fundamental_inputs",
        "revenue_quality_margin_fcf_roic_and_balance_sheet_inputs",
        "source_timestamp_and_vendor",
        "fresh_market_data_snapshot",
        "model_assumptions_sensitivity_and_audit_inputs",
        "valuation_range_and_margin_of_safety_inputs",
        "thesis_catalyst_calendar_and_invalidation_evidence",
        "portfolio_weights_and_risk_limits",
        "company_to_portfolio_exposure_map",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
        "no_unverified_filing_claims",
        "no_trade_advice",
      ]),
      next_step: "build_company_to_portfolio_causal_plan_then_require_fresh_evidence",
    };
  }

  if (looksLikeTreasurySupplyTermPremiumRisk(text)) {
    return {
      ...safe,
      task_family: "treasury_supply_term_premium_portfolio_risk",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "macro_rates_inflation",
        "credit_liquidity",
        "fx_currency_liquidity",
        "etf_regime",
        "global_index_regime",
        "quant_math",
        "portfolio_risk_gates",
        "finance_data_gateway",
        "data_provenance_quality",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_fx_dollar_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "treasury_issuance_refunding_and_auction_calendar",
        "term_premium_real_yield_and_curve_inputs",
        "current_rates_and_inflation_inputs",
        "source_timestamp_and_vendor",
        "target_etf_price_and_regime_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_current_market_data",
        "duration_and_term_premium_not_standalone_trade_signal",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ]),
      next_step: "route_treasury_supply_to_rates_credit_fx_etf_math_and_risk_gates_before_summary",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "old_lark_conversation_history",
        "rate_move_as_single_trade_signal",
        "unverified_treasury_auction_claim",
        "trade_recommendation_without_evidence",
      ]),
    };
  }

  if (looksLikePrivateCreditNonbankLeverageRisk(text)) {
    return {
      ...safe,
      task_family: "private_credit_nonbank_leverage_stress_waterflow",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "credit_liquidity",
        "cross_asset_liquidity",
        "etf_regime",
        "global_index_regime",
        "quant_math",
        "portfolio_risk_gates",
        "finance_data_gateway",
        "data_provenance_quality",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "private_credit_borrower_stress_and_valuation_inputs",
        "nonbank_leverage_and_redemption_pressure_inputs",
        "credit_spreads_funding_and_liquidity_inputs",
        "leveraged_etf_or_semiliquid_structure_exposure_map",
        "source_timestamp_and_vendor",
        "portfolio_weights_and_risk_limits",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "private_credit_or_nbfi_stress_not_standalone_alpha",
        "liquidity_mismatch_requires_source_and_review",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ]),
      next_step: "map_private_credit_and_nonbank_leverage_to_liquidity_etf_risk_gates_and_review",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "old_lark_conversation_history",
        "credit_headline_as_certain_contagion",
        "unverified_private_credit_loss_claim",
        "trade_recommendation_without_evidence",
      ]),
    };
  }

  if (looksLikeAiCapexPowerGridConcentrationRisk(text)) {
    return {
      ...safe,
      task_family: "ai_capex_power_grid_index_concentration_risk",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "event_driven",
        "global_index_regime",
        "us_equity_market_structure",
        "commodities_oil_gold",
        "quant_math",
        "portfolio_risk_gates",
        "finance_data_gateway",
        "data_provenance_quality",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_event_driven_producer",
        "finance_framework_commodities_oil_gold_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "hyperscaler_capex_guidance_and_budget_sources",
        "data_center_power_grid_and_energy_constraint_inputs",
        "supply_chain_hbm_gpu_delivery_and_inventory_inputs",
        "index_weight_concentration_and_overlap_inputs",
        "latest_company_fundamental_inputs",
        "model_assumptions_sensitivity_and_audit_inputs",
        "portfolio_weights_and_risk_limits",
        "thesis_catalyst_calendar_and_invalidation_evidence",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_filing_claims",
        "ai_capex_story_not_standalone_alpha",
        "index_concentration_requires_weights_evidence",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ]),
      next_step:
        "connect_ai_capex_to_fundamentals_power_supply_chain_index_concentration_and_portfolio_risk",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "old_lark_conversation_history",
        "ai_story_without_filing_or_capex_source",
        "market_attention_as_causality",
        "trade_recommendation_without_evidence",
      ]),
    };
  }

  if (looksLikeEnergyInflationShockRisk(text)) {
    return {
      ...safe,
      task_family: "energy_inflation_cross_asset_shock_risk",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "commodities_oil_gold",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "etf_regime",
        "global_index_regime",
        "quant_math",
        "portfolio_risk_gates",
        "finance_data_gateway",
        "data_provenance_quality",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_commodities_oil_gold_producer",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_fx_dollar_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "oil_supply_demand_inventory_and_spare_capacity_inputs",
        "energy_inflation_cpi_pce_and_expectations_inputs",
        "source_timestamp_and_vendor",
        "current_rates_and_inflation_inputs",
        "fx_dollar_and_cross_asset_liquidity_inputs",
        "target_etf_price_and_regime_inputs",
        "portfolio_weights_and_risk_limits",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "commodity_framework_not_trade_signal",
        "supply_shock_requires_official_or_primary_source",
        "equity_bond_hedge_may_fail_under_supply_shock",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ]),
      next_step: "route_energy_supply_shock_to_commodity_macro_fx_cross_asset_etf_and_risk_review",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "old_lark_conversation_history",
        "oil_headline_as_direct_equity_signal",
        "unverified_energy_price_claim",
        "trade_recommendation_without_evidence",
      ]),
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
  if (
    /(dcf|comps?|三表|财务模型|估值模型|敏感性|valuation model|financial model|model builder|audit[- ]?xls|spreadsheet)/iu.test(
      text,
    )
  ) {
    modules.push("financial_modeling_valuation_qc");
  }
  if (
    /(thesis|投资论点|研究论点|催化|catalyst|失效|invalidation|post[- ]?event|correction note|反方证据)/iu.test(
      text,
    )
  ) {
    modules.push("thesis_catalyst_lifecycle");
  }
  if (
    /(provenance|vendor|供应商|字段定义|field definition|口径|时间戳|timestamp|source quality|数据质量|币种|复权)/iu.test(
      text,
    )
  ) {
    modules.push("data_provenance_quality");
  }
  if (
    /(artifact|产物|研报|报告|表格|spreadsheet|number provenance|数字来源|cite every number|citation|QC|审阅|核对)/iu.test(
      text,
    )
  ) {
    modules.push("research_artifact_qc");
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
  if (
    /(nvda|公司|基本面|价值投资|value investing|intrinsic value|安全边际|护城河|fundamental|capex|估值|revenue|earnings|ai capex)/iu.test(
      text,
    )
  ) {
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
