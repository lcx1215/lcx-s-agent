export type VisibleAnswerAdoptionGateDecision = {
  status: "adopted" | "replaced";
  text: string;
  failedReasons: string[];
  originalText?: string;
};

const DIRECT_POSITION_ASK_PATTERN =
  /\b(?:should\s+(?:i|we)|do\s+(?:i|we)|can\s+(?:i|we)|recommend|buy|sell|add|reduce|average down|cut loss|stop loss|recover quickly|make.*back|call|put|margin|leverage|liquidation|enter|exit|chase)\b|买|卖|加仓|加一点|减仓|补仓|摊低|摊平|割肉|止损|止盈|回本|快点回本|赌|梭哈|满仓|杠杆|保证金|爆仓|要不要|该不该|应不应该|能不能|能不能买|能买吗|能买么|能上|上不上|冲不冲|追不追|要不要冲|要不要上|能拿|还能拿|有没有戏|可不可以|到底应该|直接告诉我/u;

const HOLD_OR_WAIT_ACTION_ASK_PATTERN =
  /(?:要不要|该不该|应不应该|到底应该|建议|可以|直接告诉我).{0,16}(持有|继续拿着|继续拿|等待)/u;

const ACTION_STANCE_HEADING_PATTERN =
  /\b(?:current stance|action triggers)\b|##\s*(?:Current Stance|Action Triggers)\b/iu;

