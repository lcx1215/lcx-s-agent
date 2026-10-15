import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 20 * 1024 * 1024;

async function runJsonScript(script: string) {
  try {
    return await execFileAsync(process.execPath, ["--import", "tsx", script, "--json"], {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [
        details.message ?? String(error),
        `stdout=${details.stdout ?? ""}`,
        `stderr=${details.stderr ?? ""}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

describe("LCX flow graph exam", () => {
  it("describes acceptance dispatch separately from child result consumption", async () => {
    const { FLOW_SCENARIOS, workflowControlEdges, workflowProcessEdges } =
      await import("../scripts/operator/lcx-flow-graph.js");
    const scene = FLOW_SCENARIOS.find(
      (entry) => entry.id === "commercial_acceptance_harness_waterflow",
    )!;
    const controls = workflowControlEdges(scene);
    expect(controls).toEqual([
      ["local_operator_loop", "system_doctor"],
      ["local_operator_loop", "training_plan"],
      ["local_operator_loop", "mind_model"],
      ["local_operator_loop", "flow_graph"],
      ["local_operator_loop", "external_channel_binding"],
    ]);
    const relations = workflowProcessEdges(scene);
    for (const [from, to] of controls) {
      expect(relations).toContainEqual({
        relation: "requires",
        subject: { type: "workflow", id: `${scene.id}:${to}` },
        object: { type: "policy", id: `${scene.id}:${from}:dispatch_contract:${to}` },
      });
      expect(relations).not.toContainEqual({
        relation: "requires",
        subject: { type: "workflow", id: `${scene.id}:${to}` },
        object: { type: "artifact", id: `${scene.id}:${from}:output_contract` },
      });
    }
    expect(relations).toContainEqual({
      relation: "requires",
      subject: { type: "workflow", id: `${scene.id}:commercial_acceptance_harness` },
      object: { type: "artifact", id: `${scene.id}:training_plan:output_contract` },
    });
    expect(scene.requiredNodes).toHaveLength(12);
    expect(scene.edges).toHaveLength(16);
    expect(scene.requiredFilters).toHaveLength(9);
    expect(scene.feedbackEdges).toEqual([
      ["acceptance_eval", "commercial_acceptance_harness"],
      ["commercial_acceptance_harness", "training_plan"],
    ]);
  });

  it("rejects equal data fields as proof of acceptance control dispatch", async () => {
    const { createHash } = await import("node:crypto");
    const { FLOW_SCENARIOS, auditWorkflowHandoffs } =
      await import("../scripts/operator/lcx-flow-graph.js");
    const scene = FLOW_SCENARIOS.find(
      (entry) => entry.id === "commercial_acceptance_harness_waterflow",
    )!;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-control-edge-negative-"));
    try {
      // Deliberately fabricated equal fields challenge the audit; no owner execution is asserted.
      const body = JSON.stringify({
        scope: "negative_test_no_business_identity",
        producer: "same_data_does_not_prove_dispatch",
        consumer: "same_data_does_not_prove_dispatch",
      });
      const file = path.join(root, "equal-data-only.json");
      await fs.writeFile(file, body);
      const sha256 = createHash("sha256").update(body).digest("hex");
      const ref = (pointer: string) => ({ path: file, sha256, pointer });
      const rows = await auditWorkflowHandoffs([
        {
          scenarioId: scene.id,
          environment: "offline_fixture",
          nodes: scene.requiredNodes.map((nodeId) => ({
            nodeId,
            scope: ref("/scope"),
            output: ref("/producer"),
            inputs: [...scene.edges, ...(scene.feedbackEdges ?? [])]
              .filter(([, to]) => to === nodeId)
              .map(([from]) => ({ from, value: ref("/consumer") })),
          })),
        },
      ]);
      const row = rows.find((entry) => entry.scenarioId === scene.id)!;
      expect(row.status).toBe("handoff_gap");
      expect(
        row.gaps.filter(
          (gap) => gap.reason === "control_dispatch_not_observed:local_operator_loop",
        ),
      ).toHaveLength(5);
      expect(row.gaps).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: "consumer_did_not_receive_output:local_operator_loop",
          }),
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps repair execution obligations separate from read-only impact recommendations", async () => {
    const { LCX_WORKFLOW_PROCESS_CONTRACTS } =
      await import("../src/shared/lcx-workflow-process-contracts.js");
    const { FLOW_SCENARIOS } = await import("../scripts/operator/lcx-flow-graph.js");
    const contract = LCX_WORKFLOW_PROCESS_CONTRACTS.automation_repair_lock_waterflow;
    const scene = FLOW_SCENARIOS.find((entry) => entry.id === "automation_repair_lock_waterflow")!;
    expect(scene.requiredNodes).toEqual([
      "training_plan",
      "schedule_gate",
      "repair_lock",
      "local_change",
      "local_tests",
      "system_doctor",
      "operator_latest_receipt",
    ]);
    expect(scene.edges).toEqual([
      ["training_plan", "schedule_gate"],
      ["schedule_gate", "repair_lock"],
      ["repair_lock", "local_change"],
      ["local_change", "local_tests"],
      ["local_tests", "system_doctor"],
      ["system_doctor", "operator_latest_receipt"],
    ]);
    expect(scene.feedbackEdges).toEqual([["system_doctor", "training_plan"]]);
    expect(scene.requiredFilters).toEqual([
      "automation_schedule_gate",
      "repair_lock_required",
      "single_digest_only",
      "training_overlap_guard",
      "error_receipt_required",
    ]);
    expect(contract.stages[1].preconditions).toContain(
      "not an implemented automation due/scheduling caller",
    );
    expect(contract.stages[1].preconditions).toContain("rejectedPlanningInput");
    expect(contract.stages[2]).toMatchObject({
      owner: "scripts/operator/lcx-change-impact-plan.ts",
      nodes: ["local_change", "local_tests"],
      implementationStatus: "required_not_implemented",
    });
    expect(contract.stages[2].output).toContain("recommendations only");
    expect(contract.stages[3].implementationStatus).toBe("required_unobserved");
  });

  it("describes direct commercial audit inputs and diagnostic budget consumption", async () => {
    const { FLOW_SCENARIOS, workflowProcessEdges } =
      await import("../scripts/operator/lcx-flow-graph.js");
    const { buildPipelineResult } =
      await import("../scripts/operator/lcx-commercial-answer-pipeline.js");
    const scenario = FLOW_SCENARIOS.find(
      (entry) => entry.id === "commercial_answer_pipeline_waterflow",
    )!;
    const result = buildPipelineResult("计算 2 + 2", "4");
    expect(result.processEvidence.answerAuditBudget.inputQwenChallengeRequested).toBe(
      result.processEvidence.localPlanner.qwenChallengeRequested,
    );
    expect(result.controlRoomSummary.reviewBudget.maxTotalReviewRounds).toBe(
      result.maxTotalReviewRounds,
    );
    expect(result.controlRoomSummary.reviewBudget.scope).toBe(
      "original_local_review_policy_diagnostic_not_external_quota",
    );
    expect(scenario.edges).toEqual(
      expect.arrayContaining([
        ["local_brain_planner", "answer_audit_budget"],
        ["model_candidate_answer", "display_text_normalizer"],
        ["display_text_normalizer", "local_contract_audit"],
        ["provider_evidence", "local_contract_audit"],
        ["answer_audit_budget", "control_room_summary"],
        ["local_brain_planner", "model_council"],
        ["local_contract_audit", "review_panel"],
      ]),
    );
    expect(scenario.edges).not.toContainEqual(["model_candidate_answer", "answer_audit_budget"]);
    expect(scenario.edges).not.toContainEqual(["answer_audit_budget", "local_contract_audit"]);
    expect(workflowProcessEdges(scenario)).toContainEqual({
      relation: "requires",
      subject: { type: "workflow", id: `${scenario.id}:control_room_summary` },
      object: { type: "artifact", id: `${scenario.id}:answer_audit_budget:output_contract` },
    });
  });

  it("passes current task waterflow contracts", async () => {
    const { stdout } = await runJsonScript("scripts/operator/lcx-flow-graph.ts");
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      summary: {
        failed: number;
        total: number;
        scenarios: number;
        nodes: number;
        filters: number;
        consolidationClusters: number;
        consolidatedEntrypointFamilies: number;
        sharedEntrypointOwnerRules: number;
        diagnosticEntries: number;
      };
      checks: Array<{
        id: string;
        ok: boolean;
        evidence?: {
          missing?: string[];
          staleAllowedPaths?: string[];
          staleSharedOwnerRules?: string[];
          unapprovedSharedAllowedPaths?: string[];
          uncoveredClusters?: string[];
          orphanEntrypoints?: string[];
        };
      }>;
      scenarios: Array<{
        id: string;
        requiredFilters: string[];
        feedbackEdgeCount: number;
        receipts: string[];
      }>;
      consolidationClusters: Array<{ id: string; ownerScenario: string; mergeFilters: string[] }>;
      consolidatedEntrypointFamilies: Array<{
        id: string;
        ownerCluster: string;
        ownerPath: string;
        watchedPathTerms: string[];
        allowedPaths: string[];
      }>;
      sharedEntrypointOwnerRules: Array<{
        path: string;
        familyIds: string[];
        reason: string;
      }>;
      diagnosticIndex: Array<{
        scenarioId: string;
        family: string;
        ownerEntrypoint: string;
        fastCheck: string;
        evidenceReceipts: string[];
        failureSignals: string[];
        boundary: string;
      }>;
      financeRuleHandoff: {
        proofLevel: string;
        stages: Array<{
          node: string;
          owner: string;
          input: string;
          output: string;
          blockedBy: string;
        }>;
      };
      financeAutomaticLifecycleAudit: {
        complete: boolean;
        owner: string;
        handoffs: Record<string, boolean>;
        missingHandoffs: string[];
      };
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
    };

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_flow_graph_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.financeRuleHandoff.proofLevel).toBe("structure_only");
    expect(payload.financeRuleHandoff.stages).toHaveLength(5);
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary).toMatchObject({ proofLevel: "structure_only" });
    expect(
      payload.diagnosticIndex.find(
        (entry) => entry.scenarioId === "central_agent_decision_waterflow",
      )?.ownerEntrypoint,
    ).toBe("scripts/operator/lcx-central-agent.ts");
    expect(payload.summary.total).toBeGreaterThanOrEqual(8);
    expect(payload.summary.scenarios).toBeGreaterThanOrEqual(16);
    expect(payload.summary.nodes).toBeGreaterThanOrEqual(70);
    expect(payload.summary.filters).toBeGreaterThanOrEqual(35);
    expect(payload.summary.consolidationClusters).toBeGreaterThanOrEqual(9);
    expect(payload.summary.consolidatedEntrypointFamilies).toBeGreaterThanOrEqual(9);
    expect(payload.summary.sharedEntrypointOwnerRules).toBeGreaterThanOrEqual(2);
    expect(payload.summary.diagnosticEntries).toBe(payload.summary.scenarios);
    expect(payload.financeAutomaticLifecycleAudit).toMatchObject({
      complete: true,
      proofLevel: "source_structure_only",
      owner: "scripts/operator/lcx-finance-scheduler.ts",
      handoffs: {
        researchCanProducePortfolioCandidate: true,
        schedulerCanConsumePortfolioPlan: true,
        scheduledResearchFeedsPortfolioPlan: true,
        scheduledResearchExecutesModuleDag: true,
        intradayRunsUnderFinanceScheduler: true,
        schedulerOwnsNightSettlement: true,
        nightSettlementFeedsReviewedModuleResearch: true,
        nightFeedbackDispatchesTuning: true,
        directionalCalibrationIsolatedFromPaperExecution: true,
        tradingEconomicsUsesLedgerAndQuantMath: true,
        brokerHistoryFeesReachTradeEconomics: true,
        centralHarnessHasAutomaticFinanceTaskFeed: true,
        producerDecisionReferencesReachReceiptDiagnostics: true,
        centralHarnessUsesReadOnlyFinanceSnapshots: true,
      },
      missingHandoffs: [],
    });
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "flow_graph_integrity", ok: true }),
        expect.objectContaining({ id: "flow_graph_filters_required", ok: true }),
        expect.objectContaining({ id: "flow_graph_feedback_is_bounded", ok: true }),
        expect.objectContaining({ id: "flow_graph_illegal_shortcuts_absent", ok: true }),
        expect.objectContaining({ id: "flow_graph_consolidation_clusters_merged", ok: true }),
        expect.objectContaining({
          id: "flow_graph_consolidated_entrypoints_registered",
          ok: true,
        }),
      ]),
    );
    const entrypointCheck = payload.checks.find(
      (check) => check.id === "flow_graph_consolidated_entrypoints_registered",
    );
    expect(entrypointCheck?.evidence?.missing).toEqual([]);
    expect(entrypointCheck?.evidence?.staleAllowedPaths).toEqual([]);
    expect(entrypointCheck?.evidence?.staleSharedOwnerRules).toEqual([]);
    expect(entrypointCheck?.evidence?.unapprovedSharedAllowedPaths).toEqual([]);
    expect(entrypointCheck?.evidence?.uncoveredClusters).toEqual([]);
    expect(entrypointCheck?.evidence?.orphanEntrypoints).toEqual([]);
    expect(payload.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "finance_intraday_paper_waterflow",
          requiredFilters: expect.arrayContaining([
            "closed_bar_only_required",
            "next_bar_fill_required",
            "same_cost_baseline_required",
            "paper_replay_not_execution_receipt",
            "multi_regime_validation_required",
          ]),
          receipts: expect.arrayContaining(["finance-intraday-paper-receipt"]),
        }),
        expect.objectContaining({
          id: "finance_automatic_paper_trading_waterflow",
          feedbackEdgeCount: 4,
          requiredFilters: expect.arrayContaining([
            "llm_proposes_ts_gate_approves",
            "single_finance_scheduler_owner_required",
            "paper_venue_only_for_autonomous_cycle",
            "night_feedback_requires_scored_outcomes",
            "deterministic_promotion_gate_required",
          ]),
          receipts: expect.arrayContaining([
            "lcx-finance-research-run-latest",
            "finance-portfolio-plan",
            "daily-cycle-runs",
            "research-scored",
            "tuning-proposals",
          ]),
        }),
        expect.objectContaining({
          id: "external_finance_research_waterflow",
          requiredFilters: expect.arrayContaining([
            "source_evidence_gate",
            "no_trade_advice",
            "no_unverified_current_market_data",
          ]),
        }),
        expect.objectContaining({
          id: "directed_daily_research_brief_waterflow",
          feedbackEdgeCount: 2,
          receipts: expect.arrayContaining(["lcx-directed-daily-research-brief-latest"]),
          requiredFilters: expect.arrayContaining([
            "focused_daily_product_required",
            "daily_research_packet_required",
            "candidate_watchlist_not_trade_recommendation",
            "fresh_timestamp_required",
            "field_definition_required",
            "no_trade_advice",
          ]),
        }),
        expect.objectContaining({
          id: "module_learning_internalization_waterflow",
          requiredFilters: expect.arrayContaining([
            "stored_only_is_not_learning",
            "retrieval_apply_eval_review_required",
          ]),
        }),
        expect.objectContaining({
          id: "training_failure_feedback_waterflow",
          feedbackEdgeCount: 3,
          requiredFilters: expect.arrayContaining([
            "training_overlap_guard",
            "work_then_evolve_cooldown_required",
            "parse_recovered_no_promotion",
            "promotion_ready_required",
          ]),
        }),
        expect.objectContaining({
          id: "local_to_external_channel_external_waterflow",
          requiredFilters: expect.arrayContaining([
            "local_ready_not_user_visible_observed",
            "external_channel_probe_required",
            "real_external_inbound_required",
          ]),
        }),
        expect.objectContaining({
          id: "skillopt_runtime_self_use_waterflow",
          feedbackEdgeCount: 2,
          receipts: expect.arrayContaining([
            "lcx-skillopt-lite",
            "skillopt-autocue",
            "lcx-external-channel-binding",
          ]),
          requiredFilters: expect.arrayContaining([
            "skillopt_best_skill_required",
            "skillopt_context_not_weight_absorption",
            "skillopt_external_channel_proof_required",
            "local_ready_not_user_visible_observed",
            "external_channel_probe_required",
            "real_external_inbound_required",
          ]),
        }),
        expect.objectContaining({
          id: "universe_index_total_coverage_waterflow",
          receipts: expect.arrayContaining([
            "lcx-universe-index-latest",
            "lcx-change-impact-plan",
            "lcx-governance-autopilot-latest",
          ]),
          requiredFilters: expect.arrayContaining([
            "inventory_only_no_delete",
            "owner_coverage_required",
            "artifact_staleness_visible",
            "single_owner_required",
            "protected_memory_guard",
            "no_provider_config_change",
            "no_external_channel_sender_change",
          ]),
        }),
        expect.objectContaining({
          id: "external_visible_language_waterflow",
          requiredFilters: expect.arrayContaining([
            "visible_text_no_internal_labels",
            "no_internal_runtime_details_visible",
            "bounded_answer_review",
            "reply_flow_audit_required",
          ]),
        }),
        expect.objectContaining({
          id: "commercial_answer_pipeline_waterflow",
          feedbackEdgeCount: 2,
          receipts: expect.arrayContaining(["commercial_answer_pipeline", "review_panel"]),
          requiredFilters: expect.arrayContaining([
            "candidate_answer_not_final_authority",
            "minimax_agent_draft_not_final_authority",
            "minimax_agent_output_requires_lcx_gate",
            "qwen_challenger_not_final_authority",
            "terminal_decision_required",
            "no_raw_json_visible_reply",
            "no_internal_runtime_details_visible",
            "stored_only_is_not_learning",
            "retrieval_apply_eval_review_required",
          ]),
        }),
        expect.objectContaining({
          id: "provider_council_evidence_waterflow",
          requiredFilters: expect.arrayContaining([
            "provider_evidence_required",
            "no_provider_config_change",
          ]),
        }),
        expect.objectContaining({
          id: "commercial_acceptance_harness_waterflow",
          feedbackEdgeCount: 2,
          receipts: expect.arrayContaining([
            "commercial_acceptance_harness",
            "lcx-problem-cluster-radar",
            "external-message-channel",
          ]),
          requiredFilters: expect.arrayContaining([
            "commercial_error_budget_required",
            "product_canary_suite_required",
            "single_owner_required",
            "real_external_inbound_required",
          ]),
        }),
        expect.objectContaining({
          id: "memory_correction_downrank_waterflow",
          requiredFilters: expect.arrayContaining([
            "memory_write_freshness_gate",
            "protected_memory_guard",
          ]),
        }),
        expect.objectContaining({
          id: "self_repair_hands_waterflow",
          receipts: expect.arrayContaining([
            "lcx-self-repair-hands-latest",
            "lcx-governance-autopilot-latest",
            "lcx-owner-control-map-latest",
          ]),
          requiredFilters: expect.arrayContaining([
            "self_repair_write_allowlist_required",
            "explicit_self_repair_write_flag_required",
            "training_candidate_not_absorbed",
            "protected_memory_guard",
            "training_overlap_guard",
            "model_weight_absorption_not_claimed",
          ]),
        }),
        expect.objectContaining({
          id: "finance_data_gateway_waterflow",
          requiredFilters: expect.arrayContaining([
            "fresh_timestamp_required",
            "field_definition_required",
            "three_source_reconciliation_required",
            "conflicted_data_blocks_conclusion",
          ]),
        }),
        expect.objectContaining({
          id: "senior_trader_failure_focus_waterflow",
          requiredFilters: expect.arrayContaining([
            "fresh_timestamp_required",
            "retrieval_apply_eval_review_required",
            "work_then_evolve_cooldown_required",
            "parse_recovered_no_promotion",
            "promotion_ready_required",
          ]),
        }),
        expect.objectContaining({
          id: "similar_engineering_consolidation_waterflow",
          requiredFilters: expect.arrayContaining([
            "prior_work_reuse_required",
            "same_philosophy_merge_required",
            "single_owner_required",
          ]),
        }),
        expect.objectContaining({
          id: "external_agent_skill_distillation_waterflow",
          receipts: expect.arrayContaining(["lcx-external-agent-upgrade-radar"]),
          requiredFilters: expect.arrayContaining([
            "license_scope_required",
            "untrusted_source_isolation",
            "blacktech_is_pattern_intake_only",
            "runtime_authority_not_granted",
            "model_weight_absorption_not_claimed",
            "tool_permission_audit_required",
          ]),
        }),
        expect.objectContaining({
          id: "multi_agent_pattern_shadow_evaluation_waterflow",
          requiredFilters: expect.arrayContaining([
            "same_case_required",
            "replay_before_isolated_executor_required",
            "shadow_tool_permission_audit_required",
            "no_shadow_external_side_effects",
            "shadow_recovery_receipt_required",
            "wide_trial_not_production",
          ]),
          receipts: expect.arrayContaining(["lcx-multi-agent-pattern-shadow"]),
        }),
        expect.objectContaining({
          id: "logical_agent_pool_waterflow",
          requiredFilters: expect.arrayContaining([
            "logical_agent_task_identity_snapshot_required",
            "logical_agent_pool_timeout_required",
            "logical_agent_capability_boundary_required",
            "logical_agent_config_immutable_required",
            "logical_agent_terminal_sink_required",
            "no_logical_agent_external_side_effects",
          ]),
          receipts: expect.arrayContaining(["logical-agent-pool"]),
        }),
        expect.objectContaining({
          id: "prediction_market_research_only_waterflow",
          receipts: expect.arrayContaining([
            "lcx-external-agent-upgrade-radar",
            "finance-data-gateway",
            "strategy_experiment_audit",
          ]),
          requiredFilters: expect.arrayContaining([
            "research_only_boundary",
            "no_trade_advice",
            "no_wallet_or_order_execution",
            "market_microstructure_warning_required",
            "paper_only_backtest_required",
            "thin_liquidity_downrank_required",
            "ambiguous_resolution_blocks_conclusion",
            "fees_slippage_and_sample_out_required",
          ]),
        }),
        expect.objectContaining({
          id: "automation_repair_lock_waterflow",
          requiredFilters: expect.arrayContaining([
            "automation_schedule_gate",
            "repair_lock_required",
          ]),
        }),
      ]),
    );
    expect(payload.consolidationClusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_cluster",
          ownerScenario: "compressed_context_recovery_waterflow",
          mergeFilters: expect.arrayContaining([
            "same_philosophy_merge_required",
            "single_owner_required",
          ]),
        }),
        expect.objectContaining({
          id: "universe_inventory_cluster",
          ownerScenario: "universe_index_total_coverage_waterflow",
          mergeFilters: expect.arrayContaining([
            "inventory_only_no_delete",
            "owner_coverage_required",
            "single_owner_required",
          ]),
        }),
        expect.objectContaining({
          id: "learning_internalization_cluster",
          ownerScenario: "module_learning_internalization_waterflow",
        }),
        expect.objectContaining({
          id: "finance_data_quality_cluster",
          ownerScenario: "finance_data_gateway_waterflow",
          mergeFilters: expect.arrayContaining([
            "three_source_reconciliation_required",
            "conflicted_data_blocks_conclusion",
          ]),
        }),
        expect.objectContaining({
          id: "commercial_answer_pipeline_cluster",
          ownerScenario: "commercial_answer_pipeline_waterflow",
          mergeFilters: expect.arrayContaining([
            "candidate_answer_not_final_authority",
            "terminal_decision_required",
          ]),
        }),
        expect.objectContaining({
          id: "focused_daily_research_product_cluster",
          ownerScenario: "directed_daily_research_brief_waterflow",
          mergeFilters: expect.arrayContaining([
            "focused_daily_product_required",
            "daily_research_packet_required",
            "candidate_watchlist_not_trade_recommendation",
            "single_owner_required",
          ]),
        }),
        expect.objectContaining({
          id: "commercial_acceptance_harness_cluster",
          ownerScenario: "commercial_acceptance_harness_waterflow",
          mergeFilters: expect.arrayContaining([
            "commercial_error_budget_required",
            "product_canary_suite_required",
            "single_owner_required",
          ]),
        }),
        expect.objectContaining({
          id: "senior_trader_failure_focus_cluster",
          ownerScenario: "senior_trader_failure_focus_waterflow",
          mergeFilters: expect.arrayContaining([
            "retrieval_apply_eval_review_required",
            "promotion_ready_required",
          ]),
        }),
      ]),
    );
    expect(payload.consolidatedEntrypointFamilies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_entrypoints",
          ownerCluster: "architecture_supervision_cluster",
          ownerPath: "scripts/operator/lcx-mind-model.ts",
          watchedPathTerms: expect.arrayContaining([
            "lcx-flow-graph",
            "lcx-head-tail-consistency",
            "lcx-universe-index",
          ]),
        }),
        expect.objectContaining({
          id: "universe_inventory_entrypoints",
          ownerCluster: "universe_inventory_cluster",
          ownerPath: "scripts/operator/lcx-universe-index.ts",
          watchedPathTerms: expect.arrayContaining(["lcx-universe-index", "garbageCandidates"]),
          allowedPaths: expect.arrayContaining([
            "scripts/operator/lcx-universe-index.ts",
            "test/lcx-universe-index.test.ts",
            "test/lcx-universe-index-source.test.ts",
          ]),
        }),
        expect.objectContaining({
          id: "learning_sedimentation_entrypoints",
          ownerCluster: "learning_internalization_cluster",
          watchedPathTerms: expect.arrayContaining(["module-learning", "learning-sedimentation"]),
        }),
        expect.objectContaining({
          id: "external_visible_reply_audit_entrypoints",
          ownerCluster: "commercial_answer_pipeline_cluster",
          watchedPathTerms: expect.arrayContaining([
            "reply-flow-audit",
            "commercial-answer",
            "visible-answer-adoption",
            "skill-autocue",
            "skillopt-autocue",
          ]),
          allowedPaths: expect.arrayContaining([
            "src/agents/visible-answer-adoption-gate.ts",
            "src/agents/visible-answer-adoption-gate.test.ts",
            "src/auto-reply/reply/skill-autocue.ts",
            "src/auto-reply/reply/skill-autocue.test.ts",
            "src/auto-reply/reply/skillopt-autocue.ts",
            "src/auto-reply/reply/skillopt-autocue.test.ts",
          ]),
        }),
        expect.objectContaining({
          id: "commercial_acceptance_harness_entrypoints",
          ownerCluster: "commercial_acceptance_harness_cluster",
          ownerPath: "scripts/operator/lcx-commercial-acceptance-harness.ts",
          watchedPathTerms: expect.arrayContaining(["commercial-acceptance"]),
        }),
        expect.objectContaining({
          id: "qwen_training_operation_entrypoints",
          ownerCluster: "senior_trader_failure_focus_cluster",
          watchedPathTerms: expect.arrayContaining([
            "local-brain-training-plan",
            "minimax-quota-brain-saturator",
          ]),
        }),
        expect.objectContaining({
          id: "automation_digest_entrypoints",
          ownerCluster: "automation_digest_cluster",
          watchedPathTerms: expect.arrayContaining(["automation-repair"]),
        }),
        expect.objectContaining({
          id: "external_skill_learning_entrypoints",
          ownerCluster: "external_skill_learning_cluster",
          ownerPath: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
          watchedPathTerms: expect.arrayContaining([
            "external-agent-upgrade",
            "github-project-capability-intake",
          ]),
          allowedPaths: expect.arrayContaining([
            "scripts/operator/lcx-external-agent-upgrade-radar.ts",
            "src/agents/tools/github-project-capability-intake-tool.ts",
          ]),
        }),
        expect.objectContaining({
          id: "finance_data_quality_entrypoints",
          ownerCluster: "finance_data_quality_cluster",
          watchedPathTerms: expect.arrayContaining(["finance-data-gateway"]),
        }),
        expect.objectContaining({
          id: "focused_daily_research_product_entrypoints",
          ownerCluster: "focused_daily_research_product_cluster",
          ownerPath: "scripts/operator/lcx-directed-daily-research-brief.ts",
          allowedPaths: expect.arrayContaining([
            "scripts/operator/lcx-directed-daily-research-brief.ts",
            "test/lcx-directed-daily-research-brief.test.ts",
          ]),
        }),
      ]),
    );
    expect(payload.sharedEntrypointOwnerRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "test/lcx-universe-index-source.test.ts",
          familyIds: expect.arrayContaining([
            "architecture_supervision_entrypoints",
            "universe_inventory_entrypoints",
          ]),
        }),
        expect.objectContaining({
          path: "scripts/operator/lcx-external-channel-status.ts",
          familyIds: expect.arrayContaining([
            "local_live_evidence_entrypoints",
            "external_visible_reply_audit_entrypoints",
          ]),
        }),
      ]),
    );
    expect(payload.diagnosticIndex).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "module_learning_internalization_waterflow",
          ownerEntrypoint: "scripts/operator/module-learning-pipeline-review.ts",
          fastCheck: "node --import tsx scripts/operator/module-learning-pipeline-review.ts --json",
          evidenceReceipts: expect.arrayContaining(["module_learning_pipeline_review"]),
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:retrieval_apply_eval_review_required",
          ]),
          boundary: "local_flow_graph_only",
        }),
        expect.objectContaining({
          scenarioId: "training_failure_feedback_waterflow",
          ownerEntrypoint: "scripts/operator/local-brain-training-plan.ts",
          fastCheck: "node --import tsx scripts/operator/local-brain-training-plan.ts --json",
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:training_overlap_guard",
            "missing_or_skipped_filter:work_then_evolve_cooldown_required",
            "unbounded_or_unreviewed_feedback",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "skillopt_runtime_self_use_waterflow",
          ownerEntrypoint: "scripts/operator/lcx-skillopt-lite.ts",
          fastCheck:
            "node --import tsx scripts/operator/lcx-skillopt-lite.ts --phase candidate-edit --no-write --json",
          evidenceReceipts: expect.arrayContaining([
            "lcx-skillopt-lite",
            "skillopt-autocue",
            "lcx-external-channel-binding",
          ]),
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:skillopt_context_not_weight_absorption",
            "missing_or_skipped_filter:skillopt_external_channel_proof_required",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "universe_index_total_coverage_waterflow",
          ownerEntrypoint: "scripts/operator/lcx-universe-index.ts",
          fastCheck: "node --import tsx scripts/operator/lcx-universe-index.ts --json",
          evidenceReceipts: expect.arrayContaining(["lcx-universe-index-latest"]),
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:inventory_only_no_delete",
            "missing_or_skipped_filter:owner_coverage_required",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "commercial_answer_pipeline_waterflow",
          ownerEntrypoint: "scripts/operator/lcx-commercial-answer-pipeline.ts",
          fastCheck: "node --import tsx scripts/operator/lcx-commercial-answer-pipeline.ts --json",
          evidenceReceipts: expect.arrayContaining(["commercial_answer_pipeline"]),
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:candidate_answer_not_final_authority",
            "missing_or_skipped_filter:terminal_decision_required",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "directed_daily_research_brief_waterflow",
          ownerEntrypoint: "scripts/operator/lcx-directed-daily-research-brief.ts",
          fastCheck:
            "node --import tsx scripts/operator/lcx-directed-daily-research-brief.ts --json",
          evidenceReceipts: expect.arrayContaining(["lcx-directed-daily-research-brief-latest"]),
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:focused_daily_product_required",
            "missing_or_skipped_filter:daily_research_packet_required",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "commercial_acceptance_harness_waterflow",
          ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
          fastCheck:
            "node --import tsx scripts/operator/lcx-commercial-acceptance-harness.ts --json",
          evidenceReceipts: expect.arrayContaining(["commercial_acceptance_harness"]),
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:commercial_error_budget_required",
            "missing_or_skipped_filter:product_canary_suite_required",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "self_repair_hands_waterflow",
          ownerEntrypoint: "scripts/operator/lcx-self-repair-hands.ts",
          fastCheck: "node --import tsx scripts/operator/lcx-self-repair-hands.ts --json",
          evidenceReceipts: expect.arrayContaining([
            "lcx-self-repair-hands-latest",
            "lcx-owner-control-map-latest",
          ]),
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:self_repair_write_allowlist_required",
            "missing_or_skipped_filter:training_candidate_not_absorbed",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "external_agent_skill_distillation_waterflow",
          ownerEntrypoint: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
          fastCheck:
            "node --import tsx scripts/operator/lcx-external-agent-upgrade-radar.ts --json",
          evidenceReceipts: expect.arrayContaining(["lcx-external-agent-upgrade-radar"]),
        }),
        expect.objectContaining({
          scenarioId: "multi_agent_pattern_shadow_evaluation_waterflow",
          ownerEntrypoint: "scripts/operator/lcx-multi-agent-pattern-shadow.ts",
          fastCheck:
            "node --import tsx scripts/operator/lcx-multi-agent-pattern-shadow.ts --mode replay --pattern all --case single_stock_loss_recovery_risk_triage --json",
          evidenceReceipts: expect.arrayContaining(["lcx-multi-agent-pattern-shadow"]),
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:same_case_required",
            "missing_or_skipped_filter:shadow_recovery_receipt_required",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "prediction_market_research_only_waterflow",
          ownerEntrypoint: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
          fastCheck:
            "node --import tsx scripts/operator/lcx-external-agent-upgrade-radar.ts --json",
          evidenceReceipts: expect.arrayContaining([
            "lcx-external-agent-upgrade-radar",
            "finance-data-gateway",
          ]),
          failureSignals: expect.arrayContaining([
            "missing_or_skipped_filter:no_wallet_or_order_execution",
            "missing_or_skipped_filter:market_microstructure_warning_required",
          ]),
        }),
      ]),
    );
  });

  it("is visible from doctor, mind model, head-tail, and runbook surfaces", async () => {
    const [doctorSource, mindModelSource, headTailSource, architectureMap, runbook] =
      await Promise.all([
        fs.readFile(path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"), "utf8"),
        fs.readFile(path.join(repoRoot, "scripts/operator/lcx-mind-model.ts"), "utf8"),
        fs.readFile(path.join(repoRoot, "scripts/operator/lcx-head-tail-consistency.ts"), "utf8"),
        fs.readFile(path.join(repoRoot, "ops/architecture/LCX-SYSTEM-ARCHITECTURE.md"), "utf8"),
        fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
      ]);

    expect(doctorSource).toContain('name: "flow-graph-exam"');
    expect(doctorSource).toContain("scripts/operator/lcx-flow-graph.ts");
    expect(mindModelSource).toContain("flow_graph");
    expect(headTailSource).toContain("flow_graph_boundary");
    expect(architectureMap).toContain("LCX Agent Flow Graph");
    expect(architectureMap).toContain("LCX Agent Universe Index Doctrine");
    expect(architectureMap).toContain("wrong-flow");
    expect(architectureMap).toContain("same_philosophy_merge_required");
    expect(architectureMap).toContain("finance_data_gateway_snapshot");
    expect(runbook).toContain("LCX Agent Flow Graph");
    expect(runbook).toContain("flow_graph_exam");
    expect(runbook).toContain("same-philosophy");
    expect(runbook).toContain("finance_data_gateway_snapshot");
  });
});
