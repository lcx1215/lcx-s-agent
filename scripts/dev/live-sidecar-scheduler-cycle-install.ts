import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RUNTIME_BUNDLE_ROOT } from "./live-sidecar-runtime-bundle.ts";

const SCHEDULER_LABEL = "ai.openclaw.lobster.scheduler";
const SCHEDULER_PLIST = `/Users/liuchengxu/Library/LaunchAgents/${SCHEDULER_LABEL}.plist`;
const DEFAULT_OUTPUT_DIR = "ops/live-handoff/launchagent-candidates";
const RECEIPT_NAME = "live-sidecar-scheduler-cycle-install-receipt.json";
const DEFAULT_CYCLE_COMMAND = "pnpm exec tsx scripts/dev/agent-system-loop-smoke.ts";

type Args = {
  targetRoot: string;
  outputDir: string;
  execute: boolean;
  json: boolean;
};

type CommandResult = {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
};

export type SchedulerCycleInstallReceipt = {
  schemaVersion: 1;
  generatedAt: string;
  targetRoot: string;
  receiptPath: string;
  executed: boolean;
  ok: boolean;
  blockedReasons: string[];
  backupPath: string | null;
  targetPlistSha256: string | null;
  commandResults: CommandResult[];
  boundary: string[];
};

function parseArgs(argv: string[]): Args {
  const readValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    targetRoot: path.resolve(readValue("--target-root") ?? DEFAULT_RUNTIME_BUNDLE_ROOT),
    outputDir: path.resolve(readValue("--output-dir") ?? DEFAULT_OUTPUT_DIR),
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sha256IfExists(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function timestampForPath(generatedAt: string): string {
  return generatedAt.replace(/[:.]/gu, "-");
}

function renderSchedulerPlist(targetRoot: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SCHEDULER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>${xmlEscape(path.join(targetRoot, "daily_learning_runner.py"))}</string>
    <string>--write-receipt</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(targetRoot)}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/liuchengxu/.openclaw/logs/lobster_scheduler.cycle.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/liuchengxu/.openclaw/logs/lobster_scheduler.cycle.err.log</string>
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
    <key>OPENCLAW_SCHEDULER_ENABLE_CYCLE</key>
    <string>1</string>
    <key>OPENCLAW_SCHEDULER_CYCLE_COMMAND</key>
    <string>${xmlEscape(DEFAULT_CYCLE_COMMAND)}</string>
  </dict>
</dict>
</plist>
`;
}

function run(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command: [command, ...args].join(" "),
    code: result.status,
    stdout: (result.stdout || "").slice(-4000),
    stderr: (result.stderr || "").slice(-4000),
  };
}

function buildBlockedReasons(targetRoot: string): string[] {
  const reasons: string[] = [];
  if (targetRoot.split(path.sep).includes("Desktop")) {
    reasons.push("target root must not be under Desktop");
  }
  for (const relativePath of [
    "daily_learning_runner.py",
    "lobster_orchestrator.py",
    "scripts/dev/agent-system-loop-smoke.ts",
    "node_modules/.bin/tsx",
  ]) {
    if (!fs.existsSync(path.join(targetRoot, relativePath))) {
      reasons.push(`runtime dependency missing: ${relativePath}`);
    }
  }
  if (!fs.existsSync(SCHEDULER_PLIST)) {
    reasons.push(`current scheduler plist missing: ${SCHEDULER_PLIST}`);
  }
  return reasons;
}

export function buildSchedulerCycleInstallReceipt(params: {
  targetRoot: string;
  outputDir: string;
  execute?: boolean;
  generatedAt?: string;
}): SchedulerCycleInstallReceipt {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const targetRoot = path.resolve(params.targetRoot);
  const outputDir = path.resolve(params.outputDir);
  const blockedReasons = buildBlockedReasons(targetRoot);
  const commandResults: CommandResult[] = [];
  const backupPath = `${SCHEDULER_PLIST}.backup-${timestampForPath(generatedAt)}`;

  if (params.execute && blockedReasons.length === 0) {
    fs.copyFileSync(SCHEDULER_PLIST, backupPath);
    fs.writeFileSync(SCHEDULER_PLIST, renderSchedulerPlist(targetRoot), "utf8");
    commandResults.push(run("plutil", ["-lint", SCHEDULER_PLIST], targetRoot));
    commandResults.push(
      run("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, SCHEDULER_PLIST], targetRoot),
    );
    commandResults.push(
      run(
        "launchctl",
        ["bootstrap", `gui/${process.getuid?.() ?? ""}`, SCHEDULER_PLIST],
        targetRoot,
      ),
    );
    commandResults.push(
      run(
        "launchctl",
        ["kickstart", "-k", `gui/${process.getuid?.() ?? ""}/${SCHEDULER_LABEL}`],
        targetRoot,
      ),
    );
  }

  const ok =
    Boolean(params.execute) &&
    blockedReasons.length === 0 &&
    commandResults.length === 4 &&
    commandResults.every((result) => result.code === 0);
  return {
    schemaVersion: 1,
    generatedAt,
    targetRoot,
    receiptPath: path.join(outputDir, RECEIPT_NAME),
    executed: Boolean(params.execute),
    ok,
    blockedReasons,
    backupPath: params.execute && blockedReasons.length === 0 ? backupPath : null,
    targetPlistSha256: sha256IfExists(SCHEDULER_PLIST),
    commandResults,
    boundary: [
      "Installs only the scheduler LaunchAgent.",
      "Does not modify Feishu/Lark proxy or host watchdog plist.",
      "Runs the bounded agent-system loop command and writes scheduler receipts.",
      "Does not grant trading execution authority.",
    ],
  };
}

function writeReceipt(receipt: SchedulerCycleInstallReceipt): void {
  fs.mkdirSync(path.dirname(receipt.receiptPath), { recursive: true });
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function renderText(receipt: SchedulerCycleInstallReceipt): string {
  const lines = [
    `schedulerCycleInstall=${receipt.ok ? "applied" : "blocked_or_failed"}`,
    `targetRoot=${receipt.targetRoot}`,
    `receiptPath=${receipt.receiptPath}`,
  ];
  for (const reason of receipt.blockedReasons) {
    lines.push(`blockedReason=${reason}`);
  }
  for (const result of receipt.commandResults) {
    lines.push(`${result.command}=exit_${result.code}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const receipt = buildSchedulerCycleInstallReceipt(args);
  writeReceipt(receipt);
  process.stdout.write(args.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderText(receipt));
  return receipt.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
