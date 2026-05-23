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
  | "module_learning_absorption_gate"
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
  | "governance_autopilot"
  | "automation_cleanup"
  | "system_doctor"
  | "operator_latest_receipt"
  | "operator_digest"
  | "language_router"
  | "display_text_normalizer"
  | "answer_audit_budget"
  | "visible_answer_adoption_gate"
  | "model_candidate_answer"
  | "local_contract_audit"
  | "reply_flow_audit"
  | "readability_review"
  | "provider_evidence"
  | "model_council"
  | "provider_boundary"
  | "source_conflict_review"
  | "memory_recall"
  | "system_memory_sedimentation_gate"
  | "memory_write_gate"
  | "correction_note"
  | "stale_memory_downrank"
  | "prior_work_search"
  | "similar_mechanism_merge"
  | "single_owner_contract"
  | "parallel_path_reject"
  | "external_agent_source"
  | "external_upgrade_radar"
  | "license_scope_review"
  | "workflow_distillation"
  | "local_skill_candidate"
  | "acceptance_eval"
  | "commercial_acceptance_harness"
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
  | "per_receipt_absorption_evidence_required"
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
  | "no_internal_runtime_details_visible"
  | "bounded_answer_review"
  | "candidate_answer_not_final_authority"
  | "qwen_challenger_not_final_authority"
  | "qwen_challenge_patch_only"
  | "terminal_decision_required"
  | "model_rewrite_budget_required"
  | "no_raw_json_visible_reply"
  | "reply_flow_audit_required"
  | "provider_evidence_required"
  | "no_provider_config_change"
  | "source_conflict_visible"
  | "fresh_timestamp_required"
  | "field_definition_required"
  | "three_source_reconciliation_required"
  | "conflicted_data_blocks_conclusion"
  | "memory_write_freshness_gate"
  | "system_memory_not_module_learning"
  | "correction_note_required"
  | "prior_work_reuse_required"
  | "same_philosophy_merge_required"
  | "single_owner_required"
  | "license_scope_required"
  | "untrusted_source_isolation"
  | "human_signoff_checkpoint"
  | "commercial_error_budget_required"
  | "product_canary_suite_required"
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

type ConsolidatedEntrypointFamily = {
  id: string;
  ownerCluster: string;
  ownerPath: string;
  watchedPathTerms: readonly string[];
  allowedPaths: readonly string[];
};

type SharedEntrypointOwner = {
  path: string;
  familyIds: readonly string[];
  reason: string;
};

