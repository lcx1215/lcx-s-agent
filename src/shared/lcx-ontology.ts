/**
 * Canonical semantic vocabulary for LCX Agent.
 *
 * This is a vocabulary and validation layer, not a second workflow owner.
 * Existing owners keep their receipts and decisions; they consume these
 * identifiers so the same object cannot acquire a different meaning by
 * crossing a module, workflow, evidence, or delivery boundary.
 */

export const LCX_ONTOLOGY_VERSION = "lcx_ontology_v1" as const;
export const LCX_ONTOLOGY_EVOLUTION_CONTRACT_VERSION = "lcx_ontology_evolution_v1" as const;
export const LCX_ONTOLOGY_MIGRATION_MANIFEST_SCHEMA_VERSION = "lcx_ontology_migration_v1" as const;

/**
 * The registry is extended in place. A physical move requires an explicit
 * versioned migration so consumers cannot silently grow a second ontology.
 */
export const LCX_ONTOLOGY_REGISTRY_POLICY = {
  canonicalSource: "src/shared/lcx-ontology.ts",
  auditEntrypoint: "scripts/operator/lcx-ontology.ts",
  changeMode: "extend_in_place",
  migrationMode: "versioned_explicit_migration",
  parallelRegistry: "forbidden",
  evolutionContractVersion: LCX_ONTOLOGY_EVOLUTION_CONTRACT_VERSION,
  migrationManifestSchemaVersion: LCX_ONTOLOGY_MIGRATION_MANIFEST_SCHEMA_VERSION,
} as const;

export const LCX_ONTOLOGY_ENTITY_TYPES = [
  "actor",
  "adapter",
  "action",
  "artifact",
  "capability",
  "claim",
  "delivery",
  "domain_entity",
  "evidence",
  "eval",
  "intent",
  "learning_state",
  "memory",
  "module",
  "policy",
  "provider",
  "receipt",
  "source",
  "summary",
  "task",
  "workflow",
] as const;
export type LcxOntologyEntityType = (typeof LCX_ONTOLOGY_ENTITY_TYPES)[number];

export const LCX_ONTOLOGY_RELATION_TYPES = [
  "asks_for",
  "targets",
  "requires",
  "supports",
  "derived_from",
  "validated_by",
  "produces",
  "blocks",
  "promotes",
  "delivered_via",
  "observed_as",
  "scoped_to",
  "owned_by",
  "supersedes",
  "aliases",
] as const;
export type LcxOntologyRelationType = (typeof LCX_ONTOLOGY_RELATION_TYPES)[number];

export type LcxOntologyRelationContract = {
  relation: LcxOntologyRelationType;
  subjectTypes: readonly LcxOntologyEntityType[];
  objectTypes: readonly LcxOntologyEntityType[];
};

/**
 * Relation types are not merely labels: these contracts constrain the kinds
 * of entities that may participate in each relation across all owners.
 */
export const LCX_ONTOLOGY_RELATION_CONTRACTS = [
  { relation: "asks_for", subjectTypes: ["actor", "intent"], objectTypes: ["task"] },
  {
    relation: "targets",
    subjectTypes: ["task", "intent", "capability", "workflow"],
    objectTypes: ["module", "domain_entity", "capability"],
  },
  {
    relation: "requires",
    subjectTypes: ["task", "action", "workflow", "capability"],
    objectTypes: ["policy", "evidence", "source", "module", "artifact"],
  },
  {
    relation: "supports",
    subjectTypes: ["source", "evidence", "module", "capability", "artifact"],
    objectTypes: ["claim", "capability", "task", "workflow"],
  },
  {
    relation: "derived_from",
    subjectTypes: ["claim", "summary", "artifact", "evidence"],
    objectTypes: ["source", "evidence", "artifact", "receipt"],
  },
  {
    relation: "validated_by",
    subjectTypes: ["claim", "capability", "artifact", "delivery"],
    objectTypes: ["eval", "evidence", "receipt"],
  },
  {
    relation: "produces",
    subjectTypes: ["task", "action", "workflow", "module"],
    objectTypes: ["artifact", "evidence", "receipt", "summary", "delivery"],
  },
  {
    relation: "blocks",
    subjectTypes: ["policy", "evidence", "domain_entity", "action", "capability"],
    objectTypes: ["action", "task", "delivery", "capability", "workflow"],
  },
  {
    relation: "promotes",
    subjectTypes: ["eval", "evidence", "receipt"],
    objectTypes: ["capability", "adapter", "delivery"],
  },
  {
    relation: "delivered_via",
    subjectTypes: ["delivery", "summary", "artifact"],
    objectTypes: ["adapter"],
  },
  {
    relation: "observed_as",
    subjectTypes: ["capability", "delivery", "workflow", "claim"],
    objectTypes: ["evidence", "receipt", "summary"],
  },
  {
    relation: "scoped_to",
    subjectTypes: ["task", "claim", "evidence", "source", "capability", "workflow"],
    objectTypes: ["domain_entity", "module", "adapter", "policy"],
  },
  {
    relation: "owned_by",
    subjectTypes: ["task", "workflow", "capability", "artifact", "delivery", "policy", "module"],
    objectTypes: ["actor", "adapter", "module"],
  },
  {
    relation: "supersedes",
    subjectTypes: ["source", "evidence", "receipt", "summary", "artifact", "adapter", "eval"],
    objectTypes: ["source", "evidence", "receipt", "summary", "artifact", "adapter", "eval"],
  },
  {
    relation: "aliases",
    subjectTypes: ["task", "module", "source", "artifact", "workflow", "capability", "adapter"],
    objectTypes: ["task", "module", "source", "artifact", "workflow", "capability", "adapter"],
  },
] as const satisfies readonly LcxOntologyRelationContract[];

export const LCX_ONTOLOGY_DOMAIN_ENTITY_TYPES = [
  "company",
  "security",
  "index",
  "etf",
  "option",
  "portfolio",
  "market",
  "market_data_field",
  "event",
  "thesis",
  "catalyst",
  "risk",
] as const;
export type LcxOntologyDomainEntityType = (typeof LCX_ONTOLOGY_DOMAIN_ENTITY_TYPES)[number];

export const LCX_ONTOLOGY_SURFACE_IDS = ["head", "workflow", "proof", "boundary"] as const;
export type LcxOntologySurfaceId = (typeof LCX_ONTOLOGY_SURFACE_IDS)[number];

export const LCX_ONTOLOGY_EVIDENCE_KINDS = [
  "head",
  "workflow",
  "proof",
  "boundary",
  "invariant",
] as const;
export type LcxOntologyEvidenceKind = (typeof LCX_ONTOLOGY_EVIDENCE_KINDS)[number];

export const LCX_ONTOLOGY_MODULE_IDS = [
  "macro_rates_inflation",
  "credit_liquidity",
  "cross_asset_liquidity",
  "fx_currency_liquidity",
  "etf_regime",
  "global_index_regime",
  "us_equity_market_structure",
  "china_a_share_policy_flow",
  "crypto_market_structure",
  "technical_timing",
  "options_volatility",
  "commodities_oil_gold",
  "fx_dollar",
  "event_driven",
  "company_fundamentals_value",
  "financial_modeling_valuation_qc",
  "thesis_catalyst_lifecycle",
  "finance_data_gateway",
  "data_provenance_quality",
  "research_artifact_qc",
  "quant_math",
  "portfolio_risk_gates",
  "causal_map",
  "finance_learning_memory",
  "source_registry",
  "skill_pattern_distillation",
  "agent_workflow_memory",
  "eval_harness_design",
  "review_panel",
  "control_room_summary",
  "ops_audit",
] as const;
export type LcxOntologyModuleId = (typeof LCX_ONTOLOGY_MODULE_IDS)[number];

export const LCX_ONTOLOGY_REQUIRED_FINANCE_MODULE_IDS = [
  "macro_rates_inflation",
  "credit_liquidity",
  "etf_regime",
  "company_fundamentals_value",
  "portfolio_risk_gates",
] as const satisfies readonly LcxOntologyModuleId[];

export const LCX_ONTOLOGY_FINANCE_FRAMEWORK_CORE_DOMAIN_IDS = [
  "macro_rates_inflation",
  "etf_regime",
  "options_volatility",
  "company_fundamentals_value",
  "commodities_oil_gold",
  "fx_dollar",
  "credit_liquidity",
  "event_driven",
  "portfolio_risk_gates",
  "causal_map",
] as const satisfies readonly LcxOntologyModuleId[];
export type LcxOntologyFinanceFrameworkCoreDomainId =
  (typeof LCX_ONTOLOGY_FINANCE_FRAMEWORK_CORE_DOMAIN_IDS)[number];

export const LCX_ONTOLOGY_FINANCE_ALLOWED_ACTION_AUTHORITIES = [
  "research_only",
  "watch_only",
  "candidate_for_review",
  "no_action",
] as const;
export type LcxOntologyFinanceAllowedActionAuthority =
  (typeof LCX_ONTOLOGY_FINANCE_ALLOWED_ACTION_AUTHORITIES)[number];

export const LCX_ONTOLOGY_FINANCE_CONFIDENCE_OR_CONVICTION_LEVELS = [
  "low",
  "medium",
  "high",
  "mixed",
] as const;
export type LcxOntologyFinanceConfidenceOrConvictionLevel =
  (typeof LCX_ONTOLOGY_FINANCE_CONFIDENCE_OR_CONVICTION_LEVELS)[number];

export const LCX_ONTOLOGY_MODULE_ALIASES: Readonly<Record<string, LcxOntologyModuleId>> = {
  artifact_memory_recall: "finance_learning_memory",
  capability_card_or_retrieval_receipt: "source_registry",
  doctrine_consistency_doctor: "agent_workflow_memory",
  finance_article_source_collection_preflight: "source_registry",
  finance_article_source_registry_record: "source_registry",
  finance_data_gateway_snapshot: "finance_data_gateway",
  finance_framework_core_inspect: "source_registry",
  finance_learning_capability_apply: "finance_learning_memory",
  l5_regression_batterer: "eval_harness_design",
  external_loop_diagnose: "ops_audit",
  local_brain_eval: "eval_harness_design",
  local_memory_retrieval: "finance_learning_memory",
  review_tier: "review_panel",
  sessions_history: "agent_workflow_memory",
  source_registry_lookup: "source_registry",
  source_registry_query: "source_registry",
} as const;

