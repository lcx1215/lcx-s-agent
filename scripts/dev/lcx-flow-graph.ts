import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type FlowNodeId =
  | "ingress_lark_feishu"
  | "intent_classifier"
  | "local_brain_planner"
  | "finance_research_modules"
  | "finance_data_gateway"
  | "primary_market_data_provider"
  | "cross_check_market_data_provider"
  | "official_reference_data_provider"
  | "normalized_data_snapshot"
  | "data_provenance_quality_review"
  | "source_registry"
  | "finance_learning_memory"
  | "causal_map"
  | "review_panel"
  | "control_room_summary"
  | "visible_reply"
  | "source_intake"
  | "actual_reading_scope"
  | "capability_card"
  | "retrieval_receipt"
  | "apply_validation"
  | "local_brain_eval_absorption"
  | "module_learning_review"
  | "keep_downrank_discard"
  | "teacher_quota"
  | "brain_distillation_review"
  | "dataset_builder"
  | "qwen_training"
  | "hardened_eval"
  | "promotion_gate"
  | "adapter_resolver"
  | "failure_curriculum"
  | "dev_change"
  | "dev_tests"
  | "live_migration"
  | "build_restart_probe"
  | "real_lark_inbound"
  | "live_user_seen"
  | "new_codex_window"
  | "fixed_evidence_recovery"
  | "operator_latest_state"
  | "mind_model"
  | "flow_graph"
  | "training_plan"
  | "change_impact_plan"
  | "local_operator_loop"
  | "automation_cleanup"
  | "system_doctor"
  | "operator_latest_receipt"
  | "operator_digest"
  | "language_router"
  | "display_text_normalizer"
  | "reply_flow_audit"
  | "readability_review"
  | "provider_evidence"
  | "model_council"
  | "provider_boundary"
  | "source_conflict_review"
  | "memory_recall"
  | "memory_write_gate"
  | "correction_note"
  | "stale_memory_downrank"
  | "prior_work_search"
  | "similar_mechanism_merge"
  | "single_owner_contract"
  | "parallel_path_reject"
  | "external_agent_source"
  | "license_scope_review"
  | "workflow_distillation"
  | "local_skill_candidate"
  | "acceptance_eval"
  | "schedule_gate"
  | "repair_lock";

type FlowFilterId =
  | "source_evidence_gate"
  | "no_trade_advice"
  | "research_only_boundary"
  | "no_unverified_current_market_data"
  | "stored_only_is_not_learning"
  | "protected_memory_guard"
  | "language_corpus_separation"
  | "retrieval_apply_eval_review_required"
  | "training_overlap_guard"
  | "parse_recovered_no_promotion"
  | "promotion_ready_required"
  | "step_timeout_visible"
  | "dev_ready_not_live_user_seen"
  | "live_runtime_probe_required"
  | "real_lark_inbound_required"
  | "fresh_operator_state_required"
  | "single_digest_only"
  | "error_receipt_required"
  | "visible_text_no_internal_labels"
  | "reply_flow_audit_required"
  | "provider_evidence_required"
  | "no_provider_config_change"
  | "source_conflict_visible"
  | "fresh_timestamp_required"
  | "field_definition_required"
  | "three_source_reconciliation_required"
  | "conflicted_data_blocks_conclusion"
  | "memory_write_freshness_gate"
  | "correction_note_required"
  | "prior_work_reuse_required"
  | "same_philosophy_merge_required"
  | "single_owner_required"
  | "license_scope_required"
  | "untrusted_source_isolation"
  | "human_signoff_checkpoint"
  | "automation_schedule_gate"
  | "repair_lock_required";

type SurfaceGroup = "head" | "workflow" | "proof" | "boundary";

type FlowScenario = {
  id: string;
  family: string;
  objective: string;
  start: FlowNodeId;
  end: FlowNodeId;
  requiredNodes: FlowNodeId[];
  requiredFilters: FlowFilterId[];
  edges: Array<[FlowNodeId, FlowNodeId]>;
  feedbackEdges?: Array<[FlowNodeId, FlowNodeId]>;
  receipts: string[];
};

type FlowCheck = {
  id: string;
  ok: boolean;
  summary: string;
  evidence?: unknown;
};

