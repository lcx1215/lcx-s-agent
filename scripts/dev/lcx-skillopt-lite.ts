import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_WORKSPACE_DIR, GOVERNANCE_AUTOPILOT_LATEST_PATH } from "./lcx-local-paths.ts";

type CliOptions = {
  skillId: string;
  workspaceDir: string;
  write: boolean;
  json: boolean;
  maxTrainCases: number;
  phase: "bootstrap" | "candidate-edit";
  taskText?: string;
};

type SkillSpec = {
  id: string;
  title: string;
  purpose: string;
  requiredModules: string[];
  requiredRiskBoundaries: string[];
  rejectedContexts: string[];
  requiredMissingData: string[];
  regressionCaseIds: string[];
  triggerExamples: string[];
  casePatterns: RegExp[];
  triggerPatterns: RegExp[];
  capabilityRule: string;
};

type LatestAutopilotTruth = {
  checkedAt?: string;
  selectedCleanAdapter?: string;
  latestCandidateAdapter?: string;
  promotionReady?: boolean;
  failedCaseIds: string[];
  parseErrorCaseIds: string[];
  parseRecoveredCaseIds: string[];
  activeProcessCount: number;
  externalChannelBindingStatus?: string;
  /** Legacy compatibility alias while old governance snapshots are still readable. */
  liveBindingStatus?: string;
};

