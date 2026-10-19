import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { fingerprintFinanceAnswerEvidence } from "../../src/agents/finance-answer-grounding-gate.js";
import { buildFinanceLearningModuleInput } from "../../src/agents/finance-module-execution.js";
import {
  financeResearchControllerHandoffSchema,
  financeScheduledResearchHandoffSchema,
  financeResearchPortfolioContextSchema,
  assertFinanceResearchRuleUse,
} from "../../src/agents/finance-research-portfolio-plan.js";
import { financeResearchScoredPath } from "../../src/agents/finance-state-dir.js";
import {
  __testing as councilHelpers,
  type LearningCouncilQuestionRequirements,
} from "../../src/agents/provider-learning-council.js";
import { readSelfRepairCandidateReviewInput } from "../../src/agents/self-repair-candidate-review.js";
import { readSelfRepairOwnerMapFeedback } from "../../src/agents/self-repair-owner-map-feedback.js";
import { readFileWithinRoot } from "../../src/infra/fs-safe.js";
import {
  LCX_ONTOLOGY_WORKFLOW_FILTER_IDS,
  LCX_ONTOLOGY_WORKFLOW_FAMILY_IDS,
  LCX_ONTOLOGY_WORKFLOW_NODE_IDS,
  LCX_ONTOLOGY_WORKFLOW_SCENARIO_IDS,
  LCX_FINANCE_RULE_HANDOFF_CONTRACT,
  LCX_ONTOLOGY_REGISTRY,
  validateLcxOntologyEdges,
} from "../../src/shared/lcx-ontology.js";
import type {
  LcxOntologySurfaceId,
  LcxOntologyEdge,
  LcxOntologyWorkflowFamilyId,
  LcxOntologyWorkflowFilterId,
  LcxOntologyWorkflowNodeId,
  LcxOntologyWorkflowScenarioId,
} from "../../src/shared/lcx-ontology.js";
import { planCommercialAnswerRequirements } from "./lcx-commercial-answer-pipeline.js";
import {
  buildDirectedContentReviewInput,
  readDirectedDailyCases,
  readDirectedReviewFeedback,
} from "./lcx-directed-daily-research-brief.js";
import { LCX_USER_HOME } from "./lcx-local-paths.js";

type FlowNodeId = LcxOntologyWorkflowNodeId;
type FlowFilterId = LcxOntologyWorkflowFilterId;
type FlowScenarioId = LcxOntologyWorkflowScenarioId;
type FlowFamilyId = LcxOntologyWorkflowFamilyId;

type SurfaceGroup = LcxOntologySurfaceId;