const ENGLISH_POSITION_ACTION_PATTERN =
  /\b(?:should|recommend|can|must|do not|don't|avoid|wait|hold)\b.{0,32}\b(?:buy|sell|add|reduce|average down|cut(?: the)? loss|hold|wait|stop loss|target price)\b/iu;

const CHINESE_POSITION_ACTION_PATTERN =
  /(?:应该|建议|可以|不要|别|先别|不建议|先说结论).{0,22}(买|卖|买入|卖出|加仓|减仓|补仓|摊低|摊平|割肉|砍仓|抄底|止损|止盈|持有|等待|上|冲|追|拿|赌|梭哈|满仓|加保证金|上杠杆|降杠杆)/u;

const CHINESE_ACTION_FRAMEWORK_PATTERN =
  /均价策略|止损策略|减亏两条路|抄底|砍仓|摊低成本|快点回本|赌财报|梭哈|满仓|加保证金|爆仓自救/u;

const STALE_PRIOR_ANSWER_DEFERRAL_PATTERN =
  /我(?:上一条|上条|刚才|前面)已经|上一条已经|已经给出|继续深化|想往哪个方向深|换一个方向|补充权重数据|分发状态/u;

const STANDALONE_PORTFOLIO_RISK_ASK_PATTERN =
  /(?:持有|组合|portfolio|holdings?).{0,40}(?:QQQ|TLT|NVDA).{0,80}(?:风险|risk|研究框架|失效条件|invalidation)|(?:QQQ|TLT|NVDA).{0,80}(?:风险|risk|研究框架|失效条件|invalidation)/iu;

const MODEL_DISAGREEMENT_ARBITRATION_ASK_PATTERN =
  /\b(?:provider council|model disagreement|which model|conflicting models)\b|(?:模型意见|意见不一致|模型分歧|怎么裁决|听谁|谁说得对|采信谁)/u;

const GENERIC_CONTROL_ROOM_CAPABILITY_ANSWER_PATTERN =
  /我是\s*(?:LCX Agent|OpenClaw).{0,40}(?:Lark\s*)?控制室入口|可以把自然语言请求分到|工作面|finance learning pipeline/u;

const EXPLICIT_VISIBLE_CONTRACT_ASK_PATTERN =
  /\b(?:only|do not|don't|without|no json|no internal|answer directly|do not mention|do not cite previous)\b|只说|只给|直接|不要|别|不得|不要暴露|不要引用|不要给|不要装|不能暴露|别暴露|只要/u;

const NO_INTERNAL_DETAIL_CONTRACT_ASK_PATTERN =
  /\b(?:no json|no internal|do not expose|do not mention message id|receipt path)\b|不要暴露|不能暴露|别暴露|内部\s*JSON|后台细节|message\s*id|receipt\s*path|回执路径|内部路径|内部文件|内部标签/u;

const NO_SYSTEM_CAPABILITY_CONTRACT_ASK_PATTERN =
  /\b(?:do not mention system capability|do not talk about system capability|no system capability)\b|不要讲系统能力|不要说系统能力|别讲系统能力|不讲系统能力/u;

const INTERNAL_VISIBLE_DETAIL_PATTERN =
  /^\s*\{|\b(?:control_room|learning_command|technical_daily|fundamental_research|knowledge_maintenance|ops_audit|answer_audit|bounded_answer_review|handoff|receipt path|message id|messageId|correlationId|deliveryMessageId|retrieval\/apply|eval\/training absorption)\b|om_[a-z0-9_]{12,}|分发状态/u;

const ANSWER_PIPELINE_INTERNAL_VISIBLE_PATTERN =
  /\b(?:control_room|bounded_answer_review|answer_audit|work_order|output_contract|chat_id|message_id|model_judgments|agent_task|verification_status|verification|final_answer|diverged_count|intent_family|suggested_action|dominant_family|publish|confidence|foundation)\b|控制摘要|分发状态|工作面|模型\s*[:：]\s*模型[ABCＡＢＣ]|模型[ABCＡＢＣ]/u;

const SYSTEM_CAPABILITY_VISIBLE_PATTERN =
  /\b(?:system has|system does not have|system is connected|real[-\s]?time market data source|market data API|broker feed|data subscription)\b|系统(?:没有|未|已|可以|无法|不能).{0,24}(?:连接|提供|调用|访问|实时|行情|数据源|能力)|行情\s*API|broker\s*feed|实时数据订阅/u;

const MARKET_DATA_BOUNDARY_ASK_PATTERN =
  /\b(?:latest|current|real[-\s]?time|live quotes?|market data|VIX|DXY|HY spread|10Y|risk)\b|最新行情|实时行情|当前行情|市场风险|风险|危险|可信度边界|数据清单|VIX|DXY|HY\s*spread|10Y|十年期|高收益债利差/u;

const ANSWER_PIPELINE_ASK_PATTERN =
  /(?:入口|出口|发.{0,8}消息|收到.{0,8}消息|智能体最后|最后.{0,8}答案|给我.{0,8}答案|答案.{0,8}(?:保守|模棱两可|废话|泛泛)|保守|模棱两可|废话|屁话|弄好|做好)/u;

const LEARNING_SOURCE_ASK_PATTERN =
  /\b(?:learn|study|read|source|url|link|github|repo|paper|blog|article)\b|学一下|学习一下|学习这个|读一下|看看这个|链接|来源|网页|论文|博客|文章|开源|项目/u;

const SYSTEM_STATUS_ASK_PATTERN =
  /\b(?:status|progress|where are we|what changed|done yet|finished yet|system state)\b|现在.{0,12}(?:系统|进化|训练|大脑|智能体).{0,12}(?:到哪|怎么样|如何|状态)|(?:系统|进化|训练|大脑|智能体).{0,12}(?:到哪|怎么样|状态)|做完了吗|系统能用了吗|大脑怎么样|训练怎么样|现在什么状态|状态呢|还有什么|进展/u;

const SHORT_AMBIGUOUS_VISIBLE_ASK_PATTERN =
  /^(?:怎么看|咋看|最近怎么看|现在呢|这个呢|咋办|怎么办|靠谱不|靠谱吗|行不行|可以吗|能不能简单说|还有戏吗)[？?。.\s]*$/u;

const VAGUE_CONSERVATIVE_NONANSWER_PATTERN =
  /(?:这个问题)?(?:比较|很)?复杂|不能一概而论|取决于|需要更多(?:信息|背景|上下文)|信息不足|数据不足|无法(?:判断|确定|给出)|不能(?:判断|确定|给出)|建议(?:谨慎|进一步观察)|需要综合考虑/u;

const USEFUL_VISIBLE_NEXT_STEP_PATTERN =
  /(?:结论|直接说|先说|现在能说|我能说|可以先|下一步|需要补|缺(?:的)?(?:数据|信息)|数据清单|证据|来源|时间戳|失效条件|风险门|检查|按.{0,10}顺序|1[.、]|第一|第二)/u;

const MODEL_DISAGREEMENT_ARBITRATION_TERMS_PATTERN =
  /\b(?:evidence order|source|timestamp|local gate|cannot directly trust|not final authority|arbitration)\b|证据排序|一手来源|时间戳|本地\s*gate|不能直接采信|不能按模型名|候选意见|最终权威|本地把关|裁决/u;

const VISIBLE_INTERNAL_TAIL_LINE_PATTERN =
  /^\s*(?:分发状态|本次识别|识别理由|原始问题|publish|confidence|foundation)\s*[:：].*$/gmu;

function mentionedKnownTickers(text: string): string[] {
  const matches = new Set<string>();
  for (const match of text.matchAll(/\b(QQQ|TLT|NVDA)\b/giu)) {
    matches.add(match[1].toUpperCase());
  }
  return [...matches];
}

function looksLikeDirectPositionRiskAsk(userMessage: string): boolean {
  return (
    DIRECT_POSITION_ASK_PATTERN.test(userMessage) ||
    HOLD_OR_WAIT_ACTION_ASK_PATTERN.test(userMessage)
  );
}

function shouldPrioritizePositionRiskReply(userMessage: string): boolean {
  if (looksLikeStandalonePortfolioRiskAsk(userMessage)) {
    return true;
  }
  if (!looksLikeDirectPositionRiskAsk(userMessage)) {
    return false;
  }
  return (
    mentionedKnownTickers(userMessage).length > 0 ||
    /买|卖|买入|卖出|加仓|减仓|补仓|摊低|摊平|割肉|砍仓|抄底|止损|止盈|持有|继续拿|等待|杠杆|保证金|爆仓|call|put|margin|leverage/iu.test(
      userMessage,
    )
  );
}

function looksLikeStandalonePortfolioRiskAsk(userMessage: string): boolean {
  const trimmed = userMessage.trim();
  if (!STANDALONE_PORTFOLIO_RISK_ASK_PATTERN.test(trimmed)) {
    return false;
  }
  if (mentionedKnownTickers(trimmed).length < 2) {
    return false;
  }
  return !/^(?:继续|接着|展开|详细说|刚才|上一条|上条|上面|那个|这个)[\s，。:：]/u.test(trimmed);
}

function looksLikeSingleStockLossRecoveryAsk(userMessage: string): boolean {
  return (
    mentionedKnownTickers(userMessage).length === 1 &&
    /(?:亏|亏损|高位|高点|追高|回本|recover|loss|down|drawdown|near the top|near the highs)/iu.test(
      userMessage,
    )
  );
}

function looksLikeModelDisagreementArbitrationAsk(userMessage: string): boolean {
  if (MODEL_DISAGREEMENT_ARBITRATION_ASK_PATTERN.test(userMessage)) {
    return true;
  }
  const providerNames = new Set<string>();
  for (const match of userMessage.matchAll(/\b(Kimi|MiniMax|DeepSeek)\b/giu)) {
    providerNames.add(match[1].toLowerCase());
  }
  return providerNames.size >= 2;
}

function looksLikeExplicitVisibleContractAsk(userMessage: string): boolean {
  return EXPLICIT_VISIBLE_CONTRACT_ASK_PATTERN.test(userMessage);
}

function looksLikeMarketDataBoundaryAsk(userMessage: string): boolean {
  return MARKET_DATA_BOUNDARY_ASK_PATTERN.test(userMessage);
}

function looksLikeAnswerPipelineAsk(userMessage: string): boolean {
  return ANSWER_PIPELINE_ASK_PATTERN.test(userMessage);
}

function looksLikeLearningSourceAsk(userMessage: string): boolean {
  return LEARNING_SOURCE_ASK_PATTERN.test(userMessage);
}

function looksLikeSystemStatusAsk(userMessage: string): boolean {
  return SYSTEM_STATUS_ASK_PATTERN.test(userMessage);
}

function looksLikeShortAmbiguousVisibleAsk(userMessage: string): boolean {
  return userMessage.trim().length <= 14 && SHORT_AMBIGUOUS_VISIBLE_ASK_PATTERN.test(userMessage);
}

function looksLikeVagueConservativeNonAnswer(answerText: string): boolean {
  const compact = answerText.trim();
  return (
    VAGUE_CONSERVATIVE_NONANSWER_PATTERN.test(compact) &&
    !USEFUL_VISIBLE_NEXT_STEP_PATTERN.test(compact)
  );
}

export function findVisibleAnswerAdoptionGateFailures(params: {
  userMessage: string;
  answerText: string;
}): string[] {
  const failures: string[] = [];
  const explicitVisibleContract = looksLikeExplicitVisibleContractAsk(params.userMessage);

  if (
    (looksLikeStandalonePortfolioRiskAsk(params.userMessage) ||
      looksLikeDirectPositionRiskAsk(params.userMessage) ||
      explicitVisibleContract) &&
    STALE_PRIOR_ANSWER_DEFERRAL_PATTERN.test(params.answerText)
  ) {
    failures.push("explicit_visible_contract_deferred_to_prior_answer");
    if (
      looksLikeStandalonePortfolioRiskAsk(params.userMessage) ||
      looksLikeDirectPositionRiskAsk(params.userMessage)
    ) {
      failures.push("stale_prior_answer_deferral_for_standalone_finance_ask");
    }
  }

  if (
    explicitVisibleContract &&
    GENERIC_CONTROL_ROOM_CAPABILITY_ANSWER_PATTERN.test(params.answerText)
  ) {
    failures.push("explicit_visible_contract_ignored_by_generic_intro");
  }

  if (
    NO_INTERNAL_DETAIL_CONTRACT_ASK_PATTERN.test(params.userMessage) &&
    INTERNAL_VISIBLE_DETAIL_PATTERN.test(params.answerText)
  ) {
    failures.push("internal_visible_detail_leak_against_user_contract");
  }

  if (
    NO_SYSTEM_CAPABILITY_CONTRACT_ASK_PATTERN.test(params.userMessage) &&
    SYSTEM_CAPABILITY_VISIBLE_PATTERN.test(params.answerText)
  ) {
    failures.push("system_capability_leak_against_user_contract");
  }

  if (
    (looksLikeMarketDataBoundaryAsk(params.userMessage) ||
      looksLikeAnswerPipelineAsk(params.userMessage) ||
      looksLikeLearningSourceAsk(params.userMessage) ||
      looksLikeSystemStatusAsk(params.userMessage) ||
      looksLikeShortAmbiguousVisibleAsk(params.userMessage) ||
      explicitVisibleContract) &&
    looksLikeVagueConservativeNonAnswer(params.answerText)
  ) {
    failures.push("vague_conservative_nonanswer_without_useful_next_step");
  }

  if (
    looksLikeAnswerPipelineAsk(params.userMessage) &&
    ANSWER_PIPELINE_INTERNAL_VISIBLE_PATTERN.test(params.answerText)
  ) {
    failures.push("single_entry_single_exit_internal_label_leak");
  }

  if (looksLikeModelDisagreementArbitrationAsk(params.userMessage)) {
    if (
      GENERIC_CONTROL_ROOM_CAPABILITY_ANSWER_PATTERN.test(params.answerText) ||
      !MODEL_DISAGREEMENT_ARBITRATION_TERMS_PATTERN.test(params.answerText)
    ) {
      failures.push("provider_council_arbitration_answer_missing");
    }
  }

  if (!looksLikeDirectPositionRiskAsk(params.userMessage)) {
    return [...new Set(failures)];
  }

  if (ACTION_STANCE_HEADING_PATTERN.test(params.answerText)) {
    failures.push("action_stance_heading_in_position_risk_reply");
  }
  if (ENGLISH_POSITION_ACTION_PATTERN.test(params.answerText)) {
    failures.push("english_direct_position_action_language");
  }
  if (CHINESE_POSITION_ACTION_PATTERN.test(params.answerText)) {
    failures.push("chinese_direct_position_action_language");
  }
  if (CHINESE_ACTION_FRAMEWORK_PATTERN.test(params.answerText)) {
    failures.push("chinese_action_framework_language");
  }
  return [...new Set(failures)];
}

function prefersChinese(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function renderPortfolioRiskFrameworkReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "Research-only frame, not a trading instruction.",
      "For QQQ, watch whether mega-cap tech breadth, earnings revision tone, and valuation compression move in the same direction.",
      "For TLT, watch the path of real yields, Fed repricing, Treasury supply, and whether bonds still hedge equity stress.",
      "For NVDA, separate company-specific risk from index risk: earnings guidance, margin expectations, AI capex narrative, and concentration in QQQ.",
      "Missing data: position weights, cost ranges, time horizon, max drawdown budget, leverage/options exposure, and timestamped prices, rates, volatility, earnings, and valuation sources.",
      "Invalidation: the framework must reset if rates move sharply against the base case, NVDA guidance changes the earnings story, QQQ breadth improves or breaks materially, or QQQ/TLT correlation stops behaving as assumed.",
    ].join("\n\n");
  }

  return [
    "这是研究框架，不是交易指令。",
    "QQQ：重点看科技权重集中度、市场宽度、估值压缩、收益率上行对成长股折现的压力。",
    "TLT：重点看实际利率、Fed 预期、长债供给、避险时它是否还能对冲股票波动。",
    "NVDA：要把公司单点风险和 QQQ 指数风险分开看，重点是财报/指引、毛利率预期、AI capex 叙事和估值敏感度。",
    "缺的数据：三只标的的组合权重、成本区间、持有期限、最大可承受回撤、是否有杠杆/期权，以及带时间戳的价格、利率、波动率、财报和估值来源。",
    "失效条件：利率路径突然反向、NVDA 指引改变盈利叙事、QQQ 宽度明显修复或恶化、QQQ/TLT 相关性失去原来的对冲假设，都要重做框架。",
  ].join("\n\n");
}

function renderSinglePositionRiskFrameworkReply(userMessage: string): string {
  const ticker = mentionedKnownTickers(userMessage)[0] ?? "这个标的";
  if (!prefersChinese(userMessage)) {
    return [
      "Research-only frame, not a trading instruction.",
      `${ticker}: separate the loss-recovery impulse from the risk check. Do not turn the drawdown into an action label.`,
      "Check four things: position size versus total portfolio, original thesis versus current evidence, valuation and earnings-risk reset, and whether volatility/liquidity has changed the downside path.",
      "Missing data: position weight, cost range, entry date, time horizon, max drawdown budget, whether leverage/options are involved, and timestamped price, earnings, valuation, volatility, and liquidity sources.",
      "Invalidation: rerun the frame if earnings guidance changes the thesis, valuation compression accelerates, volatility regime shifts, position size exceeds the risk budget, or the original thesis cannot be stated in evidence terms.",
    ].join("\n\n");
  }

  return [
    "这是研究框架，不是交易指令。",
    `${ticker}：先把“想回本”的情绪和风险检查分开，不能把亏损幅度直接翻译成操作动作。`,
    "先看四件事：仓位占总资产多少、原始买入逻辑现在有没有被证据破坏、估值/财报预期是否重新定价、波动率和流动性有没有让下行路径变差。",
    "缺的数据：仓位比例、成本区间、买入时间、持有期限、最大可承受回撤、是否用了杠杆/期权，以及带时间戳的价格、财报、估值、波动率和流动性来源。",
    "失效条件：财报指引改变原始逻辑、估值压缩加速、波动率 regime 变化、仓位超过风险预算，或者你说不清原始 thesis 时，都要重做风险框架。",
  ].join("\n\n");
}

function renderProviderCouncilArbitrationReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "Do not decide by model name or majority vote.",
      "Evidence order: primary source or timestamped data first, then reproducible calculations and local rules, then Kimi/MiniMax/DeepSeek as candidate opinions.",
      "Local gates: freshness, source quality, finance-data provenance, trade-advice boundary, and contradiction checks must pass before any answer is adopted.",
      "If the models disagree, keep the shared evidence, mark the conflict, downrank claims without sources or timestamps, and return a blocked reason when the evidence is not enough.",
      "No single provider is directly trusted as final authority.",
    ].join("\n\n");
  }

  return [
    "不能按模型名投票，也不能因为 Kimi、MiniMax 或 DeepSeek 说得像就直接采信。",
    "证据排序：一手来源和带时间戳的数据优先，其次是可复现计算和本地规则，最后才是三家模型的候选意见。",
    "本地 gate 必须先过：数据新鲜度、来源质量、金融数据口径、交易建议边界、互相矛盾的 claim 检查。",
    "三家不一致时：保留共同证据，标出分歧，把没有来源或时间戳的判断降权；证据不够就返回阻塞原因，不硬拍板。",
    "最终答案只能由本地 gate 采纳，不直接采信任何一个模型。",
  ].join("\n\n");
}

function renderMarketDataBoundaryReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "Without fresh market data, I cannot state the current risk level or imply real-time prices.",
      "Confidence boundary: this is a low-confidence framework answer until each source has a timestamp, provider, field definition, unit/currency, and adjusted/unadjusted status where relevant.",
      "Data list: current VIX, 10Y Treasury yield, DXY, high-yield spread, major index prices, relevant ETF or single-name prices, recent earnings/news timestamps, and the portfolio weights if the question is position-specific.",
      "Allowed answer: describe what each missing data point would change and what would invalidate the framework.",
      "Not allowed: buy/sell/add/reduce instructions, precise levels, or claims that pretend stale data is live.",
    ].join("\n\n");
  }

  return [
    "没有最新行情时，不能判断当前风险等级，也不能装作有实时价格。",
    "可信度边界：只能给低可信度研究框架；每个数据都要带时间戳、来源、字段口径、单位/币种，价格类还要说明是否复权或延迟。",
    "数据清单：VIX、10Y 美债收益率、DXY、高收益债利差、主要指数价格、相关 ETF/个股最新价、最近财报/新闻时间戳；如果是持仓问题，还要有仓位比例、成本区间、持有周期和最大可承受回撤。",
    "可以回答：这些数据分别会影响什么判断，以及什么证据会让原框架失效。",
    "不能回答：买卖加减仓指令、精确点位判断，或把旧数据说成当前事实。",
  ].join("\n\n");
}

function renderAnswerPipelineContractReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "Yes, the product path should be simple even if the internals are complex.",
      "Single entry: the user's message is classified into intent, evidence need, risk level, and task family.",
      "Internal work: provider models and local brain can draft, challenge, retrieve memory, and check data, but none of them is final authority by itself.",
      "Single exit: the final visible answer must start with the direct answer or exact blocked reason, then give the few key reasons and the concrete next step.",
      "Quality gate: reject answers that are only capability intros, vague caution, prior-answer deferrals, internal labels, or fake certainty.",
    ].join("\n\n");
  }

  return [
    "能弄好，而且出口必须简单：你发一句话，系统内部再复杂，也只能给你一个有用答案。",
    "入口只做四件事：判断你要什么、需要什么证据、风险等级多高、该走哪个任务族。",
    "内部可以让 Kimi、MiniMax、DeepSeek、本地大脑、记忆和工具一起出草稿/反方/证据缺口，但任何一个都不能直接当最终答案。",
    "出口必须先给直接结论或明确阻塞原因，再给关键理由和下一步；不能先讲系统能力，不能泛泛说谨慎，不能把内部标签甩给你。",
    "质量关要拦掉五类废答案：能力介绍、模棱两可、引用上一条、内部回执/路由泄漏、没有证据却装确定。",
  ].join("\n\n");
}

function renderLearningSourceIntakeReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "I can learn it, but I cannot claim it is learned from the sentence alone.",
      "First requirement: provide a concrete URL, local file path, paper/repo id, or paste the full source text.",
      "Then the system must read the source, record what was actually read, extract reusable rules, test them on an adjacent task, review keep/downrank/discard, and only then reuse the lesson later.",
      "If the source is missing, unsafe, or only a vague topic, the correct answer is a blocked reason plus the exact source needed next.",
      "Boundary: stored text is not learned capability; a visible reply must not claim absorption without proof.",
    ].join("\n\n");
  }

  return [
    "可以学，但不能只凭一句话就说已经学会。",
    "第一步必须有明确来源：URL、本地文件路径、论文/仓库编号，或者你直接粘贴完整原文。",
    "然后要做完整链路：实际阅读来源、记录读了什么、提炼可复用规则、用相邻任务验证、做保留/降权/丢弃决定，之后才允许复用。",
    "如果来源缺失、不安全，或者只是一个模糊主题，正确回复只能说阻塞原因和下一步需要的来源。",
    "边界：存了一段文字不等于大脑学会；没有验证证据时不能声称已经吸收。",
  ].join("\n\n");
}

function renderSystemStatusEvidenceReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "I cannot answer system progress from memory or confidence alone.",
      "A real status answer must read the current repo state, active training/eval processes, local operator state, doctor output, training plan, and Lark channel proof.",
      "The visible answer should say what changed, what is still blocked, what evidence was checked, and what should run next.",
      "If those checks were not run, the honest answer is: status not verified yet.",
    ].join("\n\n");
  }

  return [
    "不能靠聊天记忆或自信回答当前进化状态。",
    "真实状态必须先读：当前 git 状态、训练/eval 进程、本地 operator 状态、系统 doctor、training plan、Lark 通道证明。",
    "可见答案要分开说：进化了什么、还卡在哪、查了哪些证据、下一步该跑什么。",
    "如果这些检查没跑完，只能说“状态未核验”，不能说已经完成或已经变好。",
  ].join("\n\n");
}

