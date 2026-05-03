import { resolveKnownCapabilityDescriptor } from "../../commands/capabilities.js";

export type ProtocolInfoQuestionKind =
  | "snapshot"
  | "status_readback"
  | "help"
  | "lobster"
  | "dm"
  | "model"
  | "search_health"
  | "agent_architecture"
  | "learning_capability_state"
  | "capabilities"
  | "specific_capability"
  | "limitations"
  | "learning"
  | "learning_receipt"
  | "learning_application"
  | "promise_risk"
  | "persistence_state"
  | "write_outcome"
  | "improvement"
  | "error_type"
  | "runtime_model"
  | "fallback_reason"
  | "anchors";

export type SpecificCapabilityCheck = {
  label: string;
  providerCapability: string;
  genericTool: string | null;
};

const PROTOCOL_INFO_QUESTIONS = [
  "whats going on right now",
  "what's going on right now",
  "what is the current system state",
  "what is your current state",
  "what are you doing now",
  "what remains",
  "what is left",
  "how much is left",
  "is it live now",
  "is this live-fixed",
  "is this dev-fixed",
  "where are we now",
  "现在系统是什么状态",
  "你现在是什么状态",
  "现在什么状态",
  "现在在干什么",
  "继续现在在干什么",
  "现在到底在干什么",
  "现在修到哪了",
  "修到哪了",
  "还剩多少",
  "还剩什么",
  "现在还剩什么",
  "现在能用了吗",
  "是不是 live 了",
  "是不是live了",
  "是不是 live-fixed",
  "是不是 dev-fixed",
  "how do you work",
  "what protocol are you using",
  "whats your default mode",
  "what's your default mode",
  "what is your default mode",
  "is lobster on",
  "is the lobster plugin on",
  "what is lobster doing",
  "how does lobster work here",
  "are dm sessions isolated",
  "is dm isolated",
  "你现在怎么工作",
  "你现在按什么协议工作",
  "你现在用什么协议",
  "你默认按什么模式工作",
  "你默认是什么模式",
  "lobster开了吗",
  "lobster  开了吗",
  "lobster插件开了吗",
  "你现在是lobster模式吗",
  "dm是隔离的吗",
  "dm隔离吗",
  "私聊是隔离的吗",
  "私聊隔离吗",
  "what model are you using",
  "what model are you using now",
  "what model is active",
  "what model are you on",
  "what tools are actually connected",
  "what tools are connected right now",
  "what capabilities are actually connected",
  "which provider tools are connected",
  "is web search working",
  "is web search working now",
  "is search working now",
  "is browsing working now",
  "is provider health ok",
  "is provider health okay",
  "search health",
  "provider health",
  "web search health",
  "can you use web-search",
  "can you use fetch",
  "can you use memory",
  "can you use code_runner",
  "can you use code runner",
  "你能用 web-search 吗",
  "你能用 fetch 吗",
  "你能用 memory 吗",
  "你能用 code_runner 吗",
  "你能用 code runner 吗",
  "what provider tools are not connected",
  "are you multiple agents",
  "are you multi-agent",
  "are you a multi-agent system",
  "are you just one api",
  "are you just an api answering questions",
  "is this just api chat",
  "你是不是多个agent",
  "你是不是多agent",
  "你是不是多智能体",
  "你是多个agent吗",
  "你是多agent吗",
  "你是多智能体吗",
  "是不是纯靠api回答",
  "是不是纯 api 回答",
  "是不是一个api在回答",
  "是不是一个 api 在回答",
  "是不是只是api聊天",
  "是不是只是 api 聊天",
  "是不是多个工作面",
  "是不是多个surface",
  "是不是多个 surface",
  "哪些内部学习能力真的接上了",
  "哪些学习能力真的接上了",
  "内部学习能力哪些是真的",
  "finance learning pipeline 真的接上了吗",
  "finance learning pipeline 是 dev 还是 live",
  "learning_command 真的接上了吗",
  "学习管线真的接上了吗",
  "学习管线是 dev 还是 live",
  "金融学习管线真的接上了吗",
  "金融学习能力哪些是真的",
  "what capabilities are still missing",
  "what can you not do yet",
  "which provider-native tools are still missing",
  "你现在有哪些工具真的接上了",
  "你现在有哪些能力真的接上了",
  "哪些工具真的接上了",
  "哪些能力真的接上了",
  "provider tools 接上了吗",
  "你现在还缺哪些能力",
  "你现在还不能做什么",
  "哪些 provider tools 还没接上",
  "哪些能力还没接上",
  "搜索现在正常吗",
  "web search 现在正常吗",
  "搜索还坏着吗",
  "搜索现在能用吗",
  "provider 现在健康吗",
  "provider health 现在怎么样",
  "what did you learn today",
  "did you really learn it",
  "did that really stick",
  "what actually got learned today",
  "how would you learn from arxiv papers",
  "can you learn from new arxiv papers and apply it",
  "how do you learn useful parts from papers",
  "how do you get smarter",
  "do you get smarter from mistakes",
  "how do you improve from bad answers",
  "what was wrong with that answer",
  "where was that answer wrong",
  "what kind of mistake was that",
  "was that overclaiming",
  "did you overclaim",
  "do you distill from conversations",
  "今天学了什么",
  "今天真的学进去了吗",
  "真的学进去了吗",
  "你今天学了什么",
  "你会怎么学习arxiv上的文章并学会应用",
  "你能从新的arxiv文章里学会应用吗",
  "你会怎么学论文里的有用部分并应用",
  "did you pretend a background learning session started",
  "was that downgraded to a single audited learning pass",
  "did you overpromise the learning workflow",
  "did you pretend it was still running",
  "你是不是把单次 pass 说成后台持续学习了",
  "你是不是把降级执行说成完整执行了",
  "你是不是假装后台学习已经开始了",
  "你是不是把没启动说成在跑",
  "did that reach long-term storage",
  "is that only understood for the current session",
  "did the write actually stick",
  "is that in durable memory yet",
  "你是不是只在当前session里懂了",
  "你是不是还没写进长期记忆",
  "这是不是只在当前会话里懂了",
  "这是不是还没写进长期存储",
  "这次写入真的落了吗",
  "这次真的落盘了吗",
  "这是不是已经持久化了",
  "did the artifact write succeed",
  "did the write fail but stay understood in the current session",
  "is this only understood in the current session and not yet durable",
  "写入是不是失败了但当前session里已经懂了",
  "是不是写入没成但当前会话里已经理解了",
  "你会越对话越聪明吗",
  "你怎么变聪明",
  "你会从错误对话里学吗",
  "那个回答哪里不对",
  "那个回答错在哪",
  "这次错在什么类型",
  "这是哪类错误",
  "是不是过度承诺",
  "是不是没证据就下结论",
  "你会蒸馏训练吗",
  "what is the default model",
  "which model is default",
  "默认模型是什么",
  "你现在默认模型是什么",
  "你现在用的默认模型是什么",
  "你现在用的是什么模型",
  "你现在在用什么模型",
  "当前运行模型是什么",
  "当前模型是什么",
  "why is the active model different",
  "why is the runtime model different",
  "why are you not using the default model",
  "为什么不是默认模型",
  "为什么当前模型不一样",
  "为什么active model不一样",
  "为什么 active model 不一样",
  "what anchors are missing",
  "which anchors are missing",
  "what protected anchors are missing",
  "缺了哪些anchors",
  "缺了哪些 anchors",
  "缺了哪些protected anchors",
  "缺了哪些 protected anchors",
  "缺了哪些锚点",
] as const;

function includesAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => text === phrase || text.includes(phrase));
}

function looksLikeLearningTimeboxStatusAsk(text: string): boolean {
  const hasDirectStatusCue =
    /学习状态|学习进度|还在学|还在学习|学到哪|学完了吗|还没学完|timebox status|session status/u.test(
      text,
    );
  const hasLearningSessionCue =
    /(学习 session|learning session|限时学习|timebox|当前 session|学习一小时|持续学习|刚才让你学的那条)/u.test(
      text,
    );
  const hasSessionLivenessCue =
    /(还活着吗|还在跑吗|还在运行吗|在跑吗|会不会冲掉|冲掉当前 session|冲掉当前的 session)/u.test(
      text,
    );
  return hasDirectStatusCue || (hasLearningSessionCue && hasSessionLivenessCue);
}

function looksLikeLearningInternalizationAuditAsk(text: string): boolean {
  const hasLearningHistoryCue =
    /(最近学的|最近吸收的|最近看的|最近读的|之前学的|学过的|上次学的|前几天读的|前阵子学的|最近开源里学的|最近论文里学的)/u.test(
      text,
    );
  const hasInternalizationAuditCue =
    /(有没有内化|内化成|可复用规则|真的有用|到底有没有用|值不值得留下|沉淀成|会改你以后|进规矩|长期记忆|留下啥了|过眼云烟|改掉你)/u.test(
      text,
    );
  return hasLearningHistoryCue && hasInternalizationAuditCue;
}

