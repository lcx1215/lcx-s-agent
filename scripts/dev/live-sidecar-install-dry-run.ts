import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildInstallPreflightReport,
  type InstallPreflightReport,
} from "./live-sidecar-install-preflight.ts";
import { buildLaunchAgentPlan, type LaunchAgentPlan } from "./live-sidecar-launchagent-plan.ts";
import { DEFAULT_RUNTIME_BUNDLE_ROOT } from "./live-sidecar-runtime-bundle.ts";

const DEFAULT_TARGET_ROOT = DEFAULT_RUNTIME_BUNDLE_ROOT;
const DEFAULT_LEGACY_ROOT = "/Users/liuchengxu/Desktop/openclaw";
const DEFAULT_OUTPUT_DIR = "ops/live-handoff/launchagent-candidates";
const RECEIPT_NAME = "live-sidecar-install-dry-run-receipt.json";

type Args = {
  targetRoot: string;
  legacyRoot: string;
  outputDir: string;
  write: boolean;
  json: boolean;
};

export type SidecarInstallDryRunAction = {
  sidecar: string;
  label: string;
  sourceCandidatePath: string;
  targetPlistPath: string;
  backupPath: string;
  sourceCandidateSha256: string | null;
  currentPlistSha256: string | null;
  expectedTargetSha256AfterCopy: string | null;
  currentDiffSummary: {
    changed: boolean;
    removedLineCount: number;
    addedLineCount: number;
    preview: string[];
  };
  wouldRun: string[];
  rollbackCommands: string[];
};

export type InstallDryRunReceipt = {
  schemaVersion: 1;
  generatedAt: string;
  targetRoot: string;
  legacyRoot: string;
  outputDir: string;
  receiptPath: string;
  noLiveLaunchAgentChange: true;
  preflightReady: boolean;
  blockedReasons: string[];
  actions: SidecarInstallDryRunAction[];
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

function readLinesIfExists(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
  } catch {
    return [];
  }
}

function diffSummary(
  currentPath: string,
  candidatePath: string,
): SidecarInstallDryRunAction["currentDiffSummary"] {
  const current = readLinesIfExists(currentPath);
  const candidate = readLinesIfExists(candidatePath);
  const currentSet = new Set(current);
  const candidateSet = new Set(candidate);
  const removed = current.filter((line) => !candidateSet.has(line));
  const added = candidate.filter((line) => !currentSet.has(line));
  return {
    changed: sha256IfExists(currentPath) !== sha256IfExists(candidatePath),
    removedLineCount: removed.length,
    addedLineCount: added.length,
    preview: [
      ...removed.slice(0, 6).map((line) => `- ${line}`),
      ...added.slice(0, 6).map((line) => `+ ${line}`),
    ],
  };
}

function timestampForPath(generatedAt: string): string {
  return generatedAt.replace(/[:.]/gu, "-");
}

export function buildInstallDryRunReceipt(params: {
  targetRoot: string;
  legacyRoot: string;
  outputDir: string;
  generatedAt?: string;
  plan?: LaunchAgentPlan;
  preflight?: InstallPreflightReport;
}): InstallDryRunReceipt {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const plan =
    params.plan ??
    buildLaunchAgentPlan({
      targetRoot: params.targetRoot,
      legacyRoot: params.legacyRoot,
      outputDir: params.outputDir,
    });
  const preflight =
    params.preflight ??
    buildInstallPreflightReport({
      targetRoot: params.targetRoot,
      legacyRoot: params.legacyRoot,
      outputDir: params.outputDir,
      plan,
    });
  const stamp = timestampForPath(generatedAt);
  const actions = plan.candidates.map((candidate): SidecarInstallDryRunAction => {
    const backupPath = `${candidate.currentPlistPath}.backup-${stamp}`;
    return {
      sidecar: candidate.sidecar,
      label: candidate.label,
      sourceCandidatePath: candidate.candidatePath,
      targetPlistPath: candidate.currentPlistPath,
      backupPath,
      sourceCandidateSha256: sha256IfExists(candidate.candidatePath),
      currentPlistSha256: sha256IfExists(candidate.currentPlistPath),
      expectedTargetSha256AfterCopy: sha256IfExists(candidate.candidatePath),
      currentDiffSummary: diffSummary(candidate.currentPlistPath, candidate.candidatePath),
      wouldRun: [
        `cp "${candidate.currentPlistPath}" "${backupPath}"`,
        `cp "${candidate.candidatePath}" "${candidate.currentPlistPath}"`,
        `launchctl bootout "gui/$(id -u)" "${candidate.currentPlistPath}" || true`,
        `launchctl bootstrap "gui/$(id -u)" "${candidate.currentPlistPath}"`,
      ],
      rollbackCommands: [
        `cp "${backupPath}" "${candidate.currentPlistPath}"`,
        `launchctl bootout "gui/$(id -u)" "${candidate.currentPlistPath}" || true`,
        `launchctl bootstrap "gui/$(id -u)" "${candidate.currentPlistPath}"`,
      ],
    };
  });
  return {
    schemaVersion: 1,
    generatedAt,
    targetRoot: params.targetRoot,
    legacyRoot: params.legacyRoot,
    outputDir: params.outputDir,
    receiptPath: path.join(params.outputDir, RECEIPT_NAME),
    noLiveLaunchAgentChange: true,
    preflightReady: preflight.readyForManualInstall,
    blockedReasons: preflight.blockedReasons,
    actions,
    executionBoundary: [
      "This receipt is dry-run only.",
      "No plist was copied.",
      "No backup was written.",
      "No launchctl command was executed.",
      "Candidates remain smoke-mode LaunchAgents with --dry-run --write-receipt.",
    ],
  };
}

function writeReceipt(receipt: InstallDryRunReceipt): void {
  fs.mkdirSync(path.dirname(receipt.receiptPath), { recursive: true });
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function renderText(receipt: InstallDryRunReceipt): string {
  const lines = [
    `installDryRun=${receipt.preflightReady ? "ready_receipt_generated" : "blocked"}`,
    `noLiveLaunchAgentChange=${receipt.noLiveLaunchAgentChange}`,
    `receiptPath=${receipt.receiptPath}`,
  ];
  for (const action of receipt.actions) {
    lines.push(
      `${action.sidecar}.target=${action.targetPlistPath}`,
      `${action.sidecar}.backup=${action.backupPath}`,
      `${action.sidecar}.changed=${action.currentDiffSummary.changed}`,
    );
  }
  for (const reason of receipt.blockedReasons) {
    lines.push(`blockedReason=${reason}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const receipt = buildInstallDryRunReceipt(args);
  if (args.write) {
    writeReceipt(receipt);
  }
  process.stdout.write(args.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderText(receipt));
  return receipt.preflightReady ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