export const LCX_ONTOLOGY_LEARNING_TARGET_IDS = [
  "factor_research",
  "options_volatility",
  "global_index_regime",
  "macro_rates_inflation",
  "company_fundamentals_value",
  "financial_modeling_valuation_qc",
  "thesis_catalyst_lifecycle",
  "data_provenance_quality",
  "research_artifact_qc",
  "technical_timing",
  "commodities_oil_gold",
  "fx_currency_liquidity",
  "event_driven",
  "portfolio_risk_gates",
  "external_message_workflow",
  "agent_workflow_memory",
  "ops_audit",
  "skill_pattern_distillation",
] as const;
export type LcxOntologyLearningTargetId = (typeof LCX_ONTOLOGY_LEARNING_TARGET_IDS)[number];

export const LCX_ONTOLOGY_EXTERNAL_LEARNING_TARGET_IDS = [
  "factor_research",
  "external_message_workflow",
] as const satisfies readonly LcxOntologyLearningTargetId[];

export const LCX_ONTOLOGY_MODULE_FAMILY_IDS = [
  "finance_research",
  "agent_workflow",
  "ops_runtime",
  "skill_runtime",
] as const;
export type LcxOntologyModuleFamilyId = (typeof LCX_ONTOLOGY_MODULE_FAMILY_IDS)[number];

export const LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TYPES = [
  "analysis_method",
  "research_framework",
  "data_collection_method",
  "indicator_method",
  "risk_method",
  "causal_mapping_method",
] as const;
export type LcxOntologyFinanceLearningCapabilityType =
  (typeof LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TYPES)[number];

export const LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TAGS = [
  "sentiment_analysis",
  "factor_research",
  "tactical_timing",
  "leverage_research",
  "alternative_data_ingestion",
  "fundamentals_research",
  "event_catalyst_mapping",
  "volatility_research",
  "risk_gate_design",
  "causal_mapping",
] as const;
export type LcxOntologyFinanceLearningCapabilityTag =
  (typeof LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TAGS)[number];

export const LCX_ONTOLOGY_FINANCE_LEARNING_SOURCE_TYPES = [
  "wechat_public_account_article",
  "public_web_article",
  "licensed_research_excerpt",
  "manual_learning_note",
  "internal_research_note",
] as const;
export type LcxOntologyFinanceLearningSourceType =
  (typeof LCX_ONTOLOGY_FINANCE_LEARNING_SOURCE_TYPES)[number];

export const LCX_ONTOLOGY_FINANCE_LEARNING_COLLECTION_METHODS = [
  "manual_review",
  "public_article_capture",
  "public_wechat_capture",
  "licensed_excerpt_capture",
  "internal_note_capture",
] as const;
export type LcxOntologyFinanceLearningCollectionMethod =
  (typeof LCX_ONTOLOGY_FINANCE_LEARNING_COLLECTION_METHODS)[number];

export const LCX_ONTOLOGY_FINANCE_LEARNING_EVIDENCE_LEVELS = [
  "hypothesis",
  "anecdotal",
  "case_study",
  "replicated",
  "mixed",
] as const;
export type LcxOntologyFinanceLearningEvidenceLevel =
  (typeof LCX_ONTOLOGY_FINANCE_LEARNING_EVIDENCE_LEVELS)[number];

export const LCX_ONTOLOGY_TASK_FAMILY_IDS = [
  "control_room_planning",
  "finance_capability_application",
  "module_learning_review_status",
  "portfolio_risk_research_planning",
  "etf_macro_risk_research_planning",
  "human_brain_finance_decomposition",
  "local_brain_sample_trust_accounting",
  "teacher_distillation_quality_control",
  "eval_family_expansion_after_training_material",
  "module_learning_receipt_truth_boundary",
  "plain_buy_sell_research_boundary",
  "plain_recent_market_brief_boundary",
  "dataset_count_quality_boundary",
  "teacher_volume_not_gold_quality",
  "train_slice_weighting_boundary",
  "eval_pass_coverage_boundary",
  "parse_recovered_promotion_boundary",
  "short_external_market_scope_boundary",
  "commodity_scope_module_boundary",
  "options_volatility_execution_boundary",
  "position_sizing_missing_inputs_boundary",
  "alternative_source_hypothesis_boundary",
  "analyst_report_learning_boundary",
  "etf_weight_data_conflict_boundary",
  "receipt_not_live_visible_boundary",
  "single_clean_adapter_runtime_boundary",
  "heavy_process_overlap_boundary",
  "teacher_review_dedup_boundary",
  "eval_suite_family_coverage_boundary",
  "monotonic_prerequisite_eval_boundary",
  "daily_learning_automation",
  "finance_skill_curriculum_bridge",
  "ambiguous_repeat_without_current_subject",
  "context_reset_new_subject_required",
  "external_context_pollution_audit",
  "plain_language_hidden_complexity_intake",
  "senior_trader_research_risk_packet",
  "senior_trader_failure_focus_promotion_chain",
  "plain_recent_stock_market_brief_preflight",
  "offensive_stock_opportunity_research",
  "plain_single_stock_position_sizing_preflight",
  "plain_buy_hold_research_boundary",
  "conflicting_memory_live_model_review_governance",
  "abstraction_transfer_repair_protocol",
  "all_module_knowledge_internalization_chain",
  "broad_finance_module_taxonomy_planning",
  "scenario_probability_missing_inputs_research_preflight",
  "commodity_macro_framework_learning_planning",
  "alternative_market_signal_source_preflight",
  "source_grounding_claim_audit",
  "sentiment_vendor_conflict_validation_loop",
  "data_vendor_conflict_reconciliation",
  "tax_loss_rebalance_research_boundary",
  "options_iv_event_risk_research_boundary",
  "financial_modeling_valuation_qc",
  "thesis_catalyst_lifecycle_review",
  "data_provenance_quality_gate",
  "research_artifact_qc_gate",
  "external_source_learning_missing_source",
  "external_source_coverage_honesty",
  "external_knowledge_internalization_protocol",
  "prediction_market_research_strategy_distillation",
  "external_financial_agent_pattern_distillation",
  "agent_skill_pattern_distillation",
  "paper_learning_internalization_planning",
  "current_market_data_research_preflight",
  "factor_timing_overfit_resistant_learning",
  "crypto_leverage_research_boundary",
  "sentiment_market_module_learning_preflight",
  "company_filing_missing_evidence_preflight",
  "value_investing_fundamental_research_planning",
  "model_review_disagreement_resolution",
  "macro_event_risk_research_preflight",
  "portfolio_rebalance_execution_boundary",
  "single_stock_curve_technical_timing_preflight",
  "technical_timing_not_standalone_alpha",
  "full_stack_finance_stress_research_planning",
  "etf_fund_structure_research_planning",
  "finance_post_mortem_correction_learning",
  "analyst_report_learning_source_quality_review",
  "cross_market_finance_research_planning",
  "local_memory_knowledge_activated_research_planning",
  "company_fundamental_portfolio_risk_planning",
  "treasury_supply_term_premium_portfolio_risk",
  "private_credit_nonbank_leverage_stress_waterflow",
  "ai_capex_power_grid_index_concentration_risk",
  "energy_inflation_cross_asset_shock_risk",
  "portfolio_quant_math_missing_inputs",
  "portfolio_macro_risk_research_planning",
  "low_frequency_etf_timing_planning",
  "finance_research_planning",
  "all_domain_finance_research_loop",
  "finance_memory_training_self_repair",
  "generated_router_task",
] as const;
export type LcxOntologyTaskFamilyId = (typeof LCX_ONTOLOGY_TASK_FAMILY_IDS)[number];

/**
 * These are transport/parser outcomes, not semantic task families. They may
 * appear in raw receipts, but they must never become canonical task meaning.
 */
export const LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_IDS = [
  "unknown",
  "partial_json_object",
] as const;
export type LcxOntologyNonCanonicalTaskFamilyId =
  (typeof LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_IDS)[number];

export const LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_CLASSES = {
  sentinel: ["unknown"],
  parserArtifact: ["partial_json_object"],
} as const satisfies Readonly<Record<string, readonly LcxOntologyNonCanonicalTaskFamilyId[]>>;

/**
 * Historical seed, teacher, and adapter labels resolve to one task-family
 * vocabulary. Keep the source labels readable while preventing each producer
 * from silently inventing a second meaning for the same family.
 */
