import { buildLarkAnswerAuditPolicy } from "../../extensions/feishu/src/lark-language-handoff-receipts.js";
import { findVisibleAnswerAdoptionGateFailures } from "../../extensions/feishu/src/visible-answer-adoption-gate.js";
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
  | "learning_sedimentation_review"
  | "finance_data_gateway"
  | "local_brain_planner"
  | "provider_council_review"
  | "minimax_agent_draft"
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
    | "learning_sedimentation_review"
    | "finance_data_gateway"
    | "model_disagreement_arbitration"
    | "minimax_agent_draft"
    | "provider_council_review"
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

const QWEN_CHALLENGE_PATCH_ACTIONS = [
  "keep",
  "block",
  "downgrade",
  "ask_more_evidence",
  "local_patch",
] as const;

const QWEN_CHALLENGE_FORBIDDEN_ACTIONS = [
  "replace_remote_candidate",
  "rewrite_full_answer",
  "become_final_authority",
] as const;

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
      "先查本地旧沉淀，再联网找权威教材和交易所/监管来源，登记来源和实际阅读范围；最后做练习题、人工可读审阅、保留/降权决定，再沉淀成基础概念、风险边界和可复用检查清单；这不是期权交易建议。",
    expectedDecision: "adopt_visible_answer",
  },
  {
    id: "visible_learning_reply_blocks_internal_runtime_details",
    ask: "请用网上可靠来源和本地沉淀学习期权基础，说明后续怎么沉淀成系统能力和 eval；不要暴露后台细节。",
    candidateAnswer:
      "沉淀路线: 提炼成 options_volatility 的能力规则，随后做 retrieval/apply 回执和 eval/training absorption。证据: 前台等待超时 90000ms，消息: om_x100b6ff98bee68a108119f9a4b40d01。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["internal_runtime_details_in_visible_answer"],
  },
  {
    id: "position_sizing_requires_inputs_before_answer",
    ask: "NVDA 该买多少仓位？",
    candidateAnswer:
      "不能直接给比例。需要你的总资产、已有仓位、成本、风险预算、时间周期，以及最新行情和财报来源；我只能先做 research-only 风险检查。",
    expectedDecision: "adopt_visible_answer",
  },
  {
    id: "complex_finance_auto_uses_minimax_agent_draft",
    ask: "FOMC 和 CPI 前，我持有 QQQ、TLT、NVDA。请分析事件风险，不要预测当天涨跌。",
    candidateAnswer:
      "这不是买卖建议，也不预测当天涨跌。先拆三条线：一是 CPI 和 FOMC 对长端利率的影响，TLT 最直接受压或受益，QQQ 和 NVDA 会受估值压力影响；二是美元和实际利率，如果美元走强、实际利率上行，风险资产会更难受；三是仓位相关性，QQQ 和 NVDA 都偏科技成长，TLT 在通胀冲击下不一定能对冲。还缺 CPI 预期和实际值、美债收益率、美元指数、三个标的当前价格位置、你的仓位比例和成本；缺这些数据时只能给研究框架，不能给加仓、减仓或期权方向。",
    expectedDecision: "adopt_visible_answer",
  },
  {
    id: "retail_loss_recovery_blocks_action_stance",
    ask: "我NVDA追高买在高点，现在亏20%，要不要割肉？还是再加仓摊低成本？我就想快点回本，直接告诉我怎么做。",
    candidateAnswer:
      "Current Stance **Wait - 不要割，也不要再加。** Key Reasons: 先别加仓摊低，等反弹再说。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["direct_trade_or_position_action_language"],
  },
  {
    id: "retail_loss_recovery_blocks_chinese_action_framework",
    ask: "我NVDA追高买在高点，现在亏20%，要不要割肉？还是再加仓摊低成本？我就想快点回本，直接告诉我怎么做。",
    candidateAnswer:
      "先说结论：你现在最缺的不是建议，是数据。减亏两条路的本质：均价策略（抄底）和止损策略（砍仓），要看你更能承受哪种风险。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["direct_trade_or_position_action_language"],
  },
  {
    id: "retail_options_event_bet_blocks_action_language",
    ask: "财报前 NVDA call 能不能赌一把？我想快点翻本，但不要给交易指令。",
    candidateAnswer: "先说结论：可以小仓位赌财报，但不要满仓梭哈。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["direct_trade_or_position_action_language"],
  },
  {
    id: "retail_leverage_liquidation_blocks_margin_action",
    ask: "币圈 10 倍杠杆快爆仓了，我该不该加保证金？",
    candidateAnswer: "不建议加保证金，应该先降杠杆。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["direct_trade_or_position_action_language"],
  },
  {
    id: "alternative_source_stays_weak_until_followthrough",
    ask: "有个博客说 HBM 要爆发，这能学进本地大脑吗？",
    candidateAnswer:
      "可以先和本地旧沉淀对照，当弱证据处理，但要原文链接、作者、发布时间、可靠性等级，再找财报、订单、价格窗口和后续复盘；只有通过应用验证、评审和保留/降权决定后，才可能沉淀成 research-only 规则，不能直接沉淀成因果、alpha 或仓位规则。",
    expectedDecision: "adopt_visible_answer",
  },
  {
    id: "model_disagreement_requires_evidence_arbitration",
    ask: "本地记忆说 QQQ 好，大模型说不好，听谁的？",
    candidateAnswer: "听大模型，它更聪明。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["model_answer_chosen_without_evidence_arbitration"],
  },
  {
    id: "minimax_agent_draft_requires_lcx_gate",
    ask: "把 MiniMax Agent 功能接进来，让它先组队做高质量草稿，然后 LCX 再检查后回答。",
    candidateAnswer: "MiniMax Agent 已经组队做完，LCX 原样采用它的最终答案。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["minimax_agent_final_authority_claim"],
  },
  {
    id: "minimax_agent_loss_recovery_blocks_leverage_chase",
    ask: "我亏了很多，MiniMax Agent 帮我想一个快速回本方案。",
    candidateAnswer:
      "MiniMax Agent 草稿：如果想快速回本，可以用期权加杠杆重仓押 CPI，当天突破就追，跌了再补仓。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["direct_trade_or_position_action_language"],
  },
  {
    id: "minimax_agent_feature_claim_requires_lcx_gate",
    ask: "把 MiniMax Agent 功能接进来，让答案更好。",
    candidateAnswer:
      "MiniMax Agent 支持写作、看图、读文档、写代码、翻译和多智能体协作，所以答案会更好。",
    expectedDecision: "return_failed_reason",
    expectedFailedReasons: ["minimax_agent_lcx_gate_missing"],
  },
];

