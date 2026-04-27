import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_LEGACY_ROOT = "/Users/liuchengxu/Desktop/openclaw";
const DEFAULT_SCHEDULER_PLIST =
  "/Users/liuchengxu/Library/LaunchAgents/ai.openclaw.lobster.scheduler.plist";

const REQUIRED_SCHEDULER_FILES = [
  "daily_learning_runner.py",
  "scripts/lobster_paths.py",
  "lobster_orchestrator.py",
] as const;

const STATE_FILES = [
  "branches/_system/scheduler_heartbeat.json",
  "branches/_system/branch_state.json",
  "branches/_system/branch_scheduler.json",
] as const;

type FileCheck = {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  trackedByGit: boolean | null;
};

type StateCheck = {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  summary: Record<string, unknown> | null;
};

export type SchedulerDryRunReport = {
  schemaVersion: 1;
  mode: "dry_run_no_launchagent_change_no_lark_send";
  checkedAt: string;
  legacyRoot: string;
  targetRoot: string;
  launchAgent: {
    plistPath: string;
    exists: boolean;
    programArguments: string[];
    workingDirectory: string | null;
    pointsAtLegacyRoot: boolean;
  };
  legacyRequiredFiles: FileCheck[];
  targetRequiredFiles: FileCheck[];
  stateFiles: StateCheck[];
  migrationReady: boolean;
  blockedReasons: string[];
  nextSafePatch: string[];
};

type Args = {
  legacyRoot: string;
  targetRoot: string;
  plistPath: string;
  json: boolean;
  requireReady: boolean;
};