export const LCX_ONTOLOGY_TASK_FAMILY_ALIASES: Readonly<Record<string, LcxOntologyTaskFamilyId>> = {
  agent_skill_distillation_open_source: "agent_skill_pattern_distillation",
  anthropic_financial_agent_pattern_distillation: "external_financial_agent_pattern_distillation",
  broad_finance_module_taxonomy: "broad_finance_module_taxonomy_planning",
  company_filing_missing_evidence_gate: "company_filing_missing_evidence_preflight",
  context_reset: "context_reset_new_subject_required",
  coverage_honesty: "external_source_coverage_honesty",
  cross_market_us_a_index_crypto: "cross_market_finance_research_planning",
  crypto_high_leverage_research_boundary: "crypto_leverage_research_boundary",
  current_market_data_freshness_boundary: "current_market_data_research_preflight",
  data_provenance_quality: "data_provenance_quality_gate",
  etf_macro_risk_research_planning: "etf_macro_risk_research_planning",
  event_gap_options_hedge_research_boundary: "options_iv_event_risk_research_boundary",
  external_scholarly_learning_coverage_honesty: "external_source_coverage_honesty",
  external_scholarly_learning_planning: "external_source_coverage_honesty",
  external_source_learning_planning: "external_knowledge_internalization_protocol",
  external_source_missing: "external_source_learning_missing_source",
  factor_backtest_overfit_guard: "factor_timing_overfit_resistant_learning",
  factor_timing_learning_with_overfit_guard: "factor_timing_overfit_resistant_learning",
  factor_timing_overfit_guard: "factor_timing_overfit_resistant_learning",
  fundamental_research: "value_investing_fundamental_research_planning",
  fundamental_research_planning: "value_investing_fundamental_research_planning",
  human_brain_finance_decomposition: "human_brain_finance_decomposition",
  ambiguous_repeat: "ambiguous_repeat_without_current_subject",
  external_context_pollution: "external_context_pollution_audit",
  learning_external_source: "external_knowledge_internalization_protocol",
  learning_external_source_missing_source: "external_source_learning_missing_source",
  local_math_then_review: "portfolio_quant_math_missing_inputs",
  low_frequency_etf_timing_framework: "low_frequency_etf_timing_planning",
  multi_asset_macro_portfolio_risk: "full_stack_finance_stress_research_planning",
  module_learning_internalization: "all_module_knowledge_internalization_chain",
  paper_learning_internalization_absorption: "paper_learning_internalization_planning",
  portfolio_math_missing_inputs: "portfolio_quant_math_missing_inputs",
  portfolio_multi_module_risk_decomposition: "full_stack_finance_stress_research_planning",
  portfolio_multi_module_risk_planning: "full_stack_finance_stress_research_planning",
  quant_math_portfolio_risk: "portfolio_quant_math_missing_inputs",
  quant_math_portfolio_risk_missing_inputs: "portfolio_quant_math_missing_inputs",
  research_artifact_qc: "research_artifact_qc_gate",
  sentiment_market_external_module_learning: "sentiment_market_module_learning_preflight",
  single_company_fundamental_portfolio_risk: "company_fundamental_portfolio_risk_planning",
  single_company_portfolio_transmission: "company_fundamental_portfolio_risk_planning",
  source_grounding_audit: "source_grounding_claim_audit",
  technical_timing_not_standalone_alpha: "technical_timing_not_standalone_alpha",
  thesis_catalyst_lifecycle: "thesis_catalyst_lifecycle_review",
  trade_journal_post_mortem_learning: "finance_post_mortem_correction_learning",
  value_investing_fundamental_core: "value_investing_fundamental_research_planning",
  ops_source_grounding: "source_grounding_claim_audit",
} as const;

export const LCX_ONTOLOGY_CORE_RISK_BOUNDARY_IDS = [
  "research_only",
  "no_execution_authority",
  "evidence_required",
  "no_model_math_guessing",
  "risk_gate_before_action_language",
  "no_high_leverage_crypto",
  "no_unverified_cross_market_claims",
] as const;
export type LcxOntologyCoreRiskBoundaryId = (typeof LCX_ONTOLOGY_CORE_RISK_BOUNDARY_IDS)[number];

export const LCX_ONTOLOGY_CONTRACT_FIELD_IDS = [
  "research_only",
  "no_execution_authority",
  "evidence_required",
  "no_model_math_guessing",
  "no_unverified_current_market_data",
  "no_trade_advice",
  "missing_data",
  "risk_boundaries",
  "next_step",
  "rejected_context",
  "required_tools",
] as const;

export const LCX_ONTOLOGY_CONTRACT_BOUNDARY_IDS = [
  "do_not_promote_unverified_memory_claims",
  "no_high_leverage_crypto",
  "no_external_channel_sender_change",
  "no_model_math_guessing",
  "no_unverified_current_market_data",
  "no_unverified_current_market_data_claims",
  "no_protected_memory_write",
  "no_provider_config_change",
  "no_trade_advice",
  "no_unverified_live_data",
  "no_unverified_live_data_claims",
  "research_only",
  "risk_gate_before_action_language",
  "technical_timing_not_standalone_alpha",
  "do_not_pick_model_answer_without_evidence",
  "do_not_answer_literal_short_phrase_only",
  "do_not_stop_at_original_example",
  "no_one_off_phrase_patch",
  "proof_required_before_claiming_transfer",
  "no_raw_json_visible_reply",
] as const;

export const LCX_ONTOLOGY_CAPABILITY_MATURITY = ["structural", "operational", "observed"] as const;
export type LcxOntologyCapabilityMaturity = (typeof LCX_ONTOLOGY_CAPABILITY_MATURITY)[number];

export const LCX_ONTOLOGY_CAPABILITY_COVERAGE = ["complete", "partial", "missing"] as const;
export type LcxOntologyCapabilityCoverage = (typeof LCX_ONTOLOGY_CAPABILITY_COVERAGE)[number];

export const LCX_ONTOLOGY_ADAPTABILITY = [
  "adapter_neutral",
  "adapter_ready",
  "adapter_bound",
] as const;
export type LcxOntologyAdaptability = (typeof LCX_ONTOLOGY_ADAPTABILITY)[number];

export const LCX_ONTOLOGY_CAPABILITY_ROLES = [
  "core_architecture",
  "observed_implementation",
] as const;
export type LcxOntologyCapabilityRole = (typeof LCX_ONTOLOGY_CAPABILITY_ROLES)[number];

export const LCX_ONTOLOGY_DELIVERY_STATES = ["unknown", "bound", "observed"] as const;
export type LcxOntologyDeliveryState = (typeof LCX_ONTOLOGY_DELIVERY_STATES)[number];

export const LCX_ONTOLOGY_DELIVERY_PROOF_VISIBILITIES = ["binding", "user_visible"] as const;
export type LcxOntologyDeliveryProofVisibility =
  (typeof LCX_ONTOLOGY_DELIVERY_PROOF_VISIBILITIES)[number];

export const LCX_ONTOLOGY_BOUNDARY_STATUSES = [
  "unknown",
  "not_touched_by_projection",
  "touched",
] as const;
export type LcxOntologyBoundaryStatus = (typeof LCX_ONTOLOGY_BOUNDARY_STATUSES)[number];

export const LCX_ONTOLOGY_EVIDENCE_STATUSES = ["present", "missing"] as const;
export type LcxOntologyEvidenceStatus = (typeof LCX_ONTOLOGY_EVIDENCE_STATUSES)[number];

export const LCX_ONTOLOGY_PROJECTION_READ_STATUSES = [
  "current",
  "stale",
  "missing",
  "invalid",
] as const;
export type LcxOntologyProjectionReadStatus =
  (typeof LCX_ONTOLOGY_PROJECTION_READ_STATUSES)[number];

export const LCX_ONTOLOGY_ACTION_KINDS = ["observe", "repair", "wait"] as const;
export type LcxOntologyActionKind = (typeof LCX_ONTOLOGY_ACTION_KINDS)[number];

export const LCX_ONTOLOGY_ACTION_STATUSES = ["recommended", "blocked"] as const;
export type LcxOntologyActionStatus = (typeof LCX_ONTOLOGY_ACTION_STATUSES)[number];

export const LCX_ONTOLOGY_LEARNING_DECISIONS = [
  "keep",
  "downrank",
  "discard",
  "not_decided",
] as const;
export type LcxOntologyLearningDecision = (typeof LCX_ONTOLOGY_LEARNING_DECISIONS)[number];

export const LCX_ONTOLOGY_FINANCE_DATA_PROVIDER_ROLES = [
  "primary_market_data",
  "cross_check_market_data",
  "official_or_issuer_reference",
] as const;
export type LcxOntologyFinanceDataProviderRole =
  (typeof LCX_ONTOLOGY_FINANCE_DATA_PROVIDER_ROLES)[number];

export const LCX_ONTOLOGY_FINANCE_DATA_SOURCE_FAMILIES = [
  "market_data_api",
  "fundamentals_api",
  "official_filing",
  "official_macro_data",
  "etf_issuer",
  "manual_snapshot",
  "local_research_artifact",
] as const;
export type LcxOntologyFinanceDataSourceFamily =
  (typeof LCX_ONTOLOGY_FINANCE_DATA_SOURCE_FAMILIES)[number];

export const LCX_ONTOLOGY_FINANCE_DATA_DELAY_STATUSES = [
  "realtime",
  "delayed",
  "end_of_day",
  "official_lagged",
  "manual_or_unknown",
] as const;
export type LcxOntologyFinanceDataDelayStatus =
  (typeof LCX_ONTOLOGY_FINANCE_DATA_DELAY_STATUSES)[number];

export const LCX_ONTOLOGY_FINANCE_DATA_QUALITY_STATUSES = [
  "ready",
  "needs_review",
  "blocked",
] as const;
export type LcxOntologyFinanceDataQualityStatus =
  (typeof LCX_ONTOLOGY_FINANCE_DATA_QUALITY_STATUSES)[number];

export const LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_TYPES = [
  "wechat_public_account_source",
  "public_web_source",
  "official_reference_source",
  "official_data_source",
  "market_data_snapshot_source",
  "vendor_data_source",
  "academic_preprint_source",
  "github_repository_source",
  "rss_public_feed_source",
  "licensed_research_source",
  "internal_research_source",
  "manual_article_source",
  "management_interview_source",
  "investor_blog_source",
  "podcast_source",
  "social_sentiment_source",
  "viral_event_source",
] as const;
export type LcxOntologyFinanceArticleSourceType =
  (typeof LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_TYPES)[number];

export const LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS = [
  "manual_paste",
  "local_file",
  "user_provided_url",
  "rss_or_public_feed_if_available",
  "browser_assisted_manual_collection",
] as const;
export type LcxOntologyFinanceArticleSourceCollectionMethod =
  (typeof LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS)[number];

export const LCX_ONTOLOGY_FINANCE_EVIDENCE_CATEGORIES = [
  "equity_market_evidence",
  "etf_regime_evidence",
  "macro_rates_evidence",
  "inflation_evidence",
  "liquidity_evidence",
  "credit_evidence",
  "options_volatility_evidence",
  "fundamentals_evidence",
  "valuation_evidence",
  "commodity_evidence",
  "fx_dollar_evidence",
  "event_catalyst_evidence",
  "portfolio_risk_evidence",
  "causal_chain_evidence",
  "alternative_data_evidence",
  "sentiment_evidence",
  "backtest_or_empirical_evidence",
  "implementation_evidence",
  "compliance_evidence",
] as const;
export type LcxOntologyFinanceEvidenceCategory =
  (typeof LCX_ONTOLOGY_FINANCE_EVIDENCE_CATEGORIES)[number];

