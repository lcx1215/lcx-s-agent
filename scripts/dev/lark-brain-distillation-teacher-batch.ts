import fs from "node:fs/promises";
import path from "node:path";
import {
  buildLarkBrainDistillationCandidate,
  LARK_BRAIN_DISTILLATION_REVIEW_DIR,
  type LarkBrainDistillationCandidate,
  type LarkBrainDistillationReviewArtifact,
} from "../../extensions/feishu/src/lark-brain-distillation-candidates.js";

type CliOptions = {
  workspaceDir: string;
  write: boolean;
  json: boolean;
};

type TeacherCase = {
  userMessage: string;
  payload: string;
  taskFamily: string;
  primaryModules: string[];
  supportingModules: string[];
  requiredTools: string[];
  missingData: string[];
  riskBoundaries: string[];
  nextStep: string;
  reason: string;
};

const DEFAULT_WORKSPACE = path.join(process.env.HOME ?? ".", ".openclaw", "workspace");

function usage(): never {
  throw new Error(
    "Usage: node --import tsx scripts/dev/lark-brain-distillation-teacher-batch.ts [--workspace DIR] [--write] [--json]",
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
  const options: CliOptions = {
    workspaceDir: DEFAULT_WORKSPACE,
    write: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace") {
      options.workspaceDir = readValue(args, index);
      index += 1;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  options.workspaceDir = path.resolve(options.workspaceDir);
  return options;
}

const RESEARCH_BOUNDARIES = [
  "research_only",
  "no_execution_authority",
  "evidence_required",
  "no_model_math_guessing",
  "risk_gate_before_action_language",
];

const REVIEW_TOOLS = ["review_panel"];

const CASES: TeacherCase[] = [
  {
    userMessage:
      "我持有 QQQ、TLT、NVDA，未来两周担心利率、AI capex、美元流动性，先拆内部模块，不要给交易建议。",
    payload:
      "This is a multi-module portfolio risk planning task. It needs macro rates, credit liquidity, ETF regime, company fundamentals, quant math, portfolio risk gates, and causal map before any answer.",
    taskFamily: "portfolio_multi_module_risk_planning",
    primaryModules: [
      "macro_rates_inflation",
      "credit_liquidity",
      "etf_regime",
      "company_fundamentals_value",
      "quant_math",
      "portfolio_risk_gates",
      "causal_map",
    ],
    supportingModules: ["finance_learning_memory", "control_room_summary", "review_panel"],
    requiredTools: [
      "finance_framework_macro_rates_inflation_producer",
      "finance_framework_credit_liquidity_producer",
      "finance_framework_etf_regime_producer",
      "finance_framework_company_fundamentals_value_producer",
      "quant_math",
      "finance_framework_portfolio_risk_gates_producer",
      "finance_framework_causal_map_producer",
      ...REVIEW_TOOLS,
    ],
    missingData: [
      "current_rates_and_inflation_inputs",
      "current_credit_and_liquidity_inputs",
      "target_etf_price_and_regime_inputs",
      "latest_company_fundamental_inputs",
      "position_weights_and_return_series",
      "portfolio_weights_and_risk_limits",
    ],
    riskBoundaries: RESEARCH_BOUNDARIES,
    nextStep: "request_fresh_inputs_then_route_to_concrete_finance_modules",
    reason: "core user-style portfolio risk prompt with no trade approval",
  },
  {
    userMessage: "重新来一遍。",
    payload:
      "Ambiguous repeat with no current subject. The planner must ask for the current subject and reject old Lark conversation history.",
    taskFamily: "ambiguous_repeat_without_current_subject",
    primaryModules: ["control_room_summary"],
    supportingModules: ["ops_audit"],
    requiredTools: ["review_panel"],
    missingData: ["current_subject_or_original_request"],
    riskBoundaries: ["research_only", "no_execution_authority", "evidence_required"],
    nextStep: "ask_user_for_current_subject_before_reusing_prior_context",
    reason: "prevents dirty old-context continuation",
  },
  {
    userMessage: "清除上下文，换个题，从头开始。",
    payload:
      "Context reset request. The planner should acknowledge reset, avoid prior task inheritance, and request the new subject.",
    taskFamily: "context_reset_new_subject_required",
    primaryModules: ["control_room_summary"],
    supportingModules: ["ops_audit"],
    requiredTools: ["review_panel"],
    missingData: ["new_subject_or_original_request"],
    riskBoundaries: ["research_only", "no_execution_authority", "evidence_required"],
    nextStep: "acknowledge_context_reset_then_ask_for_new_task_subject",
    reason: "teaches fresh-start behavior instead of continuing old option task",
  },
  {
    userMessage: "去学习这篇金融论文并沉淀成规则，但我还没给链接或本地文件。",
    payload:
      "External source learning is impossible without a source path. Select source registry and fail cleanly before claiming learning.",
    taskFamily: "external_source_learning_missing_source",
    primaryModules: ["finance_learning_memory", "source_registry"],
    supportingModules: ["review_panel", "control_room_summary"],
    requiredTools: [
      "finance_article_source_collection_preflight",
      "finance_article_source_registry_record",
      ...REVIEW_TOOLS,
    ],
    missingData: ["source_url_or_local_source_path"],
    riskBoundaries: RESEARCH_BOUNDARIES,
    nextStep: "return_source_required_failed_reason_and_ask_for_link_or_local_file",
    reason: "fixes missing source hallucination",
  },
  {
    userMessage:
      "从 Google Scholar、SSRN 和 NBER 学一批前沿量化论文，但要标清实际读过哪些材料，不要说全覆盖。",
    payload:
      "Scholarly source learning needs source registry, actual reading scope, coverage limits, finance learning memory, causal map, and retrieval review.",
    taskFamily: "external_scholarly_learning_coverage_honesty",
    primaryModules: ["finance_learning_memory", "source_registry", "causal_map"],
    supportingModules: ["review_panel", "control_room_summary"],
    requiredTools: [
      "finance_article_source_collection_preflight",
      "finance_article_source_registry_record",
      "finance_learning_retrieval_review",
      ...REVIEW_TOOLS,
    ],
    missingData: [
      "source_url_or_local_source_path",
      "actual_reading_scope",
      "source_coverage_limits",
    ],
    riskBoundaries: [...RESEARCH_BOUNDARIES, "do_not_claim_exhaustive_coverage"],
    nextStep:
      "collect_or_verify_source_list_then_report_actual_reading_scope_before_any_learning_claim",
    reason: "teaches coverage honesty for broad research requests",
  },
  {
    userMessage:
      "我有 QQQ、TLT、NVDA 三个仓位，想算波动、相关性、回撤和利率敏感性，但我还没给权重和价格序列。先拆模块，不要靠模型胡算。",
    payload:
      "Portfolio math must route to quant_math and portfolio_risk_gates, but must request position weights and return series before computing.",
    taskFamily: "quant_math_portfolio_risk_missing_inputs",
    primaryModules: ["quant_math", "portfolio_risk_gates", "etf_regime", "macro_rates_inflation"],
    supportingModules: ["finance_learning_memory", "review_panel", "control_room_summary"],
    requiredTools: [
      "quant_math",
      "finance_framework_portfolio_risk_gates_producer",
      "finance_framework_etf_regime_producer",
      "finance_framework_macro_rates_inflation_producer",
      ...REVIEW_TOOLS,
    ],
    missingData: [
      "position_weights_and_return_series",
      "volatility_window",
      "correlation_window",
      "drawdown_window",
      "tlt_duration_or_dv01_inputs",
    ],
    riskBoundaries: RESEARCH_BOUNDARIES,
    nextStep: "request_position_weights_and_return_series_before_any_local_math",
    reason: "prevents model guessed math",
  },
  {
    userMessage:
      "只研究 NVDA 基本面风险：AI capex、收入质量、估值、客户集中度、对科技仓的传导，不要给买卖建议。",
    payload:
      "Single-company fundamentals need company_fundamentals_value plus causal_map and portfolio_risk_gates because the user asks about tech sleeve transmission.",
    taskFamily: "single_company_fundamental_portfolio_risk",
    primaryModules: ["company_fundamentals_value", "causal_map", "portfolio_risk_gates"],
    supportingModules: ["finance_learning_memory", "review_panel", "control_room_summary"],
    requiredTools: [
      "finance_framework_company_fundamentals_value_producer",
      "finance_framework_causal_map_producer",
      "finance_framework_portfolio_risk_gates_producer",
      ...REVIEW_TOOLS,
    ],
    missingData: [
      "latest_company_fundamental_inputs",
      "hyperscaler_capex_guidance",
      "valuation_band",
      "customer_concentration",
      "company_to_portfolio_exposure_map",
    ],
    riskBoundaries: RESEARCH_BOUNDARIES,
    nextStep: "build_company_to_portfolio_causal_plan_then_require_fresh_evidence",
    reason: "fixes missing causal_map on fundamental risk prompts",
  },
  {
    userMessage: "它刚才又像串到旧任务了，先审计是不是 Lark 上下文污染，不要继续金融分析。",
    payload:
      "This is an ops audit, not a finance research task. Select ops_audit and request visible reply or message id before claiming live fixed.",
    taskFamily: "lark_context_pollution_audit",
    primaryModules: ["ops_audit"],
    supportingModules: ["control_room_summary"],
    requiredTools: ["lark_loop_diagnose", "sessions_history", "review_panel"],
    missingData: ["fresh_lark_message_id_or_visible_reply_text"],
    riskBoundaries: ["no_execution_authority", "evidence_required"],
    nextStep: "inspect_lark_session_store_and_candidate_replay_before_claiming_live_fixed",
    reason: "keeps ops audit from turning into finance analysis",
  },
  {
    userMessage:
      "你刚才纳斯达克那句话哪来的，给我 artifact、source 或 receipt，没有就标 unverified。",
    payload:
      "Source grounding complaint. Select ops_audit and source_registry; verify against receipts or mark unverified.",
    taskFamily: "source_grounding_audit",
    primaryModules: ["ops_audit", "source_registry", "control_room_summary"],
    supportingModules: ["review_panel"],
    requiredTools: ["lark_loop_diagnose", "source_registry_lookup", "review_panel"],
    missingData: ["claim_to_verify", "artifact_or_source_path"],
    riskBoundaries: ["no_execution_authority", "evidence_required"],
    nextStep: "verify_claim_against_receipts_or_mark_unverified_before_answering",
    reason: "teaches evidence-first answer review",
  },
  {
    userMessage: "学一个因子择时策略，但不要给我回测神话，要说过拟合、样本外和失效条件。",
    payload:
      "Factor timing learning needs ETF regime, quant math, causal map, source registry if external source exists, and overfit/survivor-bias boundaries.",
    taskFamily: "factor_timing_learning_with_overfit_guard",
    primaryModules: [
      "etf_regime",
      "quant_math",
      "causal_map",
      "portfolio_risk_gates",
      "finance_learning_memory",
    ],
    supportingModules: ["source_registry", "review_panel", "control_room_summary"],
    requiredTools: [
      "finance_framework_etf_regime_producer",
      "quant_math",
      "finance_framework_causal_map_producer",
      "finance_framework_portfolio_risk_gates_producer",
      "finance_learning_retrieval_review",
      ...REVIEW_TOOLS,
    ],
    missingData: ["strategy_source_or_spec", "out_of_sample_design", "risk_limit_definition"],
    riskBoundaries: [...RESEARCH_BOUNDARIES, "overfit_guard_required", "sample_out_required"],
    nextStep: "collect_strategy_source_then_build_research_only_rule_with_overfit_guard",
    reason: "matches user's factor timing learning path",
  },
];

function makeAcceptedCandidate(input: TeacherCase, index: number): LarkBrainDistillationCandidate {
  const candidate = buildLarkBrainDistillationCandidate({
    source: "teacher_review",
    userMessage: input.userMessage,
    payload: input.payload,
    createdAt: "2026-05-04T00:00:00.000Z",
    review: {
      accepted: true,
      reviewer: "deterministic_review",
      reason: input.reason,
    },
  });
  return {
    ...candidate,
    id: `${candidate.id}-teacher-${String(index + 1).padStart(2, "0")}`,
    status: "accepted_brain_plan",
    proposedTaskFamily: input.taskFamily,
    proposedPrimaryModules: input.primaryModules,
    proposedSupportingModules: input.supportingModules,
    proposedRequiredTools: input.requiredTools,
    proposedMissingData: input.missingData,
    proposedRiskBoundaries: input.riskBoundaries,
    proposedNextStep: input.nextStep,
  };
}

const options = parseArgs(process.argv.slice(2));
const reviewedAt = new Date().toISOString();
const acceptedCandidates = CASES.map(makeAcceptedCandidate);
const review: LarkBrainDistillationReviewArtifact = {
  schemaVersion: 1,
  boundary: "brain_distillation_review",
  reviewedAt,
  noLanguageRoutingPromotion: true,
  noLiveSenderTouched: true,
  sourceArtifacts: ["synthetic_teacher_batch:user_style_adversarial_finance_prompts"],
  acceptedCandidates,
  rejectedCandidates: [],
  counts: {
    sourceArtifacts: 1,
    pendingCandidates: acceptedCandidates.length,
    accepted: acceptedCandidates.length,
    rejected: 0,
    discarded: 0,
  },
};

let reviewPath: string | undefined;
if (options.write) {
  const dateKey = reviewedAt.slice(0, 10);
  const reviewDir = path.join(options.workspaceDir, LARK_BRAIN_DISTILLATION_REVIEW_DIR, dateKey);
  await fs.mkdir(reviewDir, { recursive: true });
  reviewPath = path.join(reviewDir, `teacher-batch-${reviewedAt.replace(/[:.]/gu, "-")}.json`);
  await fs.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
}

const result = {
  ok: true,
  boundary: "brain_distillation_review",
  write: options.write,
  workspaceDir: options.workspaceDir,
  reviewPath: reviewPath
    ? path.relative(options.workspaceDir, reviewPath).split(path.sep).join("/")
    : undefined,
  acceptedCandidates: acceptedCandidates.length,
  liveTouched: false,
  providerConfigTouched: false,
  noLanguageRoutingPromotion: review.noLanguageRoutingPromotion,
};

process.stdout.write(
  options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `teacher batch ready accepted=${acceptedCandidates.length} write=${options.write}\n`,
);