const SKILL_SPECS: Record<string, SkillSpec> = {
  single_stock_curve_technical_timing_preflight: {
    id: "single_stock_curve_technical_timing_preflight",
    title: "Single Stock Curve Technical Timing Preflight",
    purpose:
      "Convert single-stock curve or buy/sell timing asks into a research preflight, not a direct trade answer.",
    requiredModules: [
      "technical_timing",
      "company_fundamentals_value",
      "portfolio_risk_gates",
      "source_registry",
      "data_provenance_quality",
      "review_panel",
      "control_room_summary",
    ],
    requiredRiskBoundaries: [
      "research_only",
      "no_execution_authority",
      "evidence_required",
      "technical_timing_not_standalone_alpha",
      "risk_gate_before_action_language",
      "no_trade_advice",
    ],
    rejectedContexts: [
      "direct_buy_sell_answer",
      "technical_timing_as_standalone_alpha",
      "technical_pattern_as_trade_recommendation",
      "unverified_current_market_claim",
    ],
    requiredMissingData: [
      "single_stock_ohlcv_price_volume_series",
      "moving_average_volatility_and_gap_inputs",
      "price_volume_breadth_and_technical_regime_inputs",
      "latest_company_fundamental_inputs",
      "position_weights_cost_basis_and_risk_limits",
      "invalidation_condition_for_timing_signal",
    ],
    regressionCaseIds: [
      "single_stock_curve_technical_timing_preflight",
      "plain_buy_hold_research_boundary",
      "single_company_fundamental_risk",
    ],
    triggerExamples: [
      "NVDA 还能不能拿，要不要买一点？",
      "这只股票是不是该卖了？",
      "给一段单个股 OHLCV 曲线，判断趋势阶段、支撑阻力、假突破和失效条件。",
    ],
    casePatterns: [
      /single_stock|plain_single_stock|buy_hold|position_sizing|curve|technical|full_stack|a_share|recession|crypto|valuation|china_property|offensive_stock|short_lark_position_sizing/u,
    ],
    triggerPatterns: [
      /股票|个股|NVDA|买|卖|拿|仓位|持仓|支撑|阻力|突破|均线|量价|curve|stock|buy|sell|hold|position|sizing|technical/iu,
    ],
    capabilityRule:
      "single-stock buy/hold/sell and timing asks become research preflight with fundamentals, data provenance, portfolio risk gates, review, and no execution language.",
  },
  finance_data_provenance_preflight: {
    id: "finance_data_provenance_preflight",
    title: "Finance Data Provenance Preflight",
    purpose:
      "Gate current market, price, fundamental, macro, ETF, options, index-weight, vendor, or portfolio-risk numbers through provenance before use.",
    requiredModules: [
      "source_registry",
      "data_provenance_quality",
      "finance_data_gateway",
      "review_panel",
      "control_room_summary",
    ],
    requiredRiskBoundaries: [
      "research_only",
      "evidence_required",
      "no_unverified_current_market_claim",
      "conflicting_vendor_values_require_review",
      "no_trade_advice",
    ],
    rejectedContexts: [
      "invented_current_price",
      "stale_vendor_number_as_current",
      "unit_currency_or_adjustment_missing",
      "data_conflict_silently_resolved",
    ],
    requiredMissingData: [
      "source_url_or_local_source_path",
      "source_timestamp",
      "field_definition_unit_currency_and_adjusted_status",
      "provider_role_and_official_reference_scope",
      "conflict_resolution_or_downrank_decision",
    ],
    regressionCaseIds: [
      "current_market_data_research_preflight",
      "sentiment_vendor_conflict_validation_loop",
      "adversarial_data_conflict_06",
    ],
    triggerExamples: [
      "用最新价格和基本面判断 NVDA 风险。",
      "这两个数据源冲突，哪个能信？",
      "把当前市场数据先进 finance_data_gateway。",
    ],
    casePatterns: [
      /finance_data|data_provenance|vendor|data_conflict|current_market|fresh_market|price|fundamental|ETF|options|index_weight|conflict_validation/u,
    ],
    triggerPatterns: [
      /最新|当前|价格|数据|来源|口径|单位|币种|复权|vendor|provenance|gateway|conflict|timestamp|current market|fresh market/iu,
    ],
    capabilityRule:
      "mutable finance numbers require source timestamp, field definition, unit/currency, adjusted status, provider role, and conflict review before Qwen or Lark may use them.",
  },
  local_memory_conflict_preflight: {
    id: "local_memory_conflict_preflight",
    title: "Local Memory Conflict Preflight",
    purpose:
      "Use local memory as scoped evidence only after checking freshness, relevance, conflict, and downrank rules.",
    requiredModules: [
      "finance_learning_memory",
      "source_registry",
      "causal_map",
      "review_panel",
      "control_room_summary",
    ],
    requiredRiskBoundaries: [
      "research_only",
      "memory_scope_must_be_explicit",
      "stale_memory_must_downrank",
      "memory_not_provider_or_live_truth",
      "no_trade_advice",
    ],
    rejectedContexts: [
      "old_memory_as_current_fact",
      "memory_receipt_as_model_absorption",
      "memory_conflict_ignored",
      "protected_memory_write",
    ],
    requiredMissingData: [
      "memory_recall_scope_or_relevant_receipts",
      "memory_freshness_and_conflict_check",
      "source_registry_record",
      "keep_downrank_or_discard_decision",
      "fresh_adjacent_application_task",
    ],
    regressionCaseIds: [
      "local_memory_activation_expansion_03",
      "adversarial_memory_model_conflict_06",
      "plain_buy_hold_research_boundary",
    ],
    triggerExamples: [
      "用你之前学过的规则看一下这个问题。",
      "本地记忆和现在数据冲突怎么办？",
      "不要把旧 receipt 当成模型已经学会。",
    ],
    casePatterns: [
      /local_memory|memory_model_conflict|memory_activation|stale_memory|receipt_as_eval/u,
    ],
    triggerPatterns: [/记忆|之前|学过|本地|receipt|memory|recall|stale|downrank|discard/iu],
    capabilityRule:
      "local memory can cue scope and hypotheses, but current facts, model absorption, protected memory, and user-visible proof each need their own owner evidence.",
  },
  sentiment_vendor_source_gate_preflight: {
    id: "sentiment_vendor_source_gate_preflight",
    title: "Sentiment And Vendor Source Gate Preflight",
    purpose:
      "Keep sentiment, vendor, interviews, blogs, podcasts, and viral narratives hypothesis-only until source and application proof exist.",
    requiredModules: [
      "source_registry",
      "data_provenance_quality",
      "company_fundamentals_value",
      "causal_map",
      "review_panel",
      "control_room_summary",
    ],
    requiredRiskBoundaries: [
      "research_only",
      "alternative_source_hypothesis_only",
      "official_followup_required",
      "market_followthrough_window_required",
      "no_direct_causality_claim",
      "no_trade_advice",
    ],
    rejectedContexts: [
      "sentiment_as_alpha",
      "vendor_signal_as_direct_trade",
      "viral_story_as_causality",
      "unverified_transcript_or_source_type",
    ],
    requiredMissingData: [
      "source_type_and_reliability_grade",
      "primary_source_or_transcript",
      "official_followup",
      "fundamental_followthrough",
      "market_followthrough_window",
      "keep_downrank_or_discard_decision",
    ],
    regressionCaseIds: [
      "sentiment_market_external_module_learning",
      "alternative_market_signal_source_preflight",
      "sentiment_vendor_conflict_validation_loop",
    ],
    triggerExamples: [
      "某 CEO 饭局是不是行业信号？",
      "供应商说法和市场反应冲突怎么处理？",
      "社交情绪能不能作为买入理由？",
    ],
    casePatterns: [
      /sentiment|vendor|alternative_source|viral|ceo_dinner|external_knowledge|external_source/u,
    ],
    triggerPatterns: [
      /情绪|供应商|采访|播客|博客|饭局|传闻|舆论|sentiment|vendor|viral|interview|podcast|blog/iu,
    ],
    capabilityRule:
      "weak external signals remain hypotheses until source type, transcript, official follow-up, fundamentals, market window, review, and keep/downrank/discard are present.",
  },
  module_learning_absorption_preflight: {
    id: "module_learning_absorption_preflight",
    title: "Module Learning Absorption Preflight",
    purpose:
      "Prevent stored-only source learning claims by requiring retrieval, apply, eval/training absorption, review, and keep/downrank/discard evidence.",
    requiredModules: [
      "source_registry",
      "module_learning_pipeline_plan",
      "module_learning_pipeline_review",
      "local_brain_eval_absorption",
      "review_panel",
    ],
    requiredRiskBoundaries: [
      "dev_module_learning_only",
      "stored_source_not_learned_capability",
      "retrieval_ready_not_application_ready",
      "application_ready_not_eval_absorbed",
      "no_protected_memory_write",
    ],
    rejectedContexts: [
      "plan_receipt_as_eval_absorbed",
      "stored_summary_as_module_learning",
      "retrieval_receipt_as_weight_absorption",
      "missing_keep_downrank_discard_decision",
    ],
    requiredMissingData: [
      "source_registry_record",
      "actual_reading_scope",
      "module_specific_capability_rule",
      "retrieval_receipt",
      "apply_validation_receipt",
      "local_brain_eval_or_training_absorption_evidence",
      "fresh_adjacent_application_task",
      "keep_downrank_or_discard_decision",
    ],
    regressionCaseIds: [
      "module_learning_internalization",
      "sentiment_market_external_module_learning",
      "source_coverage_actual_reading_scope",
    ],
    triggerExamples: [
      "这个模块是不是已经学会了？",
      "把这篇 paper/source 内化进模块。",
      "receipt 不能冒充 eval_absorbed。",
    ],
    casePatterns: [
      /module_learning|source_coverage|internalization|eval_absorbed|actual_reading_scope|absorption/u,
    ],
    triggerPatterns: [
      /模块|学会|内化|吸收|资料|paper|论文|source|retrieval|apply|eval_absorbed|module learning/iu,
    ],
    capabilityRule:
      "module learning is only claimable after source registry, reading scope, capability rule, retrieval, apply validation, eval/training evidence, review, and keep/downrank/discard.",
  },
  external_channel_boundary_preflight: {
    id: "external_channel_boundary_preflight",
    title: "Lark External Channel Boundary Preflight",
    purpose:
      "Keep dev, eval, selected clean adapter, external-channel drift, channel restart, and real Lark user-visible evidence separated.",
    requiredModules: [
      "lark_external_channel_binding",
      "source_registry",
      "review_panel",
      "control_room_summary",
    ],
    requiredRiskBoundaries: [
      "dev_ready_not_user_visible_observed",
      "single_clean_adapter_only",
      "no_parse_recovered_runtime",
      "fresh_real_lark_inbound_and_outbound_required",
      "no_external_channel_sender_write_without_owner_gate",
    ],
    rejectedContexts: [
      "channel_probe_as_user_visible_observed",
      "multiple_lora_runtime",
      "dirty_candidate_external_channel_binding",
      "provider_config_or_external_channel_sender_drift",
    ],
    requiredMissingData: [
      "selected_clean_adapter",
      "external_channel_source_drift_zero_after_selected_adapter",
      "lark_external_channel_gateway_restarted_after_selected_adapter",
      "lark_external_channel_diagnose_ok_after_restart",
      "fresh_real_lark_inbound_and_outbound_user_visible_observed",
    ],
    regressionCaseIds: [
      "plain_buy_hold_research_boundary",
      "local_memory_activation_expansion_03",
      "adversarial_memory_model_conflict_06",
    ],
    triggerExamples: [
      "Lark 现在是不是已经连到最好的本地脑了？",
      "dev-ready 和 user-visible-observed 有什么区别？",
      "不能把 parseRecovered candidate 接进 Lark 外部通道。",
    ],
    casePatterns: [
      /live_lark|live_runtime|external_channel|user_visible|lark|feishu|live_user_seen|parse_recovered|adapter_mismatch/u,
    ],
    triggerPatterns: [
      /飞书|Lark|LiveLark|live|外部通道|可见|sidecar|adapter|LoRA|parseRecovered|dev-ready|live-visible|user-visible/iu,
    ],
    capabilityRule:
      "Lark external-channel proof requires one selected clean adapter, zero channel drift, restarted/probed channel gateway, diagnose success, and fresh real inbound/outbound user-visible evidence.",
  },
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-skillopt-lite.ts [--skill ID|auto|all] [--phase bootstrap|candidate-edit] [--task TEXT] [--workspace DIR] [--max-train-cases N] [--no-write] [--json]",
      "",
      "Builds local SkillOpt-lite seeds and preflight packets from latest governance/eval truth.",
      "It writes only under the OpenClaw workspace memory path and does not touch live/provider/protected-memory state.",
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
  const options: CliOptions = {
    skillId: "auto",
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    write: true,
    json: false,
    maxTrainCases: 8,
    phase: "bootstrap",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--skill") {
      options.skillId = readValue(args, index);
      index += 1;
    } else if (arg === "--phase") {
      const phase = readValue(args, index);
      if (phase !== "bootstrap" && phase !== "candidate-edit") {
        usage();
      }
      options.phase = phase;
      index += 1;
    } else if (arg === "--candidate-edit") {
      options.phase = "candidate-edit";
    } else if (arg === "--workspace" || arg === "--worktree") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--max-train-cases") {
      options.maxTrainCases = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--task" || arg === "--preflight") {
      options.taskText = readValue(args, index);
      index += 1;
    } else if (arg === "--no-write" || arg === "--dry-run") {
      options.write = false;
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

  if (!["auto", "all"].includes(options.skillId) && !SKILL_SPECS[options.skillId]) {
    throw new Error(`Unknown SkillOpt-lite skill: ${options.skillId}`);
  }
  return options;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function displayValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function extractLatestAutopilotTruth(
  snapshot: Record<string, unknown> | undefined,
): LatestAutopilotTruth {
  const owners = recordValue(snapshot?.owners);
  const trainingPlan = recordValue(owners.trainingPlan);
  const latestCandidateEval = recordValue(trainingPlan.latestCandidateEval);
  const activeHeavyEvalCounts = recordValue(trainingPlan.activeHeavyEvalCounts);
  const externalChannelBinding =
    recordValue(trainingPlan.externalChannelBinding) ??
    recordValue(trainingPlan.liveLarkBrainBinding);
  const activeProcessCount =
    typeof trainingPlan.activeProcessCount === "number"
      ? trainingPlan.activeProcessCount
      : Number(activeHeavyEvalCounts.localBrainEval ?? 0) + Number(activeHeavyEvalCounts.mlx ?? 0);

  return {
    checkedAt: typeof snapshot?.checkedAt === "string" ? snapshot.checkedAt : undefined,
    selectedCleanAdapter:
      typeof trainingPlan.selectedCleanAdapter === "string"
        ? trainingPlan.selectedCleanAdapter
        : undefined,
    latestCandidateAdapter:
      typeof latestCandidateEval.adapterPath === "string"
        ? latestCandidateEval.adapterPath
        : undefined,
    promotionReady:
      typeof latestCandidateEval.promotionReady === "boolean"
        ? latestCandidateEval.promotionReady
        : undefined,
    failedCaseIds: stringArray(latestCandidateEval.failedCaseIds),
    parseErrorCaseIds: stringArray(latestCandidateEval.parseErrorCaseIds),
    parseRecoveredCaseIds: stringArray(latestCandidateEval.parseRecoveredCaseIds),
    activeProcessCount,
    externalChannelBindingStatus:
      typeof externalChannelBinding.status === "string" ? externalChannelBinding.status : undefined,
    liveBindingStatus:
      typeof externalChannelBinding.status === "string" ? externalChannelBinding.status : undefined,
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function latestFailureIds(truth: LatestAutopilotTruth): string[] {
  return unique([
    ...truth.failedCaseIds,
    ...truth.parseErrorCaseIds,
    ...truth.parseRecoveredCaseIds,
  ]);
}

function matchesAny(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function casesForSpec(spec: SkillSpec, truth: LatestAutopilotTruth): string[] {
  return latestFailureIds(truth).filter((caseId) => matchesAny(spec.casePatterns, caseId));
}

function selectSpecs(options: CliOptions, truth: LatestAutopilotTruth): SkillSpec[] {
  if (options.skillId === "all") {
    return Object.values(SKILL_SPECS);
  }
  if (options.skillId !== "auto") {
    return [SKILL_SPECS[options.skillId]];
  }

  const taskMatched = options.taskText
    ? Object.values(SKILL_SPECS).filter((spec) =>
        matchesAny(spec.triggerPatterns, options.taskText ?? ""),
      )
    : [];
  const caseMatched = Object.values(SKILL_SPECS).filter(
    (spec) => casesForSpec(spec, truth).length > 0,
  );
  const selected = unique([...taskMatched, ...caseMatched].map((spec) => spec.id)).map(
    (id) => SKILL_SPECS[id],
  );
  return selected.length > 0
    ? selected
    : [SKILL_SPECS.single_stock_curve_technical_timing_preflight];
}

function buildCaseSplit(
  spec: SkillSpec,
  truth: LatestAutopilotTruth,
  maxTrainCases: number,
  explicitSkill: boolean,
) {
  const failures = unique([
    ...truth.failedCaseIds,
    ...truth.parseErrorCaseIds,
    ...truth.parseRecoveredCaseIds,
  ]);
  const specFailures = casesForSpec(spec, truth);
  const scopedFailures = specFailures.length > 0 || !explicitSkill ? specFailures : failures;
  const trainCases = scopedFailures.slice(0, maxTrainCases);
  const remainingFailures = failures.filter((caseId) => !trainCases.includes(caseId));
  const validationCases = remainingFailures.slice(0, maxTrainCases);
  const regressionCases = unique([...spec.regressionCaseIds, ...validationCases.slice(0, 3)]);
  return {
    trainCases,
    validationCases,
    regressionCases,
    rejectedEditBufferSeeds: [
      "direct_buy_sell_answer",
      "technical_timing_as_standalone_alpha",
      "receipt_as_eval_absorbed",
      "parse_recovered_as_promotion_ready",
      "channel_probe_as_user_visible_observed",
    ],
  };
}

function renderSkillMarkdown(
  spec: SkillSpec,
  truth: LatestAutopilotTruth,
  split: ReturnType<typeof buildCaseSplit>,
): string {
  const latestCandidate = truth.latestCandidateAdapter ?? "unknown";
  const selectedClean = truth.selectedCleanAdapter ?? "unknown";
  const parseRecoveredCount = truth.parseRecoveredCaseIds.length;
  return [
    `# ${spec.title}`,
    "",
    "boundary: dev_skillopt_lite_only",
    "status: bootstrap_best_skill_not_model_weight_absorbed",
    "",
    "## Purpose",
    spec.purpose,
    "",
    "## Runtime Truth",
    `- selected_clean_adapter: ${selectedClean}`,
    `- latest_candidate_adapter: ${latestCandidate}`,
    `- latest_candidate_promotion_ready: ${truth.promotionReady === true ? "true" : "false"}`,
    `- latest_parse_recovered_count: ${parseRecoveredCount}`,
    "- this skill cannot promote an adapter, write protected memory, touch provider config, or prove user-visible-observed",
    "",
    "## Trigger Examples",
    ...spec.triggerExamples.map((entry) => `- ${entry}`),
    "",
    "## Mandatory Route",
    "When the user asks for a single-stock curve, timing, buy/hold/sell, support/resistance, breakout, MA, volume, gap, or invalidation judgment:",
    ...spec.requiredModules.map((entry) => `- include ${entry}`),
    "",
    "## Required Missing Data",
    ...spec.requiredMissingData.map((entry) => `- ${entry}`),
    "",
    "## Risk Boundaries",
    ...spec.requiredRiskBoundaries.map((entry) => `- ${entry}`),
    "",
    "## Reject",
    ...spec.rejectedContexts.map((entry) => `- ${entry}`),
    "",
    "## Small Edit Policy",
    "- add/delete/replace one narrow rule at a time",
    "- accept an edit only when validation cases improve and regression cases do not degrade",
    "- keep technical_timing as timing context, never as standalone alpha",
    "- require company fundamentals, portfolio gates, source registry, data provenance, and review before any visible summary",
    "- return a research preflight and blocked reason instead of a direct buy/sell answer",
    "",
    "## SkillOpt-lite Case Split",
    `- train_cases: ${split.trainCases.join(", ") || "none"}`,
    `- validation_cases: ${split.validationCases.join(", ") || "none"}`,
    `- regression_cases: ${split.regressionCases.join(", ")}`,
    `- rejected_edit_buffer: ${split.rejectedEditBufferSeeds.join(", ")}`,
    "",
  ].join("\n");
}

function buildCandidateEditLines(trainCases: string[]): string[] {
  const cases = new Set(trainCases);
  const lines = [
    "",
    "## Candidate Edit: Adjacent Failure Transfer",
    "- status: pending_eval_acceptance",
    "- edit_type: add",
    "- learning_rate: one_narrow_rule_block",
  ];

  if (
    [...cases].some((caseId) =>
      /full_stack|a_share|recession|crypto|valuation|china_property/u.test(caseId),
    )
  ) {
    lines.push(
      "- if a single-stock timing ask mentions macro, FX, rates, crypto, China, recession, valuation compression, or cross-asset spillover, keep the single-stock route but attach macro/cross-asset context as missing evidence before review",
      "- do not let macro narrative replace company_fundamentals_value, source_registry, data_provenance_quality, portfolio_risk_gates, or review_panel",
    );
  }
  if ([...cases].some((caseId) => /short_lark_position_sizing/u.test(caseId))) {
    lines.push(
      "- short Lark wording such as '拿不拿', '卖不卖', or '仓位多少' must expand into research preflight plus blocked reason, not a direct position-size answer",
    );
  }
  if ([...cases].some((caseId) => /offensive_stock_opportunity/u.test(caseId))) {
    lines.push(
      "- opportunity language may produce a watchlist research plan, but never a buy list; ranking needs source evidence, valuation range, catalyst, invalidation, and risk gates",
    );
  }
  if (
    [...cases].some((caseId) =>
      /sentiment|external|local_memory|adversarial|alternative_source|finance_data|data_conflict|vendor/u.test(
        caseId,
      ),
    )
  ) {
    lines.push(
      "- memory, sentiment, vendor, alternative source, or external knowledge claims must stay hypothesis-only until source registry, timestamp/provenance, application validation, and review evidence exist",
    );
  }
  if (
    [...cases].some((caseId) => /module_learning|internalization|source_coverage/u.test(caseId))
  ) {
    lines.push(
      "- source or module-learning receipts must not be called absorbed until retrieval, apply validation, eval/training evidence, review, fresh adjacent task, and keep/downrank/discard proof exist",
    );
  }
  if (
    [...cases].some((caseId) =>
      /live_lark|live_runtime|external_channel|user_visible|adapter_mismatch|parse_recovered/u.test(
        caseId,
      ),
    )
  ) {
    lines.push(
      "- dev proof, selected-clean adapter proof, external-channel binding, and user-visible-observed proof are separate; never bind dirty or parseRecovered candidates to the Lark external channel",
    );
  }
  lines.push(
    "- accept this candidate edit only after targeted eval improves train cases and regression cases stay clean",
  );
  return lines;
}

function renderStaticContractTerms(spec: SkillSpec): string {
  return [
    "",
    "## Current Static Contract Terms",
    "",
    "### Required Modules",
    ...spec.requiredModules.map((entry) => `- ${entry}`),
    "",
    "### Required Risk Boundaries",
    ...spec.requiredRiskBoundaries.map((entry) => `- ${entry}`),
    "",
    "### Rejected Contexts",
    ...spec.rejectedContexts.map((entry) => `- ${entry}`),
    "",
    "### Required Missing Data",
    ...spec.requiredMissingData.map((entry) => `- ${entry}`),
  ].join("\n");
}

function refreshStaticContractTerms(baseMarkdown: string, spec: SkillSpec): string {
  const gate = staticGate(spec, baseMarkdown);
  if (gate.ok) {
    return baseMarkdown;
  }
  const sectionMarker = "## Current Static Contract Terms";
  const baseWithoutOldSection = baseMarkdown.includes(sectionMarker)
    ? baseMarkdown.slice(0, baseMarkdown.indexOf(sectionMarker)).trimEnd()
    : baseMarkdown.trimEnd();
  return `${baseWithoutOldSection}\n${renderStaticContractTerms(spec)}\n`;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function appendCandidateEdit(baseMarkdown: string, spec: SkillSpec, trainCases: string[]): string {
  const marker = "## Candidate Edit: Adjacent Failure Transfer";
  const baseWithFreshContract = refreshStaticContractTerms(baseMarkdown, spec);
  const baseWithoutOldCandidate = baseWithFreshContract.includes(marker)
    ? baseWithFreshContract.slice(0, baseWithFreshContract.indexOf(marker)).trimEnd()
    : baseWithFreshContract.trimEnd();
  return `${baseWithoutOldCandidate}\n${buildCandidateEditLines(trainCases).join("\n")}\n`;
}

function staticGate(spec: SkillSpec, markdown: string) {
  const requiredTokens = [
    ...spec.requiredModules,
    ...spec.requiredRiskBoundaries,
    ...spec.rejectedContexts,
    ...spec.requiredMissingData,
  ];
  const missingTokens = requiredTokens.filter((token) => !markdown.includes(token));
  return {
    ok: missingTokens.length === 0,
    missingTokens,
    score:
      requiredTokens.length === 0
        ? 1
        : (requiredTokens.length - missingTokens.length) / requiredTokens.length,
  };
}

function renderText(details: Record<string, unknown>): string {
  const lines = [
    `SkillOpt-lite | skill=${displayValue(details.skillId)}`,
    `boundary=${displayValue(details.boundary)}`,
    `phase=${displayValue(details.phase)}`,
    `status=${displayValue(details.status)}`,
    `matched_skill_ids=${Array.isArray(details.matchedSkillIds) ? details.matchedSkillIds.join(",") : ""}`,
    `write=${displayValue(details.updated)}`,
    `accepted=${displayValue(details.accepted)}`,
    `active_process_count=${displayValue(details.activeProcessCount)}`,
    `latest_candidate=${displayValue(details.latestCandidateAdapter)}`,
    `parse_recovered_count=${displayValue(details.parseRecoveredCount)}`,
    `train_cases=${displayValue(details.trainCaseCount)}`,
    `validation_cases=${displayValue(details.validationCaseCount)}`,
    `regression_cases=${displayValue(details.regressionCaseCount)}`,
    `static_gate_ok=${displayValue(details.staticGateOk)}`,
    `best_skill_path=${displayValue(details.bestSkillPath)}`,
    `receipt_path=${displayValue(details.receiptPath)}`,
    "next=run targeted eval after active eval/MLX is idle; do not claim eval_absorbed from this receipt alone",
  ];
  return `${lines.join("\n")}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function targetedEvalCommand(
  adapterPath: string | undefined,
  caseIds: string[],
  regressionCaseIds: string[],
  receiptPath: string,
): string {
  const adapterArg = adapterPath ? `--adapter ${shellQuote(adapterPath)}` : "--contract-only";
  const receiptArg = `--receipt ${shellQuote(receiptPath)}`;
  if (caseIds.length > 0) {
    return `node --import tsx scripts/dev/local-brain-distill-eval.ts ${adapterArg} --hardened --case-id ${caseIds.join(",")} --summary-only --json --timeout-ms 180000 ${receiptArg}`;
  }
  return `node --import tsx scripts/dev/local-brain-distill-eval.ts ${adapterArg} --contract-only --case-id ${regressionCaseIds.join(",")} --json ${receiptArg}`;
}

function buildInstantPreflight(params: {
  options: CliOptions;
  specs: SkillSpec[];
  workspaceDir: string;
  skillPaths: Record<string, string>;
}) {
  const task = params.options.taskText?.trim();
  if (!task) {
    return {
      status: "not_requested",
      boundary: "dev_skillopt_preflight_only",
      canUseImmediately: false,
      modelWeightAbsorbed: false,
      externalChannelApplied: false,
      liveLarkApplied: false,
    };
  }
  const matchedSpecs = params.specs.filter((spec) => matchesAny(spec.triggerPatterns, task));
  const effectiveSpecs = matchedSpecs.length > 0 ? matchedSpecs : params.specs;
  return {
    status: effectiveSpecs.length > 0 ? "ready_for_context_injection" : "no_matching_skill",
    boundary: "dev_skillopt_preflight_only",
    canUseImmediately: effectiveSpecs.length > 0,
    taskText: task,
    matchedSkillIds: effectiveSpecs.map((spec) => spec.id),
    bestSkillPaths: effectiveSpecs.map((spec) => params.skillPaths[spec.id]),
    promptInjection: [
      "Before answering, apply these SkillOpt-lite SOP rules as dev context only:",
      ...effectiveSpecs.map((spec) => `- ${spec.title} (${spec.id}): ${spec.capabilityRule}`),
      "- This preflight is immediate guidance, not model-weight absorption and not user-visible-observed proof.",
    ].join("\n"),
    modelWeightAbsorbed: false,
    externalChannelApplied: false,
    liveLarkApplied: false,
  };
}

function buildProofChain(params: {
  truth: LatestAutopilotTruth;
  adapterPath?: string;
  trainCases: string[];
  regressionCases: string[];
  receiptPath: string;
}) {
  const targetedCommand = targetedEvalCommand(
    params.adapterPath,
    params.trainCases,
    params.regressionCases,
    params.receiptPath,
  );
  return {
    boundary: "dev_skillopt_proof_chain_only",
    immediateUse: {
      status: "ready_via_preflight_context_injection",
      proof: "matched best_skill.md can be injected before answer planning",
      modelWeightAbsorbed: false,
      externalChannelApplied: false,
      liveLarkApplied: false,
    },
    targetedEval: {
      status:
        params.truth.activeProcessCount > 0
          ? "blocked_by_active_training_or_eval"
          : "ready_when_idle",
      command: targetedCommand,
      adapterPath: params.adapterPath,
      receiptPath: params.receiptPath,
      acceptanceGate: "targeted cases improve and regression cases stay clean",
    },
    modelWeightAbsorption: {
      status: "not_absorbed_until_training_and_promotion_truth",
      trainSliceCommand: "node --import tsx scripts/dev/local-brain-distill-train-slice.ts --json",
      trainingPlanCommand: "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      promotionAuditCommand: "node --import tsx scripts/dev/local-brain-promotion-audit.ts --json",
      requiredProof: [
        "accepted_skillopt_candidate",
        "targeted_eval_clean",
        "regression_cases_clean",
        "train_slice_contains_skillopt_or_teacher_curriculum_evidence",
        "new_adapter_hardened_eval_clean",
        "promotionReady_true",
        "failedCaseIds_empty",
        "parseErrorCaseIds_empty",
        "parseRecoveredCaseIds_empty",
      ],
    },
    externalChannelBinding: {
      status:
        params.truth.activeProcessCount > 0
          ? "blocked_by_active_training_or_eval"
          : "requires_external_channel_owner_proof",
      statusCommand: "node --import tsx scripts/dev/lcx-external-channel-binding.ts --json",
      applyCommand: "node --import tsx scripts/dev/lcx-external-channel-binding.ts --apply --json",
      requiredProof: [
        "selected_clean_adapter_only",
        "external_channel_source_drift_zero_after_selected_adapter",
        "lark_external_channel_gateway_restarted_after_selected_adapter",
        "lark_external_channel_diagnose_ok_after_restart",
        "fresh_real_lark_inbound_and_outbound_user_visible_observed",
      ],
      legacyAlias: "liveLarkBinding",
    },
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspaceDir = path.resolve(options.workspaceDir);
  const statePath =
    workspaceDir === DEFAULT_WORKSPACE_DIR
      ? GOVERNANCE_AUTOPILOT_LATEST_PATH
      : path.join(workspaceDir, "state", "lcx-governance-autopilot-latest.json");
  const snapshot = await readJsonIfExists(statePath);
  const truth = extractLatestAutopilotTruth(snapshot);
  const explicitSkill = !["auto", "all"].includes(options.skillId);
  const specs = selectSpecs(options, truth);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const skillPackets = await Promise.all(
    specs.map(async (spec) => {
      const split = buildCaseSplit(spec, truth, options.maxTrainCases, explicitSkill);
      const markdown = renderSkillMarkdown(spec, truth, split);
      const skillRoot = path.join(workspaceDir, "memory", "skillopt-lite", spec.id);
      const bestSkillPath = path.join(skillRoot, "best_skill.md");
      const latestReceiptPath = path.join(skillRoot, "skillopt-lite-latest.json");
      const candidatePath = path.join(skillRoot, "candidates", `${timestamp}.md`);
      const receiptPath = path.join(skillRoot, "receipts", `${timestamp}.json`);
      const existingBestSkill = await readTextIfExists(bestSkillPath);
      const outputMarkdown =
        options.phase === "candidate-edit"
          ? appendCandidateEdit(existingBestSkill ?? markdown, spec, split.trainCases)
          : markdown;
      const gate = staticGate(spec, outputMarkdown);
      const accepted =
        options.phase === "bootstrap" ? gate.ok : gate.ok && split.trainCases.length > 0;
      const status = gate.ok
        ? options.phase === "candidate-edit"
          ? accepted
            ? "candidate_edit_static_accepted_pending_eval"
            : "preflight_only_no_candidate_edit"
          : "bootstrap_best_skill_seed_ready"
        : "static_gate_failed";
      return {
        spec,
        split,
        outputMarkdown,
        gate,
        accepted,
        status,
        bestSkillPath,
        latestReceiptPath,
        candidatePath,
        receiptPath,
        relativeBestSkillPath: path.relative(workspaceDir, bestSkillPath),
        relativeCandidatePath: path.relative(workspaceDir, candidatePath),
        relativeReceiptPath: path.relative(workspaceDir, receiptPath),
        relativeLatestReceiptPath: path.relative(workspaceDir, latestReceiptPath),
      };
    }),
  );
  const primary = skillPackets[0];
  const unionTrainCases = unique(skillPackets.flatMap((packet) => packet.split.trainCases));
  const unionValidationCases = unique(
    skillPackets.flatMap((packet) => packet.split.validationCases),
  );
  const unionRegressionCases = unique(
    skillPackets.flatMap((packet) => packet.split.regressionCases),
  );
  const allStaticMissingTokens = unique(
    skillPackets.flatMap((packet) => packet.gate.missingTokens),
  );
  const allGateOk = skillPackets.every((packet) => packet.gate.ok);
  const candidatePackets = skillPackets.filter((packet) => packet.split.trainCases.length > 0);
  const allAccepted =
    options.phase === "bootstrap"
      ? skillPackets.every((packet) => packet.accepted)
      : candidatePackets.length > 0 && candidatePackets.every((packet) => packet.accepted);
  const skillPathMap = Object.fromEntries(
    skillPackets.map((packet) => [packet.spec.id, packet.relativeBestSkillPath]),
  );
  const proofChain = buildProofChain({
    truth,
    adapterPath: truth.latestCandidateAdapter ?? truth.selectedCleanAdapter,
    trainCases: unionTrainCases,
    regressionCases: unionRegressionCases,
    receiptPath: path.join(workspaceDir, "state", "lcx-skillopt-targeted-eval-receipt-latest.json"),
  });
  const instantPreflight = buildInstantPreflight({
    options,
    specs,
    workspaceDir,
    skillPaths: skillPathMap,
  });
  const details = {
    ok: allGateOk,
    boundary: "dev_skillopt_lite_only",
    phase: options.phase,
    status: allGateOk
      ? options.phase === "candidate-edit"
        ? allAccepted
          ? "candidate_edit_static_accepted_pending_eval"
          : "preflight_only_no_candidate_edit"
        : "bootstrap_best_skill_seed_ready"
      : "static_gate_failed",
    updated: options.write,
    accepted: allAccepted,
    skillId: primary.spec.id,
    requestedSkillId: options.skillId,
    matchedSkillIds: skillPackets.map((packet) => packet.spec.id),
    skillFamilyCount: skillPackets.length,
    checkedAt: new Date().toISOString(),
    sourceAutopilotPath: statePath,
    sourceAutopilotCheckedAt: truth.checkedAt,
    activeProcessCount: truth.activeProcessCount,
    selectedCleanAdapter: truth.selectedCleanAdapter,
    latestCandidateAdapter: truth.latestCandidateAdapter,
    latestCandidatePromotionReady: truth.promotionReady === true,
    parseRecoveredCount: truth.parseRecoveredCaseIds.length,
    failedCaseIds: truth.failedCaseIds,
    parseErrorCaseIds: truth.parseErrorCaseIds,
    parseRecoveredCaseIds: truth.parseRecoveredCaseIds,
    trainCases: unionTrainCases,
    validationCases: unionValidationCases,
    regressionCases: unionRegressionCases,
    rejectedEditBufferSeeds: unique(
      skillPackets.flatMap((packet) => packet.split.rejectedEditBufferSeeds),
    ),
    trainCaseCount: unionTrainCases.length,
    validationCaseCount: unionValidationCases.length,
    regressionCaseCount: unionRegressionCases.length,
    staticGateOk: allGateOk,
    staticGateScore:
      skillPackets.length === 0
        ? 0
        : skillPackets.reduce((sum, packet) => sum + packet.gate.score, 0) / skillPackets.length,
    staticGateMissingTokens: allStaticMissingTokens,
    bestSkillPath: primary.relativeBestSkillPath,
    candidatePath: primary.relativeCandidatePath,
    receiptPath: primary.relativeReceiptPath,
    latestReceiptPath: primary.relativeLatestReceiptPath,
    skillPackets: skillPackets.map((packet) => ({
      skillId: packet.spec.id,
      title: packet.spec.title,
      status: packet.status,
      accepted: packet.accepted,
      trainCases: packet.split.trainCases,
      validationCases: packet.split.validationCases,
      regressionCases: packet.split.regressionCases,
      trainCaseCount: packet.split.trainCases.length,
      validationCaseCount: packet.split.validationCases.length,
      regressionCaseCount: packet.split.regressionCases.length,
      staticGateOk: packet.gate.ok,
      staticGateScore: packet.gate.score,
      staticGateMissingTokens: packet.gate.missingTokens,
      bestSkillPath: packet.relativeBestSkillPath,
      candidatePath: packet.relativeCandidatePath,
      receiptPath: packet.relativeReceiptPath,
      capabilityRule: packet.spec.capabilityRule,
    })),
    instantPreflight,
    proofChain,
    absorptionPlan: proofChain.modelWeightAbsorption,
    externalChannelProofPlan: proofChain.externalChannelBinding,
    liveLarkProofPlan: proofChain.externalChannelBinding,
    nextIdleAction: "run_targeted_eval_then_accept_or_reject_skill_edit",
    nextIdleCommand: proofChain.targetedEval.command,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  if (options.write) {
    for (const packet of skillPackets) {
      const packetDetails = {
        ...details,
        skillId: packet.spec.id,
        status: packet.status,
        accepted: packet.accepted,
        trainCases: packet.split.trainCases,
        validationCases: packet.split.validationCases,
        regressionCases: packet.split.regressionCases,
        trainCaseCount: packet.split.trainCases.length,
        validationCaseCount: packet.split.validationCases.length,
        regressionCaseCount: packet.split.regressionCases.length,
        staticGateOk: packet.gate.ok,
        staticGateScore: packet.gate.score,
        staticGateMissingTokens: packet.gate.missingTokens,
        bestSkillPath: packet.relativeBestSkillPath,
        candidatePath: packet.relativeCandidatePath,
        receiptPath: packet.relativeReceiptPath,
        latestReceiptPath: packet.relativeLatestReceiptPath,
      };
      await fs.mkdir(path.dirname(packet.receiptPath), { recursive: true });
      if (options.phase === "candidate-edit") {
        await fs.mkdir(path.dirname(packet.candidatePath), { recursive: true });
        await fs.writeFile(packet.candidatePath, packet.outputMarkdown, "utf8");
      }
      if (packet.accepted) {
        await fs.writeFile(packet.bestSkillPath, packet.outputMarkdown, "utf8");
      }
      await fs.writeFile(packet.receiptPath, `${JSON.stringify(packetDetails, null, 2)}\n`, "utf8");
      await fs.writeFile(
        packet.latestReceiptPath,
        `${JSON.stringify(packetDetails, null, 2)}\n`,
        "utf8",
      );
    }
  }

  if (options.json) {
    console.log(JSON.stringify(details, null, 2));
  } else {
    process.stdout.write(renderText(details));
  }
}

await main();
