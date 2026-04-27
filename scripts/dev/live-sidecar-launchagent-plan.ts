import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TARGET_ROOT = "/Users/liuchengxu/Desktop/lcx-s-openclaw";
const DEFAULT_LEGACY_ROOT = "/Users/liuchengxu/Desktop/openclaw";
const DEFAULT_OUTPUT_DIR = "ops/live-handoff/launchagent-candidates";

type SidecarName = "scheduler" | "host_watchdog";

type LaunchAgentCandidate = {
  sidecar: SidecarName;
  label: string;
  candidatePath: string;
  currentPlistPath: string;
  currentPlistExists: boolean;
  currentPlistSha256: string | null;
  programArguments: string[];
  workingDirectory: string;
  standardOutPath: string;
  standardErrorPath: string;
  runAtLoad: boolean;
  startInterval?: number;
  startCalendarInterval?: { Hour: number; Minute: number };
  safetyMode: "dry_run_write_receipt";
  rollbackCommands: string[];
};

export type LaunchAgentPlan = {
  schemaVersion: 1;
  generatedAt: string;
  targetRoot: string;
  legacyRoot: string;
  outputDir: string;
  noLiveLaunchAgentChange: true;
  candidates: LaunchAgentCandidate[];
  installBoundary: string[];
};

type Args = {
  targetRoot: string;
  legacyRoot: string;
  outputDir: string;
  write: boolean;
  json: boolean;
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
    write: argv.includes("--write"),
    json: argv.includes("--json"),
  };
}

function sha256IfExists(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderStringArray(values: string[]): string {
  return values.map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n");
}

function renderLaunchAgent(candidate: LaunchAgentCandidate): string {
  const schedule = candidate.startCalendarInterval
    ? `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${candidate.startCalendarInterval.Hour}</integer>
    <key>Minute</key>
    <integer>${candidate.startCalendarInterval.Minute}</integer>
  </dict>`
    : `  <key>StartInterval</key>
  <integer>${candidate.startInterval ?? 1800}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(candidate.label)}</string>
  <key>ProgramArguments</key>
  <array>
${renderStringArray(candidate.programArguments)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(candidate.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <${candidate.runAtLoad ? "true" : "false"}/>
${schedule}
  <key>StandardOutPath</key>
  <string>${xmlEscape(candidate.standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(candidate.standardErrorPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/liuchengxu</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
    <key>LC_ALL</key>
    <string>en_US.UTF-8</string>
    <key>PYTHONIOENCODING</key>
    <string>utf-8</string>
    <key>PATH</key>
    <string>/Users/liuchengxu/.local/bin:/Users/liuchengxu/.npm-global/bin:/Users/liuchengxu/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function currentPlistPath(label: string): string {
  return `/Users/liuchengxu/Library/LaunchAgents/${label}.plist`;
}

function buildRollbackCommands(label: string, legacyRoot: string): string[] {
  const plistPath = currentPlistPath(label);
  return [
    `cp "${plistPath}.bak" "${plistPath}"`,
    `launchctl bootout "gui/$(id -u)" "${plistPath}" || true`,
    `launchctl bootstrap "gui/$(id -u)" "${plistPath}"`,
    `cd "${legacyRoot}" && python3 -m py_compile daily_learning_runner.py scripts/lobster_host_watchdog.py scripts/lobster_paths.py`,
  ];
}

export function buildLaunchAgentPlan(params: {
  targetRoot: string;
  legacyRoot: string;
  outputDir: string;
  generatedAt?: string;
}): LaunchAgentPlan {
  const schedulerLabel = "ai.openclaw.lobster.scheduler";
  const hostWatchdogLabel = "ai.openclaw.lobster.host_watchdog";
  const candidates: LaunchAgentCandidate[] = [
    {
      sidecar: "scheduler",
      label: schedulerLabel,
      candidatePath: path.join(params.outputDir, `${schedulerLabel}.smoke.plist`),
      currentPlistPath: currentPlistPath(schedulerLabel),
      currentPlistExists: fs.existsSync(currentPlistPath(schedulerLabel)),
      currentPlistSha256: sha256IfExists(currentPlistPath(schedulerLabel)),
      programArguments: [
        "/usr/bin/python3",
        path.join(params.targetRoot, "daily_learning_runner.py"),
        "--dry-run",
        "--write-receipt",
      ],
      workingDirectory: params.targetRoot,
      standardOutPath: "/Users/liuchengxu/.openclaw/logs/lobster_scheduler.smoke.out.log",
      standardErrorPath: "/Users/liuchengxu/.openclaw/logs/lobster_scheduler.smoke.err.log",
      runAtLoad: false,
      startCalendarInterval: { Hour: 2, Minute: 30 },
      safetyMode: "dry_run_write_receipt",
      rollbackCommands: buildRollbackCommands(schedulerLabel, params.legacyRoot),
    },
    {
      sidecar: "host_watchdog",
      label: hostWatchdogLabel,
      candidatePath: path.join(params.outputDir, `${hostWatchdogLabel}.smoke.plist`),
      currentPlistPath: currentPlistPath(hostWatchdogLabel),
      currentPlistExists: fs.existsSync(currentPlistPath(hostWatchdogLabel)),
      currentPlistSha256: sha256IfExists(currentPlistPath(hostWatchdogLabel)),
      programArguments: [
        "/usr/bin/python3",
        path.join(params.targetRoot, "scripts/lobster_host_watchdog.py"),
        "--dry-run",
        "--write-receipt",
      ],
      workingDirectory: params.targetRoot,
      standardOutPath: "/Users/liuchengxu/.openclaw/logs/lobster_host_watchdog.smoke.out.log",
      standardErrorPath: "/Users/liuchengxu/.openclaw/logs/lobster_host_watchdog.smoke.err.log",
      runAtLoad: true,
      startInterval: 1800,
      safetyMode: "dry_run_write_receipt",
      rollbackCommands: buildRollbackCommands(hostWatchdogLabel, params.legacyRoot),
    },
  ];
  return {
    schemaVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    targetRoot: params.targetRoot,
    legacyRoot: params.legacyRoot,
    outputDir: params.outputDir,
    noLiveLaunchAgentChange: true,
    candidates,
    installBoundary: [
      "This script only generates candidate plists and a plan JSON.",
      "Do not copy these candidates into ~/Library/LaunchAgents without an explicit live migration step.",
      "Candidates use --dry-run --write-receipt and do not enable unattended live cycles.",
      "Production scheduler cycle requires a separate approval and OPENCLAW_SCHEDULER_ENABLE_CYCLE=1.",
    ],
  };
}

function writePlan(plan: LaunchAgentPlan): void {
  fs.mkdirSync(plan.outputDir, { recursive: true });
  for (const candidate of plan.candidates) {
    fs.writeFileSync(candidate.candidatePath, renderLaunchAgent(candidate), "utf8");
  }
  fs.writeFileSync(
    path.join(plan.outputDir, "live-sidecar-launchagent-plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8",
  );
}

function renderText(plan: LaunchAgentPlan): string {
  const lines = [
    "launchAgentPlan=generated_no_live_change",
    `targetRoot=${plan.targetRoot}`,
    `outputDir=${plan.outputDir}`,
  ];
  for (const candidate of plan.candidates) {
    lines.push(
      `${candidate.sidecar}.candidate=${candidate.candidatePath}`,
      `${candidate.sidecar}.safetyMode=${candidate.safetyMode}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const plan = buildLaunchAgentPlan(args);
  if (args.write) {
    writePlan(plan);
  }
  process.stdout.write(args.json ? `${JSON.stringify(plan, null, 2)}\n` : renderText(plan));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
