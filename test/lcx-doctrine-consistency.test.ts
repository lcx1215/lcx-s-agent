import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("LCX doctrine consistency doctor", () => {
  it("is wired into the main system doctor", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("doctrine-consistency");
    expect(source).toContain("scripts/dev/lcx-doctrine-consistency.ts");
  });

  it("passes current active doctrine entrypoints", async () => {
    const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-doctrine-skills-"));
    await fs.mkdir(path.join(skillsRoot, "lcx-baseline-hardening"), { recursive: true });
    await fs.mkdir(path.join(skillsRoot, "lcx-evolution-loop"), { recursive: true });
    await fs.mkdir(path.join(skillsRoot, "l5-regression-batterer", "scripts"), {
      recursive: true,
    });
    await fs.mkdir(path.join(skillsRoot, "l4-regression-batterer"), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, "lcx-baseline-hardening", "SKILL.md"),
      [
        "# LCX Baseline Hardening",
        "Repair the failure family with the smallest coherent system upgrade over a tiny symptom patch.",
        "Before creating anything new, check whether a similar mechanism exists. Reuse, merge, or extend.",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(skillsRoot, "lcx-evolution-loop", "SKILL.md"),
      [
        "# LCX Evolution Loop",
        "Use l5-regression-batterer for L5 baseline pressure.",
        "l4-regression-batterer is only a legacy compatibility alias.",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(skillsRoot, "l5-regression-batterer", "SKILL.md"),
      "# L5 Baseline Regression Batterer\nUse l5-regression-batterer for L5 baseline checks.\n",
    );
    await fs.writeFile(
      path.join(skillsRoot, "l5-regression-batterer", "scripts", "l5-regression-batterer.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    await fs.writeFile(
      path.join(skillsRoot, "l4-regression-batterer", "SKILL.md"),
      ["# Legacy Alias", "legacy compatibility alias.", "Prefer the L5 skill."].join("\n"),
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-doctrine-consistency.ts", "--json"],
      {
        cwd: repoRoot,
        env: { ...process.env, LCX_CODEX_SKILLS_ROOT: skillsRoot },
      },
    );
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      summary: { failed: number; total: number };
      checks: Array<{ id: string; ok: boolean }>;
    };

    expect(payload.ok).toBe(true);
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary.total).toBeGreaterThanOrEqual(8);
    expect(payload.checks.find((check) => check.id === "l5_skill_primary")?.ok).toBe(true);
    expect(
      payload.checks.find((check) => check.id === "current_adapter_selector_required")?.ok,
    ).toBe(true);
  });
});
