import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  buildHostWatchdogDryRunReport,
  type HostWatchdogDryRunReport,
} from "./live-sidecar-host-watchdog-dry-run.ts";
import { buildLaunchAgentPlan, type LaunchAgentPlan } from "./live-sidecar-launchagent-plan.ts";
import { DEFAULT_RUNTIME_BUNDLE_ROOT } from "./live-sidecar-runtime-bundle.ts";
import {
  buildSchedulerDryRunReport,
  type SchedulerDryRunReport,
} from "./live-sidecar-scheduler-dry-run.ts";

const DEFAULT_TARGET_ROOT = DEFAULT_RUNTIME_BUNDLE_ROOT;
const DEFAULT_LEGACY_ROOT = "/Users/liuchengxu/Desktop/openclaw";
const DEFAULT_OUTPUT_DIR = "ops/live-handoff/launchagent-candidates";
const SCHEDULER_PLIST =
  "/Users/liuchengxu/Library/LaunchAgents/ai.openclaw.lobster.scheduler.plist";
const HOST_WATCHDOG_PLIST =
  "/Users/liuchengxu/Library/LaunchAgents/ai.openclaw.lobster.host_watchdog.plist";

type CheckStatus = "pass" | "fail";

export type InstallPreflightCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
};

export type InstallPreflightReport = {
  schemaVersion: 1;
  generatedAt: string;
  targetRoot: string;
  legacyRoot: string;
  readyForManualInstall: boolean;
  noLiveLaunchAgentChange: true;
  checks: InstallPreflightCheck[];
  blockedReasons: string[];
  nextStep: string;
};

type Args = {
  targetRoot: string;
  legacyRoot: string;
  outputDir: string;
  json: boolean;
  requireReady: boolean;
};

function parseArgs(argv: string[]): Args {
  const readValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    targetRoot: path.resolve(readValue("--target-root") ?? DEFAULT_TARGET_ROOT),
    legacyRoot: path.resolve(readValue("--legacy-root") ?? DEFAULT_LEGACY_ROOT),
    outputDir: path.resolve(readValue("--output-dir") ?? DEFAULT_OUTPUT_DIR),
    json: argv.includes("--json"),
    requireReady: argv.includes("--require-ready"),
  };
}

function runCommand(command: string[], cwd: string): InstallPreflightCheck {
  const result = spawnSync(command[0] ?? "", command.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    name: command.join(" "),
    status: result.status === 0 ? "pass" : "fail",
    detail:
      result.status === 0
        ? "exit 0"
        : `exit ${result.status ?? "null"} ${(result.stderr || result.stdout || "").slice(0, 300)}`,
  };
}