type FlowDiagnosticIndexEntry = {
  scenarioId: string;
  family: string;
  detects: string;
  ownerEntrypoint: string;
  fastCheck: string;
  requiredFilters: FlowFilterId[];
  evidenceReceipts: string[];
  failureSignals: string[];
  boundary: "dev_flow_graph_only";
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
  "module_learning_absorption_gate",
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
  "governance_autopilot",
  "automation_cleanup",
  "system_doctor",
  "operator_latest_receipt",
  "operator_digest",
  "language_router",
  "display_text_normalizer",
  "answer_audit_budget",
  "visible_answer_adoption_gate",
  "model_candidate_answer",
  "local_contract_audit",
  "reply_flow_audit",
  "readability_review",
  "provider_evidence",
  "model_council",
  "provider_boundary",
  "source_conflict_review",
  "memory_recall",
  "system_memory_sedimentation_gate",
  "memory_write_gate",
  "correction_note",
  "stale_memory_downrank",
  "prior_work_search",
  "similar_mechanism_merge",
  "single_owner_contract",
  "parallel_path_reject",
  "external_agent_source",
  "external_upgrade_radar",
  "license_scope_review",
  "workflow_distillation",
  "local_skill_candidate",
  "acceptance_eval",
  "commercial_acceptance_harness",
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
  "per_receipt_absorption_evidence_required",
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
  "no_internal_runtime_details_visible",
  "bounded_answer_review",
  "candidate_answer_not_final_authority",
  "qwen_challenger_not_final_authority",
  "qwen_challenge_patch_only",
  "terminal_decision_required",
  "model_rewrite_budget_required",
  "no_raw_json_visible_reply",
  "reply_flow_audit_required",
  "provider_evidence_required",
  "no_provider_config_change",
  "source_conflict_visible",
  "fresh_timestamp_required",
  "field_definition_required",
  "three_source_reconciliation_required",
  "conflicted_data_blocks_conclusion",
  "memory_write_freshness_gate",
  "system_memory_not_module_learning",
  "correction_note_required",
  "prior_work_reuse_required",
  "same_philosophy_merge_required",
  "single_owner_required",
  "license_scope_required",
  "untrusted_source_isolation",
  "human_signoff_checkpoint",
  "commercial_error_budget_required",
  "product_canary_suite_required",
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
      "module_learning_absorption_gate",
      "module_learning_review",
      "keep_downrank_discard",
    ],
    requiredFilters: [
      "stored_only_is_not_learning",
      "protected_memory_guard",
      "language_corpus_separation",
      "retrieval_apply_eval_review_required",
      "per_receipt_absorption_evidence_required",
    ],
    edges: [
      ["source_intake", "source_registry"],
      ["source_registry", "actual_reading_scope"],
      ["actual_reading_scope", "capability_card"],
      ["capability_card", "retrieval_receipt"],
      ["retrieval_receipt", "apply_validation"],
      ["apply_validation", "local_brain_eval_absorption"],
      ["local_brain_eval_absorption", "module_learning_absorption_gate"],
      ["module_learning_absorption_gate", "module_learning_review"],
      ["module_learning_review", "keep_downrank_discard"],
    ],
    feedbackEdges: [["module_learning_review", "capability_card"]],
    receipts: [
      "module_learning_pipeline_plan",
      "module_learning_pipeline_review",
      "learning_sedimentation_bridge",
      "learning_sedimentation_audit",
      "learning_sedimentation_map",
      "module_learning_absorption_gate",
    ],
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
      "Local automation should gather cleanup, governance autopilot, doctor, training plan, mind model, flow graph, and context recovery into one latest receipt and one digest.",
    start: "local_operator_loop",
    end: "operator_digest",
    requiredNodes: [
      "local_operator_loop",
      "automation_cleanup",
      "governance_autopilot",
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
      ["automation_cleanup", "governance_autopilot"],
      ["governance_autopilot", "system_doctor"],
      ["system_doctor", "training_plan"],
      ["training_plan", "mind_model"],
      ["mind_model", "flow_graph"],
      ["flow_graph", "operator_latest_receipt"],
      ["operator_latest_receipt", "operator_digest"],
    ],
    receipts: [
      "lcx-local-operator-loop",
      "lcx-governance-autopilot-latest",
      "lcx-local-operator-latest",
      "LCX Agent Operator Digest",
    ],
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
      "answer_audit_budget",
      "display_text_normalizer",
      "readability_review",
      "visible_answer_adoption_gate",
      "reply_flow_audit",
      "visible_reply",
    ],
    requiredFilters: [
      "visible_text_no_internal_labels",
      "no_internal_runtime_details_visible",
      "bounded_answer_review",
      "reply_flow_audit_required",
      "dev_ready_not_live_user_seen",
    ],
    edges: [
      ["ingress_lark_feishu", "intent_classifier"],
      ["intent_classifier", "language_router"],
      ["language_router", "local_brain_planner"],
      ["local_brain_planner", "control_room_summary"],
      ["control_room_summary", "answer_audit_budget"],
      ["answer_audit_budget", "display_text_normalizer"],
      ["display_text_normalizer", "readability_review"],
      ["readability_review", "visible_answer_adoption_gate"],
      ["visible_answer_adoption_gate", "reply_flow_audit"],
      ["reply_flow_audit", "visible_reply"],
    ],
    feedbackEdges: [["readability_review", "display_text_normalizer"]],
    receipts: [
      "lark-language-handoff-receipt",
      "lark-context-packet",
      "feishu-reply-flow",
      "normalizeFeishuDisplayText",
      "lark-loop-diagnose",
    ],
  },
  {
    id: "commercial_answer_pipeline_waterflow",
    family: "commercial_answer_adoption_and_failed_reason",
    objective:
      "A user-facing answer must move from language intake through planning, evidence gates, bounded local/Qwen/model review, and a terminal adoption gate instead of looping forever or treating a model answer as final authority.",
    start: "ingress_lark_feishu",
    end: "visible_reply",
    requiredNodes: [
      "ingress_lark_feishu",
      "intent_classifier",
      "local_brain_planner",
      "model_council",
      "provider_evidence",
      "model_candidate_answer",
      "answer_audit_budget",
      "local_contract_audit",
      "review_panel",
      "visible_answer_adoption_gate",
      "control_room_summary",
      "reply_flow_audit",
      "visible_reply",
    ],
    requiredFilters: [
      "bounded_answer_review",
      "candidate_answer_not_final_authority",
      "provider_evidence_required",
      "qwen_challenger_not_final_authority",
      "qwen_challenge_patch_only",
      "model_rewrite_budget_required",
      "terminal_decision_required",
      "visible_text_no_internal_labels",
      "no_internal_runtime_details_visible",
      "no_raw_json_visible_reply",
      "source_evidence_gate",
      "stored_only_is_not_learning",
      "retrieval_apply_eval_review_required",
      "no_trade_advice",
      "no_unverified_current_market_data",
      "reply_flow_audit_required",
    ],
    edges: [
      ["ingress_lark_feishu", "intent_classifier"],
      ["intent_classifier", "local_brain_planner"],
      ["local_brain_planner", "model_council"],
      ["model_council", "provider_evidence"],
      ["provider_evidence", "model_candidate_answer"],
      ["model_candidate_answer", "answer_audit_budget"],
      ["answer_audit_budget", "local_contract_audit"],
      ["local_contract_audit", "review_panel"],
      ["review_panel", "visible_answer_adoption_gate"],
      ["visible_answer_adoption_gate", "control_room_summary"],
      ["control_room_summary", "reply_flow_audit"],
      ["reply_flow_audit", "visible_reply"],
    ],
    feedbackEdges: [
      ["review_panel", "model_candidate_answer"],
      ["local_contract_audit", "local_brain_planner"],
    ],
    receipts: [
      "commercial_answer_pipeline",
      "lark_language_handoff_receipt",
      "lark_context_packet",
      "review_panel",
      "feishu-reply-flow",
    ],
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
    id: "commercial_acceptance_harness_waterflow",
    family: "commercial_product_acceptance_gate",
    objective:
      "Commercial acceptance must grade real product readiness by consuming existing owner outputs, error budgets, and live canaries instead of fixing isolated red dots or becoming a new truth owner.",
    start: "local_operator_loop",
    end: "acceptance_eval",
    requiredNodes: [
      "local_operator_loop",
      "system_doctor",
      "training_plan",
      "mind_model",
      "flow_graph",
      "commercial_acceptance_harness",
      "answer_audit_budget",
      "live_migration",
      "build_restart_probe",
      "real_lark_inbound",
      "live_user_seen",
      "acceptance_eval",
    ],
    requiredFilters: [
      "commercial_error_budget_required",
      "product_canary_suite_required",
      "single_owner_required",
      "bounded_answer_review",
      "training_overlap_guard",
      "provider_evidence_required",
      "dev_ready_not_live_user_seen",
      "live_runtime_probe_required",
      "real_lark_inbound_required",
    ],
    edges: [
      ["local_operator_loop", "system_doctor"],
      ["system_doctor", "training_plan"],
      ["training_plan", "mind_model"],
      ["mind_model", "flow_graph"],
      ["flow_graph", "commercial_acceptance_harness"],
      ["commercial_acceptance_harness", "answer_audit_budget"],
      ["commercial_acceptance_harness", "live_migration"],
      ["live_migration", "build_restart_probe"],
      ["build_restart_probe", "real_lark_inbound"],
      ["real_lark_inbound", "live_user_seen"],
      ["live_user_seen", "acceptance_eval"],
      ["answer_audit_budget", "acceptance_eval"],
    ],
    feedbackEdges: [
      ["acceptance_eval", "commercial_acceptance_harness"],
      ["commercial_acceptance_harness", "training_plan"],
    ],
    receipts: [
      "commercial_acceptance_harness",
      "commercial_answer_pipeline",
      "lcx-problem-cluster-radar",
      "live-promotion",
      "feishu-reply-flow",
    ],
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
      "system_memory_sedimentation_gate",
      "source_registry",
      "source_conflict_review",
      "memory_write_gate",
      "correction_note",
      "stale_memory_downrank",
      "review_panel",
    ],
    requiredFilters: [
      "memory_write_freshness_gate",
      "system_memory_not_module_learning",
      "correction_note_required",
      "protected_memory_guard",
      "source_evidence_gate",
    ],
    edges: [
      ["memory_recall", "system_memory_sedimentation_gate"],
      ["system_memory_sedimentation_gate", "source_registry"],
      ["source_registry", "source_conflict_review"],
      ["source_conflict_review", "memory_write_gate"],
      ["memory_write_gate", "correction_note"],
      ["correction_note", "stale_memory_downrank"],
      ["stale_memory_downrank", "review_panel"],
    ],
    feedbackEdges: [["review_panel", "memory_recall"]],
    receipts: [
      "system_memory_sedimentation_gate",
      "correction_note",
      "stale_memory_rule_downrank",
      "review_panel",
    ],
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
    id: "senior_trader_failure_focus_waterflow",
    family: "senior_trader_promotion_failure_closure",
    objective:
      "Promotion failure families for senior-trader reasoning must flow through source, finance data gateway, module capability, retrieval/apply, eval/training, promotion gate, and review instead of being patched as isolated examples.",
    start: "source_intake",
    end: "control_room_summary",
    requiredNodes: [
      "source_intake",
      "source_registry",
      "finance_data_gateway",
      "data_provenance_quality_review",
      "capability_card",
      "retrieval_receipt",
      "apply_validation",
      "local_brain_eval_absorption",
      "failure_curriculum",
      "teacher_quota",
      "brain_distillation_review",
      "dataset_builder",
      "qwen_training",
      "hardened_eval",
      "promotion_gate",
      "review_panel",
      "control_room_summary",
    ],
    requiredFilters: [
      "source_evidence_gate",
      "fresh_timestamp_required",
      "field_definition_required",
      "no_unverified_current_market_data",
      "retrieval_apply_eval_review_required",
      "parse_recovered_no_promotion",
      "promotion_ready_required",
      "no_trade_advice",
    ],
    edges: [
      ["source_intake", "source_registry"],
      ["source_registry", "finance_data_gateway"],
      ["finance_data_gateway", "data_provenance_quality_review"],
      ["data_provenance_quality_review", "capability_card"],
      ["capability_card", "retrieval_receipt"],
      ["retrieval_receipt", "apply_validation"],
      ["apply_validation", "local_brain_eval_absorption"],
      ["local_brain_eval_absorption", "failure_curriculum"],
      ["failure_curriculum", "teacher_quota"],
      ["teacher_quota", "brain_distillation_review"],
      ["brain_distillation_review", "dataset_builder"],
      ["dataset_builder", "qwen_training"],
      ["qwen_training", "hardened_eval"],
      ["hardened_eval", "promotion_gate"],
      ["promotion_gate", "review_panel"],
      ["review_panel", "control_room_summary"],
    ],
    feedbackEdges: [
      ["review_panel", "failure_curriculum"],
      ["review_panel", "finance_data_gateway"],
    ],
    receipts: [
      "local-brain-distill-eval",
      "minimax-brain-training-guard",
      "finance-data-gateway",
      "review_panel",
    ],
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
      "external_upgrade_radar",
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
      ["actual_reading_scope", "external_upgrade_radar"],
      ["external_upgrade_radar", "workflow_distillation"],
      ["workflow_distillation", "local_skill_candidate"],
      ["local_skill_candidate", "review_panel"],
      ["review_panel", "acceptance_eval"],
    ],
    feedbackEdges: [["acceptance_eval", "workflow_distillation"]],
    receipts: [
      "lcx-external-agent-upgrade-radar",
      "skill_pattern_distillation",
      "agent_workflow_memory",
      "local-brain-distill-eval",
    ],
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
      "lcx-learning-sedimentation-bridge",
      "lcx-learning-sedimentation-audit",
      "lcx-learning-sedimentation-map",
      "lcx-module-learning-absorption-gate",
      "lcx-system-memory-sedimentation-gate",
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
    id: "commercial_answer_pipeline_cluster",
    philosophy:
      "model answer, Qwen challenge, local audit, review panel, and visible reply adoption are one bounded answer pipeline",
    ownerScenario: "commercial_answer_pipeline_waterflow",
    ownerNode: "answer_audit_budget",
    sameClassTerms: [
      "commercial answer pipeline",
      "answer audit",
      "model_candidate_not_final_authority",
      "challenger_only_not_final_authority",
      "challenge_patch_only",
      "terminalDecision",
      "failedReason",
    ],
    mergeFilters: [
      "candidate_answer_not_final_authority",
      "qwen_challenger_not_final_authority",
      "qwen_challenge_patch_only",
      "terminal_decision_required",
      "bounded_answer_review",
    ],
  },
  {
    id: "commercial_acceptance_harness_cluster",
    philosophy:
      "commercial acceptance is one product-grade exam that consumes owner outputs, error budgets, and live canaries without replacing those owners",
    ownerScenario: "commercial_acceptance_harness_waterflow",
    ownerNode: "commercial_acceptance_harness",
    sameClassTerms: [
      "commercial acceptance harness",
      "product canary",
      "error budget",
      "readyForCommercialRelease",
      "post_migration_lark_canary",
    ],
    mergeFilters: [
      "commercial_error_budget_required",
      "product_canary_suite_required",
      "single_owner_required",
    ],
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
    ownerNode: "external_upgrade_radar",
    sameClassTerms: [
      "lcx-external-agent-upgrade-radar",
      "skill_pattern_distillation",
      "agent_workflow_memory",
      "license",
    ],
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
  {
    id: "senior_trader_failure_focus_cluster",
    philosophy:
      "senior-trader promotion failures are one source-to-review learning loop, not eleven isolated prompt patches",
    ownerScenario: "senior_trader_failure_focus_waterflow",
    ownerNode: "failure_curriculum",
    sameClassTerms: [
      "senior_trader_failure_focus_promotion_chain",
      "promotion failure focus",
      "candidate failed case",
    ],
    mergeFilters: [
      "retrieval_apply_eval_review_required",
      "parse_recovered_no_promotion",
      "promotion_ready_required",
    ],
  },
];