type FlowScenario = {
  id: FlowScenarioId;
  family: FlowFamilyId;
  objective: string;
  start: FlowNodeId;
  end: FlowNodeId;
  requiredNodes: FlowNodeId[];
  requiredFilters: FlowFilterId[];
  edges: Array<[FlowNodeId, FlowNodeId]>;
  feedbackEdges?: Array<[FlowNodeId, FlowNodeId]>;
  /** Matching terminal failure receipts and read-only consumers may continue, never execution. */
  blockedReceiptContinuations?: Array<[FlowNodeId, FlowNodeId]>;
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
  boundary: "local_flow_graph_only";
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");

const NODE_IDS: FlowNodeId[] = [...LCX_ONTOLOGY_WORKFLOW_NODE_IDS];
const FILTER_IDS: FlowFilterId[] = [...LCX_ONTOLOGY_WORKFLOW_FILTER_IDS];
const SCENARIO_IDS: FlowScenarioId[] = [...LCX_ONTOLOGY_WORKFLOW_SCENARIO_IDS];
const FAMILY_IDS: FlowFamilyId[] = [...LCX_ONTOLOGY_WORKFLOW_FAMILY_IDS];

export const FLOW_SCENARIOS: FlowScenario[] = [
  {
    id: "finance_caseflow_waterflow",
    family: "visible_external_finance_research",
    objective:
      "Preserve research identity, evidence, frozen decision packets and append-only outcome review.",
    start: "research_case",
    end: "outcome_ledger",
    requiredNodes: [
      "research_case",
      "source_registry",
      "research_run",
      "review_panel",
      "decision_packet",
      "outcome_ledger",
    ],
    requiredFilters: [
      "source_evidence_gate",
      "no_wallet_or_order_execution",
      "human_signoff_checkpoint",
      "research_quality_gate_required",
    ],
    edges: [
      ["research_case", "source_registry"],
      ["source_registry", "research_run"],
      ["research_run", "review_panel"],
      ["review_panel", "decision_packet"],
      ["decision_packet", "outcome_ledger"],
    ],
    receipts: ["src/agents/finance-caseflow.test.ts", "src/agents/finance-outcome-ledger.test.ts"],
  },
  {
    id: "external_finance_research_waterflow",
    family: "visible_external_finance_research",
    objective:
      "A broad external message finance ask must reach the right research modules and visible summary without becoming trade advice or unsourced market data.",
    start: "ingress_external_message",
    end: "visible_reply",
    requiredNodes: [
      "ingress_external_message",
      "intent_classifier",
      "local_brain_planner",
      "finance_research_modules",
      "source_registry",
      "finance_learning_memory",
      "causal_map",
      "review_panel",
      "model_tool_decision",
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
      ["ingress_external_message", "intent_classifier"],
      ["intent_classifier", "local_brain_planner"],
      ["local_brain_planner", "source_registry"],
      ["source_registry", "finance_research_modules"],
      ["finance_research_modules", "finance_learning_memory"],
      ["source_registry", "causal_map"],
      ["finance_learning_memory", "review_panel"],
      ["causal_map", "review_panel"],
      ["review_panel", "control_room_summary"],
      ["model_tool_decision", "control_room_summary"],
      ["control_room_summary", "visible_reply"],
    ],
    feedbackEdges: [["review_panel", "model_tool_decision"]],
    receipts: ["external-message-channel", "finance_learning_capability_apply", "review_panel"],
  },
  {
    id: "directed_daily_research_brief_waterflow",
    family: "focused_daily_finance_research_product",
    objective:
      "The main daily product should produce an index-options plus semiconductor/AI compute-chain research packet with candidate radar, evidence gates, risk boundaries, and learning sedimentation instead of relying on open-ended chat.",
    start: "schedule_gate",
    end: "daily_research_packet",
    requiredNodes: [
      "schedule_gate",
      "focused_research_universe",
      "directed_daily_research_brief",
      "finance_data_gateway",
      "finance_research_modules",
      "candidate_watchlist",
      "source_registry",
      "causal_map",
      "review_panel",
      "daily_research_packet",
    ],
    requiredFilters: [
      "focused_daily_product_required",
      "daily_research_packet_required",
      "source_evidence_gate",
      "fresh_timestamp_required",
      "field_definition_required",
      "conflicted_data_blocks_conclusion",
      "research_only_boundary",
      "no_trade_advice",
      "no_unverified_current_market_data",
      "candidate_watchlist_not_trade_recommendation",
      "retrieval_apply_eval_review_required",
    ],
    edges: [
      ["schedule_gate", "focused_research_universe"],
      ["focused_research_universe", "directed_daily_research_brief"],
      ["directed_daily_research_brief", "finance_data_gateway"],
      ["finance_data_gateway", "finance_research_modules"],
      ["finance_research_modules", "candidate_watchlist"],
      ["finance_research_modules", "source_registry"],
      ["source_registry", "causal_map"],
      ["candidate_watchlist", "review_panel"],
      ["causal_map", "review_panel"],
      ["review_panel", "daily_research_packet"],
    ],
    feedbackEdges: [
      ["review_panel", "finance_research_modules"],
      ["daily_research_packet", "finance_learning_memory"],
    ],
    receipts: [
      "lcx-directed-daily-research-brief-latest",
      "lcx-finance-research-run-latest",
      "finance_data_gateway_snapshot",
      "review_panel",
      "learning_sedimentation_review",
    ],
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
      ["capability_card", "apply_validation"],
      ["capability_card", "retrieval_receipt"],
      ["apply_validation", "retrieval_receipt"],
      ["retrieval_receipt", "local_brain_eval_absorption"],
      ["apply_validation", "local_brain_eval_absorption"],
      ["local_brain_eval_absorption", "module_learning_review"],
      ["module_learning_review", "keep_downrank_discard"],
      ["module_learning_review", "module_learning_absorption_gate"],
      ["keep_downrank_discard", "module_learning_absorption_gate"],
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
      "evolution_cooldown",
      "hardened_eval",
      "promotion_gate",
      "adapter_resolver",
      "failure_curriculum",
    ],
    requiredFilters: [
      "training_overlap_guard",
      "work_then_evolve_cooldown_required",
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
      ["promotion_gate", "evolution_cooldown"],
    ],
    feedbackEdges: [
      ["hardened_eval", "failure_curriculum"],
      ["failure_curriculum", "teacher_quota"],
      ["evolution_cooldown", "teacher_quota"],
    ],
    receipts: [
      "minimax-brain-training-guard",
      "local-brain-training-plan",
      "candidate_hardened_eval",
    ],
  },
  {
    id: "local_to_external_channel_external_waterflow",
    family: "local_ready_to_external_user_visible_boundary",
    objective:
      "Local changes can reach the owner through External only after tests, external-channel binding, probe, and real External inbound proof; live runtime wording is legacy compatibility.",
    start: "local_change",
    end: "user_visible_observed",
    requiredNodes: [
      "local_change",
      "local_tests",
      "external_channel_binding",
      "channel_restart_probe",
      "real_external_inbound",
      "user_visible_observed",
    ],
    requiredFilters: [
      "local_ready_not_user_visible_observed",
      "external_channel_probe_required",
      "real_external_inbound_required",
    ],
    edges: [
      ["local_change", "local_tests"],
      ["local_tests", "external_channel_binding"],
      ["external_channel_binding", "channel_restart_probe"],
      ["channel_restart_probe", "real_external_inbound"],
      ["real_external_inbound", "user_visible_observed"],
    ],
    receipts: ["external-channel-binding", "external-message-channel"],
  },
  {
    id: "skillopt_runtime_self_use_waterflow",
    family: "skillopt_eval_to_external_message_channel_preflight",
    objective:
      "Accepted SkillOpt SOPs from eval failures should enter the External/local reply planner as deterministic preflight context while model-weight absorption, adapter promotion, and user-visible-observed proof stay gated.",
    start: "hardened_eval",
    end: "user_visible_observed",
    requiredNodes: [
      "hardened_eval",
      "failure_curriculum",
      "skillopt_candidate_edit",
      "skillopt_best_skill",
      "skillopt_runtime_preflight",
      "local_tests",
      "external_channel_binding",
      "channel_restart_probe",
      "real_external_inbound",
      "user_visible_observed",
    ],
    requiredFilters: [
      "training_overlap_guard",
      "parse_recovered_no_promotion",
      "skillopt_best_skill_required",
      "skillopt_context_not_weight_absorption",
      "skillopt_external_channel_proof_required",
      "local_ready_not_user_visible_observed",
      "external_channel_probe_required",
      "real_external_inbound_required",
      "no_internal_runtime_details_visible",
    ],
    edges: [
      ["hardened_eval", "failure_curriculum"],
      ["failure_curriculum", "skillopt_candidate_edit"],
      ["skillopt_candidate_edit", "skillopt_best_skill"],
      ["skillopt_best_skill", "skillopt_runtime_preflight"],
      ["skillopt_runtime_preflight", "local_tests"],
      ["local_tests", "external_channel_binding"],
      ["external_channel_binding", "channel_restart_probe"],
      ["channel_restart_probe", "real_external_inbound"],
      ["real_external_inbound", "user_visible_observed"],
    ],
    feedbackEdges: [
      ["real_external_inbound", "skillopt_runtime_preflight"],
      ["skillopt_candidate_edit", "failure_curriculum"],
    ],
    receipts: [
      "lcx-skillopt-lite",
      "skillopt-autocue",
      "lcx-governance-autopilot-latest",
      "lcx-external-channel-binding",
      "external-message-channel",
    ],
  },
  {
    id: "compressed_context_recovery_waterflow",
    family: "future_agent_state_recovery",
    objective:
      "A new or compressed coding window must recover state from durable files, fresh operator state, mind model, flow graph, training plan, and change-impact plan.",
    start: "new_codex_window",
    end: "central_agent_perception",
    requiredNodes: [
      "new_codex_window",
      "fixed_evidence_recovery",
      "operator_latest_state",
      "mind_model",
      "flow_graph",
      "training_plan",
      "change_impact_plan",
      "central_agent_perception",
    ],
    requiredFilters: ["fresh_operator_state_required", "error_receipt_required"],
    edges: [
      ["new_codex_window", "fixed_evidence_recovery"],
      ["fixed_evidence_recovery", "operator_latest_state"],
      ["fixed_evidence_recovery", "mind_model"],
      ["fixed_evidence_recovery", "flow_graph"],
      ["fixed_evidence_recovery", "training_plan"],
      ["fixed_evidence_recovery", "change_impact_plan"],
      ["operator_latest_state", "central_agent_perception"],
      ["mind_model", "central_agent_perception"],
      ["flow_graph", "central_agent_perception"],
      ["training_plan", "central_agent_perception"],
      ["change_impact_plan", "central_agent_perception"],
    ],
    feedbackEdges: [["central_agent_perception", "new_codex_window"]],
    receipts: ["lcx-local-operator-latest", "lcx-context-recovery-exam", "lcx-flow-graph"],
  },
  {
    id: "universe_index_total_coverage_waterflow",
    family: "repo_runtime_artifact_total_inventory",
    objective:
      "A broad full-system review must first build one read-only index of repo files, code surfaces, runtime artifacts, live sidecar files, owner coverage, and cleanup candidates before any cleanup or repair action.",
    start: "fixed_evidence_recovery",
    end: "cleanup_candidate_review",
    requiredNodes: [
      "fixed_evidence_recovery",
      "universe_index",
      "repo_inventory",
      "artifact_inventory",
      "owner_coverage_map",
      "cleanup_candidate_review",
      "change_impact_plan",
      "mind_model",
      "flow_graph",
    ],
    requiredFilters: [
      "inventory_only_no_delete",
      "owner_coverage_required",
      "artifact_staleness_visible",
      "same_philosophy_merge_required",
      "single_owner_required",
      "protected_memory_guard",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    edges: [
      ["fixed_evidence_recovery", "cleanup_candidate_review"],
      ["repo_inventory", "change_impact_plan"],
      ["repo_inventory", "owner_coverage_map"],
      ["artifact_inventory", "owner_coverage_map"],
      ["change_impact_plan", "universe_index"],
      ["repo_inventory", "universe_index"],
      ["artifact_inventory", "universe_index"],
      ["owner_coverage_map", "universe_index"],
      ["universe_index", "cleanup_candidate_review"],
      ["mind_model", "cleanup_candidate_review"],
      ["flow_graph", "cleanup_candidate_review"],
    ],
    feedbackEdges: [["cleanup_candidate_review", "change_impact_plan"]],
    receipts: [
      "lcx-universe-index-latest",
      "lcx-change-impact-plan",
      "lcx-governance-autopilot-latest",
    ],
  },
  {
    id: "local_automation_digest_waterflow",
    family: "local_operator_to_single_digest",
    objective:
      "Local automation should gather cleanup, governance autopilot, local failure trace, owner brief, doctor, training plan, mind model, flow graph, and context recovery into one latest receipt and one digest.",
    start: "local_operator_loop",
    end: "operator_digest",
    requiredNodes: [
      "local_operator_loop",
      "automation_cleanup",
      "governance_autopilot",
      "local_failure_trace",
      "system_doctor",
      "training_plan",
      "mind_model",
      "flow_graph",
      "fixed_evidence_recovery",
      "operator_training_supervisor",
      "operator_agent_exam",
      "operator_latest_receipt",
      "operator_digest",
    ],
    requiredFilters: ["single_digest_only", "error_receipt_required", "training_overlap_guard"],
    edges: [
      ["local_operator_loop", "automation_cleanup"],
      ["local_operator_loop", "governance_autopilot"],
      ["local_operator_loop", "system_doctor"],
      ["local_operator_loop", "training_plan"],
      ["local_operator_loop", "mind_model"],
      ["local_operator_loop", "flow_graph"],
      ["local_operator_loop", "fixed_evidence_recovery"],
      ["local_operator_loop", "operator_training_supervisor"],
      ["local_operator_loop", "operator_agent_exam"],
      ["governance_autopilot", "local_failure_trace"],
      ["automation_cleanup", "operator_latest_receipt"],
      ["governance_autopilot", "operator_latest_receipt"],
      ["system_doctor", "operator_latest_receipt"],
      ["training_plan", "operator_latest_receipt"],
      ["mind_model", "operator_latest_receipt"],
      ["flow_graph", "operator_latest_receipt"],
      ["fixed_evidence_recovery", "operator_latest_receipt"],
      ["operator_training_supervisor", "operator_latest_receipt"],
      ["operator_agent_exam", "operator_latest_receipt"],
      ["operator_latest_receipt", "operator_digest"],
    ],
    receipts: [
      "lcx-local-operator-loop",
      "lcx-governance-autopilot-latest",
      "lcx-local-failure-trace-latest",
      "lcx-local-failure-trace",
      "lcx-owner-brief-latest",
      "lcx-owner-control-map-latest",
      "lcx-local-operator-latest",
      "LCX Agent Operator Digest",
    ],
  },
  {
    id: "central_agent_decision_waterflow",
    family: "local_operator_to_single_digest",
    objective:
      "The whole-system decision must have one owner: the central agent perceives the governance and control-room snapshots, the model brain proposes, the TypeScript gate approves or blocks, and the cycle records one receipt and one latest snapshot.",
    start: "governance_autopilot",
    end: "central_agent_latest_receipt",
    requiredNodes: [
      "governance_autopilot",
      "central_agent_perception",
      "central_agent_brain_proposal",
      "central_agent_gate",
      "central_agent_latest_receipt",
    ],
    requiredFilters: [
      "llm_proposes_ts_gate_approves",
      "central_agent_plan_only_no_dispatch",
      "central_agent_no_execution_authority",
      "no_provider_config_change",
      "protected_memory_guard",
      "error_receipt_required",
    ],
    edges: [
      ["governance_autopilot", "central_agent_perception"],
      ["central_agent_perception", "central_agent_brain_proposal"],
      ["central_agent_brain_proposal", "central_agent_gate"],
      ["central_agent_gate", "central_agent_latest_receipt"],
    ],
    receipts: [
      "lcx-central-agent-latest",
      "lcx-central-agent-log-latest.jsonl",
      "test/lcx-central-agent.test.ts",
    ],
  },
  {
    id: "external_visible_language_waterflow",
    family: "visible_external_readability_and_language_boundary",
    objective:
      "external message visible replies must route language, normalize display text, audit reply flow, and hide internal labels from the user.",
    start: "ingress_external_message",
    end: "visible_reply",
    requiredNodes: [
      "ingress_external_message",
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
      "local_ready_not_user_visible_observed",
    ],
    edges: [
      ["ingress_external_message", "intent_classifier"],
      ["ingress_external_message", "language_router"],
      ["ingress_external_message", "display_text_normalizer"],
      ["intent_classifier", "local_brain_planner"],
      ["local_brain_planner", "answer_audit_budget"],
      ["local_brain_planner", "control_room_summary"],
      ["answer_audit_budget", "control_room_summary"],
      ["language_router", "control_room_summary"],
      ["display_text_normalizer", "readability_review"],
      ["readability_review", "visible_answer_adoption_gate"],
      ["visible_answer_adoption_gate", "control_room_summary"],
      ["control_room_summary", "reply_flow_audit"],
      ["visible_answer_adoption_gate", "reply_flow_audit"],
      ["reply_flow_audit", "visible_reply"],
    ],
    feedbackEdges: [["readability_review", "display_text_normalizer"]],
    receipts: [
      "external-message-handoff-receipt",
      "external-message-envelope",
      "external-message-channel",
      "src/agents/visible-answer-adoption-gate.ts#applyVisibleAnswerAdoptionGate",
      "external-channel-status",
    ],
  },
  {
    id: "commercial_answer_pipeline_waterflow",
    family: "commercial_answer_adoption_and_failed_reason",
    objective:
      "A user-facing answer must move from language intake through planning, evidence gates, bounded local/Qwen/model review, and a terminal adoption gate instead of looping forever or treating a model answer as final authority.",
    start: "ingress_external_message",
    end: "visible_reply",
    requiredNodes: [
      "ingress_external_message",
      "intent_classifier",
      "local_brain_planner",
      "model_council",
      "provider_evidence",
      "minimax_agent_draft",
      "model_candidate_answer",
      "display_text_normalizer",
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
      "minimax_agent_draft_not_final_authority",
      "minimax_agent_output_requires_lcx_gate",
      "minimax_agent_runtime_claim_requires_receipt",
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
      ["ingress_external_message", "intent_classifier"],
      ["intent_classifier", "local_brain_planner"],
      ["local_brain_planner", "model_council"],
      ["model_council", "provider_evidence"],
      ["provider_evidence", "minimax_agent_draft"],
      ["minimax_agent_draft", "model_candidate_answer"],
      ["local_brain_planner", "answer_audit_budget"],
      ["model_candidate_answer", "display_text_normalizer"],
      ["display_text_normalizer", "local_contract_audit"],
      ["provider_evidence", "local_contract_audit"],
      ["answer_audit_budget", "control_room_summary"],
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
    // The original blocked gate returns a diagnostic summary, never downstream execution.
    blockedReceiptContinuations: [["visible_answer_adoption_gate", "control_room_summary"]],
    receipts: [
      "commercial_answer_pipeline",
      "external_language_handoff_receipt",
      "external_context_packet",
      "review_panel",
      "external-message-channel",
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
    // A refused candidate still produces the original guarded diagnostic summary.
    blockedReceiptContinuations: [["review_panel", "control_room_summary"]],
    receipts: ["learning-council", "model-council-provider-evidence", "review_panel"],
  },
  {
    id: "commercial_acceptance_harness_waterflow",
    family: "commercial_product_acceptance_gate",
    objective:
      "Commercial acceptance must grade real product readiness by consuming existing owner outputs, error budgets, and external message-channel canaries instead of fixing isolated red dots or becoming a new truth owner.",
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
      "external_channel_binding",
      "channel_restart_probe",
      "real_external_inbound",
      "user_visible_observed",
      "acceptance_eval",
    ],
    requiredFilters: [
      "commercial_error_budget_required",
      "product_canary_suite_required",
      "single_owner_required",
      "bounded_answer_review",
      "training_overlap_guard",
      "provider_evidence_required",
      "local_ready_not_user_visible_observed",
      "external_channel_probe_required",
      "real_external_inbound_required",
    ],
    edges: [
      ["local_operator_loop", "system_doctor"],
      ["local_operator_loop", "training_plan"],
      ["local_operator_loop", "mind_model"],
      ["local_operator_loop", "flow_graph"],
      ["local_operator_loop", "external_channel_binding"],
      ["system_doctor", "commercial_acceptance_harness"],
      ["training_plan", "commercial_acceptance_harness"],
      ["mind_model", "commercial_acceptance_harness"],
      ["flow_graph", "commercial_acceptance_harness"],
      ["external_channel_binding", "commercial_acceptance_harness"],
      ["commercial_acceptance_harness", "answer_audit_budget"],
      ["external_channel_binding", "channel_restart_probe"],
      ["channel_restart_probe", "real_external_inbound"],
      ["real_external_inbound", "user_visible_observed"],
      ["user_visible_observed", "acceptance_eval"],
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
      "external-message-channel",
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
    id: "self_repair_hands_waterflow",
    family: "memory_correction_and_training_candidate_self_repair",
    objective:
      "The agent may write only allowlisted memory correction/downrank notes and training/eval candidate packets, then surface them to governance and owner control without claiming train-slice or model absorption.",
    start: "memory_recall",
    end: "owner_coverage_map",
    requiredNodes: [
      "memory_recall",
      "source_conflict_review",
      "self_repair_hands",
      "memory_write_gate",
      "self_repair_memory_cleaner",
      "correction_note",
      "stale_memory_downrank",
      "self_repair_training_case_builder",
      "training_eval_candidate_packet",
      "self_repair_latest_receipt",
      "governance_autopilot",
      "owner_coverage_map",
    ],
    requiredFilters: [
      "memory_write_freshness_gate",
      "self_repair_write_allowlist_required",
      "explicit_self_repair_write_flag_required",
      "training_candidate_not_absorbed",
      "protected_memory_guard",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "training_overlap_guard",
      "model_weight_absorption_not_claimed",
    ],
    edges: [
      ["memory_recall", "source_conflict_review"],
      // The original owner constructs sibling proposals before its writer verifies sources.
      ["self_repair_hands", "self_repair_memory_cleaner"],
      ["self_repair_hands", "self_repair_training_case_builder"],
      ["self_repair_memory_cleaner", "memory_write_gate"],
      ["self_repair_training_case_builder", "memory_write_gate"],
      ["source_conflict_review", "memory_write_gate"],
      ["memory_write_gate", "correction_note"],
      ["memory_write_gate", "training_eval_candidate_packet"],
      // This is provisional candidate metadata, not an independently executed ranking worker.
      ["self_repair_memory_cleaner", "stale_memory_downrank"],
      // Same-owner assembly/write order; independent disk consumption still requires readback evidence.
      ["correction_note", "self_repair_latest_receipt"],
      ["stale_memory_downrank", "self_repair_latest_receipt"],
      ["training_eval_candidate_packet", "self_repair_latest_receipt"],
      ["memory_write_gate", "self_repair_latest_receipt"],
      ["self_repair_latest_receipt", "governance_autopilot"],
      ["governance_autopilot", "owner_coverage_map"],
    ],
    feedbackEdges: [
      ["owner_coverage_map", "self_repair_hands"],
      ["training_eval_candidate_packet", "review_panel"],
    ],
    blockedReceiptContinuations: [["memory_write_gate", "self_repair_latest_receipt"]],
    receipts: [
      "lcx-self-repair-hands-latest",
      "lcx-self-repair-hands-jsonl",
      "lcx-governance-autopilot-latest",
      "lcx-owner-control-map-latest",
      "self_repair_training_candidate",
    ],
  },
  {
    id: "finance_data_gateway_waterflow",
    family: "timestamped_finance_data_reconciliation",
    objective:
      "Finance answers that use current, priced, fundamental, macro, ETF, options, or vendor numbers must pass through one data gateway that preserves timestamps, field definitions, and provider conflicts before Qwen, External, or memory can use the numbers.",
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
      "evolution_cooldown",
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
      "work_then_evolve_cooldown_required",
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
      ["promotion_gate", "evolution_cooldown"],
      ["evolution_cooldown", "review_panel"],
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
    start: "local_change",
    end: "single_owner_contract",
    requiredNodes: [
      "local_change",
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
      ["local_change", "change_impact_plan"],
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
      "blacktech_mechanism_map",
      "workflow_distillation",
      "local_skill_candidate",
      "trajectory_or_trace_receipt",
      "security_permission_review",
      "review_panel",
      "acceptance_eval",
    ],
    requiredFilters: [
      "license_scope_required",
      "untrusted_source_isolation",
      "blacktech_is_pattern_intake_only",
      "runtime_authority_not_granted",
      "model_weight_absorption_not_claimed",
      "live_proof_required",
      "tool_permission_audit_required",
      "human_signoff_checkpoint",
      "no_provider_config_change",
      "protected_memory_guard",
    ],
    edges: [
      ["external_agent_source", "source_registry"],
      ["source_registry", "license_scope_review"],
      ["license_scope_review", "actual_reading_scope"],
      ["actual_reading_scope", "external_upgrade_radar"],
      ["external_upgrade_radar", "blacktech_mechanism_map"],
      ["blacktech_mechanism_map", "workflow_distillation"],
      ["workflow_distillation", "local_skill_candidate"],
      ["workflow_distillation", "trajectory_or_trace_receipt"],
      ["workflow_distillation", "security_permission_review"],
      ["local_skill_candidate", "review_panel"],
      ["trajectory_or_trace_receipt", "review_panel"],
      ["security_permission_review", "review_panel"],
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
    id: "multi_agent_pattern_shadow_evaluation_waterflow",
    family: "multi_agent_pattern_shadow_evaluation",
    objective:
      "Manager, handoff, and parallel-worker topologies must be compared on the same case with replay, isolated execution, explicit ownership, permission evidence, and recoverable final delivery.",
    start: "multi_agent_pattern_intake",
    end: "acceptance_eval",
    requiredNodes: [
      "multi_agent_pattern_intake",
      "shadow_replay",
      "shadow_isolated_executor",
      "interruption_recovery_probe",
      "pattern_comparison",
      "review_panel",
      "acceptance_eval",
    ],
    requiredFilters: [
      "same_case_required",
      "same_model_policy_required",
      "replay_before_isolated_executor_required",
      "replay_before_live_required",
      "explicit_cost_basis_required",
      "shadow_tool_permission_audit_required",
      "no_shadow_external_side_effects",
      "shadow_recovery_receipt_required",
      "wide_trial_not_production",
      "research_only_boundary",
      "no_trade_advice",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    edges: [
      ["multi_agent_pattern_intake", "shadow_replay"],
      ["shadow_replay", "shadow_isolated_executor"],
      ["shadow_isolated_executor", "interruption_recovery_probe"],
      ["shadow_isolated_executor", "pattern_comparison"],
      ["interruption_recovery_probe", "pattern_comparison"],
      ["pattern_comparison", "review_panel"],
      ["review_panel", "acceptance_eval"],
    ],
    receipts: [
      "multi-agent-pattern-intake",
      "lcx-multi-agent-pattern-shadow",
      "lcx-multi-agent-pattern-shadow.jsonl",
      "review_panel",
    ],
  },
  {
    id: "logical_agent_pool_waterflow",
    family: "logical_agent_pool",
    objective:
      "Ten logical roles must share one bounded local model pool through immutable configuration, identity snapshots, task deadlines, capability checks, and a derived terminal sink.",
    start: "logical_agent_pool_intake",
    end: "logical_agent_pool_terminal",
    requiredNodes: [
      "logical_agent_pool_intake",
      "logical_agent_pool_schedule",
      "logical_agent_task_executor",
      "logical_agent_pool_terminal",
    ],
    requiredFilters: [
      "logical_agent_task_identity_snapshot_required",
      "logical_agent_pool_timeout_required",
      "logical_agent_capability_boundary_required",
      "logical_agent_config_immutable_required",
      "logical_agent_terminal_sink_required",
      "no_logical_agent_external_side_effects",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    edges: [
      ["logical_agent_pool_intake", "logical_agent_pool_schedule"],
      ["logical_agent_pool_schedule", "logical_agent_task_executor"],
      ["logical_agent_task_executor", "logical_agent_pool_terminal"],
    ],
    receipts: [
      "logical-agent-pool",
      "lcx-logical-agent-pool",
      "src/agents/logical-agent-pool.test.ts",
    ],
  },
  {
    id: "prediction_market_research_only_waterflow",
    family: "prediction_market_research_and_strategy_audit",
    objective:
      "Polymarket and prediction-market sources may enrich research packets and paper-only strategy audits, but must never become wallet, order, copy-trading, or latency-arbitrage authority.",
    start: "prediction_market_source",
    end: "control_room_summary",
    requiredNodes: [
      "prediction_market_source",
      "source_registry",
      "actual_reading_scope",
      "resolution_criteria_review",
      "finance_data_gateway",
      "data_provenance_quality_review",
      "market_microstructure_review",
      "strategy_experiment_audit",
      "review_panel",
      "control_room_summary",
    ],
    requiredFilters: [
      "source_evidence_gate",
      "research_only_boundary",
      "no_trade_advice",
      "fresh_timestamp_required",
      "field_definition_required",
      "market_microstructure_warning_required",
      "paper_only_backtest_required",
      "sample_out_validation_required",
      "thin_liquidity_downrank_required",
      "ambiguous_resolution_blocks_conclusion",
      "fees_slippage_and_sample_out_required",
      "no_wallet_or_order_execution",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    edges: [
      ["prediction_market_source", "source_registry"],
      ["source_registry", "actual_reading_scope"],
      ["actual_reading_scope", "resolution_criteria_review"],
      ["resolution_criteria_review", "finance_data_gateway"],
      ["finance_data_gateway", "data_provenance_quality_review"],
      ["data_provenance_quality_review", "market_microstructure_review"],
      ["market_microstructure_review", "strategy_experiment_audit"],
      ["strategy_experiment_audit", "review_panel"],
      ["review_panel", "control_room_summary"],
    ],
    feedbackEdges: [
      ["review_panel", "source_registry"],
      ["strategy_experiment_audit", "market_microstructure_review"],
    ],
    receipts: [
      "lcx-external-agent-upgrade-radar",
      "finance-data-gateway",
      "source_registry",
      "data_provenance_quality",
      "strategy_experiment_audit",
      "review_panel",
    ],
  },
  {
    id: "finance_intraday_paper_waterflow",
    family: "intraday_point_in_time_paper_validation",
    objective:
      "Closed point-in-time intraday bars flow through a frozen no-lookahead rule, the shared cost model and a same-cost retail baseline into a paper-only result receipt; replay evidence never becomes an execution receipt or an alpha claim.",
    start: "intraday_point_in_time_ledger",
    end: "intraday_result_score",
    requiredNodes: [
      "intraday_point_in_time_ledger",
      "frozen_intraday_signal",
      "same_cost_retail_baseline",
      "paper_replay_receipt",
      "intraday_result_score",
    ],
    requiredFilters: [
      "closed_bar_only_required",
      "next_bar_fill_required",
      "same_cost_baseline_required",
      "paper_replay_not_execution_receipt",
      "multi_regime_validation_required",
      "no_wallet_or_order_execution",
    ],
    edges: [
      ["intraday_point_in_time_ledger", "frozen_intraday_signal"],
      ["frozen_intraday_signal", "same_cost_retail_baseline"],
      ["same_cost_retail_baseline", "paper_replay_receipt"],
      ["paper_replay_receipt", "intraday_result_score"],
    ],
    feedbackEdges: [["intraday_result_score", "frozen_intraday_signal"]],
    receipts: [
      "finance-intraday-ledger",
      "finance-intraday-paper-receipt",
      "same-cost-retail-baseline",
    ],
  },
  {
    id: "finance_live_execution_waterflow",
    family: "authorized_live_execution_and_risk_budget",
    objective:
      "An explicitly authorized live-execution run may place orders, but only through a declared execution adapter, inside a stated risk budget, and only when it leaves an execution receipt that lands in an append-only position ledger. Research and candidate waterflows never reach this path.",
    start: "execution_intent",
    end: "position_ledger",
    requiredNodes: [
      "execution_intent",
      "explicit_run_authorization",
      "declared_execution_adapter",
      "order_placement",
      "execution_receipt",
      "position_ledger",
    ],
    requiredFilters: [
      "explicit_run_authorization_required",
      "declared_execution_adapter_required",
      "risk_budget_required",
      "execution_receipt_required",
      "append_only_ledger_required",
      "mark_required_for_unrealized_pnl",
    ],
    edges: [
      ["execution_intent", "explicit_run_authorization"],
      ["explicit_run_authorization", "declared_execution_adapter"],
      ["declared_execution_adapter", "order_placement"],
      ["order_placement", "execution_receipt"],
      ["execution_receipt", "position_ledger"],
    ],
    receipts: [
      "finance-decision-policy",
      "finance-caseflow",
      "finance-outcome-ledger",
      "finance-position-ledger",
    ],
  },
  {
    id: "finance_automatic_paper_trading_waterflow",
    family: "automatic_paper_trading_lifecycle",
    objective:
      "One finance scheduler directly invokes configured day research: model-assisted research consumes active rules, reviewed candidates produce a bounded plan, and execution uses the shared gate and ledger. Night directional scores produce forecast-calibration proposals and an explicit execution-promotion block, not automatic rule activation. Net-trade promotion remains unimplemented; central supervision is independent. The legacy unconfigured research path is not this research-chain proof.",
    start: "schedule_gate",
    end: "deterministic_promotion_gate",
    requiredNodes: [
      "schedule_gate",
      "finance_research_modules",
      "finance_data_gateway",
      "review_panel",
      "portfolio_candidate",
      "portfolio_plan",
      "finance_scheduler",
      "execution_intent",
      "explicit_run_authorization",
      "declared_execution_adapter",
      "order_placement",
      "execution_receipt",
      "position_ledger",
      "research_run",
      "night_settlement",
      "outcome_ledger",
      "tuning_proposal",
      "deterministic_promotion_gate",
      "strategy_rule_ledger",
    ],
    requiredFilters: [
      "llm_proposes_ts_gate_approves",
      "central_agent_no_execution_authority",
      "research_receipt_required",
      "portfolio_plan_required",
      "strategy_rule_activation_required",
      "single_finance_scheduler_owner_required",
      "paper_venue_only_for_autonomous_cycle",
      "explicit_run_authorization_required",
      "risk_budget_required",
      "execution_receipt_required",
      "append_only_ledger_required",
      "night_feedback_requires_scored_outcomes",
      "deterministic_promotion_gate_required",
    ],
    edges: [
      ["schedule_gate", "finance_research_modules"],
      ["finance_research_modules", "review_panel"],
      ["finance_research_modules", "finance_data_gateway"],
      ["finance_data_gateway", "review_panel"],
      ["review_panel", "portfolio_candidate"],
      ["portfolio_candidate", "portfolio_plan"],
      ["portfolio_plan", "finance_scheduler"],
      ["finance_scheduler", "execution_intent"],
      ["execution_intent", "explicit_run_authorization"],
      ["explicit_run_authorization", "declared_execution_adapter"],
      ["declared_execution_adapter", "order_placement"],
      ["order_placement", "execution_receipt"],
      ["execution_receipt", "position_ledger"],
      ["schedule_gate", "night_settlement"],
      ["research_run", "night_settlement"],
      ["night_settlement", "outcome_ledger"],
      ["outcome_ledger", "tuning_proposal"],
      ["tuning_proposal", "deterministic_promotion_gate"],
    ],
    feedbackEdges: [
      ["strategy_rule_ledger", "finance_research_modules"],
      ["strategy_rule_ledger", "central_agent_perception"],
      ["tuning_proposal", "central_agent_perception"],
      ["position_ledger", "finance_research_modules"],
    ],
    receipts: [
      "lcx-finance-research-run-latest",
      "finance-portfolio-plan",
      "daily-cycle-runs",
      "finance-position-ledger",
      "research-scored",
      "tuning-proposals",
      "finance-strategy-rule-ledger",
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
      "local_change",
      "local_tests",
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
      ["repair_lock", "local_change"],
      ["local_change", "local_tests"],
      ["local_tests", "system_doctor"],
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
  [
    "local_change",
    "user_visible_observed",
    "local changes must not skip external-channel binding and real External proof",
  ],
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
    "local_change",
    "flow_graph",
    "small local changes must pass change-impact and prior-work search first",
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
  ["training_plan", "local_change", "automation repair must pass schedule gate and repair lock"],
];

export const CONSOLIDATION_CLUSTERS: ConsolidationCluster[] = [
  {
    id: "finance_research_lifecycle_cluster",
    philosophy:
      "Frozen research identity, bounded execution and outcome review form one finance lifecycle.",
    ownerScenario: "finance_caseflow_waterflow",
    ownerNode: "research_case",
    sameClassTerms: ["research_case", "decision_packet", "outcome_ledger"],
    mergeFilters: [
      "source_evidence_gate",
      "no_wallet_or_order_execution",
      "human_signoff_checkpoint",
    ],
  },
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
      "lcx-universe-index",
      "lcx-system-doctor",
    ],
    mergeFilters: ["same_philosophy_merge_required", "single_owner_required"],
  },
  {
    id: "universe_inventory_cluster",
    philosophy:
      "repo inventory, runtime artifacts, live sidecar files, owner coverage, and cleanup candidates are one read-only index, not separate ad hoc scans",
    ownerScenario: "universe_index_total_coverage_waterflow",
    ownerNode: "universe_index",
    sameClassTerms: [
      "lcx-universe-index",
      "repo_inventory",
      "artifact_inventory",
      "ownerCoverage",
      "garbageCandidates",
      "local_universe_index_only",
    ],
    mergeFilters: [
      "inventory_only_no_delete",
      "owner_coverage_required",
      "artifact_staleness_visible",
      "single_owner_required",
    ],
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
    id: "local_live_evidence_cluster",
    philosophy:
      "core-ready, external-channel-bound, and user-visible-observed are one boundary model; old live terms are legacy aliases",
    ownerScenario: "local_to_external_channel_external_waterflow",
    ownerNode: "external_channel_binding",
    sameClassTerms: [
      "core-ready",
      "external-channel-bound",
      "user-visible-observed",
      "legacy-live-runtime-updated",
      "legacy-live-user-seen",
    ],
    mergeFilters: ["local_ready_not_user_visible_observed", "real_external_inbound_required"],
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
    id: "focused_daily_research_product_cluster",
    philosophy:
      "open Q&A is a guarded follow-up path, while the dependable finance product is one focused daily research packet",
    ownerScenario: "directed_daily_research_brief_waterflow",
    ownerNode: "directed_daily_research_brief",
    sameClassTerms: [
      "lcx-directed-daily-research-brief",
      "index options daily brief",
      "semiconductor AI compute chain",
      "timely stock candidate radar",
      "focused daily research product",
    ],
    mergeFilters: [
      "focused_daily_product_required",
      "daily_research_packet_required",
      "candidate_watchlist_not_trade_recommendation",
      "single_owner_required",
    ],
  },
  {
    id: "commercial_acceptance_harness_cluster",
    philosophy:
      "commercial acceptance is one product-grade exam that consumes owner outputs, error budgets, and external message-channel canaries without replacing those owners",
    ownerScenario: "commercial_acceptance_harness_waterflow",
    ownerNode: "commercial_acceptance_harness",
    sameClassTerms: [
      "commercial acceptance harness",
      "product canary",
      "error budget",
      "readyForCommercialRelease",
      "post_migration_external_canary",
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
    id: "prediction_market_research_cluster",
    philosophy:
      "prediction-market tools, CLOB data, benchmarks, and strategies are weak-evidence research sources plus paper-only audits, not execution systems",
    ownerScenario: "prediction_market_research_only_waterflow",
    ownerNode: "market_microstructure_review",
    sameClassTerms: [
      "Polymarket",
      "prediction market",
      "market_microstructure_warning",
      "thin_liquidity_downrank",
      "ambiguous_resolution_blocks_conclusion",
      "strategy_experiment_audit",
      "no_wallet_or_order_execution",
    ],
    mergeFilters: [
      "research_only_boundary",
      "no_trade_advice",
      "market_microstructure_warning_required",
      "paper_only_backtest_required",
      "thin_liquidity_downrank_required",
      "ambiguous_resolution_blocks_conclusion",
      "fees_slippage_and_sample_out_required",
      "no_wallet_or_order_execution",
    ],
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

export const CONSOLIDATED_ENTRYPOINT_FAMILIES: ConsolidatedEntrypointFamily[] = [
  {
    id: "finance_caseflow_entrypoints",
    ownerCluster: "finance_research_lifecycle_cluster",
    ownerPath: "src/agents/finance-caseflow.ts",
    watchedPathTerms: [
      "finance-caseflow",
      "finance-research-runner",
      "finance-research-batch-runner",
      "finance-outcome-ledger",
      "finance-forecast-calibration",
      "finance-history-coverage",
      "finance-research-assessment",
      "finance-model-checkpoints",
      "finance-run-checkpoints",
      "lcx-finance-research",
      "lcx-caseflow-demo",
    ],
    allowedPaths: [
      "scripts/operator/lcx-caseflow-demo.ts",
      "scripts/operator/lcx-finance-research.ts",
      "scripts/operator/lcx-finance-research-batch.ts",
      "scripts/operator/lcx-finance-research-run.ts",
      "scripts/operator/lcx-finance-research-checkpoint-run.ts",
      "test/operator/lcx-finance-research-checkpoint-run.test.ts",
      "scripts/operator/lcx-finance-research-score.ts",
      "scripts/operator/lcx-finance-research-turn.ts",
      "test/operator/lcx-finance-research.test.ts",
      "src/agents/finance-caseflow-followups.test.ts",
      "src/agents/finance-caseflow-followups.ts",
      "src/agents/finance-caseflow.test.ts",
      "src/agents/finance-caseflow.ts",
      "src/agents/finance-forecast-calibration.test.ts",
      "src/agents/finance-forecast-calibration.ts",
      "src/agents/finance-history-coverage.test.ts",
      "src/agents/finance-history-coverage.ts",
      "src/agents/finance-model-checkpoints.test.ts",
      "src/agents/finance-model-checkpoints.ts",
      "src/agents/finance-outcome-ledger.test.ts",
      "src/agents/finance-outcome-ledger.ts",
      "src/agents/finance-research-assessment.test.ts",
      "src/agents/finance-research-assessment.ts",
      "src/agents/finance-research-batch-runner.test.ts",
      "src/agents/finance-research-batch-runner.ts",
      "src/agents/finance-research-runner.test.ts",
      "src/agents/finance-research-runner.intraday-projection.test.ts",
      "src/agents/finance-research-runner.ts",
      "src/agents/finance-run-checkpoints.test.ts",
      "src/agents/finance-run-checkpoints.ts",
      "src/agents/tools/finance-outcome-ledger-read-tool.test.ts",
      "src/agents/tools/finance-outcome-ledger-read-tool.ts",
      "test/lcx-finance-research-run.test.ts",
      "test/lcx-flow-handoff-night-calibration.test.ts",
      "test/lcx-flow-handoff-finance-module-main.test.ts",
      "test/lcx-flow-handoff-finance-day-plan.test.ts",
      "test/fixtures/lcx-waterflow-finance-day-plan-probe.ts",
      "test/lcx-flow-handoff-finance-scheduler-plan.test.ts",
      "test/fixtures/lcx-waterflow-finance-scheduler-plan-probe.ts",
      "test/lcx-flow-handoff-finance-day-operator.test.ts",
      "test/fixtures/lcx-waterflow-finance-day-operator-probe.ts",
      "test/lcx-flow-handoff-finance-research-input.test.ts",
      "test/fixtures/lcx-waterflow-finance-research-input-probe.ts",
      "test/lcx-flow-handoff-finance-live-caller.test.ts",
      "test/fixtures/lcx-waterflow-finance-live-caller-probe.ts",
      "test/lcx-flow-handoff-night-review-independence.test.ts",
      "test/fixtures/lcx-waterflow-finance-module-main-probe.ts",
      "test/operator/lcx-finance-research-run.test.ts",
      "test/operator/lcx-finance-research-turn.test.ts",
      "test/operator/lcx-finance-research-workspace.test.ts",
    ],
  },
  {
    id: "architecture_supervision_entrypoints",
    ownerCluster: "architecture_supervision_cluster",
    ownerPath: "scripts/operator/lcx-mind-model.ts",
    watchedPathTerms: [
      "lcx-mind-model",
      "lcx-flow-graph",
      "lcx-head-tail-consistency",
      "lcx-context-recovery-exam",
      "lcx-problem-cluster-radar",
      "lcx-change-impact-plan",
      "lcx-governance-autopilot",
      "lcx-external-channel-binding",
      "lcx-universe-index",
      "lcx-system-doctor",
      "lcx-agent-exam",
    ],
    allowedPaths: [
      "scripts/operator/lcx-agent-exam.ts",
      "scripts/operator/lcx-change-impact-plan.ts",
      "scripts/operator/lcx-context-recovery-exam.ts",
      "scripts/operator/lcx-flow-graph.ts",
      "scripts/operator/lcx-governance-autopilot.ts",
      "scripts/operator/lcx-head-tail-consistency.ts",
      "scripts/operator/lcx-external-channel-binding.ts",
      "scripts/operator/lcx-mind-model.ts",
      "scripts/operator/lcx-problem-cluster-radar.ts",
      "scripts/operator/lcx-system-doctor.ts",
      "scripts/operator/lcx-universe-index.ts",
      "test/lcx-agent-exam.test.ts",
      "test/lcx-change-impact-plan.test.ts",
      "test/lcx-context-recovery-exam.test.ts",
      "test/lcx-flow-graph.test.ts",
      "test/lcx-flow-handoff-topology.test.ts",
      "test/lcx-governance-autopilot.test.ts",
      "test/lcx-head-tail-consistency.test.ts",
      "test/lcx-external-channel-binding.test.ts",
      "test/lcx-mind-model.test.ts",
      "test/lcx-problem-cluster-radar.test.ts",
      "test/lcx-system-doctor-council-health.test.ts",
      "test/lcx-system-doctor-dataset-inspect.test.ts",
      "test/lcx-system-doctor-train-slice.test.ts",
      "test/lcx-universe-index.test.ts",
      "test/lcx-universe-index-source.test.ts",
      "test/lcx-universe-index-deadline.test.ts",
    ],
  },
  {
    id: "universe_inventory_entrypoints",
    ownerCluster: "universe_inventory_cluster",
    ownerPath: "scripts/operator/lcx-universe-index.ts",
    watchedPathTerms: ["lcx-universe-index", "universe-index", "garbageCandidates"],
    allowedPaths: [
      "scripts/operator/lcx-universe-index.ts",
      "test/lcx-universe-index.test.ts",
      "test/lcx-universe-index-source.test.ts",
      "test/lcx-universe-index-deadline.test.ts",
      "test/lcx-flow-handoff-universe.test.ts",
      "test/fixtures/lcx-waterflow-universe-probe.ts",
      "test/fixtures/lcx-waterflow-universe-join-probe.ts",
      "test/lcx-flow-handoff-universe-join.test.ts",
    ],
  },
  {
    id: "learning_sedimentation_entrypoints",
    ownerCluster: "learning_internalization_cluster",
    ownerPath: "scripts/operator/module-learning-pipeline-review.ts",
    watchedPathTerms: ["module-learning", "learning-sedimentation", "system-memory-sedimentation"],
    allowedPaths: [
      "scripts/operator/lcx-learning-sedimentation-audit.ts",
      "scripts/operator/lcx-learning-sedimentation-bridge.ts",
      "scripts/operator/lcx-learning-sedimentation-map.ts",
      "scripts/operator/lcx-module-learning-absorption-gate.ts",
      "scripts/operator/lcx-system-memory-sedimentation-gate.ts",
      "scripts/operator/module-learning-pipeline-plan.ts",
      "scripts/operator/module-learning-pipeline-review.ts",
      "src/agents/module-learning-application-review.ts",
      "src/agents/module-learning-source-register.ts",
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
      "src/agents/tools/finance-learning-capability-inspect-tool.ts",
      "src/agents/tools/finance-learning-capability-apply-tool.ts",
      "test/lcx-flow-handoff-learning.test.ts",
      "test/lcx-flow-handoff-external-absorption.test.ts",
      "test/fixtures/lcx-waterflow-external-absorption-probe.ts",
      "test/fixtures/lcx-waterflow-learning-probe.ts",
      "test/lcx-flow-handoff-memory.test.ts",
      "test/fixtures/lcx-waterflow-memory-correction-probe.ts",
      "src/agents/self-repair-source-review.ts",
      "src/agents/self-repair-owner-map-feedback.ts",
      "test/lcx-flow-handoff-self-repair-feedback.test.ts",
      "test/fixtures/lcx-waterflow-self-repair-feedback-probe.ts",
      "test/fixtures/lcx-waterflow-self-repair-feedback-readback-probe.ts",
      "test/lcx-flow-handoff-self-repair-feedback-readback.test.ts",
      "test/fixtures/lcx-waterflow-self-repair-prewrite-probe.ts",
      "test/lcx-flow-handoff-self-repair-prewrite.test.ts",
      "src/agents/self-repair-source-review.test.ts",
      "src/agents/self-repair-candidate-review.ts",
      "test/lcx-flow-handoff-self-repair-review.test.ts",
      "test/fixtures/lcx-waterflow-self-repair-review-probe.ts",
      "test/lcx-flow-handoff-self-repair.test.ts",
      "test/fixtures/lcx-waterflow-self-repair-probe.ts",
      "test/lcx-flow-handoff-self-repair-owner-map.test.ts",
      "test/fixtures/lcx-waterflow-self-repair-owner-map-probe.ts",
    ],
  },
  {
    id: "external_visible_reply_audit_entrypoints",
    ownerCluster: "commercial_answer_pipeline_cluster",
    ownerPath: "scripts/operator/lcx-external-channel-status.ts",
    watchedPathTerms: [
      "external-message-envelope",
      "external-message-handoff",
      "reply-flow-audit",
      "answer-audit-policy",
      "external-channel-status",
      "commercial-answer",
      "visible-answer-adoption",
      "skill-autocue",
      "skillopt-autocue",
    ],
    allowedPaths: [
      "extensions/external/src/channel.ts",
      "extensions/external/src/monitor.test.ts",
      "extensions/external/src/monitor.ts",
      "extensions/external/src/protocol.test.ts",
      "extensions/external/src/protocol.ts",
      "extensions/external/src/send.test.ts",
      "extensions/external/src/send.ts",
      "src/agents/answer-audit-policy.ts",
      "src/agents/commercial-answer-pipeline.ts",
      "src/agents/commercial-answer-reply-gate.ts",
      "src/agents/visible-answer-adoption-gate.test.ts",
      "src/agents/visible-answer-adoption-gate.ts",
      "src/auto-reply/reply/get-reply-run.ts",
      "src/auto-reply/types.ts",
      "src/auto-reply/reply/agent-runner.ts",
      "src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts",
      "src/auto-reply/reply/followup-runner.ts",
      "src/auto-reply/reply/followup-runner.test.ts",
      "src/auto-reply/reply/commands-protocol-info.test.ts",
      "src/auto-reply/reply/commands-protocol-info.ts",
      "src/auto-reply/reply/skill-autocue.test.ts",
      "src/auto-reply/reply/skill-autocue.ts",
      "src/auto-reply/reply/skillopt-autocue.test.ts",
      "src/auto-reply/reply/skillopt-autocue.ts",
      "test/lcx-flow-handoff-skillopt.test.ts",
      "test/fixtures/lcx-waterflow-skillopt-probe.ts",
      "scripts/operator/lcx-commercial-answer-pipeline.ts",
      "scripts/operator/lcx-external-channel-status.ts",
      "test/lcx-external-channel-status.test.ts",
      "test/lcx-commercial-answer-pipeline.test.ts",
      "test/lcx-commercial-answer-pipeline-grounding.test.ts",
      "src/agents/provider-council-handoff.test.ts",
      "src/agents/provider-council-source-handoff.test.ts",
      "src/agents/provider-council-evidence.ts",
      "test/lcx-flow-handoff-external.test.ts",
      "test/fixtures/lcx-waterflow-external-probe.ts",
      "test/lcx-flow-handoff-language.test.ts",
      "test/fixtures/lcx-waterflow-language-probe.ts",
      "test/lcx-flow-handoff-language-default.test.ts",
      "test/fixtures/lcx-waterflow-language-default-probe.ts",
    ],
  },
  {
    id: "commercial_acceptance_harness_entrypoints",
    ownerCluster: "commercial_acceptance_harness_cluster",
    ownerPath: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    watchedPathTerms: ["commercial-acceptance", "commercial_acceptance", "product-canary"],
    allowedPaths: [
      "scripts/operator/lcx-commercial-acceptance-harness.ts",
      "test/lcx-commercial-acceptance-harness.test.ts",
      "test/lcx-flow-handoff-acceptance.test.ts",
      "test/fixtures/lcx-waterflow-acceptance-probe.ts",
    ],
  },
  {
    id: "focused_daily_research_product_entrypoints",
    ownerCluster: "focused_daily_research_product_cluster",
    ownerPath: "scripts/operator/lcx-directed-daily-research-brief.ts",
    watchedPathTerms: [
      "directed-daily-research",
      "finance-research-run",
      "finance-brain",
      "focused daily research",
      "index-options",
      "semiconductor",
    ],
    allowedPaths: [
      "scripts/operator/lcx-directed-daily-research-brief.ts",
      "scripts/operator/lcx-finance-research-run.ts",
      "src/agents/finance-brain-orchestration.test.ts",
      "src/agents/finance-brain-orchestration.ts",
      "src/agents/finance-research-runner.test.ts",
      "src/agents/finance-research-runner.intraday-projection.test.ts",
      "src/agents/finance-research-runner.ts",
      "src/agents/tools/finance-research-run-tool.test.ts",
      "src/agents/tools/finance-research-run-tool.ts",
      "src/agents/tools/finance-research-runs-read-tool.test.ts",
      "src/agents/tools/finance-research-runs-read-tool.ts",
      "test/lcx-directed-daily-research-brief.test.ts",
      "test/lcx-flow-handoff-directed-content-review.test.ts",
      "test/fixtures/lcx-waterflow-directed-content-review-probe.ts",
      "test/lcx-finance-research-run.test.ts",
      "test/operator/lcx-finance-research-run.test.ts",
    ],
  },
  {
    id: "qwen_training_operation_entrypoints",
    ownerCluster: "senior_trader_failure_focus_cluster",
    ownerPath: "scripts/operator/local-brain-training-plan.ts",
    watchedPathTerms: [
      "local-brain-distill-eval",
      "local-brain-promotion-audit",
      "local-brain-training-plan",
      "minimax-brain-training-guard",
      "minimax-brain-teacher-batch",
      "minimax-quota-brain-saturator",
    ],
    allowedPaths: [
      "scripts/operator/local-brain-distill-eval.ts",
      "scripts/operator/local-brain-promotion-audit.ts",
      "scripts/operator/local-brain-training-plan.ts",
      "scripts/operator/minimax-brain-teacher-batch.ts",
      "scripts/operator/minimax-brain-training-guard.ts",
      "scripts/operator/minimax-quota-brain-saturator.ts",
      "test/local-brain-distill-eval.test.ts",
      "test/local-brain-promotion-audit.test.ts",
      "test/local-brain-training-plan.test.ts",
      "test/minimax-brain-teacher-batch.test.ts",
      "test/minimax-brain-training-guard.test.ts",
      "test/minimax-brain-training-guard.cleanup.test.ts",
      "test/minimax-quota-brain-saturator-preview.test.ts",
    ],
  },
  {
    id: "local_live_evidence_entrypoints",
    ownerCluster: "local_live_evidence_cluster",
    ownerPath: "scripts/operator/lcx-external-channel-binding.ts",
    watchedPathTerms: [
      "lcx-external-channel-compat",
      "external-channel-binding",
      "external-channel-status",
    ],
    allowedPaths: [
      "scripts/operator/lcx-external-channel-binding.ts",
      "scripts/operator/lcx-external-channel-compat.ts",
      "scripts/operator/lcx-external-channel-status.ts",
      "test/lcx-external-channel-compat-status.test.ts",
      "test/lcx-external-channel-binding.test.ts",
      "test/lcx-external-channel-status.test.ts",
    ],
  },
  {
    id: "automation_digest_entrypoints",
    ownerCluster: "automation_digest_cluster",
    ownerPath: "scripts/operator/lcx-automation-repair-lock.ts",
    watchedPathTerms: [
      "automation-repair",
      "codex-archive",
      "lcx-local-operator",
      "operator-digest",
    ],
    allowedPaths: [
      "scripts/operator/lcx-automation-repair-lock.ts",
      "test/lcx-automation-repair-lock.test.ts",
      "test/lcx-local-operator-slot.test.ts",
      "test/lcx-flow-handoff-operator-digest.test.ts",
      "test/fixtures/lcx-waterflow-operator-digest-probe.ts",
      "test/lcx-flow-handoff-local-digest-whole.test.ts",
      "test/fixtures/lcx-waterflow-local-digest-whole-probe.ts",
    ],
  },
  {
    id: "external_skill_learning_entrypoints",
    ownerCluster: "external_skill_learning_cluster",
    ownerPath: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
    watchedPathTerms: [
      "agent-workflow",
      "external-agent-upgrade",
      "skill-pattern",
      "github-project-capability-intake",
    ],
    allowedPaths: [
      "scripts/operator/lcx-external-agent-upgrade-radar.ts",
      "test/lcx-external-agent-upgrade-radar.test.ts",
      "src/agents/provider-learning-council.ts",
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
      "finance-research-batch",
      "api-load-smoke",
      "source-registry",
    ],
    allowedPaths: [
      "src/agents/finance-data-gateway.test.ts",
      "src/agents/finance-realtime-source-registry.test.ts",
      "src/agents/finance-realtime-source-registry.ts",
      "src/agents/geospatial-source-registry.test.ts",
      "src/agents/geospatial-source-registry.ts",
      "scripts/operator/finance-data-gateway-live-smoke.ts",
      "scripts/operator/finance-data-gateway-smoke.ts",
      "scripts/operator/lcx-api-load-smoke.ts",
      "scripts/operator/lcx-finance-research-batch.ts",
      "src/agents/finance-data-gateway.ts",
      "src/agents/finance-research-batch-runner.test.ts",
      "src/agents/finance-research-batch-runner.ts",
      "src/agents/finance-research-batch.test.ts",
      "src/agents/finance-research-batch.ts",
      "src/agents/openclaw-tools.finance-article-source-registry-registration.test.ts",
      "src/agents/openclaw-tools.finance-data-gateway-registration.test.ts",
      "src/agents/tools/finance-article-source-registry-inspect-tool.ts",
      "src/agents/tools/finance-article-source-registry-record-tool.ts",
      "src/agents/tools/finance-article-source-registry-tools.test.ts",
      "src/agents/tools/finance-data-gateway-tool.test.ts",
      "src/agents/tools/finance-data-gateway-tool.ts",
      "src/agents/tools/finance-research-batch-tool.ts",
      "src/hooks/bundled/lobster-brain-registry.finance-article-source-registry.test.ts",
    ],
  },
  {
    id: "prediction_market_research_entrypoints",
    ownerCluster: "prediction_market_research_cluster",
    ownerPath: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
    watchedPathTerms: [
      "prediction-market",
      "polymarket",
      "market-microstructure",
      "strategy-experiment",
    ],
    allowedPaths: [
      "scripts/operator/lcx-external-agent-upgrade-radar.ts",
      "test/lcx-flow-handoff-prediction-market.test.ts",
      "test/fixtures/lcx-waterflow-prediction-market-probe.ts",
      "test/fixtures/lcx-waterflow-prediction-source-handoff-eighteenth-probe.ts",
      "test/lcx-flow-handoff-prediction-source-handoff-eighteenth.test.ts",
    ],
  },
];

export const SHARED_ENTRYPOINT_OWNERS: SharedEntrypointOwner[] = [
  {
    path: "scripts/operator/lcx-external-channel-binding.ts",
    familyIds: ["architecture_supervision_entrypoints", "local_live_evidence_entrypoints"],
    reason:
      "external-channel binding is both part of architecture supervision and the current owner for External channel proof.",
  },
  {
    path: "scripts/operator/lcx-external-channel-status.ts",
    familyIds: ["local_live_evidence_entrypoints", "external_visible_reply_audit_entrypoints"],
    reason:
      "external-channel status is the shared proof surface for visible answer audit and channel-boundary evidence.",
  },
  {
    path: "test/lcx-external-channel-binding.test.ts",
    familyIds: ["architecture_supervision_entrypoints", "local_live_evidence_entrypoints"],
    reason:
      "the external-channel binding test covers both architecture wiring and the local live evidence owner.",
  },
  {
    path: "test/lcx-external-channel-status.test.ts",
    familyIds: ["local_live_evidence_entrypoints", "external_visible_reply_audit_entrypoints"],
    reason:
      "the external-channel status test covers both local binding evidence and visible reply status reporting.",
  },
  {
    path: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
    familyIds: ["external_skill_learning_entrypoints", "prediction_market_research_entrypoints"],
    reason: "external-agent upgrade radar also owns prediction-market source intake boundaries.",
  },
  {
    path: "scripts/operator/lcx-universe-index.ts",
    familyIds: ["architecture_supervision_entrypoints", "universe_inventory_entrypoints"],
    reason:
      "universe index is both part of the architecture supervision stack and the owner for total inventory.",
  },
  {
    path: "test/lcx-universe-index.test.ts",
    familyIds: ["architecture_supervision_entrypoints", "universe_inventory_entrypoints"],
    reason:
      "the universe-index test is the shared proof for architecture wiring and inventory ownership.",
  },
  {
    path: "test/lcx-universe-index-source.test.ts",
    familyIds: ["architecture_supervision_entrypoints", "universe_inventory_entrypoints"],
    reason:
      "the universe source tests verify inventory completeness and its existing governance handoff.",
  },
  {
    path: "test/lcx-universe-index-deadline.test.ts",
    familyIds: ["architecture_supervision_entrypoints", "universe_inventory_entrypoints"],
    reason:
      "the original Universe deadline test verifies bounded collection and failure propagation to existing governance consumers.",
  },
  {
    path: "src/agents/finance-research-batch-runner.test.ts",
    familyIds: ["finance_caseflow_entrypoints", "finance_data_quality_entrypoints"],
    reason:
      "the batch-runner test covers both finance lifecycle orchestration and the data-quality batch boundary.",
  },
  {
    path: "src/agents/finance-research-batch-runner.ts",
    familyIds: ["finance_caseflow_entrypoints", "finance_data_quality_entrypoints"],
    reason:
      "the batch runner is shared by the finance lifecycle owner and the data-quality batch boundary.",
  },
  {
    path: "src/agents/finance-research-runner.test.ts",
    familyIds: ["finance_caseflow_entrypoints", "focused_daily_research_product_entrypoints"],
    reason:
      "the research-runner test covers both caseflow lifecycle orchestration and focused daily research.",
  },
  {
    path: "src/agents/finance-research-runner.intraday-projection.test.ts",
    familyIds: ["finance_caseflow_entrypoints", "focused_daily_research_product_entrypoints"],
    reason:
      "the original shared research runner's intraday projection regression verifies bounded producer inputs without dropping rule or broker evidence; it belongs to the same two existing runner owners.",
  },
  {
    path: "src/agents/finance-research-runner.ts",
    familyIds: ["finance_caseflow_entrypoints", "focused_daily_research_product_entrypoints"],
    reason:
      "the research runner is shared by the caseflow lifecycle owner and focused daily research product.",
  },
  {
    path: "scripts/operator/lcx-finance-research-run.ts",
    familyIds: ["finance_caseflow_entrypoints", "focused_daily_research_product_entrypoints"],
    reason:
      "the finance research operator is the shared execution surface for the caseflow lifecycle and focused daily research product.",
  },
  {
    path: "test/lcx-finance-research-run.test.ts",
    familyIds: ["finance_caseflow_entrypoints", "focused_daily_research_product_entrypoints"],
    reason:
      "the finance research operator test proves both caseflow wiring and focused daily research product registration.",
  },
  {
    path: "test/operator/lcx-finance-research-run.test.ts",
    familyIds: ["finance_caseflow_entrypoints", "focused_daily_research_product_entrypoints"],
    reason:
      "the finance research CLI test proves both caseflow wiring and focused daily research product registration.",
  },
  {
    path: "scripts/operator/lcx-finance-research-batch.ts",
    familyIds: ["finance_caseflow_entrypoints", "finance_data_quality_entrypoints"],
    reason:
      "the batch operator is shared by the finance lifecycle owner and the data-quality batch boundary.",
  },
];

export const FLOW_DIAGNOSTIC_OWNER_BY_SCENARIO_ID: Record<string, string> = {
  finance_caseflow_waterflow: "scripts/operator/lcx-finance-research.ts",
  external_finance_research_waterflow: "scripts/operator/lcx-commercial-answer-pipeline.ts",
  directed_daily_research_brief_waterflow: "scripts/operator/lcx-directed-daily-research-brief.ts",
  module_learning_internalization_waterflow: "scripts/operator/module-learning-pipeline-review.ts",
  training_failure_feedback_waterflow: "scripts/operator/local-brain-training-plan.ts",
  local_to_external_channel_external_waterflow: "scripts/operator/lcx-external-channel-binding.ts",
  skillopt_runtime_self_use_waterflow: "scripts/operator/lcx-skillopt-lite.ts",
  compressed_context_recovery_waterflow: "scripts/operator/lcx-context-recovery-exam.ts",
  universe_index_total_coverage_waterflow: "scripts/operator/lcx-universe-index.ts",
  local_automation_digest_waterflow: "host-installed:lcx-local-operator-loop.sh",
  central_agent_decision_waterflow: "scripts/operator/lcx-central-agent.ts",
  external_visible_language_waterflow: "src/agents/visible-answer-adoption-gate.ts",
  commercial_answer_pipeline_waterflow: "scripts/operator/lcx-commercial-answer-pipeline.ts",
  commercial_acceptance_harness_waterflow: "scripts/operator/lcx-commercial-acceptance-harness.ts",
  provider_council_evidence_waterflow: "src/agents/provider-learning-council.ts",
  memory_correction_downrank_waterflow: "scripts/operator/lcx-system-memory-sedimentation-gate.ts",
  self_repair_hands_waterflow: "scripts/operator/lcx-self-repair-hands.ts",
  finance_data_gateway_waterflow: "src/agents/finance-data-gateway.ts",
  senior_trader_failure_focus_waterflow: "scripts/operator/local-brain-distill-eval.ts",
  similar_engineering_consolidation_waterflow: "scripts/operator/lcx-change-impact-plan.ts",
  external_agent_skill_distillation_waterflow:
    "scripts/operator/lcx-external-agent-upgrade-radar.ts",
  multi_agent_pattern_shadow_evaluation_waterflow:
    "scripts/operator/lcx-multi-agent-pattern-shadow.ts",
  logical_agent_pool_waterflow: "scripts/operator/lcx-logical-agent-pool.ts",
  prediction_market_research_only_waterflow: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
  finance_intraday_paper_waterflow: "scripts/operator/lcx-finance-intraday-paper.ts",
  finance_live_execution_waterflow: "scripts/operator/lcx-finance-live-execution.ts",
  finance_automatic_paper_trading_waterflow: "scripts/operator/lcx-finance-scheduler.ts",
  automation_repair_lock_waterflow: "scripts/operator/lcx-automation-repair-lock.ts",
};

const FLOW_DIAGNOSTIC_FAST_CHECK_BY_SCENARIO_ID: Record<string, string> = {
  external_finance_research_waterflow:
    "node --import tsx scripts/operator/lcx-flow-graph.ts --json",
  directed_daily_research_brief_waterflow:
    "node --import tsx scripts/operator/lcx-directed-daily-research-brief.ts --json",
  module_learning_internalization_waterflow:
    "node --import tsx scripts/operator/module-learning-pipeline-review.ts --json",
  training_failure_feedback_waterflow:
    "node --import tsx scripts/operator/local-brain-training-plan.ts --json",
  local_to_external_channel_external_waterflow:
    "node --import tsx scripts/operator/lcx-external-channel-binding.ts --json",
  skillopt_runtime_self_use_waterflow:
    "node --import tsx scripts/operator/lcx-skillopt-lite.ts --phase candidate-edit --no-write --json",
  compressed_context_recovery_waterflow:
    "node --import tsx scripts/operator/lcx-context-recovery-exam.ts --json",
  universe_index_total_coverage_waterflow:
    "node --import tsx scripts/operator/lcx-universe-index.ts --json",
  local_automation_digest_waterflow: "node --import tsx scripts/operator/lcx-flow-graph.ts --json",
  external_visible_language_waterflow:
    "node --import tsx scripts/operator/lcx-external-channel-status.ts --json",
  commercial_answer_pipeline_waterflow:
    "node --import tsx scripts/operator/lcx-commercial-answer-pipeline.ts --json",
  commercial_acceptance_harness_waterflow:
    "node --import tsx scripts/operator/lcx-commercial-acceptance-harness.ts --json",
  provider_council_evidence_waterflow:
    "node --import tsx scripts/operator/lcx-system-doctor.ts --json",
  memory_correction_downrank_waterflow:
    "node --import tsx scripts/operator/lcx-system-memory-sedimentation-gate.ts --json",
  self_repair_hands_waterflow: "node --import tsx scripts/operator/lcx-self-repair-hands.ts --json",
  finance_data_gateway_waterflow:
    "node --import tsx scripts/operator/finance-data-gateway-smoke.ts --json",
  senior_trader_failure_focus_waterflow:
    "node --import tsx scripts/operator/local-brain-distill-eval.ts --contract-only --case-id senior_trader_failure_focus_promotion_chain --summary-only --json",
  similar_engineering_consolidation_waterflow:
    "node --import tsx scripts/operator/lcx-change-impact-plan.ts --json",
  external_agent_skill_distillation_waterflow:
    "node --import tsx scripts/operator/lcx-external-agent-upgrade-radar.ts --json",
  multi_agent_pattern_shadow_evaluation_waterflow:
    "node --import tsx scripts/operator/lcx-multi-agent-pattern-shadow.ts --mode replay --pattern all --case single_stock_loss_recovery_risk_triage --json",
  logical_agent_pool_waterflow:
    "node --import tsx scripts/operator/lcx-logical-agent-pool.ts --demo --json",
  prediction_market_research_only_waterflow:
    "node --import tsx scripts/operator/lcx-external-agent-upgrade-radar.ts --json",
  finance_intraday_paper_waterflow:
    "pnpm exec vitest run src/agents/finance-intraday-ledger.test.ts src/agents/finance-intraday-paper.test.ts",
  finance_live_execution_waterflow:
    "pnpm exec vitest run test/operator/lcx-finance-live-execution.test.ts",
  finance_automatic_paper_trading_waterflow:
    "node --import tsx scripts/operator/lcx-flow-graph.ts --json",
  automation_repair_lock_waterflow:
    "node --import tsx scripts/operator/lcx-automation-repair-lock.ts --mode status --json",
};

const SURFACE_FILES: Record<SurfaceGroup, readonly string[]> = {
  head: ["AGENTS.md", "README.md", "ops/local-brain/README.md", "src/agents/system-prompt.ts"],
  workflow: [
    "scripts/operator/lcx-flow-graph.ts",
    "scripts/operator/lcx-governance-autopilot.ts",
    "scripts/operator/lcx-skillopt-lite.ts",
    "scripts/operator/lcx-mind-model.ts",
    "scripts/operator/lcx-external-channel-binding.ts",
    "scripts/operator/lcx-head-tail-consistency.ts",
    "scripts/operator/lcx-context-recovery-exam.ts",
    "scripts/operator/lcx-system-doctor.ts",
    "scripts/operator/lcx-self-repair-hands.ts",
    "scripts/operator/lcx-universe-index.ts",
    "scripts/operator/lcx-commercial-answer-pipeline.ts",
    "scripts/operator/lcx-commercial-acceptance-harness.ts",
    "scripts/operator/lcx-directed-daily-research-brief.ts",
    "scripts/operator/lcx-finance-research-run.ts",
    "scripts/operator/lcx-learning-sedimentation-bridge.ts",
    "scripts/operator/lcx-learning-sedimentation-audit.ts",
    "scripts/operator/lcx-learning-sedimentation-map.ts",
    "scripts/operator/lcx-module-learning-absorption-gate.ts",
    "scripts/operator/lcx-system-memory-sedimentation-gate.ts",
    "scripts/operator/finance-data-gateway-smoke.ts",
    "scripts/operator/local-brain-training-plan.ts",
    "scripts/operator/local-brain-distill-eval.ts",
    "scripts/operator/minimax-brain-training-guard.ts",
    "scripts/operator/minimax-brain-teacher-batch.ts",
    "scripts/operator/module-learning-pipeline-plan.ts",
    "scripts/operator/module-learning-pipeline-review.ts",
    "scripts/operator/lcx-external-channel-binding.ts",
    "scripts/operator/lcx-external-channel-status.ts",
    "extensions/external/src/channel.ts",
    "extensions/external/src/monitor.ts",
    "extensions/external/src/send.ts",
    "src/auto-reply/reply/get-reply-run.ts",
    "src/auto-reply/reply/skillopt-autocue.ts",
    "src/agents/finance-data-gateway.ts",
    "src/agents/tools/finance-data-gateway-tool.ts",
    "scripts/operator/lcx-central-agent.ts",
    "src/agents/central-harness/harness-loop.ts",
    "src/agents/central-harness/tool-registry.ts",
    "src/agents/central-harness/model-brain.ts",
    "src/agents/central-harness/types.ts",
  ],
  proof: [
    "scripts/operator/lcx-flow-graph.ts",
    "scripts/operator/lcx-governance-autopilot.ts",
    "test/lcx-flow-graph.test.ts",
    "test/lcx-governance-autopilot.test.ts",
    "test/lcx-skillopt-lite.test.ts",
    "src/auto-reply/reply/skillopt-autocue.test.ts",
    "test/lcx-mind-model.test.ts",
    "test/lcx-context-recovery-exam.test.ts",
    "test/lcx-self-repair-hands.test.ts",
    "test/lcx-universe-index.test.ts",
    "test/lcx-commercial-answer-pipeline.test.ts",
    "test/lcx-commercial-acceptance-harness.test.ts",
    "test/lcx-finance-research-run.test.ts",
    "test/lcx-learning-sedimentation-bridge.test.ts",
    "test/lcx-learning-sedimentation-audit.test.ts",
    "test/lcx-learning-sedimentation-map.test.ts",
    "test/lcx-module-learning-absorption-gate.test.ts",
    "test/lcx-system-memory-sedimentation-gate.test.ts",
    "test/local-brain-distill-eval.test.ts",
    "test/local-brain-contracts.test.ts",
    "test/lcx-external-channel-compat-status.test.ts",
    "test/lcx-external-channel-binding.test.ts",
    "test/lcx-central-agent.test.ts",
  ],
  boundary: [
    "AGENTS.md",
    "README.md",
    "ops/local-brain/README.md",
    "scripts/operator/lcx-flow-graph.ts",
    "scripts/operator/lcx-universe-index.ts",
    "scripts/operator/lcx-skillopt-lite.ts",
    "scripts/operator/lcx-self-repair-hands.ts",
    "scripts/operator/lcx-external-channel-binding.ts",
    "scripts/operator/local-brain-training-plan.ts",
    "src/agents/tools/module-learning-pipeline-review-tool.ts",
    "src/auto-reply/reply/skillopt-autocue.ts",
    "scripts/operator/lcx-central-agent.ts",
    "src/agents/central-harness/harness-loop.ts",
    "src/agents/central-harness/tool-registry.ts",
    "src/agents/central-harness/types.ts",
  ],
};

const SURFACE_TERMS: Record<SurfaceGroup, string[]> = {
  head: [
    "LCX Agent Flow Graph",
    "waterflow",
    "wrong-flow",
    "filter valve",
    "bounded feedback",
    "Central Agent Harness",
  ],
  workflow: [
    "FLOW_SCENARIOS",
    "requiredFilters",
    "feedbackEdges",
    "ILLEGAL_EDGES",
    "central_agent_decision_waterflow",
    "gate_and_record_only",
    "CENTRAL_FORBIDDEN_SIDE_EFFECTS",
  ],
  proof: [
    "flow_graph_exam",
    "missingRequiredFilters",
    "test/lcx-flow-graph.test.ts",
    "test/lcx-central-agent.test.ts",
  ],
  boundary: [
    "local_flow_graph_only",
    "liveTouched",
    "providerConfigTouched",
    "protectedMemoryTouched",
    "same_philosophy_merge_required",
    "local_central_agent_observe_only",
    "llm_proposes_ts_gate_approves",
  ],
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-flow-graph.ts [--json] [--handoff-evidence <local-index.json>]",
      "",
      "Read-only LCX Agent flow graph exam. It checks that task waterflows pass",
      "through required nodes, filters, receipts, and bounded feedback gates.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]) {
  const options: { json: boolean; handoffEvidence?: string } = { json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--handoff-evidence") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error("--handoff-evidence requires a local receipt index path");
      }
      options.handoffEvidence = args[++index];
      continue;
    }
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

/** Contract edges describe required handoffs; they do not stand for executed receipts. */
export function workflowControlEdges(
  scenario: FlowScenario,
): readonly (readonly [FlowNodeId, FlowNodeId])[] {
  const contract = LCX_ONTOLOGY_REGISTRY.workflowProcesses[scenario.id];
  return "controlEdges" in contract ? contract.controlEdges : [];
}

export function workflowProcessEdges(scenario: FlowScenario): LcxOntologyEdge[] {
  const contract = LCX_ONTOLOGY_REGISTRY.workflowProcesses[scenario.id];
  const controlEdges = new Set(workflowControlEdges(scenario).map(edgeKey));
  const edges: LcxOntologyEdge[] = [];
  for (const stage of contract.stages) {
    for (const node of stage.nodes) {
      const subject = { type: "workflow" as const, id: `${scenario.id}:${node}` };
      const policy = { type: "policy" as const, id: `${subject.id}:preconditions` };
      edges.push(
        { relation: "owned_by", subject, object: { type: "module", id: stage.owner } },
        { relation: "requires", subject, object: policy },
        { relation: "blocks", subject: policy, object: subject },
        {
          relation: "produces",
          subject,
          object: { type: "artifact", id: `${subject.id}:output_contract` },
        },
      );
    }
  }
  for (const [from, to] of [...scenario.edges, ...(scenario.feedbackEdges ?? [])]) {
    edges.push({
      relation: "requires",
      subject: { type: "workflow", id: `${scenario.id}:${to}` },
      object: controlEdges.has(edgeKey([from, to]))
        ? { type: "policy", id: `${scenario.id}:${from}:dispatch_contract:${to}` }
        : { type: "artifact", id: `${scenario.id}:${from}:output_contract` },
    });
  }
  return edges;
}

async function processContractCheck(): Promise<FlowCheck> {
  const gaps: string[] = [];
  const implementationGaps: Array<{ scenario: string; owner: string; nodes: readonly string[] }> =
    [];
  for (const scenario of FLOW_SCENARIOS) {
    const contract = LCX_ONTOLOGY_REGISTRY.workflowProcesses[scenario.id];
    const controlEdges = workflowControlEdges(scenario);
    const declaredEdges = new Set(scenario.edges.map(edgeKey));
    const seenControlEdges = new Set<string>();
    for (const edge of controlEdges) {
      const key = edgeKey(edge);
      if (!declaredEdges.has(key) || seenControlEdges.has(key)) {
        gaps.push(`${scenario.id}:invalid_control_dispatch_edge:${key}`);
      }
      seenControlEdges.add(key);
    }
    const nodes = new Set<string>(contract.stages.flatMap((stage) => [...stage.nodes]));
    for (const node of new Set([
      ...scenario.requiredNodes,
      ...(scenario.feedbackEdges ?? []).flat(),
    ])) {
      if (!nodes.has(node)) {
        gaps.push(`${scenario.id}:unowned_node:${node}`);
      }
    }
    for (const stage of contract.stages) {
      if (
        "implementationStatus" in stage &&
        stage.implementationStatus === "required_not_implemented"
      ) {
        implementationGaps.push({ scenario: scenario.id, owner: stage.owner, nodes: stage.nodes });
      }
      if (!stage.input.trim() || !stage.output.trim() || !stage.preconditions.trim()) {
        gaps.push(`${scenario.id}:missing_process_semantics:${stage.owner}`);
      }
    }
    for (const owner of new Set([
      contract.entrypoint,
      ...contract.stages.map((stage) => stage.owner),
    ])) {
      if (!(await readProcessOwnerSource(owner))) {
        gaps.push(`${scenario.id}:missing_owner:${owner}`);
      }
    }
    gaps.push(
      ...validateLcxOntologyEdges(workflowProcessEdges(scenario)).map(
        (gap) => `${scenario.id}:${gap}`,
      ),
    );
  }
  return {
    id: "workflow_process_semantics",
    ok: gaps.length === 0,
    summary:
      "declared source owners, inputs, outputs and prerequisites are structurally mapped; missing implementations remain separate gaps",
    evidence: {
      gaps,
      implementationGaps,
      proofLevel: "structure_only",
      scenarios: FLOW_SCENARIOS.length,
    },
  };
}

/** References select fields in original owner receipts. This index contains no business state. */
export type WorkflowFieldRef = {
  /** Fingerprint a selected native JSON field; raw receipt SHA and alias checks stay separate. */
  encoding?: "canonical_json_sha256";
  path: string;
  pointer: string;
  sha256: string;
  /** Select exact JSON fields inside original text transports, without copying business data. */
  json?: Array<{ pointer: string; after?: string }>;
};
/** A consumer's recorded provenance may bridge runs; it never changes either native scope. */
export type WorkflowScopeBinding = {
  receipt: WorkflowFieldRef;
  workspace?: WorkflowFieldRef;
  sourceScope: WorkflowFieldRef;
} & (
  | {
      /** Original host custody relates native tool/batch/Quality IDs without changing them. */
      kind: "native_finance_tool_custody";
      rawReceipt: WorkflowFieldRef;
    }
  | {
      /** Global rule projection and this invocation's actual rule packet/selection. */
      kind: "active_strategy_rule_input";
      portfolioContext: WorkflowFieldRef;
      asOf: WorkflowFieldRef;
      consumerRunId: WorkflowFieldRef;
      parentRunId: WorkflowFieldRef;
    }
  | {
      /** Original scheduler bytes bind the child invocation without merging their native IDs. */
      kind: "scheduled_research_input";
      expectedPin: WorkflowFieldRef;
      manifest: WorkflowFieldRef;
      sourceAccount: WorkflowFieldRef;
      targetAccount: WorkflowFieldRef;
      targetVenue: WorkflowFieldRef;
      targetAsOf: WorkflowFieldRef;
      consumerRunId: WorkflowFieldRef;
    }
  | {
      /** Raw forecast-book custody only; it never creates an account or execution authority. */
      kind: "finance_book_custody";
      writer: WorkflowFieldRef;
      callerInput: WorkflowFieldRef;
      callerSource: WorkflowFieldRef;
      ledgerRaw: Readonly<{ path: string; sha256: string; bytes: number }>;
    }
  | {
      /** Later failed-reader custody is side evidence, never a replacement scheduler run. */
      kind: "portfolio_plan_failed_read";
      plan: WorkflowFieldRef;
      writePin: WorkflowFieldRef;
      sourceReceipt: WorkflowFieldRef;
      rawPlan: WorkflowFieldRef;
      handoffManifest: WorkflowFieldRef;
      schedulerReceipt: WorkflowFieldRef;
      actualOperatorArgv: WorkflowFieldRef;
      originalReaderSourcePin: WorkflowFieldRef;
      originalReaderSource: Pick<WorkflowFieldRef, "path" | "sha256">;
      receiver: WorkflowFieldRef;
      receiverSource: WorkflowFieldRef;
      replayArgv: WorkflowFieldRef;
    }
  | {
      /** Current-question custody only; ask hashes are never financial/run identities. */
      kind: "commercial_question_requirements";
      producerPacket: WorkflowFieldRef;
      callerProof: WorkflowFieldRef;
      projectionSideproof: WorkflowFieldRef;
      actualModelRequests: WorkflowFieldRef;
      helperSource: Pick<WorkflowFieldRef, "path" | "sha256">;
      plannerSource: Pick<WorkflowFieldRef, "path" | "sha256">;
    }
  | {
      kind: "historical_to_attempt";
      sourceAccount: WorkflowFieldRef;
      targetAccount: WorkflowFieldRef;
    }
  | {
      /** Revalidate the original owner's actual historical source/account and selected read. */
      kind: "verified_memory_read";
      memoryRecall: WorkflowFieldRef;
      expectedMemoryScope: WorkflowFieldRef;
      artifactStorePath: WorkflowFieldRef;
    }
  | {
      kind: "read_only_observation";
      hostRunId: WorkflowFieldRef;
      ownerParentRunId: WorkflowFieldRef;
      ownerSnapshot: WorkflowFieldRef;
      ownerPhase: WorkflowFieldRef;
    }
);
export type WorkflowHandoffEvidence = {
  scenarioId: FlowScenarioId;
  environment: "offline_fixture" | "natural_receipt";
  /** Debug call ancestry proves only a failed dispatch attempt, never child execution or scope. */
  controlAttempts?: Array<{
    from: "local_operator_loop";
    to: "training_plan" | "mind_model" | "flow_graph" | "external_channel_binding";
    receipt: WorkflowFieldRef;
  }>;
  /** One native awaited cooldown may resume the next quota invocation without text adoption. */
  controlContinuations?: Array<{
    kind: "training_cooldown_resume";
    from: "evolution_cooldown";
    to: "teacher_quota";
    receipt: WorkflowFieldRef;
    guardSource: Pick<WorkflowFieldRef, "path" | "sha256">;
  }>;
  /** A later original candidate receipt may independently consume this diagnostic feedback. */
  feedbackReads?: Array<
    | {
        kind: "directed_review_diagnostic";
        from: "review_panel";
        to: "finance_research_modules";
        /** Original receipt plus retained original bytes; no synthesized business fields. */
        receipt: WorkflowFieldRef;
        source: WorkflowFieldRef;
      }
    | {
        kind: "self_repair_diagnostic";
        from: "owner_coverage_map";
        to: "self_repair_hands";
        receipt: WorkflowFieldRef;
      }
    | {
        kind: "commercial_refusal_diagnostic";
        from: "local_contract_audit";
        to: "local_brain_planner";
        receipt: WorkflowFieldRef;
      }
  >;
  nodes: Array<{
    nodeId: FlowNodeId;
    scope: WorkflowFieldRef;
    output?: WorkflowFieldRef;
    /** Original fork outputs may select different fields for different consumers. */
    outputs?: Array<{ to: FlowNodeId; value: WorkflowFieldRef }>;
    inputs?: Array<{
      from: FlowNodeId;
      value: WorkflowFieldRef;
      scopeBinding?: WorkflowScopeBinding;
    }>;
    block?: { filter: FlowFilterId; status: WorkflowFieldRef; reason: WorkflowFieldRef };
  }>;
};

async function verifyDirectedReviewDiagnosticFeedback(
  ref: WorkflowFieldRef,
  originalSource: WorkflowFieldRef,
  producer: {
    receipt: WorkflowFieldRef;
    scope: string;
    output?: string;
    outputs: Map<string, string>;
  },
) {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const body = object(JSON.parse(await readHandoffField(ref)) as unknown);
  const result = object(body?.result);
  const task = object(result?.taskExecution);
  const host = object(task?.host);
  const recorded = object(task?.reviewFeedback);
  const request = object(body?.nextRequest);
  const workspace = body?.retainedWorkspace;
  if (
    !body ||
    !host ||
    !request ||
    !recorded ||
    task?.status !== "executed" ||
    typeof workspace !== "string" ||
    !path.isAbsolute(workspace) ||
    typeof host.accountId !== "string" ||
    typeof host.runId !== "string" ||
    host.accountId !== request.accountId ||
    host.runId !== request.runId ||
    request.taskId !== "risk_gate_and_learning_loop"
  ) {
    throw new Error("directed_feedback_original_caller_missing");
  }
  // Original pure reader rechecks archive, Caseflow, account, target, time and source hashes.
  const fresh = await readDirectedReviewFeedback(
    workspace,
    request as Parameters<typeof readDirectedReviewFeedback>[1],
    new AbortController().signal,
  );
  if (
    fresh.receipt.status !== "forwarded_to_original_runner" ||
    !isDeepStrictEqual(recorded, fresh.receipt) ||
    !isDeepStrictEqual(fresh.receipt.sourceScope, JSON.parse(producer.scope) as unknown)
  ) {
    throw new Error("directed_feedback_source_or_scope_conflict");
  }
  const source = fresh.receipt.pins[0];
  if (
    !source ||
    path.resolve(workspace, source.path) !== path.resolve(originalSource.path) ||
    source.sha256 !== originalSource.sha256
  ) {
    throw new Error("directed_feedback_archive_conflict");
  }
  const retainedSource = JSON.parse(await readHandoffField(originalSource)) as unknown;
  if (!isDeepStrictEqual(object(body.published)?.review, retainedSource)) {
    throw new Error("directed_feedback_native_producer_conflict");
  }
  const expectedReview = buildDirectedContentReviewInput(retainedSource);
  const reviewRequests = object(body.published)?.actualReviewRequests;
  const capturedReview = Array.isArray(reviewRequests) ? reviewRequests.map(object) : [];
  const expectedBodies = expectedReview.request.evidence.filter((item) =>
    item.id.endsWith(":directed-candidate-body"),
  );
  const capturedBodies = capturedReview
    .flatMap((item) => (Array.isArray(item?.evidence) ? item.evidence.map(object) : []))
    .filter((item) => typeof item?.id === "string" && item.id.endsWith(":directed-candidate-body"));
  if (
    !expectedBodies.every((expected) =>
      capturedBodies.some((actual) => isDeepStrictEqual(actual, expected)),
    ) ||
    !capturedBodies.every((actual) =>
      expectedBodies.some((expected) => isDeepStrictEqual(actual, expected)),
    )
  ) {
    throw new Error("directed_feedback_original_review_body_conflict");
  }
  const read = await readDirectedDailyCases({
    workspaceDir: workspace,
    date: String(request.date),
    bindingsFile: String(task?.bindingsFile),
    batchHost: host as NonNullable<Parameters<typeof readDirectedDailyCases>[0]["batchHost"]>,
  });
  const section = read.packetCandidateSections.find((item) => item.taskId === request.taskId);
  const diagnostic = fresh.evidence[0];
  if (!diagnostic || !section?.evidence?.some((item) => isDeepStrictEqual(item, diagnostic))) {
    throw new Error("directed_feedback_not_in_original_case");
  }
  const selected = producer.outputs.get("finance_research_modules") ?? producer.output;
  const findings: unknown = object(JSON.parse(diagnostic.text) as unknown)?.findings;
  if (
    !selected ||
    !Array.isArray(findings) ||
    !findings.some((item) => JSON.stringify(item) === selected)
  ) {
    throw new Error("directed_feedback_finding_not_consumed");
  }
  const snapshot = object(section.originalSnapshot);
  const plan = object(snapshot?.plan);
  const modules = object(snapshot?.moduleExecution);
  if (!isDeepStrictEqual(object(task?.researchReceipt)?.moduleExecution, modules)) {
    throw new Error("directed_feedback_native_module_receipt_conflict");
  }
  const nodes = Array.isArray(modules?.nodes) ? modules.nodes.map(object) : [];
  const learning = nodes.find((item) => item?.moduleId === "finance_learning_memory");
  const calls = Array.isArray(learning?.toolCalls) ? learning.toolCalls.map(object) : [];
  const call = calls.find((item) => item?.toolName === "finance_learning_capability_apply");
  if (
    typeof plan?.ask !== "string" ||
    typeof plan.asOf !== "string" ||
    typeof call?.outputSummary !== "string"
  ) {
    throw new Error("directed_feedback_original_tool_not_observed");
  }
  const tool = object(JSON.parse(call.outputSummary) as unknown);
  const expected = buildFinanceLearningModuleInput(plan.ask, plan.asOf, section.evidence);
  if (
    tool?.queryText !== expected.queryText ||
    !expected.feedbackEvidenceIds.includes(diagnostic.id) ||
    !Array.isArray(call.inputEvidenceIds) ||
    !call.inputEvidenceIds.includes(diagnostic.id) ||
    section.learningApplication?.sourceReadStatus !== "verified"
  ) {
    throw new Error("directed_feedback_tool_query_conflict");
  }
  const requests = Array.isArray(body.actualNextRequests)
    ? body.actualNextRequests.map(object)
    : [];
  const received = requests.flatMap((item) =>
    Array.isArray(item?.evidence) ? item.evidence.map(object) : [],
  );
  if (
    !received.some((item) => item?.source === diagnostic.source && item.text === diagnostic.text)
  ) {
    throw new Error("directed_feedback_model_input_not_observed");
  }
  if (tool?.ok === false) {
    const refusal = section.evidence.find(
      (item) =>
        item.id.endsWith(":diagnostic") &&
        item.source === "finance-module-execution" &&
        item.text.includes("module_refusal_diagnostic_not_market_evidence"),
    );
    if (
      !refusal ||
      !received.some((item) => item?.id === refusal.id && item.text === refusal.text)
    ) {
      throw new Error("directed_feedback_refusal_not_in_model_input");
    }
  }
}

/** Verify the retained debug call chain; this never observes a child owner body or business scope. */
async function verifyAcceptanceControlAttempt(
  witness: NonNullable<WorkflowHandoffEvidence["controlAttempts"]>[number],
  producer: { receipt: WorkflowFieldRef; scope: string } | undefined,
): Promise<void> {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const equal = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);
  const proof = object(JSON.parse(await readHandoffField(witness.receipt)) as unknown);
  const captureRef = object(proof.capture) as WorkflowFieldRef;
  const capture = object(
    JSON.parse(await readHandoffField({ ...captureRef, pointer: "" })) as unknown,
  );
  const transportRef = object(proof.transport) as WorkflowFieldRef;
  const transport = object(
    JSON.parse(await readHandoffField({ ...transportRef, pointer: "" })) as unknown,
  );
  if (
    !producer ||
    path.resolve(producer.receipt.path) !== path.resolve(captureRef.path) ||
    producer.receipt.sha256 !== captureRef.sha256 ||
    !equal(JSON.parse(producer.scope), capture.identity)
  ) {
    throw new Error("parent_observation_not_in_trace");
  }
  const sourcePins = object(proof.sourcePins),
    source = object(sourcePins.source);
  if (
    typeof source.archive !== "string" ||
    typeof source.sha256 !== "string" ||
    typeof source.path !== "string" ||
    !source.path.endsWith("/scripts/operator/lcx-commercial-acceptance-harness.ts")
  ) {
    throw new Error("original_source_pin_missing");
  }
  const sourceBytes = await fs.readFile(source.archive);
  if (
    createHash("sha256").update(sourceBytes).digest("hex") !== source.sha256 ||
    object(capture.identity).originalModuleURL !== pathToFileURL(source.path).href
  ) {
    throw new Error("original_source_hash_conflict");
  }
  const ast = ts.createSourceFile(
    source.path,
    sourceBytes.toString(),
    ts.ScriptTarget.Latest,
    true,
  );
  if (!Array.isArray(sourcePins.bodyPins) || sourcePins.bodyPins.length !== 10) {
    throw new Error("original_body_pins_missing");
  }
  for (const raw of sourcePins.bodyPins) {
    const pin = object(raw);
    const fn = ast.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === pin.name,
    );
    if (
      !fn ||
      !ts.isFunctionDeclaration(fn) ||
      !fn.body ||
      createHash("sha256").update(fn.body.getText(ast)).digest("hex") !== pin.originalBodySha256 ||
      pin.originalBodySha256 !== pin.instrumentedOriginalBodySha256
    ) {
      throw new Error("original_body_pin_conflict");
    }
  }
  if (!Array.isArray(capture.events) || capture.events.length > 256) {
    throw new Error("call_events_missing");
  }
  const events = capture.events.map(object);
  if (events.some((event, index) => event.sequence !== index + 1)) {
    throw new Error("call_sequence_conflict");
  }
  const call = (name: string) => {
    const matches = events.filter((event) => event.kind === "call" && event.name === name);
    if (matches.length !== 1) {
      throw new Error("parent_call_missing_or_duplicate");
    }
    return matches[0];
  };
  const result = (input: Record<string, unknown>) => {
    const matches = events.filter(
      (event) =>
        event.kind === "result" &&
        event.callSequence === input.sequence &&
        event.name === input.name,
    );
    if (matches.length !== 1 || Number(matches[0].sequence) <= Number(input.sequence)) {
      throw new Error("call_return_missing");
    }
    return matches[0].result;
  };
  const parent = (child: Record<string, unknown>, caller: Record<string, unknown>) => {
    if (
      child.parentCallSequence !== caller.sequence ||
      child.parentFunction !== caller.name ||
      Number(child.sequence) <= Number(caller.sequence)
    ) {
      throw new Error("actual_parent_conflict");
    }
  };
  const main = call("main"),
    collector = call("collectOwnerSnapshots"),
    shared = call("collectSharedOwnerSnapshots");
  parent(collector, main);
  parent(shared, collector);
  const owner = {
    training_plan: "local-brain-training-plan",
    mind_model: "lcx-mind-model",
    flow_graph: "lcx-flow-graph",
    external_channel_binding: "lcx-external-channel-binding",
  }[witness.to];
  const matching = events.filter(
    (event) =>
      event.kind === "call" &&
      event.name === "runJsonOwner" &&
      Array.isArray(event.args) &&
      event.args[0] === owner,
  );
  if (matching.length !== 1) {
    throw new Error("dispatch_call_missing");
  }
  const dispatch = matching[0],
    args = dispatch.args as unknown[];
  parent(dispatch, shared);
  let sourceRoute = false;
  const sharedSource = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "collectSharedOwnerSnapshots",
  );
  const inspect = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "runOwner" &&
      node.arguments.length === 3 &&
      ts.isStringLiteral(node.arguments[0]) &&
      ts.isStringLiteral(node.arguments[1]) &&
      ts.isArrayLiteralExpression(node.arguments[2])
    ) {
      const flags = node.arguments[2].elements.map((entry) =>
        ts.isStringLiteral(entry) ? entry.text : undefined,
      );
      if (equal(args, [node.arguments[0].text, node.arguments[1].text, flags])) {
        sourceRoute = true;
      }
    }
    ts.forEachChild(node, inspect);
  };
  if (sharedSource) {
    inspect(sharedSource);
  }
  if (!sourceRoute) {
    throw new Error("dispatch_args_not_in_original_source");
  }
  const returned = object(result(dispatch));
  if (
    returned.owner !== owner ||
    returned.ok !== false ||
    returned.commandSucceeded !== false ||
    typeof returned.error !== "string" ||
    !returned.error
  ) {
    throw new Error("failed_return_missing");
  }
  const binders = events.filter(
    (event) =>
      event.kind === "call" &&
      event.name === "bindActualCollectedSnapshot" &&
      Array.isArray(event.args) &&
      equal(event.args[0], returned),
  );
  if (binders.length !== 1) {
    throw new Error("failed_return_not_consumed");
  }
  const binder = binders[0];
  parent(binder, shared);
  if (
    Number(binder.sequence) <=
    Number(
      events.find((event) => event.kind === "result" && event.callSequence === dispatch.sequence)
        ?.sequence,
    )
  ) {
    throw new Error("binder_precedes_return");
  }
  const bound = result(binder),
    sharedResult = object(result(shared));
  if (!Object.values(sharedResult).some((value) => equal(value, bound))) {
    throw new Error("bound_return_not_joined");
  }
  const combine = call("combineCommercialAcceptanceSnapshots"),
    builder = call("buildCommercialAcceptanceHarness");
  parent(combine, collector);
  parent(builder, main);
  if (
    !Array.isArray(combine.args) ||
    !equal(combine.args[0], sharedResult) ||
    !Array.isArray(builder.args) ||
    !equal(builder.args[0], result(collector)) ||
    !equal(result(combine), result(collector))
  ) {
    throw new Error("joined_result_not_consumed");
  }
  const published = events.filter(
    (event) => event.kind === "publisher_input" && event.name === "original_main_stdout",
  );
  if (
    published.length !== 1 ||
    typeof published[0].text !== "string" ||
    !equal(JSON.parse(published[0].text), result(builder))
  ) {
    throw new Error("builder_result_not_published");
  }
  parent(published[0], main);
  if (
    !Array.isArray(transport.calls) ||
    !transport.calls.some((raw) => {
      const entry = object(raw);
      return (
        entry.parentFunction === "runJsonOwner" &&
        entry.parentCallSequence === dispatch.sequence &&
        equal(entry.args, ["--import", "tsx", args[1], ...(args[2] as unknown[])]) &&
        entry.code === "ENOENT" &&
        entry.childExecuted === false
      );
    })
  ) {
    throw new Error("actual_transport_attempt_missing");
  }
}

async function readHandoffField(ref: WorkflowFieldRef): Promise<string> {
  if (
    !ref ||
    typeof ref.path !== "string" ||
    typeof ref.pointer !== "string" ||
    !/^[a-f0-9]{64}$/.test(ref.sha256 ?? "") ||
    (ref.pointer !== "" && !ref.pointer.startsWith("/"))
  ) {
    throw new Error("invalid_field_reference");
  }
  if (
    ref.json !== undefined &&
    (!Array.isArray(ref.json) ||
      ref.json.length > 2 ||
      ref.json.some(
        (step) =>
          !step ||
          typeof step.pointer !== "string" ||
          (step.pointer !== "" && !step.pointer.startsWith("/")) ||
          (step.after !== undefined &&
            (typeof step.after !== "string" || !step.after || step.after.length > 160)),
      ))
  ) {
    throw new Error("invalid_embedded_json_reference");
  }
  const raw = await fs.readFile(ref.path, "utf8");
  if (createHash("sha256").update(raw).digest("hex") !== ref.sha256) {
    throw new Error("receipt_hash_conflict");
  }
  let value: unknown = JSON.parse(raw);
  for (const part of ref.pointer === "" ? [] : ref.pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
      throw new Error("receipt_field_missing");
    }
    value = (value as Record<string, unknown>)[key];
  }
  for (const step of ref.json ?? []) {
    if (typeof value !== "string") {
      throw new Error("embedded_json_source_not_text");
    }
    if (step.after !== undefined) {
      const offset = value.lastIndexOf(step.after);
      if (offset < 0) {
        throw new Error("embedded_json_marker_missing");
      }
      value = value.slice(offset + step.after.length);
    }
    try {
      value = JSON.parse(value as string) as unknown;
    } catch {
      throw new Error("embedded_json_invalid");
    }
    for (const part of step.pointer === "" ? [] : step.pointer.slice(1).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
        throw new Error("embedded_json_field_missing");
      }
      value = (value as Record<string, unknown>)[key];
    }
  }
  if (value === null || value === undefined || value === "") {
    throw new Error("receipt_field_empty");
  }
  // Canonical JSON allows independently serialized inputs with different key order.
  const canonical = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(canonical)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry)
              .toSorted(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : entry;
  const selectedJson = JSON.stringify(canonical(value));
  if (ref.encoding !== undefined && ref.encoding !== "canonical_json_sha256") {
    throw new Error("invalid_field_encoding");
  }
  return ref.encoding === "canonical_json_sha256"
    ? JSON.stringify(createHash("sha256").update(selectedJson).digest("hex"))
    : selectedJson;
}

/** Cross-run diagnostic readback only; neither caller identity becomes a finance account. */
async function verifyCommercialRefusalFeedback(
  ref: WorkflowFieldRef,
  producer: { receipt: WorkflowFieldRef; scope: string; output?: string },
): Promise<void> {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("feedback_commercial_record_invalid");
    }
    return value as Record<string, unknown>;
  };
  if (ref.pointer !== "") {
    throw new Error("feedback_future_root_required");
  }
  await readHandoffField({ ...producer.receipt, pointer: "" });
  const raw = await fs.readFile(producer.receipt.path, "utf8");
  if (createHash("sha256").update(raw).digest("hex") !== producer.receipt.sha256) {
    throw new Error("feedback_producer_hash_conflict");
  }
  const source = record(JSON.parse(raw));
  const calls = source.auditCalls;
  if (!Array.isArray(calls) || calls.length !== 1) {
    throw new Error("feedback_native_audit_ambiguous");
  }
  const call = record(calls[0]),
    receipt = record(call.output),
    invocation = record(receipt.auditInvocation);
  const caller = record(invocation.caller),
    host = record(call.caller),
    inputs = record(invocation.inputs);
  const policy = record(receipt.financeDecision),
    options = record(call.input);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const codes = receipt.failedReasons;
  if (typeof call.candidate !== "string" || typeof call.ask !== "string") {
    throw new Error("feedback_native_source_pin_unobserved");
  }
  record(options.snapshot);
  // The original producer hashes canonical snapshot content; no schema/quality approval follows from this hash-only assertion.
  const fingerprint = fingerprintFinanceAnswerEvidence(
    call.candidate,
    options.snapshot as Parameters<typeof fingerprintFinanceAnswerEvidence>[1],
  );
  if (
    invocation.schemaVersion !== "lcx_commercial_audit_invocation_v1" ||
    invocation.status !== "observed" ||
    invocation.owner !== "scripts/operator/lcx-commercial-answer-pipeline.ts#buildPipelineResult" ||
    invocation.identityBoundary !== "reply_caller_context_only" ||
    !isDeepStrictEqual(caller, host) ||
    typeof caller.runId !== "string" ||
    !caller.runId.trim() ||
    typeof caller.sessionKey !== "string" ||
    !caller.sessionKey.trim() ||
    typeof caller.messageId !== "string" ||
    !caller.messageId.trim() ||
    JSON.parse(producer.scope) !== caller.runId ||
    typeof call.ask !== "string" ||
    typeof call.candidate !== "string" ||
    inputs.askSha256 !== hash(call.ask) ||
    inputs.candidateSha256 !== fingerprint.candidateSha256 ||
    inputs.snapshotSha256 !== fingerprint.snapshotSha256 ||
    receipt.ok !== false ||
    receipt.terminalDecision !== "return_failed_reason" ||
    policy.allowed !== false ||
    policy.mode !== options.financeDecisionMode ||
    !Array.isArray(codes) ||
    !codes.length ||
    codes.some((code) => typeof code !== "string") ||
    !Array.isArray(policy.failedReasons) ||
    !policy.failedReasons.length ||
    policy.failedReasons.some((code) => !codes.includes(code)) ||
    !producer.output ||
    !isDeepStrictEqual(JSON.parse(producer.output), policy)
  ) {
    throw new Error("feedback_native_contract_audit_unconfirmed");
  }
  const auditSHA = hash(JSON.stringify(receipt));
  const events = source.events;
  if (
    !Array.isArray(events) ||
    !events.some((value) => {
      const event = record(value),
        data = record(event.data);
      return (
        event.runId === caller.runId &&
        event.sessionKey === caller.sessionKey &&
        data.phase === "commercial_answer_terminal_gate" &&
        data.nativeTerminalDecision === "return_failed_reason" &&
        data.auditReceiptSha256 === auditSHA &&
        isDeepStrictEqual(data.auditInvocation, invocation) &&
        record(data.refusalFeedback).status === "queued"
      );
    })
  ) {
    throw new Error("feedback_native_enqueue_unconfirmed");
  }
  const future = record(JSON.parse(await readHandoffField(ref)));
  if (
    future.boundary !==
      "offline_original_system_event_prompt_model_transport_response_only_not_natural_adoption" ||
    future.semanticAdoption !== "not_proven" ||
    future.persistence !== "not_provided_process_queue_only" ||
    !isDeepStrictEqual(future.nativeCaller, caller) ||
    !Array.isArray(future.entries) ||
    future.entries.length !== 1 ||
    !Array.isArray(future.promptReads) ||
    !Array.isArray(future.nextModelInputs) ||
    future.nextModelInputs.length !== 1
  ) {
    throw new Error("feedback_next_readback_boundary_invalid");
  }
  const entry = record(future.entries[0]);
  if (
    typeof entry.text !== "string" ||
    Buffer.byteLength(entry.text) > 2048 ||
    entry.contextKey !== `commercial-refusal:${caller.runId}:${auditSHA}`
  ) {
    throw new Error("feedback_diagnostic_pin_invalid");
  }
  const diagnosticText = entry.text;
  const diagnostic = record(JSON.parse(diagnosticText));
  if (
    diagnostic.schemaVersion !== "lcx_commercial_refusal_feedback_v1" ||
    diagnostic.boundary !==
      "historical_native_audit_refusal_diagnostic_only_not_market_fact_or_execution_authority" ||
    diagnostic.semanticAdoption !== "not_proven" ||
    diagnostic.auditReceiptSha256 !== auditSHA ||
    diagnostic.runId !== caller.runId ||
    diagnostic.messageId !== caller.messageId ||
    diagnostic.askSha256 !== inputs.askSha256 ||
    diagnostic.candidateSha256 !== inputs.candidateSha256 ||
    !isDeepStrictEqual(diagnostic.failedReasons, codes.slice(0, 8)) ||
    diagnostic.omittedFailedReasons !== Math.max(0, codes.length - 8)
  ) {
    throw new Error("feedback_native_diagnostic_conflict");
  }
  const next = record(future.nextModelInputs[0]),
    observed = record(future.nextDiagnostics);
  if (
    typeof next.runId !== "string" ||
    !next.runId.trim() ||
    next.runId === caller.runId ||
    next.sessionKey !== caller.sessionKey ||
    observed.sessionKey !== caller.sessionKey ||
    !isDeepStrictEqual(observed.nextModelInputs, future.nextModelInputs) ||
    typeof observed.messageId !== "string" ||
    !observed.messageId.trim() ||
    observed.messageId === caller.messageId ||
    typeof next.extraSystemPrompt !== "string" ||
    !Array.isArray(observed.inputs) ||
    !observed.inputs.some((value) => {
      const input = record(value);
      return (
        input.SessionKey === caller.sessionKey &&
        (input.MessageSidFull ?? input.MessageSid) === observed.messageId
      );
    }) ||
    !future.promptReads.some((value) => {
      const read = record(value);
      return (
        read.sessionKey === caller.sessionKey &&
        typeof read.result === "string" &&
        read.result.startsWith("## Runtime System Events (gateway-generated)") &&
        read.result
          .split("\n")
          .some((line) => line.startsWith("- [") && line.endsWith(`] ${diagnosticText}`)) &&
        typeof next.extraSystemPrompt === "string" &&
        next.extraSystemPrompt.includes(read.result)
      );
    })
  ) {
    throw new Error("feedback_actual_next_prompt_not_consumed");
  }
}

async function verifySelfRepairDiagnosticFeedback(
  ref: WorkflowFieldRef,
  producer: { receipt: WorkflowFieldRef; scope: string },
): Promise<void> {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (ref?.pointer !== "") {
    throw new Error("feedback_future_root_required");
  }
  let future = record(JSON.parse(await readHandoffField(ref)));
  if (
    !future ||
    future.kind !== "lcx-self-repair-hands" ||
    future.boundary !== "local_self_repair_hands_only" ||
    future.candidateOnly !== true ||
    future.reuseAllowed !== false ||
    future.semanticTruth !== "not_proven" ||
    future.status !== "write_completed" ||
    future.ok !== true ||
    typeof future.workspaceDir !== "string" ||
    !path.isAbsolute(future.workspaceDir)
  ) {
    throw new Error("feedback_future_candidate_boundary_invalid");
  }
  const workspaceAlias = path.resolve(future.workspaceDir);
  const workspace = await fs.realpath(workspaceAlias);
  const safeRead = async (filePath: string) =>
    readFileWithinRoot({
      rootDir: workspace,
      relativePath: path.relative(workspaceAlias, path.resolve(workspaceAlias, filePath)),
      maxBytes: 512 * 1024,
    });
  const root = await safeRead(ref.path);
  const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  if (
    sha(root.buffer) !== ref.sha256 ||
    typeof future.latestJsonPath !== "string" ||
    (await fs.realpath(future.latestJsonPath)) !== root.realPath
  ) {
    throw new Error("feedback_future_root_pin_conflict");
  }
  // Field comparison canonicalizes keys. Original writer body serialization must keep raw key order.
  future = record(JSON.parse(root.buffer.toString("utf8")));
  if (!future) {
    throw new Error("feedback_future_candidate_boundary_invalid");
  }
  const requestHost = record(future.diagnosticFeedbackRequest);
  const request = record(requestHost?.request);
  const map = record(request?.map);
  if (
    !map ||
    typeof map.path !== "string" ||
    (await fs.realpath(path.resolve(workspaceAlias, map.path))) !==
      (await fs.realpath(producer.receipt.path)) ||
    map.sha256 !== producer.receipt.sha256
  ) {
    throw new Error("feedback_current_map_pin_mismatch");
  }
  const host = record(requestHost?.host);
  const readFresh = () =>
    readSelfRepairOwnerMapFeedback(
      workspace,
      request,
      host ? { ...host, nowMs: Date.now() } : requestHost?.host,
    );
  const fresh = await readFresh();
  if (
    fresh.status !== "read" ||
    !fresh.diagnostic ||
    !isDeepStrictEqual(fresh, future.diagnosticFeedback)
  ) {
    throw new Error(
      `feedback_diagnostic_readback_conflict:${fresh.blockers.join(";") || "cached_result_mismatch"}`,
    );
  }
  if (!isDeepStrictEqual(fresh.snapshot, JSON.parse(producer.scope))) {
    throw new Error("feedback_current_map_scope_mismatch");
  }
  const futureTime = typeof future.checkedAt === "string" ? Date.parse(future.checkedAt) : NaN;
  const sourceTime = fresh.sourceCheckedAt ? Date.parse(fresh.sourceCheckedAt) : NaN;
  if (
    !Number.isFinite(futureTime) ||
    !Number.isFinite(sourceTime) ||
    futureTime < sourceTime ||
    typeof future.signalKey !== "string" ||
    !future.signalKey.trim() ||
    future.signalKey === fresh.sourceRunId
  ) {
    throw new Error("feedback_future_attempt_identity_invalid");
  }
  const process = record(future.processEvidence);
  const writer = record(process?.writer);
  const gates = record(process?.gates);
  if (
    writer?.publication !== "pending_in_snapshot" ||
    writer.status !== "writing" ||
    writer.diskReadback !== "not_observed" ||
    writer.candidateEligibility !== true ||
    gates?.candidateWritesAllowed !== true ||
    !Array.isArray(writer.successfulWrites)
  ) {
    throw new Error("feedback_native_candidate_write_evidence_missing");
  }
  const hands = record(future.hands);
  for (const [hand, field, bodyField] of [
    ["memoryCleaner", "/hands/memoryCleaner/correctionMarkdown", "correctionMarkdown"],
    ["trainingCaseBuilder", "/hands/trainingCaseBuilder/candidate", "candidate"],
    ["patchCandidateBuilder", "/hands/patchCandidateBuilder/candidate", "candidate"],
  ]) {
    const candidate = record(hands?.[hand]);
    const body = candidate?.[bodyField];
    const writes = writer.successfulWrites.map(record).filter((write) => write?.field === field);
    if (!candidate || typeof candidate.path !== "string" || writes.length !== 1) {
      throw new Error(`feedback_candidate_write_missing:${field}`);
    }
    const expected =
      bodyField === "correctionMarkdown" && typeof body === "string"
        ? `${body}\n`
        : `${JSON.stringify(body, null, 2)}\n`;
    const actual = await safeRead(candidate.path);
    if (
      sha(actual.buffer) !== writes[0]?.sha256 ||
      actual.buffer.length !== writes[0]?.bytes ||
      !actual.buffer.equals(Buffer.from(expected))
    ) {
      throw new Error(`feedback_candidate_body_hash_conflict:${field}`);
    }
    // These are the original builder's observedFailure consumer fields, not an arbitrary extra key.
    const diagnosticBody =
      hand === "memoryCleaner"
        ? body
        : hand === "trainingCaseBuilder"
          ? record(record(body)?.trainExampleCandidate)?.prompt
          : record(record(body)?.proposedPatchContract)?.failureFamily;
    if (typeof diagnosticBody !== "string" || !diagnosticBody.includes(fresh.diagnostic)) {
      throw new Error(`feedback_diagnostic_not_in_candidate_body:${field}`);
    }
  }
  // Re-pin after body reads; no mutation of historical scope or original candidate state occurs.
  if (
    sha((await safeRead(ref.path)).buffer) !== ref.sha256 ||
    !isDeepStrictEqual(await readFresh(), fresh)
  ) {
    throw new Error("feedback_source_changed_during_read");
  }
}

async function verifyNativeFinanceToolCustody(
  binding: Extract<WorkflowScopeBinding, { kind: "native_finance_tool_custody" }>,
  producer: { receipt: WorkflowFieldRef; scope: string },
  consumer: { receipt: WorkflowFieldRef; scope: string },
  input: WorkflowFieldRef,
  edge: { from: FlowNodeId; to: FlowNodeId },
  context: { scenarioId: FlowScenarioId; environment: WorkflowHandoffEvidence["environment"] },
) {
  const routes = [
    ["local_brain_planner", "source_registry"],
    ["source_registry", "finance_research_modules"],
    ["source_registry", "causal_map"],
    ["finance_learning_memory", "review_panel"],
    ["causal_map", "review_panel"],
    ["review_panel", "control_room_summary"],
    ["review_panel", "finance_research_modules"],
    ["review_panel", "model_tool_decision"],
  ];
  const sameOutlet = (ref: WorkflowFieldRef) =>
    ref &&
    path.resolve(ref.path) === path.resolve(binding.receipt.path) &&
    ref.sha256 === binding.receipt.sha256;
  if (
    context.scenarioId !== "external_finance_research_waterflow" ||
    context.environment !== "offline_fixture" ||
    !routes.some(([from, to]) => from === edge.from && to === edge.to) ||
    binding.receipt.pointer !== "" ||
    binding.receipt.json !== undefined ||
    binding.rawReceipt.pointer !== "" ||
    binding.rawReceipt.json !== undefined ||
    !sameOutlet(producer.receipt) ||
    !sameOutlet(consumer.receipt) ||
    !sameOutlet(input) ||
    !sameOutlet(binding.sourceScope) ||
    path.resolve(binding.rawReceipt.path) === path.resolve(binding.receipt.path)
  ) {
    throw new Error("finance_custody_route_or_receipt_conflict");
  }
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const identity = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value);
  const outlet = object(JSON.parse(await readHandoffField(binding.receipt)) as unknown);
  await readHandoffField(binding.rawReceipt);
  // Preserve original writer key order for its payload hash, not canonical field-reader order.
  const rawBytes = await fs.readFile(binding.rawReceipt.path);
  const fileSha256 = createHash("sha256").update(rawBytes).digest("hex");
  if (fileSha256 !== binding.rawReceipt.sha256) {
    throw new Error("finance_custody_raw_hash_conflict");
  }
  const raw = object(JSON.parse(rawBytes.toString("utf8")) as unknown);
  const custody = object(raw?.toolInvocation),
    caller = object(custody?.caller),
    native = object(custody?.native),
    batch = object(raw?.batch),
    quality = object(raw?.quality);
  if (
    !raw ||
    !custody ||
    !caller ||
    !native ||
    !batch ||
    raw.boundary !== "finance_research_run_research_only" ||
    custody.schemaVersion !== "finance_research_tool_invocation_v1" ||
    custody.status !== "observed" ||
    custody.boundary !== "host_tool_invocation_custody_only_not_business_or_account_identity" ||
    custody.contextValidation !== "matched_on_entry_and_before_receipt_publication" ||
    custody.payloadHashBoundary !==
      "native_receipt_json_without_toolInvocation_plus_final_newline" ||
    !identity(caller?.runId) ||
    !identity(caller.sessionKey) ||
    !identity(caller.toolCallId) ||
    !identity(batch?.correlationId) ||
    native?.batchCorrelationId !== batch.correlationId ||
    (quality?.runId !== undefined &&
      (!identity(quality.runId) || native?.qualityRunId !== quality.runId)) ||
    (quality?.runId === undefined && native?.qualityRunId !== undefined)
  ) {
    throw new Error("finance_custody_native_identity_unconfirmed");
  }
  const { toolInvocation: _custody, ...payload } = raw;
  if (
    custody.payloadSha256 !==
    createHash("sha256")
      .update(JSON.stringify(payload, null, 2) + "\n")
      .digest("hex")
  ) {
    throw new Error("finance_custody_payload_hash_conflict");
  }
  const source = object(outlet?.source),
    invocation = object(source?.invocation),
    host = object(invocation?.hostCaller),
    modelInput = object(outlet?.modelNextInput),
    consumed = object(modelInput?.consumedToolJSON),
    hostContext = object(modelInput?.originalHostContext),
    readback = object(outlet?.originalReceiptReadback);
  if (
    !outlet ||
    !source ||
    !host ||
    !modelInput ||
    !consumed ||
    !readback ||
    outlet.boundary !==
      "offline_original_producer_publisher_reply_dispatcher_sender_receiver_substitutes" ||
    !isDeepStrictEqual(source?.receipt, payload) ||
    host?.runId !== caller.runId ||
    host?.sessionKey !== caller.sessionKey ||
    hostContext?.sessionKey !== caller.sessionKey ||
    readback?.sha256 !== fileSha256 ||
    typeof readback?.retainedPath !== "string" ||
    path.resolve(readback.retainedPath) !== path.resolve(binding.rawReceipt.path) ||
    typeof readback.sourcePath !== "string" ||
    consumed?.receiptPath !== readback.sourcePath ||
    consumed.receiptSha256 !== fileSha256 ||
    modelInput?.nativeReceiptSha256 !== fileSha256 ||
    !isDeepStrictEqual(modelInput?.storedToolInvocation, custody)
  ) {
    throw new Error("finance_custody_source_or_model_readback_conflict");
  }
  const events = Array.isArray(outlet.events) ? outlet.events.map(object) : [];
  const toolEvents = events.filter((event) => {
    const data = object(event?.data);
    return (
      event?.stream === "tool" &&
      data?.phase === "result" &&
      data.name === "finance_research_run" &&
      data.toolCallId === caller.toolCallId
    );
  });
  const event = toolEvents[0],
    data = object(event?.data),
    details = object(object(data?.result)?.details);
  if (
    toolEvents.length !== 1 ||
    event?.runId !== caller.runId ||
    event?.sessionKey !== caller.sessionKey ||
    data?.isError !== false ||
    details?.receiptPath !== readback.sourcePath ||
    details.receiptSha256 !== fileSha256 ||
    !isDeepStrictEqual(details.toolInvocation, custody)
  ) {
    throw new Error("finance_custody_tool_event_conflict");
  }
  const expectedScope = (node: FlowNodeId) =>
    node === "source_registry"
      ? batch.correlationId
      : node === "review_panel"
        ? quality?.runId
        : caller.runId;
  if (
    !identity(expectedScope(edge.from)) ||
    !identity(expectedScope(edge.to)) ||
    JSON.parse(producer.scope) !== expectedScope(edge.from) ||
    JSON.parse(consumer.scope) !== expectedScope(edge.to) ||
    (await readHandoffField(binding.sourceScope)) !== producer.scope
  ) {
    throw new Error("finance_custody_scope_role_conflict");
  }
}

