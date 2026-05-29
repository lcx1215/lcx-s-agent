import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeGuardEvolutionCooldownSnapshot,
  buildLocalBrainTrainingPlan,
  buildQwenBaseModelMigrationPlan,
} from "../scripts/dev/local-brain-training-plan.js";

async function writeJsonl(prefix: string, lines: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const logPath = path.join(dir, "events.jsonl");
  await fs.writeFile(logPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return logPath;
}

async function writeJson(
  workspaceDir: string,
  relativePath: string,
  payload: unknown,
): Promise<void> {
  const targetPath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

describe("local-brain-training-plan", () => {
  it("detects an active guard launched before the evolution cooldown flag", () => {
    expect(
      activeGuardEvolutionCooldownSnapshot([
        {
          pid: 101,
          command: "node --import tsx scripts/dev/minimax-brain-training-guard.ts",
          role: "guard",
        },
      ]),
    ).toMatchObject({
      boundary: "dev_active_guard_evolution_cooldown_only",
      activeGuardCount: 1,
      activeGuardHasEvolutionCooldown: false,
      guardsMissingCooldownFlag: 1,
      missingCooldownPids: [101],
      action: "do_not_restart_current_guard_wait_for_next_launchd_start",
    });

    expect(
      activeGuardEvolutionCooldownSnapshot([
        {
          pid: 102,
          command:
            "node --import tsx scripts/dev/minimax-brain-training-guard.ts --evolution-cooldown-minutes 10",
          role: "guard",
        },
      ]),
    ).toMatchObject({
      activeGuardCount: 1,
      activeGuardHasEvolutionCooldown: true,
      guardsMissingCooldownFlag: 0,
      action: "cooldown_flag_present_or_no_active_guard",
    });
  });

  it("blocks Qwen 1.7B migration probes while training is active", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-qwen-migration-home-"));
    const cacheDir = path.join(homeDir, ".cache/huggingface/hub/models--Qwen--Qwen3-1.7B");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "model.safetensors"), "fake");

    try {
      const plan = await buildQwenBaseModelMigrationPlan({
        homeDir,
        machineMemoryBytes: 8 * 1024 * 1024 * 1024,
        activeHeavyEvalCounts: {
          localBrainEval: 1,
          externalLocalBrainEval: 0,
          mlx: 1,
        },
        activeProcesses: [
          {
            pid: 101,
            command: "node --import tsx scripts/dev/minimax-brain-training-guard.ts",
            role: "guard",
          },
          {
            pid: 102,
            ppid: 101,
            command: "node --import tsx scripts/dev/local-brain-distill-eval.ts",
            role: "local_brain_eval",
          },
        ],
      });

      expect(plan).toMatchObject({
        boundary: "dev_qwen_base_model_migration_plan_only",
        currentModel: "Qwen/Qwen3-0.6B",
        candidateModel: "Qwen/Qwen3-1.7B",
        candidateCached: true,
        activeTrainingProcessCount: 2,
        decision: "blocked_training_active",
        action: "wait_for_current_guard_eval_and_mlx_to_finish",
      });
      expect(plan.allowedNextCommand).toBeUndefined();
      expect(plan.forbiddenWhileActive).toContain(
        "do_not_start_qwen_1_7b_smoke_while_guard_active",
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("reports guard-only Qwen migration blocking without implying eval or teacher work", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-qwen-migration-home-"));
    const cacheDir = path.join(homeDir, ".cache/huggingface/hub/models--Qwen--Qwen3-1.7B");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "model.safetensors"), "fake");

    try {
      const plan = await buildQwenBaseModelMigrationPlan({
        homeDir,
        machineMemoryBytes: 8 * 1024 * 1024 * 1024,
        activeHeavyEvalCounts: {
          localBrainEval: 0,
          externalLocalBrainEval: 0,
          mlx: 0,
        },
        activeProcesses: [
          {
            pid: 101,
            command: "node --import tsx scripts/dev/minimax-brain-training-guard.ts",
            role: "guard",
          },
        ],
      });

      expect(plan).toMatchObject({
        candidateCached: true,
        activeTrainingProcessCount: 1,
        decision: "blocked_training_active",
        action: "wait_for_current_guard_to_finish",
      });
      expect(plan.allowedNextCommand).toBeUndefined();
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("only makes Qwen 1.7B smoke available when cached and idle", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-qwen-migration-home-"));
    const cacheDir = path.join(homeDir, ".cache/huggingface/hub/models--Qwen--Qwen3-1.7B");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "model.safetensors"), "fake");

    try {
      const plan = await buildQwenBaseModelMigrationPlan({
        homeDir,
        machineMemoryBytes: 8 * 1024 * 1024 * 1024,
        activeHeavyEvalCounts: {
          localBrainEval: 0,
          externalLocalBrainEval: 0,
          mlx: 0,
        },
        activeProcesses: [],
      });

      expect(plan).toMatchObject({
        candidateCached: true,
        activeTrainingProcessCount: 0,
        decision: "ready_for_no_adapter_smoke",
        action: "run_no_adapter_smoke_before_any_lora_training",
      });
      expect(plan.allowedNextCommand).toContain("--no-adapter");
      expect(plan.allowedNextCommand).toContain("--model Qwen/Qwen3-1.7B");
      expect(plan.notes.join("\n")).toContain("adapters cannot be directly reused");
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("turns eval output-contract failures into a Codex repair decision", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
      {
        at: "2026-05-09T10:01:00.000Z",
        event: "step_non_passing",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r1",
          summary: {
            passed: 61,
            total: 64,
            passRate: 0.953,
            failedCaseIds: ["anthropic_financial_agent_pattern_distillation"],
            parseErrorCaseIds: ["anthropic_financial_agent_pattern_distillation"],
            promotionReady: false,
          },
          cases: [
            {
              id: "anthropic_financial_agent_pattern_distillation",
              parseError:
                "no JSON object found in model output: { primary_modules: [finance_framework_macro_rates_inflation",
            },
          ],
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", [
      {
        at: "2026-05-09T10:02:00.000Z",
        event: "step_ok",
        name: "minimax_teacher_batch",
        result: { acceptedCandidates: 36, failures: [], providerSkippedPromptIds: [] },
      },
    ]);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.boundary).toBe("dev_local_brain_training_plan_only");
    expect(plan.latestEval).toMatchObject({
      passed: 61,
      total: 64,
      promotionReady: false,
      parseErrorCaseIds: ["anthropic_financial_agent_pattern_distillation"],
    });
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "output_contract_or_parser_failure",
          codexRepairEligible: true,
          lane: "dev_acceptance",
        }),
        expect.objectContaining({
          id: "eval_not_promotion_ready",
          action: "continue_failure_focus_teacher_and_hold_promotion",
        }),
      ]),
    );
    expect(plan.codexAutoRepair).toMatchObject({
      eligible: true,
      repairDecisionIds: ["output_contract_or_parser_failure"],
    });
    expect(plan.liveTouched).toBe(false);
    expect(plan.providerConfigTouched).toBe(false);
  });

  it("routes teacher JSON failures to the teacher quality lane", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
      {
        at: "2026-05-09T10:01:00.000Z",
        event: "step_ok",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r2",
          summary: {
            passed: 64,
            total: 64,
            passRate: 1,
            failedCaseIds: [],
            promotionReady: true,
          },
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", [
      {
        at: "2026-05-09T10:02:00.000Z",
        event: "step_failed",
        name: "minimax_teacher_batch",
        result: {
          acceptedCandidates: 35,
          failures: [
            {
              id: "failure_focus_commodity_fx_inflation_inventory_portfolio_loop_00145",
              error: "SyntaxError: Expected ',' or ']' after array element in JSON",
            },
          ],
          providerSkippedPromptIds: [],
        },
      },
    ]);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "teacher_sample_quality_failure",
          lane: "teacher_quality",
          codexRepairEligible: true,
        }),
        expect.objectContaining({
          id: "promotion_candidate_ready",
          lane: "promotion_audit",
        }),
      ]),
    );
    expect(plan.codexAutoRepair).toMatchObject({
      eligible: true,
      repairDecisionIds: ["teacher_sample_quality_failure"],
    });
  });

  it("keeps latest passing eval separate from a newer non-promoted candidate", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
      {
        at: "2026-05-09T10:01:00.000Z",
        event: "step_ok",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r2",
          summary: {
            passed: 72,
            total: 72,
            passRate: 1,
            failedCaseIds: [],
            parseErrorCaseIds: [],
            promotionReady: true,
          },
        },
      },
      {
        at: "2026-05-09T10:02:00.000Z",
        event: "step_non_passing",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r8",
          summary: {
            passed: 72,
            total: 72,
            passRate: 1,
            failedCaseIds: [],
            parseErrorCaseIds: [],
            parseRecoveredCaseIds: ["plain_recent_stock_market_brief_preflight"],
            promotionReady: false,
          },
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.latestEval).toMatchObject({
      name: "candidate_hardened_eval",
      adapterPath: "/tmp/adapter-r8",
      promotionReady: false,
      parseRecoveredCaseIds: ["plain_recent_stock_market_brief_preflight"],
    });
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "eval_not_promotion_ready",
          reason: expect.stringContaining(
            "parseRecovered=plain_recent_stock_market_brief_preflight",
          ),
        }),
      ]),
    );
    expect(plan.latestPassingEval).toMatchObject({
      name: "stable_hardened_eval",
      adapterPath: "/tmp/adapter-r2",
      promotionReady: true,
    });
    expect(plan.latestStableEval).toMatchObject({
      name: "stable_hardened_eval",
      adapterPath: "/tmp/adapter-r2",
      promotionReady: true,
    });
    expect(plan.latestCandidateEval).toMatchObject({
      name: "candidate_hardened_eval",
      adapterPath: "/tmp/adapter-r8",
      promotionReady: false,
    });
    expect(plan.qwenCapabilityConsolidation).toMatchObject({
      boundary: "dev_qwen_capability_consolidation_only",
      runtimeAdapterPolicy: "single_clean_adapter_only_no_dirty_ensemble",
      adapterLadderPolicy: "champion_challenger_harvest_into_next_single_adapter",
      capabilityIntegrationMode: "teacher_dataset_eval_promotion_into_one_clean_adapter",
      consolidationState: "candidate_capabilities_not_yet_consolidated",
      selectedCleanAdapter: "/tmp/adapter-r2",
      cleanCandidateAdapterCount: 0,
      blockedCandidateAdapterCount: 1,
      requiredAction: "continue_failure_focus_until_next_clean_unified_adapter",
      blockedCapabilityFamilies: [
        { caseId: "plain_recent_stock_market_brief_preflight", count: 1 },
      ],
      monotonicIntelligenceGuard: {
        boundary: "dev_qwen_monotonic_intelligence_guard_only",
        guaranteeLevel: "runtime_monotonic_not_every_training_round",
        runtimeInvariant: "never_replace_clean_champion_with_dirty_or_parse_recovered_challenger",
        promotionInvariant: "new_runtime_requires_clean_full_hardened_eval_and_promotion_audit",
        challengerPolicy: "harvest_failures_into_teacher_curriculum_until_clean",
        currentRuntimeStatus: "clean_champion_serving",
        latestChallengerStatus: "blocked_and_harvested",
        noRegressionGate: true,
        nextProofRequired: "targeted_eval_clean_then_full_hardened_eval_then_promotion_audit",
      },
    });
    expect(plan.qwenCapabilityConsolidation.adapterLadder).toMatchObject({
      champion: {
        adapterPath: "/tmp/adapter-r2",
        runtimeEligible: true,
      },
      latestBlockedChallenger: {
        adapterPath: "/tmp/adapter-r8",
        runtimeEligible: false,
      },
    });
    expect(plan.qwenCapabilityConsolidation.capabilityHarvest).toMatchObject({
      boundary: "dev_blocked_challenger_harvest_only",
      harvestMode: "failed_or_parse_recovered_cases_to_teacher_curriculum",
      sourceBlockedAdapter: "/tmp/adapter-r8",
      harvestCaseIds: ["plain_recent_stock_market_brief_preflight"],
      nextTeacherFocusCaseIds: ["plain_recent_stock_market_brief_preflight"],
      accelerationMode: "targeted_eval_then_full_hardened_eval",
      targetedEvalFirstCaseIds: ["plain_recent_stock_market_brief_preflight"],
      targetedEvalCommand: expect.stringContaining(
        "--case-id plain_recent_stock_market_brief_preflight",
      ),
      fullEvalGate: "run_full_hardened_eval_only_after_targeted_cases_are_clean",
      notPromotionProof: true,
      requiredNextStep:
        "feed_harvested_cases_to_failure_focus_teacher_then_run_targeted_eval_before_full_eval",
    });
    expect(plan.evolutionAccelerationQueue).toMatchObject({
      boundary: "dev_evolution_acceleration_queue_only",
      objective: "shorten_safe_feedback_loop_without_overlapping_training",
      activeTrainingOrEval: false,
      canStartHeavyWorkNow: true,
      fastestSafeNextAction: "targeted_challenger_eval_first",
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: "targeted_challenger_eval_first",
          lane: "adapter_promotion",
          status: "ready_when_idle",
          executionClass: "idle_only_heavy_eval",
          command: expect.stringContaining("--case-id plain_recent_stock_market_brief_preflight"),
        }),
        expect.objectContaining({
          id: "keep_clean_champion_runtime",
          status: "informational",
        }),
      ]),
    });
    expect(plan.activeHeavyEvalCounts).toEqual({
      localBrainEval: 0,
      externalLocalBrainEval: 0,
      mlx: 0,
    });
    expect(plan.overlappingHeavyEval).toBe(false);
  });

  it("surfaces MiniMax quota completion as normal idle instead of provider failure", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", [
      {
        at: "2026-05-09T10:01:00.000Z",
        event: "quota_saturator_start",
        plan: { targetCalls: 900 },
      },
      {
        at: "2026-05-09T13:41:00.000Z",
        event: "quota_saturator_complete",
        attempted: 900,
        completedRounds: 25,
        stopReason: "target_calls_reached",
        finalBatchLimit: 36,
        finalConcurrency: 8,
      },
    ]);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.latestQuotaStatus).toMatchObject({
      event: "quota_saturator_complete",
      active: false,
      stopReason: "target_calls_reached",
      attempted: 900,
      completedRounds: 25,
    });
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "teacher_quota_target_reached",
          action: "do_not_treat_minimax_idle_as_provider_failure",
        }),
      ]),
    );
  });

  it("surfaces guard evolution cooldown as a first-class pause window", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
      {
        at: "2026-05-09T10:05:00.000Z",
        event: "evolution_cooldown",
        round: 2,
        durationMs: 600000,
        requestedDurationMs: 600000,
        reason: "work_then_evolve_window_before_next_heavy_round",
        ownerWindow: ["governance_autopilot", "monotonic_data_ledger"],
        heavyWorkPaused: true,
        liveTouched: false,
        providerConfigTouched: false,
      },
    ]);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath: await writeJsonl("lcx-training-plan-quota-", []),
      json: true,
      processCheck: false,
    });

    expect(plan.latestGuardEvent).toMatchObject({
      at: "2026-05-09T10:05:00.000Z",
      event: "evolution_cooldown",
      round: 2,
    });
    expect(plan.latestEvolutionCooldown).toMatchObject({
      round: 2,
      durationMs: 600000,
      reason: "work_then_evolve_window_before_next_heavy_round",
      ownerWindow: ["governance_autopilot", "monotonic_data_ledger"],
      heavyWorkPaused: true,
      liveTouched: false,
      providerConfigTouched: false,
    });
  });

  it("surfaces newer on-disk dataset manifests and stale train slices", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-plan-dataset-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const sliceDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(sliceDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "manifest.json"),
      JSON.stringify({
        ok: true,
        counts: { sourceFiles: 12, examples: 24, train: 22, valid: 1, test: 1 },
        sourceKinds: {
          brain_distillation_review: 10,
          module_learning_plan_receipt: 2,
          module_learning_review_receipt: 1,
        },
      }),
    );
    await fs.writeFile(
      path.join(sliceDir, "manifest.json"),
      JSON.stringify({
        ok: true,
        counts: {
          sourceTrain: 18,
          curatedSeen: 2,
          nonReviewSeen: 4,
          reviewSeen: 12,
          trainWritten: 10,
        },
      }),
    );

    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
      {
        at: "2026-05-09T10:01:00.000Z",
        event: "step_ok",
        name: "dataset",
        result: {
          ok: true,
          outDir: dataDir,
          counts: { sourceFiles: 9, examples: 20, train: 18, valid: 1, test: 1 },
          sourceKinds: { brain_distillation_review: 10, curated_seed: 2 },
        },
      },
      {
        at: "2026-05-09T10:02:00.000Z",
        event: "step_ok",
        name: "train_slice",
        result: {
          ok: true,
          sourceDataDir: dataDir,
          outDir: sliceDir,
          counts: { sourceTrain: 18, trainWritten: 10 },
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.latestDataset).toMatchObject({
      counts: { train: 18 },
      sourceKinds: { curated_seed: 2 },
    });
    expect(plan.onDiskLocalBrainDataset).toMatchObject({
      exists: true,
      counts: { train: 22 },
      sourceKinds: {
        module_learning_plan_receipt: 2,
        module_learning_review_receipt: 1,
      },
    });
    expect(plan.onDiskTrainSlice).toMatchObject({
      exists: true,
      counts: { sourceTrain: 18 },
    });
    expect(plan.datasetRuntimeFreshness).toMatchObject({
      boundary: "dev_dataset_runtime_freshness_only",
      trainSliceStaleAfterDatasetUpdate: true,
      datasetTrainCount: 22,
      trainSliceSourceTrainCount: 18,
      datasetHasModuleLearningReceipts: true,
      trainSliceBuiltFromModuleLearningDataset: false,
      action: "wait_for_active_training_then_rebuild_train_slice",
    });
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "train_slice_stale_after_dataset_update",
          action: "wait_for_idle_then_rebuild_train_slice",
          codexRepairEligible: false,
        }),
      ]),
    );
    expect(plan.evolutionAccelerationQueue).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: "rebuild_train_slice_after_idle",
          lane: "training",
          status: "ready_when_idle",
          executionClass: "idle_only_training_data",
          command: "node --import tsx scripts/dev/local-brain-distill-train-slice.ts --json",
        }),
      ]),
    });
  });

  it("surfaces guard adapter mismatch against the selected clean adapter", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      {
        at: "2026-05-09T09:40:00.000Z",
        event: "step_ok",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-clean-r2",
          summary: {
            passed: 77,
            total: 77,
            passRate: 1,
            failedCaseIds: [],
            parseErrorCaseIds: [],
            parseRecoveredCaseIds: [],
            promotionReady: true,
          },
        },
      },
      {
        at: "2026-05-09T09:45:00.000Z",
        event: "adapter_promoted_for_guard_session",
        adapterPath: "/tmp/adapter-clean-r2",
      },
      {
        at: "2026-05-09T10:00:00.000Z",
        event: "guard_start",
        options: {
          currentAdapter: "/tmp/adapter-stale-r1",
          trainingSeedAdapter: "/tmp/adapter-stale-r1",
          trainingResumeAdapter: "/tmp/adapter-stale-r1",
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.activeGuardAdapterTruth).toMatchObject({
      boundary: "dev_active_guard_adapter_truth_only",
      guardCurrentAdapter: "/tmp/adapter-stale-r1",
      selectedCleanAdapter: "/tmp/adapter-clean-r2",
      latestPromotedAdapter: "/tmp/adapter-clean-r2",
      guardStartedAfterLatestPromotion: true,
      guardUsesSelectedCleanAdapter: false,
      guardUsesLatestPromotedAdapter: false,
      mismatchReasons: expect.arrayContaining([
        "guard_current_adapter_not_selected_clean",
        "guard_current_adapter_not_latest_promoted_after_promotion",
        "guard_training_seed_adapter_not_selected_clean",
        "guard_training_resume_adapter_not_selected_clean",
      ]),
    });
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "guard_adapter_mismatch",
          lane: "training",
          severity: "P2",
          codexRepairEligible: false,
        }),
      ]),
    );
  });

  it("surfaces the live Lark brain binding gate for the selected clean adapter", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      {
        at: "2026-05-09T09:40:00.000Z",
        event: "step_ok",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-clean-r2",
          summary: {
            passed: 77,
            total: 77,
            passRate: 1,
            failedCaseIds: [],
            parseErrorCaseIds: [],
            parseRecoveredCaseIds: [],
            promotionReady: true,
          },
        },
      },
      {
        at: "2026-05-09T09:45:00.000Z",
        event: "adapter_promoted_for_guard_session",
        adapterPath: "/tmp/adapter-clean-r2",
      },
      {
        at: "2026-05-09T10:00:00.000Z",
        event: "guard_start",
        options: {
          currentAdapter: "/tmp/adapter-clean-r2",
          trainingSeedAdapter: "/tmp/adapter-clean-r2",
          trainingResumeAdapter: "/tmp/adapter-clean-r2",
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.liveLarkBrainBinding).toMatchObject({
      boundary: "dev_live_lark_brain_binding_plan_only",
      selectedCleanAdapter: "/tmp/adapter-clean-r2",
      activeTrainingOrEval: false,
      guardUsesSelectedCleanAdapter: true,
      status: "ready_for_live_runtime_binding",
      action: "bind_live_runtime_to_selected_clean_adapter_and_collect_lark_visible_proof",
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    });
    expect(plan.liveLarkBrainBinding.missingProof).toEqual(
      expect.arrayContaining([
        "live_sidecar_source_drift_zero_after_selected_adapter",
        "fresh_real_lark_inbound_and_outbound_seen",
      ]),
    );
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "live_lark_brain_binding_ready",
          lane: "live_runtime",
          nextCommand: "node --import tsx scripts/dev/lcx-live-lark-brain-binding.ts --json",
        }),
      ]),
    );
    expect(plan.evolutionAccelerationQueue.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "bind_live_lark_to_selected_clean_brain",
          lane: "live_runtime",
          status: "ready_when_idle",
          command: "node --import tsx scripts/dev/lcx-live-lark-brain-binding.ts --json",
        }),
      ]),
    );
  });

  it("does not select an adapter whose latest verdict became non-passing", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      {
        at: "2026-05-09T09:00:00.000Z",
        event: "step_ok",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/older-still-clean-r1",
          summary: {
            passed: 77,
            total: 77,
            passRate: 1,
            failedCaseIds: [],
            parseErrorCaseIds: [],
            parseRecoveredCaseIds: [],
            promotionReady: true,
          },
        },
      },
      {
        at: "2026-05-09T10:00:00.000Z",
        event: "step_ok",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/newer-later-failed-r2",
          summary: {
            passed: 77,
            total: 77,
            passRate: 1,
            failedCaseIds: [],
            parseErrorCaseIds: [],
            parseRecoveredCaseIds: [],
            promotionReady: true,
          },
        },
      },
      {
        at: "2026-05-09T11:00:00.000Z",
        event: "step_non_passing",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/newer-later-failed-r2",
          summary: {
            passed: 76,
            total: 77,
            passRate: 0.987,
            failedCaseIds: ["single_company_fundamental_risk"],
            parseErrorCaseIds: ["single_company_fundamental_risk"],
            parseRecoveredCaseIds: [],
            promotionReady: false,
          },
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.latestPassingEval).toMatchObject({
      adapterPath: "/tmp/older-still-clean-r1",
      promotionReady: true,
    });
    expect(plan.qwenCapabilityConsolidation.selectedCleanAdapter).toBe("/tmp/older-still-clean-r1");
  });

  it("marks a promoted adapter as invalidated when its latest verdict fails", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      {
        at: "2026-05-09T09:00:00.000Z",
        event: "step_ok",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/older-still-clean-r1",
          summary: {
            passed: 77,
            total: 77,
            passRate: 1,
            failedCaseIds: [],
            parseErrorCaseIds: [],
            parseRecoveredCaseIds: [],
            promotionReady: true,
          },
        },
      },
      {
        at: "2026-05-09T10:00:00.000Z",
        event: "step_ok",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/promoted-later-failed-r2",
          summary: {
            passed: 77,
            total: 77,
            passRate: 1,
            failedCaseIds: [],
            parseErrorCaseIds: [],
            parseRecoveredCaseIds: [],
            promotionReady: true,
          },
        },
      },
      {
        at: "2026-05-09T10:00:01.000Z",
        event: "adapter_promoted_for_guard_session",
        adapterPath: "/tmp/promoted-later-failed-r2",
      },
      {
        at: "2026-05-09T11:00:00.000Z",
        event: "step_non_passing",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/promoted-later-failed-r2",
          summary: {
            passed: 76,
            total: 77,
            passRate: 0.987,
            failedCaseIds: ["single_company_fundamental_risk"],
            parseErrorCaseIds: ["single_company_fundamental_risk"],
            parseRecoveredCaseIds: [],
            promotionReady: false,
          },
        },
      },
      {
        at: "2026-05-09T12:00:00.000Z",
        event: "guard_start",
        options: {
          currentAdapter: "/tmp/older-still-clean-r1",
          trainingSeedAdapter: "/tmp/older-still-clean-r1",
          trainingResumeAdapter: "/tmp/older-still-clean-r1",
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.activeGuardAdapterTruth).toMatchObject({
      selectedCleanAdapter: "/tmp/older-still-clean-r1",
      latestPromotedAdapter: "/tmp/promoted-later-failed-r2",
      latestPromotedAdapterStillClean: false,
      guardUsesSelectedCleanAdapter: true,
      guardUsesLatestPromotedAdapter: null,
      mismatchReasons: [],
      stalePromotionReasons: ["latest_promoted_adapter_no_longer_selected_clean"],
      action: "guard_adapter_matches_selected_clean_adapter",
    });
    expect(plan.decisions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "guard_adapter_mismatch" })]),
    );
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "latest_promoted_adapter_not_selected_clean",
          lane: "adapter_promotion",
          severity: "P3",
          codexRepairEligible: false,
        }),
      ]),
    );
    expect(plan.qwenCapabilityConsolidation.adapterLadder.latestCleanChallenger).toBeUndefined();
    expect(plan.qwenCapabilityConsolidation.adapterLadder.latestBlockedChallenger).toMatchObject({
      adapterPath: "/tmp/promoted-later-failed-r2",
      runtimeEligible: false,
    });
  });

  it("does not repair from stale eval failures before the latest guard start", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      {
        at: "2026-05-09T09:59:00.000Z",
        event: "step_non_passing",
        name: "training_seed_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r3",
          summary: {
            passed: 57,
            total: 68,
            passRate: 0.838,
            failedCaseIds: ["broad_finance_module_taxonomy_coverage"],
            parseErrorCaseIds: ["broad_finance_module_taxonomy_coverage"],
            promotionReady: false,
          },
          cases: [
            {
              id: "broad_finance_module_taxonomy_coverage",
              parseError: "no JSON object found in model output",
            },
          ],
        },
      },
      { at: "2026-05-09T10:10:00.000Z", event: "guard_start" },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.latestEvalIsCurrentForGuardStart).toBe(false);
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "eval_pending_after_latest_start",
          codexRepairEligible: false,
        }),
      ]),
    );
    expect(plan.decisions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "output_contract_or_parser_failure" }),
      ]),
    );
    expect(plan.codexAutoRepair).toMatchObject({
      eligible: false,
      repairDecisionIds: [],
    });
  });

  it("surfaces repeated stable eval timeouts after the latest guard start", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
      {
        at: "2026-05-09T11:00:00.000Z",
        event: "step_timeout",
        name: "stable_hardened_eval",
        durationMs: 3_600_001,
        timeoutReason: "total_timeout",
        result: {
          adapterPath: "/tmp/adapter-r2",
          timeoutReason: "total_timeout",
          timeoutMs: 3_600_001,
          durationMs: 3_600_001,
          summary: {
            passed: 0,
            total: 0,
            failedCaseIds: ["stable_hardened_eval_total_timeout"],
            promotionReady: false,
          },
        },
      },
      {
        at: "2026-05-09T12:00:00.000Z",
        event: "step_timeout",
        name: "stable_hardened_eval",
        durationMs: 3_600_002,
        timeoutReason: "total_timeout",
        result: {
          adapterPath: "/tmp/adapter-r2",
          timeoutReason: "total_timeout",
          timeoutMs: 3_600_002,
          durationMs: 3_600_002,
          summary: {
            passed: 0,
            total: 0,
            failedCaseIds: ["stable_hardened_eval_total_timeout"],
            promotionReady: false,
          },
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.latestEvalTimeout).toMatchObject({
      at: "2026-05-09T12:00:00.000Z",
      name: "stable_hardened_eval",
      adapterPath: "/tmp/adapter-r2",
      timeoutReason: "total_timeout",
      failedCaseIds: ["stable_hardened_eval_total_timeout"],
    });
    expect(plan.stableEvalTimeoutCountAfterLatestStart).toBe(2);
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "stable_eval_timeout_after_latest_start",
          lane: "training",
          severity: "P2",
          action: "hold_promotion_and_repair_eval_runtime_or_scope",
          codexRepairEligible: false,
          reason: expect.stringContaining("stable_hardened_eval timeouts this guard=2"),
        }),
      ]),
    );
  });

  it("does not advertise promotion ready when a newer stable eval timeout supersedes the clean eval", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
      {
        at: "2026-05-09T10:30:00.000Z",
        event: "step_ok",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r2",
          summary: {
            passed: 200,
            total: 200,
            passRate: 1,
            failedCaseIds: [],
            parseErrorCaseIds: [],
            parseRecoveredCaseIds: [],
            promotionReady: true,
          },
        },
      },
      {
        at: "2026-05-09T11:00:00.000Z",
        event: "step_timeout",
        name: "stable_hardened_eval",
        durationMs: 3_600_002,
        timeoutReason: "total_timeout",
        result: {
          adapterPath: "/tmp/adapter-r2",
          timeoutReason: "total_timeout",
          timeoutMs: 3_600_002,
          durationMs: 3_600_002,
          summary: {
            passed: 0,
            total: 0,
            failedCaseIds: ["stable_hardened_eval_total_timeout"],
            promotionReady: false,
          },
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.latestEval).toMatchObject({
      at: "2026-05-09T10:30:00.000Z",
      promotionReady: true,
    });
    expect(plan.latestEvalTimeout).toMatchObject({
      at: "2026-05-09T11:00:00.000Z",
      timeoutReason: "total_timeout",
    });
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "promotion_candidate_blocked_by_runtime_truth",
          lane: "promotion_audit",
          severity: "P2",
          codexRepairEligible: false,
          reason: expect.stringContaining("newer than promotion-ready eval"),
        }),
      ]),
    );
    expect(plan.decisions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "promotion_candidate_ready" })]),
    );
  });

  it("treats summary-only parse error case ids as output-contract failures", async () => {
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
      {
        at: "2026-05-09T10:20:00.000Z",
        event: "step_non_passing",
        name: "training_seed_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r4",
          summary: {
            passed: 61,
            total: 68,
            passRate: 0.897,
            failedCaseIds: ["local_memory_knowledge_activation"],
            parseErrorCaseIds: ["local_memory_knowledge_activation"],
            promotionReady: false,
          },
        },
      },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);

    const plan = await buildLocalBrainTrainingPlan({
      guardLogPath,
      quotaLogPath,
      json: true,
      processCheck: false,
    });

    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "output_contract_or_parser_failure",
          codexRepairEligible: true,
        }),
      ]),
    );
    expect(plan.codexAutoRepair).toMatchObject({
      eligible: true,
      repairDecisionIds: ["output_contract_or_parser_failure"],
    });
  });

  it("surfaces incomplete module-learning receipts for automation without writing reviews", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-plan-worktree-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-plan-workspace-"));
    const dateKey = new Date().toISOString().slice(0, 10);
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);
    await writeJson(
      workspaceDir,
      `memory/module-learning-pipeline-plan-receipts/${dateKey}/incomplete.json`,
      {
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "options_volatility",
        moduleFamily: "finance_research",
        status: "retrieval_ready",
        learningIntent: "Learn an options IV event-risk source.",
        missingEvidence: ["application_validation_receipt", "training_or_eval_absorption_evidence"],
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );

    try {
      const plan = await buildLocalBrainTrainingPlan({
        guardLogPath,
        quotaLogPath,
        worktree,
        workspaceDir,
        json: true,
        processCheck: false,
      });

      expect(plan.moduleLearningReview).toMatchObject({
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: expect.objectContaining({
          weakModuleLearning: 1,
          retrievalReady: 1,
          boundaryViolations: 0,
        }),
      });
      expect(plan.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "module_learning_incomplete_evidence",
            lane: "module_learning",
            codexRepairEligible: false,
          }),
        ]),
      );
      expect(plan.evolutionAccelerationQueue).toMatchObject({
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "close_module_learning_exact_proof_gaps",
            lane: "module_learning",
            status: "blocked_by_missing_proof",
            executionClass: "read_only",
            blockedByDecisionIds: ["module_learning_incomplete_evidence"],
          }),
        ]),
      });
      await expect(
        fs.stat(path.join(worktree, `memory/module-learning-pipeline-reviews/${dateKey}.json`)),
      ).rejects.toThrow();
      await expect(
        fs.stat(path.join(workspaceDir, `memory/module-learning-pipeline-reviews/${dateKey}.json`)),
      ).rejects.toThrow();
    } finally {
      await fs.rm(worktree, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("surfaces module-learning boundary violations on eval-absorbed receipts", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-plan-worktree-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-plan-workspace-"));
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);
    const dateKey = new Date().toISOString().slice(0, 10);
    await writeJson(
      workspaceDir,
      `memory/module-learning-pipeline-plan-receipts/${dateKey}/bad.json`,
      {
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "portfolio_risk_gates",
        status: "eval_absorbed",
        absorptionEvidence: {
          evalCaseId: "portfolio_risk_gate_eval",
          evalPassed: true,
          trainingSliceIncluded: true,
          keepDownrankDiscardDecision: "keep",
        },
        liveTouched: true,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );

    try {
      const plan = await buildLocalBrainTrainingPlan({
        guardLogPath,
        quotaLogPath,
        worktree,
        workspaceDir,
        json: true,
        processCheck: false,
      });

      expect(plan.moduleLearningReview).toMatchObject({
        counts: expect.objectContaining({
          weakModuleLearning: 1,
          evalAbsorbed: 1,
          boundaryViolations: 1,
        }),
      });
      expect(plan.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "module_learning_incomplete_evidence",
            lane: "module_learning",
            codexRepairEligible: true,
            reason: expect.stringContaining("violate boundary rules"),
            nextCommand: expect.stringContaining("lcx-automation-repair-lock.ts"),
          }),
        ]),
      );
    } finally {
      await fs.rm(worktree, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("surfaces finance apply receipts that still need module-learning bridge receipts", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-plan-worktree-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-plan-workspace-"));
    const guardLogPath = await writeJsonl("lcx-training-plan-guard-", [
      { at: "2026-05-09T10:00:00.000Z", event: "guard_start" },
    ]);
    const quotaLogPath = await writeJsonl("lcx-training-plan-quota-", []);
    await writeJson(workspaceDir, "memory/finance-learning-retrieval-receipts/2026-05-12/r.json", {
      boundary: "finance_learning_retrieval_receipt",
      normalizedArticleArtifactPaths: ["memory/research-sources/source.md"],
    });
    await writeJson(
      workspaceDir,
      "memory/finance-learning-apply-usage-receipts/2026-05-12/a.json",
      {
        boundary: "finance_learning_capability_apply_usage_receipt",
        ok: true,
        queryText: "Research-only QQQ TLT NVDA portfolio risk decomposition.",
        appliedCapabilities: [
          {
            capabilityName: "ETF risk sizing review workflow",
            sourceArticlePath: "memory/research-sources/source.md",
            matchedSignals: ["portfolio_risk_gates", "risk_gate_design"],
            applicationBoundary: "research_only",
            attachmentPoint: "research_capability:risk_gate_design",
          },
        ],
      },
    );

    try {
      const plan = await buildLocalBrainTrainingPlan({
        guardLogPath,
        quotaLogPath,
        worktree,
        workspaceDir,
        json: true,
        processCheck: false,
      });

      expect(plan.moduleLearningReview).toMatchObject({
        counts: expect.objectContaining({
          receiptFiles: 0,
          weakModuleLearning: 0,
        }),
      });
      expect(plan.learningSedimentationBridge).toMatchObject({
        boundary: "dev_learning_sedimentation_bridge_only",
        candidateCount: 1,
        sourceApplyReceiptFiles: 1,
        notPromoted: true,
      });
      expect(plan.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "module_learning_bridge_candidates_pending",
            lane: "module_learning",
            action: "write_module_learning_plan_receipts_then_review_absorption_gate",
          }),
        ]),
      );
      expect(plan.evolutionAccelerationQueue).toMatchObject({
        readyNowCount: 1,
        fastestSafeNextAction: "bridge_module_learning_receipts_now",
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "bridge_module_learning_receipts_now",
            lane: "module_learning",
            status: "ready_now",
            executionClass: "workspace_receipt_write",
            command: expect.stringContaining("--write-plan-receipts"),
          }),
        ]),
      });
    } finally {
      await fs.rm(worktree, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