type ConsolidationCluster = {
  id: string;
  philosophy: string;
  ownerScenario: string;
  ownerNode: FlowNodeId;
  sameClassTerms: string[];
  mergeFilters: FlowFilterId[];
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");

const NODE_IDS: FlowNodeId[] = [
  "ingress_lark_feishu",
  "intent_classifier",
  "local_brain_planner",
  "finance_research_modules",
  "finance_data_gateway",
  "primary_market_data_provider",
  "cross_check_market_data_provider",
  "official_reference_data_provider",
  "normalized_data_snapshot",
  "data_provenance_quality_review",
  "source_registry",
  "finance_learning_memory",
  "causal_map",
  "review_panel",
  "control_room_summary",
  "visible_reply",
  "source_intake",
  "actual_reading_scope",
  "capability_card",
  "retrieval_receipt",
  "apply_validation",
  "local_brain_eval_absorption",
  "module_learning_review",
  "keep_downrank_discard",
  "teacher_quota",
  "brain_distillation_review",
  "dataset_builder",
  "qwen_training",
  "hardened_eval",
  "promotion_gate",
  "adapter_resolver",
  "failure_curriculum",
  "dev_change",
  "dev_tests",
  "live_migration",
  "build_restart_probe",
  "real_lark_inbound",
  "live_user_seen",
  "new_codex_window",
  "fixed_evidence_recovery",
  "operator_latest_state",
  "mind_model",
  "flow_graph",
  "training_plan",
  "change_impact_plan",
  "local_operator_loop",
  "automation_cleanup",
  "system_doctor",
  "operator_latest_receipt",
  "operator_digest",
  "language_router",
  "display_text_normalizer",
  "reply_flow_audit",
  "readability_review",
  "provider_evidence",
  "model_council",
  "provider_boundary",
  "source_conflict_review",
  "memory_recall",
  "memory_write_gate",
  "correction_note",
  "stale_memory_downrank",
  "prior_work_search",
  "similar_mechanism_merge",
  "single_owner_contract",
  "parallel_path_reject",
  "external_agent_source",
  "license_scope_review",
  "workflow_distillation",
  "local_skill_candidate",
  "acceptance_eval",
  "schedule_gate",
  "repair_lock",
];

const FILTER_IDS: FlowFilterId[] = [
  "source_evidence_gate",
  "no_trade_advice",
  "research_only_boundary",
  "no_unverified_current_market_data",
  "stored_only_is_not_learning",
  "protected_memory_guard",
  "language_corpus_separation",
  "retrieval_apply_eval_review_required",
  "training_overlap_guard",
  "parse_recovered_no_promotion",
  "promotion_ready_required",
  "step_timeout_visible",
  "dev_ready_not_live_user_seen",
  "live_runtime_probe_required",
  "real_lark_inbound_required",
  "fresh_operator_state_required",
  "single_digest_only",
  "error_receipt_required",
  "visible_text_no_internal_labels",
  "reply_flow_audit_required",
  "provider_evidence_required",
  "no_provider_config_change",
  "source_conflict_visible",
  "fresh_timestamp_required",
  "field_definition_required",
  "three_source_reconciliation_required",
  "conflicted_data_blocks_conclusion",
  "memory_write_freshness_gate",
  "correction_note_required",
  "prior_work_reuse_required",
  "same_philosophy_merge_required",
  "single_owner_required",
  "license_scope_required",
  "untrusted_source_isolation",
  "human_signoff_checkpoint",
  "automation_schedule_gate",
  "repair_lock_required",
];

const FLOW_SCENARIOS: FlowScenario[] = [
  {
    id: "lark_finance_research_waterflow",
    family: "visible_lark_finance_research",
    objective:
      "A broad Lark/Feishu finance ask must reach the right research modules and visible summary without becoming trade advice or unsourced market data.",
    start: "ingress_lark_feishu",
    end: "visible_reply",
    requiredNodes: [
      "ingress_lark_feishu",
      "intent_classifier",
      "local_brain_planner",
      "finance_research_modules",
      "source_registry",
      "finance_learning_memory",
      "causal_map",
      "review_panel",
      "control_room_summary",
      "visible_reply",
    ],
    requiredFilters: [
      "source_evidence_gate",
      "no_trade_advice",
      "research_only_boundary",
      "no_unverified_current_market_data",
    ],
    edges: [
      ["ingress_lark_feishu", "intent_classifier"],
      ["intent_classifier", "local_brain_planner"],
      ["local_brain_planner", "finance_research_modules"],
      ["finance_research_modules", "source_registry"],
      ["finance_research_modules", "finance_learning_memory"],
      ["source_registry", "causal_map"],
      ["finance_learning_memory", "causal_map"],
      ["causal_map", "review_panel"],
      ["review_panel", "control_room_summary"],
      ["control_room_summary", "visible_reply"],
    ],
    feedbackEdges: [["review_panel", "finance_research_modules"]],
    receipts: ["feishu-reply-flow", "finance_learning_capability_apply", "review_panel"],
  },
  {
    id: "module_learning_internalization_waterflow",
    family: "online_learning_to_memory_sedimentation",
    objective:
      "External knowledge must flow through source, reading, capability, retrieval, application, eval absorption, review, and keep/downrank/discard before it is called learned.",
    start: "source_intake",
    end: "keep_downrank_discard",
    requiredNodes: [
      "source_intake",
      "source_registry",
      "actual_reading_scope",
      "capability_card",
      "retrieval_receipt",
      "apply_validation",
      "local_brain_eval_absorption",
      "module_learning_review",
      "keep_downrank_discard",
    ],
    requiredFilters: [
      "stored_only_is_not_learning",
      "protected_memory_guard",
      "language_corpus_separation",
      "retrieval_apply_eval_review_required",
    ],
    edges: [
      ["source_intake", "source_registry"],
      ["source_registry", "actual_reading_scope"],
      ["actual_reading_scope", "capability_card"],
      ["capability_card", "retrieval_receipt"],
      ["retrieval_receipt", "apply_validation"],
      ["apply_validation", "local_brain_eval_absorption"],
      ["local_brain_eval_absorption", "module_learning_review"],
      ["module_learning_review", "keep_downrank_discard"],
    ],
    feedbackEdges: [["module_learning_review", "capability_card"]],
    receipts: ["module_learning_pipeline_plan", "module_learning_pipeline_review"],
  },
  {
    id: "training_failure_feedback_waterflow",
    family: "teacher_qwen_eval_promotion_loop",
    objective:
      "Teacher output, Qwen training, hardened eval, and promotion must form a bounded feedback loop instead of force-promoting weak adapters.",
    start: "teacher_quota",
    end: "adapter_resolver",
    requiredNodes: [
      "teacher_quota",
      "brain_distillation_review",
      "dataset_builder",
      "qwen_training",
      "hardened_eval",
      "promotion_gate",
      "adapter_resolver",
      "failure_curriculum",
    ],
    requiredFilters: [
      "training_overlap_guard",
      "parse_recovered_no_promotion",
      "promotion_ready_required",
      "step_timeout_visible",
    ],
    edges: [
      ["teacher_quota", "brain_distillation_review"],
      ["brain_distillation_review", "dataset_builder"],
      ["dataset_builder", "qwen_training"],
      ["qwen_training", "hardened_eval"],
      ["hardened_eval", "promotion_gate"],
      ["promotion_gate", "adapter_resolver"],
    ],
    feedbackEdges: [
      ["hardened_eval", "failure_curriculum"],
      ["failure_curriculum", "teacher_quota"],
    ],
    receipts: [
      "minimax-brain-training-guard",
      "local-brain-training-plan",
      "candidate_hardened_eval",
    ],
  },
  {
    id: "dev_to_live_lark_waterflow",
    family: "dev_ready_to_live_user_seen_boundary",
    objective:
      "Dev changes can move to live runtime only through tests, migration, build/restart/probe, and then real Lark inbound proof.",
    start: "dev_change",
    end: "live_user_seen",
    requiredNodes: [
      "dev_change",
      "dev_tests",
      "live_migration",
      "build_restart_probe",
      "real_lark_inbound",
      "live_user_seen",
    ],
    requiredFilters: [
      "dev_ready_not_live_user_seen",
      "live_runtime_probe_required",
      "real_lark_inbound_required",
    ],
    edges: [
      ["dev_change", "dev_tests"],
      ["dev_tests", "live_migration"],
      ["live_migration", "build_restart_probe"],
      ["build_restart_probe", "real_lark_inbound"],
      ["real_lark_inbound", "live_user_seen"],
    ],
    receipts: ["live-promotion", "feishu-reply-flow"],
  },
  {
    id: "compressed_context_recovery_waterflow",
    family: "future_agent_state_recovery",
    objective:
      "A new or compressed coding window must recover state from durable files, fresh operator state, mind model, flow graph, training plan, and change-impact plan.",
    start: "new_codex_window",
    end: "change_impact_plan",
    requiredNodes: [
      "new_codex_window",
      "fixed_evidence_recovery",
      "operator_latest_state",
      "mind_model",
      "flow_graph",
      "training_plan",
      "change_impact_plan",
    ],
    requiredFilters: ["fresh_operator_state_required", "error_receipt_required"],
    edges: [
      ["new_codex_window", "fixed_evidence_recovery"],
      ["fixed_evidence_recovery", "operator_latest_state"],
      ["operator_latest_state", "mind_model"],
      ["mind_model", "flow_graph"],
      ["flow_graph", "training_plan"],
      ["training_plan", "change_impact_plan"],
    ],
    feedbackEdges: [["change_impact_plan", "mind_model"]],
    receipts: ["lcx-local-operator-latest", "lcx-context-recovery-exam", "lcx-flow-graph"],
  },
  {
    id: "local_automation_digest_waterflow",
    family: "local_operator_to_single_digest",
    objective:
      "Local automation should gather cleanup, doctor, training plan, mind model, flow graph, and context recovery into one latest receipt and one digest.",
    start: "local_operator_loop",
    end: "operator_digest",
    requiredNodes: [
      "local_operator_loop",
      "automation_cleanup",
      "system_doctor",
      "training_plan",
      "mind_model",
      "flow_graph",
      "operator_latest_receipt",
      "operator_digest",
    ],
    requiredFilters: ["single_digest_only", "error_receipt_required", "training_overlap_guard"],
    edges: [
      ["local_operator_loop", "automation_cleanup"],
      ["automation_cleanup", "system_doctor"],
      ["system_doctor", "training_plan"],
      ["training_plan", "mind_model"],
      ["mind_model", "flow_graph"],
      ["flow_graph", "operator_latest_receipt"],
      ["operator_latest_receipt", "operator_digest"],
    ],
    receipts: ["lcx-local-operator-loop", "lcx-local-operator-latest", "LCX Agent Operator Digest"],
  },
  {
    id: "lark_visible_language_waterflow",
    family: "visible_lark_readability_and_language_boundary",
    objective:
      "Lark/Feishu visible replies must route language, normalize display text, audit reply flow, and hide internal labels from the user.",
    start: "ingress_lark_feishu",
    end: "visible_reply",
    requiredNodes: [
      "ingress_lark_feishu",
      "intent_classifier",
      "language_router",
      "local_brain_planner",
      "control_room_summary",
      "display_text_normalizer",
      "readability_review",
      "reply_flow_audit",
      "visible_reply",
    ],
    requiredFilters: [
      "visible_text_no_internal_labels",
      "reply_flow_audit_required",
      "dev_ready_not_live_user_seen",
    ],
    edges: [
      ["ingress_lark_feishu", "intent_classifier"],
      ["intent_classifier", "language_router"],
      ["language_router", "local_brain_planner"],
      ["local_brain_planner", "control_room_summary"],
      ["control_room_summary", "display_text_normalizer"],
      ["display_text_normalizer", "readability_review"],
      ["readability_review", "reply_flow_audit"],
      ["reply_flow_audit", "visible_reply"],
    ],
    feedbackEdges: [["readability_review", "display_text_normalizer"]],
    receipts: ["feishu-reply-flow", "normalizeFeishuDisplayText", "lark-loop-diagnose"],
  },
  {
    id: "provider_council_evidence_waterflow",
    family: "multi_model_provider_evidence_review",
    objective:
      "Model council or external-provider review must keep provider evidence, source conflicts, and provider-config boundaries separate from local deterministic review.",
    start: "model_council",
    end: "review_panel",
    requiredNodes: [
      "model_council",
      "provider_boundary",
      "provider_evidence",
      "source_registry",
      "source_conflict_review",
      "review_panel",
      "control_room_summary",
    ],
    requiredFilters: [
      "provider_evidence_required",
      "no_provider_config_change",
      "source_conflict_visible",
      "research_only_boundary",
    ],
    edges: [
      ["model_council", "provider_boundary"],
      ["provider_boundary", "provider_evidence"],
      ["provider_evidence", "source_registry"],
      ["source_registry", "source_conflict_review"],
      ["source_conflict_review", "review_panel"],
      ["review_panel", "control_room_summary"],
    ],
    feedbackEdges: [["review_panel", "source_conflict_review"]],
    receipts: ["learning-council", "model-council-provider-evidence", "review_panel"],
  },
  {
    id: "memory_correction_downrank_waterflow",
    family: "memory_recall_correction_and_downrank",
    objective:
      "Memory recall must mark stale or wrong premises, write correction notes when allowed, and downrank stale memory without touching protected summaries.",
    start: "memory_recall",
    end: "stale_memory_downrank",
    requiredNodes: [
      "memory_recall",
      "source_registry",
      "source_conflict_review",
      "memory_write_gate",
      "correction_note",
      "stale_memory_downrank",
      "review_panel",
    ],
    requiredFilters: [
      "memory_write_freshness_gate",
      "correction_note_required",
      "protected_memory_guard",
      "source_evidence_gate",
    ],
    edges: [
      ["memory_recall", "source_registry"],
      ["source_registry", "source_conflict_review"],
      ["source_conflict_review", "memory_write_gate"],
      ["memory_write_gate", "correction_note"],
      ["correction_note", "stale_memory_downrank"],
      ["stale_memory_downrank", "review_panel"],
    ],
    feedbackEdges: [["review_panel", "memory_recall"]],
    receipts: ["correction_note", "stale_memory_rule_downrank", "review_panel"],
  },
  {
    id: "finance_data_gateway_waterflow",
    family: "timestamped_finance_data_reconciliation",
    objective:
      "Finance answers that use current, priced, fundamental, macro, ETF, options, or vendor numbers must pass through one data gateway that preserves timestamps, field definitions, and provider conflicts before Qwen, Lark, or memory can use the numbers.",
    start: "finance_research_modules",
    end: "control_room_summary",
    requiredNodes: [
      "finance_research_modules",
      "finance_data_gateway",
      "primary_market_data_provider",
      "cross_check_market_data_provider",
      "official_reference_data_provider",
      "normalized_data_snapshot",
      "data_provenance_quality_review",
      "causal_map",
      "review_panel",
      "control_room_summary",
    ],
    requiredFilters: [
      "fresh_timestamp_required",
      "field_definition_required",
      "three_source_reconciliation_required",
      "conflicted_data_blocks_conclusion",
      "source_evidence_gate",
      "source_conflict_visible",
      "no_unverified_current_market_data",
      "no_trade_advice",
    ],
    edges: [
      ["finance_research_modules", "finance_data_gateway"],
      ["primary_market_data_provider", "finance_data_gateway"],
      ["cross_check_market_data_provider", "finance_data_gateway"],
      ["official_reference_data_provider", "finance_data_gateway"],
      ["finance_data_gateway", "normalized_data_snapshot"],
      ["finance_data_gateway", "data_provenance_quality_review"],
      ["normalized_data_snapshot", "causal_map"],
      ["data_provenance_quality_review", "review_panel"],
      ["causal_map", "review_panel"],
      ["review_panel", "control_room_summary"],
    ],
    feedbackEdges: [["review_panel", "finance_data_gateway"]],
    receipts: ["finance-data-gateway", "data_provenance_quality_review", "control_room_summary"],
  },
  {
    id: "similar_engineering_consolidation_waterflow",
    family: "same_philosophy_engineering_merge",
    objective:
      "Same-class system engineering mechanisms must first search prior work, merge into an existing owner, and reject parallel paths unless the old owner is insufficient.",
    start: "dev_change",
    end: "single_owner_contract",
    requiredNodes: [
      "dev_change",
      "change_impact_plan",
      "prior_work_search",
      "similar_mechanism_merge",
      "single_owner_contract",
      "parallel_path_reject",
      "mind_model",
      "flow_graph",
      "system_doctor",
    ],
    requiredFilters: [
      "prior_work_reuse_required",
      "same_philosophy_merge_required",
      "single_owner_required",
      "error_receipt_required",
    ],
    edges: [
      ["dev_change", "change_impact_plan"],
      ["change_impact_plan", "prior_work_search"],
      ["prior_work_search", "similar_mechanism_merge"],
      ["similar_mechanism_merge", "single_owner_contract"],
      ["similar_mechanism_merge", "parallel_path_reject"],
      ["single_owner_contract", "mind_model"],
      ["mind_model", "flow_graph"],
      ["flow_graph", "system_doctor"],
    ],
    feedbackEdges: [["system_doctor", "change_impact_plan"]],
    receipts: ["lcx-change-impact-plan", "mind-model-consistency", "flow_graph_exam"],
  },
  {
    id: "external_agent_skill_distillation_waterflow",
    family: "external_agent_or_skill_learning",
    objective:
      "External agent, skill, or open-source workflow learning must be isolated, licensed, distilled into LCX workflow patterns, and proven by eval before use.",
    start: "external_agent_source",
    end: "acceptance_eval",
    requiredNodes: [
      "external_agent_source",
      "source_registry",
      "license_scope_review",
      "actual_reading_scope",
      "workflow_distillation",
      "local_skill_candidate",
      "review_panel",
      "acceptance_eval",
    ],
    requiredFilters: [
      "license_scope_required",
      "untrusted_source_isolation",
      "human_signoff_checkpoint",
      "no_provider_config_change",
      "protected_memory_guard",
    ],
    edges: [
      ["external_agent_source", "source_registry"],
      ["source_registry", "license_scope_review"],
      ["license_scope_review", "actual_reading_scope"],
      ["actual_reading_scope", "workflow_distillation"],
      ["workflow_distillation", "local_skill_candidate"],
      ["local_skill_candidate", "review_panel"],
      ["review_panel", "acceptance_eval"],
    ],
    feedbackEdges: [["acceptance_eval", "workflow_distillation"]],
    receipts: ["skill_pattern_distillation", "agent_workflow_memory", "local-brain-distill-eval"],
  },
  {
    id: "automation_repair_lock_waterflow",
    family: "codex_auto_repair_and_schedule_guard",
    objective:
      "Automation repair must run through schedule gates, repair lock, doctor evidence, and operator receipt instead of spawning duplicate or silent jobs.",
    start: "training_plan",
    end: "operator_latest_receipt",
    requiredNodes: [
      "training_plan",
      "schedule_gate",
      "repair_lock",
      "dev_change",
      "dev_tests",
      "system_doctor",
      "operator_latest_receipt",
    ],
    requiredFilters: [
      "automation_schedule_gate",
      "repair_lock_required",
      "single_digest_only",
      "training_overlap_guard",
      "error_receipt_required",
    ],
    edges: [
      ["training_plan", "schedule_gate"],
      ["schedule_gate", "repair_lock"],
      ["repair_lock", "dev_change"],
      ["dev_change", "dev_tests"],
      ["dev_tests", "system_doctor"],
      ["system_doctor", "operator_latest_receipt"],
    ],
    feedbackEdges: [["system_doctor", "training_plan"]],
    receipts: [
      "lcx-automation-repair-lock",
      "local-brain-training-plan",
      "lcx-local-operator-latest",
    ],
  },
];

const ILLEGAL_EDGES: Array<[string, string, string]> = [
  ["dev_change", "live_user_seen", "dev changes must not skip migration and real Lark proof"],
  ["source_intake", "keep_downrank_discard", "stored or read source must not skip internalization"],
  ["hardened_eval", "adapter_resolver", "eval must pass through promotion gate"],
  [
    "source_registry",
    "finance_learning_memory",
    "source registry alone is not learned memory without the module-learning flow",
  ],
  [
    "finance_data_gateway",
    "visible_reply",
    "current finance data must pass normalized snapshot, causal map, review, and summary before visible reply",
  ],
  [
    "dev_change",
    "flow_graph",
    "small dev changes must pass change-impact and prior-work search first",
  ],
  [
    "memory_recall",
    "correction_note",
    "memory correction must pass source conflict and write gates",
  ],
  [
    "external_agent_source",
    "local_skill_candidate",
    "external skills must pass license and reading scope",
  ],
  ["training_plan", "dev_change", "automation repair must pass schedule gate and repair lock"],
];

const CONSOLIDATION_CLUSTERS: ConsolidationCluster[] = [
  {
    id: "architecture_supervision_cluster",
    philosophy:
      "god-view, head-tail, flow-graph, context recovery, and doctor are one supervision stack",
    ownerScenario: "compressed_context_recovery_waterflow",
    ownerNode: "mind_model",
    sameClassTerms: [
      "lcx-mind-model",
      "lcx-flow-graph",
      "lcx-head-tail-consistency",
      "lcx-system-doctor",
    ],
    mergeFilters: ["same_philosophy_merge_required", "single_owner_required"],
  },
  {
    id: "learning_internalization_cluster",
    philosophy:
      "source storage, capability cards, retrieval, apply, eval, and review are one learning chain",
    ownerScenario: "module_learning_internalization_waterflow",
    ownerNode: "module_learning_review",
    sameClassTerms: [
      "module_learning_pipeline_plan",
      "module_learning_pipeline_review",
      "evalAbsorbed",
    ],
    mergeFilters: ["stored_only_is_not_learning", "retrieval_apply_eval_review_required"],
  },
  {
    id: "dev_live_evidence_cluster",
    philosophy: "dev-ready, live-runtime-updated, and live-user-seen are one boundary model",
    ownerScenario: "dev_to_live_lark_waterflow",
    ownerNode: "live_migration",
    sameClassTerms: ["dev-ready", "live-runtime-updated", "live-user-seen"],
    mergeFilters: ["dev_ready_not_live_user_seen", "real_lark_inbound_required"],
  },
  {
    id: "automation_digest_cluster",
    philosophy:
      "operator loop, cleanup, doctor, training plan, and digest must produce one local truth",
    ownerScenario: "local_automation_digest_waterflow",
    ownerNode: "operator_latest_receipt",
    sameClassTerms: [
      "lcx-local-operator-loop",
      "LCX Agent Operator Digest",
      "lcx-local-operator-latest",
    ],
    mergeFilters: ["single_digest_only", "error_receipt_required"],
  },
  {
    id: "external_skill_learning_cluster",
    philosophy:
      "external agent and skill ideas are learned as bounded workflow patterns, not installed authority",
    ownerScenario: "external_agent_skill_distillation_waterflow",
    ownerNode: "workflow_distillation",
    sameClassTerms: ["skill_pattern_distillation", "agent_workflow_memory", "license"],
    mergeFilters: ["license_scope_required", "untrusted_source_isolation"],
  },
  {
    id: "finance_data_quality_cluster",
    philosophy:
      "market data APIs, fundamentals APIs, official sources, and model-visible finance numbers are one provenance contract",
    ownerScenario: "finance_data_gateway_waterflow",
    ownerNode: "finance_data_gateway",
    sameClassTerms: [
      "finance_data_gateway_snapshot",
      "data_provenance_quality",
      "fresh_market_data",
    ],
    mergeFilters: [
      "fresh_timestamp_required",
      "field_definition_required",
      "three_source_reconciliation_required",
      "conflicted_data_blocks_conclusion",
    ],
  },
];

const SURFACE_FILES: Record<SurfaceGroup, readonly string[]> = {
  head: ["AGENTS.md", "README.md", "ops/local-brain/README.md", "src/agents/system-prompt.ts"],
  workflow: [
    "scripts/dev/lcx-flow-graph.ts",
    "scripts/dev/lcx-mind-model.ts",
    "scripts/dev/lcx-head-tail-consistency.ts",
    "scripts/dev/lcx-context-recovery-exam.ts",
    "scripts/dev/lcx-system-doctor.ts",
    "scripts/dev/finance-data-gateway-smoke.ts",
    "scripts/dev/local-brain-training-plan.ts",
    "scripts/dev/local-brain-distill-eval.ts",
    "scripts/dev/minimax-brain-training-guard.ts",
    "scripts/dev/minimax-brain-teacher-batch.ts",
    "scripts/dev/module-learning-pipeline-plan.ts",
    "scripts/dev/module-learning-pipeline-review.ts",
    "scripts/dev/lcx-promote-live.ts",
    "src/commands/capabilities/lark-loop-diagnose.ts",
    "src/agents/finance-data-gateway.ts",
    "src/agents/tools/finance-data-gateway-tool.ts",
  ],
  proof: [
    "scripts/dev/lcx-flow-graph.ts",
    "test/lcx-flow-graph.test.ts",
    "test/lcx-mind-model.test.ts",
    "test/lcx-context-recovery-exam.test.ts",
    "test/local-brain-distill-eval.test.ts",
    "test/local-brain-contracts.test.ts",
    "test/lcx-promote-live-status.test.ts",
  ],
  boundary: [
    "AGENTS.md",
    "README.md",
    "ops/local-brain/README.md",
    "scripts/dev/lcx-flow-graph.ts",
    "scripts/dev/lcx-promote-live.ts",
    "scripts/dev/local-brain-training-plan.ts",
    "src/agents/tools/module-learning-pipeline-review-tool.ts",
  ],
};

const SURFACE_TERMS: Record<SurfaceGroup, string[]> = {
  head: ["LCX Agent Flow Graph", "waterflow", "wrong-flow", "filter valve", "bounded feedback"],
  workflow: ["FLOW_SCENARIOS", "requiredFilters", "feedbackEdges", "ILLEGAL_EDGES"],
  proof: ["flow_graph_exam", "missingRequiredFilters", "test/lcx-flow-graph.test.ts"],
  boundary: [
    "dev_flow_graph_only",
    "liveTouched",
    "providerConfigTouched",
    "protectedMemoryTouched",
    "same_philosophy_merge_required",
  ],
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-flow-graph.ts [--json]",
      "",
      "Read-only LCX Agent flow graph exam. It checks that task waterflows pass",
      "through required nodes, filters, receipts, and bounded feedback gates.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]) {
  const options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function edgeKey(edge: readonly [string, string]): string {
  return `${edge[0]}->${edge[1]}`;
}

function hasPath(
  edges: ReadonlyArray<readonly [FlowNodeId, FlowNodeId]>,
  start: FlowNodeId,
  end: FlowNodeId,
) {
  const nextByNode = new Map<FlowNodeId, FlowNodeId[]>();
  for (const [from, to] of edges) {
    nextByNode.set(from, [...(nextByNode.get(from) ?? []), to]);
  }
  const queue = [start];
  const seen = new Set<FlowNodeId>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === end) {
      return true;
    }
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    queue.push(...(nextByNode.get(node) ?? []));
  }
  return false;
}