function plistLintChecks(plan: LaunchAgentPlan): InstallPreflightCheck[] {
  return plan.candidates.map((candidate) => {
    if (!fs.existsSync(candidate.candidatePath)) {
      return {
        name: `plist_lint:${candidate.sidecar}`,
        status: "fail",
        detail: `candidate plist missing: ${candidate.candidatePath}`,
      };
    }
    const result = spawnSync("plutil", ["-lint", candidate.candidatePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      name: `plist_lint:${candidate.sidecar}`,
      status: result.status === 0 ? "pass" : "fail",
      detail:
        result.status === 0
          ? "plutil OK"
          : (result.stderr || result.stdout || "plutil failed").slice(0, 300),
    };
  });
}

function sidecarReportCheck(
  name: string,
  report: SchedulerDryRunReport | HostWatchdogDryRunReport,
): InstallPreflightCheck {
  return {
    name,
    status: report.migrationReady ? "pass" : "fail",
    detail: report.migrationReady
      ? "migration_ready"
      : report.blockedReasons.join("; ") || "migration gate blocked",
  };
}

function planSafetyChecks(plan: LaunchAgentPlan): InstallPreflightCheck[] {
  const checks: InstallPreflightCheck[] = [];
  checks.push({
    name: "plan_no_live_change",
    status: plan.noLiveLaunchAgentChange ? "pass" : "fail",
    detail: `noLiveLaunchAgentChange=${plan.noLiveLaunchAgentChange}`,
  });
  for (const candidate of plan.candidates) {
    const safeArgs =
      candidate.programArguments.includes("--dry-run") &&
      candidate.programArguments.includes("--write-receipt");
    const enableEnv = JSON.stringify(candidate).includes("OPENCLAW_SCHEDULER_ENABLE_CYCLE");
    checks.push({
      name: `candidate_safety:${candidate.sidecar}`,
      status:
        safeArgs && !enableEnv && candidate.safetyMode === "dry_run_write_receipt"
          ? "pass"
          : "fail",
      detail: `safetyMode=${candidate.safetyMode}; safeArgs=${safeArgs}; enableEnv=${enableEnv}`,
    });
    checks.push({
      name: `current_plist_backup_source:${candidate.sidecar}`,
      status: candidate.currentPlistExists && candidate.currentPlistSha256 ? "pass" : "fail",
      detail: candidate.currentPlistExists
        ? `currentSha256=${candidate.currentPlistSha256}`
        : `current plist missing: ${candidate.currentPlistPath}`,
    });
  }
  return checks;
}

export function buildInstallPreflightReport(params: {
  targetRoot: string;
  legacyRoot: string;
  outputDir: string;
  generatedAt?: string;
  schedulerReport?: SchedulerDryRunReport;
  hostWatchdogReport?: HostWatchdogDryRunReport;
  plan?: LaunchAgentPlan;
  commandChecks?: InstallPreflightCheck[];
  plistChecks?: InstallPreflightCheck[];
}): InstallPreflightReport {
  const schedulerReport =
    params.schedulerReport ??
    buildSchedulerDryRunReport({
      legacyRoot: params.legacyRoot,
      targetRoot: params.targetRoot,
      plistPath: SCHEDULER_PLIST,
    });
  const hostWatchdogReport =
    params.hostWatchdogReport ??
    buildHostWatchdogDryRunReport({
      legacyRoot: params.legacyRoot,
      targetRoot: params.targetRoot,
      plistPath: HOST_WATCHDOG_PLIST,
    });
  const plan =
    params.plan ??
    buildLaunchAgentPlan({
      legacyRoot: params.legacyRoot,
      targetRoot: params.targetRoot,
      outputDir: params.outputDir,
    });

  const checks = [
    sidecarReportCheck("scheduler_root_drift_gate", schedulerReport),
    sidecarReportCheck("host_watchdog_root_drift_gate", hostWatchdogReport),
    ...planSafetyChecks(plan),
    ...(params.plistChecks ?? plistLintChecks(plan)),
    ...(params.commandChecks ?? [
      runCommand(["python3", "daily_learning_runner.py", "--dry-run"], params.targetRoot),
      runCommand(["python3", "scripts/lobster_host_watchdog.py", "--dry-run"], params.targetRoot),
    ]),
  ];
  const blockedReasons = checks
    .filter((check) => check.status === "fail")
    .map((check) => `${check.name}: ${check.detail}`);
  const readyForManualInstall = blockedReasons.length === 0;
  return {
    schemaVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    targetRoot: params.targetRoot,
    legacyRoot: params.legacyRoot,
    readyForManualInstall,
    noLiveLaunchAgentChange: true,
    checks,
    blockedReasons,
    nextStep: readyForManualInstall
      ? "Manual install can be considered, but only with explicit operator approval and backup/rollback receipts."
      : "Do not install or modify live LaunchAgents; fix the failing preflight checks first.",
  };
}

function renderText(report: InstallPreflightReport): string {
  const lines = [
    `installPreflight=${report.readyForManualInstall ? "ready_for_manual_install" : "blocked"}`,
    `noLiveLaunchAgentChange=${report.noLiveLaunchAgentChange}`,
  ];
  for (const check of report.checks) {
    lines.push(`${check.name}=${check.status}`);
  }
  for (const reason of report.blockedReasons) {
    lines.push(`blockedReason=${reason}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const report = buildInstallPreflightReport(args);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  return args.requireReady && !report.readyForManualInstall ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
