import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/dev/module-learning-pipeline-plan.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: os.homedir(),
    },
    timeout: 20_000,
    input: "",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCliWithDefaultWorkspace(args: string[], userHome: string) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      LCX_USER_HOME: userHome,
    },
    timeout: 20_000,
    input: "",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("module-learning-pipeline-plan CLI", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("dry-runs through the existing module-learning plan tool by default", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-module-plan-cli-"));

    const result = runCli([
      "--workspace",
      workspaceDir,
      "--target-module",
      "options_volatility",
      "--source",
      "ops/local-brain/README.md",
      "--actual-reading-scope",
      "Read local-brain module-learning chain and options eval gates.",
      "--existing-artifact",
      "scripts/dev/local-brain-distill-eval.ts",
      "--json",
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "options_volatility",
        receiptWritten: false,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    await expect(
      fs.stat(path.join(workspaceDir, "memory/module-learning-pipeline-plan-receipts")),
    ).rejects.toBeTruthy();
  });

  it("writes a plan receipt only when explicitly requested", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-module-plan-cli-"));

    const result = runCli([
      "--workspace",
      workspaceDir,
      "--target-module",
      "global_index_regime",
      "--source",
      "scripts/dev/local-brain-distill-eval.ts",
      "--actual-reading-scope",
      "Read index concentration and all-domain finance eval cases.",
      "--existing-artifact",
      "scripts/dev/local-brain-distill-eval.ts",
      "--source-registry-record",
      "scripts/dev/local-brain-distill-eval.ts",
      "--retrieval-receipt",
      "scripts/dev/local-brain-distill-eval.ts",
      "--application-validation-receipt",
      "test/local-brain-distill-eval.test.ts",
      "--training-or-eval-absorption-evidence",
      "test/local-brain-distill-eval.test.ts",
      "--fresh-adjacent-application-task",
      "Apply index concentration learning to a fresh QQQ/SPY concentration risk ask.",
      "--keep-downrank-discard-decision",
      "keep",
      "--write",
      "--json",
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        targetModule: "global_index_regime",
        status: "eval_absorbed",
        receiptWritten: true,
      }),
    );
    const receiptPath = String(parsed.receiptPath);
    await expect(fs.stat(path.join(workspaceDir, receiptPath))).resolves.toBeTruthy();
  });

  it("defaults writes to the local OpenClaw workspace instead of the repo worktree", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-module-plan-home-"));

    const result = runCliWithDefaultWorkspace(
      [
        "--target-module",
        "portfolio_risk_gates",
        "--source",
        "ops/local-brain/README.md",
        "--actual-reading-scope",
        "Read module learning workspace default rules.",
        "--existing-artifact",
        "scripts/dev/module-learning-pipeline-plan.ts",
        "--write",
        "--json",
      ],
      workspaceDir,
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const receiptPath = String(parsed.receiptPath);
    const defaultWorkspaceDir = path.join(workspaceDir, ".openclaw", "workspace");

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        targetModule: "portfolio_risk_gates",
        receiptWritten: true,
      }),
    );
    await expect(fs.stat(path.join(defaultWorkspaceDir, receiptPath))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(repoRoot, receiptPath))).rejects.toBeTruthy();
  });

  it("accepts advanced trader QC module targets", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-module-plan-cli-"));

    const result = runCli([
      "--workspace",
      workspaceDir,
      "--target-module",
      "research_artifact_qc",
      "--source",
      "ops/local-brain/README.md",
      "--actual-reading-scope",
      "Read artifact QC and number provenance workflow.",
      "--existing-artifact",
      "scripts/dev/local-brain-distill-eval.ts",
      "--json",
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "research_artifact_qc",
        moduleFamily: "finance_research",
        receiptWritten: false,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(parsed).toEqual(
      expect.objectContaining({
        safetyBoundaries: expect.arrayContaining([
          "cite_every_number_or_mark_unsourced",
          "human_review_required_before_external_use",
        ]),
        missingEvidence: expect.arrayContaining([
          "source_registry_record",
          "capability_card_or_retrieval_receipt",
        ]),
      }),
    );
  });
});