function looksLikeLearningWorkflowAuditAsk(text: string): boolean {
  const hasLearningWorkflowCue =
    /(后台自动学习|自动学习后台|后台那条学习链|那条后台学习|昨天让你学|前天让你学|最近学的|学的东西)/u.test(
      text,
    );
  const hasAuditCue =
    /(卡住|卡在哪|写进记忆|写进长期记忆|写进脑子|进长期记忆|只是生成了报告|只是出了报告|装样子|改变你自己的行为|完成了|失败了|假装在跑|半路断过|断过|真落账|留痕)/u.test(
      text,
    );
  return hasLearningWorkflowCue && hasAuditCue;
}

function isSpecificCapabilityQuestion(text: string): boolean {
  const mentionsCapability = Boolean(resolveKnownCapabilityDescriptor(text));
  const asksAbility =
    includesAny(text, ["can you use", "can you", "你能用", "能不能用", "能用吗", "有没有"]) ||
    text.endsWith("吗");
  return mentionsCapability && asksAbility;
}

function isLearningTruthQuestion(text: string): boolean {
  const mentionsLearning = ["learn", "learned", "stick", "学了什么", "学进去", "学进去了"].some(
    (phrase) => text.includes(phrase),
  );
  const asksTruth = ["today", "really", "actually", "今天", "真的", "到底"].some((phrase) =>
    text.includes(phrase),
  );
  return mentionsLearning && asksTruth;
}

function isLearningReceiptQuestion(text: string): boolean {
  if (
    looksLikeLearningTimeboxStatusAsk(text) ||
    looksLikeLearningInternalizationAuditAsk(text) ||
    looksLikeLearningWorkflowAuditAsk(text)
  ) {
    return true;
  }
  const hasMemoryVsReportAuditCue =
    text.includes("report") &&
    ["写进脑子", "写进记忆", "落账", "装样子", "躺在 report"].some((phrase) =>
      text.includes(phrase),
    );
  if (hasMemoryVsReportAuditCue) {
    return true;
  }
  const mentionsLearningSubject = [
    "learn",
    "learning",
    "paper",
    "papers",
    "article",
    "articles",
    "arxiv",
    "论文",
    "文章",
    "学习",
    "学那篇",
    "学的那条",
    "那篇论文",
  ].some((phrase) => text.includes(phrase));
  const mentionsReceiptOrAudit = [
    "started",
    "still running",
    "running",
    "executing",
    "execution",
    "receipt",
    "session",
    "timebox",
    "artifact",
    "lesson",
    "report",
    "write into memory",
    "wrote into memory",
    "开始学",
    "还在跑",
    "还活着",
    "在执行",
    "只是在解释",
    "沉淀成",
    "写进记忆",
    "写进脑子",
    "落账",
    "躺在 report",
  ].some((phrase) => text.includes(phrase));
  const asksMeta = [
    "did",
    "have",
    "are you",
    "is it",
    "真的吗",
    "真的",
    "有没有",
    "是不是",
    "吗",
    "现在",
    "刚才",
    "已经",
  ].some((phrase) => text.includes(phrase));
  return mentionsLearningSubject && mentionsReceiptOrAudit && asksMeta;
}

