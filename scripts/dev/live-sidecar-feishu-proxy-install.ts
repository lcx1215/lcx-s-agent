import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RUNTIME_BUNDLE_ROOT } from "./live-sidecar-runtime-bundle.ts";

const LABEL = "ai.openclaw.feishu.proxy";
const PLIST_PATH = `/Users/liuchengxu/Library/LaunchAgents/${LABEL}.plist`;
const DEFAULT_OUTPUT_DIR = "ops/live-handoff/launchagent-candidates";
const RECEIPT_NAME = "live-sidecar-feishu-proxy-install-receipt.json";

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

export type FeishuProxyInstallReceipt = {
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
  health: Record<string, unknown> | null;
  rollbackCommands: string[];
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

function renderPlist(targetRoot: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/python3</string>
    <string>${xmlEscape(path.join(targetRoot, "feishu_event_proxy.py"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(targetRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/liuchengxu/.openclaw/logs/feishu_proxy.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/liuchengxu/.openclaw/logs/feishu_proxy.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
    <key>LC_ALL</key>
    <string>en_US.UTF-8</string>
    <key>PYTHONIOENCODING</key>
    <string>utf-8</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/Users/liuchengxu/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LOBSTER_PROXY_PORT</key>
    <string>3011</string>
    <key>OPENCLAW_ROOT</key>
    <string>${xmlEscape(targetRoot)}</string>
    <key>OPENCLAW_BIN</key>
    <string>${xmlEscape(path.join(targetRoot, "send_feishu_reply.sh"))}</string>
    <key>ORIGINAL_FEISHU_URL</key>
    <string>http://127.0.0.1:3000/feishu/events</string>
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

function parseHealth(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function probeHealthWithRetry(targetRoot: string): CommandResult {
  return run(
    "bash",
    [
      "-lc",
      [
        "for i in 1 2 3 4 5 6 7 8 9 10; do",
        "  curl -sS --max-time 5 http://127.0.0.1:3011/healthz && exit 0;",
        "  sleep 1;",
        "done;",
        "curl -sS --max-time 5 http://127.0.0.1:3011/healthz",
      ].join(" "),
    ],
    targetRoot,
  );
}

function blockedReasons(targetRoot: string): string[] {
  const reasons: string[] = [];
  if (targetRoot.split(path.sep).includes("Desktop")) {
    reasons.push("target root must not be under Desktop");
  }
  for (const relativePath of [
    "feishu_event_proxy.py",
    "send_feishu_reply.sh",
    "scripts/learning_goal_registry.py",
  ]) {
    if (!fs.existsSync(path.join(targetRoot, relativePath))) {
      reasons.push(`runtime dependency missing: ${relativePath}`);
    }
  }
  if (!fs.existsSync(PLIST_PATH)) {
    reasons.push(`current Feishu proxy plist missing: ${PLIST_PATH}`);
  }
  return reasons;
}

export function buildFeishuProxyInstallReceipt(params: {
  targetRoot: string;
  outputDir: string;
  execute?: boolean;
  generatedAt?: string;
}): FeishuProxyInstallReceipt {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const targetRoot = path.resolve(params.targetRoot);
  const outputDir = path.resolve(params.outputDir);
  const reasons = blockedReasons(targetRoot);
  const commandResults: CommandResult[] = [];
  const backupPath = `${PLIST_PATH}.backup-${timestampForPath(generatedAt)}`;

  if (params.execute && reasons.length === 0) {
    fs.copyFileSync(PLIST_PATH, backupPath);
    fs.writeFileSync(PLIST_PATH, renderPlist(targetRoot), "utf8");
    commandResults.push(run("plutil", ["-lint", PLIST_PATH], targetRoot));
    commandResults.push(
      run("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, PLIST_PATH], targetRoot),
    );
    commandResults.push(
      run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? ""}`, PLIST_PATH], targetRoot),
    );
    commandResults.push(probeHealthWithRetry(targetRoot));
  }

  const healthResult = commandResults.at(-1);
  const health = healthResult ? parseHealth(healthResult.stdout) : null;
  const ok =
    Boolean(params.execute) &&
    reasons.length === 0 &&
    commandResults.length === 4 &&
    commandResults.every((result) => result.code === 0) &&
    health?.ok === true &&
    health?.port === 3011;
  return {
    schemaVersion: 1,
    generatedAt,
    targetRoot,
    receiptPath: path.join(outputDir, RECEIPT_NAME),
    executed: Boolean(params.execute),
    ok,
    blockedReasons: reasons,
    backupPath: params.execute && reasons.length === 0 ? backupPath : null,
    targetPlistSha256: sha256IfExists(PLIST_PATH),
    commandResults,
    health,
    rollbackCommands:
      params.execute && reasons.length === 0
        ? [
            `cp "${backupPath}" "${PLIST_PATH}"`,
            `launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" || true`,
            `launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"`,
          ]
        : [],
    boundary: [
      "Installs only the Feishu/Lark proxy LaunchAgent.",
      "Keeps the existing origin URL http://127.0.0.1:3000/feishu/events.",
      "Does not modify scheduler or host watchdog plists.",
      "Does not send Feishu/Lark messages during install; healthz only.",
    ],
  };
}

function writeReceipt(receipt: FeishuProxyInstallReceipt): void {
  fs.mkdirSync(path.dirname(receipt.receiptPath), { recursive: true });
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function renderText(receipt: FeishuProxyInstallReceipt): string {
  const lines = [
    `feishuProxyInstall=${receipt.ok ? "applied" : "blocked_or_failed"}`,
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
  const receipt = buildFeishuProxyInstallReceipt(args);
  writeReceipt(receipt);
  process.stdout.write(args.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderText(receipt));
  return receipt.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
