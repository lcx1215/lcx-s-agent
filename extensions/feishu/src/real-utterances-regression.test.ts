import { describe, expect, it } from "vitest";
import { resolveProtocolInfoQuestionKind } from "../../../src/auto-reply/reply/commands-protocol-families.js";
import {
  looksLikeBatchQueueScopeAsk,
  looksLikeCapabilityClaimScopeAsk,
  looksLikeClassifyWorkScopeAsk,
  looksLikeCompletionProofScopeAsk,
  looksLikeEvidenceShapeScopeAsk,
  looksLikeExecutionAuthorityScopeAsk,
  looksLikeFailureReportScopeAsk,
  looksLikeFinanceLearningMaintenanceAsk,
  looksLikeFinanceLearningPipelineAsk,
  looksLikeGitHubProjectCapabilityIntakeAsk,
  looksLikeOutOfScopeBoundaryAsk,
  looksLikeProgressStatusScopeAsk,
  looksLikeResultShapeScopeAsk,
  looksLikeSourceCoverageScopeAsk,
  looksLikeStrategicLearningAsk,
} from "./intent-matchers.js";
import {
  LARK_EXTERNAL_SOURCE_LANGUAGE_BATCH,
  LARK_ROUTING_CORPUS,
  LARK_ROUTING_FAMILY_CONTRACTS,
  LARK_ROUTING_GUARD_MATCHERS,
  resolveLarkDeterministicCorpusCase,
  resolveLarkAgentInstructionHandoff,
  resolveLarkHybridRouteCandidate,
  resolveLarkSemanticRouteCandidate,
  scoreLarkRoutingCorpus,
  scoreLarkRoutingCorpusAsync,
  type LarkApiRouteProvider,
  type LarkRoutingFamily,
} from "./lark-routing-corpus.js";
import {
  looksLikeLarkWorkRoleManagementAsk,
  resolveFeishuControlRoomOrchestration,
  resolveFeishuSurfaceRouting,
} from "./surfaces.js";
import type { FeishuConfig } from "./types.js";

const cfg = {
  surfaces: {
    control_room: { chatId: "oc-control" },
    technical_daily: { chatId: "oc-tech" },
    fundamental_research: { chatId: "oc-fund" },
    knowledge_maintenance: { chatId: "oc-knowledge" },
    ops_audit: { chatId: "oc-ops" },
    learning_command: { chatId: "oc-learning" },
    watchtower: { chatId: "oc-watch" },
  },
} as FeishuConfig;