/** Validate the original pre-role question packet, not a post-candidate plan or role flags. */
async function verifyCommercialQuestionRequirements(
  binding: Extract<WorkflowScopeBinding, { kind: "commercial_question_requirements" }>,
  producer: { receipt: WorkflowFieldRef; scope: string },
  consumer: { receipt: WorkflowFieldRef; scope: string; scopeRef: WorkflowFieldRef },
  input: WorkflowFieldRef,
  edge: { from: FlowNodeId; to: FlowNodeId },
  scenarioId: FlowScenarioId,
): Promise<void> {
  const prefix = "question_bridge_";
  function fail(reason: string): never {
    throw new Error(`${prefix}${reason}`);
  }
  const belongs = (ref: WorkflowFieldRef, owner: WorkflowFieldRef) =>
    path.resolve(ref.path) === path.resolve(owner.path) && ref.sha256 === owner.sha256 && !ref.json;
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fail("record_missing");
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // The generic field reader canonicalizes object keys; the intake hash needs native JSON order.
  const originalRoot = async (ref: WorkflowFieldRef) => {
    await readHandoffField({ ...ref, pointer: "", json: undefined });
    const bytes = await fs.readFile(ref.path);
    if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
      fail("receipt_hash_conflict");
    }
    return record(JSON.parse(bytes.toString("utf8")) as unknown);
  };
  if (
    scenarioId !== "commercial_answer_pipeline_waterflow" ||
    edge.from !== "local_brain_planner" ||
    edge.to !== "model_council" ||
    binding.producerPacket.pointer !== "/plannerOutput" ||
    !belongs(binding.producerPacket, producer.receipt) ||
    binding.callerProof.pointer !== "" ||
    !belongs(binding.callerProof, producer.receipt) ||
    binding.actualModelRequests.pointer !== "/actualModelRequests" ||
    !belongs(binding.actualModelRequests, producer.receipt) ||
    ![binding.receipt, binding.sourceScope, input, consumer.scopeRef].every((ref) =>
      belongs(ref, consumer.receipt),
    ) ||
    binding.receipt.pointer !== "/processEvidence/questionRequirements" ||
    binding.sourceScope.pointer !== "/processEvidence/questionRequirements/actualAskSha256" ||
    input.pointer !== "/processEvidence/questionRequirements/receivedInputSha256" ||
    consumer.scopeRef.pointer !== "/messageId" ||
    binding.projectionSideproof.pointer !== "/readback" ||
    binding.projectionSideproof.json
  ) {
    fail("route_or_owner_conflict");
  }
  const caller = await originalRoot(binding.callerProof);
  const artifact = await originalRoot(consumer.receipt);
  const packet = record(caller.plannerOutput);
  const plannerInput = record(caller.plannerInput);
  const process = record(artifact.processEvidence);
  const received = record(process.questionRequirements);
  if (
    typeof artifact.userMessage !== "string" ||
    typeof artifact.messageId !== "string" ||
    !artifact.messageId ||
    plannerInput.decisionMode !== "research_only_default" ||
    typeof packet.askSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(packet.askSha256) ||
    !Array.isArray(packet.needs) ||
    !packet.needs.every((need) => {
      const item = record(need);
      return typeof item.id === "string" && typeof item.reason === "string";
    })
  ) {
    fail("original_question_missing");
  }
  const askSha = createHash("sha256").update(artifact.userMessage).digest("hex");
  if (
    plannerInput.askSha256 !== askSha ||
    packet.askSha256 !== askSha ||
    received.actualAskSha256 !== askSha ||
    producer.scope !== JSON.stringify(askSha) ||
    consumer.scope !== JSON.stringify(artifact.messageId)
  ) {
    fail("actual_ask_scope_conflict");
  }
  if (hash(packet) !== received.receivedInputSha256) {
    fail("raw_packet_hash_conflict");
  }
  const expectedPacket = {
    askSha256: askSha,
    needs: planCommercialAnswerRequirements(artifact.userMessage)
      .needs.filter((need) => need.required)
      .map(({ id, reason }) => ({ id, reason })),
  };
  if (!isDeepStrictEqual(packet, expectedPacket)) {
    fail("original_planner_output_conflict");
  }
  // Pins relate the capture to the actual unchanged caller body and the current pure helper.
  const callerPath = path.join(repoRoot, "scripts/operator/lcx-provider-council-acceleration.ts");
  const helperPath = path.join(repoRoot, "src/agents/provider-learning-council.ts");
  const plannerPath = path.join(repoRoot, "scripts/operator/lcx-commercial-answer-pipeline.ts");
  const [callerBytes, capturedCaller, helperBytes, pinnedHelper, plannerBytes, pinnedPlanner] =
    await Promise.all([
      fs.readFile(callerPath),
      fs.readFile(String(caller.sourcePath)),
      fs.readFile(helperPath),
      fs.readFile(binding.helperSource.path),
      fs.readFile(plannerPath),
      fs.readFile(binding.plannerSource.path),
    ]);
  const bytesHash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const callerAst = ts.createSourceFile(
    callerPath,
    callerBytes.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const body = callerAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "runCouncil",
  );
  if (
    bytesHash(callerBytes) !== caller.sourceSha256 ||
    bytesHash(capturedCaller) !== caller.sourceSha256 ||
    !body ||
    createHash("sha256").update(body.getText(callerAst)).digest("hex") !==
      caller.originalBodySha256 ||
    bytesHash(helperBytes) !== binding.helperSource.sha256 ||
    bytesHash(pinnedHelper) !== binding.helperSource.sha256 ||
    bytesHash(plannerBytes) !== binding.plannerSource.sha256 ||
    bytesHash(pinnedPlanner) !== binding.plannerSource.sha256
  ) {
    fail("original_source_pin_conflict");
  }
  const rebuilt = councilHelpers.buildQuestionRequirementsContext(
    artifact.userMessage,
    packet as LearningCouncilQuestionRequirements,
  );
  const side = record(JSON.parse(await readHandoffField(binding.projectionSideproof)) as unknown);
  const nativeProjection = { ...received };
  delete nativeProjection.inputSha256;
  delete nativeProjection.inputBoundary;
  const rebuiltProjection = { ...rebuilt.evidence };
  delete (rebuiltProjection as Record<string, unknown>).inputSha256;
  delete (rebuiltProjection as Record<string, unknown>).inputBoundary;
  if (
    received.status !== "provided" ||
    !rebuilt.evidence ||
    Buffer.byteLength(rebuilt.context, "utf8") > 1024 ||
    !isDeepStrictEqual(nativeProjection, rebuiltProjection) ||
    !isDeepStrictEqual(side.evidence, rebuilt.evidence) ||
    side.context !== rebuilt.context ||
    (received.inputSha256 !== undefined && received.inputSha256 !== rebuilt.evidence.inputSha256) ||
    (received.inputBoundary !== undefined &&
      received.inputBoundary !== rebuilt.evidence.inputBoundary)
  ) {
    fail("projection_builder_conflict");
  }
  const calls = process.planningCalls;
  const requests = caller.actualModelRequests;
  const planner = record(process.planner);
  const ids = ["kimi", "deepseek", "minimax_primary", "minimax_extra"];
  if (
    !Array.isArray(calls) ||
    calls.length !== 4 ||
    !Array.isArray(requests) ||
    requests.length !== 4 ||
    planner.messageId !== artifact.messageId ||
    typeof planner.sessionKey !== "string" ||
    planner.userMessageSha256 !== hash(artifact.userMessage)
  ) {
    fail("actual_role_context_conflict");
  }
  for (const [index, raw] of calls.entries()) {
    const call = record(raw),
      dispatch = record(call.dispatchInput),
      arrived = record(call.receivedInput);
    const request = record(requests[index]);
    if (
      call.callId !== ids[index] ||
      !isDeepStrictEqual(dispatch, arrived) ||
      call.dispatchInputSha256 !== hash(dispatch) ||
      call.receivedInputSha256 !== hash(arrived) ||
      arrived.questionRequirementsContextSha256 !== rebuilt.evidence.contextSha256 ||
      arrived.userMessageSha256 !== hash(artifact.userMessage) ||
      typeof arrived.sessionKey !== "string" ||
      !arrived.sessionKey.startsWith(
        `${planner.sessionKey}:learning-council:${artifact.messageId}:`,
      ) ||
      request.sessionKey !== arrived.sessionKey ||
      request.askSha256 !== askSha ||
      request.promptSha256 !== arrived.extraSystemPromptSha256
    ) {
      fail("actual_role_context_conflict");
    }
  }
}

