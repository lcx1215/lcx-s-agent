export type VisibleAnswerAdoptionGateDecision = {
  status: "adopted" | "replaced";
  text: string;
  failedReasons: string[];
  originalText?: string;
};

const DIRECT_POSITION_ASK_PATTERN =
  /\b(?:buy|sell|add|reduce|hold|wait|position|sizing|average down|cut loss|stop loss|recover quickly|make.*back|call|put|margin|leverage|liquidation)\b|买|卖|加仓|减仓|持有|等待|仓位|持仓|补仓|摊低|摊平|割肉|止损|止盈|回本|快点回本|期权|财报|赌|梭哈|满仓|杠杆|保证金|爆仓/u;

const ACTION_STANCE_HEADING_PATTERN =
  /\b(?:current stance|action triggers)\b|##\s*(?:Current Stance|Action Triggers)\b/iu;

const ENGLISH_POSITION_ACTION_PATTERN =
  /\b(?:should|recommend|can|must|do not|don't|avoid|wait|hold)\b.{0,32}\b(?:buy|sell|add|reduce|average down|cut(?: the)? loss|hold|wait|stop loss|target price)\b/iu;

const CHINESE_POSITION_ACTION_PATTERN =
  /(?:应该|建议|可以|不要|别|先别|不建议|先说结论).{0,22}(买|卖|买入|卖出|加仓|减仓|补仓|摊低|摊平|割肉|砍仓|抄底|止损|止盈|持有|等待|赌|梭哈|满仓|加保证金|上杠杆|降杠杆)/u;

const CHINESE_ACTION_FRAMEWORK_PATTERN =
  /均价策略|止损策略|减亏两条路|抄底|砍仓|摊低成本|快点回本|赌财报|梭哈|满仓|加保证金|爆仓自救/u;

function looksLikeDirectPositionRiskAsk(userMessage: string): boolean {
  return DIRECT_POSITION_ASK_PATTERN.test(userMessage);
}

export function findVisibleAnswerAdoptionGateFailures(params: {
  userMessage: string;
  answerText: string;
}): string[] {
  if (!looksLikeDirectPositionRiskAsk(params.userMessage)) {
    return [];
  }

  const failures: string[] = [];
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

function renderPositionRiskRescueReply(userMessage: string): string {
  if (!prefersChinese(userMessage)) {
    return [
      "I can't give a direct trading action for this.",
      "Missing inputs: NVDA portfolio weight, cost range, time horizon, risk budget, max drawdown tolerance, and timestamped price, earnings, and valuation sources.",
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
  const text = params.answerText.trim();
  const failedReasons = findVisibleAnswerAdoptionGateFailures({
    userMessage: params.userMessage,
    answerText: text,
  });
  if (failedReasons.length === 0) {
    return { status: "adopted", text, failedReasons };
  }

  return {
    status: "replaced",
    text: renderPositionRiskRescueReply(params.userMessage),
    originalText: text,
    failedReasons,
  };
}
