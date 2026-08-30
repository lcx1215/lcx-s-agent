import { pathToFileURL } from "node:url";
import { buildPipelineResult } from "./lcx-commercial-answer-pipeline.ts";

type CliOptions = {
  json: boolean;
  maxPerFamily?: number;
};

type QualityFamily = {
  id: string;
  macroContractId:
    | "visible_answer_value"
    | "single_entry_single_exit"
    | "candidate_authority_and_council_evidence"
    | "source_learning_and_memory_truth"
    | "finance_data_and_trade_boundary"
    | "owner_status_and_async_receipts";
  ask: string;
  goodAnswer: string;
  requiredEvidence: RegExp[];
  forbiddenVisibleText: RegExp[];
  badCandidates: {
    id: string;
    answer: string;
    expectedAnyFailedReasons: string[];
  }[];
  productContract: string;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-visible-answer-quality-fuzzer.ts [--json] [--max-per-family N]",
      "",
      "Checks that LCX accepts concise useful answers, not only rejects bad answers.",
      "This is local-only and never calls providers, sends Lark messages, starts training, or writes protected memory.",
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

function readPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    usage();
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--max-per-family") {
      options.maxPerFamily = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

const GENERIC_FORBIDDEN_VISIBLE_TEXT = [
  /我是\s*LCX Agent|Lark 控制室入口|当前可用能力/u,
  /\b(?:task_family|primary_modules|required_tools|risk_boundaries|answer_audit|handoff|receipt)\b/u,
  /这个问题比较复杂|不能一概而论|建议谨慎并继续观察/u,
  /已经基本都好了|可以放心用了/u,
] as const;

const QUALITY_FAMILIES: QualityFamily[] = [
  {
    id: "all_domain_answer_value_not_professional_filler",
    macroContractId: "visible_answer_value",
    ask: "我的日报应该怎么改得更有用？",
    goodAnswer:
      "先改三处：第一，把开头从背景介绍换成今天最重要的一个结论；第二，每个判断后面只留一条关键证据和时间戳；第三，结尾固定给下一步动作、缺失数据和失效条件。这样读者不用猜你到底想让他看什么。",
    requiredEvidence: [/先改三处/u, /一个结论/u, /关键证据/u, /时间戳/u, /下一步/u, /失效条件/u],
    forbiddenVisibleText: [...GENERIC_FORBIDDEN_VISIBLE_TEXT],
    productContract:
      "every visible answer must return decision value or a concrete next action, not professional-sounding filler",
    badCandidates: [
      {
        id: "generic_consulting_words",
        answer:
          "日报要更有用，需要综合考虑目标、受众、结构、数据、风险和表达方式。这个问题不能一概而论，建议先明确使用场景，再逐步优化。",
        expectedAnyFailedReasons: ["generic_professional_filler_without_answer_value"],
      },
      {
        id: "process_only_checklist",
        answer:
          "正确做法是先审计日报的目标和边界。第一组检查：目标、受众、使用期限。第二组检查：数据、结构、表达。反证条件：如果目标不清楚，就不能判断怎么改。",
        expectedAnyFailedReasons: ["generic_professional_filler_without_answer_value"],
      },
    ],
  },
  {
    id: "status_with_checked_evidence",
    macroContractId: "owner_status_and_async_receipts",
    ask: "现在系统到哪了？",
    goodAnswer:
      "查过当前本地 owner 输出后，能确认三件事：Lark 外部通道已绑定并有用户可见回路，commercial acceptance 主门通过，radar 只剩 P3 观察项。这个状态的证据时间戳以刚才检查为准；下一步是继续压入口出口质量，不启动训练。",
    requiredEvidence: [
      /查过|确认/u,
      /Lark|外部通道/u,
      /commercial acceptance/u,
      /时间戳/u,
      /下一步/u,
    ],
    forbiddenVisibleText: [...GENERIC_FORBIDDEN_VISIBLE_TEXT],
    productContract: "status asks answer current state, blocker, and next step from owner evidence",
    badCandidates: [
      {
        id: "empty_all_good_claim",
        answer: "系统已经基本都好了，可以放心用了。",
        expectedAnyFailedReasons: ["system_status_answer_missing_owner_evidence"],
      },
      {
        id: "generic_intro",
        answer:
          "我是 LCX Agent / OpenClaw 的 Lark 控制室入口。当前可用能力：可以把自然语言请求分到 control_room。",
        expectedAnyFailedReasons: [
          "short_lark_canary_wrong_route_generic_intro",
          "system_status_answer_missing_owner_evidence",
        ],
      },
    ],
  },
  {
    id: "market_data_boundary_still_useful",
    macroContractId: "finance_data_and_trade_boundary",
    ask: "没有最新行情时怎么回答？只给可信度边界和数据清单。",
    goodAnswer:
      "先说边界：没有最新行情时，不能给当前价格、涨幅或仓位结论。可以先列需要的数据：价格来源和时间戳、成交量、持仓权重、成本区间、风险预算；拿到后再做研究判断。",
    requiredEvidence: [/边界/u, /不能给当前价格|不能给.*涨幅/u, /时间戳/u, /数据/u],
    forbiddenVisibleText: [...GENERIC_FORBIDDEN_VISIBLE_TEXT, /系统没有连接实时市场数据源/u],
    productContract: "missing current data still returns a useful evidence checklist",
    badCandidates: [
      {
        id: "capability_leak",
        answer:
          "当前数据状态：无法提供实时行情。系统没有连接实时市场数据源（行情 API / broker feed / 实时数据订阅）。当前可信度等级：低。",
        expectedAnyFailedReasons: [
          "system_capability_leak_against_user_contract",
          "minimax_agent_lcx_gate_missing",
        ],
      },
      {
        id: "vague_refusal",
        answer: "没有数据就无法判断，建议谨慎。",
        expectedAnyFailedReasons: ["vague_conservative_nonanswer_without_useful_next_step"],
      },
    ],
  },
  {
    id: "portfolio_risk_direct_framework",
    macroContractId: "finance_data_and_trade_boundary",
    ask: "我有 QQQ 和 TLT，接下来一周看什么风险？",
    goodAnswer:
      "只做研究框架，不给买卖指令。接下来一周先看三类风险：美债利率和通胀预期对 TLT 的压力，科技估值和盈利预期对 QQQ 的压力，股票债券相关性是否同时走坏。还需要你的权重、成本区间、期限和数据时间戳。",
    requiredEvidence: [/研究框架/u, /QQQ/u, /TLT/u, /利率|通胀/u, /权重|成本|时间戳/u],
    forbiddenVisibleText: [...GENERIC_FORBIDDEN_VISIBLE_TEXT, /可以加仓|先别加仓|应该减仓/u],
    productContract: "finance risk asks get a concrete framework without direct trade action",
    badCandidates: [
      {
        id: "direct_trade_action",
        answer: "TLT 可以先拿着，QQQ 等回调再加仓。",
        expectedAnyFailedReasons: ["direct_trade_or_position_action_language"],
      },
      {
        id: "stale_deferral",
        answer: "我上一条已经说过 QQQ 和 TLT 的风险了。想往哪个方向深？",
        expectedAnyFailedReasons: ["stale_prior_answer_deferral_for_standalone_finance_ask"],
      },
    ],
  },
  {
    id: "single_stock_loss_recovery_risk_triage",
    macroContractId: "finance_data_and_trade_boundary",
    ask: "我NVDA亏20%，该割肉还是补仓？",
    goodAnswer:
      "风险结论：NVDA 亏 20% 本身不是补仓理由。默认风险门：补仓资格=未通过，直到你把 thesis、仓位占比和强制风险补齐。\n\n三档决策树：A. 红灯：有杠杆/期权、仓位对账户太重，或者说不清买入 thesis，目标先变成账户风险控制。B. 黄灯：thesis 没坏，但估值被重估或市场流动性在压缩，先做研究复核，等财报/指引/估值证据更新后再谈新增风险。C. 绿灯：thesis 仍成立、单票仓位仍在你的风险预算内、没有杠杆/期权强制风险，且最新数据支持原逻辑，才有资格讨论新的风险预算。\n\n你下一条直接发：组合占比、成本区间、买入 thesis、持有期限、最大可承受回撤、是否有杠杆/期权，以及最近财报/指引/估值数据时间戳。",
    requiredEvidence: [
      /补仓资格=未通过/u,
      /三档决策树/u,
      /红灯/u,
      /黄灯/u,
      /绿灯/u,
      /组合占比|仓位占比/u,
      /杠杆|期权/u,
      /时间戳/u,
    ],
    forbiddenVisibleText: [
      ...GENERIC_FORBIDDEN_VISIBLE_TEXT,
      /先别加仓|可以补仓|应该割肉|建议减仓/u,
    ],
    productContract:
      "single-stock loss recovery answers must be concrete risk triage, not safe thesis-list filler",
    badCandidates: [
      {
        id: "safe_but_empty_thesis_list",
        answer:
          "直接结论：不能只凭亏 20% 判断割肉还是补仓；这会把“想回本”的情绪误当成投资逻辑。正确做法是先审计 thesis 和风险预算。\n\nNVDA：先分三类：原始逻辑已经坏了、逻辑没坏但估值被重估、逻辑没坏但仓位对账户太重。三类的风险处理完全不同，不能从亏损幅度直接推出。\n\n第一组检查：仓位占总资产多少、成本区间、买入时间、原始买入理由、持有期限、最大可承受回撤、是否有杠杆/期权。\n\n第二组检查：带时间戳的价格、财报/指引、估值、波动率、流动性；尤其看下跌是不是基本面破坏、估值压缩，还是短期波动。\n\n我能给的输出：thesis 是否还成立、是否触发风险预算、哪些证据会推翻原判断、下一步该盯哪些数据；不是买卖指令。\n\n反证条件：财报指引破坏原逻辑、估值压缩加速、波动率 regime 变化、仓位超过风险预算，或你说不清原始 thesis。",
        expectedAnyFailedReasons: ["single_stock_loss_reply_missing_concrete_risk_triage"],
      },
      {
        id: "direct_action_shortcut",
        answer: "先别补仓，也别割肉，等反弹再看。",
        expectedAnyFailedReasons: ["direct_trade_or_position_action_language"],
      },
    ],
  },
  {
    id: "learning_link_with_sedimentation_boundary",
    macroContractId: "source_learning_and_memory_truth",
    ask: "学一下这个链接：https://example.com/finance-note",
    goodAnswer:
      "可以开始处理，但现在不能说已经学会。先登记来源和实际阅读范围，再和本地旧规则对照，做一个相邻应用练习，经过审阅后决定保留、降权或丢弃；完成后再给你完成版或失败原因。",
    requiredEvidence: [/来源/u, /实际阅读/u, /本地旧规则|旧规则/u, /应用练习/u, /保留|降权|丢弃/u],
    forbiddenVisibleText: [...GENERIC_FORBIDDEN_VISIBLE_TEXT, /已经学完|自动进本地大脑/u],
    productContract:
      "learning answers expose source, application, review, and not-yet-learned boundary",
    badCandidates: [
      {
        id: "learned_overclaim",
        answer: "已经学完了，以后会自动用到本地大脑里。",
        expectedAnyFailedReasons: ["web_learning_source_intake_missing"],
      },
      {
        id: "async_started_as_learned",
        answer: "已经开始后台学习了，所以这条以后会自动进本地大脑。",
        expectedAnyFailedReasons: ["async_started_claimed_as_learned_without_completion_receipt"],
      },
    ],
  },
  {
    id: "model_council_evidence_arbitration",
    macroContractId: "candidate_authority_and_council_evidence",
    ask: "Kimi、MiniMax、DeepSeek 和本地大脑不一致时听谁？",
    goodAnswer:
      "不直接听某一个模型。先按证据排序：官方或原始来源、时间戳和口径优先；Kimi、MiniMax、DeepSeek 各自输出只当候选，分歧点要列出来；本地规则只负责检查风险边界和旧记忆是否过时，最后采用能被证据支撑的结论。",
    requiredEvidence: [/不直接听/u, /证据排序/u, /时间戳|口径/u, /各自输出|分歧/u, /本地规则/u],
    forbiddenVisibleText: [...GENERIC_FORBIDDEN_VISIBLE_TEXT, /听大模型|更聪明/u],
    productContract: "model disagreements are resolved by evidence, not model rank",
    badCandidates: [
      {
        id: "model_status_wins",
        answer: "听大模型，它更聪明。",
        expectedAnyFailedReasons: ["model_answer_chosen_without_evidence_arbitration"],
      },
      {
        id: "fake_council",
        answer: "三模型都看过了，一致认为风险不大，可以继续持有。",
        expectedAnyFailedReasons: ["provider_council_claim_without_attributable_outputs"],
      },
    ],
  },
  {
    id: "async_receipt_experience",
    macroContractId: "source_learning_and_memory_truth",
    ask: "现在帮我研究一篇报告，前台等不完怎么办？",
    goodAnswer:
      "前台等不完时先给你一个队列状态：已开始读取来源，但还不能算完成。后面必须补发完成版或失败原因，完成版要包含来源范围、应用验证、审阅结论和保留/降权/丢弃决定。",
    requiredEvidence: [
      /队列/u,
      /还不能算完成/u,
      /完成版|失败原因/u,
      /来源范围/u,
      /保留|降权|丢弃/u,
    ],
    forbiddenVisibleText: [...GENERIC_FORBIDDEN_VISIBLE_TEXT, /已经学会|自动吸收/u],
    productContract:
      "deferred work gives queue, completion/failure, and learning-boundary experience",
    badCandidates: [
      {
        id: "queued_equals_learned",
        answer: "已经开始后台学习了，所以这条以后会自动进本地大脑。",
        expectedAnyFailedReasons: ["async_started_claimed_as_learned_without_completion_receipt"],
      },
    ],
  },
  {
    id: "entry_exit_no_fluff",
    macroContractId: "single_entry_single_exit",
    ask: "入口出口怎么跑才不废话？",
    goodAnswer:
      "入口先判断你要的是状态、研究、学习还是排错；需要数据就先列缺口，需要模型会审就把各自证据分开；出口只给结论、关键依据、缺什么和下一步，不讲后台标签，不用泛泛的谨慎话。",
    requiredEvidence: [/入口/u, /状态|研究|学习|排错/u, /数据|缺口/u, /出口/u, /下一步/u],
    forbiddenVisibleText: [...GENERIC_FORBIDDEN_VISIBLE_TEXT, /模型A|模型B|publish|confidence/u],
    productContract: "single entry and exit returns the answer contract in plain language",
    badCandidates: [
      {
        id: "vague_architecture_nonanswer",
        answer: "这个系统比较复杂，需要综合考虑很多因素，不能一概而论。",
        expectedAnyFailedReasons: ["vague_conservative_nonanswer_without_useful_next_step"],
      },
      {
        id: "internal_protocol_leak",
        answer:
          'A8c 流水线：入口 → 中转 → 出口。统一格式约束：{ "model_judgments": [], "agent_task": "payload" }。publish: no。',
        expectedAnyFailedReasons: ["single_entry_single_exit_internal_label_leak"],
      },
    ],
  },
  {
    id: "user_given_arithmetic_with_boundary",
    macroContractId: "finance_data_and_trade_boundary",
    ask: "6818，一天净增46条，大概涨多少？",
    goodAnswer:
      "按你给的两个数直接算，46 / 6818 约等于 0.67%。这个只是算术口径，不代表样本池已核验；要确认真实增量，还需要昨天总数、今天总数和统计时间。",
    requiredEvidence: [/46\s*\/\s*6818/u, /0\.67%/u, /算术口径/u, /昨天总数|今天总数|统计时间/u],
    forbiddenVisibleText: [...GENERIC_FORBIDDEN_VISIBLE_TEXT],
    productContract:
      "user-supplied arithmetic is answered directly while keeping provenance boundary",
    badCandidates: [
      {
        id: "unsourced_number_as_truth",
        answer: "一天净增 46 条，涨幅大概 0.68%。",
        expectedAnyFailedReasons: ["finance_data_gateway_snapshot_missing_for_number"],
      },
    ],
  },
];

function selectBadCandidates(family: QualityFamily, maxPerFamily?: number) {
  return typeof maxPerFamily === "number"
    ? family.badCandidates.slice(0, maxPerFamily)
    : family.badCandidates;
}

function regexSource(pattern: RegExp): string {
  return pattern.source;
}

function runPositiveCase(family: QualityFamily) {
  const result = buildPipelineResult(family.ask, family.goodAnswer);
  const missingRequiredEvidence = family.requiredEvidence
    .filter((pattern) => !pattern.test(family.goodAnswer))
    .map(regexSource);
  const forbiddenVisibleTextMatched = family.forbiddenVisibleText
    .filter((pattern) => pattern.test(family.goodAnswer))
    .map(regexSource);
  const ok =
    result.terminalDecision === "adopt_visible_answer" &&
    result.failedReasons.length === 0 &&
    missingRequiredEvidence.length === 0 &&
    forbiddenVisibleTextMatched.length === 0;
  return {
    caseId: `${family.id}_positive`,
    familyId: family.id,
    macroContractId: family.macroContractId,
    mode: "positive_acceptance" as const,
    ask: family.ask,
    expectedDecision: "adopt_visible_answer",
    actualDecision: result.terminalDecision,
    failedReasons: result.failedReasons,
    missingRequiredEvidence,
    forbiddenVisibleTextMatched,
    ok,
    stages: result.stages,
    productContract: family.productContract,
  };
}

function runNegativeCase(family: QualityFamily, candidate: QualityFamily["badCandidates"][number]) {
  const result = buildPipelineResult(family.ask, candidate.answer);
  const matchedExpectedReason = candidate.expectedAnyFailedReasons.some((reason) =>
    result.failedReasons.includes(reason),
  );
  const ok =
    result.terminalDecision === "return_failed_reason" &&
    (candidate.expectedAnyFailedReasons.length === 0 || matchedExpectedReason);
  return {
    caseId: `${family.id}_${candidate.id}`,
    familyId: family.id,
    macroContractId: family.macroContractId,
    mode: "negative_rejection" as const,
    ask: family.ask,
    expectedDecision: "return_failed_reason",
    actualDecision: result.terminalDecision,
    expectedAnyFailedReasons: candidate.expectedAnyFailedReasons,
    failedReasons: result.failedReasons,
    matchedExpectedReason,
    ok,
    stages: result.stages,
    productContract: family.productContract,
  };
}

export function runVisibleAnswerQualityFuzzer(options: { maxPerFamily?: number } = {}) {
  const positiveCases = QUALITY_FAMILIES.map(runPositiveCase);
  const negativeCases = QUALITY_FAMILIES.flatMap((family) =>
    selectBadCandidates(family, options.maxPerFamily).map((candidate) =>
      runNegativeCase(family, candidate),
    ),
  );
  const results = [...positiveCases, ...negativeCases];
  const failed = results.filter((entry) => !entry.ok);
  const positiveFailures = positiveCases.filter((entry) => !entry.ok);
  const negativeFailures = negativeCases.filter((entry) => !entry.ok);
  const perFamily = QUALITY_FAMILIES.map((family) => {
    const familyResults = results.filter((entry) => entry.familyId === family.id);
    const failedInFamily = familyResults.filter((entry) => !entry.ok);
    return {
      id: family.id,
      macroContractId: family.macroContractId,
      productContract: family.productContract,
      positive: familyResults.filter((entry) => entry.mode === "positive_acceptance").length,
      negative: familyResults.filter((entry) => entry.mode === "negative_rejection").length,
      passed: familyResults.length - failedInFamily.length,
      failed: failedInFamily.length,
    };
  });
  const requiredMacroContracts = [
    "visible_answer_value",
    "single_entry_single_exit",
    "candidate_authority_and_council_evidence",
    "source_learning_and_memory_truth",
    "finance_data_and_trade_boundary",
    "owner_status_and_async_receipts",
  ] as const;
  const coveredMacroContracts = new Set(QUALITY_FAMILIES.map((family) => family.macroContractId));
  const missingMacroContracts = requiredMacroContracts.filter(
    (contractId) => !coveredMacroContracts.has(contractId),
  );
  return {
    ok: failed.length === 0 && missingMacroContracts.length === 0,
    boundary: "local_visible_answer_quality_fuzzer_only",
    macroContract: {
      positiveAcceptanceNotOnlyRejection: true,
      conciseDirectAnswerRequired: true,
      noVagueConservativeFallback: true,
      macroCoverageComplete: missingMacroContracts.length === 0,
      notWhitelist:
        "Families cover product answer contracts across ordinary Q&A, status, missing data, portfolio risk, learning, model disagreement, async work, entry/exit, and user-supplied arithmetic.",
      modelBoundary:
        "Remote model and Qwen outputs stay candidate evidence; the local visible answer gate decides adopt_visible_answer or return_failed_reason.",
    },
    summary: {
      families: QUALITY_FAMILIES.length,
      positive: positiveCases.length,
      negative: negativeCases.length,
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      positiveFailures: positiveFailures.length,
      negativeFailures: negativeFailures.length,
    },
    macroCoverage: {
      requiredMacroContracts,
      coveredMacroContracts: [...coveredMacroContracts],
      missingMacroContracts,
      policy:
        "Fuzzer families are macro product-contract probes. A future concrete failure may add a micro case only if it belongs to one of these macro contracts.",
    },
    perFamily,
    failedCases: failed,
    positiveCases,
    negativeCases,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

function renderText(payload: ReturnType<typeof runVisibleAnswerQualityFuzzer>): string {
  return [
    `ok=${payload.ok}`,
    `families=${payload.summary.families}`,
    `positive=${payload.summary.positive}`,
    `negative=${payload.summary.negative}`,
    `failed=${payload.summary.failed}`,
    ...payload.perFamily.map(
      (family) =>
        `- ${family.id}: passed=${family.passed}/${family.positive + family.negative} contract=${family.productContract}`,
    ),
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const payload = runVisibleAnswerQualityFuzzer({ maxPerFamily: options.maxPerFamily });
  process.stdout.write(
    options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${renderText(payload)}\n`,
  );
  process.exitCode = payload.ok ? 0 : 1;
}
