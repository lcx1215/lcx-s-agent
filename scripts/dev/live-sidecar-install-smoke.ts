import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildInstallDryRunReceipt,
  type InstallDryRunReceipt,
  type SidecarInstallDryRunAction,
} from "./live-sidecar-install-dry-run.ts";

const DEFAULT_TARGET_ROOT = "/Users/liuchengxu/Desktop/lcx-s-openclaw";
const DEFAULT_LEGACY_ROOT = "/Users/liuchengxu/Desktop/openclaw";
const DEFAULT_OUTPUT_DIR = "ops/live-handoff/launchagent-candidates";
const SMOKE_RECEIPT_NAME = "live-sidecar-install-smoke-receipt.json";

type Args = {
  targetRoot: string;
  legacyRoot: string;
  outputDir: string;
  executeSmoke: boolean;
  allowDesktopTarget: boolean;
  json: boolean;
};

type CommandResult = {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
};

type SmokeActionResult = {
  sidecar: string;
  label: string;
  targetPlistPath: string;
  backupPath: string;
  expectedTargetSha256: string | null;
  actualTargetSha256: string | null;
  backupCreated: boolean;
  copiedCandidate: boolean;
  targetShaMatches: boolean;
  commandResults: CommandResult[];
  ok: boolean;
};

export type SmokeInstallReceipt = {
  schemaVersion: 1;
  generatedAt: string;
  sourceDryRunReceiptPath: string;
  receiptPath: string;
  liveLaunchAgentChanged: boolean;
  smokeModeOnly: true;
  preflightReady: boolean;
  blockedReasons: string[];
  actions: SmokeActionResult[];
  rollbackCommands: string[];
  executionBoundary: string[];
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
    executeSmoke: argv.includes("--execute-smoke"),
    allowDesktopTarget: argv.includes("--allow-desktop-target"),
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

function timestampForPath(generatedAt: string): string {
  return generatedAt.replace(/[:.]/gu, "-");
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
    stdout: (result.stdout || "").slice(0, 4000),
    stderr: (result.stderr || "").slice(0, 4000),
  };
}

function candidateIsSmokeOnly(action: SidecarInstallDryRunAction): boolean {
  let text = "";
  try {
    text = fs.readFileSync(action.sourceCandidatePath, "utf8");
  } catch {
    return false;
  }
  return (
    text.includes("<string>--dry-run</string>") &&
    text.includes("<string>--write-receipt</string>") &&
    !text.includes("OPENCLAW_SCHEDULER_ENABLE_CYCLE")
  );
}

