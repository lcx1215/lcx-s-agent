import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 20 * 1024 * 1024;

async function runJsonScript(script: string) {
  try {
    return await execFileAsync(process.execPath, ["--import", "tsx", script, "--json"], {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [
        details.message ?? String(error),
        `stdout=${details.stdout ?? ""}`,
        `stderr=${details.stderr ?? ""}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

describe("LCX mind model god-view architecture check", () => {
  it("passes current macro workflow closure surfaces", async () => {
    const { stdout } = await runJsonScript("scripts/dev/lcx-mind-model.ts");
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      summary: { failed: number; total: number; masterLanes: string[] };
      lanes: Array<{ id: string; ok: boolean; missing: unknown[] }>;
      missingSurfaceFiles: string[];
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
    };

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_mind_model_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary.total).toBeGreaterThanOrEqual(9);
    expect(payload.missingSurfaceFiles).toEqual([]);
    expect(payload.summary.masterLanes).toEqual(
      expect.arrayContaining([
        "global_doctrine_and_runbook",
        "qwen_training",
        "finance_research_capability",
        "dev_live_boundary",
      ]),
    );
    expect(payload.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mind_model_self_supervision", ok: true }),
        expect.objectContaining({ id: "local_brain_training", ok: true }),
        expect.objectContaining({ id: "module_learning_memory", ok: true }),
        expect.objectContaining({ id: "lark_feishu_live_boundary", ok: true }),
      ]),
    );
  });

  it("is wired into the main doctor and head-tail gate", async () => {
    const [doctorSource, headTailSource, runbook, localOperator] = await Promise.all([
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-head-tail-consistency.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
      fs.readFile("/Users/liuchengxu/.openclaw/bin/lcx-local-operator-loop.sh", "utf8"),
    ]);

    expect(doctorSource).toContain('name: "mind-model-consistency"');
    expect(doctorSource).toContain('name: "context-recovery-exam"');
    expect(doctorSource).toContain("scripts/dev/lcx-mind-model.ts");
    expect(doctorSource).toContain("scripts/dev/lcx-context-recovery-exam.ts");
    expect(headTailSource).toContain("mind_model_boundary");
    expect(headTailSource).toContain("MIND_MODEL_LANES");
    expect(headTailSource).toContain("compressedContextRecovered");
    expect(runbook).toContain("LCX Agent Mind Model");
    expect(runbook).toContain("workflow closure");
    expect(runbook).toContain("lcx-context-recovery-exam");
    expect(localOperator).toContain("mind_file");
    expect(localOperator).toContain("context_recovery_file");
    expect(localOperator).toContain("mindModel");
    expect(localOperator).toContain("contextRecovery");
  });
});