function renderVisibleContractFailureReply(userMessage: string): string {
  if (looksLikeMarketDataBoundaryAsk(userMessage)) {
    return renderMarketDataBoundaryReply(userMessage);
  }

  if (looksLikeLearningSourceAsk(userMessage)) {
    return renderLearningSourceIntakeReply(userMessage);
  }

  if (looksLikeSystemStatusAsk(userMessage)) {
    return renderSystemStatusEvidenceReply(userMessage);
  }

  if (looksLikeAnswerPipelineAsk(userMessage)) {
    return renderAnswerPipelineContractReply(userMessage);
  }

  if (!prefersChinese(userMessage)) {
    return [
      "I can't adopt the candidate answer because it ignored the requested visible-output contract.",
      "The answer must address the user's actual question directly, avoid generic capability intros, avoid prior-answer deferrals, and keep internal JSON, ids, paths, receipts, and routing labels out of the visible reply.",
      "A fresh answer should be regenerated under those constraints instead of sending the rejected candidate.",
    ].join("\n\n");
  }

  return [
    "这条候选回答不能采用：它没有按你的可见输出要求回答。",
    "可见回复必须直接回答原问题，不能退成控制室能力介绍，不能拿旧回复搪塞，也不能暴露内部 JSON、消息 id、回执路径、路由标签或工作面名字。",
    "需要按你的限制重新生成答案；证据不够就说阻塞原因，不能把错误候选直接发给你。",
  ].join("\n\n");
}