function executeAction(action: SidecarInstallDryRunAction, cwd: string): SmokeActionResult {
  const commandResults: CommandResult[] = [];
  if (!candidateIsSmokeOnly(action)) {
    return {
      sidecar: action.sidecar,
      label: action.label,
      targetPlistPath: action.targetPlistPath,
      backupPath: action.backupPath,
      expectedTargetSha256: action.expectedTargetSha256AfterCopy,
      actualTargetSha256: sha256IfExists(action.targetPlistPath),
      backupCreated: false,
      copiedCandidate: false,
      targetShaMatches: false,
      commandResults,
      ok: false,
    };
  }

  fs.copyFileSync(action.targetPlistPath, action.backupPath);
  fs.copyFileSync(action.sourceCandidatePath, action.targetPlistPath);
  commandResults.push(run("plutil", ["-lint", action.targetPlistPath], cwd));
  commandResults.push(
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, action.targetPlistPath], cwd),
  );
  commandResults.push(
    run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? ""}`, action.targetPlistPath], cwd),
  );

  const actualTargetSha256 = sha256IfExists(action.targetPlistPath);
  const bootstrap = commandResults.at(-1);
  const lint = commandResults[0];
  const ok =
    lint?.code === 0 &&
    bootstrap?.code === 0 &&
    actualTargetSha256 !== null &&
    actualTargetSha256 === action.expectedTargetSha256AfterCopy;
  return {
    sidecar: action.sidecar,
    label: action.label,
    targetPlistPath: action.targetPlistPath,
    backupPath: action.backupPath,
    expectedTargetSha256: action.expectedTargetSha256AfterCopy,
    actualTargetSha256,
    backupCreated: fs.existsSync(action.backupPath),
    copiedCandidate: true,
    targetShaMatches: actualTargetSha256 === action.expectedTargetSha256AfterCopy,
    commandResults,
    ok,
  };
}

export function buildBlockedReceipt(params: {
  generatedAt: string;
  dryRunReceipt: InstallDryRunReceipt;
  outputDir: string;
  reason: string;
}): SmokeInstallReceipt {
  return {
    schemaVersion: 1,
    generatedAt: params.generatedAt,
    sourceDryRunReceiptPath: params.dryRunReceipt.receiptPath,
    receiptPath: path.join(params.outputDir, SMOKE_RECEIPT_NAME),
    liveLaunchAgentChanged: false,
    smokeModeOnly: true,
    preflightReady: false,
    blockedReasons: [params.reason, ...params.dryRunReceipt.blockedReasons],
    actions: [],
    rollbackCommands: [],
    executionBoundary: [
      "Execution was blocked before any live LaunchAgent change.",
      "No plist was copied.",
      "No backup was written.",
      "No launchctl command was executed.",
    ],
  };
}

function writeReceipt(receipt: SmokeInstallReceipt): void {
  fs.mkdirSync(path.dirname(receipt.receiptPath), { recursive: true });
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function renderText(receipt: SmokeInstallReceipt): string {
  const lines = [
    `installSmoke=${receipt.actions.every((action) => action.ok) && receipt.preflightReady ? "applied" : "blocked_or_failed"}`,
    `smokeModeOnly=${receipt.smokeModeOnly}`,
    `receiptPath=${receipt.receiptPath}`,
  ];
  for (const reason of receipt.blockedReasons) {
    lines.push(`blockedReason=${reason}`);
  }
  for (const action of receipt.actions) {
    lines.push(
      `${action.sidecar}.ok=${action.ok}`,
      `${action.sidecar}.backup=${action.backupPath}`,
      `${action.sidecar}.targetShaMatches=${action.targetShaMatches}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const generatedAt = new Date().toISOString();
  const dryRunReceipt = buildInstallDryRunReceipt({
    targetRoot: args.targetRoot,
    legacyRoot: args.legacyRoot,
    outputDir: args.outputDir,
    generatedAt,
  });
  if (!args.executeSmoke) {
    const blocked = buildBlockedReceipt({
      generatedAt,
      dryRunReceipt,
      outputDir: args.outputDir,
      reason: "missing required --execute-smoke",
    });
    process.stdout.write(args.json ? `${JSON.stringify(blocked, null, 2)}\n` : renderText(blocked));
    return 2;
  }
  if (args.targetRoot.includes("/Desktop/") && !args.allowDesktopTarget) {
    const blocked = buildBlockedReceipt({
      generatedAt,
      dryRunReceipt,
      outputDir: args.outputDir,
      reason:
        "target root is under Desktop; LaunchAgent Python execution may fail with macOS Operation not permitted. Build a non-Desktop runtime bundle or pass --allow-desktop-target explicitly.",
    });
    writeReceipt(blocked);
    process.stdout.write(args.json ? `${JSON.stringify(blocked, null, 2)}\n` : renderText(blocked));
    return 2;
  }
  if (!dryRunReceipt.preflightReady) {
    const blocked = buildBlockedReceipt({
      generatedAt,
      dryRunReceipt,
      outputDir: args.outputDir,
      reason: "preflight was not ready",
    });
    writeReceipt(blocked);
    process.stdout.write(args.json ? `${JSON.stringify(blocked, null, 2)}\n` : renderText(blocked));
    return 1;
  }

  const stamp = timestampForPath(generatedAt);
  const actions = dryRunReceipt.actions.map((action) =>
    executeAction(
      {
        ...action,
        backupPath: `${action.targetPlistPath}.backup-${stamp}`,
      },
      args.targetRoot,
    ),
  );
  const receipt: SmokeInstallReceipt = {
    schemaVersion: 1,
    generatedAt,
    sourceDryRunReceiptPath: dryRunReceipt.receiptPath,
    receiptPath: path.join(args.outputDir, SMOKE_RECEIPT_NAME),
    liveLaunchAgentChanged: true,
    smokeModeOnly: true,
    preflightReady: true,
    blockedReasons: [],
    actions,
    rollbackCommands: actions.flatMap((action) => [
      `cp "${action.backupPath}" "${action.targetPlistPath}"`,
      `launchctl bootout "gui/$(id -u)" "${action.targetPlistPath}" || true`,
      `launchctl bootstrap "gui/$(id -u)" "${action.targetPlistPath}"`,
    ]),
    executionBoundary: [
      "Live LaunchAgent plist files were replaced with smoke-mode candidates.",
      "Smoke-mode candidates include --dry-run --write-receipt.",
      "Unattended live cycle remains disabled.",
      "Rollback commands are recorded in this receipt.",
    ],
  };
  writeReceipt(receipt);
  process.stdout.write(args.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderText(receipt));
  return actions.every((action) => action.ok) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