const CONSOLIDATED_ENTRYPOINT_FAMILIES: ConsolidatedEntrypointFamily[] = [
  {
    id: "architecture_supervision_entrypoints",
    ownerCluster: "architecture_supervision_cluster",
    ownerPath: "scripts/dev/lcx-mind-model.ts",
    watchedPathTerms: [
      "lcx-mind-model",
      "lcx-flow-graph",
      "lcx-head-tail-consistency",
      "lcx-context-recovery-exam",
      "lcx-problem-cluster-radar",
      "lcx-change-impact-plan",
      "lcx-governance-autopilot",
      "lcx-live-lark-brain-binding",
      "lcx-system-doctor",
      "lcx-agent-exam",
    ],
    allowedPaths: [
      "scripts/dev/lcx-agent-exam.ts",
      "scripts/dev/lcx-change-impact-plan.ts",
      "scripts/dev/lcx-context-recovery-exam.ts",
      "scripts/dev/lcx-flow-graph.ts",
      "scripts/dev/lcx-governance-autopilot.ts",
      "scripts/dev/lcx-head-tail-consistency.ts",
      "scripts/dev/lcx-live-lark-brain-binding.ts",
      "scripts/dev/lcx-mind-model.ts",
      "scripts/dev/lcx-problem-cluster-radar.ts",
      "scripts/dev/lcx-system-doctor.ts",
      "test/lcx-agent-exam.test.ts",
      "test/lcx-change-impact-plan.test.ts",
      "test/lcx-context-recovery-exam.test.ts",
      "test/lcx-flow-graph.test.ts",
      "test/lcx-governance-autopilot.test.ts",
      "test/lcx-head-tail-consistency.test.ts",
      "test/lcx-live-lark-brain-binding.test.ts",
      "test/lcx-mind-model.test.ts",
      "test/lcx-problem-cluster-radar.test.ts",
      "test/lcx-system-doctor-train-slice.test.ts",
    ],
  },
  {
    id: "learning_sedimentation_entrypoints",
    ownerCluster: "learning_internalization_cluster",
    ownerPath: "scripts/dev/module-learning-pipeline-review.ts",
    watchedPathTerms: ["module-learning", "learning-sedimentation", "system-memory-sedimentation"],
    allowedPaths: [
      "scripts/dev/lcx-learning-sedimentation-audit.ts",
      "scripts/dev/lcx-learning-sedimentation-bridge.ts",
      "scripts/dev/lcx-learning-sedimentation-map.ts",
      "scripts/dev/lcx-module-learning-absorption-gate.ts",
      "scripts/dev/lcx-system-memory-sedimentation-gate.ts",
      "scripts/dev/module-learning-pipeline-plan.ts",
      "scripts/dev/module-learning-pipeline-review.ts",
      "src/agents/openclaw-tools.module-learning-pipeline-plan-registration.test.ts",
      "src/agents/tools/module-learning-pipeline-plan-tool.test.ts",
      "src/agents/tools/module-learning-pipeline-plan-tool.ts",
      "src/agents/tools/module-learning-pipeline-review-tool.test.ts",
      "src/agents/tools/module-learning-pipeline-review-tool.ts",
      "test/lcx-learning-sedimentation-audit.test.ts",
      "test/lcx-learning-sedimentation-bridge.test.ts",
      "test/lcx-learning-sedimentation-map.test.ts",
      "test/lcx-module-learning-absorption-gate.test.ts",
      "test/lcx-system-memory-sedimentation-gate.test.ts",
      "test/module-learning-pipeline-plan-cli.test.ts",
      "test/module-learning-pipeline-review-cli.test.ts",
    ],
  },
  {
    id: "lark_visible_reply_audit_entrypoints",
    ownerCluster: "commercial_answer_pipeline_cluster",
    ownerPath: "src/commands/capabilities/lark-loop-diagnose.ts",
    watchedPathTerms: [
      "lark-context-packet",
      "lark-language-handoff",
      "reply-flow-audit",
      "feishu-reply-flow-evidence",
      "lark-loop-diagnose",
      "commercial-answer",
      "visible-answer-adoption",
      "skill-autocue",
    ],
    allowedPaths: [
      "extensions/feishu/src/lark-context-packet.test.ts",
      "extensions/feishu/src/lark-context-packet.ts",
      "extensions/feishu/src/lark-language-handoff-receipts.test.ts",
      "extensions/feishu/src/lark-language-handoff-receipts.ts",
      "extensions/feishu/src/reply-flow-audit.ts",
      "extensions/feishu/src/visible-answer-adoption-gate.test.ts",
      "extensions/feishu/src/visible-answer-adoption-gate.ts",
      "src/auto-reply/reply/feishu-reply-flow-evidence.test.ts",
      "src/auto-reply/reply/feishu-reply-flow-evidence.ts",
      "src/auto-reply/reply/skill-autocue.test.ts",
      "src/auto-reply/reply/skill-autocue.ts",
      "scripts/dev/lcx-commercial-answer-pipeline.ts",
      "src/commands/capabilities.lark-loop-diagnose.test.ts",
      "src/commands/capabilities/lark-loop-diagnose.ts",
      "test/lcx-commercial-answer-pipeline.test.ts",
    ],
  },
  {
    id: "commercial_acceptance_harness_entrypoints",
    ownerCluster: "commercial_acceptance_harness_cluster",
    ownerPath: "scripts/dev/lcx-commercial-acceptance-harness.ts",
    watchedPathTerms: ["commercial-acceptance", "commercial_acceptance", "product-canary"],
    allowedPaths: [
      "scripts/dev/lcx-commercial-acceptance-harness.ts",
      "test/lcx-commercial-acceptance-harness.test.ts",
    ],
  },
  {
    id: "qwen_training_operation_entrypoints",
    ownerCluster: "senior_trader_failure_focus_cluster",
    ownerPath: "scripts/dev/local-brain-training-plan.ts",
    watchedPathTerms: [
      "local-brain-distill-eval",
      "local-brain-promotion-audit",
      "local-brain-training-plan",
      "minimax-brain-training-guard",
      "minimax-brain-teacher-batch",
      "minimax-quota-brain-saturator",
    ],
    allowedPaths: [
      "scripts/dev/local-brain-distill-eval.ts",
      "scripts/dev/local-brain-promotion-audit.ts",
      "scripts/dev/local-brain-training-plan.ts",
      "scripts/dev/minimax-brain-teacher-batch.ts",
      "scripts/dev/minimax-brain-training-guard.ts",
      "scripts/dev/minimax-quota-brain-saturator.ts",
      "test/local-brain-distill-eval.test.ts",
      "test/local-brain-promotion-audit.test.ts",
      "test/local-brain-training-plan.test.ts",
      "test/minimax-brain-teacher-batch.test.ts",
      "test/minimax-brain-training-guard.test.ts",
      "test/minimax-quota-brain-saturator-preview.test.ts",
    ],
  },
  {
    id: "dev_live_evidence_entrypoints",
    ownerCluster: "dev_live_evidence_cluster",
    ownerPath: "scripts/dev/lcx-promote-live.ts",
    watchedPathTerms: ["lcx-promote-live", "live-promotion", "lark-loop-diagnose"],
    allowedPaths: [
      "scripts/dev/lcx-promote-live.ts",
      "src/commands/capabilities.lark-loop-diagnose.test.ts",
      "src/commands/capabilities/lark-loop-diagnose.ts",
      "test/lcx-promote-live-status.test.ts",
    ],
  },
  {
    id: "automation_digest_entrypoints",
    ownerCluster: "automation_digest_cluster",
    ownerPath: "scripts/dev/lcx-automation-repair-lock.ts",
    watchedPathTerms: [
      "automation-repair",
      "codex-archive",
      "lcx-local-operator",
      "operator-digest",
    ],
    allowedPaths: [
      "scripts/dev/lcx-automation-repair-lock.ts",
      "test/lcx-automation-repair-lock.test.ts",
    ],
  },
  {
    id: "external_skill_learning_entrypoints",
    ownerCluster: "external_skill_learning_cluster",
    ownerPath: "scripts/dev/lcx-external-agent-upgrade-radar.ts",
    watchedPathTerms: [
      "agent-workflow",
      "external-agent-upgrade",
      "skill-pattern",
      "github-project-capability-intake",
    ],
    allowedPaths: [
      "scripts/dev/lcx-external-agent-upgrade-radar.ts",
      "test/lcx-external-agent-upgrade-radar.test.ts",
      "extensions/feishu/src/learning-council.test.ts",
      "extensions/feishu/src/learning-council.ts",
      "src/agents/openclaw-tools.github-project-capability-intake-registration.test.ts",
      "src/agents/tools/github-project-capability-intake-tool.test.ts",
      "src/agents/tools/github-project-capability-intake-tool.ts",
    ],
  },
  {
    id: "finance_data_quality_entrypoints",
    ownerCluster: "finance_data_quality_cluster",
    ownerPath: "src/agents/finance-data-gateway.ts",
    watchedPathTerms: [
      "finance-article-source-registry",
      "finance-data-gateway",
      "source-registry",
    ],
    allowedPaths: [
      "scripts/dev/finance-data-gateway-smoke.ts",
      "src/agents/finance-data-gateway.ts",
      "src/agents/openclaw-tools.finance-article-source-registry-registration.test.ts",
      "src/agents/openclaw-tools.finance-data-gateway-registration.test.ts",
      "src/agents/tools/finance-article-source-registry-inspect-tool.ts",
      "src/agents/tools/finance-article-source-registry-record-tool.ts",
      "src/agents/tools/finance-article-source-registry-tools.test.ts",
      "src/agents/tools/finance-data-gateway-tool.test.ts",
      "src/agents/tools/finance-data-gateway-tool.ts",
      "src/hooks/bundled/lobster-brain-registry.finance-article-source-registry.test.ts",
    ],
  },
];

