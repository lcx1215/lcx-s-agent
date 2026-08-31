import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type CliOptions = {
  json: boolean;
  write: boolean;
  date?: string;
};

type ResearchTask = {
  id: string;
  title: string;
  purpose: string;
  requiredFreshInputs: string[];
  output: string;
  invalidation: string[];
};

const DEFAULT_WORKSPACE_DIR = "/Users/liuchengxu/.openclaw/workspace";

const INDEX_OPTION_UNIVERSE = ["SPX", "NDX", "QQQ", "SPY", "IWM", "VIX", "VVIX", "TLT"] as const;

const SEMICONDUCTOR_UNIVERSE = [
  "NVDA",
  "AMD",
  "AVGO",
  "TSM",
  "ASML",
  "MU",
  "ARM",
  "SMH",
  "SOXX",
] as const;

const DAILY_RESEARCH_TASKS: ResearchTask[] = [
  {
    id: "index_options_regime",
    title: "指数期权盘面",
    purpose: "判断指数风险是趋势、震荡、事件波动还是流动性冲击，不做方向押注。",
    requiredFreshInputs: [
      "SPX/NDX/QQQ/SPY 最新价格和成交量，带来源时间戳",
      "0DTE/1W/1M implied volatility、term structure、put/call skew",
      "VIX/VVIX、主要到期日、gamma exposure 或可替代公开代理",
      "FOMC/CPI/PCE/财报集中期等事件日历",
      "10Y/2Y 美债收益率、美元指数、流动性压力代理",
    ],
    output: "给出指数风险状态、关键触发器、缺口数据、失效条件和 next watch，不给买卖或仓位指令。",
    invalidation: [
      "缺少带时间戳的期权波动率或偏度数据",
      "只凭指数涨跌推断期权风险",
      "把 0DTE 噪音当成日频趋势结论",
    ],
  },
  {
    id: "semiconductor_leader_board",
    title: "半导体/AI 算力链",
    purpose: "盯住最能代表基本面和叙事变化的龙头、二线弹性、设备和存储链条。",
    requiredFreshInputs: [
      "NVDA/AMD/AVGO/TSM/ASML/MU/ARM 最新价格、成交量和相对 SMH/SOXX 强弱",
      "最新财报、指引、订单、毛利率、capex、库存或供应链证据",
      "估值口径：forward P/E、EV/Sales、gross margin trend 或明确缺失",
      "新闻和管理层表述必须标注来源、发布时间和可靠性等级",
    ],
    output: "给出强弱分层、基本面证据、估值/叙事风险、催化剂、反证和观察优先级。",
    invalidation: [
      "把单条新闻当成确定性因果",
      "没有财报/指引/订单证据就说基本面改善",
      "只因股价强就提升研究等级",
    ],
  },
  {
    id: "timely_stock_candidates",
    title: "当日候选股雷达",
    purpose: "从指数期权和半导体链条里抽出值得继续研究的候选，不输出买入清单。",
    requiredFreshInputs: [
      "相对强弱、成交量异常、期权 IV/skew 变化、事件日历",
      "财报/指引/政策/供应链/客户集中度等催化剂证据",
      "估值区间、安全边际、下行风险和拥挤度代理",
      "同业对比和反方证据",
    ],
    output: "输出 watchlist 分层：核心跟踪、需要数据、降权观察、丢弃；每个候选必须有证据和反证。",
    invalidation: ["候选变成直接推荐", "没有反证和失效条件", "只选半导体而忽略指数风险背景"],
  },
  {
    id: "risk_gate_and_learning_loop",
    title: "风险门和沉淀",
    purpose: "把每天的研究沉淀成可复用规则，而不是一次性评论。",
    requiredFreshInputs: [
      "当天被采用或被拒绝的候选理由",
      "数据冲突、来源缺失、模型分歧和错判复盘",
      "下一次可验证的相邻任务",
    ],
    output:
      "输出 reusable rule、risk boundary、invalidation condition、application example 和 application_ready/failedReason。",
    invalidation: ["把 receipt 当成已经学会", "没有相邻应用就说沉淀完成", "没有保留/降权/丢弃决定"],
  },
];

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-directed-daily-research-brief.ts [--json] [--write] [--date YYYY-MM-DD]",
      "",
      "Builds the focused daily research product brief for index options and semiconductor/AI compute-chain research.",
      "This owner is research-only: it does not fetch live market data, send Lark messages, start training, or give trade execution instructions.",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false, write: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--date") {
      options.date = readValue(args, index);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function dateKeyFromOption(date?: string): string {
  if (!date) {
    return new Date().toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    usage();
  }
  return date;
}

function workspaceDir(): string {
  return process.env.OPENCLAW_WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR;
}

