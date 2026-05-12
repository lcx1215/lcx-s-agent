import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/dev/module-learning-pipeline-review.ts");

async function seedJson(workspaceDir: string, relativePath: string, payload: unknown) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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

describe("module-learning-pipeline-review CLI", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("writes a daily review receipt by default", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-module-review-cli-"));
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/options.json",
      {
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "options_volatility",
        moduleFamily: "finance_research",
        status: "application_ready",
        sourceUrlOrPath: "memory/research-sources/options.md",
        learningIntent: "Learn options volatility event risk.",
        actualReadingScope: "Read IV, skew, gamma, event, and liquidity sections.",
        sourceRegistryRecordPath: "memory/research-sources/options.md",
        retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/2026-05-12/r.json",
        applicationValidationReceiptPath:
          "memory/finance-learning-apply-usage-receipts/2026-05-12/a.json",
        missingEvidence: ["training_or_eval_absorption_evidence"],
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );

    const result = runCli(["--date", "2026-05-12", "--json"], workspaceDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "module_learning_pipeline_review_only",
        updated: true,
        reviewPath: "memory/module-learning-pipeline-reviews/2026-05-12.json",
        counts: expect.objectContaining({
          receiptFiles: 1,
          validReceipts: 1,
          applicationReady: 1,
          weakModuleLearning: 1,
          boundaryViolations: 0,
        }),
      }),
    );
    await expect(
      fs.stat(path.join(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-12.json")),
    ).resolves.toBeTruthy();
  });

  it("supports dry-run without writing a review receipt", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-module-review-cli-"));

    const result = runCli(["--date", "2026-05-12", "--no-write", "--json"], workspaceDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        updated: false,
        counts: expect.objectContaining({
          receiptFiles: 0,
          validReceipts: 0,
          weakModuleLearning: 0,
        }),
      }),
    );
    expect(parsed).not.toHaveProperty("reviewPath");
    await expect(
      fs.stat(path.join(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-12.json")),
    ).rejects.toThrow();
  });
});