async function verifyScopeBinding(
  binding: WorkflowScopeBinding,
  producer: { receipt: WorkflowFieldRef; scope: string },
  consumer: { receipt: WorkflowFieldRef; scope: string; scopeRef: WorkflowFieldRef },
  input: WorkflowFieldRef,
  edge: { from: FlowNodeId; to: FlowNodeId },
  context: { scenarioId: FlowScenarioId; environment: WorkflowHandoffEvidence["environment"] },
): Promise<void> {
  if (binding.kind === "commercial_question_requirements") {
    return verifyCommercialQuestionRequirements(
      binding,
      producer,
      consumer,
      input,
      edge,
      context.scenarioId,
    );
  }
  if (binding.kind === "native_finance_tool_custody") {
    return verifyNativeFinanceToolCustody(binding, producer, consumer, input, edge, context);
  }
  const belongs = (ref: WorkflowFieldRef, owner: WorkflowFieldRef) =>
    ref && path.resolve(ref.path) === path.resolve(owner.path) && ref.sha256 === owner.sha256;
  const readConsumer = async (ref: WorkflowFieldRef): Promise<unknown> => {
    if (!belongs(ref, consumer.receipt)) {
      throw new Error("scope_binding_not_in_consumer_receipt");
    }
    return JSON.parse(await readHandoffField(ref)) as unknown;
  };
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (binding.kind === "portfolio_plan_failed_read") {
    const side = (ref: WorkflowFieldRef) => belongs(ref, binding.receiver);
    if (
      context.scenarioId !== "finance_automatic_paper_trading_waterflow" ||
      edge.from !== "portfolio_plan" ||
      edge.to !== "finance_scheduler" ||
      ![binding.plan, binding.writePin, binding.sourceReceipt].every((ref) =>
        belongs(ref, producer.receipt),
      ) ||
      ![
        input,
        binding.schedulerReceipt,
        binding.actualOperatorArgv,
        binding.originalReaderSourcePin,
      ].every((ref) => belongs(ref, consumer.receipt)) ||
      ![binding.receipt, binding.sourceScope, binding.receiverSource, binding.replayArgv].every(
        side,
      ) ||
      belongs(binding.receiver, consumer.receipt) ||
      binding.rawPlan.pointer !== "" ||
      binding.rawPlan.json !== undefined ||
      binding.handoffManifest.pointer !== "" ||
      binding.handoffManifest.json !== undefined
    ) {
      throw new Error("portfolio_plan_failed_read_route_or_owner_conflict");
    }
    const read = async (ref: WorkflowFieldRef): Promise<unknown> =>
      JSON.parse(await readHandoffField(ref)) as unknown;
    const plan = object(await read(binding.plan));
    const write = object(await read(binding.writePin));
    const source = object(await read(binding.sourceReceipt));
    const scheduler = object(await read(binding.schedulerReceipt));
    const receiver = object(await read(binding.receiver));
    const consumed = object(await read(binding.receipt));
    const parsedScope = object(await read(binding.sourceScope));
    const readerSource = object(await read(binding.receiverSource));
    if (
      !plan ||
      !write ||
      !source ||
      !scheduler ||
      !receiver ||
      !consumed ||
      !parsedScope ||
      !readerSource
    ) {
      throw new Error("portfolio_plan_failed_read_original_receipts_missing");
    }
    const originalArgv = await read(binding.actualOperatorArgv);
    const replayArgv = await read(binding.replayArgv);
    const expected = object(consumed.expected),
      actualRead = object(consumed.read),
      provenance = object(plan.provenance);
    const oldResult =
      typeof scheduler.stdout === "string"
        ? object(JSON.parse(scheduler.stdout) as unknown)
        : undefined;
    const failure = "portfolio plan producer scope does not match caller";
    if (
      scheduler.status !== "failed" ||
      scheduler.ok !== false ||
      !oldResult ||
      oldResult.ok !== false ||
      oldResult.failureKind !== "portfolio_plan_binding_gate" ||
      oldResult.error !== failure ||
      receiver.ok !== false ||
      receiver.failureKind !== "portfolio_plan_binding_gate" ||
      receiver.error !== failure ||
      !expected ||
      !actualRead ||
      !provenance ||
      !Array.isArray(originalArgv) ||
      !originalArgv.every((value) => typeof value === "string") ||
      !isDeepStrictEqual(replayArgv, originalArgv) ||
      !isDeepStrictEqual(receiver.portfolioPlanInput, consumed) ||
      !isDeepStrictEqual(consumed.parsedScope, parsedScope) ||
      !isDeepStrictEqual(source.portfolioPlan, plan) ||
      !isDeepStrictEqual(JSON.parse(await readHandoffField(input)) as unknown, write)
    ) {
      throw new Error("portfolio_plan_failed_read_not_original_failure_or_input");
    }
    const argument = (flag: string): string | undefined => {
      const indexes = originalArgv.flatMap((value, index) => (value === flag ? [index] : []));
      return indexes.length === 1 && typeof originalArgv[indexes[0] + 1] === "string"
        ? originalArgv[indexes[0] + 1]
        : undefined;
    };
    const handoff = financeResearchControllerHandoffSchema.parse(source.controllerHandoff);
    const manifestBytes = await fs.readFile(binding.handoffManifest.path);
    const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
    const { producer: manifestPin, ...manifest } = handoff;
    if (actualRead.sha256 !== write.sha256 || expected.sha256 !== write.sha256) {
      throw new Error("portfolio_plan_failed_read_read_pin_conflict");
    }
    if (
      expected.accountId !== handoff.sourceScope.accountId ||
      expected.accountId !== plan.accountId ||
      write.accountId !== plan.accountId
    ) {
      throw new Error("portfolio_plan_failed_read_account_scope_conflict");
    }
    if (
      expected.parentRunId !== handoff.sourceScope.runId ||
      scheduler.runId !== handoff.sourceScope.runId ||
      receiver.parentRunId !== scheduler.runId ||
      oldResult.parentRunId !== scheduler.runId
    ) {
      throw new Error("portfolio_plan_failed_read_parent_run_conflict");
    }
    if (
      typeof write.path !== "string" ||
      typeof write.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(write.sha256) ||
      path.resolve(binding.handoffManifest.path) !== path.resolve(manifestPin.path) ||
      manifestSha !== binding.handoffManifest.sha256 ||
      manifestSha !== manifestPin.sha256 ||
      manifestBytes.length !== manifestPin.bytes ||
      !isDeepStrictEqual(JSON.parse(manifestBytes.toString("utf8")) as unknown, manifest) ||
      path.resolve(binding.rawPlan.path) !== path.resolve(write.path) ||
      actualRead.path !== write.path ||
      actualRead.sha256 !== write.sha256 ||
      expected.sha256 !== write.sha256 ||
      expected.parentRunId !== handoff.sourceScope.runId ||
      scheduler.runId !== handoff.sourceScope.runId ||
      receiver.parentRunId !== scheduler.runId ||
      oldResult.parentRunId !== scheduler.runId ||
      expected.accountId !== handoff.sourceScope.accountId ||
      expected.accountId !== plan.accountId ||
      write.accountId !== plan.accountId ||
      expected.asOf !== handoff.sourceScope.asOf ||
      expected.asOf !== plan.asOf ||
      write.asOf !== plan.asOf ||
      write.venue !== plan.venue ||
      handoff.sourceScope.venue !== plan.venue ||
      !isDeepStrictEqual(parsedScope, {
        asOf: plan.asOf,
        accountId: plan.accountId,
        venue: plan.venue,
      }) ||
      expected.venue === plan.venue ||
      argument("--portfolio-plan") !== write.path ||
      argument("--portfolio-plan-sha256") !== write.sha256 ||
      argument("--portfolio-plan-parent-run") !== scheduler.runId ||
      argument("--portfolio-plan-account") !== expected.accountId ||
      argument("--portfolio-plan-as-of") !== expected.asOf ||
      argument("--as-of") !== expected.asOf ||
      argument("--venue") !== expected.venue ||
      argument("--mode") !== "day" ||
      producer.scope !== JSON.stringify(provenance.receiptId) ||
      consumer.scope !== JSON.stringify(scheduler.runId)
    ) {
      throw new Error("portfolio_plan_failed_read_source_scope_or_caller_conflict");
    }
    const rawBytes = await fs.readFile(binding.rawPlan.path);
    const rawSha = createHash("sha256").update(rawBytes).digest("hex");
    if (
      rawSha !== binding.rawPlan.sha256 ||
      rawSha !== write.sha256 ||
      actualRead.bytes !== rawBytes.length ||
      !isDeepStrictEqual(JSON.parse(rawBytes.toString("utf8")) as unknown, plan)
    ) {
      throw new Error("portfolio_plan_failed_read_raw_bytes_conflict");
    }
    // Source-version side evidence must retain the exact old owner and unchanged read guards.
    const currentOwner = path.join(repoRoot, "scripts/operator/lcx-finance-daily-cycle.ts");
    const currentBytes = await fs.readFile(currentOwner);
    if ((await read(binding.originalReaderSourcePin)) !== binding.originalReaderSource.sha256) {
      throw new Error("portfolio_plan_failed_read_original_source_conflict");
    }
    if (
      typeof readerSource.path !== "string" ||
      typeof readerSource.sha256 !== "string" ||
      !readerSource.path.endsWith("/scripts/operator/lcx-finance-daily-cycle.ts") ||
      createHash("sha256")
        .update(await fs.readFile(readerSource.path))
        .digest("hex") !== readerSource.sha256 ||
      createHash("sha256").update(currentBytes).digest("hex") !== readerSource.sha256
    ) {
      throw new Error("portfolio_plan_failed_read_reader_source_conflict");
    }
    const oldBytes = await fs.readFile(binding.originalReaderSource.path);
    if (
      createHash("sha256").update(oldBytes).digest("hex") !== binding.originalReaderSource.sha256
    ) {
      throw new Error("portfolio_plan_failed_read_original_source_conflict");
    }
    const guards = (bytes: Buffer): string[] => {
      const file = ts.createSourceFile(
        "reader.ts",
        bytes.toString("utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const result: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "runFinanceDailyCycleOperator") {
          const find = (child: ts.Node) => {
            if (ts.isIfStatement(child)) {
              const statements = ts.isBlock(child.thenStatement)
                ? child.thenStatement.statements
                : [child.thenStatement];
              const directGuard = statements.some(
                (statement) =>
                  ts.isThrowStatement(statement) &&
                  ts.isNewExpression(statement.expression) &&
                  statement.expression.arguments?.some(
                    (argument) =>
                      ts.isStringLiteral(argument) &&
                      [failure, "portfolio plan bytes do not match producer SHA256"].includes(
                        argument.text,
                      ),
                  ),
              );
              if (directGuard) {
                result.push(child.getText(file).replace(/\s+/gu, ""));
              }
            }
            ts.forEachChild(child, find);
          };
          find(node);
        } else {
          ts.forEachChild(node, visit);
        }
      };
      visit(file);
      return result;
    };
    const oldGuards = guards(oldBytes),
      currentGuards = guards(currentBytes);
    if (oldGuards.length !== 2 || !isDeepStrictEqual(oldGuards, currentGuards)) {
      throw new Error("portfolio_plan_failed_read_original_guard_changed");
    }
    return;
  }
  if (binding.kind === "finance_book_custody") {
    if (
      context.scenarioId !== "finance_automatic_paper_trading_waterflow" ||
      edge.from !== "outcome_ledger" ||
      edge.to !== "tuning_proposal" ||
      !belongs(binding.writer, producer.receipt) ||
      !belongs(input, consumer.receipt)
    ) {
      throw new Error("finance_book_custody_route_or_owner_conflict");
    }
    const writer = object(JSON.parse(await readHandoffField(binding.writer)) as unknown);
    const sourceRead = object(await readConsumer(binding.receipt));
    const sourceWrite = object(await readConsumer(binding.sourceScope));
    const caller = object(await readConsumer(binding.callerInput));
    const callerSource = object(await readConsumer(binding.callerSource));
    const validPin = (value: Record<string, unknown> | undefined) =>
      value &&
      typeof value.path === "string" &&
      path.isAbsolute(value.path) &&
      typeof value.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(value.sha256) &&
      typeof value.bytes === "number" &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0;
    if (
      !validPin(writer) ||
      !validPin(sourceWrite) ||
      !validPin(sourceRead) ||
      sourceRead?.status !== "read" ||
      !isDeepStrictEqual(sourceRead.usedFields, ["conviction", "outcome"]) ||
      typeof caller?.directory !== "string" ||
      !path.isAbsolute(caller.directory)
    ) {
      throw new Error("finance_book_custody_original_read_or_caller_missing");
    }
    if (
      producer.scope !== JSON.stringify(writer?.path) ||
      consumer.scope !== JSON.stringify(caller.directory)
    ) {
      throw new Error("finance_book_custody_non_book_scope");
    }
    // The host parser intentionally drops appended/skipped. Validate that exact projection,
    // then the actual callee arguments and its independent same-Buffer readback.
    const expected = { path: writer?.path, sha256: writer?.sha256, bytes: writer?.bytes };
    if (
      typeof expected.path !== "string" ||
      !isDeepStrictEqual(sourceWrite, expected) ||
      !isDeepStrictEqual(caller.expectedSource, expected) ||
      !isDeepStrictEqual(await readConsumer(input), expected) ||
      sourceRead.path !== expected.path ||
      sourceRead.sha256 !== expected.sha256 ||
      sourceRead.bytes !== expected.bytes ||
      path.resolve(financeResearchScoredPath(caller.directory)) !== path.resolve(expected.path)
    ) {
      throw new Error("finance_book_custody_path_hash_bytes_or_input_conflict");
    }
    if (
      binding.writer.pointer === "" ||
      !binding.writer.pointer.endsWith("/scoredFiled") ||
      typeof writer?.appended !== "number" ||
      !Number.isSafeInteger(writer.appended) ||
      writer.appended < 0 ||
      typeof writer?.skipped !== "number" ||
      !Number.isSafeInteger(writer.skipped) ||
      writer.skipped < 0
    ) {
      throw new Error("finance_book_custody_original_writer_missing");
    }
    const schedulerPath = path.join(repoRoot, "scripts/operator/lcx-finance-scheduler.ts");
    const schedulerBytes = await fs.readFile(schedulerPath);
    const ast = ts.createSourceFile(
      schedulerPath,
      schedulerBytes.toString("utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const functionHashes = new Map(
      ast.statements
        .filter(ts.isFunctionDeclaration)
        .map((declaration) => [
          declaration.name?.text,
          createHash("sha256").update(declaration.getText(ast)).digest("hex"),
        ]),
    );
    if (
      !callerSource ||
      callerSource.path !== schedulerPath ||
      callerSource.sha256 !== createHash("sha256").update(schedulerBytes).digest("hex") ||
      !functionHashes.has("parseNightSettlement") ||
      !functionHashes.has("runNightTuning") ||
      callerSource.parserSha256 !== functionHashes.get("parseNightSettlement") ||
      callerSource.callerSha256 !== functionHashes.get("runNightTuning")
    ) {
      throw new Error("finance_book_custody_original_caller_source_conflict");
    }
    const raw = binding.ledgerRaw;
    if (
      !raw ||
      typeof raw.path !== "string" ||
      !raw.path ||
      raw.sha256 !== expected.sha256 ||
      raw.bytes !== expected.bytes
    ) {
      throw new Error("finance_book_custody_raw_snapshot_pin_conflict");
    }
    // A retained raw copy may have a different archive locator. It is never parsed as receipt JSON.
    const buffer = await fs.readFile(raw.path);
    if (
      buffer.length !== raw.bytes ||
      createHash("sha256").update(buffer).digest("hex") !== raw.sha256
    ) {
      throw new Error("finance_book_custody_raw_snapshot_hash_conflict");
    }
    return;
  }
  if (binding.kind === "active_strategy_rule_input") {
    if (edge.from !== "strategy_rule_ledger" || edge.to !== "finance_research_modules") {
      throw new Error("active_rule_binding_owner_conflict");
    }
    const asOf = await readConsumer(binding.asOf);
    const packet = await readConsumer(input);
    if (typeof asOf !== "string" || typeof packet !== "string") {
      throw new Error("active_rule_binding_input_missing");
    }
    const use = assertFinanceResearchRuleUse(
      await readConsumer(binding.receipt),
      [
        {
          id: "finance-controller:active-strategies",
          source: "finance-strategy-rule-ledger",
          timestamp: asOf,
          text: packet,
        },
      ],
      financeResearchPortfolioContextSchema.parse(await readConsumer(binding.portfolioContext)),
      asOf,
    );
    const sourceScope = await readConsumer(binding.sourceScope);
    const childRunId = await readConsumer(binding.consumerRunId);
    const parentRunId = await readConsumer(binding.parentRunId);
    if (
      !use ||
      !isDeepStrictEqual(sourceScope, use.source) ||
      !isDeepStrictEqual(sourceScope, JSON.parse(producer.scope)) ||
      typeof childRunId !== "string" ||
      !childRunId.trim() ||
      JSON.stringify(childRunId) !== consumer.scope ||
      typeof parentRunId !== "string" ||
      !parentRunId.trim() ||
      parentRunId !== use.parentRunId
    ) {
      throw new Error("active_rule_binding_source_or_invocation_conflict");
    }
    return;
  }
  if (binding.kind === "scheduled_research_input") {
    if (
      edge.from !== "schedule_gate" ||
      edge.to !== "finance_research_modules" ||
      !belongs(binding.expectedPin, producer.receipt) ||
      !belongs(binding.sourceAccount, producer.receipt) ||
      binding.manifest.pointer !== ""
    ) {
      throw new Error("scheduled_research_binding_owner_conflict");
    }
    const expectedPin = JSON.parse(await readHandoffField(binding.expectedPin)) as unknown;
    const receivedPin = await readConsumer(binding.receipt);
    const sourceScope = await readConsumer(binding.sourceScope);
    const childRunId = await readConsumer(binding.consumerRunId);
    const manifestBytes = await fs.readFile(binding.manifest.path);
    const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
    if (manifestSha !== binding.manifest.sha256) {
      throw new Error("scheduled_research_manifest_hash_conflict");
    }
    const manifest = financeScheduledResearchHandoffSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    const witness = financeResearchControllerHandoffSchema.parse({
      ...manifest,
      producer: receivedPin,
    });
    if (
      !isDeepStrictEqual(expectedPin, witness.producer) ||
      !path.isAbsolute(witness.producer.path) ||
      witness.producer.sha256 !== manifestSha ||
      witness.producer.bytes !== manifestBytes.length ||
      !isDeepStrictEqual(sourceScope, manifest.sourceScope) ||
      manifest.sourceScope.runId !== JSON.parse(producer.scope) ||
      typeof childRunId !== "string" ||
      !childRunId.trim() ||
      JSON.stringify(childRunId) !== consumer.scope
    ) {
      throw new Error("scheduled_research_producer_or_run_conflict");
    }
    // A separate retained copy preserves the original manifest bytes, not a new runtime path.
    const sourceAccount: unknown = JSON.parse(await readHandoffField(binding.sourceAccount));
    const targetAccount = await readConsumer(binding.targetAccount);
    const targetVenue = await readConsumer(binding.targetVenue);
    const targetAsOf = await readConsumer(binding.targetAsOf);
    if (
      sourceAccount !== manifest.sourceScope.accountId ||
      targetAccount !== sourceAccount ||
      targetVenue !== manifest.sourceScope.venue ||
      typeof targetAsOf !== "string" ||
      Date.parse(targetAsOf) !== Date.parse(manifest.sourceScope.asOf) ||
      !isDeepStrictEqual(await readConsumer(input), manifest.inputs)
    ) {
      throw new Error("scheduled_research_input_scope_conflict");
    }
    return;
  }
  const pin = object(await readConsumer(binding.receipt));
  if (!pin || typeof pin.path !== "string" || pin.sha256 !== producer.receipt.sha256) {
    throw new Error("scope_binding_source_receipt_mismatch");
  }
  let sourcePath = pin.path;
  if (!path.isAbsolute(sourcePath)) {
    const workspace = binding.workspace ? await readConsumer(binding.workspace) : undefined;
    if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
      throw new Error("scope_binding_source_workspace_missing");
    }
    sourcePath = path.resolve(workspace, sourcePath);
  }
  if (path.resolve(sourcePath) !== path.resolve(producer.receipt.path)) {
    throw new Error("scope_binding_source_receipt_mismatch");
  }
  if (!belongs(binding.sourceScope, consumer.receipt)) {
    throw new Error("scope_binding_not_in_consumer_receipt");
  }
  if ((await readHandoffField(binding.sourceScope)) !== producer.scope) {
    throw new Error("scope_binding_source_scope_mismatch");
  }
  if (binding.kind === "historical_to_attempt") {
    if (!belongs(binding.sourceAccount, producer.receipt)) {
      throw new Error("scope_binding_account_not_in_producer_receipt");
    }
    const sourceAccount: unknown = JSON.parse(await readHandoffField(binding.sourceAccount));
    const targetAccount = await readConsumer(binding.targetAccount);
    const sourceScope = object(JSON.parse(producer.scope));
    const targetScope = object(JSON.parse(consumer.scope));
    if (
      typeof sourceAccount !== "string" ||
      !sourceAccount.trim() ||
      sourceAccount !== targetAccount ||
      sourceScope?.accountId !== sourceAccount ||
      targetScope?.accountId !== targetAccount ||
      typeof sourceScope.runId !== "string" ||
      !sourceScope.runId.trim() ||
      typeof targetScope.runId !== "string" ||
      !targetScope.runId.trim()
    ) {
      throw new Error("scope_binding_account_conflict");
    }
  } else if (binding.kind === "verified_memory_read") {
    const workspaceRef = binding.workspace;
    if (
      !workspaceRef ||
      edge.from !== "memory_recall" ||
      edge.to !== "source_conflict_review" ||
      consumer.scopeRef.pointer !== "/sourceReview/scope" ||
      binding.receipt.pointer !== "/sourceReview/memoryRecall/artifact" ||
      binding.sourceScope.pointer !== "/sourceReview/memoryRecall/artifact/invocation" ||
      binding.memoryRecall.pointer !== "/sourceReview/memoryRecall" ||
      binding.expectedMemoryScope.pointer !== "/sourceReviewRequest/expectedMemoryScope" ||
      binding.artifactStorePath.pointer !== "/sourceReviewRequest/artifactStorePath" ||
      workspaceRef.pointer !== "/workspaceDir" ||
      input.pointer !== "/sourceReview/memoryRecall/selectedText" ||
      !belongs(input, consumer.receipt)
    ) {
      throw new Error("scope_binding_memory_read_route_invalid");
    }
    const workspace = await readConsumer(workspaceRef);
    const expectedMemoryScope = object(await readConsumer(binding.expectedMemoryScope));
    const currentScope = object(JSON.parse(consumer.scope));
    const artifactStorePath = await readConsumer(binding.artifactStorePath);
    if (
      typeof workspace !== "string" ||
      !path.isAbsolute(workspace) ||
      typeof artifactStorePath !== "string" ||
      typeof currentScope?.accountId !== "string" ||
      typeof currentScope.runId !== "string" ||
      typeof expectedMemoryScope?.accountId !== "string" ||
      typeof expectedMemoryScope.runId !== "string"
    ) {
      throw new Error("scope_binding_memory_read_host_missing");
    }
    // Reuse the original read-only consumer, including primary/historical account,
    // source/body pins and a fresh memory_get comparison. Observation is not source truth.
    const fresh = await readSelfRepairCandidateReviewInput({
      workspaceDir: workspace,
      receipt: {
        path: path.relative(workspace, consumer.receipt.path),
        sha256: consumer.receipt.sha256,
      },
      scope: { accountId: currentScope.accountId, runId: currentScope.runId },
      expectedMemoryScope: {
        accountId: expectedMemoryScope.accountId,
        runId: expectedMemoryScope.runId,
      },
      artifactStorePath,
    });
    const recorded = await readConsumer(binding.memoryRecall);
    const selected: unknown = JSON.parse(await readHandoffField(input));
    if (
      !fresh.memoryRecall ||
      !isDeepStrictEqual(recorded, fresh.memoryRecall) ||
      selected !== fresh.memoryRecall.selectedText ||
      fresh.memoryRecall.semanticTruth !== "not_proven" ||
      fresh.memoryRecall.reuseAllowed ||
      fresh.memoryRecall.actionAuthority
    ) {
      throw new Error("scope_binding_memory_readback_mismatch");
    }
  } else if (binding.kind === "read_only_observation") {
    const hostRunId = await readConsumer(binding.hostRunId);
    const parentRunId = await readConsumer(binding.ownerParentRunId);
    const snapshot = await readConsumer(binding.ownerSnapshot);
    const phase = await readConsumer(binding.ownerPhase);
    const childPrefix = binding.ownerParentRunId.pointer.replace(/\/parentRunId$/, "");
    const commandPrefix = childPrefix.replace(/\/runReceipt$/, "");
    const compact = binding.receipt.pointer.match(
      /^(\/owners\/([^/]+)\/latestWrittenReceipt)\/receipt$/,
    );
    if (
      !/^\/ownerCommands\/\d+\/runReceipt$/.test(childPrefix) ||
      !compact ||
      !binding.sourceScope.pointer.startsWith(`${compact[1]}/`) ||
      (input.pointer !== compact[1] && !input.pointer.startsWith(`${compact[1]}/`))
    ) {
      throw new Error("scope_binding_observation_identity_conflict");
    }
    const ownerId = compact?.[2].replace(/~1/g, "/").replace(/~0/g, "~");
    const commandId = await readConsumer({ ...consumer.receipt, pointer: `${commandPrefix}/id` });
    const childOwner = await readConsumer({ ...consumer.receipt, pointer: `${childPrefix}/owner` });
    const nativeSnapshot = object(snapshot);
    if (
      typeof hostRunId !== "string" ||
      !hostRunId.trim() ||
      hostRunId !== parentRunId ||
      !["/runId", "/runReceipt/runId"].includes(binding.hostRunId.pointer) ||
      !["/snapshot", "/runReceipt/snapshot"].includes(consumer.scopeRef.pointer) ||
      ownerId !== commandId ||
      ownerId !== childOwner ||
      binding.ownerSnapshot.pointer !== `${childPrefix}/snapshot` ||
      binding.ownerPhase.pointer !== `${childPrefix}/phase` ||
      !["snapshotId", "observedAt", "sourceCommit", "sourceBranch", "authorityOwner"].every(
        (key) => typeof nativeSnapshot?.[key] === "string" && String(nativeSnapshot[key]).trim(),
      ) ||
      (await readHandoffField(binding.ownerSnapshot)) !== consumer.scope ||
      phase !== "observe"
    ) {
      throw new Error("scope_binding_observation_identity_conflict");
    }
  } else {
    throw new Error("scope_binding_kind_invalid");
  }
}