function stripVisibleInternalTail(text: string): string {
  return text
    .replace(/^\s*控制摘要\s*/u, "")
    .replace(VISIBLE_INTERNAL_TAIL_LINE_PATTERN, "")
    .replace(/\s*分发状态\s*[:：][^\n。.]*(?:[。.]|$)/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function renderPositionRiskRescueReply(userMessage: string): string {
  if (looksLikeStandalonePortfolioRiskAsk(userMessage)) {
    return renderPortfolioRiskFrameworkReply(userMessage);
  }

  if (looksLikeSingleStockLossRecoveryAsk(userMessage)) {
    return renderSinglePositionRiskFrameworkReply(userMessage);
  }

  if (!prefersChinese(userMessage)) {
    return [
      "I can't give a direct trading action for this.",
      "Missing inputs: portfolio weight, cost range, time horizon, risk budget, max drawdown tolerance, and timestamped price, earnings, and valuation sources.",
      "The useful path is a research check: concentration risk, whether fundamentals are impaired, valuation compression, rates and liquidity pressure, technicals as observation only, and loss-recovery behavior risk.",
      "Even after the inputs are filled, the output should be research findings, risk gates, and invalidation points, not execution instructions.",
    ].join("\n\n");
  }

  return [
    "这类问题不能直接给交易动作结论。",
    "现在缺：标的、组合占比、成本区间、期限、风险预算、最大可承受回撤、杠杆或期权到期信息，以及最新价格、财报、估值和流动性来源时间戳。",
    "能做的是研究检查：集中度、基本面是否被破坏、估值压缩、利率和流动性压力、杠杆/期权到期风险、技术面仅作观察、亏损后的行为风险。",
    "补齐数据后也只给研究结论、风险门和失效条件，不给交易指令。",
  ].join("\n\n");
}

export function applyVisibleAnswerAdoptionGate(params: {
  userMessage: string;
  answerText: string;
}): VisibleAnswerAdoptionGateDecision {
  const text = stripVisibleInternalTail(params.answerText);
  const failedReasons = findVisibleAnswerAdoptionGateFailures({
    userMessage: params.userMessage,
    answerText: text,
  });
  if (failedReasons.length === 0) {
    return { status: "adopted", text, failedReasons };
  }

  if (shouldPrioritizePositionRiskReply(params.userMessage)) {
    return {
      status: "replaced",
      text: renderPositionRiskRescueReply(params.userMessage),
      originalText: text,
      failedReasons,
    };
  }

  if (looksLikeAnswerPipelineAsk(params.userMessage)) {
    return {
      status: "replaced",
      text: renderAnswerPipelineContractReply(params.userMessage),
      originalText: text,
      failedReasons,
    };
  }

  if (looksLikeLearningSourceAsk(params.userMessage)) {
    return {
      status: "replaced",
      text: renderLearningSourceIntakeReply(params.userMessage),
      originalText: text,
      failedReasons,
    };
  }

  if (looksLikeSystemStatusAsk(params.userMessage)) {
    return {
      status: "replaced",
      text: renderSystemStatusEvidenceReply(params.userMessage),
      originalText: text,
      failedReasons,
    };
  }

  if (looksLikeModelDisagreementArbitrationAsk(params.userMessage)) {
    return {
      status: "replaced",
      text: renderProviderCouncilArbitrationReply(params.userMessage),
      originalText: text,
      failedReasons,
    };
  }

  if (
    failedReasons.some((reason) =>
      [
        "explicit_visible_contract_ignored_by_generic_intro",
        "explicit_visible_contract_deferred_to_prior_answer",
        "internal_visible_detail_leak_against_user_contract",
        "system_capability_leak_against_user_contract",
        "vague_conservative_nonanswer_without_useful_next_step",
      ].includes(reason),
    )
  ) {
    return {
      status: "replaced",
      text: renderVisibleContractFailureReply(params.userMessage),
      originalText: text,
      failedReasons,
    };
  }

  return {
    status: "replaced",
    text: renderPositionRiskRescueReply(params.userMessage),
    originalText: text,
    failedReasons,
  };
}
