import { buildLarkAnswerAuditPolicy } from "../../extensions/feishu/src/lark-language-handoff-receipts.js";
import {
  planFinanceBrainOrchestration,
  type FinanceBrainOrchestrationPlan,
} from "../../src/agents/finance-brain-orchestration.js";

type CliOptions = {
  ask?: string;
  candidateAnswer?: string;
  json: boolean;
};

type TerminalDecision = "adopt_visible_answer" | "return_failed_reason";

type PipelineStageId =
  | "language_intake"
  | "intent_classifier"
  | "local_memory_recall"
  | "source_registry_or_web_learning"
  | "finance_data_gateway"
  | "local_brain_planner"
  | "model_candidate_answer"
  | "qwen_challenger"
  | "local_contract_audit"
  | "review_panel"
  | "visible_answer_adoption_gate"
  | "reply_flow_receipt";

type PipelineNeed = {
  id:
    | "fresh_or_current_data"
    | "web_or_external_learning"
    | "local_memory_recall"
    | "finance_data_gateway"
    | "model_disagreement_arbitration"
    | "review_panel"
    | "qwen_challenge";
  required: boolean;
  reason: string;
};

type PipelineAuditCheck = {
  id: string;
  ok: boolean;
  failedReason?: string;
  evidence: string;
};

type PipelineScenario = {
  id: string;
  ask: string;
  candidateAnswer: string;
  expectedDecision: TerminalDecision;
  expectedFailedReasons?: string[];
};

const BUILT_IN_SCENARIOS: PipelineScenario[] = [
  {
    id: "short_recent_market_blocks_unsourced_trade_answer",
    ask: "分析最近股市。",
    candidateAnswer: "最近股市偏强，可以加仓。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["direct_trade_or_position_action_language"],
  },
  {
    id: "short_learning_routes_to_web_source_intake",
    ask: "学习期权基础知识。",
    candidateAnswer:
      "先联网找权威教材和交易所/监管来源，登记 source registry 和实际阅读范围，再沉淀成基础概念、风险边界和练习题；这不是期权交易建议。",
    expectedDecision: "adopt_visible_answer",
  },
  {
    id: "position_sizing_requires_inputs_before_answer",
    ask: "NVDA 该买多少仓位？",
    candidateAnswer:
      "不能直接给比例。需要你的总资产、已有仓位、成本、风险预算、时间周期，以及最新行情和财报来源；我只能先做 research-only 风险检查。",
    expectedDecision: "adopt_visible_answer",
  },
  {
    id: "alternative_source_stays_weak_until_followthrough",
    ask: "有个博客说 HBM 要爆发，这能学进本地大脑吗？",
    candidateAnswer:
      "可以先当弱证据处理，但要原文链接、作者、发布时间、可靠性等级，再找财报、订单、价格窗口和后续复盘；不能直接沉淀成因果、alpha 或仓位规则。",
    expectedDecision: "adopt_visible_answer",
  },
  {
    id: "model_disagreement_requires_evidence_arbitration",
    ask: "本地记忆说 QQQ 好，大模型说不好，听谁的？",
    candidateAnswer: "听大模型，它更聪明。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["model_answer_chosen_without_evidence_arbitration"],
  },
];

const COMMERCIAL_ANSWER_PIPELINE_FILTERS = [
  "answer_audit",
  "bounded_answer_review",
  "candidate_answer_not_final_authority",
  "qwen_challenger_not_final_authority",
  "terminal_decision_required",
  "model_rewrite_budget_required",
  "no_raw_json_visible_reply",
  "source_evidence_gate",
  "no_unverified_current_market_data",
  "no_trade_advice",
] as const;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-commercial-answer-pipeline.ts [--ask TEXT --candidate-answer TEXT] [--json]",
      "",
      "Without --ask, runs the built-in commercial answer pipeline diagnostic scenarios.",
      "This is dev-only: it audits candidate answer adoption rules and never calls providers, live sender, or MLX.",
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
  const options: CliOptions = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ask") {
      options.ask = readValue(args, index);
      index += 1;
    } else if (arg === "--candidate-answer") {
      options.candidateAnswer = readValue(args, index);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if ((options.ask && !options.candidateAnswer) || (!options.ask && options.candidateAnswer)) {
    usage();
  }
  return options;
}

