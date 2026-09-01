import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  LCX_ONTOLOGY_LEARNING_DECISIONS,
  LCX_ONTOLOGY_LEARNING_EVIDENCE_STATUSES,
  LCX_ONTOLOGY_LEARNING_TARGET_IDS,
  LCX_ONTOLOGY_SOURCE_EVIDENCE_CLASSES,
  LCX_ONTOLOGY_SOURCE_RELIABILITY_GRADES,
  LCX_ONTOLOGY_WEAK_EVIDENCE_POLICIES,
} from "../../shared/lcx-ontology.js";
import type {
  LcxOntologyLearningEvidenceStatus,
  LcxOntologyModuleFamilyId,
} from "../../shared/lcx-ontology.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam, ToolInputError } from "./common.js";

export const MODULE_LEARNING_TARGETS = LCX_ONTOLOGY_LEARNING_TARGET_IDS;

type ModuleLearningTarget = (typeof MODULE_LEARNING_TARGETS)[number];

type ModuleLearningSchema = {
  targetModule: ModuleLearningTarget;
  moduleFamily: LcxOntologyModuleFamilyId;
  requiredInputs: string[];
  evidenceFamilies: string[];
  moduleSpecificCapabilityRule: string;
  applicationValidationTask: string;
  safetyBoundaries: string[];
  existingToolBridge: {
    primaryTool: string;
    supportTools: string[];
    bridgeStatus: "direct_finance_pipeline" | "module_specific_receipt_required";
    closestExistingFinanceDomains: string[];
  };
};

export const MODULE_LEARNING_DECISIONS = LCX_ONTOLOGY_LEARNING_DECISIONS;
export const MODULE_LEARNING_SOURCE_EVIDENCE_CLASSES = LCX_ONTOLOGY_SOURCE_EVIDENCE_CLASSES;
export const MODULE_LEARNING_SOURCE_RELIABILITY_GRADES = LCX_ONTOLOGY_SOURCE_RELIABILITY_GRADES;
export const MODULE_LEARNING_WEAK_EVIDENCE_POLICIES = LCX_ONTOLOGY_WEAK_EVIDENCE_POLICIES;

type ModuleLearningEvidenceStatus = LcxOntologyLearningEvidenceStatus;

export const MODULE_LEARNING_EVIDENCE_STATUSES: ModuleLearningEvidenceStatus[] = [
  ...LCX_ONTOLOGY_LEARNING_EVIDENCE_STATUSES,
];

const ModuleLearningPipelinePlanSchema = Type.Object({
  targetModule: stringEnum(MODULE_LEARNING_TARGETS),
  receiptDateKey: Type.Optional(Type.String()),
  sourceUrlOrPath: Type.Optional(Type.String()),
  learningIntent: Type.Optional(Type.String()),
  actualReadingScope: Type.Optional(Type.String()),
  applicationValidationTask: Type.Optional(Type.String()),
  existingArtifactPaths: Type.Optional(Type.Array(Type.String())),
  sourceRegistryRecordPath: Type.Optional(Type.String()),
  retrievalReceiptPath: Type.Optional(Type.String()),
  applicationValidationReceiptPath: Type.Optional(Type.String()),
  trainingOrEvalAbsorptionEvidencePath: Type.Optional(Type.String()),
  freshAdjacentApplicationTask: Type.Optional(Type.String()),
  sourceEvidenceClass: Type.Optional(stringEnum(MODULE_LEARNING_SOURCE_EVIDENCE_CLASSES)),
  sourceReliabilityGrade: Type.Optional(stringEnum(MODULE_LEARNING_SOURCE_RELIABILITY_GRADES)),
  primarySourceOrTranscriptPath: Type.Optional(Type.String()),
  officialFollowupEvidencePath: Type.Optional(Type.String()),
  fundamentalFollowthroughEvidencePath: Type.Optional(Type.String()),
  marketFollowthroughWindow: Type.Optional(Type.String()),
  weakEvidenceLearningPolicy: Type.Optional(stringEnum(MODULE_LEARNING_WEAK_EVIDENCE_POLICIES)),
  keepDownrankDiscardDecision: Type.Optional(stringEnum(MODULE_LEARNING_DECISIONS)),
  supersedesReceiptPath: Type.Optional(Type.String()),
  writeReceipt: Type.Optional(Type.Boolean()),
});