export const LCX_ONTOLOGY_SOURCE_EVIDENCE_CLASSES = [
  "hard",
  "medium",
  "weak_alternative_source",
] as const;
export type LcxOntologySourceEvidenceClass = (typeof LCX_ONTOLOGY_SOURCE_EVIDENCE_CLASSES)[number];

export const LCX_ONTOLOGY_SOURCE_RELIABILITY_GRADES = ["a", "b", "c", "d"] as const;
export type LcxOntologySourceReliabilityGrade =
  (typeof LCX_ONTOLOGY_SOURCE_RELIABILITY_GRADES)[number];

export const LCX_ONTOLOGY_WEAK_EVIDENCE_POLICIES = [
  "hypothesis_only",
  "downrank_until_followthrough",
] as const;
export type LcxOntologyWeakEvidencePolicy = (typeof LCX_ONTOLOGY_WEAK_EVIDENCE_POLICIES)[number];

export const LCX_ONTOLOGY_LEARNING_EVIDENCE_STATUSES = [
  "missing_evidence",
  "stored_only",
  "retrieval_ready",
  "application_ready",
  "eval_absorbed",
] as const;
export type LcxOntologyLearningEvidenceStatus =
  (typeof LCX_ONTOLOGY_LEARNING_EVIDENCE_STATUSES)[number];

export const LCX_ONTOLOGY_CHANNEL_MILESTONES = [
  "core_ready",
  "external_channel_bound",
  "user_visible_observed",
] as const;
export type LcxOntologyChannelMilestone = (typeof LCX_ONTOLOGY_CHANNEL_MILESTONES)[number];

export const LCX_ONTOLOGY_CHANNEL_MILESTONE_ALIASES: Readonly<
  Record<string, LcxOntologyChannelMilestone>
> = {
  "core-ready": "core_ready",
  "external-channel-bound": "external_channel_bound",
  "user-visible-observed": "user_visible_observed",
  "live-runtime-updated": "external_channel_bound",
  "live-user-seen": "user_visible_observed",
  core_ready: "core_ready",
  external_channel_bound: "external_channel_bound",
  user_visible_observed: "user_visible_observed",
  live_runtime_updated: "external_channel_bound",
  live_user_seen: "user_visible_observed",
} as const;

export const LCX_ONTOLOGY_WORKFLOW_NODE_IDS = [
  "ingress_external_message",
  "intent_classifier",
  "local_brain_planner",
  "finance_research_modules",
  "finance_data_gateway",
  "focused_research_universe",
  "directed_daily_research_brief",
  "daily_research_packet",
  "candidate_watchlist",
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
  "evolution_cooldown",
  "hardened_eval",
  "promotion_gate",
  "adapter_resolver",
  "failure_curriculum",
  "skillopt_candidate_edit",
  "skillopt_best_skill",
  "skillopt_runtime_preflight",
  "local_change",
  "local_tests",
  "live_migration",
  "build_restart_probe",
  "external_channel_binding",
  "channel_restart_probe",
  "real_external_inbound",
  "live_user_seen",
  "user_visible_observed",
  "new_codex_window",
  "fixed_evidence_recovery",
  "operator_latest_state",
  "universe_index",
  "repo_inventory",
  "artifact_inventory",
  "owner_coverage_map",
  "cleanup_candidate_review",
  "mind_model",
  "flow_graph",
  "training_plan",
  "change_impact_plan",
  "local_operator_loop",
  "governance_autopilot",
  "local_failure_trace",
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
  "minimax_agent_draft",
  "provider_boundary",
  "source_conflict_review",
  "memory_recall",
  "system_memory_sedimentation_gate",
  "memory_write_gate",
  "correction_note",
  "stale_memory_downrank",
  "self_repair_hands",
  "self_repair_memory_cleaner",
  "self_repair_training_case_builder",
  "training_eval_candidate_packet",
  "self_repair_latest_receipt",
  "prior_work_search",
  "similar_mechanism_merge",
  "single_owner_contract",
  "parallel_path_reject",
  "external_agent_source",
  "prediction_market_source",
  "resolution_criteria_review",
  "market_microstructure_review",
  "strategy_experiment_audit",
  "external_upgrade_radar",
  "blacktech_mechanism_map",
  "license_scope_review",
  "workflow_distillation",
  "local_skill_candidate",
  "trajectory_or_trace_receipt",
  "security_permission_review",
  "acceptance_eval",
  "commercial_acceptance_harness",
  "schedule_gate",
  "repair_lock",
] as const;
export type LcxOntologyWorkflowNodeId = (typeof LCX_ONTOLOGY_WORKFLOW_NODE_IDS)[number];

export const LCX_ONTOLOGY_ANSWER_PIPELINE_FILTER_IDS = [
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
  "post_council_gate_replacement_returns_failed_reason",
  "explicit_visible_contract_must_be_answered_directly",
  "vague_conservative_nonanswer_rejected",
  "single_entry_single_exit_visible_answer_required",
  "single_entry_single_exit_internal_labels_hidden",
  "positive_visible_answer_acceptance_required",
  "direct_answer_not_overconservative_required",
  "all_visible_answers_require_decision_value",
  "single_stock_loss_reply_requires_concrete_risk_triage",
  "visible_answer_quality_fuzzer_required",
  "short_external_intent_expansion_required",
  "system_status_requires_owner_evidence",
  "standalone_finance_ask_cannot_defer_to_stale_prior_answer",
  "model_rewrite_budget_required",
  "no_raw_json_visible_reply",
  "no_internal_runtime_details_visible",
  "source_evidence_gate",
  "stored_only_is_not_learning",
  "retrieval_apply_eval_review_required",
  "async_task_receipt_required_for_deferred_work",
  "real_external_short_canary_suite_required",
  "short_intent_family_fuzzer_required",
  "unknown_short_intent_clean_failure_required",
  "no_unverified_current_market_data",
  "finance_data_gateway_snapshot_required_for_numbers",
  "finance_data_conflicts_route_to_provenance_review",
  "no_trade_advice",
] as const;
export type LcxOntologyAnswerPipelineFilterId =
  (typeof LCX_ONTOLOGY_ANSWER_PIPELINE_FILTER_IDS)[number];

export const LCX_ONTOLOGY_WORKFLOW_FILTER_IDS = [
  ...LCX_ONTOLOGY_ANSWER_PIPELINE_FILTER_IDS,
  "research_only_boundary",
  "protected_memory_guard",
  "language_corpus_separation",
  "per_receipt_absorption_evidence_required",
  "training_overlap_guard",
  "work_then_evolve_cooldown_required",
  "parse_recovered_no_promotion",
  "promotion_ready_required",
  "step_timeout_visible",
  "local_ready_not_live_user_seen",
  "live_runtime_probe_required",
  "local_ready_not_user_visible_observed",
  "external_channel_probe_required",
  "real_external_inbound_required",
  "fresh_operator_state_required",
  "single_digest_only",
  "error_receipt_required",
  "visible_text_no_internal_labels",
  "reply_flow_audit_required",
  "provider_evidence_required",
  "no_provider_config_change",
  "no_external_channel_sender_change",
  "source_conflict_visible",
  "fresh_timestamp_required",
  "field_definition_required",
  "three_source_reconciliation_required",
  "conflicted_data_blocks_conclusion",
  "memory_write_freshness_gate",
  "self_repair_write_allowlist_required",
  "explicit_self_repair_write_flag_required",
  "training_candidate_not_absorbed",
  "system_memory_not_module_learning",
  "correction_note_required",
  "prior_work_reuse_required",
  "same_philosophy_merge_required",
  "single_owner_required",
  "license_scope_required",
  "untrusted_source_isolation",
  "blacktech_is_pattern_intake_only",
  "runtime_authority_not_granted",
  "model_weight_absorption_not_claimed",
  "live_proof_required",
  "tool_permission_audit_required",
  "human_signoff_checkpoint",
  "no_wallet_or_order_execution",
  "market_microstructure_warning_required",
  "paper_only_backtest_required",
  "sample_out_validation_required",
  "thin_liquidity_downrank_required",
  "ambiguous_resolution_blocks_conclusion",
  "fees_slippage_and_sample_out_required",
  "commercial_error_budget_required",
  "product_canary_suite_required",
  "automation_schedule_gate",
  "repair_lock_required",
  "skillopt_best_skill_required",
  "skillopt_context_not_weight_absorption",
  "skillopt_external_channel_proof_required",
  "inventory_only_no_delete",
  "owner_coverage_required",
  "artifact_staleness_visible",
  "focused_daily_product_required",
  "daily_research_packet_required",
  "candidate_watchlist_not_trade_recommendation",
] as const;
export type LcxOntologyWorkflowFilterId = (typeof LCX_ONTOLOGY_WORKFLOW_FILTER_IDS)[number];

export const LCX_ONTOLOGY_WORKFLOW_SCENARIO_IDS = [
  "external_finance_research_waterflow",
  "directed_daily_research_brief_waterflow",
  "module_learning_internalization_waterflow",
  "training_failure_feedback_waterflow",
  "local_to_external_channel_external_waterflow",
  "skillopt_runtime_self_use_waterflow",
  "compressed_context_recovery_waterflow",
  "universe_index_total_coverage_waterflow",
  "local_automation_digest_waterflow",
  "external_visible_language_waterflow",
  "commercial_answer_pipeline_waterflow",
  "provider_council_evidence_waterflow",
  "commercial_acceptance_harness_waterflow",
  "memory_correction_downrank_waterflow",
  "self_repair_hands_waterflow",
  "finance_data_gateway_waterflow",
  "senior_trader_failure_focus_waterflow",
  "similar_engineering_consolidation_waterflow",
  "external_agent_skill_distillation_waterflow",
  "prediction_market_research_only_waterflow",
  "automation_repair_lock_waterflow",
] as const;
export type LcxOntologyWorkflowScenarioId = (typeof LCX_ONTOLOGY_WORKFLOW_SCENARIO_IDS)[number];

