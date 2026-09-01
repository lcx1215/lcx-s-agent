import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLaunchAgentPlan,
  main as launchAgentPlanMain,
} from "../scripts/operator/external-channel-sidecar-launchagent-plan.ts";
import { DEFAULT_RUNTIME_BUNDLE_ROOT } from "../scripts/operator/external-channel-sidecar-runtime-bundle.ts";
import {
  DEFAULT_LAUNCH_AGENTS_DIR,
  DEFAULT_LAUNCH_AGENT_PATH,
  DEFAULT_LEGACY_ROOT,
  DEFAULT_OPENCLAW_LOG_DIR,
  LCX_USER_HOME,
} from "../scripts/operator/lcx-local-paths.ts";

const tmpRoots: string[] = [];

function makeTmpRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${label}-`));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("live sidecar launchagent plan", () => {
  it("builds dry-run candidate plists without live install commands", () => {
    const targetRoot = makeTmpRoot("target-root");
    const legacyRoot = makeTmpRoot("legacy-root");
    const outputDir = makeTmpRoot("launchagent-plan");
    const plan = buildLaunchAgentPlan({
      targetRoot,
      legacyRoot,
      outputDir,
      generatedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(plan.noLiveLaunchAgentChange).toBe(true);
    expect(plan.candidates).toHaveLength(2);
    for (const candidate of plan.candidates) {
      expect(candidate.safetyMode).toBe("dry_run_write_receipt");
      expect(candidate.programArguments).toContain("--dry-run");
      expect(candidate.programArguments).toContain("--write-receipt");
      expect(candidate.workingDirectory).toBe(targetRoot);
      expect(candidate.candidatePath.startsWith(outputDir)).toBe(true);
      expect(candidate.rollbackCommands.join("\n")).toContain(legacyRoot);
      expect(candidate.programArguments.join("\n")).not.toContain(
        "OPENCLAW_SCHEDULER_ENABLE_CYCLE",
      );
    }
    expect(plan.installBoundary.join("\n")).toContain("Do not copy these candidates");
  });

  it("defaults candidate plists to the non-Desktop runtime bundle", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exitCode = launchAgentPlanMain(["--json"]);
    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(write.mock.calls[0]?.[0] ?? "{}"));
    expect(path.resolve(payload.targetRoot)).toBe(path.resolve(DEFAULT_RUNTIME_BUNDLE_ROOT));
    expect(payload.targetRoot).not.toContain("/Desktop/");
    write.mockRestore();
  });

  it("derives user-specific LaunchAgent and log paths from the shared home", () => {
    const outputDir = makeTmpRoot("launchagent-portable");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exitCode = launchAgentPlanMain(["--json", "--write", "--output-dir", outputDir]);
    const payload = JSON.parse(String(write.mock.calls[0]?.[0] ?? "{}"));
    const scheduler = payload.candidates[0];
    const plist = fs.readFileSync(scheduler.candidatePath, "utf8");

    expect(exitCode).toBe(0);
    expect(path.resolve(payload.legacyRoot)).toBe(path.resolve(DEFAULT_LEGACY_ROOT));
    expect(scheduler.currentPlistPath).toBe(
      path.join(DEFAULT_LAUNCH_AGENTS_DIR, "ai.openclaw.lobster.scheduler.plist"),
    );
    expect(scheduler.standardOutPath).toBe(
      path.join(DEFAULT_OPENCLAW_LOG_DIR, "lobster_scheduler.smoke.out.log"),
    );
    expect(plist).toContain(`<string>${LCX_USER_HOME}</string>`);
    expect(plist).toContain(`<string>${DEFAULT_LAUNCH_AGENT_PATH}</string>`);
    write.mockRestore();
  });
});