const SHARED_ENTRYPOINT_OWNERS: SharedEntrypointOwner[] = [
  {
    path: "src/commands/capabilities/lark-loop-diagnose.ts",
    familyIds: ["dev_live_evidence_entrypoints", "lark_visible_reply_audit_entrypoints"],
    reason:
      "lark-loop-diagnose is the intentional bridge between visible reply audit and dev/live evidence.",
  },
  {
    path: "src/commands/capabilities.lark-loop-diagnose.test.ts",
    familyIds: ["dev_live_evidence_entrypoints", "lark_visible_reply_audit_entrypoints"],
    reason:
      "the lark-loop-diagnose test is the shared proof surface for visible reply audit and dev/live evidence.",
  },
];

const FLOW_DIAGNOSTIC_OWNER_BY_SCENARIO_ID: Record<string, string> = {
  lark_finance_research_waterflow: "src/commands/capabilities/lark-loop-diagnose.ts",
  module_learning_internalization_waterflow: "scripts/dev/module-learning-pipeline-review.ts",
  training_failure_feedback_waterflow: "scripts/dev/local-brain-training-plan.ts",
  dev_to_live_lark_waterflow: "scripts/dev/lcx-promote-live.ts",
  compressed_context_recovery_waterflow: "scripts/dev/lcx-context-recovery-exam.ts",
  local_automation_digest_waterflow: "scripts/dev/lcx-governance-autopilot.ts",
  lark_visible_language_waterflow: "src/commands/capabilities/lark-loop-diagnose.ts",
  commercial_answer_pipeline_waterflow: "scripts/dev/lcx-commercial-answer-pipeline.ts",
  commercial_acceptance_harness_waterflow: "scripts/dev/lcx-commercial-acceptance-harness.ts",
  provider_council_evidence_waterflow: "extensions/feishu/src/learning-council.ts",
  memory_correction_downrank_waterflow: "scripts/dev/lcx-system-memory-sedimentation-gate.ts",
  finance_data_gateway_waterflow: "src/agents/finance-data-gateway.ts",
  senior_trader_failure_focus_waterflow: "scripts/dev/local-brain-distill-eval.ts",
  similar_engineering_consolidation_waterflow: "scripts/dev/lcx-change-impact-plan.ts",
  external_agent_skill_distillation_waterflow: "scripts/dev/lcx-external-agent-upgrade-radar.ts",
  automation_repair_lock_waterflow: "scripts/dev/lcx-automation-repair-lock.ts",
};

