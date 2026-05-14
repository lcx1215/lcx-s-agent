import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLocalBrainTrainingPlan } from "../scripts/dev/local-brain-training-plan.js";

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
});