async function readText(file: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, file), "utf8").catch(() => "");
}

async function joinedSurfaceText(files: readonly string[]): Promise<string> {
  const chunks = await Promise.all(files.map((file) => readText(file)));
  return chunks.join("\n").replace(/\s+/gu, " ").toLowerCase();
}

async function missingSurfaceFiles(): Promise<string[]> {
  const files = Object.values(SURFACE_FILES).flat();
  const statuses = await Promise.all(
    files.map(async (file) => {
      try {
        await fs.access(path.join(repoRoot, file));
        return undefined;
      } catch {
        return file;
      }
    }),
  );
  return statuses.filter((file): file is string => typeof file === "string");
}

function surfaceTermCheck(surfaceTexts: Record<SurfaceGroup, string>): FlowCheck {
  const missing = Object.entries(SURFACE_TERMS).flatMap(([surface, terms]) =>
    terms
      .filter((term) => !surfaceTexts[surface as SurfaceGroup].includes(term.toLowerCase()))
      .map((term) => `${surface}:${term}`),
  );
  return {
    id: "flow_graph_surface_terms_present",
    ok: missing.length === 0,
    summary:
      "macro doctrine, workflow code, proof tests, and boundaries must all name flow graph contracts",
    evidence: { missing },
  };
}

function graphIntegrityCheck(): FlowCheck {
  const nodeSet = new Set(NODE_IDS);
  const missingNodes = FLOW_SCENARIOS.flatMap((scenario) =>
    [...scenario.requiredNodes, scenario.start, scenario.end]
      .filter((node) => !nodeSet.has(node))
      .map((node) => `${scenario.id}:${node}`),
  );
  const invalidEdges = FLOW_SCENARIOS.flatMap((scenario) =>
    [...scenario.edges, ...(scenario.feedbackEdges ?? [])]
      .filter(([from, to]) => !nodeSet.has(from) || !nodeSet.has(to))
      .map(([from, to]) => `${scenario.id}:${from}->${to}`),
  );
  const disconnected = FLOW_SCENARIOS.filter(
    (scenario) => !hasPath(scenario.edges, scenario.start, scenario.end),
  ).map((scenario) => scenario.id);
  return {
    id: "flow_graph_integrity",
    ok: missingNodes.length === 0 && invalidEdges.length === 0 && disconnected.length === 0,
    summary:
      "each waterflow must have known nodes, valid edges, and a path from intake to terminal node",
    evidence: { missingNodes, invalidEdges, disconnected },
  };
}