const FLOW_DIAGNOSTIC_FAST_CHECK_BY_SCENARIO_ID: Record<string, string> = {
  lark_finance_research_waterflow: "node --import tsx scripts/dev/lcx-flow-graph.ts --json",
  module_learning_internalization_waterflow:
    "node --import tsx scripts/dev/module-learning-pipeline-review.ts --json",
  training_failure_feedback_waterflow:
    "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
  dev_to_live_lark_waterflow: "node --import tsx scripts/dev/lcx-promote-live.ts --status --json",
  compressed_context_recovery_waterflow:
    "node --import tsx scripts/dev/lcx-context-recovery-exam.ts --json",
  local_automation_digest_waterflow:
    "node --import tsx scripts/dev/lcx-governance-autopilot.ts --json",
  lark_visible_language_waterflow:
    "node --import tsx src/commands/capabilities/lark-loop-diagnose.ts --json",
  commercial_answer_pipeline_waterflow:
    "node --import tsx scripts/dev/lcx-commercial-answer-pipeline.ts --json",
  commercial_acceptance_harness_waterflow:
    "node --import tsx scripts/dev/lcx-commercial-acceptance-harness.ts --json",
  provider_council_evidence_waterflow: "node --import tsx scripts/dev/lcx-system-doctor.ts --json",
  memory_correction_downrank_waterflow:
    "node --import tsx scripts/dev/lcx-system-memory-sedimentation-gate.ts --json",
  finance_data_gateway_waterflow:
    "node --import tsx scripts/dev/finance-data-gateway-smoke.ts --json",
  senior_trader_failure_focus_waterflow:
    "node --import tsx scripts/dev/local-brain-distill-eval.ts --contract-only --case-id senior_trader_failure_focus_promotion_chain --summary-only --json",
  similar_engineering_consolidation_waterflow:
    "node --import tsx scripts/dev/lcx-change-impact-plan.ts --json",
  external_agent_skill_distillation_waterflow:
    "node --import tsx scripts/dev/lcx-external-agent-upgrade-radar.ts --json",
  automation_repair_lock_waterflow:
    "node --import tsx scripts/dev/lcx-automation-repair-lock.ts --mode status --json",
};

