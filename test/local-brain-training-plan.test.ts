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
});
