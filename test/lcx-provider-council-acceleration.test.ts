import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/operator/lcx-provider-council-acceleration.ts");

async function seedAutopilot(workspaceDir: string) {
  const statePath = path.join(workspaceDir, "state", "lcx-governance-autopilot-latest.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify(
      {
        owners: {
          trainingPlan: {
            selectedCleanAdapter: "/adapters/clean-r2",
            latestCandidateEval: {
              adapterPath: "/adapters/candidate-r6",
              promotionReady: false,
              failedCaseIds: ["single_stock_curve_technical_timing_preflight"],
              parseErrorCaseIds: [],
              parseRecoveredCaseIds: ["external_knowledge_expansion_05"],
            },
          },
          skillOptLite: {
            status: "candidate_edit_static_accepted_pending_eval",
            skillId: "single_stock_curve_technical_timing_preflight",
          },
          problemRadar: {
            blockedClusters: ["module_learning_absorption_cluster"],
            actionableClusters: ["evolution_acceleration_cluster"],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writePidFixture(workspaceDir: string, content: string) {
  const filePath = path.join(workspaceDir, "pid-fixture.txt");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

function runCli(args: string[], workspaceDir: string, pidFixture: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "--workspace",
      workspaceDir,
      "--pid-fixture",
      pidFixture,
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

describe("lcx-provider-council-acceleration CLI", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("plans a high-token three-provider council pass without calling providers by default", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-accel-"));
    await seedAutopilot(workspaceDir);
    const pidFixture = await writePidFixture(workspaceDir, "");

    const result = runCli(["--json", "--profile", "aggressive"], workspaceDir, pidFixture);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_provider_council_acceleration_only",
        status: "ready_plan",
        action: "dry_run_plan_only",
        write: false,
        activeEvalOrMlx: false,
        freshCompleteCouncil: false,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(parsed.dailyUse).toEqual(
      expect.objectContaining({
        completeCouncilInWindow: false,
        dueNow: true,
      }),
    );
    expect(parsed.blockedCaseIds).toEqual([
      "single_stock_curve_technical_timing_preflight",
      "external_knowledge_expansion_05",
    ]);
    expect(String(parsed.plannedPrompt)).toContain("Kimi");
    expect(String(parsed.plannedPrompt)).toContain("DeepSeek");
    expect(String(parsed.plannedPrompt)).toContain("MiniMax");
    expect(parsed.outputsFeed).toEqual(
      expect.arrayContaining(["skillopt_candidate_edit", "eval_case", "teacher_curriculum"]),
    );
  }, 240_000);

  it("defers --write while eval or MLX is active instead of spending provider tokens", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-accel-"));
    await seedAutopilot(workspaceDir);
    const pidFixture = await writePidFixture(
      workspaceDir,
      "123 00:01 node --import tsx scripts/operator/local-brain-distill-eval.ts --json\n",
    );

    const result = runCli(["--json", "--write"], workspaceDir, pidFixture);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: false,
        status: "deferred_by_safety_gate",
        action: "deferred",
        write: true,
        activeEvalOrMlx: true,
        canRunProviderCouncilNow: false,
      }),
    );
    expect(parsed.hardBlocks).toEqual(expect.arrayContaining(["active_eval_or_mlx"]));
    expect(parsed.providerResultSnippet).toBeUndefined();
  });

  it("shows when Kimi MiniMax and DeepSeek were all used inside the daily window", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-accel-"));
    await seedAutopilot(workspaceDir);
    const councilDir = path.join(workspaceDir, "bank/knowledge/learning-councils");
    await fs.mkdir(councilDir, { recursive: true });
    await fs.writeFile(
      path.join(councilDir, "provider-smoke-current.json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          status: "full",
          roles: [
            {
              role: "kimi",
              model: "moonshot/kimi-k2.6",
              providerFamily: "moonshot",
              success: true,
            },
            {
              role: "minimax",
              model: "minimax-portal/MiniMax-M2.7",
              providerFamily: "minimax-portal",
              success: true,
            },
            {
              role: "deepseek",
              model: "custom-api-deepseek-com/deepseek-v4-flash",
              providerFamily: "custom-api-deepseek-com",
              success: true,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const pidFixture = await writePidFixture(workspaceDir, "");

    const result = runCli(["--json"], workspaceDir, pidFixture);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const dailyUse = parsed.dailyUse as Record<string, unknown>;

    expect(dailyUse).toEqual(
      expect.objectContaining({
        completeCouncilInWindow: true,
        dueNow: false,
        missingSuccessfulRoles: [],
      }),
    );
    expect(dailyUse.successfulRolesInWindow).toEqual(
      expect.arrayContaining(["kimi", "minimax", "deepseek"]),
    );
  });
});