function isLearningApplicationQuestion(text: string): boolean {
  const mentionsSource = ["arxiv", "paper", "papers", "article", "articles", "论文", "文章"].some(
    (phrase) => text.includes(phrase),
  );
  const mentionsLearning = ["learn", "apply", "useful", "学", "应用", "有用"].some((phrase) =>
    text.includes(phrase),
  );
  const asksMeta = ["how", "can you", "would you", "你会", "你能", "怎么", "如何", "能不能"].some(
    (phrase) => text.includes(phrase),
  );
  return mentionsSource && mentionsLearning && asksMeta;
}

function isPromiseRiskQuestion(text: string): boolean {
  const mentionsExecutionClaim = [
    "background learning session",
    "single audited learning pass",
    "overpromise",
    "pretend",
    "still running",
    "started",
    "downgraded",
    "后台持续学习",
    "降级执行",
    "完整执行",
    "假装",
    "在跑",
    "已启动",
    "后台学习",
    "单次 pass",
  ].some((phrase) => text.includes(phrase));
  const asksAudit = ["did you", "was that", "是不是", "有没有", "说成", "假装"].some((phrase) =>
    text.includes(phrase),
  );
  return mentionsExecutionClaim && asksAudit;
}

function isPersistenceStateQuestion(text: string): boolean {
  const mentionsDurability = [
    "long-term storage",
    "durable memory",
    "current session",
    "write actually stick",
    "really persisted",
    "写进长期记忆",
    "长期存储",
    "当前session",
    "当前会话",
    "写入真的落",
    "落进长期记忆",
    "进长期记忆",
    "持久化",
    "落账",
  ].some((phrase) => text.includes(phrase));
  const asksAudit = ["did that", "is that", "是不是", "还没", "真的", "真", "到底"].some((phrase) =>
    text.includes(phrase),
  );
  return mentionsDurability && asksAudit;
}

function isWriteOutcomeQuestion(text: string): boolean {
  const mentionsWriteState = [
    "artifact write succeed",
    "write fail",
    "current session",
    "not yet durable",
    "写入",
    "写失败",
    "没写进去",
    "落盘",
    "持久化",
    "落账",
    "当前session",
    "当前会话",
    "没成",
    "失败了",
  ].some((phrase) => text.includes(phrase));
  const asksOutcome = ["did the", "is this", "是不是", "已经", "真的", "真", "到底", "没有"].some(
    (phrase) => text.includes(phrase),
  );
  return mentionsWriteState && asksOutcome;
}

function isImprovementQuestion(text: string): boolean {
  const mentionsImprovement = [
    "smarter",
    "improve",
    "improved",
    "mistake",
    "mistakes",
    "wrong",
    "error",
    "distill",
    "聪明",
    "变聪明",
    "改进",
    "错误",
    "不对",
    "错在",
    "蒸馏",
  ].some((phrase) => text.includes(phrase));
  const asksMethodOrTruth = [
    "what",
    "how",
    "where",
    "from",
    "really",
    "会",
    "怎么",
    "哪里",
    "是不是",
  ].some((phrase) => text.includes(phrase));
  return mentionsImprovement && asksMethodOrTruth;
}

function isErrorTypeQuestion(text: string): boolean {
  const mentionsErrorType = [
    "kind of mistake",
    "overclaim",
    "wrong type",
    "哪类错误",
    "什么类型",
    "过度承诺",
    "没证据",
  ].some((phrase) => text.includes(phrase));
  const asksClassification = ["what", "was", "did", "是", "是不是", "这次"].some((phrase) =>
    text.includes(phrase),
  );
  return mentionsErrorType && asksClassification;
}