async function isOriginalPostBlockObserver(
  nodeId: FlowNodeId,
  receipt: WorkflowFieldRef,
  scope: string,
): Promise<boolean> {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const read = (pointer: string) => readHandoffField({ ...receipt, pointer });
  const root = object(JSON.parse(await read("")) as unknown);
  const run = object(root?.runReceipt);
  const snapshot = object(run?.snapshot);
  if (
    !root ||
    !run ||
    !snapshot ||
    run.owner !== "lcx-governance-autopilot" ||
    run.phase !== "observe" ||
    typeof run.runId !== "string" ||
    !run.runId.trim() ||
    ["snapshotId", "observedAt", "sourceCommit", "sourceBranch", "authorityOwner"].some(
      (key) => typeof snapshot[key] !== "string" || !String(snapshot[key]).trim(),
    ) ||
    (await read("/runReceipt/snapshot")) !== scope ||
    (await read("/snapshot")) !== scope ||
    ["liveTouched", "providerConfigTouched", "protectedMemoryTouched"].some(
      (key) => root[key] !== false,
    )
  ) {
    return false;
  }
  if (nodeId === "owner_coverage_map") {
    return (
      root.kind === "lcx-owner-control-map" && root.boundary === "local_owner_control_map_only"
    );
  }
  if (
    nodeId !== "governance_autopilot" ||
    root.boundary !== "local_governance_autopilot_only" ||
    root.runId !== run.runId ||
    !Array.isArray(root.ownerCommands)
  ) {
    return false;
  }
  const children = root.ownerCommands
    .map((value, index) => ({ value: object(value), index }))
    .filter((child) => child.value?.id === "selfRepairHands");
  const child = children.length === 1 ? object(children[0].value?.runReceipt) : undefined;
  return (
    child?.owner === "selfRepairHands" &&
    child.phase === "observe" &&
    child.parentRunId === run.runId &&
    (await read(`/ownerCommands/${children[0].index}/runReceipt/snapshot`)) === scope
  );
}