export const LCX_ONTOLOGY_WORKFLOW_FAMILY_IDS = [
  "visible_external_finance_research",
  "focused_daily_finance_research_product",
  "online_learning_to_memory_sedimentation",
  "teacher_qwen_eval_promotion_loop",
  "local_ready_to_external_user_visible_boundary",
  "skillopt_eval_to_external_message_channel_preflight",
  "future_agent_state_recovery",
  "repo_runtime_artifact_total_inventory",
  "local_operator_to_single_digest",
  "visible_external_readability_and_language_boundary",
  "commercial_answer_adoption_and_failed_reason",
  "multi_model_provider_evidence_review",
  "commercial_product_acceptance_gate",
  "memory_recall_correction_and_downrank",
  "memory_correction_and_training_candidate_self_repair",
  "timestamped_finance_data_reconciliation",
  "senior_trader_promotion_failure_closure",
  "same_philosophy_engineering_merge",
  "external_agent_or_skill_learning",
  "prediction_market_research_and_strategy_audit",
  "codex_auto_repair_and_schedule_guard",
] as const;
export type LcxOntologyWorkflowFamilyId = (typeof LCX_ONTOLOGY_WORKFLOW_FAMILY_IDS)[number];

export const LCX_ONTOLOGY_VOCABULARIES = {
  entityType: LCX_ONTOLOGY_ENTITY_TYPES,
  relation: LCX_ONTOLOGY_RELATION_TYPES,
  domainEntityType: LCX_ONTOLOGY_DOMAIN_ENTITY_TYPES,
  surface: LCX_ONTOLOGY_SURFACE_IDS,
  evidenceKind: LCX_ONTOLOGY_EVIDENCE_KINDS,
  module: LCX_ONTOLOGY_MODULE_IDS,
  learningTarget: LCX_ONTOLOGY_LEARNING_TARGET_IDS,
  externalLearningTarget: LCX_ONTOLOGY_EXTERNAL_LEARNING_TARGET_IDS,
  moduleFamily: LCX_ONTOLOGY_MODULE_FAMILY_IDS,
  taskFamily: LCX_ONTOLOGY_TASK_FAMILY_IDS,
  coreRiskBoundary: LCX_ONTOLOGY_CORE_RISK_BOUNDARY_IDS,
  contractField: LCX_ONTOLOGY_CONTRACT_FIELD_IDS,
  contractBoundary: LCX_ONTOLOGY_CONTRACT_BOUNDARY_IDS,
  capabilityMaturity: LCX_ONTOLOGY_CAPABILITY_MATURITY,
  capabilityCoverage: LCX_ONTOLOGY_CAPABILITY_COVERAGE,
  adaptability: LCX_ONTOLOGY_ADAPTABILITY,
  capabilityRole: LCX_ONTOLOGY_CAPABILITY_ROLES,
  deliveryState: LCX_ONTOLOGY_DELIVERY_STATES,
  deliveryProofVisibility: LCX_ONTOLOGY_DELIVERY_PROOF_VISIBILITIES,
  boundaryStatus: LCX_ONTOLOGY_BOUNDARY_STATUSES,
  evidenceStatus: LCX_ONTOLOGY_EVIDENCE_STATUSES,
  projectionReadStatus: LCX_ONTOLOGY_PROJECTION_READ_STATUSES,
  actionKind: LCX_ONTOLOGY_ACTION_KINDS,
  actionStatus: LCX_ONTOLOGY_ACTION_STATUSES,
  learningDecision: LCX_ONTOLOGY_LEARNING_DECISIONS,
  financeFrameworkCoreDomain: LCX_ONTOLOGY_FINANCE_FRAMEWORK_CORE_DOMAIN_IDS,
  financeAllowedActionAuthority: LCX_ONTOLOGY_FINANCE_ALLOWED_ACTION_AUTHORITIES,
  financeConfidenceOrConviction: LCX_ONTOLOGY_FINANCE_CONFIDENCE_OR_CONVICTION_LEVELS,
  financeLearningCapabilityType: LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TYPES,
  financeLearningCapabilityTag: LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TAGS,
  financeLearningSourceType: LCX_ONTOLOGY_FINANCE_LEARNING_SOURCE_TYPES,
  financeLearningCollectionMethod: LCX_ONTOLOGY_FINANCE_LEARNING_COLLECTION_METHODS,
  financeLearningEvidenceLevel: LCX_ONTOLOGY_FINANCE_LEARNING_EVIDENCE_LEVELS,
  financeDataProviderRole: LCX_ONTOLOGY_FINANCE_DATA_PROVIDER_ROLES,
  financeDataSourceFamily: LCX_ONTOLOGY_FINANCE_DATA_SOURCE_FAMILIES,
  financeDataDelayStatus: LCX_ONTOLOGY_FINANCE_DATA_DELAY_STATUSES,
  financeDataQualityStatus: LCX_ONTOLOGY_FINANCE_DATA_QUALITY_STATUSES,
  financeArticleSourceType: LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_TYPES,
  financeArticleSourceCollectionMethod: LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS,
  financeEvidenceCategory: LCX_ONTOLOGY_FINANCE_EVIDENCE_CATEGORIES,
  sourceEvidenceClass: LCX_ONTOLOGY_SOURCE_EVIDENCE_CLASSES,
  sourceReliabilityGrade: LCX_ONTOLOGY_SOURCE_RELIABILITY_GRADES,
  weakEvidencePolicy: LCX_ONTOLOGY_WEAK_EVIDENCE_POLICIES,
  learningEvidenceStatus: LCX_ONTOLOGY_LEARNING_EVIDENCE_STATUSES,
  channelMilestone: LCX_ONTOLOGY_CHANNEL_MILESTONES,
  workflowNode: LCX_ONTOLOGY_WORKFLOW_NODE_IDS,
  workflowFilter: LCX_ONTOLOGY_WORKFLOW_FILTER_IDS,
  answerPipelineFilter: LCX_ONTOLOGY_ANSWER_PIPELINE_FILTER_IDS,
  workflowScenario: LCX_ONTOLOGY_WORKFLOW_SCENARIO_IDS,
  workflowFamily: LCX_ONTOLOGY_WORKFLOW_FAMILY_IDS,
} as const;
export type LcxOntologyVocabularyName = keyof typeof LCX_ONTOLOGY_VOCABULARIES;
export type LcxOntologyVocabularyValue<V extends LcxOntologyVocabularyName> =
  (typeof LCX_ONTOLOGY_VOCABULARIES)[V][number];

/**
 * Every vocabulary belongs to one semantic area so future additions declare
 * where they participate in the whole-system model instead of becoming
 * another unowned list.
 */
export const LCX_ONTOLOGY_VOCABULARY_GROUPS = {
  semanticGraph: ["entityType", "relation", "domainEntityType"],
  architecture: [
    "surface",
    "evidenceKind",
    "module",
    "learningTarget",
    "externalLearningTarget",
    "moduleFamily",
    "coreRiskBoundary",
    "contractField",
    "contractBoundary",
    "capabilityMaturity",
    "capabilityCoverage",
    "adaptability",
    "capabilityRole",
    "actionKind",
    "actionStatus",
    "learningDecision",
  ],
  stateAndDelivery: [
    "deliveryState",
    "deliveryProofVisibility",
    "boundaryStatus",
    "evidenceStatus",
    "projectionReadStatus",
    "learningEvidenceStatus",
    "channelMilestone",
  ],
  finance: [
    "financeFrameworkCoreDomain",
    "financeAllowedActionAuthority",
    "financeConfidenceOrConviction",
    "financeLearningCapabilityType",
    "financeLearningCapabilityTag",
    "financeLearningSourceType",
    "financeLearningCollectionMethod",
    "financeLearningEvidenceLevel",
    "financeDataProviderRole",
    "financeDataSourceFamily",
    "financeDataDelayStatus",
    "financeDataQualityStatus",
    "financeArticleSourceType",
    "financeArticleSourceCollectionMethod",
    "financeEvidenceCategory",
    "sourceEvidenceClass",
    "sourceReliabilityGrade",
    "weakEvidencePolicy",
  ],
  workflow: [
    "taskFamily",
    "workflowNode",
    "workflowFilter",
    "answerPipelineFilter",
    "workflowScenario",
    "workflowFamily",
  ],
} as const satisfies Readonly<Record<string, readonly LcxOntologyVocabularyName[]>>;
export type LcxOntologyVocabularyGroupId = keyof typeof LCX_ONTOLOGY_VOCABULARY_GROUPS;

export const LCX_ONTOLOGY_EVOLUTION_CHANGE_KINDS = [
  "add_canonical_value",
  "add_alias",
  "change_relation_contract",
  "change_state_chain",
  "rename_canonical_value",
  "remove_canonical_value",
  "rename_vocabulary",
  "move_canonical_source",
  "change_identifier_classification",
  "introduce_parallel_registry",
] as const;
export type LcxOntologyEvolutionChangeKind = (typeof LCX_ONTOLOGY_EVOLUTION_CHANGE_KINDS)[number];

export const LCX_ONTOLOGY_EVOLUTION_ACTIONS = [
  "extend_in_place",
  "versioned_explicit_migration",
  "forbidden",
] as const;
export type LcxOntologyEvolutionAction = (typeof LCX_ONTOLOGY_EVOLUTION_ACTIONS)[number];

export const LCX_ONTOLOGY_EVOLUTION_PROOF_IDS = [
  "ontology_audit",
  "change_impact_plan",
  "focused_regression",
  "head_tail_consistency",
  "flow_graph",
  "mind_model",
  "migration_manifest",
] as const;
export type LcxOntologyEvolutionProofId = (typeof LCX_ONTOLOGY_EVOLUTION_PROOF_IDS)[number];

export type LcxOntologyEvolutionRule = {
  changeKind: LcxOntologyEvolutionChangeKind;
  action: LcxOntologyEvolutionAction;
  requiresVersionBump: boolean;
  requiresMigrationManifest: boolean;
  requiredProofs: readonly LcxOntologyEvolutionProofId[];
};