const MODULE_SCHEMAS: Record<ModuleLearningTarget, ModuleLearningSchema> = {
  factor_research: {
    targetModule: "factor_research",
    moduleFamily: "finance_research",
    requiredInputs: [
      "factor_formula",
      "universe_definition",
      "rebalance_frequency",
      "lag_and_data_availability_rule",
      "transaction_cost_turnover_capacity_inputs",
      "sample_out_or_walk_forward_window",
    ],
    evidenceFamilies: [
      "factor_research_evidence",
      "equity_market_evidence",
      "portfolio_risk_evidence",
    ],
    moduleSpecificCapabilityRule:
      "A factor can only become a reusable research capability after formula, data lag, sample-out, cost, turnover, and capacity checks are explicit.",
    applicationValidationTask:
      "Apply the factor to a fresh ETF or index timing question and refuse application if formula, lag, cost, or sample-out evidence is missing.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "backtest_overfit_check_required",
      "sample_out_validation_required",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: [
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "local_brain_eval",
      ],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["causal_map", "portfolio_risk_gates"],
    },
  },
  options_volatility: {
    targetModule: "options_volatility",
    moduleFamily: "finance_research",
    requiredInputs: [
      "underlying_and_event_calendar",
      "iv_term_structure_skew_gamma_inputs",
      "liquidity_spread_and_open_interest_inputs",
      "position_exposure_and_gap_risk_inputs",
      "historical_event_move_context",
    ],
    evidenceFamilies: [
      "options_volatility_evidence",
      "event_catalyst_evidence",
      "portfolio_risk_evidence",
    ],
    moduleSpecificCapabilityRule:
      "Options learning must separate IV/skew/gamma observation from trade recommendation and require liquidity, event, and position-risk evidence before reuse.",
    applicationValidationTask:
      "Apply the options rule to a fresh earnings or FOMC gap-risk question and return research-only risk framing, not a contract recommendation.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_contract_recommendation",
      "risk_gate_before_action_language",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "quant_math", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["options_volatility", "event_driven", "portfolio_risk_gates"],
    },
  },
  global_index_regime: {
    targetModule: "global_index_regime",
    moduleFamily: "finance_research",
    requiredInputs: [
      "index_methodology_and_rebalance_rule",
      "constituent_weight_concentration_inputs",
      "breadth_sector_rotation_and_market_structure_inputs",
      "valuation_and_earnings_revision_context",
      "cross_market_liquidity_and_fx_context",
    ],
    evidenceFamilies: [
      "equity_market_evidence",
      "etf_regime_evidence",
      "liquidity_evidence",
      "portfolio_risk_evidence",
    ],
    moduleSpecificCapabilityRule:
      "Index learning must preserve methodology, concentration, breadth, sector, liquidity, and valuation context before turning into a reusable regime rule.",
    applicationValidationTask:
      "Apply the index rule to a fresh Nasdaq/S&P/A-share index regime question and name missing breadth, constituent, or methodology evidence before conclusion.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_unverified_current_market_data",
      "index_methodology_required",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "source_registry_lookup", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["etf_regime", "causal_map", "portfolio_risk_gates"],
    },
  },
  macro_rates_inflation: {
    targetModule: "macro_rates_inflation",
    moduleFamily: "finance_research",
    requiredInputs: [
      "rate_curve_inflation_growth_and_employment_inputs",
      "central_bank_reaction_function_context",
      "timestamped_macro_source_and_revision_policy",
      "asset_transmission_channel",
    ],
    evidenceFamilies: ["macro_rates_evidence", "inflation_evidence", "liquidity_evidence"],
    moduleSpecificCapabilityRule:
      "Macro learning must name source timestamps, revision risk, reaction-function assumptions, transmission channel, and falsification evidence.",
    applicationValidationTask:
      "Apply the macro rule to a fresh rates/liquidity portfolio question and separate current data gaps from reusable regime logic.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_unverified_current_market_data",
      "red_team_invalidation_required",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "source_registry_lookup", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["macro_rates_inflation", "credit_liquidity", "causal_map"],
    },
  },
  company_fundamentals_value: {
    targetModule: "company_fundamentals_value",
    moduleFamily: "finance_research",
    requiredInputs: [
      "latest_10q_10k_or_earnings_release",
      "revenue_quality_margin_fcf_roic_balance_sheet_inputs",
      "moat_management_and_capital_allocation_evidence",
      "valuation_range_and_margin_of_safety_inputs",
      "value_trap_and_thesis_invalidation_evidence",
    ],
    evidenceFamilies: ["fundamentals_evidence", "valuation_evidence", "portfolio_risk_evidence"],
    moduleSpecificCapabilityRule:
      "Fundamental learning must preserve original filing evidence, business quality, valuation range, margin of safety, and value-trap invalidation.",
    applicationValidationTask:
      "Apply the fundamental rule to a fresh company risk question and refuse filing-specific claims when source filings are missing.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_unverified_filing_claims",
      "margin_of_safety_required",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "source_registry_lookup", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["company_fundamentals_value", "portfolio_risk_gates"],
    },
  },
  financial_modeling_valuation_qc: {
    targetModule: "financial_modeling_valuation_qc",
    moduleFamily: "finance_research",
    requiredInputs: [
      "latest_10q_10k_or_earnings_release",
      "model_assumptions_sensitivity_and_audit_inputs",
      "data_field_definition_timestamp_and_vendor_quality_inputs",
      "valuation_range_and_margin_of_safety_inputs",
      "research_artifact_qc_and_number_provenance_checklist",
    ],
    evidenceFamilies: [
      "valuation_model_evidence",
      "data_provenance_evidence",
      "artifact_qc_evidence",
    ],
    moduleSpecificCapabilityRule:
      "Valuation-model learning must keep filing sources, model assumptions, sensitivity checks, field definitions, number provenance, and artifact QC together before reuse.",
    applicationValidationTask:
      "Apply the valuation QC rule to a fresh DCF/comps or three-statement modeling question and refuse unsupported target-price or trade language.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_model_math_guessing",
      "no_unverified_filing_claims",
      "cite_every_number_or_mark_unsourced",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "source_registry_lookup", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: [
        "company_fundamentals_value",
        "data_provenance_quality",
        "research_artifact_qc",
      ],
    },
  },
  thesis_catalyst_lifecycle: {
    targetModule: "thesis_catalyst_lifecycle",
    moduleFamily: "finance_research",
    requiredInputs: [
      "original_thesis_and_evidence_used",
      "thesis_catalyst_calendar_and_invalidation_evidence",
      "event_source_timestamp_and_expected_vs_surprise_channel",
      "portfolio_or_index_transmission_context",
      "post_event_correction_note",
    ],
    evidenceFamilies: ["thesis_evidence", "event_catalyst_evidence", "portfolio_risk_evidence"],
    moduleSpecificCapabilityRule:
      "Thesis/catalyst learning must preserve the original thesis, catalyst calendar, invalidation evidence, post-event correction, and keep/downrank decision.",
    applicationValidationTask:
      "Apply the thesis lifecycle rule to a fresh earnings, product, macro, or regulatory catalyst question and include a red-team invalidation path.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "red_team_invalidation_required",
      "do_not_rewrite_past_mistakes",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "source_registry_lookup", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["event_driven", "company_fundamentals_value", "causal_map"],
    },
  },
  data_provenance_quality: {
    targetModule: "data_provenance_quality",
    moduleFamily: "finance_research",
    requiredInputs: [
      "source_timestamp_and_vendor",
      "data_field_definition_timestamp_and_vendor_quality_inputs",
      "currency_adjustment_and_update_frequency_policy",
      "outlier_missing_field_and_conflict_resolution_rule",
      "validation_dataset_and_sample_out_plan",
    ],
    evidenceFamilies: [
      "source_registry_evidence",
      "data_quality_evidence",
      "conflict_resolution_evidence",
    ],
    moduleSpecificCapabilityRule:
      "Data-provenance learning must name vendor, timestamp, field definition, currency, adjustment, update cadence, conflicts, and trust priority before any sourced number is promoted.",
    applicationValidationTask:
      "Apply the provenance rule to a fresh conflicting ETF holdings, price, volume, IV, sentiment, or filing-field question and mark unresolved conflicts unverified.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_unverified_current_market_data",
      "source_timestamp_required",
      "cite_every_number_or_mark_unsourced",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["source_registry_lookup", "finance_learning_capability_apply", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["source_registry", "quant_math", "review_panel"],
    },
  },
  research_artifact_qc: {
    targetModule: "research_artifact_qc",
    moduleFamily: "finance_research",
    requiredInputs: [
      "research_artifact_qc_and_number_provenance_checklist",
      "source_timestamp_and_vendor",
      "citation_and_provenance_rule",
      "table_model_and_visible_summary_consistency_check",
      "human_review_required_before_external_use",
    ],
    evidenceFamilies: [
      "artifact_qc_evidence",
      "number_provenance_evidence",
      "visible_summary_evidence",
    ],
    moduleSpecificCapabilityRule:
      "Research-artifact QC learning must audit every number, table/model consistency, unverified labels, citations, and human-review checkpoint before visible use.",
    applicationValidationTask:
      "Apply the artifact QC rule to a fresh report, table, valuation model, or control-room summary and list any numbers that must remain unverified.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "cite_every_number_or_mark_unsourced",
      "human_review_required_before_external_use",
      "no_raw_json_visible_reply",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["source_registry_lookup", "review_panel", "local_brain_eval"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: [
        "data_provenance_quality",
        "financial_modeling_valuation_qc",
        "control_room_summary",
      ],
    },
  },
  technical_timing: {
    targetModule: "technical_timing",
    moduleFamily: "finance_research",
    requiredInputs: [
      "price_volume_breadth_and_regime_inputs",
      "signal_definition_and_invalidation_condition",
      "sample_out_or_walk_forward_evidence",
      "portfolio_risk_and_time_horizon_context",
    ],
    evidenceFamilies: ["equity_market_evidence", "etf_regime_evidence", "portfolio_risk_evidence"],
    moduleSpecificCapabilityRule:
      "Technical timing learning can only become context for timing discipline; it is not standalone alpha and needs invalidation plus sample-out evidence.",
    applicationValidationTask:
      "Apply the timing rule to a fresh ETF timing context question and keep it subordinate to risk gates and source freshness.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "technical_timing_not_standalone_alpha",
      "sample_out_validation_required",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "quant_math", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["etf_regime", "causal_map", "portfolio_risk_gates"],
    },
  },
  commodities_oil_gold: {
    targetModule: "commodities_oil_gold",
    moduleFamily: "finance_research",
    requiredInputs: [
      "curve_roll_yield_inventory_and_supply_demand_inputs",
      "real_rates_usd_and_inflation_context",
      "geopolitical_or_weather_event_context",
      "etf_futures_equity_transmission_map",
    ],
    evidenceFamilies: ["commodity_evidence", "fx_dollar_evidence", "inflation_evidence"],
    moduleSpecificCapabilityRule:
      "Commodity learning must include curve, inventory, USD/real-rate, supply-demand, event, and instrument-transmission evidence.",
    applicationValidationTask:
      "Apply the commodity rule to a fresh oil/gold ETF question and name curve, inventory, or USD evidence gaps before conclusion.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_unverified_current_market_data",
      "instrument_transmission_required",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "source_registry_lookup", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["commodities_oil_gold", "fx_dollar", "causal_map"],
    },
  },
  fx_currency_liquidity: {
    targetModule: "fx_currency_liquidity",
    moduleFamily: "finance_research",
    requiredInputs: [
      "dollar_liquidity_and_fx_rate_inputs",
      "rate_differential_and_policy_context",
      "capital_flow_and_cross_asset_transmission_inputs",
      "timestamped_vendor_or_source_scope",
    ],
    evidenceFamilies: ["fx_dollar_evidence", "liquidity_evidence", "macro_rates_evidence"],
    moduleSpecificCapabilityRule:
      "FX/liquidity learning must preserve source timestamps, rate differential, policy, capital-flow, and cross-asset transmission assumptions.",
    applicationValidationTask:
      "Apply the FX/liquidity rule to a fresh USD/CNH or dollar-liquidity cross-asset question and mark stale data gaps.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_unverified_current_market_data",
      "source_timestamp_required",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "source_registry_lookup", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["fx_dollar", "credit_liquidity", "causal_map"],
    },
  },
  event_driven: {
    targetModule: "event_driven",
    moduleFamily: "finance_research",
    requiredInputs: [
      "event_calendar_and_source_timestamp",
      "expected_vs_surprise_channel",
      "affected_assets_and_second_order_links",
      "pre_event_and_post_event_invalidation_conditions",
    ],
    evidenceFamilies: [
      "event_catalyst_evidence",
      "equity_market_evidence",
      "portfolio_risk_evidence",
    ],
    moduleSpecificCapabilityRule:
      "Event learning must distinguish calendar facts, surprise channel, affected assets, second-order links, and invalidation conditions.",
    applicationValidationTask:
      "Apply the event rule to a fresh CPI/FOMC/earnings question and keep the output as preflight research, not a same-day prediction.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_same_day_price_prediction",
      "risk_gate_before_action_language",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "source_registry_lookup", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["event_driven", "causal_map", "portfolio_risk_gates"],
    },
  },
  portfolio_risk_gates: {
    targetModule: "portfolio_risk_gates",
    moduleFamily: "finance_research",
    requiredInputs: [
      "position_weights_cost_basis_and_risk_limits",
      "return_series_correlation_volatility_and_drawdown_inputs",
      "liquidity_and_concentration_constraints",
      "risk_budget_and_invalidation_rule",
    ],
    evidenceFamilies: ["portfolio_risk_evidence", "liquidity_evidence", "equity_market_evidence"],
    moduleSpecificCapabilityRule:
      "Portfolio risk learning must require actual weights, risk limits, return series, liquidity, concentration, and drawdown evidence before sizing language.",
    applicationValidationTask:
      "Apply the risk rule to a fresh portfolio sizing question and refuse percentages when weights, limits, or return series are missing.",
    safetyBoundaries: [
      "research_only",
      "no_execution_authority",
      "no_model_math_guessing",
      "risk_gate_before_action_language",
      "no_trade_advice",
    ],
    existingToolBridge: {
      primaryTool: "finance_learning_pipeline_orchestrator",
      supportTools: ["finance_learning_capability_apply", "quant_math", "review_panel"],
      bridgeStatus: "direct_finance_pipeline",
      closestExistingFinanceDomains: ["portfolio_risk_gates", "causal_map"],
    },
  },
  external_message_workflow: {
    targetModule: "external_message_workflow",
    moduleFamily: "agent_workflow",
    requiredInputs: [
      "visible_reply_sample_or_message_id",
      "routing_family_and_backend_tool_contract",
      "reply_flow_receipt_or_external_diagnose_output",
      "human_readable_summary_contract",
      "local_vs_legacy_live_evidence_boundary",
    ],
    evidenceFamilies: ["visible_reply_evidence", "routing_receipt", "live_boundary_evidence"],
    moduleSpecificCapabilityRule:
      "external message workflow learning must improve readable replies and routing while preserving dev-vs-live proof boundaries.",
    applicationValidationTask:
      "Apply the workflow rule to a fresh External-style message and prove no raw JSON/internal labels leak into the visible reply.",
    safetyBoundaries: [
      "no_live_visible_fixed_claim_without_real_inbound_reply",
      "no_external_channel_sender_change",
      "no_provider_config_change",
      "no_raw_json_visible_reply",
    ],
    existingToolBridge: {
      primaryTool: "external_channel_status",
      supportTools: ["reply_flow_audit", "review_panel", "local_brain_eval"],
      bridgeStatus: "module_specific_receipt_required",
      closestExistingFinanceDomains: [],
    },
  },
  agent_workflow_memory: {
    targetModule: "agent_workflow_memory",
    moduleFamily: "agent_workflow",
    requiredInputs: [
      "workflow_receipt_or_runbook_path",
      "prior_art_checked",
      "handoff_contract",
      "fresh_adjacent_workflow_task",
      "stale_or_conflicting_memory_downrank_rule",
    ],
    evidenceFamilies: ["workflow_receipt", "memory_recall_evidence", "handoff_evidence"],
    moduleSpecificCapabilityRule:
      "Agent workflow memory learning must preserve prior-art search, handoff contract, fresh adjacent use, and stale-memory downrank evidence.",
    applicationValidationTask:
      "Apply the workflow rule to a fresh operator handoff or automation task and show the exact receipt or failedReason.",
    safetyBoundaries: [
      "no_protected_memory_write",
      "do_not_promote_unverified_memory_claims",
      "prefer_reuse_over_duplicate_pipeline",
    ],
    existingToolBridge: {
      primaryTool: "artifact_memory_recall",
      supportTools: ["sessions_history", "review_panel", "local_brain_eval"],
      bridgeStatus: "module_specific_receipt_required",
      closestExistingFinanceDomains: [],
    },
  },
  ops_audit: {
    targetModule: "ops_audit",
    moduleFamily: "ops_runtime",
    requiredInputs: [
      "doctor_or_smoke_command",
      "log_path_and_timestamp_scope",
      "active_pid_or_absence_evidence",
      "failure_family_and_repro_command",
      "acceptance_check_or_failed_reason",
    ],
    evidenceFamilies: ["doctor_evidence", "process_evidence", "log_receipt"],
    moduleSpecificCapabilityRule:
      "Ops learning must anchor on commands, logs, PIDs, failure family, and acceptance checks, not narrative reassurance.",
    applicationValidationTask:
      "Apply the ops rule to a fresh health check and report exact command evidence plus failedReason if not healthy.",
    safetyBoundaries: [
      "core_verified_not_legacy_live_fixed",
      "no_overlapping_training_start",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    existingToolBridge: {
      primaryTool: "lcx_system_doctor",
      supportTools: ["local_brain_training_plan", "review_panel", "local_brain_eval"],
      bridgeStatus: "module_specific_receipt_required",
      closestExistingFinanceDomains: [],
    },
  },
  skill_pattern_distillation: {
    targetModule: "skill_pattern_distillation",
    moduleFamily: "skill_runtime",
    requiredInputs: [
      "candidate_skill_source_or_local_skill_path",
      "license_and_write_scope_review",
      "prompt_injection_and_security_review",
      "isolated_install_or_reuse_decision",
      "fresh_adjacent_skill_application_task",
    ],
    evidenceFamilies: ["skill_source_evidence", "security_review_evidence", "application_receipt"],
    moduleSpecificCapabilityRule:
      "Skill learning must evaluate source, license, isolation, security, and fresh adjacent utility before affecting agent workflows.",
    applicationValidationTask:
      "Apply the skill rule to a fresh candidate skill and return reuse/extend/new with evidence, not installation by default.",
    safetyBoundaries: [
      "untrusted_external_source",
      "evaluate_before_installing",
      "no_direct_external_agent_install",
      "no_protected_memory_write",
    ],
    existingToolBridge: {
      primaryTool: "skill_harvester",
      supportTools: ["source_registry_lookup", "review_panel", "local_brain_eval"],
      bridgeStatus: "module_specific_receipt_required",
      closestExistingFinanceDomains: [],
    },
  },
};