const REAL_DAILY_CONTROL_ROOM_UTTERANCES = [
  "现在整体怎么样",
  "现在整体怎么样，先给我一个总览",
  "今天先看什么",
  "我今天先抓哪三件事",
  "别废话，先给我今天最该盯的三件事",
  "如果我今天只能看十分钟，先看什么",
  "现在最可能出错的是哪里",
  "你先红队一下，今天最容易错在哪",
  "先给我一个控制室总览，再告诉我哪里最容易错",
  "最近学到的东西到底有没有用",
  "昨天纠正了什么，今天还剩什么坑",
  "现在最该关注的不是行情，是哪里在漂",
  "给我一句话说清现在系统和研究线最危险的点",
  "今天有没有什么必须先处理的故障或学习债",
  "QQQ 现在还能拿吗",
  "MSFT 这次财报我最该盯什么",
  "给我一个今天的健康卓越日报",
  "昨天学了什么，昨天纠正了什么，给我一个工作面板",
  "继续这个研究线",
  "expand technical",
  "去学一下最近开源里有什么值得学，学完说人话总结给我",
  "我是学ds和统计的中国散户，你别给我讲市场大词，直接告诉我：如果我做ETF轮动，用样本外、walk-forward、bootstrap，什么结果才算没有自欺欺人？",
  "别偷懒，你现在就去学习一个小时，学前沿论文里最值得记住、以后能反复用的策略和概念",
  "今天的控制室总结，如果错了最可能错在哪",
  "现在网络搜索可以用吗",
  "帮我看看今天有没有静默失败",
  "今天系统最脏的地方是什么",
  "我今天该先补学习债还是先补研究债",
  "给我一个最短版的控制室日报",
  "先告诉我今天哪里最危险，再说其他的",
  "我今天最容易犯的错是什么",
  "如果今天我只能做一件事，做什么",
  "哪里最值得怀疑",
  "把今天最重要的三条风险讲清楚",
  "先说结论，今天研究主线有没有漂",
  "给我一个今天的研究/学习/风控总览",
  "今天有哪些结论其实还不够硬",
  "现在最该追的是哪条学习线",
  "昨天修掉的东西今天还成立吗",
  "现在有哪些东西看起来正常但其实可能是假的",
  "今天有没有哪条自动流程在撒谎",
  "现在最像定时炸弹的是哪块",
  "把今天最该警惕的一条偏差说出来",
  "今天如果看错了，最可能错在哪条线",
  "给我一个偏红队的总览",
  "先从系统稳定性角度给我一个总览",
  "先从研究质量角度给我一个总览",
  "先从学习有效性角度给我一个总览",
  "今天有没有什么低质量学习还在污染记忆",
  "现在记忆里最可疑的锚点是什么",
  "今天哪条研究结论最像过拟合",
  "现在有哪些输出值得降权",
  "今天有什么该删的噪音",
  "把今天的系统健康、学习状态、研究状态一起讲给我",
  "给我一个基本面总览",
  "给我一个技术面总览",
  "给我一个知识维护总览",
  "给我一个审计总览",
  "今天最该看的宏观锚点是什么",
  "今天 ETF 这边先看什么",
  "给我说说长端利率和 QQQ 的关系",
  "把 AI capex 这条线给我讲清楚",
  "今天风控上最不该忽略什么",
  "现在有没有 hard block",
  "今天有哪些标的该直接 veto",
  "如果我是普通散户，今天最容易被什么叙事骗",
  "今天有没有什么结论只是 proxy，不够硬",
  "帮我红队一下 AI 叙事这条线",
  "帮我红队一下 market regime 这条线",
  "最近学的 openclaw 更新到底有没有内化",
  "最近学的智能体更新到底有没有变成可复用规则",
  "把最近的纠错和学习成果给我压成三条规则",
  "最近哪条纠错最值钱",
  "最近哪条学习其实没什么用",
  "最近哪条规则应该降级",
  "最近哪条记忆应该删掉",
  "给我一个最近七天的总览",
  "最近七天哪里改善最大",
  "最近七天哪里最危险",
  "最近七天哪条自动化最不稳定",
  "今天有没有恢复失败的 session",
  "学习 session 现在还活着吗",
  "现在还在学吗，学到哪了",
  "学习进度",
  "学习状态",
  "我刚才让你学的那条还在跑吗",
  "如果我现在再发一条学习一小时，会不会冲掉当前 session",
  "你现在有没有把已经过期的学习还当成 running",
  "系统现在有没有把失败说成成功",
  "有没有哪条控制面还在高报",
  "有没有哪条控制面还在低报",
  "给我一个一句话的现状判断",
  "一句话说现在值不值得扩新功能",
  "一句话说现在最该修什么",
  "如果我现在睡觉八小时，你最担心哪条链会掉",
  "如果明天只验一条链，先验哪条",
  "现在最不值得信的输出是什么",
  "哪条线最像表面稳定实际在漂",
  "现在最像假繁荣的是哪块",
  "给我一个不粉饰的总判断",
] as const;

const BOT_LEVEL_INTERCEPT_OR_RESET_PHRASES = new Set([
  "继续这个研究线",
  "现在还在学吗，学到哪了",
  "我刚才让你学的那条还在跑吗",
]);

const CRITICAL_FULL_AGGREGATE_PHRASES = [
  "现在整体怎么样",
  "现在最可能出错的是哪里",
  "今天的控制室总结，如果错了最可能错在哪",
  "给我一个今天的研究/学习/风控总览",
  "先从学习有效性角度给我一个总览",
  "把今天的系统健康、学习状态、研究状态一起讲给我",
  "哪里最值得怀疑",
  "最近学到的东西到底有没有用",
  "最近七天哪条自动化最不稳定",
  "系统现在有没有把失败说成成功",
  "给我一个一句话的现状判断",
  "如果我现在睡觉八小时，你最担心哪条链会掉",
  "给我一个不粉饰的总判断",
] as const;

const CRITICAL_RESEARCH_LINE_CONTINUATION_PHRASES = [
  "别换线，沿着上一轮继续下一步",
  "接着刚才那条研究线往下做",
] as const;

