import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("LCX mind model god-view architecture check", () => {
  it("passes current macro workflow closure surfaces", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-mind-model.ts", "--json"],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      summary: { failed: number; total: number; masterLanes: string[] };
      lanes: Array<{ id: string; ok: boolean; missing: unknown[] }>;
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
    const [doctorSource, headTailSource, runbook] = await Promise.all([
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-head-tail-consistency.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
    ]);

    expect(doctorSource).toContain('name: "mind-model-consistency"');
    expect(doctorSource).toContain("scripts/dev/lcx-mind-model.ts");
    expect(headTailSource).toContain("mind_model_boundary");
    expect(headTailSource).toContain("MIND_MODEL_LANES");
    expect(runbook).toContain("LCX Agent Mind Model");
    expect(runbook).toContain("workflow closure");
  });
});