const LCX_ONTOLOGY_EVOLUTION_ADDITIVE_PROOFS = [
  "ontology_audit",
  "change_impact_plan",
  "focused_regression",
] as const satisfies readonly LcxOntologyEvolutionProofId[];
const LCX_ONTOLOGY_EVOLUTION_BREAKING_PROOFS = [
  "ontology_audit",
  "change_impact_plan",
  "focused_regression",
  "head_tail_consistency",
  "flow_graph",
  "mind_model",
  "migration_manifest",
] as const satisfies readonly LcxOntologyEvolutionProofId[];
const LCX_ONTOLOGY_EVOLUTION_STRUCTURAL_PROOFS = [
  "ontology_audit",
  "change_impact_plan",
  "focused_regression",
  "head_tail_consistency",
  "mind_model",
  "migration_manifest",
] as const satisfies readonly LcxOntologyEvolutionProofId[];

/**
 * Additive changes preserve the current registry version. Semantic breaks,
 * physical moves, and classification changes require an explicit migration;
 * a parallel registry is never an accepted evolution strategy.
 */
export const LCX_ONTOLOGY_EVOLUTION_RULES: readonly LcxOntologyEvolutionRule[] = [
  {
    changeKind: "add_canonical_value",
    action: "extend_in_place",
    requiresVersionBump: false,
    requiresMigrationManifest: false,
    requiredProofs: LCX_ONTOLOGY_EVOLUTION_ADDITIVE_PROOFS,
  },
  {
    changeKind: "add_alias",
    action: "extend_in_place",
    requiresVersionBump: false,
    requiresMigrationManifest: false,
    requiredProofs: LCX_ONTOLOGY_EVOLUTION_ADDITIVE_PROOFS,
  },
  {
    changeKind: "change_relation_contract",
    action: "versioned_explicit_migration",
    requiresVersionBump: true,
    requiresMigrationManifest: true,
    requiredProofs: LCX_ONTOLOGY_EVOLUTION_BREAKING_PROOFS,
  },
  {
    changeKind: "change_state_chain",
    action: "versioned_explicit_migration",
    requiresVersionBump: true,
    requiresMigrationManifest: true,
    requiredProofs: LCX_ONTOLOGY_EVOLUTION_BREAKING_PROOFS,
  },
  {
    changeKind: "rename_canonical_value",
    action: "versioned_explicit_migration",
    requiresVersionBump: true,
    requiresMigrationManifest: true,
    requiredProofs: LCX_ONTOLOGY_EVOLUTION_BREAKING_PROOFS,
  },
  {
    changeKind: "remove_canonical_value",
    action: "versioned_explicit_migration",
    requiresVersionBump: true,
    requiresMigrationManifest: true,
    requiredProofs: LCX_ONTOLOGY_EVOLUTION_BREAKING_PROOFS,
  },
  {
    changeKind: "rename_vocabulary",
    action: "versioned_explicit_migration",
    requiresVersionBump: true,
    requiresMigrationManifest: true,
    requiredProofs: LCX_ONTOLOGY_EVOLUTION_BREAKING_PROOFS,
  },
  {
    changeKind: "move_canonical_source",
    action: "versioned_explicit_migration",
    requiresVersionBump: true,
    requiresMigrationManifest: true,
    requiredProofs: LCX_ONTOLOGY_EVOLUTION_STRUCTURAL_PROOFS,
  },
  {
    changeKind: "change_identifier_classification",
    action: "versioned_explicit_migration",
    requiresVersionBump: true,
    requiresMigrationManifest: true,
    requiredProofs: LCX_ONTOLOGY_EVOLUTION_STRUCTURAL_PROOFS,
  },
  {
    changeKind: "introduce_parallel_registry",
    action: "forbidden",
    requiresVersionBump: false,
    requiresMigrationManifest: false,
    requiredProofs: ["ontology_audit"],
  },
];

export const LCX_ONTOLOGY_EVOLUTION_PROOF_SURFACES = {
  ontology_audit: "scripts/operator/lcx-ontology.ts",
  change_impact_plan: "scripts/operator/lcx-change-impact-plan.ts",
  focused_regression: "test/lcx-ontology.test.ts",
  head_tail_consistency: "scripts/operator/lcx-head-tail-consistency.ts",
  flow_graph: "scripts/operator/lcx-flow-graph.ts",
  mind_model: "scripts/operator/lcx-mind-model.ts",
  migration_manifest: "versioned explicit migration manifest",
} as const satisfies Record<LcxOntologyEvolutionProofId, string>;

export const LCX_ONTOLOGY_MIGRATION_MANIFEST_REQUIRED_FIELDS = [
  "schemaVersion",
  "fromOntologyVersion",
  "toOntologyVersion",
  "changes",
  "affectedVocabularies",
  "reason",
  "compatibility",
  "rollback",
  "requiredProofs",
] as const;

export const LCX_ONTOLOGY_EVOLUTION_CONTRACT = {
  contractVersion: LCX_ONTOLOGY_EVOLUTION_CONTRACT_VERSION,
  registryVersion: LCX_ONTOLOGY_VERSION,
  canonicalSource: LCX_ONTOLOGY_REGISTRY_POLICY.canonicalSource,
  defaultAction: "extend_in_place",
  breakingChangeAction: "versioned_explicit_migration",
  forbiddenAction: "forbidden",
  vocabularyGroups: LCX_ONTOLOGY_VOCABULARY_GROUPS,
  rules: LCX_ONTOLOGY_EVOLUTION_RULES,
  proofSurfaces: LCX_ONTOLOGY_EVOLUTION_PROOF_SURFACES,
  migrationManifestSchemaVersion: LCX_ONTOLOGY_MIGRATION_MANIFEST_SCHEMA_VERSION,
  migrationManifestRequiredFields: LCX_ONTOLOGY_MIGRATION_MANIFEST_REQUIRED_FIELDS,
  invariants: [
    "canonical_ids_are_stable",
    "aliases_target_current_canonical_values",
    "semantic_breaks_require_versioned_migration",
    "parallel_registries_are_forbidden",
    "non_canonical_runtime_outcomes_stay_outside_semantics",
  ],
} as const;

export type LcxOntologyMigrationChange = {
  changeKind: LcxOntologyEvolutionChangeKind;
  scope: LcxOntologyVocabularyName | "registry";
  from?: string;
  to?: string;
};

export type LcxOntologyMigrationManifest = {
  schemaVersion: typeof LCX_ONTOLOGY_MIGRATION_MANIFEST_SCHEMA_VERSION;
  fromOntologyVersion: string;
  toOntologyVersion: string;
  changes: readonly LcxOntologyMigrationChange[];
  affectedVocabularies: readonly LcxOntologyVocabularyName[];
  reason: string;
  compatibility: "dual_read_then_cutover" | "explicit_cutover";
  rollback: "available" | "not_available";
  requiredProofs: readonly LcxOntologyEvolutionProofId[];
};

/**
 * These identifiers describe today's adapter implementation, not the
 * underlying capability or evidence. They remain canonical for compatibility
 * until the owning workflows migrate to neutral names.
 */
export const LCX_ONTOLOGY_ADAPTER_IMPLEMENTATION_IDS = {
  learningTarget: ["external_message_workflow"],
  taskFamily: ["external_context_pollution_audit"],
  workflowNode: ["ingress_external_message", "real_external_inbound"],
  workflowFilter: ["real_external_inbound_required"],
} as const satisfies Partial<Record<LcxOntologyVocabularyName, readonly string[]>>;

/**
 * Legacy status/flow labels stay readable but must not be mistaken for new
 * architecture vocabulary.
 */
export const LCX_ONTOLOGY_LEGACY_COMPATIBILITY_IDS = {
  workflowNode: ["live_user_seen"],
  workflowFilter: ["local_ready_not_live_user_seen"],
} as const satisfies Partial<Record<LcxOntologyVocabularyName, readonly string[]>>;

export const LCX_ONTOLOGY_FORBIDDEN_CANONICAL_TOKENS = ["dev"] as const;

export const LCX_ONTOLOGY_STATE_CHAINS = {
  moduleLearning: [
    "missing_evidence",
    "stored_only",
    "retrieval_ready",
    "application_ready",
    "eval_absorbed",
  ],
  externalDelivery: ["core_ready", "external_channel_bound", "user_visible_observed"],
  capabilityEvidence: ["missing", "present"],
} as const;

export const LCX_ONTOLOGY_REGISTRY = {
  version: LCX_ONTOLOGY_VERSION,
  entityTypes: LCX_ONTOLOGY_ENTITY_TYPES,
  relationContracts: LCX_ONTOLOGY_RELATION_CONTRACTS,
  relationTypes: LCX_ONTOLOGY_RELATION_TYPES,
  vocabularies: LCX_ONTOLOGY_VOCABULARIES,
  vocabularyGroups: LCX_ONTOLOGY_VOCABULARY_GROUPS,
  evolution: LCX_ONTOLOGY_EVOLUTION_CONTRACT,
  nonCanonicalTaskFamilyIds: LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_IDS,
  nonCanonicalTaskFamilyClasses: LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_CLASSES,
  policy: LCX_ONTOLOGY_REGISTRY_POLICY,
  stateChains: LCX_ONTOLOGY_STATE_CHAINS,
  aliases: {
    module: LCX_ONTOLOGY_MODULE_ALIASES,
    taskFamily: LCX_ONTOLOGY_TASK_FAMILY_ALIASES,
    channelMilestone: LCX_ONTOLOGY_CHANNEL_MILESTONE_ALIASES,
  },
  identifierClasses: {
    adapterImplementation: LCX_ONTOLOGY_ADAPTER_IMPLEMENTATION_IDS,
    legacyCompatibility: LCX_ONTOLOGY_LEGACY_COMPATIBILITY_IDS,
  },
} as const;

export function normalizeLcxOntologyKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

export function isLcxOntologyValue(vocabulary: LcxOntologyVocabularyName, value: string): boolean {
  return (LCX_ONTOLOGY_VOCABULARIES[vocabulary] as readonly string[]).includes(value);
}

export function getLcxOntologyRelationContract(
  relation: LcxOntologyRelationType,
): LcxOntologyRelationContract | undefined {
  return LCX_ONTOLOGY_RELATION_CONTRACTS.find((contract) => contract.relation === relation);
}

