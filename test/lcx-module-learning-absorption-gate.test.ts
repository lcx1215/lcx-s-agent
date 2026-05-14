import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/dev/lcx-module-learning-absorption-gate.ts");

async function seedJson(workspaceDir: string, relativePath: string, payload: unknown) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return absolutePath;
}

function runCli(args: string[], workspaceDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--workspace", workspaceDir, ...args, "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

function runReviewCli(args: string[], workspaceDir: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repoRoot, "scripts/dev/module-learning-pipeline-review.ts"),
      "--workspace",
      workspaceDir,
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

function cleanEvalSummary() {
  return {
    at: "2026-05-14T15:00:00.000Z",
    event: "step_ok",
    name: "stable_hardened_eval",
    result: {
      adapterPath: "/tmp/adapter-r6",
      summary: {
        passed: 77,
        total: 77,
        passRate: 1,
        promotionReady: true,
        failedCaseIds: [],
        parseErrorCaseIds: [],
        parseRecoveredCaseIds: [],
      },
    },
  };
}

describe("lcx-module-learning-absorption-gate", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("holds application-ready receipts even when global eval is clean", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-absorption-gate-"));
    const evalSummaryPath = await seedJson(workspaceDir, "eval-summary.json", cleanEvalSummary());
    await seedJson(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-14.json", {
      boundary: "module_learning_pipeline_review",
      dateKey: "2026-05-14",
      counts: {
        receiptFiles: 1,
        validReceipts: 1,
        applicationReady: 1,
        evalAbsorbed: 0,
        weakModuleLearning: 1,
        boundaryViolations: 0,
      },
      rows: [
        {
          receiptPath: "memory/module-learning-pipeline-plan-receipts/2026-05-14/options.json",
          targetModule: "options_volatility",
          status: "application_ready",
          trainingOrEvalAbsorptionEvidencePath: null,
          freshAdjacentApplicationTask: null,
          keepDownrankDiscardDecision: "not_decided",
          missingEvidence: [
            "training_or_eval_absorption_evidence",
            "fresh_adjacent_application_task",
            "keep_downrank_or_discard_decision",
          ],
          weak: true,
          boundaryViolation: false,
        },
      ],
    });

    const result = runCli(
      ["--date", "2026-05-14", "--eval-summary", evalSummaryPath],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_module_learning_absorption_gate_only",
        absorptionReady: false,
        gateDecision: "hold_at_application_ready",
        notPromoted: true,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(parsed.blockers).toEqual(
      expect.arrayContaining([
        "module_receipts_not_eval_absorbed",
        "module_receipts_missing_absorption_decision_evidence",
      ]),
    );
    expect(parsed.latestEval).toEqual(
      expect.objectContaining({
        passed: 77,
        total: 77,
        promotionReady: true,
        globalEvalClean: true,
      }),
    );
  });

  it("allows a ready decision only when every receipt carries absorption evidence", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-absorption-gate-"));
    const evalSummaryPath = await seedJson(workspaceDir, "eval-summary.json", cleanEvalSummary());
    await seedJson(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-14.json", {
      boundary: "module_learning_pipeline_review",
      dateKey: "2026-05-14",
      counts: {
        receiptFiles: 1,
        validReceipts: 1,
        applicationReady: 0,
        evalAbsorbed: 1,
        weakModuleLearning: 0,
        boundaryViolations: 0,
      },
      rows: [
        {
          receiptPath: "memory/module-learning-pipeline-plan-receipts/2026-05-14/options.json",
          targetModule: "options_volatility",
          status: "eval_absorbed",
          trainingOrEvalAbsorptionEvidencePath: "memory/evals/options.json",
          freshAdjacentApplicationTask: "Apply the options lesson to a new ETF event-risk brief.",
          keepDownrankDiscardDecision: "keep",
          missingEvidence: [],
          weak: false,
          boundaryViolation: false,
        },
      ],
    });

    const result = runCli(
      ["--date", "2026-05-14", "--eval-summary", evalSummaryPath],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        absorptionReady: true,
        gateDecision: "ready_for_eval_absorbed_review",
        blockers: [],
      }),
    );
  });

  it("keeps absorption blocked when the review receipt is missing", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-absorption-gate-"));
    const evalSummaryPath = await seedJson(workspaceDir, "eval-summary.json", cleanEvalSummary());

    const result = runCli(
      ["--date", "2026-05-14", "--eval-summary", evalSummaryPath],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        absorptionReady: false,
        gateDecision: "hold_at_application_ready",
        reviewPath: "memory/module-learning-pipeline-reviews/2026-05-14.json",
      }),
    );
    expect(parsed.blockers).toContain("module_learning_review_missing");
  });

  it("can write evidence and superseding eval-absorbed plan receipts when the gate is clean", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-absorption-gate-"));
    const evalSummaryPath = await seedJson(workspaceDir, "eval-summary.json", cleanEvalSummary());
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-14/options.json",
      {
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "options_volatility",
        moduleFamily: "finance_research",
        status: "application_ready",
        sourceUrlOrPath: "memory/research-sources/options.md",
        learningIntent: "Learn options volatility event risk.",
        actualReadingScope: "Read IV, skew, gamma, event, and liquidity sections.",
        sourceRegistryRecordPath: "memory/research-sources/options.md",
        retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/2026-05-14/r.json",
        applicationValidationReceiptPath:
          "memory/finance-learning-apply-usage-receipts/2026-05-14/a.json",
        missingEvidence: [
          "training_or_eval_absorption_evidence",
          "fresh_adjacent_application_task",
          "keep_downrank_or_discard_decision",
        ],
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );
    await seedJson(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-14.json", {
      boundary: "module_learning_pipeline_review",
      dateKey: "2026-05-14",
      counts: {
        receiptFiles: 1,
        validReceipts: 1,
        applicationReady: 1,
        evalAbsorbed: 0,
        weakModuleLearning: 1,
        boundaryViolations: 0,
      },
      rows: [
        {
          receiptPath: "memory/module-learning-pipeline-plan-receipts/2026-05-14/options.json",
          targetModule: "options_volatility",
          moduleFamily: "finance_research",
          status: "application_ready",
          sourceUrlOrPath: "memory/research-sources/options.md",
          learningIntent: "Learn options volatility event risk.",
          actualReadingScope: "Read IV, skew, gamma, event, and liquidity sections.",
          sourceRegistryRecordPath: "memory/research-sources/options.md",
          retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/2026-05-14/r.json",
          applicationValidationReceiptPath:
            "memory/finance-learning-apply-usage-receipts/2026-05-14/a.json",
          trainingOrEvalAbsorptionEvidencePath: null,
          freshAdjacentApplicationTask: null,
          keepDownrankDiscardDecision: "not_decided",
          missingEvidence: [
            "training_or_eval_absorption_evidence",
            "fresh_adjacent_application_task",
            "keep_downrank_or_discard_decision",
          ],
          weak: true,
          boundaryViolation: false,
        },
      ],
    });

    const writeResult = runCli(
      ["--date", "2026-05-14", "--eval-summary", evalSummaryPath, "--write-absorbed-plan-receipts"],
      workspaceDir,
    );
    expect(writeResult.status).toBe(0);
    const writeParsed = JSON.parse(writeResult.stdout) as Record<string, unknown>;
    expect(writeParsed.writtenAbsorptionReceipts).toEqual([
      expect.objectContaining({
        targetModule: "options_volatility",
        status: "eval_absorbed",
      }),
    ]);

    const reviewResult = runReviewCli(
      ["--date", "2026-05-14", "--no-write", "--json"],
      workspaceDir,
    );
    expect(reviewResult.status).toBe(0);
    const reviewParsed = JSON.parse(reviewResult.stdout) as Record<string, unknown>;
    expect(reviewParsed).toEqual(
      expect.objectContaining({
        counts: expect.objectContaining({
          receiptFiles: 1,
          rawReceiptFiles: 2,
          evalAbsorbed: 1,
          weakModuleLearning: 0,
        }),
      }),
    );
  });
});
