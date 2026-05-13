import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("LCX head-tail consistency doctor", () => {
  it("is wired into the main system doctor", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("head-tail-consistency");
    expect(source).toContain("scripts/dev/lcx-change-impact-plan.ts");
    expect(source).toContain("scripts/dev/lcx-head-tail-consistency.ts");
  });

  it("passes current macro doctrine and local-brain micro surfaces", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-head-tail-consistency.ts", "--json"],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      summary: { failed: number; total: number };
      moduleCounts: {
        localBrainTaxonomy: number;
        moduleLearningTargets: number;
        explicitExemptions: number;
      };
      checks: Array<{ id: string; ok: boolean }>;
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
    };

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_head_tail_consistency_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary.total).toBeGreaterThanOrEqual(8);
    expect(payload.moduleCounts.localBrainTaxonomy).toBeGreaterThan(
      payload.moduleCounts.moduleLearningTargets,
    );
    expect(payload.moduleCounts.explicitExemptions).toBeGreaterThan(0);
    expect(
      payload.checks.find(
        (check) => check.id === "taxonomy_modules_have_learning_target_or_explicit_exemption",
      )?.ok,
    ).toBe(true);
    expect(
      payload.checks.find((check) => check.id === "runbook_lists_every_module_learning_target")?.ok,
    ).toBe(true);
    expect(
      payload.checks.find((check) => check.id === "critical_module_head_tail_terms_present")?.ok,
    ).toBe(true);
    expect(
      payload.checks.find((check) => check.id === "engineering_micro_contracts_head_tail_present")
        ?.ok,
    ).toBe(true);
  });

  it("plans fast verification for micro changes without forcing a full scan first", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/lcx-change-impact-plan.ts",
        "--json",
        "--changed",
        "src/agents/tools/module-learning-pipeline-plan-tool.ts",
        "--changed",
        "extensions/feishu/src/bot.test.ts",
      ],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      affectedLanes: string[];
      impacts: Array<{
        id: string;
        lane: string;
        requiredChecks: string[];
        headTailRequired: boolean;
        risk: "normal" | "elevated";
      }>;
      recommendedFastCommands: string[];
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
    };

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_change_impact_plan_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.affectedLanes).toEqual(
      expect.arrayContaining(["memory_sedimentation", "lark_feishu_visible_reply"]),
    );
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "module_learning_memory",
          headTailRequired: true,
          requiredChecks: expect.arrayContaining(["head-tail-consistency"]),
        }),
        expect.objectContaining({
          id: "lark_feishu_visible_surface",
          risk: "elevated",
        }),
      ]),
    );
    expect(payload.recommendedFastCommands.join("\n")).toContain(
      "scripts/dev/lcx-head-tail-consistency.ts",
    );
    expect(payload.recommendedFastCommands.join("\n")).toContain(
      "extensions/feishu/src/bot.test.ts",
    );
  });
});