function isConnectedCapabilitiesQuestion(text: string): boolean {
  const mentionsCapability = ["tools", "capabilities", "provider tools", "工具", "能力"].some(
    (phrase) => text.includes(phrase),
  );
  const asksConnected = ["connected", "接上", "真的接上", "真的能用", "能用", "可用"].some(
    (phrase) => text.includes(phrase),
  );
  const hasNegativeSignal = ["not connected", "still missing", "还缺", "还不能", "没接上"].some(
    (phrase) => text.includes(phrase),
  );
  return mentionsCapability && asksConnected && !hasNegativeSignal;
}

function isSearchHealthQuestion(text: string): boolean {
  const asksAbility = ["can you use", "can you", "你能用", "能不能用", "能用吗"].some((phrase) =>
    text.includes(phrase),
  );
  if (asksAbility) {
    return false;
  }
  const mentionsSearchOrProvider = [
    "web search",
    "search",
    "browsing",
    "provider health",
    "provider",
    "搜索",
    "检索",
    "浏览",
    "provider",
  ].some((phrase) => text.includes(phrase));
  const asksCurrentState = [
    "working",
    "working now",
    "health",
    "ok",
    "okay",
    "degraded",
    "now",
    "正常",
    "还坏着",
    "能用",
    "有没有",
    "可用",
    "健康",
    "现在",
    "到底",
  ].some((phrase) => text.includes(phrase));
  return mentionsSearchOrProvider && asksCurrentState;
}

function isMissingCapabilitiesQuestion(text: string): boolean {
  const mentionsCapability = [
    "provider tools",
    "provider-native tools",
    "capabilities",
    "工具",
    "能力",
  ].some((phrase) => text.includes(phrase));
  const asksMissing = [
    "not connected",
    "still missing",
    "not do yet",
    "还缺",
    "还不能",
    "没接上",
    "缺什么",
    "差什么",
  ].some((phrase) => text.includes(phrase));
  return (mentionsCapability && asksMissing) || text.includes("还不能做什么");
}

function isAgentArchitectureQuestion(text: string): boolean {
  const mentionsAgentArchitecture = [
    "multi-agent",
    "multiple agents",
    "agent system",
    "agents",
    "subagents",
    "just one api",
    "just api",
    "api chat",
    "多个agent",
    "多agent",
    "多智能体",
    "多个智能体",
    "子agent",
    "子智能体",
    "纯靠api",
    "纯 api",
    "一个api",
    "一个 api",
    "只是api",
    "只是 api",
    "多个工作面",
    "多个surface",
    "多个 surface",
    "多角色",
  ].some((phrase) => text.includes(phrase));
  const asksTruthOrComparison = [
    "are you",
    "is this",
    "or",
    "versus",
    "vs",
    "just",
    "是不是",
    "还是",
    "到底",
    "吗",
    "区别",
    "一样",
  ].some((phrase) => text.includes(phrase));
  return mentionsAgentArchitecture && asksTruthOrComparison;
}

function isLearningCapabilityStateQuestion(text: string): boolean {
  const mentionsLearningCapability = [
    "learning capability",
    "learning capabilities",
    "learning pipeline",
    "learning_command",
    "finance learning",
    "finance-learning",
    "内部学习能力",
    "学习能力",
    "学习管线",
    "金融学习",
    "金融学习管线",
    "以前的学习能力",
    "已有学习能力",
  ].some((phrase) => text.includes(phrase));
  const asksTruthOrState = [
    "connected",
    "really connected",
    "dev",
    "live",
    "dev-fixed",
    "live-fixed",
    "state",
    "status",
    "真的接上",
    "是真的",
    "哪些是真的",
    "接上了吗",
    "能用",
    "可用",
    "状态",
    "dev 还是 live",
    "开发",
    "线上",
    "live 还是 dev",
  ].some((phrase) => text.includes(phrase));
  return mentionsLearningCapability && asksTruthOrState;
}

