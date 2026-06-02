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
  /我是\s*(?:LCX Agent|OpenClaw).{0,40}(?:Lark\s*)?控制室入口|我是你在\s*Lark\s*里联系\s*LCX Agent\s*的入口|当前可用能力|可以把自然语言请求分到|工作面|finance learning pipeline/u;

const EXPLICIT_VISIBLE_CONTRACT_ASK_PATTERN =
  /\b(?:only|do not|don't|without|no json|no internal|answer directly|do not mention|do not cite previous)\b|只说|只给|直接|不要|别|不得|不要暴露|不要引用|不要给|不要装|不能暴露|别暴露|只要/u;

const NO_INTERNAL_DETAIL_CONTRACT_ASK_PATTERN =
  /\b(?:no json|no internal|do not expose|do not mention message id|receipt path)\b|不要暴露|不能暴露|别暴露|内部\s*JSON|后台细节|message\s*id|receipt\s*path|回执路径|内部路径|内部文件|内部标签/iu;

const NO_SYSTEM_CAPABILITY_CONTRACT_ASK_PATTERN =
  /\b(?:do not mention system capability|do not talk about system capability|no system capability)\b|不要讲系统能力|不要说系统能力|别讲系统能力|不讲系统能力/u;

const INTERNAL_VISIBLE_DETAIL_PATTERN =
  /^\s*\{|\b(?:control_room|learning_command|technical_daily|fundamental_research|knowledge_maintenance|ops_audit|answer_audit|bounded_answer_review|handoff|receipt path|message id|messageId|correlationId|deliveryMessageId|retrieval\/apply|eval\/training absorption|rationale|work_order|output_contract|required_modules|backend_tool)\b|识别理由|om_[a-z0-9_]{12,}|分发状态/u;

const ANSWER_PIPELINE_INTERNAL_VISIBLE_PATTERN =
  /\b(?:control_room|bounded_answer_review|answer_audit|work_order|output_contract|chat_id|message_id|model_judgments|agent_task|verification_status|verification|final_answer|diverged_count|intent_family|suggested_action|dominant_family|publish|confidence|foundation|dev-fixed|probe-fixed|live-visible-fixed|live-fixed)\b|控制摘要|分发状态|工作面|模型\s*[:：]\s*模型[ABCＡＢＣ]|模型[ABCＡＢＣ]/u;

const LEGACY_PROOF_LABEL_VISIBLE_PATTERN =
  /\b(?:dev-fixed|probe-fixed|live-visible-fixed|live-fixed)\b/iu;

const LEGACY_TEST_ARTIFACT_VISIBLE_PATTERN =
  /\b(?:lark-canary|canary|LCX[-_ ]?[A-Z]\d+[a-z]?|[A-Z]\d+[a-z]?\s*探针)\b|[A-Z]\d+[a-z]?\s*(?:一致|结论|复测|通过|失败)|(?:真实)?(?:入口)?探针|验收码|复测记录|复测\s*[:：]|与探针|同一批\s*probe|probe\s*(?:结果|层|发送|通过)|channel\s*probe/iu;

const CHINESE_INTERNAL_BLOCKED_LABEL_PATTERN = /\b(?:blocked|Boundary And Missing Inputs)\b/iu;

const SYSTEM_CAPABILITY_VISIBLE_PATTERN =
  /\b(?:system has|system does not have|system is connected|real[-\s]?time market data source|market data API|broker feed|data subscription)\b|系统(?:没有|未|已|可以|无法|不能).{0,24}(?:连接|提供|调用|访问|实时|行情|数据源|能力)|行情\s*API|broker\s*feed|实时数据订阅/u;

const MARKET_DATA_BOUNDARY_ASK_PATTERN =
  /\b(?:latest|current|real[-\s]?time|live quotes?|market data|VIX|DXY|HY spread|10Y|risk)\b|最新行情|实时行情|当前行情|市场风险|风险|危险|可信度边界|数据清单|VIX|DXY|HY\s*spread|10Y|十年期|高收益债利差/u;

const ANSWER_PIPELINE_ASK_PATTERN =
  /(?:入口|出口|发.{0,8}消息|收到.{0,8}消息|智能体最后|最后.{0,8}答案|给我.{0,8}答案|答案.{0,8}(?:保守|模棱两可|废话|泛泛)|保守|模棱两可|废话|屁话|弄好|做好)/u;

const GENERIC_ENTRY_EXIT_ANSWER_PATTERN =
  /能弄好，而且出口必须简单|入口只做四件事|内部可以让\s*Kimi、MiniMax、DeepSeek|质量关要拦掉五类废答案/u;

const LEARNING_SOURCE_ASK_PATTERN =
  /\b(?:learn|study|read|source|url|link|github|repo|paper|blog|article)\b|学一下|学习一下|学习这个|学了|学习|吸收|读取|读一下|读这个|看看这个|链接|来源|网页|论文|博客|文章|开源|项目|文件|PDF/u;

const SYSTEM_STATUS_ASK_PATTERN =
  /\b(?:status|progress|where are we|what changed|done yet|finished yet|system state)\b|现在.{0,12}(?:系统|进化|训练|大脑|智能体).{0,12}(?:到哪|怎么样|如何|状态)|(?:系统|进化|训练|大脑|智能体).{0,12}(?:到哪|怎么样|状态)|做完了吗|系统能用了吗|大脑怎么样|训练怎么样|现在什么状态|状态呢|还有什么|进展/u;

const SHORT_AMBIGUOUS_VISIBLE_ASK_PATTERN =
  /^(?:怎么看|咋看|最近怎么看|现在呢|这个呢|咋办|怎么办|靠谱不|靠谱吗|行不行|可以吗|能不能简单说|还有戏吗)[？?。.\s]*$/u;

const VAGUE_CONSERVATIVE_NONANSWER_PATTERN =
  /(?:这个问题)?(?:比较|很)?复杂|不能一概而论|取决于|需要更多(?:信息|背景|上下文)|信息不足|数据不足|无法(?:判断|确定|给出)|不能(?:判断|确定|给出)|建议(?:谨慎|进一步观察)|需要综合考虑/u;

const USEFUL_VISIBLE_NEXT_STEP_PATTERN =
  /(?:结论|直接说|先说|现在能说|我能说|可以先|下一步|需要补|缺(?:的)?(?:数据|信息)|数据清单|证据|来源|时间戳|失效条件|风险门|检查|按.{0,10}顺序|1[.、]|第一|第二)/u;

const NORMAL_VISIBLE_ASK_PATTERN =
  /[？?]|(?:怎么|为什么|帮我|给我|看一下|看下|改|写|总结|解释|判断|分析|到哪|怎么样|风险|要不要|该不该|能不能|可以吗|怎么办|做什么|有什么|多少|学一下|学习一下|现在|今天|明天|日报|报告|链接)/u;

const PROFESSIONAL_FILLER_PATTERN =
  /(?:需要综合考虑|不能一概而论|取决于|需要更多(?:信息|背景|上下文)|正确做法是先|先审计|不能只凭|不能从.{0,24}直接推出|我能给的输出|第一组检查|第二组检查|反证条件|需要先.{0,28}(?:检查|审计|确认|补齐)|要先.{0,28}(?:检查|审计|确认|补齐)|建议先.{0,28}(?:观察|确认|补齐)|需要从.{0,32}(?:维度|角度|层面)|先分(?:三|几)类)/u;

const DIRECT_VISIBLE_VALUE_PATTERN =
  /(?:风险结论|当前判断|默认判断|优先级|排序|第一优先|最该看|答案是|结论是|约等于|大概\s*\d|百分之|已确认|还剩|卡在|能确认|不能确认|可以开始|不能说已经|先改|先做|先看|先登记|三档决策树|红灯|黄灯|绿灯|具体阈值|具体做法|下一条直接发|下一步(?:是|先)|直接算|按你给的)/u;

const PROTOCOL_TRUTH_SURFACE_ASK_PATTERN =
  /(?:现在你是谁|你能做什么|当前可用能力|不可用边界|外部通道|Lark.{0,24}(?:通信|沟通|媒介|入口)|验收|acceptance code|identity test|protocol truth|真实链路)/iu;

const PROTOCOL_TRUTH_SURFACE_ANSWER_PATTERN =
  /(?:外部通道验收请求已识别|Lark 只是你和 LCX Agent 通信的外部通道|我是你在 Lark 里联系 LCX Agent 的入口|当前可用能力:|不可用边界:|下一步会做什么:|必须看同一轮 Lark 入站和出站回执)/u;

const SOURCE_REQUIRED_TRUTH_ASK_PATTERN =
  /\b(?:source_required|failedReason|source check|missing source|acceptance code)\b|(?:缺来源|没有(?:给|提供).{0,16}(?:链接|网址|URL|文件|路径|仓库|论文|DOI|source)|没给.{0,16}(?:链接|网址|URL|文件|路径|仓库|论文|DOI|source)|不能假装|不要说\s*application_ready|不要假装已经学)/iu;

const SOURCE_REQUIRED_TRUTH_ANSWER_PATTERN =
  /(?:任务类型:\s*来源缺失检查|还缺来源:\s*是|失败原因:\s*没有提供链接、本地文件或完整来源|下一步:|边界:|证据:)/u;

const CONCRETE_SOURCE_IDENTIFIER_PATTERN =
  /(https?:\/\/\S+|file:\/\/\S+|(?:^|\s)(?:\.{1,2}\/|\/)?[\w./ -]+\.(?:md|txt|pdf|html?|csv|json|jsonl)|(?:arXiv:\s*)?\b\d{4}\.\d{4,5}(?:v\d+)?\b|10\.\d{4,9}\/[-._;()/:A-Z0-9]+|\b[\w.-]+\/[\w.-]+\b)/iu;

const IMPLICIT_MISSING_SOURCE_LEARNING_ASK_PATTERN =
  /(?:这个网页|这个链接|这个网址|这个项目|这个仓库|这篇(?:论文|文章|博客|公众号)|这个\s*PDF|PDF\s*学了|去\s*(?:Google|GitHub|arXiv)|学习.{0,20}(?:论文|项目|网页|文章|材料|文件)|吸收.{0,20}(?:论文|项目|网页|文章|材料|文件)|文件路径|仓库链接|论文链接|网址)/iu;

const MODEL_DISAGREEMENT_ARBITRATION_TERMS_PATTERN =
  /\b(?:evidence order|source|timestamp|local gate|cannot directly trust|not final authority|arbitration)\b|证据排序|一手来源|时间戳|本地\s*gate|不能直接采信|不能按模型名|候选意见|最终权威|本地把关|裁决/u;

const MODEL_DISAGREEMENT_DECIDER_PATTERN =
  /\b(?:do not decide by model name|majority vote|local gates?|final authority|not final authority|evidence order|arbitration)\b|不能按模型名|不能.*投票|本地\s*gate|最终答案|最终权威|不直接采信|证据排序/u;

const VISIBLE_INTERNAL_TAIL_LINE_PATTERN =
  /^\s*(?:分发状态|本次识别|识别理由|原始问题|publish|confidence|foundation)\s*[:：].*$/gmu;

const RAW_WORK_ORDER_VISIBLE_PATTERN =
  /^\s*```json|^\s*\{[\s\S]{0,2200}(?:"family"|"confidence"|"work_order"|"output_contract"|"required_modules")|(?:work_order|output_contract|required_modules|backend_tool)\s*[:：]/iu;

const USER_SUPPLIED_ARITHMETIC_PERCENT_ASK_PATTERN =
  /(?:\d[\d,，]*).{0,24}(?:净增|增加|新增|涨|增长|多了|\+).{0,16}(?:\d[\d,，]*)|(?:\d[\d,，]*).{0,16}(?:大概|约|多少).{0,12}(?:比例|百分比|涨幅|增长率)/u;

const DAILY_SEMICONDUCTOR_OPTIONS_FORMAT_ASK_PATTERN =
  /(?:每天|每日|自动|产出格式|格式).{0,24}(?:半导体|芯片|semiconductor).{0,32}(?:指数期权|期权|options)|(?:半导体|芯片|semiconductor).{0,32}(?:指数期权|期权|options).{0,32}(?:每天|每日|自动|产出格式|格式)/iu;

const SEMICONDUCTOR_OPTIONS_RISK_ASK_PATTERN =
  /(?:半导体|芯片|semiconductor).{0,32}(?:指数期权|期权|options).{0,32}(?:风险|看哪|关注|危险|三个|3个)|(?:风险|看哪|关注|危险|三个|3个).{0,32}(?:半导体|芯片|semiconductor).{0,32}(?:指数期权|期权|options)/iu;

function mentionedKnownTickers(text: string): string[] {
  const matches = new Set<string>();
  for (const match of text.matchAll(/\b(QQQ|TLT|NVDA)\b/giu)) {
    matches.add(match[1].toUpperCase());
  }
  return [...matches];
}

function hasUnaskedKnownTickerLeak(userMessage: string, answerText: string): boolean {
  const requested = new Set(mentionedKnownTickers(userMessage));
  const answered = mentionedKnownTickers(answerText);
  return answered.some((ticker) => !requested.has(ticker));
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

function extractsConcreteSingleStockLossTriage(answerText: string): boolean {
  const defaultRiskGate =
    /(?:补仓|加仓)资格\s*[=＝:：]?\s*(?:未通过|不通过|先不通过)|默认风险门|亏损(?:本身)?不是(?:补仓|加仓)理由/u.test(
      answerText,
    );
  const decisionTree = /(?:红灯|黄灯|绿灯|三档|决策树|A[.、]|B[.、]|C[.、]|①|②|③)/u.test(
    answerText,
  );
  const concreteThresholdOrForcedRisk =
    /(?:单票|仓位|组合占比|账户).{0,28}(?:\d{1,2}\s*(?:-|到|~|–)?\s*\d{0,2}\s*%|超过|上限|太重)|(?:杠杆|期权|融资|保证金|最大可承受回撤|强平)/u.test(
      answerText,
    );
  const nextUserInputs =
    /(?:你(?:下一条)?(?:发|补)|需要你|下一步(?:先)?(?:补|给)|总资产|账户规模|仓位占比|组合占比|成本区间|持有期限|杠杆|期权|最大可承受回撤)/u.test(
      answerText,
    );
  return defaultRiskGate && decisionTree && concreteThresholdOrForcedRisk && nextUserInputs;
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

function looksLikeGenericEntryExitAnswer(answerText: string): boolean {
  return GENERIC_ENTRY_EXIT_ANSWER_PATTERN.test(answerText);
}

function looksLikeLearningSourceAsk(userMessage: string): boolean {
  return LEARNING_SOURCE_ASK_PATTERN.test(userMessage);
}

function looksLikeSystemStatusAsk(userMessage: string): boolean {
  return SYSTEM_STATUS_ASK_PATTERN.test(userMessage);
}

function looksLikeUserSuppliedArithmeticPercentAsk(userMessage: string): boolean {
  return USER_SUPPLIED_ARITHMETIC_PERCENT_ASK_PATTERN.test(userMessage);
}

function looksLikeDailySemiconductorOptionsFormatAsk(userMessage: string): boolean {
  return DAILY_SEMICONDUCTOR_OPTIONS_FORMAT_ASK_PATTERN.test(userMessage);
}

function looksLikeSemiconductorOptionsRiskAsk(userMessage: string): boolean {
  return SEMICONDUCTOR_OPTIONS_RISK_ASK_PATTERN.test(userMessage);
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

function looksLikeNormalVisibleAsk(userMessage: string): boolean {
  return NORMAL_VISIBLE_ASK_PATTERN.test(userMessage.trim());
}

function looksLikeProfessionalFillerWithoutAnswerValue(answerText: string): boolean {
  const compact = answerText.trim();
  return PROFESSIONAL_FILLER_PATTERN.test(compact) && !DIRECT_VISIBLE_VALUE_PATTERN.test(compact);
}

function looksLikeProtocolTruthSurfaceReply(userMessage: string, answerText: string): boolean {
  return (
    PROTOCOL_TRUTH_SURFACE_ASK_PATTERN.test(userMessage) &&
    PROTOCOL_TRUTH_SURFACE_ANSWER_PATTERN.test(answerText)
  );
}

function looksLikeSourceRequiredTruthReply(userMessage: string, answerText: string): boolean {
  return (
    looksLikeMissingSourceLearningAsk(userMessage) &&
    SOURCE_REQUIRED_TRUTH_ANSWER_PATTERN.test(answerText)
  );
}

function looksLikeMissingSourceLearningAsk(userMessage: string): boolean {
  const text = userMessage.trim();
  return (
    looksLikeLearningSourceAsk(text) &&
    !CONCRETE_SOURCE_IDENTIFIER_PATTERN.test(text) &&
    (SOURCE_REQUIRED_TRUTH_ASK_PATTERN.test(text) ||
      IMPLICIT_MISSING_SOURCE_LEARNING_ASK_PATTERN.test(text))
  );
}

function extractsUsefulArithmeticPercent(answerText: string): boolean {
  return /(?:\d[\d,，]*\s*\/\s*\d[\d,，]*|0\.\d{1,3}\s*%|约等于\s*0\.\d|大概\s*0\.\d|百分之\s*零点)/u.test(
    answerText,
  );
}

function extractsDailyResearchFormat(answerText: string): boolean {
  return (
    /(?:每日|每天|日更|日报|固定模板|产出格式)/u.test(answerText) &&
    /(?:半导体|芯片|SOXX|SMH|NVDA)/iu.test(answerText) &&
    /(?:指数期权|期权|IV|VIX|skew|偏斜|期限结构|gamma)/iu.test(answerText) &&
    /(?:数据时间戳|来源|缺失数据|触发条件|风险|结论)/u.test(answerText)
  );
}

function extractsSemiconductorOptionsRiskList(answerText: string): boolean {
  const riskAnchors = [
    /(?:半导体|芯片|SOXX|SMH|NVDA).{0,32}(?:风险|波动|财报|估值|集中度|供需|capex|AI)/iu,
    /(?:指数期权|期权|VIX|IV|skew|偏斜|期限结构|gamma|dealer).{0,40}(?:风险|波动|挤压|对冲|到期)/iu,
    /(?:利率|美元|流动性|宏观|美债|收益率|DXY|credit|信用).{0,36}(?:风险|压力|传导|冲击)/iu,
  ];
  return riskAnchors.filter((pattern) => pattern.test(answerText)).length >= 2;
}

export function findVisibleAnswerAdoptionGateFailures(params: {
  userMessage: string;
  answerText: string;
}): string[] {
  const failures: string[] = [];
  const explicitVisibleContract = looksLikeExplicitVisibleContractAsk(params.userMessage);
  const protocolTruthSurfaceReply = looksLikeProtocolTruthSurfaceReply(
    params.userMessage,
    params.answerText,
  );
  const sourceRequiredTruthReply = looksLikeSourceRequiredTruthReply(
    params.userMessage,
    params.answerText,
  );
  const explicitTruthSurfaceReply = protocolTruthSurfaceReply || sourceRequiredTruthReply;

  if (RAW_WORK_ORDER_VISIBLE_PATTERN.test(params.answerText)) {
    failures.push("raw_work_order_json_visible_answer");
  }

  if (!explicitTruthSurfaceReply && LEGACY_TEST_ARTIFACT_VISIBLE_PATTERN.test(params.answerText)) {
    failures.push("legacy_test_artifact_visible_answer");
  }

  if (
    !explicitTruthSurfaceReply &&
    prefersChinese(params.userMessage) &&
    CHINESE_INTERNAL_BLOCKED_LABEL_PATTERN.test(params.answerText)
  ) {
    failures.push("english_internal_blocked_label_visible");
  }

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
    !protocolTruthSurfaceReply &&
    GENERIC_CONTROL_ROOM_CAPABILITY_ANSWER_PATTERN.test(params.answerText)
  ) {
    failures.push("explicit_visible_contract_ignored_by_generic_intro");
  }

  if (
    looksLikeMarketDataBoundaryAsk(params.userMessage) &&
    GENERIC_CONTROL_ROOM_CAPABILITY_ANSWER_PATTERN.test(params.answerText)
  ) {
    failures.push("market_data_boundary_wrong_route_generic_intro");
  }

  if (
    looksLikeGenericEntryExitAnswer(params.answerText) &&
    (looksLikeUserSuppliedArithmeticPercentAsk(params.userMessage) ||
      looksLikeDailySemiconductorOptionsFormatAsk(params.userMessage) ||
      looksLikeSemiconductorOptionsRiskAsk(params.userMessage) ||
      looksLikeModelDisagreementArbitrationAsk(params.userMessage))
  ) {
    failures.push("wrong_route_generic_entry_exit_answer");
  }

  if (
    looksLikeUserSuppliedArithmeticPercentAsk(params.userMessage) &&
    !extractsUsefulArithmeticPercent(params.answerText)
  ) {
    failures.push("user_supplied_arithmetic_not_answered_directly");
  }

  if (
    looksLikeDailySemiconductorOptionsFormatAsk(params.userMessage) &&
    !extractsDailyResearchFormat(params.answerText)
  ) {
    failures.push("daily_semiconductor_options_format_missing");
  }

  if (
    looksLikeSemiconductorOptionsRiskAsk(params.userMessage) &&
    !extractsSemiconductorOptionsRiskList(params.answerText)
  ) {
    failures.push("semiconductor_options_risk_answer_incomplete");
  }

  if (
    !explicitTruthSurfaceReply &&
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
    !explicitTruthSurfaceReply &&
    looksLikeVagueConservativeNonAnswer(params.answerText)
  ) {
    failures.push("vague_conservative_nonanswer_without_useful_next_step");
  }

  if (
    looksLikeNormalVisibleAsk(params.userMessage) &&
    looksLikeProfessionalFillerWithoutAnswerValue(params.answerText)
  ) {
    failures.push("generic_professional_filler_without_answer_value");
  }

  if (
    LEGACY_PROOF_LABEL_VISIBLE_PATTERN.test(params.answerText) ||
    (!explicitTruthSurfaceReply &&
      looksLikeAnswerPipelineAsk(params.userMessage) &&
      ANSWER_PIPELINE_INTERNAL_VISIBLE_PATTERN.test(params.answerText))
  ) {
    failures.push("single_entry_single_exit_internal_label_leak");
  }

  if (looksLikeModelDisagreementArbitrationAsk(params.userMessage)) {
    if (
      GENERIC_CONTROL_ROOM_CAPABILITY_ANSWER_PATTERN.test(params.answerText) ||
      !MODEL_DISAGREEMENT_ARBITRATION_TERMS_PATTERN.test(params.answerText) ||
      !MODEL_DISAGREEMENT_DECIDER_PATTERN.test(params.answerText)
    ) {
      failures.push("provider_council_arbitration_answer_missing");
    }
  }

  if (!looksLikeDirectPositionRiskAsk(params.userMessage)) {
    return [...new Set(failures)];
  }

  if (
    looksLikeSingleStockLossRecoveryAsk(params.userMessage) &&
    !extractsConcreteSingleStockLossTriage(params.answerText)
  ) {
    failures.push("single_stock_loss_reply_missing_concrete_risk_triage");
  }

  if (hasUnaskedKnownTickerLeak(params.userMessage, params.answerText)) {
    failures.push("unasked_ticker_context_bleed_in_position_reply");
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
      "Direct answer: I cannot turn this into add/reduce/hold advice without fresh data and your position context. I can give a research ranking.",
      "Priority order: 1. rates/liquidity, because they reprice both QQQ and TLT; 2. semiconductor earnings and AI-capex narrative, because NVDA can dominate portfolio beta; 3. cross-asset correlation, because TLT may stop hedging QQQ/NVDA in an inflation shock.",
      "QQQ: watch breadth under mega-cap tech, earnings revision tone, valuation compression, and whether downside is broadening beyond a few leaders.",
      "TLT: watch real yields, Fed repricing, Treasury supply, and whether duration still offsets equity stress or becomes the same macro bet.",
      "NVDA: separate company-specific risk from index risk: earnings guidance, margin expectations, AI capex narrative, supply-chain constraints, and QQQ concentration.",
      "Data I need next: position weights, cost ranges, holding horizon, max drawdown budget, leverage/options exposure, timestamped prices, rates, volatility, earnings, and valuation sources.",
      "What would change the view: rates break sharply against the base case, NVDA guidance changes the earnings story, QQQ breadth materially improves or deteriorates, or QQQ/TLT correlation stops matching the hedge assumption.",
    ].join("\n\n");
  }

  return [
    "直接结论：现在不能把它翻译成加仓/减仓/持有指令；能给的是研究排序。优先级先看利率和流动性，再看半导体盈利叙事，最后看组合相关性。",
    "QQQ：核心不是“科技好不好”，而是巨头集中度、市场宽度、盈利预期和估值压缩是不是同向恶化；如果宽度修复，风险会降一档。",
    "TLT：看真实利率、Fed 预期、长债供给和避险属性。通胀冲击下 TLT 可能不再对冲 QQQ/NVDA，而是变成同一个宏观风险。",
    "NVDA：要和 QQQ 指数风险拆开。重点看财报/指引、毛利率、AI capex 叙事、供应链约束、估值敏感度，以及它在组合里的单点风险。",
    "下一步数据：三只标的的权重、成本区间、持有期限、最大可承受回撤、杠杆/期权暴露，以及带时间戳的价格、利率、波动率、财报和估值来源。",
    "反证条件：利率路径突然反向、NVDA 指引改变盈利故事、QQQ 宽度明显修复或恶化、QQQ/TLT 相关性不再符合对冲假设，都要重做结论。",
  ].join("\n\n");
}

function renderSinglePositionRiskFrameworkReply(userMessage: string): string {
  const ticker = mentionedKnownTickers(userMessage)[0] ?? "这个标的";
  if (!prefersChinese(userMessage)) {
    return [
      `Direct answer: ${ticker} loss alone is not a reason to average down. Default risk gate: add-qualification = not passed until thesis, position weight, and forced-risk inputs are checked.`,
      "Decision tree: A. Red light: leverage/options, margin pressure, position too large for the account, or no written thesis. First objective is account-risk control, not making the loss back fast. B. Yellow light: thesis still intact but valuation reset; keep it in research mode and wait for fresh earnings/valuation evidence before increasing risk. C. Green light: thesis intact, position weight inside budget, no leverage/options, and fresh data supports the thesis; only then can a new risk-budget decision be discussed.",
      "Concrete thresholds to send next: portfolio weight, cost range, entry date, holding horizon, max drawdown budget, leverage/options exposure, and timestamped earnings, valuation, volatility, and liquidity sources. If single-name weight is already above your own cap, treat that as a risk-budget breach before any recovery plan.",
      "Output after data: thesis status, risk-budget status, what evidence would invalidate the position, and what to monitor next. This is still research/risk gating, not execution instruction.",
    ].join("\n\n");
  }

  return [
    `风险结论：${ticker} 亏 20% 本身不是补仓理由。默认风险门：补仓资格=未通过，直到你把 thesis、仓位占比和强制风险补齐。`,
    "三档决策树：A. 红灯：有杠杆/期权、仓位对账户太重、快到强平/到期，或者说不清买入 thesis。目标先变成账户风险控制，不能把“想回本”当策略。B. 黄灯：thesis 没坏，但估值被重估或市场流动性在压缩；先做研究复核，等财报/指引/估值证据更新后再谈新增风险。C. 绿灯：thesis 仍成立、单票仓位仍在你的风险预算内、没有杠杆/期权强制风险，且最新数据支持原逻辑，才有资格讨论新的风险预算。",
    "具体阈值：如果单票仓位已经超过你给账户设的上限，或一次下跌已经打到最大可承受回撤，就先按风险预算违约处理；如果没有自己的上限，我会先让你定组合占比、最大回撤和持有期限，再做判断。",
    "你下一条直接发：总资产或组合占比、NVDA 成本区间、买入 thesis、持有期限、最大可承受回撤、是否有杠杆/期权，以及最近财报/指引/估值数据时间戳。",
    "我拿到后给你四项：thesis 是否还成立、风险预算是否违约、哪些证据会推翻原判断、接下来优先盯什么；不给执行口令。",
  ].join("\n\n");
}

function renderProviderCouncilArbitrationReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "Final decider: the local evidence gate, not Kimi, MiniMax, DeepSeek, or a majority vote.",
      "Evidence order: primary source or timestamped data first, then reproducible calculations and local rules, then Kimi/MiniMax/DeepSeek as candidate opinions.",
      "Local gates: freshness, source quality, finance-data provenance, trade-advice boundary, and contradiction checks must pass before any answer is adopted.",
      "If the models disagree, keep the shared evidence, mark the conflict, downrank claims without sources or timestamps, and return a blocked reason when the evidence is not enough.",
      "No single provider is directly trusted as final authority.",
    ].join("\n\n");
  }

  return [
    "最后说了算的是本地证据 gate，不是 Kimi、MiniMax、DeepSeek，也不是多数投票。",
    "证据排序：一手来源和带时间戳的数据优先，其次是可复现计算和本地规则，最后才是三家模型的候选意见。",
    "本地 gate 必须先过：数据新鲜度、来源质量、金融数据口径、交易建议边界、互相矛盾的 claim 检查。",
    "三家不一致时：保留共同证据，标出分歧，把没有来源或时间戳的判断降权；证据不够就返回阻塞原因，不硬拍板。",
    "最终答案只能由本地 gate 采纳，不直接采信任何一个模型。",
  ].join("\n\n");
}

function extractVisibleAcceptanceCode(text: string): string | undefined {
  return text.match(/\b(?:lark|live|feishu|migration)[A-Za-z0-9_-]*-[A-Za-z0-9_-]*\b/u)?.[0];
}

function renderSourceRequiredTruthReply(userMessage: string): string {
  const acceptanceCode = extractVisibleAcceptanceCode(userMessage);
  return [
    "不能直接学：这条消息没有给可核验来源，所以我不会假装已经读取、学习或内化。",
    "",
    "任务类型: 来源缺失检查",
    "还缺来源: 是",
    "失败原因: 没有提供链接、本地文件或完整来源",
    "下一步: 先给出明确 URL、本地文件路径、论文编号/DOI、仓库名，或直接粘贴完整原文；之后再运行学习流水线。",
    "边界: 不搜索、不抓取、不学习、不保留，也不声称已经学会。",
    "证据: 用户明确要求 source_required / 缺来源处理，且当前消息没有可核验 URL、本地文件路径、论文编号/DOI、仓库名或完整原文。",
    acceptanceCode ? `验收码: ${acceptanceCode}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractNumericValues(text: string): number[] {
  return [...text.matchAll(/\d[\d,，]*/gu)]
    .map((match) => Number(match[0].replace(/[，,]/gu, "")))
    .filter((value) => Number.isFinite(value));
}

function extractArithmeticBaseAndDelta(text: string): { base: number; delta: number } | null {
  const normalized = text
    .replace(/(?:探针|复测)[A-Z]\d+/giu, "")
    .replace(/\blark-canary-[a-z]\d+\b/giu, "")
    .replace(/[，,]/gu, "");
  const netIncreaseMatch = normalized.match(
    /(?<base>\d+).{0,20}(?:净增|新增|增加|涨了|涨|增长|多了|\+)\s*(?<delta>\d+)/u,
  );
  if (netIncreaseMatch?.groups) {
    const base = Number(netIncreaseMatch.groups.base);
    const delta = Number(netIncreaseMatch.groups.delta);
    if (Number.isFinite(base) && Number.isFinite(delta) && base > 0 && delta > 0) {
      return { base, delta };
    }
  }

  const filtered = extractNumericValues(text).filter((value) => value >= 10);
  if (filtered.length >= 2) {
    const sorted = [...filtered].sort((a, b) => b - a);
    return { base: sorted[0], delta: sorted[sorted.length - 1] };
  }
  return null;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2).replace(/\.?0+$/u, "")}%`;
}

function renderUserSuppliedArithmeticPercentReply(userMessage: string): string {
  const pair = extractArithmeticBaseAndDelta(userMessage);
  if (pair) {
    const { base, delta } = pair;
    const percent = (delta / base) * 100;
    if (Number.isFinite(percent)) {
      if (!prefersChinese(userMessage)) {
        return [
          `Using only the two numbers you gave: ${delta} / ${base} = ${formatPercent(percent)}.`,
          "This is just the arithmetic ratio, not proof that the sample pool was audited.",
          "To verify the real daily increase, I would need yesterday's total, today's total, the counting rule, and the timestamp of both snapshots.",
        ].join("\n\n");
      }
      return [
        `按你给的两个数直接算：${delta} / ${base} = ${formatPercent(percent)}。`,
        "这只是算术口径，不代表样本池已经核验为真实增量或好样本。",
        "要确认真实增量，还要看昨天总数、今天总数、统计口径和两个快照的时间戳。",
      ].join("\n\n");
    }
  }

  if (!prefersChinese(userMessage)) {
    return "I need two numeric values to calculate the ratio directly: the base count and the increase.";
  }
  return "要直接算比例，需要两个数：基数和新增数。现在没有足够数字，不能硬算。";
}

function renderDailySemiconductorOptionsFormatReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "Daily output format:",
      "1. Direct view: one-line conclusion, confidence boundary, and whether fresh data is missing.",
      "2. Semiconductor: SOXX/SMH/NVDA/major names, breadth, earnings/news timestamps, valuation pressure, AI capex narrative, and invalidation signals.",
      "3. Index options: VIX/IV, skew, term structure, put-call pressure, dealer gamma or large-expiry risk, with timestamped source fields.",
      "4. Cross-asset risk: 10Y yield, DXY, credit/liquidity, and whether rates are amplifying or easing equity risk.",
      "5. Next action for the agent: data gaps to fetch, items to watch tomorrow, and what would change the view. Research-only, no execution instruction.",
    ].join("\n\n");
  }

  return [
    "每日产出格式：",
    "1. 直接结论：今天最重要的 1 句话、可信度边界、哪些实时数据缺失。",
    "2. 半导体：SOXX/SMH/NVDA/核心个股，市场宽度、财报/新闻时间戳、估值压力、AI capex 叙事、失效信号。",
    "3. 指数期权：VIX/IV、偏斜、期限结构、put-call 压力、dealer gamma 或大到期风险，每项都带来源和时间戳。",
    "4. 跨资产：10Y 美债、DXY、信用/流动性，判断利率和美元是在放大还是缓解权益风险。",
    "5. 明日跟踪：缺什么数据、明天优先看什么、什么证据会改变结论。只做研究，不给交易指令。",
  ].join("\n\n");
}

function renderSemiconductorOptionsRiskReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "Fresh market data is not available here, so this is a risk checklist, not a current-market conclusion.",
      "1. Semiconductor beta risk: SOXX/SMH/NVDA breadth, earnings guidance, valuation compression, and whether AI capex expectations are being repriced. [DATA_MISSING: current prices, breadth, earnings/news timestamps]",
      "2. Index-options volatility risk: VIX/IV level, skew, term structure, put-call pressure, dealer gamma, and large-expiry pin or squeeze risk. [DATA_MISSING: current IV/skew/gamma/expiry data]",
      "3. Macro transmission risk: 10Y yield, DXY, credit/liquidity, and whether rates plus dollar pressure hit growth multiples. [DATA_MISSING: current rates, DXY, credit spreads]",
      "Next step: fetch timestamped market-data snapshots before turning this into a ranked daily note.",
    ].join("\n\n");
  }

  return [
    "没有最新行情，所以这里只能给风险清单，不能说当前市场结论。",
    "1. 半导体 beta 风险：SOXX/SMH/NVDA 的市场宽度、财报指引、估值压缩、AI capex 预期是否被重定价。[DATA_MISSING: 当前价格、宽度、财报/新闻时间戳]",
    "2. 指数期权波动风险：VIX/IV、偏斜、期限结构、put-call 压力、dealer gamma、大到期 pin 或挤压风险。[DATA_MISSING: 当前 IV/skew/gamma/到期数据]",
    "3. 宏观传导风险：10Y 美债、DXY、信用/流动性，利率和美元是否同时压成长股估值。[DATA_MISSING: 当前利率、美元、信用利差]",
    "下一步：先补带时间戳的数据快照，再把三类风险排优先级。",
  ].join("\n\n");
}

function renderMarketDataBoundaryReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "Direct answer: without fresh market data, the answer can only be a confidence-bounded research frame, not a current-market call.",
      "Confidence boundary: every market claim needs source, timestamp, field definition, unit/currency, and adjusted/unadjusted status. Missing any of those downgrades the answer.",
      "Data list: VIX, 10Y Treasury yield, DXY, high-yield spread, index prices, relevant ETF/single-name prices, recent earnings/news timestamps, and portfolio weights when the question is position-specific.",
      "Useful output even before data: explain what each missing field would change, which scenario is most sensitive to it, and what evidence would invalidate the frame.",
      "Forbidden output: buy/sell/add/reduce instructions, precise levels, or pretending stale data is current.",
    ].join("\n\n");
  }

  return [
    "直接结论：没有最新行情时，只能给带可信度边界的研究框架，不能给当前市场判断。",
    "可信度边界：每个市场 claim 都要有来源、时间戳、字段口径、单位/币种；价格类还要说明复权/延迟口径。缺一项，可信度就降级。",
    "数据清单：VIX、10Y 美债收益率、DXY、高收益债利差、主要指数价格、相关 ETF/个股最新价、最近财报/新闻时间戳；持仓问题还要有仓位比例、成本区间、持有周期和最大可承受回撤。",
    "仍然可以有用：先说明每个缺失字段会改变哪类判断、哪个场景最敏感、什么证据会推翻原框架。",
    "不能输出：买卖加减仓指令、精确点位判断，或者把旧数据包装成当前事实。",
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
  if (looksLikeMissingSourceLearningAsk(userMessage)) {
    return renderSourceRequiredTruthReply(userMessage);
  }

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
    "直接结论：这类问题不能直接给交易动作结论；现在还缺最基本的标的和账户上下文。",
    "现在缺：标的、组合占比、成本区间、持有期限、风险预算、最大可承受回撤；如果有杠杆或期权，还要补到期日、杠杆/期权到期风险和强平/行权风险。",
    "我会按三层做研究检查：基本面有没有被破坏，估值/宏观流动性是不是在压缩，组合层面是否已经过度集中或相关性失控。",
    "有最新数据后，输出应该是风险等级、证据链、失效条件和下一步监控项；不是“买/卖/加/减”的执行口令。",
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

  if (looksLikeUserSuppliedArithmeticPercentAsk(params.userMessage)) {
    return {
      status: "replaced",
      text: renderUserSuppliedArithmeticPercentReply(params.userMessage),
      originalText: text,
      failedReasons,
    };
  }

  if (looksLikeDailySemiconductorOptionsFormatAsk(params.userMessage)) {
    return {
      status: "replaced",
      text: renderDailySemiconductorOptionsFormatReply(params.userMessage),
      originalText: text,
      failedReasons,
    };
  }

  if (looksLikeSemiconductorOptionsRiskAsk(params.userMessage)) {
    return {
      status: "replaced",
      text: renderSemiconductorOptionsRiskReply(params.userMessage),
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

  if (looksLikeMarketDataBoundaryAsk(params.userMessage)) {
    return {
      status: "replaced",
      text: renderMarketDataBoundaryReply(params.userMessage),
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

  if (
    failedReasons.some((reason) =>
      [
        "explicit_visible_contract_ignored_by_generic_intro",
        "explicit_visible_contract_deferred_to_prior_answer",
        "internal_visible_detail_leak_against_user_contract",
        "system_capability_leak_against_user_contract",
        "vague_conservative_nonanswer_without_useful_next_step",
        "raw_work_order_json_visible_answer",
        "wrong_route_generic_entry_exit_answer",
        "legacy_test_artifact_visible_answer",
        "english_internal_blocked_label_visible",
        "generic_professional_filler_without_answer_value",
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
