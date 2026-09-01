import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
    };

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_flow_graph_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary.total).toBeGreaterThanOrEqual(8);
    expect(payload.summary.scenarios).toBeGreaterThanOrEqual(16);
    expect(payload.summary.nodes).toBeGreaterThanOrEqual(70);
    expect(payload.summary.filters).toBeGreaterThanOrEqual(35);
    expect(payload.summary.consolidationClusters).toBeGreaterThanOrEqual(9);
    expect(payload.summary.consolidatedEntrypointFamilies).toBeGreaterThanOrEqual(9);
    expect(payload.summary.sharedEntrypointOwnerRules).toBeGreaterThanOrEqual(2);
    expect(payload.summary.diagnosticEntries).toBe(payload.summary.scenarios);
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
          id: "lark_finance_research_waterflow",
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
          id: "dev_to_external_channel_lark_waterflow",
          requiredFilters: expect.arrayContaining([
            "dev_ready_not_user_visible_observed",
            "external_channel_probe_required",
            "real_lark_inbound_required",
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
            "dev_ready_not_user_visible_observed",
            "external_channel_probe_required",
            "real_lark_inbound_required",
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
          id: "lark_visible_language_waterflow",
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
            "feishu-reply-flow",
          ]),
          requiredFilters: expect.arrayContaining([
            "commercial_error_budget_required",
            "product_canary_suite_required",
            "single_owner_required",
            "real_lark_inbound_required",
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
          ]),
        }),
        expect.objectContaining({
          id: "learning_sedimentation_entrypoints",
          ownerCluster: "learning_internalization_cluster",
          watchedPathTerms: expect.arrayContaining(["module-learning", "learning-sedimentation"]),
        }),
        expect.objectContaining({
          id: "lark_visible_reply_audit_entrypoints",
          ownerCluster: "commercial_answer_pipeline_cluster",
          watchedPathTerms: expect.arrayContaining([
            "reply-flow-audit",
            "commercial-answer",
            "visible-answer-adoption",
            "skill-autocue",
            "skillopt-autocue",
          ]),
          allowedPaths: expect.arrayContaining([
            "extensions/feishu/src/visible-answer-adoption-gate.ts",
            "extensions/feishu/src/visible-answer-adoption-gate.test.ts",
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
          path: "src/commands/capabilities/lark-loop-diagnose.ts",
          familyIds: expect.arrayContaining([
            "dev_live_evidence_entrypoints",
            "lark_visible_reply_audit_entrypoints",
          ]),
        }),
        expect.objectContaining({
          path: "src/commands/capabilities.lark-loop-diagnose.test.ts",
          familyIds: expect.arrayContaining([
            "dev_live_evidence_entrypoints",
            "lark_visible_reply_audit_entrypoints",
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
          boundary: "dev_flow_graph_only",
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
    const [doctorSource, mindModelSource, headTailSource, agents, runbook] = await Promise.all([
      fs.readFile(path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/operator/lcx-mind-model.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/operator/lcx-head-tail-consistency.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "AGENTS.md"), "utf8"),
      fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
    ]);

    expect(doctorSource).toContain('name: "flow-graph-exam"');
    expect(doctorSource).toContain("scripts/operator/lcx-flow-graph.ts");
    expect(mindModelSource).toContain("flow_graph");
    expect(headTailSource).toContain("flow_graph_boundary");
    expect(agents).toContain("LCX Agent Flow Graph");
    expect(agents).toContain("LCX Agent Universe Index Doctrine");
    expect(agents).toContain("wrong-flow");
    expect(agents).toContain("same_philosophy_merge_required");
    expect(agents).toContain("finance_data_gateway_snapshot");
    expect(runbook).toContain("LCX Agent Flow Graph");
    expect(runbook).toContain("flow_graph_exam");
    expect(runbook).toContain("same-philosophy");
    expect(runbook).toContain("finance_data_gateway_snapshot");
  });
});