function isRuntimeModelQuestion(text: string): boolean {
  const mentionsModel = ["model", "模型"].some((phrase) => text.includes(phrase));
  const asksRuntime = [
    "active",
    "runtime",
    "using now",
    "are you on",
    "当前",
    "运行",
    "现在",
    "在回我",
    "回我的",
  ].some((phrase) => text.includes(phrase));
  return mentionsModel && asksRuntime;
}

function isFallbackReasonQuestion(text: string): boolean {
  const mentionsFallback = ["fallback", "回退", "降级", "切模型", "换模型"].some((phrase) =>
    text.includes(phrase),
  );
  const asksReasonOrTruth = [
    "why",
    "reason",
    "是不是",
    "有没有",
    "为什么",
    "偷偷",
    "悄悄",
    "现在",
  ].some((phrase) => text.includes(phrase));
  return mentionsFallback && asksReasonOrTruth;
}

function isStatusReadbackQuestion(text: string): boolean {
  const mentionsStatus = [
    "what are you doing now",
    "what remains",
    "what is left",
    "how much is left",
    "where are we now",
    "status audit",
    "status readback",
    "what did you just fix",
    "current evidence",
    "live-fixed",
    "dev-fixed",
    "unverified",
    "现在在干什么",
    "继续现在在干什么",
    "现在到底在干什么",
    "修到哪",
    "还剩多少",
    "还剩什么",
    "现在还剩什么",
    "剩下什么",
    "现在能用",
    "能用了",
    "到哪一步",
  ].some((phrase) => text.includes(phrase));
  const asksLiveState = [
    "is it live",
    "is this live",
    "live 了",
    "live了",
    "上 live",
    "上线",
    "真实 lark",
    "真实 feishu",
  ].some((phrase) => text.includes(phrase));
  const asksCurrent = [
    "now",
    "current",
    "left",
    "remains",
    "is this",
    "remaining",
    "现在",
    "到底",
    "还有",
    "还剩",
    "是不是",
    "了吗",
  ].some((phrase) => text.includes(phrase));
  return (mentionsStatus || asksLiveState) && asksCurrent;
}

function matchesProtocolInfoQuestion(text: string): boolean {
  return (
    PROTOCOL_INFO_QUESTIONS.some((phrase) => text === phrase || text.includes(phrase)) ||
    isStatusReadbackQuestion(text) ||
    isSpecificCapabilityQuestion(text) ||
    isSearchHealthQuestion(text) ||
    isLearningTruthQuestion(text) ||
    isLearningReceiptQuestion(text) ||
    isLearningApplicationQuestion(text) ||
    isPromiseRiskQuestion(text) ||
    isPersistenceStateQuestion(text) ||
    isWriteOutcomeQuestion(text) ||
    isImprovementQuestion(text) ||
    isErrorTypeQuestion(text) ||
    isConnectedCapabilitiesQuestion(text) ||
    isMissingCapabilitiesQuestion(text) ||
    isAgentArchitectureQuestion(text) ||
    isLearningCapabilityStateQuestion(text) ||
    isRuntimeModelQuestion(text) ||
    isFallbackReasonQuestion(text)
  );
}

export function normalizeProtocolInfoText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[?？!！。]+$/g, "")
    .replace(/\s+/g, " ");
}