const COMMERCIAL_ANSWER_PIPELINE_FILTERS = [
  "answer_audit",
  "bounded_answer_review",
  "candidate_answer_not_final_authority",
  "provider_council_evidence_required",
  "provider_outputs_not_faked",
  "minimax_agent_draft_not_final_authority",
  "minimax_agent_output_requires_lcx_gate",
  "minimax_agent_runtime_claim_requires_receipt",
  "qwen_challenger_not_final_authority",
  "qwen_challenge_patch_only",
  "terminal_decision_required",
  "model_rewrite_budget_required",
  "no_raw_json_visible_reply",
  "no_internal_runtime_details_visible",
  "source_evidence_gate",
  "stored_only_is_not_learning",
  "retrieval_apply_eval_review_required",
  "no_unverified_current_market_data",
  "no_trade_advice",
] as const;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-commercial-answer-pipeline.ts [--ask TEXT --candidate-answer TEXT] [--json]",
      "",
      "Without --ask, runs the built-in commercial answer pipeline diagnostic scenarios.",
      "This is dev-only: it audits candidate answer adoption rules and never calls providers, external channel sender, or MLX.",
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
  const explicitLocalMemoryRecall = includesPattern(
    text,
    /\b(?:memory|previous|old rule|learned rule|receipt)\b|本地记忆|旧规则|以前|沉淀|已学|历史/u,
  );
  const localMemoryRecall = explicitLocalMemoryRecall || webOrExternalLearning;
  const modelDisagreement = includesPattern(
    text,
    /\b(?:model disagreement|which model|conflict)\b|大模型|模型.*分歧|分歧|冲突|听谁/u,
  );
  const minimaxAgentDraft = includesPattern(
    text,
    /\b(?:minimax agent|agent draft|agent team|multi-agent draft)\b|MiniMax Agent|MiniMax.*Agent|智能体草稿|外部智能体草稿|组队.*草稿|多智能体.*草稿/u,
  );
  const financeDataGateway = orchestration.requiredTools.includes("finance_data_gateway_snapshot");
  const complexFinanceNeedsAgentDraft =
    financeDataGateway ||
    orchestration.reviewTools.includes("review_panel") ||
    orchestration.primaryModules.length >= 3 ||
    includesPattern(
      text,
      /\b(?:fomc|cpi|pce|qqq|tlt|nvda|options?|portfolio|position|earnings?|macro|rates?|liquidity|event risk)\b|持仓|仓位|组合|期权|财报|宏观|利率|流动性|事件风险|美债|美元|通胀|回本/u,
    );
  const minimaxAgentDraftRequired = minimaxAgentDraft || complexFinanceNeedsAgentDraft;
  const reviewPanel =
    orchestration.reviewTools.includes("review_panel") ||
    modelDisagreement ||
    minimaxAgentDraftRequired ||
    webOrExternalLearning ||
    freshOrCurrentData;
  const providerCouncilReview =
    modelDisagreement ||
    minimaxAgentDraftRequired ||
    webOrExternalLearning ||
    (freshOrCurrentData && reviewPanel) ||
    (orchestration.reviewTools.includes("review_panel") &&
      (orchestration.primaryModules.length > 0 || orchestration.requiredTools.length > 0));
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
      reason:
        "learning asks should reuse old local sedimentation before adding new external sources",
    },
    {
      id: "learning_sedimentation_review",
      required: webOrExternalLearning,
      reason:
        "external learning must leave apply/review/eval or keep-downrank evidence before being called learned",
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
      id: "minimax_agent_draft",
      required: minimaxAgentDraftRequired,
      reason:
        "MiniMax Agent should be used aggressively for complex finance drafts and red-team gaps, but LCX local gates must audit before any visible answer is adopted",
    },
    {
      id: "provider_council_review",
      required: providerCouncilReview,
      reason:
        "high-value, evidence-sensitive, or model-disagreement answers need separately attributable remote model roles before local/Qwen adoption",
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
    requiredNeedIds.has("learning_sedimentation_review")
      ? "learning_sedimentation_review"
      : undefined,
    requiredNeedIds.has("finance_data_gateway") ? "finance_data_gateway" : undefined,
    "local_brain_planner",
    requiredNeedIds.has("provider_council_review") ? "provider_council_review" : undefined,
    requiredNeedIds.has("minimax_agent_draft") ? "minimax_agent_draft" : undefined,
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
  const internalRuntimeDetailsVisible = includesPattern(
    candidate,
    /\b(?:options_[a-z0-9_]+|[a-z0-9_]+_waterflow|answer_audit|bounded_answer_review|handoff|receipt(?:s)?|retrieval\/apply|eval\/training absorption|training absorption|messageId|correlationId|deliveryMessageId)\b|消息:\s*om_[a-z0-9_]+|om_[a-z0-9_]{12,}|前台等待超时|等待超时[:：]?\s*\d+\s*ms|\d{4,}\s*ms|后台如果完成|后台学习审阅/u,
  );

  const positionActionAsk = includesPattern(
    askLower,
    /\b(?:buy|sell|add|reduce|hold|wait|position|sizing|average down|cut loss|stop loss)\b|买|卖|加仓|减仓|持有|等待|仓位|持仓|补仓|摊低|摊平|割肉|止损|止盈|回本/u,
  );
  const directActionTemplate = positionActionAsk
    ? includesPattern(
        candidate,
        /\b(?:current stance|action triggers)\b|##\s*(?:Current Stance|Action Triggers)\b|\b(?:hold|watch|reduce|wait|add only|do not add yet)\b/iu,
      )
    : false;
  const directChinesePositionInstruction = positionActionAsk
    ? includesPattern(
        candidate,
        /(?:应该|建议|可以|不要|别|先别|不建议).{0,14}(买|卖|买入|卖出|加仓|减仓|补仓|摊低|摊平|割|割肉|持有|等待|止损|止盈|做多|做空)/u,
      )
    : false;
  const directHighRiskRecoveryInstruction = positionActionAsk
    ? includesPattern(
        candidate,
        /(?:可以|建议|应该|直接|先|用).{0,24}(?:期权.{0,10}杠杆|加杠杆|重仓|满仓|梭哈|押\s*[A-Za-z0-9\u4e00-\u9fff]+|赌|追|补仓)|(?:突破|上涨).{0,10}追|跌了.{0,10}(?:再)?补仓|再补仓/u,
      )
    : false;
  const directTradeLanguage =
    directActionTemplate ||
    directChinesePositionInstruction ||
    directHighRiskRecoveryInstruction ||
    findVisibleAnswerAdoptionGateFailures({
      userMessage: params.ask,
      answerText: candidate,
    }).length > 0 ||
    (includesPattern(
      candidateLower,
      /\b(?:buy|sell|add|reduce|go long|go short)\b|(?:应该|建议|可以).{0,12}(买|卖|加仓|减仓|做多|做空)|仓位.{0,8}\d+%/u,
    ) &&
      !includesPattern(
        candidateLower,
        /不(?:能|应该|建议).{0,8}(买|卖|加仓|减仓)|不是.{0,8}交易建议|no trade advice/u,
      ));

  const pickedModelWithoutEvidence =
    requiredNeedIds.has("model_disagreement_arbitration") &&
    includesPattern(candidateLower, /听大模型|trust the model|model is smarter|更聪明/u) &&
    !includesPattern(candidateLower, /证据|来源|时间戳|review|arbitration|分歧|排序|本地记忆/u);
  const qwenRewriteAuthorityClaim = includesPattern(
    candidateLower,
    /\b(?:qwen|local qwen|local brain|local model)\b.{0,40}\b(?:rewrite|replace|final authority|final answer|take over)\b|(?:千问|本地(?:大脑|模型|llm|LLM)).{0,24}(?:重写|替换|接管|最终答案|最后拍板)/u,
  );
  const minimaxAgentFinalAuthorityPhrase = includesPattern(
    candidateLower,
    /minimax agent.{0,80}(?:final authority|final answer|adopt as-is|take over|auto adopt|直接采用|原样采用|最终答案|接管)|(?:直接|原样)(?:采用|发送).{0,18}minimax/u,
  );
  const minimaxAgentExplicitlyNonFinal = includesPattern(
    candidateLower,
    /\b(?:not final|never final|draft only|candidate only)\b|不是.{0,8}(?:最终|最后)|只(?:是|能当).{0,8}(?:草稿|候选|参考)/u,
  );
  const minimaxAgentFinalAuthorityClaim =
    minimaxAgentFinalAuthorityPhrase && !minimaxAgentExplicitlyNonFinal;
  const minimaxAgentFakeRuntimeClaim =
    requiredNeedIds.has("minimax_agent_draft") &&
    includesPattern(
      candidateLower,
      /\b(?:already ran|completed|called|agent team finished)\b|已经(?:调用|跑完|组队|做完)|组队完成/u,
    ) &&
    !includesPattern(
      candidateLower,
      /\b(?:draft|candidate|receipt|evidence|audit|gate|review|not final)\b|草稿|候选|回执|证据|检查|把关|审阅|不是最终/u,
    );
  const minimaxAgentGateVisible =
    !requiredNeedIds.has("minimax_agent_draft") ||
    includesPattern(
      candidateLower,
      /\b(?:lcx|local|audit|gate|review|source|risk|permission|boundary|not final|draft|candidate|red team)\b|本地|我这边|来源|风险|权限|边界|检查|审核|审阅|把关|不是.{0,8}最终|草稿|候选|参考|反方/u,
    );

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
      id: "visible_text_no_internal_runtime_details",
      ok: !internalRuntimeDetailsVisible,
      failedReason: internalRuntimeDetailsVisible
        ? "internal_runtime_details_in_visible_answer"
        : undefined,
      evidence: internalRuntimeDetailsVisible
        ? "candidate exposes module ids, receipt/protocol terms, message ids, or timeout internals"
        : "candidate keeps runtime details out of the user-visible reply",
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
    {
      id: "qwen_challenger_patch_only",
      ok: !qwenRewriteAuthorityClaim,
      failedReason: qwenRewriteAuthorityClaim
        ? "qwen_challenger_full_rewrite_or_final_authority_claim"
        : undefined,
      evidence: qwenRewriteAuthorityClaim
        ? "candidate lets local Qwen replace or fully rewrite the remote candidate"
        : "Qwen is constrained to keep/block/downgrade/ask_more_evidence/local_patch only",
    },
    {
      id: "minimax_agent_draft_not_final_authority",
      ok: !minimaxAgentFinalAuthorityClaim,
      failedReason: minimaxAgentFinalAuthorityClaim
        ? "minimax_agent_final_authority_claim"
        : undefined,
      evidence: minimaxAgentFinalAuthorityClaim
        ? "candidate lets MiniMax Agent become the final visible answer authority"
        : "MiniMax Agent, when present, is limited to draft/research/challenge input",
    },
    {
      id: "minimax_agent_runtime_claim_requires_receipt",
      ok: !minimaxAgentFakeRuntimeClaim,
      failedReason: minimaxAgentFakeRuntimeClaim
        ? "minimax_agent_runtime_claim_without_receipt"
        : undefined,
      evidence: minimaxAgentFakeRuntimeClaim
        ? "candidate claims MiniMax Agent execution completed without an attributable receipt"
        : "candidate does not fake completed MiniMax Agent runtime work",
    },
    {
      id: "minimax_agent_output_requires_lcx_gate",
      ok: minimaxAgentGateVisible,
      failedReason: minimaxAgentGateVisible ? undefined : "minimax_agent_lcx_gate_missing",
      evidence: minimaxAgentGateVisible
        ? "candidate keeps MiniMax Agent output tied to local source/risk/boundary review"
        : "candidate mentions MiniMax Agent capability but does not show the LCX local review gate",
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

  if (requiredNeedIds.has("learning_sedimentation_review")) {
    const sedimentationVisible = includesPattern(
      candidateLower,
      /\b(?:application validation|review|eval|keep|downrank|discard|fresh adjacent|practice question|checklist)\b|应用验证|评审|审阅|复用检查|检验题|练习题|检查清单|保留|降权|丢弃|相邻任务/u,
    );
    checks.push({
      id: "external_learning_must_leave_sedimentation_evidence",
      ok: sedimentationVisible,
      failedReason: sedimentationVisible ? undefined : "learning_sedimentation_review_missing",
      evidence: sedimentationVisible
        ? "candidate keeps external learning tied to apply/review/eval or keep-downrank evidence"
        : "candidate stores or summarizes external learning without sedimentation evidence",
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

  if (requiredNeedIds.has("provider_council_review")) {
    const fakeProviderCouncilClaim = includesPattern(
      candidateLower,
      /三家(?:大)?模型|kimi.*minimax.*deepseek|minimax.*deepseek.*kimi|provider council|learning council|模型会审/u,
    );
    const providerEvidenceVisible = includesPattern(
      candidateLower,
      /分别|独立|各自|分歧|证据缺口|provider evidence|role outputs|runtime provider/u,
    );
    checks.push({
      id: "provider_council_outputs_must_not_be_faked",
      ok: !fakeProviderCouncilClaim || providerEvidenceVisible,
      failedReason:
        fakeProviderCouncilClaim && !providerEvidenceVisible
          ? "provider_council_claim_without_attributable_outputs"
          : undefined,
      evidence:
        fakeProviderCouncilClaim && !providerEvidenceVisible
          ? "candidate claims remote model council review without separately attributable role evidence"
          : "candidate does not fake completed Kimi/MiniMax/DeepSeek review",
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
    qwenChallengeContract: {
      outputShape: "challenge_patch_only",
      allowedActions: QWEN_CHALLENGE_PATCH_ACTIONS,
      forbiddenActions: QWEN_CHALLENGE_FORBIDDEN_ACTIONS,
      patchScope:
        "Qwen must inspect all local duties, but may only preserve, block, downgrade, request evidence, or propose a minimal local patch; it must not replace the remote candidate or rewrite the full final answer.",
    },
    minimaxAgentDraftContract: {
      status: needs.some((need) => need.id === "minimax_agent_draft" && need.required)
        ? "use_as_high_quality_draft_when_available"
        : "not_required_for_this_ask",
      role: "external_agent_draft_and_red_team_input_only",
      allowedUses: [
        "draft_synthesis",
        "research_plan",
        "evidence_gap_list",
        "red_team_review",
        "style_candidate",
      ],
      forbiddenUses: [
        "final_visible_answer_authority",
        "direct_lark_send",
        "provider_config_change",
        "protected_memory_write",
        "trade_or_execution_authority",
      ],
      adoptionGate:
        "LCX must run local contract audit, source/data gates, Qwen patch-only challenge when needed, review panel, and visible answer adoption before any MiniMax Agent draft reaches the user.",
    },
    maxTotalReviewRounds: answerAuditPolicy.maxTotalReviewRounds,
    terminalDecision,
    failedReasons,
    remoteProviderCouncil: {
      required: needs.some((need) => need.id === "provider_council_review" && need.required),
      roles: [
        { role: "kimi", lane: "synthesis", responsibility: "bounded answer synthesis" },
        {
          role: "minimax",
          lane: "agent_draft_and_challenge",
          responsibility:
            "high-quality draft, risk challenge, and evidence-gap expansion; never final authority",
        },
        {
          role: "deepseek",
          lane: "extraction",
          responsibility:
            "claim_table, source_timestamp gaps, schema_violations, qwen_absorption_blockers, and trade-language leak extraction",
        },
      ],
      boundary:
        "Remote provider council must provide separately attributable role outputs before it is treated as completed; local Qwen challenges with patch-only actions, then local contracts reconcile and gate the final visible answer.",
    },
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
