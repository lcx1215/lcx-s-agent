import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/dev/lcx-skillopt-lite.ts");

async function seedAutopilot(workspaceDir: string) {
  const statePath = path.join(workspaceDir, "state", "lcx-governance-autopilot-latest.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify(
      {
        checkedAt: "2026-05-26T10:00:00.000Z",
        owners: {
          trainingPlan: {
            activeProcessCount: 3,
            selectedCleanAdapter: "/adapters/clean-r2",
            latestCandidateEval: {
              adapterPath: "/adapters/candidate-r6",
              promotionReady: false,
              failedCaseIds: [],
              parseErrorCaseIds: [],
              parseRecoveredCaseIds: [
                "full_stack_finance_stress_with_red_team",
                "a_share_policy_flow_us_tech_spillover",
                "single_stock_curve_technical_timing_preflight",
                "adversarial_data_conflict_06",
              ],
            },
            externalChannelBinding: {
              status: "deferred_active_training_or_eval",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function runCli(args: string[], workspaceDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--workspace", workspaceDir, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

describe("lcx-skillopt-lite CLI", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("builds a dry-run SkillOpt-lite split from latest governance truth", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);

    const result = runCli(
      [
        "--skill",
        "single_stock_curve_technical_timing_preflight",
        "--no-write",
        "--json",
        "--max-train-cases",
        "2",
      ],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_skillopt_lite_only",
        updated: false,
        skillId: "single_stock_curve_technical_timing_preflight",
        activeProcessCount: 3,
        latestCandidateAdapter: "/adapters/candidate-r6",
        parseRecoveredCount: 4,
        trainCaseCount: 2,
        validationCaseCount: 2,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(parsed.trainCases).toEqual([
      "full_stack_finance_stress_with_red_team",
      "a_share_policy_flow_us_tech_spillover",
    ]);
    expect(parsed.regressionCases).toEqual(
      expect.arrayContaining(["single_stock_curve_technical_timing_preflight"]),
    );
    await expect(
      fs.stat(
        path.join(
          workspaceDir,
          "memory/skillopt-lite/single_stock_curve_technical_timing_preflight/best_skill.md",
        ),
      ),
    ).rejects.toThrow();
  });

  it("writes a bootstrap best_skill seed and receipt under workspace memory", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);

    const result = runCli(["--json"], workspaceDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        updated: true,
        status: "bootstrap_best_skill_seed_ready",
        staticGateOk: true,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );

    const bestSkill = await fs.readFile(
      path.join(
        workspaceDir,
        "memory/skillopt-lite/single_stock_curve_technical_timing_preflight/best_skill.md",
      ),
      "utf8",
    );
    expect(bestSkill).toContain("technical_timing");
    expect(bestSkill).toContain("company_fundamentals_value");
    expect(bestSkill).toContain("portfolio_risk_gates");
    expect(bestSkill).toContain("source_registry");
    expect(bestSkill).toContain("data_provenance_quality");
    expect(bestSkill).toContain("direct_buy_sell_answer");
    expect(bestSkill).toContain("technical_timing_as_standalone_alpha");

    await expect(
      fs.stat(
        path.join(
          workspaceDir,
          "memory/skillopt-lite/single_stock_curve_technical_timing_preflight/skillopt-lite-latest.json",
        ),
      ),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(
        path.join(
          workspaceDir,
          "memory/skillopt-lite/finance_data_provenance_preflight/best_skill.md",
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it("accepts a bounded candidate edit only as pending eval evidence", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);

    expect(runCli(["--json"], workspaceDir).status).toBe(0);
    const result = runCli(
      ["--phase", "candidate-edit", "--json", "--max-train-cases", "3"],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        phase: "candidate-edit",
        accepted: true,
        status: "candidate_edit_static_accepted_pending_eval",
        trainCaseCount: 4,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(parsed.matchedSkillIds).toEqual(
      expect.arrayContaining([
        "single_stock_curve_technical_timing_preflight",
        "finance_data_provenance_preflight",
      ]),
    );
    expect(parsed.proofChain).toEqual(
      expect.objectContaining({
        boundary: "dev_skillopt_proof_chain_only",
      }),
    );
    expect(parsed.nextIdleCommand).toContain("--adapter '/adapters/candidate-r6'");
    expect(parsed.nextIdleCommand).not.toContain("--adapter latest-passing");
    expect(parsed.nextIdleCommand).toContain("--hardened");
    expect(parsed.nextIdleCommand).toContain("--receipt");
    expect(parsed.absorptionPlan).toEqual(
      expect.objectContaining({
        status: "not_absorbed_until_training_and_promotion_truth",
      }),
    );

    const bestSkill = await fs.readFile(
      path.join(
        workspaceDir,
        "memory/skillopt-lite/single_stock_curve_technical_timing_preflight/best_skill.md",
      ),
      "utf8",
    );
    expect(bestSkill).toContain("## Candidate Edit: Adjacent Failure Transfer");
    expect(bestSkill).toContain("pending_eval_acceptance");
    expect(bestSkill).toContain("macro/cross-asset context");
    expect(bestSkill).toContain("accept this candidate edit only after targeted eval improves");

    const candidatePath = parsed.candidatePath as string;
    await expect(fs.stat(path.join(workspaceDir, candidatePath))).resolves.toBeTruthy();
  });

  it("refreshes stale external-channel boundary skill contracts before scoring candidate edits", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);
    const skillRoot = path.join(
      workspaceDir,
      "memory/skillopt-lite/external_channel_boundary_preflight",
    );
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "best_skill.md"),
      [
        "# Lark External Channel Boundary Preflight",
        "",
        "boundary: dev_skillopt_lite_only",
        "",
        "## Purpose",
        "Old external-channel proof text requires selected clean adapter and fresh real inbound/outbound evidence.",
      ].join("\n"),
      "utf8",
    );

    const result = runCli(
      [
        "--skill",
        "external_channel_boundary_preflight",
        "--phase",
        "candidate-edit",
        "--json",
        "--max-train-cases",
        "2",
      ],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        staticGateOk: true,
        staticGateMissingTokens: [],
        status: "candidate_edit_static_accepted_pending_eval",
      }),
    );

    const bestSkill = await fs.readFile(path.join(skillRoot, "best_skill.md"), "utf8");
    expect(bestSkill).toContain("## Current Static Contract Terms");
    expect(bestSkill).toContain("lark_external_channel_binding");
    expect(bestSkill).toContain("dev_ready_not_user_visible_observed");
    expect(bestSkill).toContain("channel_probe_as_user_visible_observed");
    expect(bestSkill).toContain("dirty_candidate_external_channel_binding");
    expect(bestSkill).toContain("external_channel_source_drift_zero_after_selected_adapter");
    expect(bestSkill).toContain("lark_external_channel_gateway_restarted_after_selected_adapter");
    expect(bestSkill).toContain("lark_external_channel_diagnose_ok_after_restart");
    expect(bestSkill).toContain("fresh_real_lark_inbound_and_outbound_user_visible_observed");
  });

  it("builds an immediate deterministic preflight packet without claiming absorption or user-visible proof", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);

    const result = runCli(
      ["--no-write", "--json", "--task", "最新价格和供应商数据冲突，哪个能信？"],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const instantPreflight = parsed.instantPreflight as Record<string, unknown>;

    expect(instantPreflight).toEqual(
      expect.objectContaining({
        status: "ready_for_context_injection",
        boundary: "dev_skillopt_preflight_only",
        canUseImmediately: true,
        modelWeightAbsorbed: false,
        externalChannelApplied: false,
        liveLarkApplied: false,
      }),
    );
    expect(instantPreflight.matchedSkillIds).toEqual(
      expect.arrayContaining(["finance_data_provenance_preflight"]),
    );
    expect(String(instantPreflight.promptInjection)).toContain("Finance Data Provenance Preflight");
    expect(parsed.externalChannelProofPlan).toEqual(
      expect.objectContaining({
        status: "blocked_by_active_training_or_eval",
      }),
    );
    expect(parsed.liveLarkProofPlan).toEqual(parsed.externalChannelProofPlan);
  });
});