export function isLcxOntologyRelationAllowed(
  relation: LcxOntologyRelationType,
  subjectType: LcxOntologyEntityType,
  objectType: LcxOntologyEntityType,
): boolean {
  const contract = getLcxOntologyRelationContract(relation);
  return (
    contract !== undefined &&
    contract.subjectTypes.includes(subjectType) &&
    contract.objectTypes.includes(objectType)
  );
}

export function isLcxOntologyNonCanonicalTaskFamily(value: string): boolean {
  return LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_IDS.includes(
    normalizeLcxOntologyKey(value) as LcxOntologyNonCanonicalTaskFamilyId,
  );
}

export function canonicalizeLcxOntologyValue<V extends LcxOntologyVocabularyName>(
  vocabulary: V,
  value: string,
): LcxOntologyVocabularyValue<V> | undefined {
  const normalized = normalizeLcxOntologyKey(value);
  const aliases =
    vocabulary === "module"
      ? LCX_ONTOLOGY_MODULE_ALIASES
      : vocabulary === "taskFamily"
        ? LCX_ONTOLOGY_TASK_FAMILY_ALIASES
        : vocabulary === "channelMilestone"
          ? LCX_ONTOLOGY_CHANNEL_MILESTONE_ALIASES
          : undefined;
  const canonical = aliases?.[normalized] ?? normalized;
  return isLcxOntologyValue(vocabulary, canonical)
    ? (canonical as LcxOntologyVocabularyValue<V>)
    : undefined;
}

