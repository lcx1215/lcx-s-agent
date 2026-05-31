export type VisibleAnswerAdoptionGateDecision = {
  status: "adopted" | "replaced";
  text: string;
  failedReasons: string[];
  originalText?: string;
};

const DIRECT_POSITION_ASK_PATTERN =
  /\b(?:should\s+(?:i|we)|do\s+(?:i|we)|can\s+(?:i|we)|recommend|buy|sell|add|reduce|average down|cut loss|stop loss|recover quickly|make.*back|call|put|margin|leverage|liquidation)\b|买|卖|加仓|减仓|补仓|摊低|摊平|割肉|止损|止盈|回本|快点回本|赌|梭哈|满仓|杠杆|保证金|爆仓|要不要|该不该|应不应该|能不能|可不可以|到底应该|直接告诉我/u;

const HOLD_OR_WAIT_ACTION_ASK_PATTERN =
  /(?:要不要|该不该|应不应该|到底应该|建议|可以|直接告诉我).{0,16}(持有|继续拿着|继续拿|等待)/u;

const ACTION_STANCE_HEADING_PATTERN =
  /\b(?:current stance|action triggers)\b|##\s*(?:Current Stance|Action Triggers)\b/iu;

const ENGLISH_POSITION_ACTION_PATTERN =
  /\b(?:should|recommend|can|must|do not|don't|avoid|wait|hold)\b.{0,32}\b(?:buy|sell|add|reduce|average down|cut(?: the)? loss|hold|wait|stop loss|target price)\b/iu;

const CHINESE_POSITION_ACTION_PATTERN =
  /(?:应该|建议|可以|不要|别|先别|不建议|先说结论).{0,22}(买|卖|买入|卖出|加仓|减仓|补仓|摊低|摊平|割肉|砍仓|抄底|止损|止盈|持有|等待|赌|梭哈|满仓|加保证金|上杠杆|降杠杆)/u;

const CHINESE_ACTION_FRAMEWORK_PATTERN =
  /均价策略|止损策略|减亏两条路|抄底|砍仓|摊低成本|快点回本|赌财报|梭哈|满仓|加保证金|爆仓自救/u;

const STALE_PRIOR_ANSWER_DEFERRAL_PATTERN =
  /我(?:上一条|上条|刚才|前面)已经|上一条已经|已经给出|继续深化|想往哪个方向深|换一个方向|补充权重数据|分发状态/u;

const STANDALONE_PORTFOLIO_RISK_ASK_PATTERN =
  /(?:持有|组合|portfolio|holdings?).{0,40}(?:QQQ|TLT|NVDA).{0,80}(?:风险|risk|研究框架|失效条件|invalidation)|(?:QQQ|TLT|NVDA).{0,80}(?:风险|risk|研究框架|失效条件|invalidation)/iu;

const MODEL_DISAGREEMENT_ARBITRATION_ASK_PATTERN =
  /\b(?:provider council|model disagreement|which model|conflicting models)\b|大模型|三个模型|三家模型|模型意见|意见不一致|模型分歧|怎么裁决|听谁/u;

const GENERIC_CONTROL_ROOM_CAPABILITY_ANSWER_PATTERN =
  /我是\s*(?:LCX Agent|OpenClaw).{0,40}(?:Lark\s*)?控制室入口|当前可用能力|可以把自然语言请求分到|工作面|finance learning pipeline/u;

const MODEL_DISAGREEMENT_ARBITRATION_TERMS_PATTERN =
  /\b(?:evidence order|source|timestamp|local gate|cannot directly trust|not final authority|arbitration)\b|证据排序|一手来源|时间戳|本地\s*gate|不能直接采信|不能按模型名|候选意见|最终权威|本地把关|裁决/u;

const VISIBLE_INTERNAL_TAIL_LINE_PATTERN =
  /^\s*(?:分发状态|本次识别|识别理由|原始问题|边界)\s*[:：].*$/gmu;

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

export function findVisibleAnswerAdoptionGateFailures(params: {
  userMessage: string;
  answerText: string;
}): string[] {
  const failures: string[] = [];

  if (
    (looksLikeStandalonePortfolioRiskAsk(params.userMessage) ||
      looksLikeDirectPositionRiskAsk(params.userMessage)) &&
    STALE_PRIOR_ANSWER_DEFERRAL_PATTERN.test(params.answerText)
  ) {
    failures.push("stale_prior_answer_deferral_for_standalone_finance_ask");
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

function stripVisibleInternalTail(text: string): string {
  return text
    .replace(VISIBLE_INTERNAL_TAIL_LINE_PATTERN, "")
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

  if (looksLikeModelDisagreementArbitrationAsk(params.userMessage)) {
    return {
      status: "replaced",
      text: renderProviderCouncilArbitrationReply(params.userMessage),
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
