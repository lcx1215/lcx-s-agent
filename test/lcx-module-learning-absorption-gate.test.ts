import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedNativeLearning, learningHash, text } from "./fixtures/lcx-waterflow-learning-probe.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/operator/lcx-module-learning-absorption-gate.ts");

async function seedJson(workspaceDir: string, relativePath: string, payload: unknown) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return absolutePath;
}

async function seedJsonl(workspaceDir: string, relativePath: string, lines: unknown[]) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return absolutePath;
}

async function seedSourceReceiptsFromFixture(workspaceDir: string) {
  const fixture = JSON.parse(
    await fs.readFile(
      path.join(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-14.json"),
      "utf8",
    ),
  ) as { rows: Array<Record<string, unknown>> };
  for (const row of fixture.rows) {
    const artifact = `evidence/${String(row.targetModule)}.json`;
    await seedJson(workspaceDir, artifact, { testResult: "passed" });
    const hash = createHash("sha256")
      .update(await fs.readFile(path.join(workspaceDir, artifact)))
      .digest("hex");
    const source = `fixture-source:${String(row.targetModule)}`;
    await seedJson(workspaceDir, String(row.receiptPath), {
      ...row,
      boundary: "local_module_learning_pipeline_plan",
      sourceUrlOrPath: source,
      actualReadingScope: "fixture source",
      sourceRegistryRecordPath: artifact,
      retrievalReceiptPath: artifact,
      applicationValidationReceiptPath: artifact,
      moduleSpecificCapabilityRule: "retain source binding",
      safetyBoundaries: ["research_only"],
    });
    if (row.status === "eval_absorbed") {
      await seedJson(workspaceDir, String(row.trainingOrEvalAbsorptionEvidencePath), {
        schemaVersion: "lcx_module_learning_eval_v1",
        verdict: "passed",
        targetModule: row.targetModule,
        sourceUrlOrPath: source,
        freshAdjacentApplicationTask: row.freshAdjacentApplicationTask,
        checks: [{ id: "source-case", passed: true, evidencePath: artifact, sha256: hash }],
      });
    }
  }
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
      path.join(repoRoot, "scripts/operator/module-learning-pipeline-review.ts"),
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

  it("retains actual fresh source/module receipt and bytes hashes without narrowing the global gate", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-selected-learning-gate-"));
    const seeded = await seedNativeLearning(workspaceDir);
    const args = [
      "--guard-log",
      path.join(workspaceDir, "guard.jsonl"),
      "--source",
      seeded.source,
      "--target-module",
      "portfolio_risk_gates",
      "--host-run-id",
      "offline-continuous-learning",
      "--receipt-sha256",
      await learningHash(workspaceDir, text(seeded.plan.receiptPath)),
      "--source-sha256",
      await learningHash(workspaceDir, seeded.source),
    ];
    const result = runCli(args, workspaceDir);
    expect(result.status).toBe(0);
    const gate = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(gate).toMatchObject({
      absorptionReady: false,
      consumedReview: {
        readMode: "fresh_original_review",
        hostScope: { runId: "offline-continuous-learning" },
        selection: { sourceUrlOrPath: seeded.source, targetModule: "portfolio_risk_gates" },
        gaps: [],
        selectedReceipts: [
          expect.objectContaining({
            receiptPath: seeded.plan.receiptPath,
            receiptSha256: await learningHash(workspaceDir, text(seeded.plan.receiptPath)),
            sourceUrlOrPath: seeded.source,
            evaluationVerified: true,
          }),
        ],
      },
    });
    expect(gate.blockers).toContain("registered_sources_missing_application_or_eval_evidence");
  });
  it.each(["source", "receipt", "missing-module"])(
    "selected %s conflict remains held with an exact evidence gap",
    async (fault) => {
      workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-selected-learning-conflict-"));
      const seeded = await seedNativeLearning(workspaceDir);
      const args = [
        "--guard-log",
        path.join(workspaceDir, "guard.jsonl"),
        "--source",
        seeded.source,
        "--target-module",
        fault === "missing-module" ? "technical_timing" : "portfolio_risk_gates",
        fault === "receipt" ? "--receipt-sha256" : "--source-sha256",
        "0".repeat(64),
      ];
      const result = runCli(args, workspaceDir);
      expect(result.status).toBe(0);
      const gate = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(gate.absorptionReady).toBe(false);
      expect(gate.blockers).toContain(
        fault === "missing-module"
          ? "selected_source_module_receipt_missing"
          : `selected_${fault}_hash_conflict`,
      );
    },
  );
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

    await seedSourceReceiptsFromFixture(workspaceDir);
    const result = runCli(
      ["--date", "2026-05-14", "--eval-summary", evalSummaryPath],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_module_learning_absorption_gate_only",
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

    await seedSourceReceiptsFromFixture(workspaceDir);
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

  it("allows terminal discarded receipts to stay out of the absorption denominator", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-absorption-gate-"));
    const evalSummaryPath = await seedJson(workspaceDir, "eval-summary.json", cleanEvalSummary());
    await seedJson(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-14.json", {
      boundary: "module_learning_pipeline_review",
      dateKey: "2026-05-14",
      counts: {
        receiptFiles: 2,
        validReceipts: 2,
        applicationReady: 0,
        evalAbsorbed: 1,
        terminalNonAbsorbed: 1,
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
        {
          receiptPath: "memory/module-learning-pipeline-plan-receipts/2026-05-14/discard.json",
          targetModule: "portfolio_risk_gates",
          status: "stored_only",
          keepDownrankDiscardDecision: "discard",
          terminalNonAbsorbedDecision: true,
          missingEvidence: [
            "capability_card_or_retrieval_receipt",
            "application_validation_receipt",
            "training_or_eval_absorption_evidence",
          ],
          exactMissingProof: [],
          weak: false,
          boundaryViolation: false,
        },
      ],
    });

    await seedSourceReceiptsFromFixture(workspaceDir);
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
        counts: expect.objectContaining({
          claimableRows: 1,
          terminalNonAbsorbedRows: 1,
          weakReceiptCount: 0,
        }),
      }),
    );
  });

  it("blocks absorption when a newer hardened eval timeout follows older clean evidence", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-absorption-gate-"));
    const guardLogPath = await seedJsonl(workspaceDir, "guard.jsonl", [
      cleanEvalSummary(),
      {
        at: "2026-05-14T16:00:00.000Z",
        event: "step_timeout",
        name: "stable_hardened_eval",
        durationMs: 3_600_001,
        timeoutReason: "total_timeout",
        result: {
          adapterPath: "/tmp/adapter-r6",
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
    ]);
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

    const result = runCli(["--date", "2026-05-14", "--guard-log", guardLogPath], workspaceDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        absorptionReady: false,
        gateDecision: "hold_at_application_ready",
        writeAvailable: false,
      }),
    );
    expect(parsed.latestEvalTimeout).toEqual(
      expect.objectContaining({
        name: "stable_hardened_eval",
        timeoutReason: "total_timeout",
        newerThanLatestEval: true,
      }),
    );
    expect(parsed.blockers).toContain(
      "latest_hardened_eval_timeout_newer_than_absorption_evidence",
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
    expect(parsed.blockers).toContain("module_learning_plan_receipts_missing");
  });

  it("rebuilds a stale empty review from current plan receipts", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-absorption-gate-"));
    const evalSummaryPath = await seedJson(workspaceDir, "eval-summary.json", cleanEvalSummary());
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-14/options.json",
      {
        boundary: "local_module_learning_pipeline_plan",
        targetModule: "options_volatility",
        status: "application_ready",
      },
    );
    await seedJson(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-14.json", {
      boundary: "module_learning_pipeline_review",
      dateKey: "2026-05-14",
      counts: {
        receiptFiles: 0,
        validReceipts: 0,
        applicationReady: 0,
        evalAbsorbed: 0,
        weakModuleLearning: 0,
        boundaryViolations: 0,
      },
      rows: [],
    });

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
        writeAvailable: false,
      }),
    );
    expect(parsed.counts).toEqual(
      expect.objectContaining({
        planReceiptFiles: 1,
        reviewRows: 1,
      }),
    );
    expect(parsed.blockers).toContain("module_receipts_not_eval_absorbed");
    expect(parsed.blockers).not.toContain("module_learning_review_stale_or_empty");
  });

  it("does not manufacture per-source absorption or adjacent-task proof from a clean global eval", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-absorption-gate-"));
    const evalSummaryPath = await seedJson(workspaceDir, "eval-summary.json", cleanEvalSummary());
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-14/options.json",
      {
        boundary: "local_module_learning_pipeline_plan",
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
    expect(writeParsed).toMatchObject({
      absorptionReady: false,
      writeAvailable: false,
      gateDecision: "hold_at_application_ready",
      postWriteReviewRefreshed: false,
      writtenAbsorptionReceipts: [],
      writeSkippedReason:
        "absorption_requires_executed_per_receipt_training_and_adjacent_task_evidence",
    });

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
          rawReceiptFiles: 1,
          evalAbsorbed: 0,
          weakModuleLearning: 1,
        }),
      }),
    );
  });
});