function optionalList(value: string[] | undefined): string[] {
  return value ?? [];
}

function normalizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function chooseFinancePipelineSourceType(params: {
  targetModule: ModuleLearningTarget;
  sourceUrlOrPath: string | null;
}): "manual_article_source" | "official_data_source" | "market_data_snapshot_source" {
  if (params.targetModule !== "data_provenance_quality") {
    return "manual_article_source";
  }
  const source = params.sourceUrlOrPath ?? "";
  if (
    /(fred|bls\.gov|bea\.gov|treasury\.gov|fiscaldata\.treasury|cpi|pce|payroll)/iu.test(source)
  ) {
    return "official_data_source";
  }
  return "market_data_snapshot_source";
}

function resolveEvidenceStatus(params: {
  sourceUrlOrPath: string | null;
  actualReadingScope: string | null;
  sourceRegistryRecordPath: string | null;
  retrievalReceiptPath: string | null;
  applicationValidationReceiptPath: string | null;
  trainingOrEvalAbsorptionEvidencePath: string | null;
  freshAdjacentApplicationTask: string | null;
  keepDownrankDiscardDecision: string | null;
  weakEvidenceGateSatisfied: boolean;
}): ModuleLearningEvidenceStatus {
  if (!params.weakEvidenceGateSatisfied) {
    return "missing_evidence";
  }
  const sourceReady =
    Boolean(params.sourceUrlOrPath) &&
    Boolean(params.actualReadingScope) &&
    Boolean(params.sourceRegistryRecordPath);
  if (!sourceReady) {
    return "missing_evidence";
  }
  if (!params.retrievalReceiptPath) {
    return "stored_only";
  }
  if (!params.applicationValidationReceiptPath) {
    return "retrieval_ready";
  }
  if (
    !params.trainingOrEvalAbsorptionEvidencePath ||
    !params.freshAdjacentApplicationTask ||
    !params.keepDownrankDiscardDecision ||
    params.keepDownrankDiscardDecision === "not_decided"
  ) {
    return "application_ready";
  }
  return "eval_absorbed";
}

