import { describe, expect, it } from "vitest";
import type { HostWatchdogDryRunReport } from "../scripts/dev/live-sidecar-host-watchdog-dry-run.ts";
import {
  buildInstallPreflightReport,
  type InstallPreflightCheck,
} from "../scripts/dev/live-sidecar-install-preflight.ts";
import type { LaunchAgentPlan } from "../scripts/dev/live-sidecar-launchagent-plan.ts";
import type { SchedulerDryRunReport } from "../scripts/dev/live-sidecar-scheduler-dry-run.ts";

function schedulerReport(overrides: Partial<SchedulerDryRunReport> = {}): SchedulerDryRunReport {
  return {
    schemaVersion: 1,
    mode: "dry_run_no_launchagent_change_no_lark_send",
    checkedAt: "2026-04-27T00:00:00.000Z",
    legacyRoot: "/legacy",
    targetRoot: "/target",
    launchAgent: {
      plistPath: "/scheduler.plist",
      exists: true,
      programArguments: [],
      workingDirectory: "/legacy",
      pointsAtLegacyRoot: true,
    },
    legacyRequiredFiles: [],
    targetRequiredFiles: [],
    stateFiles: [],
    migrationReady: true,
    blockedReasons: [],
    nextSafePatch: [],
    ...overrides,
  };
}

function hostReport(overrides: Partial<HostWatchdogDryRunReport> = {}): HostWatchdogDryRunReport {
  return {
    schemaVersion: 1,
    mode: "dry_run_no_launchagent_change_no_lark_send",
    checkedAt: "2026-04-27T00:00:00.000Z",
    legacyRoot: "/legacy",
    targetRoot: "/target",
    launchAgent: {
      plistPath: "/watchdog.plist",
      exists: true,
      programArguments: [],
      workingDirectory: "/legacy",
      pointsAtLegacyRoot: true,
    },
    legacyRequiredFiles: [],
    targetRequiredFiles: [],
    stateFiles: [],
    migrationReady: true,
    blockedReasons: [],
    nextSafePatch: [],
    ...overrides,
  };
}

function plan(): LaunchAgentPlan {
  return {
    schemaVersion: 1,
    generatedAt: "2026-04-27T00:00:00.000Z",
    targetRoot: "/target",
    legacyRoot: "/legacy",
    outputDir: "/out",
    noLiveLaunchAgentChange: true,
    candidates: [
      {
        sidecar: "scheduler",
        label: "ai.openclaw.lobster.scheduler",
        candidatePath: "/out/scheduler.plist",
        currentPlistPath: "/current/scheduler.plist",
        currentPlistExists: true,
        currentPlistSha256: "abc",
        programArguments: [
          "/usr/bin/python3",
          "/target/daily_learning_runner.py",
          "--dry-run",
          "--write-receipt",
        ],
        workingDirectory: "/target",
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
        candidatePath: "/out/watchdog.plist",
        currentPlistPath: "/current/watchdog.plist",
        currentPlistExists: true,
        currentPlistSha256: "def",
        programArguments: [
          "/usr/bin/python3",
          "/target/scripts/lobster_host_watchdog.py",
          "--dry-run",
          "--write-receipt",
        ],
        workingDirectory: "/target",
        standardOutPath: "/tmp/watchdog.out",
        standardErrorPath: "/tmp/watchdog.err",
        runAtLoad: true,
        startInterval: 1800,
        safetyMode: "dry_run_write_receipt",
        rollbackCommands: [],
      },
    ],
    installBoundary: ["Do not install without approval."],
  };
}

const passingCheck = (name: string): InstallPreflightCheck => ({
  name,
  status: "pass",
  detail: "ok",
});

describe("live sidecar install preflight", () => {
  it("is ready only when every gate passes", () => {
    const report = buildInstallPreflightReport({
      targetRoot: "/target",
      legacyRoot: "/legacy",
      outputDir: "/out",
      generatedAt: "2026-04-27T00:00:00.000Z",
      schedulerReport: schedulerReport(),
      hostWatchdogReport: hostReport(),
      plan: plan(),
      plistChecks: [passingCheck("plist_lint:scheduler"), passingCheck("plist_lint:host_watchdog")],
      commandChecks: [passingCheck("scheduler_smoke"), passingCheck("watchdog_smoke")],
    });

    expect(report.readyForManualInstall).toBe(true);
    expect(report.noLiveLaunchAgentChange).toBe(true);
    expect(report.blockedReasons).toEqual([]);
  });

  it("blocks when any gate fails", () => {
    const report = buildInstallPreflightReport({
      targetRoot: "/target",
      legacyRoot: "/legacy",
      outputDir: "/out",
      schedulerReport: schedulerReport({
        migrationReady: false,
        blockedReasons: ["target scheduler dependency missing"],
      }),
      hostWatchdogReport: hostReport(),
      plan: plan(),
      plistChecks: [passingCheck("plist_lint:scheduler"), passingCheck("plist_lint:host_watchdog")],
      commandChecks: [
        passingCheck("scheduler_smoke"),
        { name: "watchdog_smoke", status: "fail", detail: "exit 1" },
      ],
    });

    expect(report.readyForManualInstall).toBe(false);
    expect(report.blockedReasons).toContain(
      "scheduler_root_drift_gate: target scheduler dependency missing",
    );
    expect(report.blockedReasons).toContain("watchdog_smoke: exit 1");
    expect(report.nextStep).toContain("Do not install");
  });
});