export function resolveProtocolInfoQuestionKind(text: string): ProtocolInfoQuestionKind | null {
  const normalized = normalizeProtocolInfoText(text);
  if (!normalized || normalized.startsWith("/")) {
    return null;
  }
  if (!matchesProtocolInfoQuestion(normalized)) {
    return null;
  }
  if (
    isStatusReadbackQuestion(normalized) &&
    !includesAny(normalized, [
      "what is the current system state",
      "what is your current state",
      "现在系统是什么状态",
      "你现在是什么状态",
      "现在什么状态",
    ])
  ) {
    return "status_readback";
  }
  if (
    includesAny(normalized, [
      "whats going on right now",
      "what's going on right now",
      "what is the current system state",
      "what is your current state",
      "现在系统是什么状态",
      "你现在是什么状态",
      "现在什么状态",
    ])
  ) {
    return "snapshot";
  }
  if (
    includesAny(normalized, [
      "is lobster on",
      "is the lobster plugin on",
      "what is lobster doing",
      "how does lobster work here",
      "lobster开了吗",
      "lobster 开了吗",
      "lobster插件开了吗",
      "你现在是lobster模式吗",
    ])
  ) {
    return "lobster";
  }
  if (
    includesAny(normalized, [
      "are dm sessions isolated",
      "is dm isolated",
      "dm是隔离的吗",
      "dm隔离吗",
      "私聊是隔离的吗",
      "私聊隔离吗",
    ])
  ) {
    return "dm";
  }
  if (isSpecificCapabilityQuestion(normalized)) {
    return "specific_capability";
  }
  if (isAgentArchitectureQuestion(normalized)) {
    return "agent_architecture";
  }
  if (isLearningCapabilityStateQuestion(normalized)) {
    return "learning_capability_state";
  }
  if (isMissingCapabilitiesQuestion(normalized)) {
    return "limitations";
  }
  if (isConnectedCapabilitiesQuestion(normalized)) {
    return "capabilities";
  }
  if (
    includesAny(normalized, [
      "is web search working",
      "is web search working now",
      "is search working now",
      "is browsing working now",
      "is provider health ok",
      "is provider health okay",
      "search health",
      "provider health",
      "web search health",
      "搜索现在正常吗",
      "web search 现在正常吗",
      "搜索还坏着吗",
      "搜索现在能用吗",
      "provider 现在健康吗",
      "provider health 现在怎么样",
    ]) ||
    isSearchHealthQuestion(normalized)
  ) {
    return "search_health";
  }
  if (isLearningTruthQuestion(normalized)) {
    return "learning";
  }
  if (isPromiseRiskQuestion(normalized)) {
    return "promise_risk";
  }
  if (isWriteOutcomeQuestion(normalized)) {
    return "write_outcome";
  }
  if (isPersistenceStateQuestion(normalized)) {
    return "persistence_state";
  }
  if (isLearningReceiptQuestion(normalized)) {
    return "learning_receipt";
  }
  if (isLearningApplicationQuestion(normalized)) {
    return "learning_application";
  }
  if (isImprovementQuestion(normalized)) {
    return "improvement";
  }
  if (isErrorTypeQuestion(normalized)) {
    return "error_type";
  }
  if (
    includesAny(normalized, [
      "why is the active model different",
      "why is the runtime model different",
      "why are you not using the default model",
      "为什么不是默认模型",
      "为什么当前模型不一样",
      "为什么active model不一样",
      "为什么 active model 不一样",
    ]) ||
    isFallbackReasonQuestion(normalized)
  ) {
    return "fallback_reason";
  }
  if (
    includesAny(normalized, [
      "what model are you using now",
      "what model is active",
      "what model are you on",
      "你现在用的是什么模型",
      "你现在在用什么模型",
      "当前运行模型是什么",
      "当前模型是什么",
    ]) ||
    isRuntimeModelQuestion(normalized)
  ) {
    return "runtime_model";
  }
  if (
    includesAny(normalized, [
      "what model are you using",
      "what is the default model",
      "which model is default",
      "默认模型是什么",
      "你现在默认模型是什么",
      "你现在用的默认模型是什么",
    ])
  ) {
    return "model";
  }
  if (
    includesAny(normalized, [
      "what anchors are missing",
      "which anchors are missing",
      "what protected anchors are missing",
      "缺了哪些anchors",
      "缺了哪些 anchors",
      "缺了哪些protected anchors",
      "缺了哪些 protected anchors",
      "缺了哪些锚点",
    ])
  ) {
    return "anchors";
  }
  return "help";
}

export function resolveSpecificCapabilityCheck(text: string): SpecificCapabilityCheck | null {
  const normalized = normalizeProtocolInfoText(text);
  const descriptor = resolveKnownCapabilityDescriptor(normalized);
  return descriptor
    ? {
        label: descriptor.label,
        providerCapability: descriptor.providerCapability,
        genericTool: descriptor.genericTool,
      }
    : null;
}