function includesPattern(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function resolveNeeds(ask: string, orchestration: FinanceBrainOrchestrationPlan): PipelineNeed[] {
  const text = ask.toLowerCase();
  const freshOrCurrentData = includesPattern(
    text,
    /\b(?:recent|latest|today|now|current|price|quote|market|holdings?|position|portfolio|earnings?)\b|最近|最新|今天|现在|行情|价格|持仓|仓位|组合|财报/u,
  );
  const webOrExternalLearning = includesPattern(
    text,
    /\b(?:learn|study|web|online|internet|paper|blog|interview|podcast|source|github|repo)\b|学习|网上|联网|网页|论文|博客|访谈|播客|来源|链接|开源|项目/u,
  );
  const localMemoryRecall = includesPattern(
    text,
    /\b(?:memory|previous|old rule|learned rule|receipt)\b|本地记忆|旧规则|以前|沉淀|已学|历史/u,
  );
  const modelDisagreement = includesPattern(
    text,
    /\b(?:model disagreement|which model|conflict)\b|大模型|模型.*分歧|分歧|冲突|听谁/u,
  );
  const financeDataGateway = orchestration.requiredTools.includes("finance_data_gateway_snapshot");
  const reviewPanel =
    orchestration.reviewTools.includes("review_panel") ||
    modelDisagreement ||
    webOrExternalLearning ||
    freshOrCurrentData;
  const qwenChallenge = reviewPanel || localMemoryRecall || webOrExternalLearning;

  return [
    {
      id: "fresh_or_current_data",
      required: freshOrCurrentData,
      reason: "current, priced, portfolio, or time-sensitive answer needs timestamped evidence",
    },
    {
      id: "web_or_external_learning",
      required: webOrExternalLearning,
      reason: "learning or source intake must read external material before claiming knowledge",
    },
    {
      id: "local_memory_recall",
      required: localMemoryRecall,
      reason: "old memory must be recalled, checked, and downranked when stale",
    },
    {
      id: "finance_data_gateway",
      required: financeDataGateway,
      reason: "finance numbers must pass the data gateway before visible use",
    },
    {
      id: "model_disagreement_arbitration",
      required: modelDisagreement,
      reason: "model disagreement must be arbitrated by evidence, not model preference",
    },
    {
      id: "review_panel",
      required: reviewPanel,
      reason: "high-risk or evidence-sensitive answers need a bounded local review gate",
    },
    {
      id: "qwen_challenge",
      required: qwenChallenge,
      reason: "Qwen can challenge the model candidate but cannot decide final authority",
    },
  ];
}

function resolveRequiredStages(needs: PipelineNeed[]): PipelineStageId[] {
  const requiredNeedIds = new Set(needs.filter((need) => need.required).map((need) => need.id));
  return [
    "language_intake",
    "intent_classifier",
    requiredNeedIds.has("local_memory_recall") ? "local_memory_recall" : undefined,
    requiredNeedIds.has("web_or_external_learning") ? "source_registry_or_web_learning" : undefined,
    requiredNeedIds.has("finance_data_gateway") ? "finance_data_gateway" : undefined,
    "local_brain_planner",
    "model_candidate_answer",
    requiredNeedIds.has("qwen_challenge") ? "qwen_challenger" : undefined,
    "local_contract_audit",
    requiredNeedIds.has("review_panel") ? "review_panel" : undefined,
    "visible_answer_adoption_gate",
    "reply_flow_receipt",
  ].filter((stage): stage is PipelineStageId => Boolean(stage));
}

function candidateHasEvidenceGapLanguage(candidate: string): boolean {
  return includesPattern(
    candidate.toLowerCase(),
    /\b(?:missing|need|needs|source|timestamp|data|as of|cannot conclude|failedreason|blockedreason)\b|缺|需要|来源|时间戳|数据|截至|不能下结论|无法判断|失败理由|缺口/u,
  );
}

function auditCandidate(params: {
  ask: string;
  candidateAnswer: string;
  needs: PipelineNeed[];
}): PipelineAuditCheck[] {
  const candidate = params.candidateAnswer.trim();
  const candidateLower = candidate.toLowerCase();
  const askLower = params.ask.toLowerCase();
  const requiredNeedIds = new Set(
    params.needs.filter((need) => need.required).map((need) => need.id),
  );

  const rawJsonOrInternalLabels =
    includesPattern(candidate, /^\s*\{/u) ||
    includesPattern(
      candidateLower,
      /\b(?:task_family|primary_modules|supporting_modules|required_tools|risk_boundaries|bounded_answer_review|finance_data_gateway_snapshot|review_panel)\b/u,
    );

  const directTradeLanguage =
    includesPattern(
      candidateLower,
      /\b(?:buy|sell|add|reduce|go long|go short)\b|(?:应该|建议|可以).{0,12}(买|卖|加仓|减仓|做多|做空)|仓位.{0,8}\d+%/u,
    ) &&
    !includesPattern(
      candidateLower,
      /不(?:能|应该|建议).{0,8}(买|卖|加仓|减仓)|不是.{0,8}交易建议|no trade advice/u,
    );

  const pickedModelWithoutEvidence =
    requiredNeedIds.has("model_disagreement_arbitration") &&
    includesPattern(candidateLower, /听大模型|trust the model|model is smarter|更聪明/u) &&
    !includesPattern(candidateLower, /证据|来源|时间戳|review|arbitration|分歧|排序|本地记忆/u);

  const checks: PipelineAuditCheck[] = [
    {
      id: "visible_text_no_internal_labels",
      ok: !rawJsonOrInternalLabels,
      failedReason: rawJsonOrInternalLabels
        ? "raw_json_or_internal_labels_in_visible_answer"
        : undefined,
      evidence: rawJsonOrInternalLabels
        ? "candidate leaks JSON/protocol/module labels"
        : "candidate is visible prose, not raw protocol output",
    },
    {
      id: "no_trade_or_execution_authority",
      ok: !directTradeLanguage,
      failedReason: directTradeLanguage ? "direct_trade_or_position_action_language" : undefined,
      evidence: directTradeLanguage
        ? "candidate gives direct buy/sell/sizing action"
        : "candidate does not claim execution authority",
    },
    {
      id: "model_answer_not_final_authority",
      ok: !pickedModelWithoutEvidence,
      failedReason: pickedModelWithoutEvidence
        ? "model_answer_chosen_without_evidence_arbitration"
        : undefined,
      evidence: pickedModelWithoutEvidence
        ? "candidate chooses the model by status instead of evidence"
        : "candidate does not make a model answer the final authority",
    },
  ];

  if (requiredNeedIds.has("fresh_or_current_data") || requiredNeedIds.has("finance_data_gateway")) {
    checks.push({
      id: "fresh_data_gap_or_timestamp_required",
      ok: candidateHasEvidenceGapLanguage(candidate),
      failedReason: candidateHasEvidenceGapLanguage(candidate)
        ? undefined
        : "fresh_data_or_timestamp_gap_not_marked",
      evidence: candidateHasEvidenceGapLanguage(candidate)
        ? "candidate marks missing data/source/timestamp before conclusion"
        : "candidate answers time-sensitive finance ask without marking data/source/timestamp gap",
    });
  }

  if (requiredNeedIds.has("web_or_external_learning")) {
    const sourceIntakeVisible = includesPattern(
      candidateLower,
      /\b(?:web|online|source|url|read|reading|registry|transcript|paper|blog)\b|联网|网上|来源|链接|阅读|实际阅读|登记|原文|作者|发布时间/u,
    );
    checks.push({
      id: "web_learning_source_intake_required",
      ok: sourceIntakeVisible,
      failedReason: sourceIntakeVisible ? undefined : "web_learning_source_intake_missing",
      evidence: sourceIntakeVisible
        ? "candidate routes learning through source intake and reading scope"
        : "candidate teaches from memory without source intake",
    });
  }

  if (requiredNeedIds.has("local_memory_recall")) {
    const memoryBoundaryVisible = includesPattern(
      candidateLower,
      /\b(?:memory|old rule|receipt|stale|downrank|source|evidence)\b|本地记忆|旧规则|过时|降权|证据|来源|时间戳/u,
    );
    checks.push({
      id: "local_memory_must_be_checked_not_obeyed",
      ok: memoryBoundaryVisible,
      failedReason: memoryBoundaryVisible ? undefined : "local_memory_check_missing",
      evidence: memoryBoundaryVisible
        ? "candidate treats local memory as evidence to check"
        : "candidate ignores stale-memory/downrank boundary",
    });
  }

  if (requiredNeedIds.has("model_disagreement_arbitration")) {
    const arbitrationVisible = includesPattern(
      candidateLower,
      /\b(?:evidence|source|timestamp|arbitrat|review|conflict|disagreement)\b|证据|来源|时间戳|分歧|冲突|裁判|排序|审阅/u,
    );
    checks.push({
      id: "model_disagreement_requires_evidence_ordering",
      ok: arbitrationVisible,
      failedReason: arbitrationVisible ? undefined : "model_disagreement_arbitration_missing",
      evidence: arbitrationVisible
        ? "candidate routes disagreement to evidence ordering"
        : "candidate does not explain evidence arbitration for model disagreement",
    });
  }

  if (
    includesPattern(askLower, /学习|learn|study/u) &&
    !requiredNeedIds.has("web_or_external_learning")
  ) {
    checks.push({
      id: "learning_ask_must_not_be_literal_only",
      ok: false,
      failedReason: "learning_intent_not_expanded_to_source_workflow",
      evidence: "learning ask was not expanded into source workflow",
    });
  }

  return checks;
}

function buildPipelineResult(ask: string, candidateAnswer: string) {
  const orchestration = planFinanceBrainOrchestration({
    text: ask,
    hasHoldingsOrPortfolioContext: /持仓|仓位|组合|portfolio|position|holdings?/iu.test(ask),
    highStakesConclusion:
      /买|卖|加仓|减仓|仓位|风险|当前|最新|今天|现在|buy|sell|risk|current|latest/iu.test(ask),
    writesDurableMemory: /学习|沉淀|memory|learn|study/iu.test(ask),
  });
  const needs = resolveNeeds(ask, orchestration);
  const stages = resolveRequiredStages(needs);
  const answerAuditPolicy = buildLarkAnswerAuditPolicy({
    workOrder: {
      validation: {
        qwenChallenge: {
          status: needs.some((need) => need.id === "qwen_challenge" && need.required)
            ? "recommended"
            : "not_requested",
        },
      },
    },
  } as Parameters<typeof buildLarkAnswerAuditPolicy>[0]);
  const checks = auditCandidate({ ask, candidateAnswer, needs });
  const failedReasons = checks
    .filter((check) => !check.ok && check.failedReason)
    .map((check) => check.failedReason!);
  const terminalDecision: TerminalDecision =
    failedReasons.length === 0 ? "adopt_visible_answer" : "return_failed_reason";
  return {
    ok: failedReasons.length === 0,
    boundary: "dev_commercial_answer_pipeline_only",
    ask,
    candidateAuthority: "model_candidate_not_final_authority",
    qwenRole: answerAuditPolicy.qwenRole,
    maxTotalReviewRounds: answerAuditPolicy.maxTotalReviewRounds,
    terminalDecision,
    failedReasons,
    contractFilters: COMMERCIAL_ANSWER_PIPELINE_FILTERS,
    stages,
    needs,
    orchestration,
    checks,
    receipts: [
      "commercial_answer_pipeline",
      "lark_language_handoff_receipt",
      "lark_context_packet",
      "review_panel",
      "feishu_reply_flow",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

function runScenarioSuite() {
  const results = BUILT_IN_SCENARIOS.map((scenario) => {
    const result = buildPipelineResult(scenario.ask, scenario.candidateAnswer);
    const expectedFailedReasons = scenario.expectedFailedReasons ?? [];
    const expectedFailedReasonsPresent = expectedFailedReasons.every((reason) =>
      result.failedReasons.includes(reason),
    );
    return {
      scenarioId: scenario.id,
      expectedDecision: scenario.expectedDecision,
      actualDecision: result.terminalDecision,
      ok: result.terminalDecision === scenario.expectedDecision && expectedFailedReasonsPresent,
      failedReasons: result.failedReasons,
      stages: result.stages,
      qwenRole: result.qwenRole,
    };
  });
  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    boundary: "dev_commercial_answer_pipeline_only",
    summary: {
      passed: results.length - failed.length,
      failed: failed.length,
      total: results.length,
    },
    contractFilters: COMMERCIAL_ANSWER_PIPELINE_FILTERS,
    scenarios: results,
    actionableFailures: failed.map(
      (result) =>
        `${result.scenarioId}: expected=${result.expectedDecision} actual=${result.actualDecision}`,
    ),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

const options = parseArgs(process.argv.slice(2));
const result =
  options.ask && options.candidateAnswer
    ? buildPipelineResult(options.ask, options.candidateAnswer)
    : runScenarioSuite();

if (options.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