function buildVisibleBrief(dateKey: string): string {
  const taskLines = DAILY_RESEARCH_TASKS.map(
    (task, index) =>
      `${index + 1}. ${task.title}: ${task.output} 缺口先列数据和来源时间戳，不直接下结论。`,
  );
  return [
    `LCX 定向日频研究包 ${dateKey}`,
    "",
    "定位：开放问答只做入口保底，主产品每天专攻指数期权、半导体/AI 算力链和当日候选股雷达。",
    "",
    "固定研究宇宙：",
    `- 指数/期权: ${INDEX_OPTION_UNIVERSE.join(", ")}`,
    `- 半导体/AI 算力链: ${SEMICONDUCTOR_UNIVERSE.join(", ")}`,
    "",
    "每天固定产出：",
    ...taskLines,
    "",
    "硬边界：research-only；不输出买入、卖出、加仓、减仓、仓位比例或期权下注指令；所有当前数字必须带来源、时间戳、字段口径和冲突处理。",
  ].join("\n");
}

export function buildDirectedDailyResearchBrief(options: { date?: string } = {}) {
  const dateKey = dateKeyFromOption(options.date);
  return {
    ok: true,
    boundary: "local_directed_daily_research_brief_only",
    productMode: "focused_daily_research_product_not_open_ended_chat",
    date: dateKey,
    thesis:
      "The 8-positive/14-negative visible-answer fuzzer is a guardrail, not enough coverage for all future open-ended asks; daily focused research should carry the product value.",
    focus: {
      primary: "index_options_and_semiconductor_ai_compute_chain",
      secondary: "timely_stock_candidate_radar",
      cadence: "daily_low_frequency_research",
      ownerVisibleGoal:
        "Give the owner one useful daily research packet instead of forcing every value through open-ended chat.",
    },
    universe: {
      indexOptions: INDEX_OPTION_UNIVERSE,
      semiconductorAiCompute: SEMICONDUCTOR_UNIVERSE,
    },
    tasks: DAILY_RESEARCH_TASKS,
    outputContract: {
      visibleSections: [
        "one_sentence_market_state",
        "index_options_regime",
        "semiconductor_leader_board",
        "timely_stock_candidates",
        "risk_gates_and_missing_data",
        "invalidation_and_next_watch",
        "learning_sedimentation",
      ],
      requiredEvidence: [
        "source_name_or_artifact",
        "source_timestamp",
        "field_definition",
        "unit_or_currency",
        "provider_role",
        "conflict_or_missing_data_status",
      ],
      forbiddenVisibleOutputs: [
        "buy_sell_add_reduce_instruction",
        "position_percentage",
        "options_bet_instruction",
        "unverified_current_price_or_iv",
        "prediction_without_invalidation",
      ],
    },
    learningContract: {
      sourceNameAndPathRequired: true,
      reusableDecisionRuleRequired: true,
      riskBoundaryRequired: true,
      invalidationConditionRequired: true,
      applicationExampleRequired: true,
      terminalDecision: "application_ready_or_failedReason",
    },
    openQuestionBoundary: {
      qaStillUsefulForFollowups: true,
      qaGuardrailOnly:
        "Short-answer fuzzers prevent bad replies; they do not replace a focused daily research product.",
      unknownAskFallback:
        "Classify the ask, answer directly if safe, otherwise return the missing evidence and route into the daily research queue.",
    },
    visibleBrief: buildVisibleBrief(dateKey),
    notTouched: [
      "external_channel_sender",
      "provider_config",
      "protected_memory",
      "training_processes",
      "trade_execution",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

async function writeBrief(payload: ReturnType<typeof buildDirectedDailyResearchBrief>) {
  const root = workspaceDir();
  const dateDir = path.join(root, "memory", "directed-daily-research", payload.date);
  const stateDir = path.join(root, "state");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const jsonPath = path.join(dateDir, `${stamp}__directed-daily-research-brief.json`);
  const markdownPath = path.join(dateDir, `${stamp}__directed-daily-research-brief.md`);
  const latestJsonPath = path.join(stateDir, "lcx-directed-daily-research-brief-latest.json");
  const latestMarkdownPath = path.join(stateDir, "lcx-directed-daily-research-brief-latest.md");
  await fs.mkdir(dateDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.writeFile(markdownPath, `${payload.visibleBrief}\n`);
  await fs.writeFile(latestJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.writeFile(latestMarkdownPath, `${payload.visibleBrief}\n`);
  return {
    jsonPath,
    markdownPath,
    latestJsonPath,
    latestMarkdownPath,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const payload = buildDirectedDailyResearchBrief({ date: options.date });
  const written = options.write ? await writeBrief(payload) : undefined;
  const output = written ? { ...payload, written } : payload;
  process.stdout.write(
    options.json ? `${JSON.stringify(output, null, 2)}\n` : `${payload.visibleBrief}\n`,
  );
}
