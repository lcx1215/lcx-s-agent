import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallDryRunReceipt } from "../scripts/dev/live-sidecar-install-dry-run.ts";
import type { LaunchAgentPlan } from "../scripts/dev/live-sidecar-launchagent-plan.ts";

const tmpRoots: string[] = [];

function makeTmpRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${label}-`));
  tmpRoots.push(root);
  return root;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makePlan(root: string): LaunchAgentPlan {
  const currentDir = path.join(root, "current");
  const outputDir = path.join(root, "out");
  const schedulerCurrent = path.join(currentDir, "scheduler.plist");
  const schedulerCandidate = path.join(outputDir, "scheduler.plist");
  const watchdogCurrent = path.join(currentDir, "watchdog.plist");
  const watchdogCandidate = path.join(outputDir, "watchdog.plist");
  writeFile(schedulerCurrent, "<plist><string>old scheduler</string></plist>\n");
  writeFile(schedulerCandidate, "<plist><string>new scheduler</string></plist>\n");
  writeFile(watchdogCurrent, "<plist><string>old watchdog</string></plist>\n");
  writeFile(watchdogCandidate, "<plist><string>new watchdog</string></plist>\n");
  return {
    schemaVersion: 1,
    generatedAt: "2026-04-27T00:00:00.000Z",
    targetRoot: path.join(root, "target"),
    legacyRoot: path.join(root, "legacy"),
    outputDir,
    noLiveLaunchAgentChange: true,
    candidates: [
      {
        sidecar: "scheduler",
        label: "ai.openclaw.lobster.scheduler",
        candidatePath: schedulerCandidate,
        currentPlistPath: schedulerCurrent,
        currentPlistExists: true,
        currentPlistSha256: "old",
        programArguments: [
          "/usr/bin/python3",
          "daily_learning_runner.py",
          "--dry-run",
          "--write-receipt",
        ],
        workingDirectory: path.join(root, "target"),
        standardOutPath: "/tmp/scheduler.out",
        standardErrorPath: "/tmp/scheduler.err",
        runAtLoad: false,
        startCalendarInterval: { Hour: 2, Minute: 30 },
        safetyMode: "dry_run_write_receipt",
        rollbackCommands: [],
      },
      {
        sidecar: "host_watchdog",
        label: "ai.openclaw.lobster.host_watchdog",
        candidatePath: watchdogCandidate,
        currentPlistPath: watchdogCurrent,
        currentPlistExists: true,
        currentPlistSha256: "old",
        programArguments: [
          "/usr/bin/python3",
          "scripts/lobster_host_watchdog.py",
          "--dry-run",
          "--write-receipt",
        ],
        workingDirectory: path.join(root, "target"),
        standardOutPath: "/tmp/watchdog.out",
        standardErrorPath: "/tmp/watchdog.err",
        runAtLoad: true,
        startInterval: 1800,
        safetyMode: "dry_run_write_receipt",
        rollbackCommands: [],
      },
    ],
    installBoundary: [],
  };
}

describe("live sidecar install dry-run receipt", () => {
  it("builds backup/copy/rollback actions without changing plist files", () => {
    const root = makeTmpRoot("install-dry-run");
    const plan = makePlan(root);
    const before = fs.readFileSync(plan.candidates[0].currentPlistPath, "utf8");
    const receipt = buildInstallDryRunReceipt({
      targetRoot: plan.targetRoot,
      legacyRoot: plan.legacyRoot,
      outputDir: plan.outputDir,
      generatedAt: "2026-04-27T00:00:00.000Z",
      plan,
      preflight: {
        schemaVersion: 1,
        generatedAt: "2026-04-27T00:00:00.000Z",
        targetRoot: plan.targetRoot,
        legacyRoot: plan.legacyRoot,
        readyForManualInstall: true,
        noLiveLaunchAgentChange: true,
        checks: [],
        blockedReasons: [],
        nextStep: "ready",
      },
    });

    expect(receipt.noLiveLaunchAgentChange).toBe(true);
    expect(receipt.preflightReady).toBe(true);
    expect(receipt.actions).toHaveLength(2);
    expect(receipt.actions[0].wouldRun.join("\n")).toContain("cp ");
    expect(receipt.actions[0].wouldRun.join("\n")).toContain("launchctl bootstrap");
    expect(receipt.actions[0].currentDiffSummary.changed).toBe(true);
    expect(receipt.executionBoundary.join("\n")).toContain("No plist was copied");
    expect(fs.readFileSync(plan.candidates[0].currentPlistPath, "utf8")).toBe(before);
  });

  it("records blocked preflight without hiding install actions", () => {
    const root = makeTmpRoot("install-dry-run-blocked");
    const plan = makePlan(root);
    const receipt = buildInstallDryRunReceipt({
      targetRoot: plan.targetRoot,
      legacyRoot: plan.legacyRoot,
      outputDir: plan.outputDir,
      generatedAt: "2026-04-27T00:00:00.000Z",
      plan,
      preflight: {
        schemaVersion: 1,
        generatedAt: "2026-04-27T00:00:00.000Z",
        targetRoot: plan.targetRoot,
        legacyRoot: plan.legacyRoot,
        readyForManualInstall: false,
        noLiveLaunchAgentChange: true,
        checks: [],
        blockedReasons: ["scheduler_root_drift_gate: fail"],
        nextStep: "blocked",
      },
    });

    expect(receipt.preflightReady).toBe(false);
    expect(receipt.blockedReasons).toEqual(["scheduler_root_drift_gate: fail"]);
    expect(receipt.actions[0].rollbackCommands.join("\n")).toContain("launchctl bootstrap");
  });
});