async function verifyTrainingCooldownContinuation(
  witness: NonNullable<WorkflowHandoffEvidence["controlContinuations"]>[number],
  producer: { receipt: WorkflowFieldRef; scope: string; output?: string },
  consumer: { receipt: WorkflowFieldRef; scope: string },
) {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("cooldown_control_receipt_invalid");
    }
    return value as Record<string, unknown>;
  };
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (
    witness.receipt.pointer !== "" ||
    witness.receipt.json ||
    [producer.receipt, consumer.receipt].some(
      (ref) =>
        path.resolve(ref.path) !== path.resolve(witness.receipt.path) ||
        ref.sha256 !== witness.receipt.sha256,
    ) ||
    producer.scope !== consumer.scope
  ) {
    throw new Error("cooldown_control_owner_receipt_conflict");
  }
  await readHandoffField(witness.receipt);
  // This owner's native decision hash uses original JSON key order, not canonical field order.
  const proofBytes = await fs.readFile(witness.receipt.path, "utf8");
  if (hash(proofBytes) !== witness.receipt.sha256) {
    throw new Error("cooldown_control_receipt_hash_conflict");
  }
  const proof = record(JSON.parse(proofBytes));
  const options = record(proof.options);
  const callerRef = record(record(proof.caller).caller);
  if (
    proof.boundary !==
      "original_complete_guard_two_rounds_deadline_clock_and_low_worker_IO_substitutes_no_semantic_model_success" ||
    JSON.stringify(options.workspaceDir) !== producer.scope ||
    !Array.isArray(proof.receipts) ||
    !Array.isArray(proof.quotaRuns) ||
    proof.quotaRuns.length !== 2
  ) {
    throw new Error("cooldown_control_scope_conflict");
  }
  const rows = proof.receipts.map(record);
  const starts = rows.filter((row) => row.event === "evolution_cooldown" && row.round === 1);
  const completions = rows.filter(
    (row) => row.event === "evolution_cooldown_completed" && row.round === 1,
  );
  if (starts.length !== 1 || completions.length !== 1) {
    throw new Error("cooldown_control_completion_missing");
  }
  const start = starts[0],
    complete = completions[0];
  if (
    producer.receipt.pointer !== `/receipts/${rows.indexOf(start)}/event` ||
    producer.output !== JSON.stringify(start.event) ||
    start.heavyWorkPaused !== true ||
    typeof start.durationMs !== "number" ||
    start.durationMs <= 0 ||
    typeof start.requestedDurationMs !== "number" ||
    start.durationMs > start.requestedDurationMs ||
    complete.durationMs !== start.durationMs ||
    !isDeepStrictEqual(complete.callerRef, callerRef) ||
    complete.upstreamDecisionSha256 !== hash(JSON.stringify(record(start.upstreamDecision)))
  ) {
    throw new Error("cooldown_control_producer_or_caller_conflict");
  }
  const next = record(proof.quotaRuns[1]);
  const invocation = record(next.invocation);
  const input = record(invocation.guardLogInput);
  if (
    typeof input.raw !== "string" ||
    hash(input.raw) !== input.sha256 ||
    input.path !== callerRef.path
  ) {
    throw new Error("cooldown_control_guard_input_conflict");
  }
  const lines = input.raw.split(/\r?\n/u).filter(Boolean);
  const inputRows = lines.map((line) => record(JSON.parse(line)));
  const first = inputRows[0];
  const callerIndex =
    typeof callerRef.pointer === "string" && /^line:[1-9]\d*$/u.test(callerRef.pointer)
      ? Number(callerRef.pointer.slice(5)) - 1
      : -1;
  if (
    callerIndex !== 0 ||
    hash(lines[0] ?? "") !== callerRef.sha256 ||
    first.event !== "training_caller_start" ||
    first.owner !== "minimax-brain-training-guard" ||
    first.runId !== callerRef.runId ||
    first.workspaceDir !== options.workspaceDir ||
    !inputRows.some((row) => isDeepStrictEqual(row, start)) ||
    !inputRows.some((row) => isDeepStrictEqual(row, complete)) ||
    !Array.isArray(invocation.args) ||
    !Array.isArray(invocation.actualArgs)
  ) {
    throw new Error("cooldown_control_completion_not_consumed");
  }
  const args = invocation.actualArgs;
  const flag = (name: string) => args[args.indexOf(name) + 1];
  const nextCaller: unknown =
    typeof flag("--caller-receipt") === "string"
      ? JSON.parse(String(flag("--caller-receipt")))
      : undefined;
  if (
    !args.includes("scripts/operator/minimax-quota-brain-saturator.ts") ||
    !isDeepStrictEqual(nextCaller, callerRef) ||
    flag("--guard-log") !== input.path ||
    flag("--workspace") !== options.workspaceDir
  ) {
    throw new Error("cooldown_control_next_caller_conflict");
  }
  if (!Array.isArray(next.receipts)) {
    throw new Error("cooldown_control_quota_start_missing");
  }
  const quotaStart = record(next.receipts[0]);
  const quotaLog = record(next.logReadback);
  const quotaRawFirst = typeof quotaLog.raw === "string" ? quotaLog.raw.split(/\r?\n/u)[0] : "";
  if (
    quotaStart.event !== "quota_saturator_start" ||
    !isDeepStrictEqual(JSON.parse(quotaRawFirst), quotaStart)
  ) {
    throw new Error("cooldown_control_quota_start_missing");
  }
  const at = (value: unknown) => (typeof value === "string" ? Date.parse(value) : NaN);
  const times = [
    at(start.at),
    at(complete.startedAt),
    at(complete.completedAt),
    at(complete.at),
    at(quotaStart.at),
  ];
  if (
    times.some((time) => !Number.isFinite(time)) ||
    times.some((time, index) => index > 0 && time < times[index - 1]) ||
    times[2] - times[1] < start.durationMs
  ) {
    throw new Error("cooldown_control_quota_started_early");
  }
  const sourcePin = record(record(proof.source).guard);
  if (
    sourcePin.path !== witness.guardSource.path ||
    sourcePin.sha256 !== witness.guardSource.sha256 ||
    !witness.guardSource.path.endsWith("/scripts/operator/minimax-brain-training-guard.ts")
  ) {
    throw new Error("cooldown_control_source_pin_conflict");
  }
  const source = await fs.readFile(
    path.join(repoRoot, "scripts/operator/minimax-brain-training-guard.ts"),
    "utf8",
  );
  if (hash(source) !== witness.guardSource.sha256) {
    throw new Error("cooldown_control_source_hash_conflict");
  }
  const ast = ts.createSourceFile("guard.ts", source, ts.ScriptTarget.Latest, true);
  const cooldown = ast.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "runEvolutionCooldown",
  );
  const awaitedCall = (node: ts.Statement, name: string) =>
    ts.isExpressionStatement(node) &&
    ts.isAwaitExpression(node.expression) &&
    ts.isCallExpression(node.expression.expression) &&
    ts.isIdentifier(node.expression.expression.expression) &&
    node.expression.expression.expression.text === name;
  const body = cooldown?.body?.statements ?? [];
  const sleepIndex = body.findIndex((node) => awaitedCall(node, "sleep"));
  const completedIndex = body.findIndex(
    (node) =>
      awaitedCall(node, "appendLog") &&
      node.getText(ast).includes('event: "evolution_cooldown_completed"'),
  );
  const entry = ast.statements.find(ts.isTryStatement);
  const loop = entry?.tryBlock.statements.find(ts.isWhileStatement);
  const loopBody = loop && ts.isBlock(loop.statement) ? loop.statement.statements : [];
  if (
    sleepIndex < 0 ||
    completedIndex <= sleepIndex ||
    !entry ||
    hash(entry.getText(ast)) !== sourcePin.entryTrySha256 ||
    !loopBody.length ||
    !awaitedCall(loopBody[loopBody.length - 1], "runEvolutionCooldown") ||
    !loop
      ?.getText(ast)
      .includes("await runTeacherStepOrRetire(options, round, minimaxTeacherRetired)")
  ) {
    throw new Error("cooldown_control_original_await_not_verified");
  }
}

