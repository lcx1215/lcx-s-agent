import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runBridge(workspaceDir: string, extraArgs: string[] = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/dev/lcx-learning-sedimentation-bridge.ts",
      "--workspace",
      workspaceDir,
      "--json",
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    boundary: string;
    writePlanReceipts: boolean;
    candidateCount: number;
    existingPlanReceiptCount: number;
    missingPlanReceiptCount: number;
    nextAction: string;
    candidates: Array<{
      targetModule: string;
      status: string;
      sourceUrlOrPath: string;
      retrievalReceiptPath: string | null;
      applicationValidationReceiptPath: string;
      missingEvidence: string[];
      receiptPath: string | null;
      receiptWritten: boolean;
      receiptAlreadyExists: boolean;
    }>;
    notPromoted: boolean;
    liveTouched: boolean;
    providerConfigTouched: boolean;
    protectedMemoryTouched: boolean;
  };
}

async function seedBridgeEvidence(workspaceDir: string): Promise<void> {
  const memoryDir = path.join(workspaceDir, "memory");
  await writeJson(path.join(memoryDir, "finance-learning-retrieval-receipts", "day", "r.json"), {
    boundary: "finance_learning_retrieval_receipt",
    normalizedArticleArtifactPaths: ["memory/research-sources/source.md"],
  });
  await writeJson(path.join(memoryDir, "finance-learning-apply-usage-receipts", "day", "a.json"), {
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
  });
}

describe("LCX learning sedimentation bridge", () => {
  it("builds application-ready module-learning plan candidates without writing by default", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-bridge-"));
    await seedBridgeEvidence(workspaceDir);

    const payload = await runBridge(workspaceDir);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_learning_sedimentation_bridge_only",
        writePlanReceipts: false,
        candidateCount: 1,
        existingPlanReceiptCount: 0,
        missingPlanReceiptCount: 1,
        nextAction: "write_missing_plan_receipts_then_run_module_learning_review",
        notPromoted: true,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.candidates[0]).toEqual(
      expect.objectContaining({
        targetModule: "portfolio_risk_gates",
        status: "application_ready",
        sourceUrlOrPath: "memory/research-sources/source.md",
        retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/day/r.json",
        applicationValidationReceiptPath: "memory/finance-learning-apply-usage-receipts/day/a.json",
        receiptPath: null,
        receiptWritten: false,
        receiptAlreadyExists: false,
      }),
    );
    expect(payload.candidates[0]?.missingEvidence).toEqual(
      expect.arrayContaining([
        "training_or_eval_absorption_evidence",
        "fresh_adjacent_application_task",
        "keep_downrank_or_discard_decision",
      ]),
    );
  });

  it("can explicitly write weak plan receipts without promoting them", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-bridge-"));
    await seedBridgeEvidence(workspaceDir);

    const payload = await runBridge(workspaceDir, ["--write-plan-receipts"]);

    expect(payload.writePlanReceipts).toBe(true);
    expect(payload.candidates[0]?.receiptWritten).toBe(true);
    expect(payload.candidates[0]?.receiptAlreadyExists).toBe(false);
    expect(payload.candidates[0]?.status).toBe("application_ready");
    const receiptPath = payload.candidates[0]?.receiptPath;
    expect(receiptPath).toEqual(expect.stringContaining("module-learning-pipeline-plan-receipts"));
    const receipt = JSON.parse(
      await fs.readFile(path.join(workspaceDir, receiptPath ?? ""), "utf8"),
    );
    expect(receipt).toEqual(
      expect.objectContaining({
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "portfolio_risk_gates",
        status: "application_ready",
        learningIntent: expect.stringContaining("Convert existing finance-learning sedimentation"),
        receiptWritten: true,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
  });

  it("reuses same-day plan receipts instead of asking operators to write duplicates", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-bridge-"));
    await seedBridgeEvidence(workspaceDir);

    const written = await runBridge(workspaceDir, ["--write-plan-receipts"]);
    const existingReceiptPath = written.candidates[0]?.receiptPath;
    expect(existingReceiptPath).toEqual(
      expect.stringContaining("module-learning-pipeline-plan-receipts"),
    );

    const dryRun = await runBridge(workspaceDir);

    expect(dryRun).toEqual(
      expect.objectContaining({
        writePlanReceipts: false,
        candidateCount: 1,
        existingPlanReceiptCount: 1,
        missingPlanReceiptCount: 0,
        nextAction: "run_module_learning_review_and_absorption_gate",
      }),
    );
    expect(dryRun.candidates[0]).toEqual(
      expect.objectContaining({
        receiptPath: existingReceiptPath,
        receiptWritten: false,
        receiptAlreadyExists: true,
      }),
    );
  });

  it("stays empty when no apply receipts exist", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-bridge-"));

    const payload = await runBridge(workspaceDir);

    expect(payload.candidateCount).toBe(0);
    expect(payload.candidates).toEqual([]);
    expect(payload.notPromoted).toBe(true);
  });
});