const SURFACE_FILES: Record<SurfaceGroup, readonly string[]> = {
  head: ["AGENTS.md", "README.md", "ops/local-brain/README.md", "src/agents/system-prompt.ts"],
  workflow: [
    "scripts/dev/lcx-flow-graph.ts",
    "scripts/dev/lcx-governance-autopilot.ts",
    "scripts/dev/lcx-mind-model.ts",
    "scripts/dev/lcx-live-lark-brain-binding.ts",
    "scripts/dev/lcx-head-tail-consistency.ts",
    "scripts/dev/lcx-context-recovery-exam.ts",
    "scripts/dev/lcx-system-doctor.ts",
    "scripts/dev/lcx-commercial-answer-pipeline.ts",
    "scripts/dev/lcx-commercial-acceptance-harness.ts",
    "scripts/dev/lcx-learning-sedimentation-bridge.ts",
    "scripts/dev/lcx-learning-sedimentation-audit.ts",
    "scripts/dev/lcx-learning-sedimentation-map.ts",
    "scripts/dev/lcx-module-learning-absorption-gate.ts",
    "scripts/dev/lcx-system-memory-sedimentation-gate.ts",
    "scripts/dev/finance-data-gateway-smoke.ts",
    "scripts/dev/local-brain-training-plan.ts",
    "scripts/dev/local-brain-distill-eval.ts",
    "scripts/dev/minimax-brain-training-guard.ts",
    "scripts/dev/minimax-brain-teacher-batch.ts",
    "scripts/dev/module-learning-pipeline-plan.ts",
    "scripts/dev/module-learning-pipeline-review.ts",
    "scripts/dev/lcx-promote-live.ts",
    "scripts/dev/lcx-live-lark-brain-binding.ts",
    "src/commands/capabilities/lark-loop-diagnose.ts",
    "src/agents/finance-data-gateway.ts",
    "src/agents/tools/finance-data-gateway-tool.ts",
  ],
  proof: [
    "scripts/dev/lcx-flow-graph.ts",
    "scripts/dev/lcx-governance-autopilot.ts",
    "test/lcx-flow-graph.test.ts",
    "test/lcx-governance-autopilot.test.ts",
    "test/lcx-mind-model.test.ts",
    "test/lcx-context-recovery-exam.test.ts",
    "test/lcx-commercial-answer-pipeline.test.ts",
    "test/lcx-commercial-acceptance-harness.test.ts",
    "test/lcx-learning-sedimentation-bridge.test.ts",
    "test/lcx-learning-sedimentation-audit.test.ts",
    "test/lcx-learning-sedimentation-map.test.ts",
    "test/lcx-module-learning-absorption-gate.test.ts",
    "test/lcx-system-memory-sedimentation-gate.test.ts",
    "test/local-brain-distill-eval.test.ts",
    "test/local-brain-contracts.test.ts",
    "test/lcx-promote-live-status.test.ts",
    "test/lcx-live-lark-brain-binding.test.ts",
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

function familyKey(familyIds: readonly string[]): string {
  return familyIds.toSorted().join(",");
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

async function listRepoFiles(relativeDir: string): Promise<string[]> {
  const root = path.join(repoRoot, relativeDir);
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(root, entry.name);
        const repoPath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
        if (entry.isDirectory()) {
          if ([".git", "coverage", "dist", "node_modules"].includes(entry.name)) {
            return [];
          }
          return listRepoFiles(repoPath);
        }
        return [repoPath];
      }),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

async function discoverCodeEntrypoints(): Promise<string[]> {
  const roots = ["scripts", "src", "extensions", "test"];
  const files = (await Promise.all(roots.map((root) => listRepoFiles(root)))).flat();
  return files.filter((file) => /\.(?:cts|js|mjs|mts|ts|tsx)$/u.test(file)).toSorted();
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
          "bounded_answer_review",
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

function buildFlowDiagnosticIndex(): FlowDiagnosticIndexEntry[] {
  return FLOW_SCENARIOS.map((scenario) => ({
    scenarioId: scenario.id,
    family: scenario.family,
    detects: scenario.objective,
    ownerEntrypoint:
      FLOW_DIAGNOSTIC_OWNER_BY_SCENARIO_ID[scenario.id] ?? "scripts/dev/lcx-flow-graph.ts",
    fastCheck:
      FLOW_DIAGNOSTIC_FAST_CHECK_BY_SCENARIO_ID[scenario.id] ??
      "node --import tsx scripts/dev/lcx-flow-graph.ts --json",
    requiredFilters: scenario.requiredFilters,
    evidenceReceipts: scenario.receipts,
    failureSignals: [
      ...scenario.requiredFilters.map((filter) => `missing_or_skipped_filter:${filter}`),
      ...scenario.receipts.map((receipt) => `missing_or_stale_receipt:${receipt}`),
      (scenario.feedbackEdges?.length ?? 0) > 0 ? "unbounded_or_unreviewed_feedback" : "",
    ].filter(Boolean),
    boundary: "dev_flow_graph_only",
  }));
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

async function consolidatedEntrypointCheck(): Promise<FlowCheck> {
  const files = await discoverCodeEntrypoints();
  const fileSet = new Set(files);
  const clusterIds = new Set(CONSOLIDATION_CLUSTERS.map((cluster) => cluster.id));
  const familyIds = new Set(CONSOLIDATED_ENTRYPOINT_FAMILIES.map((family) => family.id));
  const coveredClusterIds = new Set(
    CONSOLIDATED_ENTRYPOINT_FAMILIES.map((family) => family.ownerCluster),
  );
  const allowedSharedOwners = new Map(
    SHARED_ENTRYPOINT_OWNERS.map((owner) => [owner.path, familyKey(owner.familyIds)]),
  );
  const uncoveredClusters = CONSOLIDATION_CLUSTERS.filter(
    (cluster) => !coveredClusterIds.has(cluster.id),
  ).map((cluster) => cluster.id);
  const missing = CONSOLIDATED_ENTRYPOINT_FAMILIES.flatMap((family) => {
    const problems: string[] = [];
    if (!clusterIds.has(family.ownerCluster)) {
      problems.push(`${family.id}:missing_owner_cluster:${family.ownerCluster}`);
    }
    if (!fileSet.has(family.ownerPath)) {
      problems.push(`${family.id}:missing_owner_path:${family.ownerPath}`);
    }
    if (!family.allowedPaths.includes(family.ownerPath)) {
      problems.push(`${family.id}:owner_path_not_allowed:${family.ownerPath}`);
    }
    if (family.watchedPathTerms.length === 0) {
      problems.push(`${family.id}:empty_watched_path_terms`);
    }
    if (family.allowedPaths.length === 0) {
      problems.push(`${family.id}:empty_allowed_paths`);
    }
    return problems;
  });
  const staleAllowedPaths = CONSOLIDATED_ENTRYPOINT_FAMILIES.flatMap((family) =>
    family.allowedPaths.filter((file) => !fileSet.has(file)).map((file) => `${family.id}:${file}`),
  );
  const familyIdsByAllowedPath = new Map<string, string[]>();
  for (const family of CONSOLIDATED_ENTRYPOINT_FAMILIES) {
    for (const file of family.allowedPaths) {
      familyIdsByAllowedPath.set(file, [...(familyIdsByAllowedPath.get(file) ?? []), family.id]);
    }
  }
  const unapprovedSharedAllowedPaths = [...familyIdsByAllowedPath.entries()]
    .filter(([, owners]) => owners.length > 1)
    .filter(([file, owners]) => allowedSharedOwners.get(file) !== familyKey(owners))
    .map(([file, owners]) => `${file}:${familyKey(owners)}`);
  const staleSharedOwnerRules = SHARED_ENTRYPOINT_OWNERS.flatMap((owner) => {
    const problems: string[] = [];
    if (!fileSet.has(owner.path)) {
      problems.push(`${owner.path}:missing_shared_path`);
    }
    for (const familyId of owner.familyIds) {
      if (!familyIds.has(familyId)) {
        problems.push(`${owner.path}:missing_shared_family:${familyId}`);
      }
    }
    const actualOwners = familyIdsByAllowedPath.get(owner.path) ?? [];
    if (actualOwners.length > 1 && familyKey(actualOwners) !== familyKey(owner.familyIds)) {
      problems.push(`${owner.path}:shared_owner_mismatch:${familyKey(actualOwners)}`);
    }
    if (actualOwners.length <= 1) {
      problems.push(`${owner.path}:shared_rule_without_shared_allowed_path`);
    }
    return problems;
  });
  const orphanEntrypoints = CONSOLIDATED_ENTRYPOINT_FAMILIES.flatMap((family) => {
    const allowed = new Set(family.allowedPaths);
    const terms = family.watchedPathTerms.map((term) => term.toLowerCase());
    return files
      .filter((file) => terms.some((term) => file.toLowerCase().includes(term)))
      .filter((file) => !allowed.has(file))
      .map((file) => `${family.id}:${file}`);
  });
  return {
    id: "flow_graph_consolidated_entrypoints_registered",
    ok:
      missing.length === 0 &&
      staleAllowedPaths.length === 0 &&
      unapprovedSharedAllowedPaths.length === 0 &&
      staleSharedOwnerRules.length === 0 &&
      orphanEntrypoints.length === 0 &&
      uncoveredClusters.length === 0,
    summary:
      "same-class workflow files must register under an existing owner cluster instead of becoming parallel V2 systems",
    evidence: {
      families: CONSOLIDATED_ENTRYPOINT_FAMILIES.length,
      missing,
      staleAllowedPaths,
      unapprovedSharedAllowedPaths,
      staleSharedOwnerRules,
      orphanEntrypoints,
      uncoveredClusters,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [head, workflow, proof, boundary, missingFiles, consolidatedEntrypoints] =
    await Promise.all([
      joinedSurfaceText(SURFACE_FILES.head),
      joinedSurfaceText(SURFACE_FILES.workflow),
      joinedSurfaceText(SURFACE_FILES.proof),
      joinedSurfaceText(SURFACE_FILES.boundary),
      missingSurfaceFiles(),
      consolidatedEntrypointCheck(),
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
    consolidatedEntrypoints,
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
      consolidatedEntrypointFamilies: CONSOLIDATED_ENTRYPOINT_FAMILIES.length,
      sharedEntrypointOwnerRules: SHARED_ENTRYPOINT_OWNERS.length,
      diagnosticEntries: FLOW_SCENARIOS.length,
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
    diagnosticIndex: buildFlowDiagnosticIndex(),
    consolidationClusters: CONSOLIDATION_CLUSTERS,
    consolidatedEntrypointFamilies: CONSOLIDATED_ENTRYPOINT_FAMILIES,
    sharedEntrypointOwnerRules: SHARED_ENTRYPOINT_OWNERS,
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