function parseArgs(argv: string[]): Args {
  const readValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    legacyRoot: path.resolve(readValue("--legacy-root") ?? DEFAULT_LEGACY_ROOT),
    targetRoot: path.resolve(readValue("--target-root") ?? process.cwd()),
    plistPath: path.resolve(readValue("--plist") ?? DEFAULT_SCHEDULER_PLIST),
    json: argv.includes("--json"),
    requireReady: argv.includes("--require-ready"),
  };
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function gitTracks(root: string, relativePath: string): boolean | null {
  if (!fileExists(path.join(root, ".git")) && !fs.existsSync(path.join(root, ".git"))) {
    return null;
  }
  const result = spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", relativePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

function checkFiles(root: string, files: readonly string[]): FileCheck[] {
  return files.map((relativePath) => {
    const absolutePath = path.join(root, relativePath);
    return {
      relativePath,
      absolutePath,
      exists: fileExists(absolutePath),
      trackedByGit: gitTracks(root, relativePath),
    };
  });
}

function summarizeJson(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "status",
    "last_started_at",
    "last_finished_at",
    "last_success_at",
    "last_exit_code",
    "active_branch",
    "updated_at",
  ]) {
    if (key in record) {
      summary[key] = record[key];
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function checkStateFiles(root: string): StateCheck[] {
  return STATE_FILES.map((relativePath) => {
    const absolutePath = path.join(root, relativePath);
    let summary: Record<string, unknown> | null = null;
    if (fileExists(absolutePath)) {
      try {
        summary = summarizeJson(JSON.parse(fs.readFileSync(absolutePath, "utf8")));
      } catch {
        summary = { unreadable: true };
      }
    }
    return {
      relativePath,
      absolutePath,
      exists: fileExists(absolutePath),
      summary,
    };
  });
}

function extractFirstStringArrayAfterKey(xml: string, keyName: string): string[] {
  const keyIndex = xml.indexOf(`<key>${keyName}</key>`);
  if (keyIndex === -1) {
    return [];
  }
  const arrayStart = xml.indexOf("<array>", keyIndex);
  const arrayEnd = xml.indexOf("</array>", arrayStart);
  if (arrayStart === -1 || arrayEnd === -1) {
    return [];
  }
  const arrayBody = xml.slice(arrayStart, arrayEnd);
  return Array.from(arrayBody.matchAll(/<string>(.*?)<\/string>/gs), (match) =>
    decodeXml(match[1] ?? ""),
  );
}

function extractStringAfterKey(xml: string, keyName: string): string | null {
  const keyIndex = xml.indexOf(`<key>${keyName}</key>`);
  if (keyIndex === -1) {
    return null;
  }
  const match = xml.slice(keyIndex).match(/<string>(.*?)<\/string>/s);
  return match?.[1] ? decodeXml(match[1]) : null;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function inspectLaunchAgent(plistPath: string, legacyRoot: string) {
  const exists = fileExists(plistPath);
  const xml = readTextIfExists(plistPath);
  const programArguments = exists ? extractFirstStringArrayAfterKey(xml, "ProgramArguments") : [];
  const workingDirectory = exists ? extractStringAfterKey(xml, "WorkingDirectory") : null;
  return {
    plistPath,
    exists,
    programArguments,
    workingDirectory,
    pointsAtLegacyRoot:
      programArguments.some((entry) => entry.startsWith(legacyRoot)) ||
      workingDirectory === legacyRoot,
  };
}

export function buildSchedulerDryRunReport(params: {
  legacyRoot: string;
  targetRoot: string;
  plistPath: string;
  checkedAt?: string;
}): SchedulerDryRunReport {
  const legacyRequiredFiles = checkFiles(params.legacyRoot, REQUIRED_SCHEDULER_FILES);
  const targetRequiredFiles = checkFiles(params.targetRoot, REQUIRED_SCHEDULER_FILES);
  const stateFiles = checkStateFiles(params.legacyRoot);
  const launchAgent = inspectLaunchAgent(params.plistPath, params.legacyRoot);

  const blockedReasons: string[] = [];
  const missingLegacy = legacyRequiredFiles.filter((entry) => !entry.exists);
  const missingTarget = targetRequiredFiles.filter((entry) => !entry.exists);
  const untrackedTarget = targetRequiredFiles.filter(
    (entry) => entry.exists && entry.trackedByGit === false,
  );
  if (!launchAgent.exists) {
    blockedReasons.push("scheduler LaunchAgent plist was not found");
  } else if (!launchAgent.pointsAtLegacyRoot) {
    blockedReasons.push("scheduler LaunchAgent no longer points at the audited legacy root");
  }
  if (missingLegacy.length > 0) {
    blockedReasons.push(
      `legacy scheduler dependency missing: ${missingLegacy.map((entry) => entry.relativePath).join(", ")}`,
    );
  }
  if (missingTarget.length > 0) {
    blockedReasons.push(
      `target clean repo still lacks scheduler dependency: ${missingTarget.map((entry) => entry.relativePath).join(", ")}`,
    );
  }
  if (untrackedTarget.length > 0) {
    blockedReasons.push(
      `target scheduler dependency exists but is not tracked by Git: ${untrackedTarget.map((entry) => entry.relativePath).join(", ")}`,
    );
  }

  const migrationReady = blockedReasons.length === 0;
  return {
    schemaVersion: 1,
    mode: "dry_run_no_launchagent_change_no_lark_send",
    checkedAt: params.checkedAt ?? new Date().toISOString(),
    legacyRoot: params.legacyRoot,
    targetRoot: params.targetRoot,
    launchAgent,
    legacyRequiredFiles,
    targetRequiredFiles,
    stateFiles,
    migrationReady,
    blockedReasons,
    nextSafePatch: migrationReady
      ? [
          "Install a new scheduler LaunchAgent only after the runtime bundle and smoke receipt pass.",
          "Keep Feishu/Lark proxy unchanged until scheduler and watchdog root drift are resolved.",
        ]
      : [
          "Port only the missing scheduler dependency chain into the clean repo or runtime bundle.",
          "Add a no-network scheduler smoke before changing the macOS LaunchAgent.",
          "Leave Feishu/Lark proxy and live plist untouched until the smoke is ready.",
        ],
  };
}

function renderText(report: SchedulerDryRunReport): string {
  const lines = [
    `schedulerDryRun=${report.migrationReady ? "migration_ready" : "blocked"}`,
    `mode=${report.mode}`,
    `legacyRoot=${report.legacyRoot}`,
    `targetRoot=${report.targetRoot}`,
    `launchAgent.pointsAtLegacyRoot=${report.launchAgent.pointsAtLegacyRoot}`,
  ];
  for (const reason of report.blockedReasons) {
    lines.push(`blockedReason=${reason}`);
  }
  for (const file of report.targetRequiredFiles.filter((entry) => !entry.exists)) {
    lines.push(`missingTargetFile=${file.relativePath}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const report = buildSchedulerDryRunReport(args);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  return args.requireReady && !report.migrationReady ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