function filterCoverageCheck(): FlowCheck {
  const filterSet = new Set(FILTER_IDS);
  const missingRequiredFilters = FLOW_SCENARIOS.flatMap((scenario) =>
    scenario.requiredFilters
      .filter((filter) => !filterSet.has(filter))
      .map((filter) => `${scenario.id}:${filter}`),
  );
  const unfilteredScenarios = FLOW_SCENARIOS.filter(
    (scenario) => scenario.requiredFilters.length === 0,
  ).map((scenario) => scenario.id);
  return {
    id: "flow_graph_filters_required",
    ok: missingRequiredFilters.length === 0 && unfilteredScenarios.length === 0,
    summary: "every task waterflow must pass explicit filter valves",
    evidence: { missingRequiredFilters, unfilteredScenarios },
  };
}

function feedbackCheck(): FlowCheck {
  const unbounded = FLOW_SCENARIOS.filter(
    (scenario) =>
      (scenario.feedbackEdges?.length ?? 0) > 0 &&
      !scenario.requiredFilters.some((filter) =>
        [
          "training_overlap_guard",
          "retrieval_apply_eval_review_required",
          "fresh_operator_state_required",
          "source_evidence_gate",
          "three_source_reconciliation_required",
          "conflicted_data_blocks_conclusion",
          "reply_flow_audit_required",
          "provider_evidence_required",
          "same_philosophy_merge_required",
          "license_scope_required",
          "repair_lock_required",
        ].includes(filter),
      ),
  ).map((scenario) => scenario.id);
  return {
    id: "flow_graph_feedback_is_bounded",
    ok: unbounded.length === 0,
    summary: "feedback loops must have a guard that prevents infinite or unsafe recirculation",
    evidence: { unbounded },
  };
}