const CRITICAL_SINGLE_SPECIALIST_CASES = [
  {
    phrase: "QQQ 现在还能拿吗",
    targetSurface: "technical_daily",
    specialistSurfaces: ["technical_daily"],
  },
  {
    phrase: "MSFT 这次财报我最该盯什么",
    targetSurface: "fundamental_research",
    specialistSurfaces: ["fundamental_research"],
  },
  {
    phrase: "给我一个基本面总览",
    targetSurface: "fundamental_research",
    specialistSurfaces: ["fundamental_research"],
  },
  {
    phrase: "给我一个技术面总览",
    targetSurface: "technical_daily",
    specialistSurfaces: ["technical_daily"],
  },
  {
    phrase: "给我一个知识维护总览",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance"],
  },
  {
    phrase: "给我一个审计总览",
    targetSurface: "ops_audit",
    specialistSurfaces: ["ops_audit"],
  },
  {
    phrase: "把 AI capex 这条线给我讲清楚",
    targetSurface: "fundamental_research",
    specialistSurfaces: ["fundamental_research"],
  },
  {
    phrase:
      "我是学ds和统计的中国散户，你别给我讲市场大词，直接告诉我：如果我做ETF轮动，用样本外、walk-forward、bootstrap，什么结果才算没有自欺欺人？",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "去github上学习开源的值得你学的，并把值得内化的内化",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "去读关于llm应用在金融智能体上的文章，对你自我提升的启发",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "之前内部做了很多的金融学习，你应该把它们维护好并加强",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "把已有的 ETF 学习能力和 pipeline 梳理加固一下",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "现在你的任务很繁重，把以前的学习能力收紧加强，连上lark接口命令",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "把之前的学习管线接到 Lark 命令上，语言接口也继续加强",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "去github上学值得你学的，但别做开源综述，直接告诉我哪些会改你以后的做法",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "去看最近开源agent都怎么做长期记忆，然后只告诉我哪些真的值得你自己内化，别做表面总结",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "最近学的 openclaw 更新到底有没有内化",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "最近学的智能体更新到底有没有变成可复用规则",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "最近学的 openclaw 更新到底有没有内化成可复用规则，别给我做总结秀",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "你先别总结，直接告诉我最近学的 openclaw 更新到底沉淀成了哪些以后会复用的规则",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "别给我一份总结，你就告诉我最近后台自动学习有没有卡住，卡在哪",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "我昨天让你学的东西，现在到底写进记忆还是只是生成了报告",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "我前天让你学那个，现在是写进脑子了还是还躺在 report 里装样子",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "你别给我整日报，我就问自动学习后台最近是不是死过机，后来是续上了还是装没事",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "前几天读那堆东西，到底留下啥了，还是过眼云烟",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "别端水，就说上次学的那些花活有没有一条真改掉你老毛病",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "你是不是把前阵子学过的东西又忘回去了",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "你前阵子学的那些长期记忆玩意儿，进规矩了没，还是嘴上热闹",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "后台那条学习链是不是半路断过，然后又装作啥事没有",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "别给我成果展，你就说前阵子学的最后有没有进长期记忆",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "github上那些能偷的招你去偷，最后只说真会改你手法的三条，别做分享会",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "去 Google 上学最近 agent 记忆怎么做，只留下会改你以后做法的三条",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "网上搜一下最近金融智能体文章，别复述文章，只说哪些值得内化",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "查一下 arxiv 上 agent workflow 的新文章，筛出以后会复用的规则",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "去看几篇 blog 和 docs，别做综述，只留下能改你研究流程的东西",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "去 Google 上学半个小时，学 agent 记忆怎么做",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "从网上找资料持续学30分钟，主题是 finance agent workflow",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "看看同类 agent 怎么做长期记忆，筛出能改你工作流的规则",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "找几个竞品智能体的做法参考一下，别做综述，只留下可复用的",
    targetSurface: "learning_command",
    specialistSurfaces: ["learning_command"],
  },
  {
    phrase: "最近读的那些金融智能体文章，有哪条不是嘴上热闹，是真的会改你以后做法的",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "你最近学的那堆 agent 招数，到底哪条真进了你以后干活的规矩",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "前几天让你补的那堆，现在是真进脑子还是只是多了几份文件",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "别装稳定，自动学习后台是不是自己断过又没报",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "那条后台学习是不是根本没落账，只是文件看着多",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "前阵子补的记忆那套，真进总线了还是边上堆垃圾",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "你别跟我讲学了多少，就说最近学进规矩的两条和明确扔掉的两条",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "别拿报告糊我，学完到底有没有改掉你以前那套坏习惯",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "自动学习后台是不是只会留痕，不会真落账",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
  },
  {
    phrase: "刚才那句回答太满了，下次别把没证据的东西说死",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance"],
  },
  {
    phrase: "这条规则记住，以后遇到 provider 没确认就别说已经接上",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance"],
  },
  {
    phrase: "你刚才把 session 理解说成长期记忆了，改掉这个习惯",
    targetSurface: "knowledge_maintenance",
    specialistSurfaces: ["knowledge_maintenance"],
  },
  {
    phrase: "你这句话哪来的，给我出处",
    targetSurface: "ops_audit",
    specialistSurfaces: ["ops_audit"],
  },
  {
    phrase: "刚才那个结论有来源吗",
    targetSurface: "ops_audit",
    specialistSurfaces: ["ops_audit"],
  },
  {
    phrase: "这条判断是你确认过的还是猜的",
    targetSurface: "ops_audit",
    specialistSurfaces: ["ops_audit"],
  },
  {
    phrase: "没源没证据就说不知道，别编",
    targetSurface: "ops_audit",
    specialistSurfaces: ["ops_audit"],
  },
  {
    phrase: "我不是问现在买不买，我是问你上次那套逻辑现在是不是已经失效了",
    targetSurface: "control_room",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
  {
    phrase: "别跟我说现在买卖，我问的是原来拿它的理由还剩几成",
    targetSurface: "control_room",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
  {
    phrase: "如果你上次对QQQ那套说法已经烂掉了，就标出来哪句烂了，别重写",
    targetSurface: "technical_daily",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
  {
    phrase: "上回那个看多的由头现在还有活口没",
    targetSurface: "control_room",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
  {
    phrase: "别给我行情秀，我问的是之前那份看多理由现在塌了没",
    targetSurface: "control_room",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
  {
    phrase: "别跟我聊仓位，原先撑着继续拿的那几个点，现在死了几个",
    targetSurface: "control_room",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
  {
    phrase: "原来扛着不卖那点底气还剩几口气",
    targetSurface: "control_room",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
  {
    phrase: "之前那套继续拿着的根据，现在是不是就剩嘴硬了",
    targetSurface: "control_room",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
  {
    phrase: "之前死扛它那口气，现在还有没有道理",
    targetSurface: "control_room",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
  {
    phrase: "原来那份继续拿着的说法，现在还有没有骨头",
    targetSurface: "control_room",
    specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
    publishMode: "summary_only",
  },
] as const;

const LARK_WORK_ROLE_MANAGEMENT_CASES = [
  "新增一个机器人小陈，负责看宏观和利率",
  "把小李这个角色删掉，先不要展示它",
  "列出现在 Lark 里有哪些分工角色",
  "机器人还能新增或者减少，只要我一声命令",
] as const;

const LARK_TRUTH_SURFACE_UTTERANCES = [
  { phrase: "你别跟我讲感觉，就说这次到底落盘没有", kind: "write_outcome" },
  { phrase: "刚才那次写入是真持久化了，还是只在当前会话里懂了", kind: "write_outcome" },
  { phrase: "你是不是把昨天的写失败还当成今天没写进去", kind: "write_outcome" },
  { phrase: "这次是不是已经落进长期记忆了", kind: "persistence_state" },
  { phrase: "你到底有没有搜索能力", kind: "search_health" },
  { phrase: "你现在到底有没有 web-search 能力", kind: "specific_capability" },
  { phrase: "哪些工具是真的能用", kind: "capabilities" },
  { phrase: "provider 工具现在还缺什么", kind: "limitations" },
  { phrase: "哪些内部学习能力真的接上了", kind: "learning_capability_state" },
  { phrase: "finance learning pipeline 是 dev 还是 live", kind: "learning_capability_state" },
  { phrase: "现在是哪个模型在回我", kind: "runtime_model" },
  { phrase: "是不是偷偷 fallback 了", kind: "fallback_reason" },
] as const;

const LIVE_LARK_SCHEDULING_CONTRACT_PROBE =
  "先按语义家族分类这条请求：这些都做但不要并行，按优先级排队，一次只做一个；现在做到哪、还剩什么、proof 是什么，用 done / queued / next step 回答，别把 queued 说成 completed。";

const LIVE_LARK_PERMISSION_AND_RECEIPT_PROBE =
  "你可以操控电脑做 Lark 真实对话测试，但这不等于授权 build/restart/deploy；接 live 前先定义验收短语，按固定回执格式列出测试语句、同一个 chat/thread、可见回复、是否命中、dev/live 边界和下一步。";

const LIVE_LARK_NO_REPLY_PROBE =
  "Lark 探针发出后如果无回复、超时、旧回复、错 chat、错线程或不对应测试语句，按 blocked / proof / next step 报，不要把 only sent 或任意可见回复说成 pass。";

const LIVE_LARK_STOP_PROBE =
  "撤回授权，别接 live，也别再 probe，只保留 dev patch 和本地测试；之前允许操控电脑不能继承到下一轮 restart 或 deploy。";

const EXTERNAL_SOURCE_LEARNING_MATRIX: ReadonlyArray<{
  label: string;
  phrase: string;
  expectsSourceCoverageGuard: boolean;
}> = [
  {
    label: "google distilled learning",
    phrase: "去 Google 上学最近 agent 记忆怎么做，只留下会改你以后做法的三条",
    expectsSourceCoverageGuard: false,
  },
  {
    label: "google coverage honesty",
    phrase:
      "去 Google 上学最近 agent 记忆怎么做，但别把看了几个来源说成完整覆盖，只留下会改你以后做法的三条",
    expectsSourceCoverageGuard: true,
  },
  {
    label: "timeboxed web study",
    phrase: "从网上找资料持续学30分钟，主题是 finance agent workflow",
    expectsSourceCoverageGuard: false,
  },
] as const;

const LIVE_LARK_CONTROL_MATCHERS = {
  classifyWork: looksLikeClassifyWorkScopeAsk,
  batchQueue: looksLikeBatchQueueScopeAsk,
  progressStatus: looksLikeProgressStatusScopeAsk,
  resultShape: looksLikeResultShapeScopeAsk,
  completionProof: looksLikeCompletionProofScopeAsk,
  executionAuthority: looksLikeExecutionAuthorityScopeAsk,
  capabilityClaim: looksLikeCapabilityClaimScopeAsk,
  evidenceShape: looksLikeEvidenceShapeScopeAsk,
  failureReport: looksLikeFailureReportScopeAsk,
  outOfScope: looksLikeOutOfScopeBoundaryAsk,
} as const;

type LiveLarkControlFamily = keyof typeof LIVE_LARK_CONTROL_MATCHERS;

const LIVE_LARK_CONTROL_MATRIX: ReadonlyArray<{
  label: string;
  phrase: string;
  expectedFamilies: readonly LiveLarkControlFamily[];
}> = [
  {
    label: "scheduling contract",
    phrase: LIVE_LARK_SCHEDULING_CONTRACT_PROBE,
    expectedFamilies: [
      "classifyWork",
      "batchQueue",
      "progressStatus",
      "resultShape",
      "completionProof",
    ],
  },
  {
    label: "permission and receipt",
    phrase: LIVE_LARK_PERMISSION_AND_RECEIPT_PROBE,
    expectedFamilies: ["executionAuthority", "capabilityClaim", "evidenceShape", "resultShape"],
  },
  {
    label: "no reply and mismatched reply",
    phrase: LIVE_LARK_NO_REPLY_PROBE,
    expectedFamilies: ["failureReport", "progressStatus", "evidenceShape"],
  },
  {
    label: "stop live lane",
    phrase: LIVE_LARK_STOP_PROBE,
    expectedFamilies: ["executionAuthority", "outOfScope"],
  },
] as const;

function expectLiveLarkFamilies(params: {
  label: string;
  phrase: string;
  expectedFamilies: readonly LiveLarkControlFamily[];
}): void {
  for (const family of params.expectedFamilies) {
    expect(LIVE_LARK_CONTROL_MATCHERS[family](params.phrase), `${params.label}:${family}`).toBe(
      true,
    );
  }
}

describe("real daily utterance regression", () => {
  it("covers one hundred real daily control-room utterances", () => {
    expect(REAL_DAILY_CONTROL_ROOM_UTTERANCES).toHaveLength(100);
  });

  it("does not drop routing for the full real-utterance set", () => {
    for (const phrase of REAL_DAILY_CONTROL_ROOM_UTTERANCES) {
      const routing = resolveFeishuSurfaceRouting({
        cfg,
        chatId: "oc-control",
        content: phrase,
      });

      expect(routing.targetSurface, phrase).toBeDefined();
    }
  });

  it("keeps broad control-room asks from falling through with no orchestration plan", () => {
    for (const phrase of REAL_DAILY_CONTROL_ROOM_UTTERANCES) {
      const routing = resolveFeishuSurfaceRouting({
        cfg,
        chatId: "oc-control",
        content: phrase,
      });
      const plan = resolveFeishuControlRoomOrchestration({
        currentSurface: routing.currentSurface,
        targetSurface: routing.targetSurface,
        content: phrase,
      });

      if (
        routing.targetSurface === "control_room" &&
        !BOT_LEVEL_INTERCEPT_OR_RESET_PHRASES.has(phrase)
      ) {
        expect(plan, phrase).toBeDefined();
      }
    }
  });

  it("keeps the critical broad summary and red-team asks on the full aggregate path", () => {
    for (const phrase of CRITICAL_FULL_AGGREGATE_PHRASES) {
      const routing = resolveFeishuSurfaceRouting({
        cfg,
        chatId: "oc-control",
        content: phrase,
      });
      const plan = resolveFeishuControlRoomOrchestration({
        currentSurface: routing.currentSurface,
        targetSurface: routing.targetSurface,
        content: phrase,
      });

      expect(plan, phrase).toEqual({
        mode: "aggregate",
        specialistSurfaces: [
          "technical_daily",
          "fundamental_research",
          "knowledge_maintenance",
          "ops_audit",
        ],
        publishMode: "classified_publish",
        replyContract: "default",
        includeDailyWorkface: true,
      });
    }
  });

  it("keeps explicit research-line continuation asks on the control-room anchor path", () => {
    for (const phrase of CRITICAL_RESEARCH_LINE_CONTINUATION_PHRASES) {
      const routing = resolveFeishuSurfaceRouting({
        cfg,
        chatId: "oc-control",
        content: phrase,
      });
      const plan = resolveFeishuControlRoomOrchestration({
        currentSurface: routing.currentSurface,
        targetSurface: routing.targetSurface,
        content: phrase,
      });

      expect(routing.targetSurface, phrase).toBe("control_room");
      expect(plan, phrase).toBeUndefined();
    }
  });

  it("keeps explicit slice asks pinned to the intended specialist lane", () => {
    for (const testCase of CRITICAL_SINGLE_SPECIALIST_CASES) {
      const { phrase, targetSurface, specialistSurfaces } = testCase;
      const publishMode = "publishMode" in testCase ? testCase.publishMode : undefined;
      const routing = resolveFeishuSurfaceRouting({
        cfg,
        chatId: "oc-control",
        content: phrase,
      });
      const plan = resolveFeishuControlRoomOrchestration({
        currentSurface: routing.currentSurface,
        targetSurface: routing.targetSurface,
        content: phrase,
      });

      expect(routing.targetSurface, phrase).toBe(targetSurface);
      expect(plan, phrase).toMatchObject({
        mode: "aggregate",
        specialistSurfaces,
        publishMode: publishMode ?? "classified_publish",
      });
    }
  });

  it("keeps real Lark persistence and write-outcome asks on shared truth surfaces", () => {
    for (const { phrase, kind } of LARK_TRUTH_SURFACE_UTTERANCES) {
      expect(resolveProtocolInfoQuestionKind(phrase), phrase).toBe(kind);
    }
  });

  it("scores the structured Lark routing corpus by semantic family", () => {
    const score = scoreLarkRoutingCorpus({ cfg });

    expect(score.total).toBe(LARK_ROUTING_CORPUS.length);
    expect(score.deterministicPassed).toBe(score.total);
    expect(score.semanticCandidatePassed).toBe(score.total);

    for (const [family, familyScore] of Object.entries(score.families) as Array<
      [LarkRoutingFamily, (typeof score.families)[LarkRoutingFamily]]
    >) {
      expect(familyScore.total, family).toBeGreaterThan(0);
      expect(familyScore.deterministicPassed, family).toBe(familyScore.total);
      expect(familyScore.semanticCandidatePassed, family).toBe(familyScore.total);
    }
  });

  it("can score an API semantic-router candidate layer without replacing deterministic gates", async () => {
    const apiProvider: LarkApiRouteProvider = async ({ utterance }) => {
      const entry = LARK_ROUTING_CORPUS.find((candidate) => candidate.utterance === utterance);
      return {
        family: entry?.family ?? "unknown",
        confidence: entry ? 0.91 : 0.2,
        rationale: "test provider mirrors the supervised corpus",
      };
    };
    const score = await scoreLarkRoutingCorpusAsync({ cfg, apiProvider });

    expect(score.total).toBe(LARK_ROUTING_CORPUS.length);
    expect(score.deterministicPassed).toBe(score.total);
    expect(score.semanticCandidatePassed).toBe(score.total);
    expect(score.apiCandidatePassed).toBe(score.total);
  });

  it("builds a Lark instruction-understanding envelope before handing work to the agent", async () => {
    const handoff = await resolveLarkAgentInstructionHandoff({
      cfg,
      chatId: "oc-control",
      utterance:
        "现在先靠大模型 API 回复，每次对话都产出一个可蒸馏样本，日积月累喂给我们的智能体。",
      apiProvider: async () => ({
        family: "api_reply_distillation",
        confidence: 0.93,
        rationale: "API router understood the request as reply distillation",
      }),
    });

    expect(handoff).toMatchObject({
      family: "api_reply_distillation",
      source: "api",
      targetSurface: "learning_command",
    });
    expect(handoff.notice).toContain("Lark instruction-understanding envelope");
    expect(handoff.notice).toContain("not execution approval");
  });

  it("hands concrete finance learning asks to the finance pipeline backend contract", async () => {
    const handoff = await resolveLarkAgentInstructionHandoff({
      cfg,
      chatId: "oc-control",
      utterance: "学习一套很好的量化因子择时策略，最后要有 retrieval receipt 和 review",
      apiProvider: async () => ({
        family: "market_capability_learning_intake",
        confidence: 0.91,
        rationale: "API router understood this as finance learning pipeline intake",
      }),
    });

    expect(
      looksLikeFinanceLearningPipelineAsk(handoff.backendToolContract?.learningIntent ?? ""),
    ).toBe(true);
    expect(handoff).toMatchObject({
      family: "market_capability_learning_intake",
      source: "api",
      targetSurface: "learning_command",
      backendToolContract: {
        toolName: "finance_learning_pipeline_orchestrator",
        sourceRequirement: "safe_local_or_manual_source_required",
      },
    });
    expect(handoff.notice).toContain("Backend tool contract");
    expect(handoff.notice).toContain("finance_learning_pipeline_orchestrator");
    expect(handoff.notice).toContain("retrievalReceiptPath,retrievalReviewPath");
  });

  it("keeps explicit finance pipeline validation ahead of a wrong open-source API route", async () => {
    const handoff = await resolveLarkAgentInstructionHandoff({
      cfg,
      chatId: "oc-control",
      utterance:
        "真实学习任务端到端验收：请用本地安全 source test/fixtures/finance-learning-pipeline/valid-finance-article.md 跑 finance_learning_pipeline_orchestrator，learningIntent=学习 ETF event triage workflow，必须在回复里明确显示 learningInternalizationStatus=application_ready 或 failedReason；不要说后台已完成，除非 receipt/review 真的证明。",
      apiProvider: async () => ({
        family: "learning_external_source",
        confidence: 0.95,
        rationale: "wrongly treated source and skills wording as open-source learning",
      }),
    });

    expect(handoff).toMatchObject({
      family: "market_capability_learning_intake",
      source: "semantic",
      targetSurface: "learning_command",
      backendToolContract: {
        toolName: "finance_learning_pipeline_orchestrator",
        sourceRequirement: "safe_local_or_manual_source_required",
      },
    });
    expect(handoff.notice).toContain("finance_learning_pipeline_orchestrator");
    expect(handoff.notice).toContain("retrievalReceiptPath,retrievalReviewPath");
  });

  it("hands GitHub project feature adoption asks to the capability intake backend contract", async () => {
    const utterance =
      "现在github上热榜的一些项目，你看看哪些功能可以加进来，或者我们内部有没有这种功能的雏形";
    const handoff = await resolveLarkAgentInstructionHandoff({
      cfg,
      chatId: "oc-control",
      utterance,
      apiProvider: async () => ({
        family: "learning_external_source",
        confidence: 0.9,
        rationale: "API router understood this as GitHub/open-source capability intake",
      }),
    });

    expect(looksLikeGitHubProjectCapabilityIntakeAsk(utterance)).toBe(true);
    expect(handoff).toMatchObject({
      family: "learning_external_source",
      source: "api",
      targetSurface: "learning_command",
      backendToolContract: {
        toolName: "github_project_capability_intake",
        sourceRequirement: "repo_url_or_readme_summary_required",
      },
    });
    expect(handoff.notice).toContain("github_project_capability_intake");
    expect(handoff.notice).toContain("capabilityFamily,existingEmbryos,adoptionDecision");
  });

  it("sanitizes low-confidence API candidates and keeps deterministic routing authoritative", async () => {
    const entry = LARK_ROUTING_CORPUS.find((candidate) => candidate.id === "technical-001");
    expect(entry).toBeDefined();
    const hybrid = await resolveLarkHybridRouteCandidate({
      cfg,
      entry: entry!,
      apiProvider: async () => ({
        family: "fundamental_research",
        confidence: 0.2,
        rationale: "low-confidence wrong family should not be accepted",
      }),
    });

    expect(hybrid.api).toMatchObject({
      family: "unknown",
      confidence: 0.2,
    });
    expect(hybrid.acceptedFamily).toBe("technical_timing");
    expect(hybrid.source).toBe("deterministic");
  });

  it("keeps semantic-route near misses out of their tempting families", () => {
    for (const [family, contract] of Object.entries(LARK_ROUTING_FAMILY_CONTRACTS) as Array<
      [LarkRoutingFamily, (typeof LARK_ROUTING_FAMILY_CONTRACTS)[LarkRoutingFamily]]
    >) {
      for (const utterance of contract.nearMisses) {
        const candidate = resolveLarkSemanticRouteCandidate(utterance);
        expect(candidate.family, `${family}:${utterance}`).not.toBe(family);
      }
    }
  });

  it("keeps external-source learning routed by semantic family instead of fixed sentences", () => {
    for (const { label, phrase, expectsSourceCoverageGuard } of EXTERNAL_SOURCE_LEARNING_MATRIX) {
      const routing = resolveFeishuSurfaceRouting({
        cfg,
        chatId: "oc-control",
        content: phrase,
      });
      const plan = resolveFeishuControlRoomOrchestration({
        currentSurface: routing.currentSurface,
        targetSurface: routing.targetSurface,
        content: phrase,
      });

      expect(routing.targetSurface, label).toBe("learning_command");
      expect(plan, label).toMatchObject({
        mode: "aggregate",
        specialistSurfaces: ["learning_command"],
      });
      expect(
        looksLikeStrategicLearningAsk(phrase) || looksLikeFinanceLearningMaintenanceAsk(phrase),
        label,
      ).toBe(true);
      expect(looksLikeSourceCoverageScopeAsk(phrase), label).toBe(expectsSourceCoverageGuard);
    }
  });

  it("language-classifies broad external-source utterances without becoming brain learning artifacts", () => {
    for (const entry of LARK_EXTERNAL_SOURCE_LANGUAGE_BATCH) {
      const deterministic = resolveLarkDeterministicCorpusCase({ cfg, entry });
      const semantic = resolveLarkSemanticRouteCandidate(entry.utterance);

      expect(deterministic.passed, entry.id).toBe(true);
      expect(deterministic.targetSurface, entry.id).toBe("learning_command");
      expect(semantic.family, entry.id).toBe(entry.family);
      expect(LARK_ROUTING_GUARD_MATCHERS.sourceCoverage(entry.utterance), entry.id).toBe(true);
      expect(LARK_ROUTING_GUARD_MATCHERS.tradingLanguage(entry.utterance), entry.id).toBe(false);
    }
  });

  it("keeps external-source language corpus separate from finance learning memory artifacts", () => {
    for (const entry of LARK_EXTERNAL_SOURCE_LANGUAGE_BATCH) {
      expect(entry.id, entry.utterance).toMatch(/^external-language-batch-/u);
      expect(entry.notes ?? "", entry.id).not.toMatch(
        /capability card|finance_learning|finance-learning|artifact write|memory\/local-memory/u,
      );
    }
  });

  it("keeps visible Lark robot add/remove commands on the control-room role registry path", () => {
    for (const phrase of LARK_WORK_ROLE_MANAGEMENT_CASES) {
      const routing = resolveFeishuSurfaceRouting({
        cfg,
        chatId: "oc-control",
        content: phrase,
      });
      const plan = resolveFeishuControlRoomOrchestration({
        currentSurface: routing.currentSurface,
        targetSurface: routing.targetSurface,
        content: phrase,
      });

      expect(looksLikeLarkWorkRoleManagementAsk(phrase), phrase).toBe(true);
      expect(routing.targetSurface, phrase).toBe("control_room");
      expect(plan, phrase).toMatchObject({
        mode: "aggregate",
        specialistSurfaces: ["ops_audit"],
        publishMode: "summary_only",
      });
    }
  });

  it("keeps the live Lark control matrix covered by semantic families", () => {
    for (const entry of LIVE_LARK_CONTROL_MATRIX) {
      expectLiveLarkFamilies(entry);
    }
  });
});