type WorkflowHandoffAuditResult = {
  scenarioId: FlowScenarioId;
  status: string;
  proofLevel: "structure_only" | "receipt_handoff_only";
  owner: string;
  semanticAdoption: "not_proven";
  evidenceOrigin?: WorkflowHandoffEvidence["environment"];
  missing?: readonly FlowNodeId[];
  blocked?: FlowNodeId[];
  gaps: Array<{ node: string; owner: string; reason: string }>;
  controlAttemptsObserved?: string[];
  controlAttemptBoundary?: "debug_dispatch_attempt_only_child_execution_not_observed";
  controlContinuationsObserved?: string[];
  controlBoundary?: "original_await_continuation_only_not_text_or_model_adoption";
};

export async function auditWorkflowHandoffs(
  evidence: readonly WorkflowHandoffEvidence[] = [],
): Promise<WorkflowHandoffAuditResult[]> {
  if (
    !Array.isArray(evidence) ||
    evidence.some(
      (item) =>
        !item ||
        !SCENARIO_IDS.includes(item.scenarioId) ||
        !Array.isArray(item.nodes) ||
        item.nodes.some(
          (node: WorkflowHandoffEvidence["nodes"][number]) =>
            !node || typeof node.nodeId !== "string",
        ),
    )
  ) {
    throw new Error(
      "handoff_evidence_index_invalid: expected known scenarios and node receipt references",
    );
  }
  return Promise.all(
    FLOW_SCENARIOS.map(async (scenario) => {
      const contract = LCX_ONTOLOGY_REGISTRY.workflowProcesses[scenario.id];
      const entries = evidence.filter((item) => item.scenarioId === scenario.id);
      const observation = entries[0];
      const gaps: Array<{ node: string; owner: string; reason: string }> = [];
      const ownerFor = (node: string) =>
        contract.stages.find((stage) => (stage.nodes as readonly string[]).includes(node))?.owner ??
        contract.entrypoint;
      const gap = (node: string, reason: string) =>
        gaps.push({ node, owner: ownerFor(node), reason });
      if (!observation) {
        return {
          scenarioId: scenario.id,
          status: "not_observed",
          proofLevel: "structure_only",
          owner: contract.entrypoint,
          missing: scenario.requiredNodes,
          semanticAdoption: "not_proven",
          gaps: [
            {
              node: scenario.start,
              owner: ownerFor(scenario.start),
              reason: "original_producer_and_consumer_receipts_required",
            },
          ],
        };
      }
      if (
        entries.length !== 1 ||
        !["offline_fixture", "natural_receipt"].includes(observation.environment)
      ) {
        gap(scenario.start, "ambiguous_evidence_index");
      }
      const nodes = new Map<
        FlowNodeId,
        {
          receipt: WorkflowFieldRef;
          scope: string;
          scopeRef: WorkflowFieldRef;
          output?: string;
          outputRef?: string;
          outputs: Map<string, string>;
          outputRefs: Map<string, string>;
          blocked: boolean;
          blockFilter?: FlowFilterId;
          blockReason?: string;
          blockStatus?: string;
          inputs: Map<string, string>;
          inputRefs: Map<string, string>;
          inputFields: Map<string, WorkflowFieldRef>;
          scopeBindings: Map<string, WorkflowScopeBinding>;
        }
      >();
      for (const entry of observation.nodes) {
        if (
          !scenario.requiredNodes.includes(entry.nodeId) &&
          !scenario.feedbackEdges?.flat().includes(entry.nodeId)
        ) {
          gap(entry.nodeId, "node_outside_scenario");
          continue;
        }
        if (nodes.has(entry.nodeId)) {
          gap(entry.nodeId, "duplicate_node_observation");
          continue;
        }
        const stage = LCX_ONTOLOGY_REGISTRY.workflowProcesses[scenario.id].stages.find(
          (candidate) => (candidate.nodes as readonly string[]).includes(entry.nodeId),
        );
        if (
          stage &&
          "implementationStatus" in stage &&
          String(stage.implementationStatus) === "required_not_implemented"
        ) {
          gap(entry.nodeId, "original_consumer_not_implemented");
        }
        try {
          const ownerReceipt = entry.output ?? entry.outputs?.[0]?.value ?? entry.block?.status;
          const sameReceipt = (ref: WorkflowFieldRef) =>
            ownerReceipt &&
            path.resolve(ref.path) === path.resolve(ownerReceipt.path) &&
            ref.sha256 === ownerReceipt.sha256;
          if (!sameReceipt(entry.scope)) {
            throw new Error("scope_not_in_owner_receipt");
          }
          if (
            entry.block &&
            (!sameReceipt(entry.block.status) || !sameReceipt(entry.block.reason))
          ) {
            throw new Error("block_not_in_owner_receipt");
          }
          const scope = await readHandoffField(entry.scope);
          const output = entry.output ? await readHandoffField(entry.output) : undefined;
          let blocked = false;
          let blockReason: string | undefined;
          let blockStatus: string | undefined;
          if (entry.nodeId === "cleanup_candidate_review" && output !== undefined) {
            const review: unknown = JSON.parse(output);
            if (
              !review ||
              typeof review !== "object" ||
              Array.isArray(review) ||
              !("status" in review) ||
              !["reviewed", "blocked"].includes(String(review.status)) ||
              !("cleanupAuthorized" in review) ||
              review.cleanupAuthorized !== false ||
              !("semanticTruth" in review) ||
              review.semanticTruth !== "not_proven" ||
              !("sourceReads" in review) ||
              !Array.isArray(review.sourceReads) ||
              !("dispositions" in review) ||
              !Array.isArray(review.dispositions)
            ) {
              throw new Error("original_cleanup_review_verdict_missing");
            }
          }
          if (entry.block) {
            const status = JSON.parse(await readHandoffField(entry.block.status)) as unknown;
            const reason = JSON.parse(await readHandoffField(entry.block.reason)) as unknown;
            blocked =
              scenario.requiredFilters.includes(entry.block.filter) &&
              typeof status === "string" &&
              ((status === "ran_failed" && entry.block.filter === "error_receipt_required") ||
                (status === "channel_runtime_probe_failed" &&
                  entry.nodeId === "external_channel_binding" &&
                  entry.block.filter === "external_channel_probe_required") ||
                /^(blocked|refused|unavailable|missing|failed|timed_out|timeout|hold|not_ready|needs_review|quality-failed|execution-failed|verification-failed|verification-blocked|incomplete|unresolved)(?:$|_)/.test(
                  status,
                )) &&
              typeof reason === "string" &&
              reason.trim().length > 0;
            if (!blocked) {
              gap(entry.nodeId, "unproven_or_unknown_block");
            } else {
              blockReason = reason as string;
              blockStatus = status as string;
            }
          }
          const inputs = new Map<string, string>();
          const inputRefs = new Map<string, string>();
          const inputFields = new Map<string, WorkflowFieldRef>();
          const scopeBindings = new Map<string, WorkflowScopeBinding>();
          const refKey = (ref: WorkflowFieldRef) =>
            JSON.stringify([
              path.resolve(ref.path),
              ref.pointer,
              ref.sha256,
              (ref.json ?? []).map((step) => [step.pointer, step.after ?? null]),
            ]);
          const outputs = new Map<string, string>();
          const outputRefs = new Map<string, string>();
          for (const port of entry.outputs ?? []) {
            if (!sameReceipt(port.value)) {
              throw new Error("output_not_in_producer_receipt");
            }
            if (
              ![...scenario.edges, ...(scenario.feedbackEdges ?? [])].some(
                ([from, to]) => from === entry.nodeId && to === port.to,
              )
            ) {
              throw new Error("output_target_outside_scenario");
            }
            if (outputs.has(port.to)) {
              gap(entry.nodeId, `duplicate_output:${port.to}`);
            }
            outputs.set(port.to, await readHandoffField(port.value));
            outputRefs.set(port.to, refKey(port.value));
          }
          for (const input of entry.inputs ?? []) {
            if (!sameReceipt(input.value)) {
              throw new Error("consumption_not_in_consumer_receipt");
            }
            if (inputs.has(input.from)) {
              gap(entry.nodeId, `duplicate_consumption:${input.from}`);
            }
            inputs.set(input.from, await readHandoffField(input.value));
            inputRefs.set(input.from, refKey(input.value));
            inputFields.set(input.from, input.value);
            if (input.scopeBinding) {
              scopeBindings.set(input.from, input.scopeBinding);
            }
          }
          if (output === undefined && outputs.size === 0 && !blocked) {
            gap(entry.nodeId, "producer_output_missing");
          }
          nodes.set(entry.nodeId, {
            receipt: ownerReceipt!,
            scope,
            scopeRef: entry.scope,
            output,
            outputRef: entry.output ? refKey(entry.output) : undefined,
            outputs,
            outputRefs,
            blocked,
            blockFilter: blocked ? entry.block?.filter : undefined,
            blockReason,
            blockStatus,
            inputs,
            inputRefs,
            inputFields,
            scopeBindings,
          });
        } catch (error) {
          gap(entry.nodeId, error instanceof Error ? error.message : "receipt_unreadable");
        }
      }
      const verifiedControlContinuations = new Set<string>();
      if (observation.controlContinuations !== undefined) {
        if (
          !Array.isArray(observation.controlContinuations) ||
          observation.controlContinuations.length !== 1
        ) {
          gap(scenario.start, "control_continuation_route_invalid");
        } else {
          const witness = observation.controlContinuations[0];
          const producer = witness ? nodes.get(witness.from) : undefined,
            consumer = witness ? nodes.get(witness.to) : undefined;
          if (
            !witness ||
            scenario.id !== "training_failure_feedback_waterflow" ||
            observation.environment !== "offline_fixture" ||
            witness.kind !== "training_cooldown_resume" ||
            witness.from !== "evolution_cooldown" ||
            witness.to !== "teacher_quota" ||
            !scenario.feedbackEdges?.some(
              ([from, to]) => from === witness.from && to === witness.to,
            ) ||
            !producer ||
            !consumer
          ) {
            gap(scenario.start, "control_continuation_route_invalid");
          } else {
            try {
              await verifyTrainingCooldownContinuation(witness, producer, consumer);
              verifiedControlContinuations.add(edgeKey([witness.from, witness.to]));
            } catch (error) {
              gap(
                witness.to,
                error instanceof Error ? error.message : "control_continuation_unverified",
              );
            }
          }
        }
      }
      const verifiedFeedbackReads = new Set<string>();
      if (observation.feedbackReads !== undefined) {
        if (!Array.isArray(observation.feedbackReads)) {
          gap(scenario.start, "feedback_read_index_invalid");
        } else {
          const routeCount = observation.feedbackReads.filter(
            (read: NonNullable<WorkflowHandoffEvidence["feedbackReads"]>[number]) =>
              read?.kind === "self_repair_diagnostic" &&
              read.from === "owner_coverage_map" &&
              read.to === "self_repair_hands",
          ).length;
          for (const read of observation.feedbackReads) {
            if (read?.kind === "directed_review_diagnostic") {
              if (
                scenario.id !== "directed_daily_research_brief_waterflow" ||
                read.from !== "review_panel" ||
                read.to !== "finance_research_modules" ||
                observation.feedbackReads.filter(
                  (item: NonNullable<WorkflowHandoffEvidence["feedbackReads"]>[number]) =>
                    item.kind === read.kind,
                ).length !== 1
              ) {
                gap(scenario.start, "feedback_read_route_invalid");
                continue;
              }
              try {
                const producer = nodes.get(read.from);
                if (!producer) {
                  throw new Error("directed_feedback_producer_not_observed");
                }
                await verifyDirectedReviewDiagnosticFeedback(read.receipt, read.source, producer);
                verifiedFeedbackReads.add(edgeKey([read.from, read.to]));
              } catch (error) {
                gap(
                  read.to,
                  error instanceof Error ? error.message : "directed_feedback_unavailable",
                );
              }
              continue;
            }
            if (read?.kind === "commercial_refusal_diagnostic") {
              if (
                scenario.id !== "commercial_answer_pipeline_waterflow" ||
                observation.environment !== "offline_fixture" ||
                read.from !== "local_contract_audit" ||
                read.to !== "local_brain_planner" ||
                !scenario.feedbackEdges?.some(([from, to]) => from === read.from && to === read.to)
              ) {
                gap(scenario.start, "feedback_read_route_invalid");
                continue;
              }
              if (
                observation.feedbackReads.filter(
                  (value: NonNullable<WorkflowHandoffEvidence["feedbackReads"]>[number]) =>
                    value?.kind === read.kind && value.from === read.from && value.to === read.to,
                ).length !== 1
              ) {
                gap(read.to, "feedback_read_duplicate");
                continue;
              }
              try {
                const producer = nodes.get(read.from);
                if (!producer) {
                  throw new Error("feedback_current_producer_not_observed");
                }
                await verifyCommercialRefusalFeedback(read.receipt, producer);
                verifiedFeedbackReads.add(edgeKey([read.from, read.to]));
              } catch (error) {
                gap(
                  read.to,
                  `feedback_read_${error instanceof Error ? error.message.replace(/^feedback_/u, "") : "unavailable"}`,
                );
              }
              continue;
            }

            if (
              scenario.id !== "self_repair_hands_waterflow" ||
              read?.kind !== "self_repair_diagnostic" ||
              read.from !== "owner_coverage_map" ||
              read.to !== "self_repair_hands" ||
              !scenario.feedbackEdges?.some(([from, to]) => from === read.from && to === read.to)
            ) {
              gap(scenario.start, "feedback_read_route_invalid");
              continue;
            }
            if (routeCount !== 1) {
              gap(read.to, "feedback_read_duplicate");
              continue;
            }
            try {
              const producer = nodes.get(read.from);
              if (!producer) {
                throw new Error("feedback_current_producer_not_observed");
              }
              await verifySelfRepairDiagnosticFeedback(read.receipt, producer);
              verifiedFeedbackReads.add(edgeKey([read.from, read.to]));
            } catch (error) {
              const reason = error instanceof Error ? error.message : "unavailable";
              gap(read.to, `feedback_read_${reason.replace(/^feedback_/u, "")}`);
            }
          }
        }
      }
      const scopeParents = new Map([...nodes.values()].map((node) => [node.scope, node.scope]));
      const scopeRoot = (scope: string): string => {
        const parent = scopeParents.get(scope)!;
        return parent === scope ? scope : scopeRoot(parent);
      };
      const blocked = [...nodes.entries()].filter(([, node]) => node.blocked).map(([node]) => node);
      const blockedReceipts = new Set<FlowNodeId>();
      for (const [from, to] of scenario.blockedReceiptContinuations ?? []) {
        const producer = nodes.get(from),
          consumer = nodes.get(to);
        if (
          scenario.id === "commercial_answer_pipeline_waterflow" &&
          from === "visible_answer_adoption_gate" &&
          to === "control_room_summary" &&
          producer?.blocked &&
          consumer
        ) {
          try {
            if (
              !producer.blocked ||
              !consumer.blocked ||
              producer.blockFilter !== consumer.blockFilter ||
              producer.blockReason !== consumer.blockReason
            ) {
              throw new Error("reason_or_filter_conflict");
            }
            if (
              path.resolve(producer.receipt.path) !== path.resolve(consumer.receipt.path) ||
              producer.receipt.sha256 !== consumer.receipt.sha256
            ) {
              throw new Error("original_gate_receipt_conflict");
            }
            const nativeTrace: unknown = JSON.parse(
              await readHandoffField({
                ...consumer.receipt,
                pointer: "/gateOutput/trace",
                json: undefined,
              }),
            );
            if (!nativeTrace || typeof nativeTrace !== "object" || Array.isArray(nativeTrace)) {
              throw new Error("original_trace_missing");
            }
            const trace = nativeTrace as Record<string, unknown>;
            const summary = trace.controlRoomSummary as Record<string, unknown> | undefined;
            if (
              trace.decision !== "blocked" ||
              trace.nativeTerminalDecision !== "return_failed_reason" ||
              !Array.isArray(trace.failedReasons) ||
              trace.failedReasons[0] !== producer.blockReason ||
              !Array.isArray(trace.nativeFailedReasons) ||
              trace.nativeFailedReasons[0] !== consumer.blockReason ||
              !summary ||
              summary.boundary !== "original_terminal_diagnostic_summary_only" ||
              summary.authority !== "diagnostic_only_no_adoption_or_execution" ||
              summary.status !== "blocked" ||
              summary.terminalDecision !== "return_failed_reason" ||
              summary.semanticAdoption !== "not_proven" ||
              consumer.output !==
                (await readHandoffField({
                  ...consumer.receipt,
                  pointer: "/gateOutput/trace/controlRoomSummary",
                  json: undefined,
                }))
            ) {
              throw new Error("diagnostic_boundary_conflict");
            }
            blockedReceipts.add(to);
          } catch (error) {
            gap(
              to,
              `commercial_diagnostic_continuation_${error instanceof Error ? error.message : "invalid"}`,
            );
          }
          continue;
        }
        if (
          scenario.edges.some(([parent, child]) => parent === from && child === to) &&
          producer?.blocked &&
          consumer?.blocked &&
          producer.blockFilter === consumer.blockFilter &&
          producer.blockReason === consumer.blockReason
        ) {
          blockedReceipts.add(to);
        }
      }
      if (scenario.id === "self_repair_hands_waterflow" && blockedReceipts.size > 0) {
        for (const nodeId of ["governance_autopilot", "owner_coverage_map"] as const) {
          const observed = nodes.get(nodeId);
          if (nodeId === "owner_coverage_map" && !blockedReceipts.has("governance_autopilot")) {
            continue;
          }
          try {
            if (
              observed &&
              (await isOriginalPostBlockObserver(nodeId, observed.receipt, observed.scope)) &&
              (nodeId !== "owner_coverage_map" ||
                (await readHandoffField({ ...observed.receipt, pointer: "/runReceipt" })) ===
                  (await readHandoffField({
                    ...nodes.get("governance_autopilot")!.receipt,
                    pointer: "/runReceipt",
                  })))
            ) {
              blockedReceipts.add(nodeId);
            }
          } catch {
            // Missing native observer evidence leaves the original post-block execution check active.
          }
        }
      }
      const waived = new Set<FlowNodeId>();
      const traversed = new Set<FlowNodeId>();
      const waiveDescendants = (from: FlowNodeId) => {
        if (traversed.has(from)) {
          return;
        }
        traversed.add(from);
        for (const [parent, child] of scenario.edges) {
          if (parent === from && !waived.has(child)) {
            if (!blockedReceipts.has(child)) {
              waived.add(child);
            }
            waiveDescendants(child);
          }
        }
      };
      for (const node of blocked) {
        waiveDescendants(node);
      }
      for (const node of scenario.requiredNodes) {
        if (!nodes.has(node) && !waived.has(node)) {
          const stage = LCX_ONTOLOGY_REGISTRY.workflowProcesses[scenario.id].stages.find(
            (candidate) => (candidate.nodes as readonly string[]).includes(node),
          );
          gap(
            node,
            stage &&
              "implementationStatus" in stage &&
              String(stage.implementationStatus) === "required_not_implemented"
              ? "original_consumer_not_implemented"
              : "original_receipt_not_observed",
          );
        }
      }
      const verifiedControlAttempts = new Set<string>();
      for (const attempt of observation.controlAttempts ?? []) {
        const key = edgeKey([attempt.from, attempt.to]);
        try {
          if (
            scenario.id !== "commercial_acceptance_harness_waterflow" ||
            !workflowControlEdges(scenario).some((edge) => edgeKey(edge) === key) ||
            (observation.controlAttempts ?? []).filter(
              (entry: NonNullable<WorkflowHandoffEvidence["controlAttempts"]>[number]) =>
                edgeKey([entry.from, entry.to]) === key,
            ).length !== 1
          ) {
            throw new Error("invalid_or_duplicate_route");
          }
          await verifyAcceptanceControlAttempt(attempt, nodes.get(attempt.from));
          verifiedControlAttempts.add(key);
        } catch (error) {
          gap(attempt.to, `control_dispatch_invalid:${attempt.from}:${String(error)}`);
        }
      }
      for (const [from, to] of [...scenario.edges, ...(scenario.feedbackEdges ?? [])]) {
        if (verifiedControlContinuations.has(edgeKey([from, to]))) {
          // This exact native awaited continuation proves control flow, never text or model use.
          continue;
        }
        if (verifiedFeedbackReads.has(edgeKey([from, to]))) {
          // This one feedback was consumed by a later candidate, not the current node's old input.
          // Neither future scope nor provenance is merged into this observation's scope roots.
          continue;
        }
        if (waived.has(to) || waived.has(from)) {
          continue;
        }
        if (workflowControlEdges(scenario).some((edge) => edgeKey(edge) === edgeKey([from, to]))) {
          if (!verifiedControlAttempts.has(edgeKey([from, to]))) {
            gap(to, `control_dispatch_not_observed:${from}`);
          }
          // Even a verified attempt does not supply the absent child body or any data edge.
          continue;
        }
        const producer = nodes.get(from),
          consumer = nodes.get(to);
        if (!producer || !consumer) {
          gap(to, `handoff_not_observed:${from}`);
          continue;
        }
        const output = producer.outputs.get(to) ?? producer.output;
        const outputRef = producer.outputRefs.get(to) ?? producer.outputRef;
        if (outputRef !== undefined && consumer.inputRefs.get(from) === outputRef) {
          gap(to, `producer_field_cannot_serve_as_consumer_readback:${from}`);
        }
        const binding = consumer.scopeBindings.get(from);
        let bound = false;
        if (binding) {
          try {
            await verifyScopeBinding(
              binding,
              producer,
              consumer,
              consumer.inputFields.get(from)!,
              {
                from,
                to,
              },
              {
                scenarioId: scenario.id,
                environment: observation.environment,
              },
            );
            bound = true;
          } catch (error) {
            gap(to, `${error instanceof Error ? error.message : "scope_binding_invalid"}:${from}`);
          }
        }
        const verifiedBookProjection =
          bound &&
          binding?.kind === "finance_book_custody" &&
          outputRef ===
            JSON.stringify([
              path.resolve(binding.writer.path),
              binding.writer.pointer,
              binding.writer.sha256,
              (binding.writer.json ?? []).map((step) => [step.pointer, step.after ?? null]),
            ]);
        const verifiedFailedPlanRead =
          bound &&
          binding?.kind === "portfolio_plan_failed_read" &&
          outputRef ===
            JSON.stringify([
              path.resolve(binding.plan.path),
              binding.plan.pointer,
              binding.plan.sha256,
              (binding.plan.json ?? []).map((step) => [step.pointer, step.after ?? null]),
            ]);
        const verifiedQuestionPacket =
          bound &&
          binding?.kind === "commercial_question_requirements" &&
          outputRef ===
            JSON.stringify([
              path.resolve(binding.producerPacket.path),
              binding.producerPacket.pointer,
              binding.producerPacket.sha256,
              [],
            ]);
        if (
          output === undefined ||
          (consumer.inputs.get(from) !== output &&
            !verifiedQuestionPacket &&
            !verifiedBookProjection &&
            !verifiedFailedPlanRead)
        ) {
          gap(to, `consumer_did_not_receive_output:${from}`);
        }
        if (producer.scope !== consumer.scope) {
          if (bound) {
            scopeParents.set(scopeRoot(consumer.scope), scopeRoot(producer.scope));
          } else {
            gap(to, `handoff_scope_conflict:${from}`);
          }
        }
      }
      // Finance includes independently invoked, account-neutral forecast roots across cycles.
      // Its declared handoffs above still require exact input and scope/binding checks.
      if (
        scenario.id !== "finance_automatic_paper_trading_waterflow" &&
        new Set([...scopeParents.keys()].map(scopeRoot)).size > 1
      ) {
        gap(scenario.start, "run_or_account_scope_conflict");
      }
      for (const node of waived) {
        const observed = nodes.get(node);
        const result: unknown = observed?.output ? JSON.parse(observed.output) : undefined;
        const deferredResearchRefusal =
          scenario.id === "finance_automatic_paper_trading_waterflow" &&
          node === "finance_scheduler" &&
          blocked.includes(node) &&
          observed?.blockFilter === "research_receipt_required" &&
          observed.blockStatus === "failed" &&
          observed.blockReason === "research_plan_not_accepted" &&
          result !== null &&
          typeof result === "object" &&
          "outcome" in result &&
          result.outcome === "not_run" &&
          "blockReason" in result &&
          result.blockReason === observed.blockReason;
        if (observed && !deferredResearchRefusal) {
          gap(node, "downstream_observed_after_block_requires_owner_review");
        }
      }
      return {
        scenarioId: scenario.id,
        status: gaps.length ? "handoff_gap" : blocked.length ? "normal_block" : "handoffs_verified",
        proofLevel: "receipt_handoff_only",
        evidenceOrigin: observation.environment,
        semanticAdoption: "not_proven",
        owner: contract.entrypoint,
        blocked,
        gaps,
        ...(verifiedControlAttempts.size
          ? {
              controlAttemptsObserved: [...verifiedControlAttempts],
              controlAttemptBoundary:
                "debug_dispatch_attempt_only_child_execution_not_observed" as const,
            }
          : {}),
        ...(verifiedControlContinuations.size
          ? {
              controlContinuationsObserved: [...verifiedControlContinuations],
              controlBoundary:
                "original_await_continuation_only_not_text_or_model_adoption" as const,
            }
          : {}),
      };
    }),
  );
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

/** Source presence only: a host-installed owner is never executed by the audit. */
export async function readProcessOwnerSource(
  owner: string,
  userHome = LCX_USER_HOME,
): Promise<string> {
  if (!owner.startsWith("host-installed:")) {
    return readText(owner);
  }
  const basename = owner.slice("host-installed:".length);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sh$/u.test(basename)) {
    return "";
  }
  return fs.readFile(path.join(userHome, ".openclaw", "bin", basename), "utf8").catch(() => "");
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
  const scenarioSet = new Set(SCENARIO_IDS);
  const familySet = new Set(FAMILY_IDS);
  const unknownScenarios = FLOW_SCENARIOS.filter((scenario) => !scenarioSet.has(scenario.id)).map(
    (scenario) => scenario.id,
  );
  const unknownFamilies = FLOW_SCENARIOS.filter((scenario) => !familySet.has(scenario.family)).map(
    (scenario) => `${scenario.id}:${scenario.family}`,
  );
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
    ok:
      unknownScenarios.length === 0 &&
      unknownFamilies.length === 0 &&
      missingNodes.length === 0 &&
      invalidEdges.length === 0 &&
      disconnected.length === 0,
    summary:
      "each waterflow must have known nodes, valid edges, and a path from intake to terminal node",
    evidence: {
      unknownScenarios,
      unknownFamilies,
      missingNodes,
      invalidEdges,
      disconnected,
    },
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
          "work_then_evolve_cooldown_required",
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
          "multi_regime_validation_required",
          "deterministic_promotion_gate_required",
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
      FLOW_DIAGNOSTIC_OWNER_BY_SCENARIO_ID[scenario.id] ?? "scripts/operator/lcx-flow-graph.ts",
    fastCheck:
      FLOW_DIAGNOSTIC_FAST_CHECK_BY_SCENARIO_ID[scenario.id] ??
      "node --import tsx scripts/operator/lcx-flow-graph.ts --json",
    requiredFilters: scenario.requiredFilters,
    evidenceReceipts: scenario.receipts,
    failureSignals: [
      ...scenario.requiredFilters.map((filter) => `missing_or_skipped_filter:${filter}`),
      ...scenario.receipts.map((receipt) => `missing_or_stale_receipt:${receipt}`),
      (scenario.feedbackEdges?.length ?? 0) > 0 ? "unbounded_or_unreviewed_feedback" : "",
    ].filter(Boolean),
    boundary: "local_flow_graph_only",
  }));
}