function buildModuleLearningReceiptPath(params: {
  targetModule: string;
  learningIntent: string;
  toolCallId: string;
  sourceUrlOrPath?: string | null;
  supersedesReceiptPath?: string | null;
  existingArtifactPaths?: string[];
  dateKey?: string;
}): string {
  const dateKey = params.dateKey ?? new Date().toISOString().slice(0, 10);
  const hash = createHash("sha256")
    .update(
      [
        params.toolCallId,
        params.targetModule,
        params.learningIntent,
        params.sourceUrlOrPath ?? "",
        params.supersedesReceiptPath ?? "",
        ...(params.existingArtifactPaths ?? []),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 12);
  const fileName = `${new Date().toISOString().replace(/[:.]/gu, "-")}__${hash}.json`;
  return path
    .join("memory", "module-learning-pipeline-plan-receipts", dateKey, fileName)
    .split(path.sep)
    .join("/");
}

async function writeModuleLearningPlanReceipt(params: {
  workspaceDir: string;
  receiptPath: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const absolutePath = path.join(params.workspaceDir, params.receiptPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(params.payload, null, 2)}\n`, "utf8");
}

export function createModuleLearningPipelinePlanTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Module Learning Pipeline Plan",
    name: "module_learning_pipeline_plan",
    description:
      "Plan one evidence-gated module learning run using the shared source, capability, retrieval, application, eval, and keep/downrank/discard chain. This is read-only and does not fetch remote content or mutate live/provider/protected-memory state.",
    parameters: ModuleLearningPipelinePlanSchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const targetModule = readStringParam(params, "targetModule", { required: true });
      if (!MODULE_LEARNING_TARGETS.includes(targetModule as ModuleLearningTarget)) {
        throw new ToolInputError(`unsupported targetModule: ${targetModule}`);
      }
      const receiptDateKey = normalizeOptional(
        readStringParam(params, "receiptDateKey", { allowEmpty: true }),
      );
      if (receiptDateKey && !/^\d{4}-\d{2}-\d{2}$/u.test(receiptDateKey)) {
        throw new ToolInputError("receiptDateKey must be YYYY-MM-DD");
      }
      const schema = MODULE_SCHEMAS[targetModule as ModuleLearningTarget];
      const sourceUrlOrPath = normalizeOptional(readStringParam(params, "sourceUrlOrPath"));
      const learningIntent =
        normalizeOptional(readStringParam(params, "learningIntent", { allowEmpty: true })) ??
        `Internalize a reusable ${schema.targetModule} capability with source, retrieval, application, eval, and keep/downrank/discard proof.`;
      const actualReadingScope = normalizeOptional(
        readStringParam(params, "actualReadingScope", { allowEmpty: true }),
      );
      const applicationValidationTask =
        normalizeOptional(
          readStringParam(params, "applicationValidationTask", { allowEmpty: true }),
        ) ?? schema.applicationValidationTask;
      const existingArtifactPaths = optionalList(
        readStringArrayParam(params, "existingArtifactPaths"),
      );
      const sourceRegistryRecordPath = normalizeOptional(
        readStringParam(params, "sourceRegistryRecordPath", { allowEmpty: true }),
      );
      const retrievalReceiptPath = normalizeOptional(
        readStringParam(params, "retrievalReceiptPath", { allowEmpty: true }),
      );
      const applicationValidationReceiptPath = normalizeOptional(
        readStringParam(params, "applicationValidationReceiptPath", { allowEmpty: true }),
      );
      const trainingOrEvalAbsorptionEvidencePath = normalizeOptional(
        readStringParam(params, "trainingOrEvalAbsorptionEvidencePath", { allowEmpty: true }),
      );
      const freshAdjacentApplicationTask = normalizeOptional(
        readStringParam(params, "freshAdjacentApplicationTask", { allowEmpty: true }),
      );
      const sourceEvidenceClass = normalizeOptional(
        readStringParam(params, "sourceEvidenceClass", { allowEmpty: true }),
      );
      if (
        sourceEvidenceClass &&
        !MODULE_LEARNING_SOURCE_EVIDENCE_CLASSES.includes(
          sourceEvidenceClass as (typeof MODULE_LEARNING_SOURCE_EVIDENCE_CLASSES)[number],
        )
      ) {
        throw new ToolInputError(`unsupported sourceEvidenceClass: ${sourceEvidenceClass}`);
      }
      const sourceReliabilityGrade = normalizeOptional(
        readStringParam(params, "sourceReliabilityGrade", { allowEmpty: true }),
      );
      if (
        sourceReliabilityGrade &&
        !MODULE_LEARNING_SOURCE_RELIABILITY_GRADES.includes(
          sourceReliabilityGrade as (typeof MODULE_LEARNING_SOURCE_RELIABILITY_GRADES)[number],
        )
      ) {
        throw new ToolInputError(`unsupported sourceReliabilityGrade: ${sourceReliabilityGrade}`);
      }
      const primarySourceOrTranscriptPath = normalizeOptional(
        readStringParam(params, "primarySourceOrTranscriptPath", { allowEmpty: true }),
      );
      const officialFollowupEvidencePath = normalizeOptional(
        readStringParam(params, "officialFollowupEvidencePath", { allowEmpty: true }),
      );
      const fundamentalFollowthroughEvidencePath = normalizeOptional(
        readStringParam(params, "fundamentalFollowthroughEvidencePath", { allowEmpty: true }),
      );
      const marketFollowthroughWindow = normalizeOptional(
        readStringParam(params, "marketFollowthroughWindow", { allowEmpty: true }),
      );
      const weakEvidenceLearningPolicy = normalizeOptional(
        readStringParam(params, "weakEvidenceLearningPolicy", { allowEmpty: true }),
      );
      if (
        weakEvidenceLearningPolicy &&
        !MODULE_LEARNING_WEAK_EVIDENCE_POLICIES.includes(
          weakEvidenceLearningPolicy as (typeof MODULE_LEARNING_WEAK_EVIDENCE_POLICIES)[number],
        )
      ) {
        throw new ToolInputError(
          `unsupported weakEvidenceLearningPolicy: ${weakEvidenceLearningPolicy}`,
        );
      }
      const keepDownrankDiscardDecision = normalizeOptional(
        readStringParam(params, "keepDownrankDiscardDecision", { allowEmpty: true }),
      );
      const supersedesReceiptPath = normalizeOptional(
        readStringParam(params, "supersedesReceiptPath", { allowEmpty: true }),
      );
      if (
        keepDownrankDiscardDecision &&
        !MODULE_LEARNING_DECISIONS.includes(
          keepDownrankDiscardDecision as (typeof MODULE_LEARNING_DECISIONS)[number],
        )
      ) {
        throw new ToolInputError(
          `unsupported keepDownrankDiscardDecision: ${keepDownrankDiscardDecision}`,
        );
      }
      const weakEvidenceGateRequired = sourceEvidenceClass === "weak_alternative_source";
      const weakEvidenceGateMissing = weakEvidenceGateRequired
        ? [
            primarySourceOrTranscriptPath ? null : "primary_source_or_transcript",
            sourceReliabilityGrade ? null : "source_reliability_grade",
            officialFollowupEvidencePath ? null : "official_followup_or_contract_evidence",
            fundamentalFollowthroughEvidencePath ? null : "fundamental_followthrough_evidence",
            marketFollowthroughWindow ? null : "market_followthrough_window",
            weakEvidenceLearningPolicy ? null : "weak_evidence_learning_policy",
          ].filter((item): item is string => Boolean(item))
        : [];
      const weakEvidenceGateSatisfied =
        !weakEvidenceGateRequired || weakEvidenceGateMissing.length === 0;
      const evidenceStatus = resolveEvidenceStatus({
        sourceUrlOrPath,
        actualReadingScope,
        sourceRegistryRecordPath,
        retrievalReceiptPath,
        applicationValidationReceiptPath,
        trainingOrEvalAbsorptionEvidencePath,
        freshAdjacentApplicationTask,
        keepDownrankDiscardDecision,
        weakEvidenceGateSatisfied,
      });
      const missingEvidence = [
        sourceUrlOrPath ? null : "source_url_or_local_source_path",
        actualReadingScope ? null : "actual_reading_scope",
        existingArtifactPaths.length > 0 ? null : "prior_art_or_existing_artifact_paths",
        sourceRegistryRecordPath ? null : "source_registry_record",
        retrievalReceiptPath ? null : "capability_card_or_retrieval_receipt",
        applicationValidationReceiptPath ? null : "application_validation_receipt",
        trainingOrEvalAbsorptionEvidencePath ? null : "training_or_eval_absorption_evidence",
        freshAdjacentApplicationTask ? null : "fresh_adjacent_application_task",
        keepDownrankDiscardDecision && keepDownrankDiscardDecision !== "not_decided"
          ? null
          : "keep_downrank_or_discard_decision",
        ...weakEvidenceGateMissing,
      ].filter((item): item is string => Boolean(item));

      const financePipelineArgs =
        schema.existingToolBridge.bridgeStatus === "direct_finance_pipeline"
          ? {
              sourceName: sourceUrlOrPath ?? `${schema.targetModule} local/manual source`,
              sourceType: chooseFinancePipelineSourceType({
                targetModule: schema.targetModule,
                sourceUrlOrPath,
              }),
              retrievalNotes:
                "Operator-provided local/manual source. Do not fetch remote content in the orchestrator step; preserve provenance and actual reading scope.",
              allowedActionAuthority: "research_only",
              learningIntent,
              applicationValidationQuery: applicationValidationTask,
              expectedNextReviewTarget:
                schema.targetModule === "data_provenance_quality"
                  ? "data_provenance_quality_review_input"
                  : "finance_article_extract_capability_input",
              sourceEvidenceClass: sourceEvidenceClass ?? "medium",
              sourceReliabilityGrade,
              weakEvidenceLearningPolicy,
            }
          : null;

      const receiptPath =
        params.writeReceipt === true
          ? buildModuleLearningReceiptPath({
              targetModule: schema.targetModule,
              learningIntent,
              toolCallId,
              sourceUrlOrPath,
              supersedesReceiptPath,
              existingArtifactPaths,
              dateKey: receiptDateKey ?? undefined,
            })
          : null;
      const payload = {
        ok: true,
        boundary: "local_module_learning_pipeline_plan",
        targetModule: schema.targetModule,
        moduleFamily: schema.moduleFamily,
        status: evidenceStatus,
        sourceUrlOrPath,
        learningIntent,
        actualReadingScope,
        sourceRegistryRecordPath,
        retrievalReceiptPath,
        applicationValidationReceiptPath,
        trainingOrEvalAbsorptionEvidencePath,
        freshAdjacentApplicationTask,
        sourceEvidenceClass: sourceEvidenceClass ?? "medium",
        sourceReliabilityGrade,
        primarySourceOrTranscriptPath,
        officialFollowupEvidencePath,
        fundamentalFollowthroughEvidencePath,
        marketFollowthroughWindow,
        weakEvidenceLearningPolicy,
        weakEvidenceGate: {
          required: weakEvidenceGateRequired,
          satisfied: weakEvidenceGateSatisfied,
          missingEvidence: weakEvidenceGateMissing,
          boundary:
            "weak alternative sources can shape hypotheses and reusable research checks only; they cannot become causality, alpha, or trade evidence without follow-through review",
        },
        keepDownrankDiscardDecision: keepDownrankDiscardDecision ?? "not_decided",
        supersedesReceiptPath,
        existingArtifactPaths,
        moduleSpecificCapabilityRule: schema.moduleSpecificCapabilityRule,
        requiredInputs: schema.requiredInputs,
        evidenceFamilies: schema.evidenceFamilies,
        applicationValidationTask,
        safetyBoundaries: schema.safetyBoundaries,
        missingEvidence,
        internalizationChain: [
          "prior_art_search",
          "source_registry_record",
          "actual_reading_scope",
          "weak_source_type_reliability_and_followthrough_gate",
          "module_specific_capability_rule",
          "capability_card_or_retrieval_receipt",
          "application_validation_receipt",
          "training_or_eval_absorption_evidence",
          "fresh_adjacent_application_task",
          "keep_downrank_or_discard_decision",
        ],
        existingToolBridge: schema.existingToolBridge,
        financePipelineArgs,
        claimBoundary:
          "A module is not learned from storage alone. Claim stored_only, retrieval_ready, application_ready, or eval_absorbed only when the matching evidence exists.",
        receiptPath,
        receiptWritten: receiptPath !== null,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      };
      if (receiptPath) {
        await writeModuleLearningPlanReceipt({
          workspaceDir,
          receiptPath,
          payload,
        });
      }
      return jsonResult(payload);
    },
  };
}
