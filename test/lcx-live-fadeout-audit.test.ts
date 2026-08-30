import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("LCX live fadeout audit", () => {
  it("passes and exposes the canonical external-channel status model", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-live-fadeout-audit.ts", "--json"],
      {
        cwd: repoRoot,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      statusModel: string;
      cloudMigrationModel: string;
      repositoryModel: string;
      remoteBranchModel: string;
      summary: { failed: number; total: number; liveReferenceNeedsReview: number };
      checks: Array<{ id: string; ok: boolean }>;
      liveReferenceInventory: { totalMatches: number };
    };

    expect(payload.ok).toBe(true);
    expect(payload.boundary).toBe("local_live_fadeout_audit_only");
    expect(payload.statusModel).toBe(
      "core-ready -> external-channel-bound -> user-visible-observed",
    );
    expect(payload.cloudMigrationModel).toBe(
      "local LCX core -> cloud-runtime-ready -> external-channel-bound -> user-visible-observed",
    );
    expect(payload.repositoryModel).toBe(
      "one local LCX system/factory -> one canonical Git repository -> linked worktree",
    );
    expect(payload.repositoryModel).not.toContain("feature branch");
    expect(payload.remoteBranchModel).toBe("GitHub/GitLab feature branch -> review/publish");
    expect(payload.remoteBranchModel).toContain("GitHub/GitLab");
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary.total).toBeGreaterThanOrEqual(10);
    expect(payload.liveReferenceInventory.totalMatches).toBeGreaterThan(0);
    expect(payload.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "active_dev_status_semantics_retired",
        "cloud_migration_keeps_single_local_core",
        "binding_owner_is_canonical",
        "external_channel_status_wrapper_is_canonical_readonly",
        "commercial_acceptance_prefers_binding_owner",
        "package_scripts_prefer_external_channel_alias",
        "doctor_runs_live_fadeout_audit",
        "governance_autopilot_runs_live_fadeout_audit",
        "context_recovery_exposes_live_fadeout_audit",
      ]),
    );
  });

  it("is wired into doctor, governance autopilot, context recovery, package aliases, and docs", async () => {
    const [doctor, governance, recovery, packageJsonText, readme, agents, runbook] =
      await Promise.all([
        fs.readFile(path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"), "utf8"),
        fs.readFile(path.join(repoRoot, "scripts/dev/lcx-governance-autopilot.ts"), "utf8"),
        fs.readFile(path.join(repoRoot, "scripts/dev/lcx-context-recovery-exam.ts"), "utf8"),
        fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
        fs.readFile(path.join(repoRoot, "README.md"), "utf8"),
        fs.readFile(path.join(repoRoot, "AGENTS.md"), "utf8"),
        fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
      ]);
    const packageJson = JSON.parse(packageJsonText) as { scripts: Record<string, string> };
    const normalizedAgents = agents.replace(/\s+/gu, " ");

    expect(doctor).toContain('name: "live-fadeout-audit"');
    expect(doctor).toContain("scripts/dev/lcx-live-fadeout-audit.ts");
    expect(governance).toContain('"liveFadeoutAudit"');
    expect(governance).toContain("scripts/dev/lcx-live-fadeout-audit.ts");
    expect(recovery).toContain("scripts/dev/lcx-live-fadeout-audit.ts --json");
    expect(packageJson.scripts["lcx:external-channel"]).toBe(
      "node --import tsx scripts/dev/lcx-external-channel-binding.ts --apply --json",
    );
    expect(packageJson.scripts["lcx:live"]).toBe("pnpm lcx:external-channel");
    expect(readme).toContain("scripts/dev/lcx-live-fadeout-audit.ts --json");
    expect(readme).toContain("local LCX core");
    expect(readme).toContain("cloud-runtime-ready");
    expect(readme).toContain("one canonical repository");
    expect(readme).toContain("Local system/factory rule");
    expect(readme).toContain("Feature branches belong to GitHub/GitLab collaboration");
    expect(agents).toContain("System-wide live fadeout truth belongs");
    expect(agents).toContain("Cloud migration must not resurrect a dual-repository model");
    expect(agents).toContain("Local system/factory rule");
    expect(normalizedAgents).toContain("Feature branches belong to");
    expect(normalizedAgents).toContain("GitHub/GitLab collaboration");
    expect(runbook).toContain("whole-system fadeout audit");
    expect(runbook).toContain("cloud-runtime-ready");
  });
});