async function financeAutomaticLifecycleAudit() {
  const hasCall = (source: string, callee: string) => {
    const ast = ts.createSourceFile("owner.ts", source, ts.ScriptTarget.Latest, true);
    let found = false;
    const matchesCallee = (expression: ts.Expression): boolean => {
      if (ts.isIdentifier(expression)) {
        return expression.text === callee;
      }
      if (ts.isParenthesizedExpression(expression)) {
        return matchesCallee(expression.expression);
      }
      return (
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        (matchesCallee(expression.left) || matchesCallee(expression.right))
      );
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && matchesCallee(node.expression)) {
        found = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return found;
  };
  const readSource = async (relativePath: string) =>
    fs.readFile(path.join(repoRoot, relativePath), "utf8").catch(() => "");
  const [
    scheduler,
    researchOperator,
    researchRunner,
    tuningLifecycle,
    tuningProposal,
    paperPromotion,
    paperRankPlace,
    positionLedger,
    positionLedgerRead,
    accountTradingBook,
    brokerReconciliation,
    centralAgent,
    dailyCycle,
    intradayExecution,
    executionAdapter,
    financeFeedback,
    ruleReadinessState,
    strategyRuleLedger,
    barLedger,
  ] = await Promise.all([
    readSource("scripts/operator/lcx-finance-scheduler.ts"),
    readSource("scripts/operator/lcx-finance-research-run.ts"),
    readSource("src/agents/finance-research-runner.ts"),
    readSource("src/agents/finance-tuning-lifecycle.ts"),
    readSource("src/agents/finance-tuning-proposal.ts"),
    readSource("src/agents/finance-paper-promotion.ts"),
    readSource("src/agents/tools/finance-paper-rank-place-tool.ts"),
    readSource("src/agents/finance-position-ledger.ts"),
    readSource("src/agents/tools/finance-position-ledger-read-tool.ts"),
    readSource("src/agents/finance-account-trading-book.ts"),
    readSource("src/agents/finance-alpaca-history-reconciliation.ts"),
    readSource("scripts/operator/lcx-central-agent.ts"),
    readSource("src/agents/finance-daily-cycle.ts"),
    readSource("src/agents/finance-intraday-execution.ts"),
    readSource("src/agents/finance-execution-adapter.ts"),
    readSource("src/agents/finance-automatic-lifecycle-feedback.ts"),
    readSource("src/agents/finance-rule-readiness-state.ts"),
    readSource("src/agents/finance-strategy-rule-ledger.ts"),
    readSource("src/agents/finance-bar-ledger.ts"),
  ]);
  const handoffs = {
    researchCanProducePortfolioCandidate:
      hasCall(researchRunner, "resolveFinanceResearchPortfolioOutcome") &&
      hasCall(researchOperator, "writeVerifiedPortfolioPlan"),
    schedulerCanConsumePortfolioPlan:
      hasCall(scheduler, "runScheduledCycleProcess") &&
      scheduler.includes("researchPayload.portfolioPlanWritten === portfolioPlanPath") &&
      scheduler.includes('"--portfolio-plan"'),
    scheduledResearchFeedsPortfolioPlan:
      hasCall(scheduler, "runDayResearchPreflight") &&
      scheduler.includes("lcx-finance-research-run.ts"),
    scheduledResearchExecutesModuleDag:
      scheduler.includes('"--execute-modules"') &&
      researchOperator.includes("executeModules: true") &&
      hasCall(researchRunner, "executeFinanceModuleComposition") &&
      hasCall(researchRunner, "producerInputsFromCommittee") &&
      researchRunner.includes("domainProducerInputs"),
    intradayRunsUnderFinanceScheduler: hasCall(scheduler, "runFinanceIntradayMonitorTick"),
    schedulerOwnsNightSettlement:
      hasCall(scheduler, "parseNightSettlement") && hasCall(scheduler, "runScheduledCycleProcess"),
    nightSettlementFeedsReviewedModuleResearch:
      hasCall(scheduler, "runNightResearchReview") &&
      hasCall(scheduler, "buildFinanceNightReviewEvidence") &&
      scheduler.includes('"--controller-evidence"') &&
      scheduler.includes('"--execute-modules"'),
    nightFeedbackDispatchesTuning:
      hasCall(scheduler, "runNightTuning") &&
      hasCall(scheduler, "runFinanceTuningLifecycle") &&
      scheduler.includes("scoredFiled.appended === 0"),
    directionalCalibrationIsolatedFromPaperExecution:
      !tuningLifecycle.includes("deterministicPromotion") &&
      tuningProposal.includes('scope: "forecast_calibration_only"') &&
      tuningLifecycle.includes("FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON") &&
      paperPromotion.includes('"directional_forecast_outcomes_are_not_net_trade_pnl"') &&
      paperPromotion.includes('"net_trade_economics_promotion_contract_unavailable"') &&
      paperPromotion.includes('evidenceScope: "legacy_directional_calibration_only"') &&
      paperRankPlace.includes("no net-trade-economics promotion exists"),
    tradingEconomicsUsesLedgerAndQuantMath:
      positionLedger.includes('pnlBasis: "gross_fill_price_only"') &&
      hasCall(positionLedgerRead, "calculateMaxDrawdown") &&
      positionLedgerRead.includes("gross_marked_ledger_diagnostic_only"),
    brokerHistoryFeesReachTradeEconomics:
      hasCall(positionLedgerRead, "readFinanceAccountTradingBook") &&
      positionLedgerRead.includes("realizedTradePnlAfterFees") &&
      hasCall(accountTradingBook, "reconcileFinanceBrokerHistory") &&
      brokerReconciliation.includes("const closingFee") &&
      brokerReconciliation.includes("const effectivePrice"),
    centralHarnessHasAutomaticFinanceTaskFeed:
      hasCall(centralAgent, "buildFinanceAutomaticLifecycleFeedback") &&
      centralAgent.includes("financeAutomaticLifecycle"),
    producerDecisionReferencesReachReceiptDiagnostics:
      dailyCycle.includes('source: "daily_cycle_candidate"') &&
      dailyCycle.includes(
        "[params.runAuthorizationId, signalAnchor, item.instrument, item.action].join",
      ) &&
      intradayExecution.includes('source: "intraday_signal"') &&
      intradayExecution.includes("id: input.signalId") &&
      executionAdapter.includes("decisionRef: intent.decisionRef") &&
      positionLedger.includes("decisionRef:") &&
      positionLedgerRead.includes("decisionLinkCoverage"),
    centralHarnessUsesReadOnlyFinanceSnapshots:
      hasCall(centralAgent, "buildFinanceAutomaticLifecycleFeedback") &&
      hasCall(financeFeedback, "readFinanceStrategyRuleLedger") &&
      hasCall(ruleReadinessState, "readFinanceBarLedger") &&
      strategyRuleLedger.includes(
        "new DatabaseSync(databasePath(directory), { readOnly: true })",
      ) &&
      strategyRuleLedger.includes("const db = openReadOnlyDatabase(directory)") &&
      barLedger.includes("new DatabaseSync(financeBarLedgerPath(directory), { readOnly: true })") &&
      barLedger.includes("const db = openReadOnlyDatabase(directory)"),
  };
  const missingHandoffs = [
    ...(handoffs.researchCanProducePortfolioCandidate
      ? []
      : ["configured_research_to_written_portfolio_candidate"]),
    ...(handoffs.schedulerCanConsumePortfolioPlan
      ? []
      : ["scheduler_to_verified_portfolio_plan_consumer"]),
    ...(handoffs.intradayRunsUnderFinanceScheduler ? [] : ["scheduler_to_intraday_monitor"]),
    ...(handoffs.schedulerOwnsNightSettlement ? [] : ["scheduler_to_night_settlement"]),
    ...(handoffs.scheduledResearchFeedsPortfolioPlan
      ? []
      : ["scheduled_research_to_portfolio_plan"]),
    ...(handoffs.scheduledResearchExecutesModuleDag
      ? []
      : ["scheduled_research_to_finance_module_dag"]),
    ...(handoffs.nightFeedbackDispatchesTuning
      ? []
      : ["night_scored_outcomes_to_tuning_proposal_dispatch"]),
    ...(handoffs.nightSettlementFeedsReviewedModuleResearch
      ? []
      : ["night_settlement_to_reviewed_module_research"]),
    ...(handoffs.directionalCalibrationIsolatedFromPaperExecution
      ? []
      : ["forecast_calibration_to_paper_execution_separation"]),
    ...(handoffs.tradingEconomicsUsesLedgerAndQuantMath
      ? []
      : ["execution_ledger_to_quant_trading_economics_diagnostic"]),
    ...(handoffs.brokerHistoryFeesReachTradeEconomics
      ? []
      : ["broker_fee_history_to_trade_economics_diagnostic"]),
    ...(handoffs.centralHarnessHasAutomaticFinanceTaskFeed
      ? []
      : ["central_harness_automatic_finance_task_feed"]),
    ...(handoffs.producerDecisionReferencesReachReceiptDiagnostics
      ? []
      : ["producer_decision_ids_to_execution_receipt_diagnostics"]),
    ...(handoffs.centralHarnessUsesReadOnlyFinanceSnapshots
      ? []
      : ["central_harness_to_read_only_finance_ledgers"]),
  ];
  return {
    complete: missingHandoffs.length === 0,
    proofLevel: "source_structure_only",
    owner: "scripts/operator/lcx-finance-scheduler.ts",
    principle:
      "one scheduler owns lifecycle triggers; forecast accuracy and realized trade economics remain separate evidence paths, and only reconciled net-trade evidence may change a paper execution threshold",
    handoffs,
    missingHandoffs,
  };
}

function consolidationClusterCheck(surfaceTexts: Record<SurfaceGroup, string>): FlowCheck {
  // `Set<string>` because `cluster.ownerScenario` is an unconstrained string from the cluster
  // table; the literal union of scenario ids would reject it at the membership test below.
  const scenarioIds = new Set<string>(FLOW_SCENARIOS.map((scenario) => scenario.id));
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
  const [
    head,
    workflow,
    proof,
    boundary,
    missingFiles,
    consolidatedEntrypoints,
    financeLifecycleAudit,
    processContracts,
  ] = await Promise.all([
    joinedSurfaceText(SURFACE_FILES.head),
    joinedSurfaceText(SURFACE_FILES.workflow),
    joinedSurfaceText(SURFACE_FILES.proof),
    joinedSurfaceText(SURFACE_FILES.boundary),
    missingSurfaceFiles(),
    consolidatedEntrypointCheck(),
    financeAutomaticLifecycleAudit(),
    processContractCheck(),
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
    processContracts,
  ];
  const failed = checks.filter((check) => !check.ok);
  const handoffEvidence = options.handoffEvidence
    ? (JSON.parse(await fs.readFile(options.handoffEvidence, "utf8")) as WorkflowHandoffEvidence[])
    : [];
  const handoffAudit = await auditWorkflowHandoffs(handoffEvidence);
  const result = {
    ok: failed.length === 0,
    boundary: "local_flow_graph_only",
    checkedAt: new Date().toISOString(),
    summary: {
      proofLevel: "structure_only",
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
      blockedReceiptContinuations: scenario.blockedReceiptContinuations ?? [],
      receipts: scenario.receipts,
    })),
    diagnosticIndex: buildFlowDiagnosticIndex(),
    financeRuleHandoff: { ...LCX_FINANCE_RULE_HANDOFF_CONTRACT, proofLevel: "structure_only" },
    workflowProcessSummary: {
      registry: "src/shared/lcx-ontology.ts:workflowProcesses",
      scenarios: FLOW_SCENARIOS.length,
      stages: Object.values(LCX_ONTOLOGY_REGISTRY.workflowProcesses).reduce(
        (total, contract) => total + contract.stages.length,
        0,
      ),
      relationEdges: FLOW_SCENARIOS.flatMap(workflowProcessEdges).length,
      proofLevel: "structure_only",
    },
    handoffAudit,
    handoffSummary: {
      verified: handoffAudit.filter((item) => item.status === "handoffs_verified").length,
      normalBlock: handoffAudit.filter((item) => item.status === "normal_block").length,
      gaps: handoffAudit.filter((item) => item.status === "handoff_gap").length,
      notObserved: handoffAudit.filter((item) => item.status === "not_observed").length,
    },
    financeAutomaticLifecycleAudit: financeLifecycleAudit,
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
