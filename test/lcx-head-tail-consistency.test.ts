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
    expect(payload.summary.total).toBeGreaterThanOrEqual(7);
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
  });
});