function illegalEdgeCheck(): FlowCheck {
  const actualEdges = new Set(
    FLOW_SCENARIOS.flatMap((scenario) => [
      ...scenario.edges.map(edgeKey),
      ...(scenario.feedbackEdges ?? []).map(edgeKey),
    ]),
  );
  const present = ILLEGAL_EDGES.filter(([from, to]) => actualEdges.has(`${from}->${to}`)).map(
    ([from, to, reason]) => `${from}->${to}: ${reason}`,
  );
  return {
    id: "flow_graph_illegal_shortcuts_absent",
    ok: present.length === 0,
    summary: "water must not skip required gates through known illegal shortcuts",
    evidence: { present },
  };
}

function receiptCheck(): FlowCheck {
  const missingReceipts = FLOW_SCENARIOS.flatMap((scenario) =>
    scenario.receipts.length === 0 ? [scenario.id] : [],
  );
  return {
    id: "flow_graph_receipts_required",
    ok: missingReceipts.length === 0,
    summary: "each waterflow must leave at least one receipt or proof surface",
    evidence: { missingReceipts },
  };
}

function consolidationClusterCheck(surfaceTexts: Record<SurfaceGroup, string>): FlowCheck {
  const scenarioIds = new Set(FLOW_SCENARIOS.map((scenario) => scenario.id));
  const nodeIds = new Set(NODE_IDS);
  const filterIds = new Set(FILTER_IDS);
  const missing = CONSOLIDATION_CLUSTERS.flatMap((cluster) => {
    const problems: string[] = [];
    if (!scenarioIds.has(cluster.ownerScenario)) {
      problems.push(`${cluster.id}:missing_owner_scenario:${cluster.ownerScenario}`);
    }
    if (!nodeIds.has(cluster.ownerNode)) {
      problems.push(`${cluster.id}:missing_owner_node:${cluster.ownerNode}`);
    }
    for (const filter of cluster.mergeFilters) {
      if (!filterIds.has(filter)) {
        problems.push(`${cluster.id}:missing_merge_filter:${filter}`);
      }
    }
    for (const term of cluster.sameClassTerms) {
      const lower = term.toLowerCase();
      if (!surfaceTexts.head.includes(lower) && !surfaceTexts.workflow.includes(lower)) {
        problems.push(`${cluster.id}:missing_same_class_term:${term}`);
      }
    }
    return problems;
  });
  return {
    id: "flow_graph_consolidation_clusters_merged",
    ok: missing.length === 0,
    summary:
      "same-philosophy mechanisms must name one owner scenario, one owner node, and merge filters instead of becoming parallel systems",
    evidence: { clusters: CONSOLIDATION_CLUSTERS.length, missing },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [head, workflow, proof, boundary, missingFiles] = await Promise.all([
    joinedSurfaceText(SURFACE_FILES.head),
    joinedSurfaceText(SURFACE_FILES.workflow),
    joinedSurfaceText(SURFACE_FILES.proof),
    joinedSurfaceText(SURFACE_FILES.boundary),
    missingSurfaceFiles(),
  ]);
  const checks = [
    {
      id: "flow_graph_surfaces_readable",
      ok: missingFiles.length === 0,
      summary: "flow graph surfaces must exist before they can supervise task routing",
      evidence: { missingFiles },
    },
    surfaceTermCheck({ head, workflow, proof, boundary }),
    graphIntegrityCheck(),
    filterCoverageCheck(),
    feedbackCheck(),
    illegalEdgeCheck(),
    receiptCheck(),
    consolidationClusterCheck({ head, workflow, proof, boundary }),
  ];
  const failed = checks.filter((check) => !check.ok);
  const result = {
    ok: failed.length === 0,
    boundary: "dev_flow_graph_only",
    checkedAt: new Date().toISOString(),
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      total: checks.length,
      scenarios: FLOW_SCENARIOS.length,
      nodes: NODE_IDS.length,
      filters: FILTER_IDS.length,
      consolidationClusters: CONSOLIDATION_CLUSTERS.length,
    },
    checks,
    scenarios: FLOW_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      family: scenario.family,
      objective: scenario.objective,
      start: scenario.start,
      end: scenario.end,
      requiredNodeCount: scenario.requiredNodes.length,
      requiredFilters: scenario.requiredFilters,
      feedbackEdgeCount: scenario.feedbackEdges?.length ?? 0,
      receipts: scenario.receipts,
    })),
    consolidationClusters: CONSOLIDATION_CLUSTERS,
    actionableFailures: failed.map((check) => `${check.id}: ${check.summary}`),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `lcx flow graph ${result.ok ? "ok" : "failed"}`,
          `passed=${result.summary.passed} failed=${result.summary.failed} total=${result.summary.total} scenarios=${result.summary.scenarios}`,
          ...result.actionableFailures.map((failure) => `- ${failure}`),
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