export function getLcxOntologyEvolutionRule(
  changeKind: LcxOntologyEvolutionChangeKind,
): LcxOntologyEvolutionRule | undefined {
  return LCX_ONTOLOGY_EVOLUTION_RULES.find((rule) => rule.changeKind === changeKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvolutionChangeKind(value: unknown): value is LcxOntologyEvolutionChangeKind {
  return (
    typeof value === "string" &&
    LCX_ONTOLOGY_EVOLUTION_CHANGE_KINDS.includes(value as LcxOntologyEvolutionChangeKind)
  );
}

function isEvolutionProofId(value: unknown): value is LcxOntologyEvolutionProofId {
  return (
    typeof value === "string" &&
    LCX_ONTOLOGY_EVOLUTION_PROOF_IDS.includes(value as LcxOntologyEvolutionProofId)
  );
}

/**
 * Validate a future migration artifact before it is used by an owner. The
 * input is unknown on purpose: migration manifests normally arrive from JSON
 * or another persisted boundary and must not be trusted by their type alone.
 */
export function validateLcxOntologyMigrationManifest(manifest: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(manifest)) {
    return ["ontology migration manifest must be an object"];
  }
  if (manifest.schemaVersion !== LCX_ONTOLOGY_MIGRATION_MANIFEST_SCHEMA_VERSION) {
    errors.push("ontology migration manifest has an unsupported schema version");
  }
  const fromOntologyVersion = manifest.fromOntologyVersion;
  const toOntologyVersion = manifest.toOntologyVersion;
  if (typeof fromOntologyVersion !== "string" || fromOntologyVersion.trim().length === 0) {
    errors.push("ontology migration manifest needs fromOntologyVersion");
  }
  if (typeof toOntologyVersion !== "string" || toOntologyVersion.trim().length === 0) {
    errors.push("ontology migration manifest needs toOntologyVersion");
  }
  if (
    typeof fromOntologyVersion === "string" &&
    typeof toOntologyVersion === "string" &&
    fromOntologyVersion === toOntologyVersion
  ) {
    errors.push("ontology migration manifest must change the ontology version");
  }
  if (typeof manifest.reason !== "string" || manifest.reason.trim().length === 0) {
    errors.push("ontology migration manifest needs a reason");
  }
  if (!Array.isArray(manifest.changes) || manifest.changes.length === 0) {
    errors.push("ontology migration manifest needs at least one change");
  }
  const requiredProofs = Array.isArray(manifest.requiredProofs) ? manifest.requiredProofs : [];
  if (!Array.isArray(manifest.requiredProofs) || requiredProofs.length === 0) {
    errors.push("ontology migration manifest needs requiredProofs");
  }
  if (
    manifest.compatibility !== "dual_read_then_cutover" &&
    manifest.compatibility !== "explicit_cutover"
  ) {
    errors.push("ontology migration manifest has an unsupported compatibility mode");
  }
  if (manifest.rollback !== "available" && manifest.rollback !== "not_available") {
    errors.push("ontology migration manifest has an unsupported rollback mode");
  }

  const vocabularyNames = new Set(Object.keys(LCX_ONTOLOGY_VOCABULARIES));
  const affectedVocabularies = Array.isArray(manifest.affectedVocabularies)
    ? manifest.affectedVocabularies
    : [];
  if (!Array.isArray(manifest.affectedVocabularies) || affectedVocabularies.length === 0) {
    errors.push("ontology migration manifest needs affectedVocabularies");
  }
  for (const vocabulary of affectedVocabularies) {
    if (typeof vocabulary !== "string" || !vocabularyNames.has(vocabulary)) {
      errors.push("ontology migration manifest uses unknown vocabulary: " + String(vocabulary));
    }
  }
  for (const duplicate of duplicateValues(
    affectedVocabularies.filter(
      (vocabulary): vocabulary is string => typeof vocabulary === "string",
    ),
  )) {
    errors.push("ontology migration manifest repeats vocabulary: " + duplicate);
  }
  const affectedVocabularySet = new Set(
    affectedVocabularies.filter(
      (vocabulary): vocabulary is string =>
        typeof vocabulary === "string" && vocabularyNames.has(vocabulary),
    ),
  );
  const requiredProofSet = new Set<LcxOntologyEvolutionProofId>();
  for (const proof of requiredProofs) {
    if (!isEvolutionProofId(proof)) {
      errors.push("ontology migration manifest uses unknown proof: " + String(proof));
    }
  }
  for (const duplicate of duplicateValues(requiredProofs.filter(isEvolutionProofId))) {
    errors.push("ontology migration manifest repeats proof: " + duplicate);
  }
  for (const proof of requiredProofs) {
    if (isEvolutionProofId(proof)) {
      requiredProofSet.add(proof);
    }
  }

  const changes = Array.isArray(manifest.changes) ? manifest.changes : [];
  for (const [index, rawChange] of changes.entries()) {
    if (!isRecord(rawChange)) {
      errors.push("ontology migration change " + index + " must be an object");
      continue;
    }
    const changeKind = rawChange.changeKind;
    if (!isEvolutionChangeKind(changeKind)) {
      errors.push("ontology migration change " + index + " uses unknown change kind");
      continue;
    }
    const rule = getLcxOntologyEvolutionRule(changeKind);
    if (rule === undefined) {
      errors.push("ontology migration change has no rule: " + changeKind);
      continue;
    }
    if (rule.action !== "versioned_explicit_migration") {
      errors.push(
        "ontology migration cannot contain non-breaking or forbidden change: " + changeKind,
      );
    }
    for (const proof of rule.requiredProofs) {
      if (!requiredProofSet.has(proof)) {
        errors.push("ontology migration manifest is missing proof " + proof + " for " + changeKind);
      }
    }
    const scope = rawChange.scope;
    if (scope !== "registry" && (typeof scope !== "string" || !vocabularyNames.has(scope))) {
      errors.push("ontology migration change " + index + " uses unknown scope");
    } else if (scope !== "registry" && !affectedVocabularySet.has(scope)) {
      errors.push(
        "ontology migration change " + index + " scope is not listed in affectedVocabularies",
      );
    }
    const from = rawChange.from;
    const to = rawChange.to;
    if (changeKind === "remove_canonical_value") {
      if (typeof from !== "string" || from.trim().length === 0) {
        errors.push("ontology removal change " + index + " needs from");
      }
    } else if (
      typeof from !== "string" ||
      from.trim().length === 0 ||
      typeof to !== "string" ||
      to.trim().length === 0
    ) {
      errors.push("ontology migration change " + index + " needs from and to");
    } else if (from === to) {
      errors.push("ontology migration change " + index + " must change its identifier or contract");
    }
  }
  return errors;
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function validateVocabularyGroups(): string[] {
  const errors: string[] = [];
  const covered = new Map<string, string>();
  const vocabularyNames = new Set(Object.keys(LCX_ONTOLOGY_VOCABULARIES));
  for (const [group, vocabularies] of Object.entries(LCX_ONTOLOGY_VOCABULARY_GROUPS)) {
    for (const duplicate of duplicateValues(vocabularies)) {
      errors.push("vocabulary group " + group + " contains duplicate vocabulary " + duplicate);
    }
    for (const vocabulary of vocabularies) {
      if (!vocabularyNames.has(vocabulary)) {
        errors.push("vocabulary group " + group + " uses unknown vocabulary " + vocabulary);
        continue;
      }
      const previousGroup = covered.get(vocabulary);
      if (previousGroup !== undefined && previousGroup !== group) {
        errors.push(
          "vocabulary " +
            vocabulary +
            " belongs to multiple groups: " +
            previousGroup +
            ", " +
            group,
        );
      }
      covered.set(vocabulary, group);
    }
  }
  for (const vocabulary of vocabularyNames) {
    if (!covered.has(vocabulary)) {
      errors.push("vocabulary has no evolution group: " + vocabulary);
    }
  }
  return errors;
}

function validateEvolutionContract(): string[] {
  const errors: string[] = [];
  if (LCX_ONTOLOGY_EVOLUTION_CONTRACT.contractVersion !== LCX_ONTOLOGY_EVOLUTION_CONTRACT_VERSION) {
    errors.push("ontology evolution contract version is inconsistent");
  }
  if (LCX_ONTOLOGY_EVOLUTION_CONTRACT.registryVersion !== LCX_ONTOLOGY_VERSION) {
    errors.push("ontology evolution contract points to a different registry version");
  }
  if (
    LCX_ONTOLOGY_EVOLUTION_CONTRACT.canonicalSource !== LCX_ONTOLOGY_REGISTRY_POLICY.canonicalSource
  ) {
    errors.push("ontology evolution contract points to a different canonical source");
  }
  if (
    LCX_ONTOLOGY_EVOLUTION_CONTRACT.migrationManifestSchemaVersion !==
    LCX_ONTOLOGY_MIGRATION_MANIFEST_SCHEMA_VERSION
  ) {
    errors.push("ontology evolution contract uses an inconsistent migration manifest schema");
  }
  for (const proof of LCX_ONTOLOGY_EVOLUTION_PROOF_IDS) {
    if (!(proof in LCX_ONTOLOGY_EVOLUTION_PROOF_SURFACES)) {
      errors.push("ontology evolution contract has no proof surface: " + proof);
    }
  }
  for (const duplicate of duplicateValues(LCX_ONTOLOGY_EVOLUTION_CONTRACT.invariants)) {
    errors.push("ontology evolution contract repeats invariant: " + duplicate);
  }
  const knownChangeKinds = new Set<string>(LCX_ONTOLOGY_EVOLUTION_CHANGE_KINDS);
  const coveredChangeKinds = new Set<string>();
  for (const rule of LCX_ONTOLOGY_EVOLUTION_RULES) {
    if (!knownChangeKinds.has(rule.changeKind)) {
      errors.push("evolution rule uses unknown change kind: " + rule.changeKind);
    }
    if (coveredChangeKinds.has(rule.changeKind)) {
      errors.push("evolution rule is duplicated: " + rule.changeKind);
    }
    coveredChangeKinds.add(rule.changeKind);
    if (rule.action === "versioned_explicit_migration") {
      if (!rule.requiresVersionBump || !rule.requiresMigrationManifest) {
        errors.push(
          "breaking evolution rule lacks version/migration requirement: " + rule.changeKind,
        );
      }
    }
    if (
      rule.action === "extend_in_place" &&
      (rule.requiresVersionBump || rule.requiresMigrationManifest)
    ) {
      errors.push("additive evolution rule requires an unnecessary migration: " + rule.changeKind);
    }
    if (
      rule.action === "forbidden" &&
      (rule.requiresVersionBump || rule.requiresMigrationManifest)
    ) {
      errors.push("forbidden evolution rule must stop before migration: " + rule.changeKind);
    }
    for (const proof of rule.requiredProofs) {
      if (!(proof in LCX_ONTOLOGY_EVOLUTION_PROOF_SURFACES)) {
        errors.push("evolution rule uses unknown proof: " + rule.changeKind + ":" + proof);
      }
    }
    for (const duplicate of duplicateValues(rule.requiredProofs)) {
      errors.push("evolution rule contains duplicate proof: " + rule.changeKind + ":" + duplicate);
    }
  }
  for (const changeKind of LCX_ONTOLOGY_EVOLUTION_CHANGE_KINDS) {
    if (!coveredChangeKinds.has(changeKind)) {
      errors.push("evolution change kind has no rule: " + changeKind);
    }
  }
  if (LCX_ONTOLOGY_REGISTRY_POLICY.changeMode !== LCX_ONTOLOGY_EVOLUTION_CONTRACT.defaultAction) {
    errors.push("ontology policy and evolution contract disagree on additive changes");
  }
  if (
    LCX_ONTOLOGY_REGISTRY_POLICY.migrationMode !==
    LCX_ONTOLOGY_EVOLUTION_CONTRACT.breakingChangeAction
  ) {
    errors.push("ontology policy and evolution contract disagree on breaking changes");
  }
  if (LCX_ONTOLOGY_REGISTRY_POLICY.parallelRegistry !== "forbidden") {
    errors.push("ontology evolution contract must forbid parallel registries");
  }
  return errors;
}

function validateRelationContracts(): string[] {
  const errors: string[] = [];
  const coveredRelations = new Set<string>();
  for (const contract of LCX_ONTOLOGY_RELATION_CONTRACTS) {
    if (coveredRelations.has(contract.relation)) {
      errors.push("relation contract is duplicated: " + contract.relation);
    }
    coveredRelations.add(contract.relation);
    const subjectTypeCount: number = contract.subjectTypes.length;
    const objectTypeCount: number = contract.objectTypes.length;
    if (subjectTypeCount === 0 || objectTypeCount === 0) {
      errors.push("relation contract has an empty endpoint: " + contract.relation);
    }
    for (const type of [...contract.subjectTypes, ...contract.objectTypes]) {
      if (!isLcxOntologyValue("entityType", type)) {
        errors.push("relation contract " + contract.relation + " uses unknown entity type " + type);
      }
    }
  }
  for (const relation of LCX_ONTOLOGY_RELATION_TYPES) {
    if (!coveredRelations.has(relation)) {
      errors.push("relation has no contract: " + relation);
    }
  }
  return errors;
}

function validateStateChains(): string[] {
  const errors: string[] = [];
  const chainVocabularies = {
    moduleLearning: "learningEvidenceStatus",
    externalDelivery: "channelMilestone",
    capabilityEvidence: "evidenceStatus",
  } as const satisfies Record<keyof typeof LCX_ONTOLOGY_STATE_CHAINS, LcxOntologyVocabularyName>;
  for (const [chainName, values] of Object.entries(LCX_ONTOLOGY_STATE_CHAINS)) {
    const vocabulary = chainVocabularies[chainName as keyof typeof chainVocabularies];
    for (const duplicate of duplicateValues(values)) {
      errors.push(chainName + " state chain contains duplicate value " + duplicate);
    }
    for (const value of values) {
      if (!isLcxOntologyValue(vocabulary, value)) {
        errors.push(chainName + " state chain uses unknown " + vocabulary + " value " + value);
      }
    }
  }
  return errors;
}

function validateAliasKeys(): string[] {
  const errors: string[] = [];
  for (const [name, aliases] of Object.entries(LCX_ONTOLOGY_REGISTRY.aliases)) {
    const vocabulary = name as LcxOntologyVocabularyName;
    const normalizedAliases = new Map<string, string>();
    for (const [alias, target] of Object.entries(aliases)) {
      const normalizedAlias = normalizeLcxOntologyKey(alias);
      if (!normalizedAlias) {
        errors.push(name + " alias is empty after normalization: " + alias);
        continue;
      }
      const previousTarget = normalizedAliases.get(normalizedAlias);
      if (previousTarget !== undefined && previousTarget !== target) {
        errors.push(
          name +
            " aliases collide after normalization: " +
            alias +
            " and another alias resolve to different targets",
        );
      }
      normalizedAliases.set(normalizedAlias, target);
      if (!isLcxOntologyValue(vocabulary, target)) {
        errors.push(name + " alias targets unknown canonical value " + target);
      }
      if (isLcxOntologyValue(vocabulary, normalizedAlias) && normalizedAlias !== target) {
        errors.push(
          name +
            " alias collides with canonical value " +
            normalizedAlias +
            " but targets " +
            target,
        );
      }
    }
  }
  return errors;
}

export function validateLcxOntologyRegistry(): string[] {
  const errors: string[] = [];
  errors.push(
    ...validateVocabularyGroups(),
    ...validateEvolutionContract(),
    ...validateRelationContracts(),
    ...validateStateChains(),
    ...validateAliasKeys(),
  );
  for (const duplicate of duplicateValues(LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_IDS)) {
    errors.push("non-canonical task-family value is duplicated: " + duplicate);
  }
  for (const value of LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_IDS) {
    if (isLcxOntologyValue("taskFamily", value)) {
      errors.push("non-canonical task-family value is also canonical: " + value);
    }
  }
  for (const [className, values] of Object.entries(
    LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_CLASSES,
  )) {
    for (const value of values) {
      if (!LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_IDS.includes(value)) {
        errors.push(
          "non-canonical task-family class " + className + " uses unknown value " + value,
        );
      }
    }
  }
  if (!LCX_ONTOLOGY_REGISTRY_POLICY.canonicalSource.endsWith("src/shared/lcx-ontology.ts")) {
    errors.push("ontology canonical source policy points outside src/shared/lcx-ontology.ts");
  }
  if (LCX_ONTOLOGY_REGISTRY_POLICY.parallelRegistry !== "forbidden") {
    errors.push("ontology policy must forbid parallel registries");
  }
  for (const [name, values] of Object.entries(LCX_ONTOLOGY_VOCABULARIES)) {
    const emptyValues = values.filter((value) => value.trim().length === 0);
    if (emptyValues.length > 0) {
      errors.push(name + " contains empty values");
    }
    for (const duplicate of duplicateValues(values)) {
      errors.push(name + " contains duplicate value " + duplicate);
    }
  }
  for (const token of LCX_ONTOLOGY_FORBIDDEN_CANONICAL_TOKENS) {
    const tokenPattern = new RegExp(`(?:^|_)${token}(?:_|$)`, "u");
    for (const [name, values] of Object.entries(LCX_ONTOLOGY_VOCABULARIES)) {
      for (const value of values) {
        if (tokenPattern.test(value)) {
          errors.push(name + " contains forbidden canonical token " + token + ": " + value);
        }
      }
    }
  }
  for (const [classification, vocabularies] of Object.entries(
    LCX_ONTOLOGY_REGISTRY.identifierClasses,
  )) {
    for (const [name, values] of Object.entries(vocabularies)) {
      for (const value of values) {
        const vocabulary = name as LcxOntologyVocabularyName;
        if (!isLcxOntologyValue(vocabulary, value)) {
          errors.push(classification + " identifier " + name + ":" + value + " is not registered");
        }
      }
    }
  }
  for (const [name, aliases] of Object.entries(LCX_ONTOLOGY_REGISTRY.aliases)) {
    for (const [alias, target] of Object.entries(aliases)) {
      const vocabulary = name as LcxOntologyVocabularyName;
      if (!isLcxOntologyValue(vocabulary, target)) {
        errors.push(name + " alias " + alias + " points to unknown value " + target);
      }
    }
  }
  for (const moduleId of LCX_ONTOLOGY_REQUIRED_FINANCE_MODULE_IDS) {
    if (!isLcxOntologyValue("module", moduleId)) {
      errors.push("required finance module is not registered: " + moduleId);
    }
  }
  return errors;
}
