import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam, ToolInputError } from "./common.js";

const MODULE_LEARNING_TARGETS = [
  "factor_research",
  "options_volatility",
  "global_index_regime",
  "macro_rates_inflation",
  "company_fundamentals_value",
  "technical_timing",
  "commodities_oil_gold",
  "fx_currency_liquidity",
  "event_driven",
  "portfolio_risk_gates",
  "lark_feishu_workflow",
  "agent_workflow_memory",
  "ops_audit",
  "skill_pattern_distillation",
] as const;

type ModuleLearningTarget = (typeof MODULE_LEARNING_TARGETS)[number];

type ModuleLearningSchema = {
  targetModule: ModuleLearningTarget;
  moduleFamily: "finance_research" | "agent_workflow" | "ops_runtime" | "skill_runtime";
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

const ModuleLearningPipelinePlanSchema = Type.Object({
  targetModule: stringEnum(MODULE_LEARNING_TARGETS),
  sourceUrlOrPath: Type.Optional(Type.String()),
  learningIntent: Type.Optional(Type.String()),
  actualReadingScope: Type.Optional(Type.String()),
  applicationValidationTask: Type.Optional(Type.String()),
  existingArtifactPaths: Type.Optional(Type.Array(Type.String())),
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
  lark_feishu_workflow: {
    targetModule: "lark_feishu_workflow",
    moduleFamily: "agent_workflow",
    requiredInputs: [
      "visible_reply_sample_or_message_id",
      "routing_family_and_backend_tool_contract",
      "reply_flow_receipt_or_lark_diagnose_output",
      "human_readable_summary_contract",
      "dev_vs_live_evidence_boundary",
    ],
    evidenceFamilies: ["visible_reply_evidence", "routing_receipt", "live_boundary_evidence"],
    moduleSpecificCapabilityRule:
      "Lark/Feishu workflow learning must improve readable replies and routing while preserving dev-vs-live proof boundaries.",
    applicationValidationTask:
      "Apply the workflow rule to a fresh Lark-style message and prove no raw JSON/internal labels leak into the visible reply.",
    safetyBoundaries: [
      "no_live_visible_fixed_claim_without_real_inbound_reply",
      "no_live_sender_change",
      "no_provider_config_change",
      "no_raw_json_visible_reply",
    ],
    existingToolBridge: {
      primaryTool: "lark_loop_diagnose",
      supportTools: ["lark_language_corpus_review", "review_panel", "local_brain_eval"],
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
      "dev_fixed_not_live_fixed",
      "no_overlapping_training_start",
      "no_provider_config_change",
      "no_live_sender_change",
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

export function createModuleLearningPipelinePlanTool(): AnyAgentTool {
  return {
    label: "Module Learning Pipeline Plan",
    name: "module_learning_pipeline_plan",
    description:
      "Plan one evidence-gated module learning run using the shared source, capability, retrieval, application, eval, and keep/downrank/discard chain. This is read-only and does not fetch remote content or mutate live/provider/protected-memory state.",
    parameters: ModuleLearningPipelinePlanSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const targetModule = readStringParam(params, "targetModule", { required: true });
      if (!MODULE_LEARNING_TARGETS.includes(targetModule as ModuleLearningTarget)) {
        throw new ToolInputError(`unsupported targetModule: ${targetModule}`);
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
      const missingEvidence = [
        sourceUrlOrPath ? null : "source_url_or_local_source_path",
        actualReadingScope ? null : "actual_reading_scope",
        existingArtifactPaths.length > 0 ? null : "prior_art_or_existing_artifact_paths",
        "source_registry_record",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "fresh_adjacent_application_task",
        "keep_downrank_or_discard_decision",
      ].filter((item): item is string => Boolean(item));

      const financePipelineArgs =
        schema.existingToolBridge.bridgeStatus === "direct_finance_pipeline"
          ? {
              sourceName: sourceUrlOrPath ?? `${schema.targetModule} local/manual source`,
              sourceType: "manual_article_source",
              retrievalNotes:
                "Operator-provided local/manual source. Do not fetch remote content in the orchestrator step; preserve provenance and actual reading scope.",
              allowedActionAuthority: "research_only",
              learningIntent,
              applicationValidationQuery: applicationValidationTask,
            }
          : null;

      return jsonResult({
        ok: true,
        boundary: "dev_read_only_module_learning_plan",
        targetModule: schema.targetModule,
        moduleFamily: schema.moduleFamily,
        status: missingEvidence.length === 0 ? "plan_ready" : "missing_evidence",
        sourceUrlOrPath,
        actualReadingScope,
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
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      });
    },
  };
}
