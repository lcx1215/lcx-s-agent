import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RUNTIME_BUNDLE_ROOT } from "./live-sidecar-runtime-bundle.ts";

const DEFAULT_SOURCE_ROOT = process.cwd();
const DEFAULT_OUTPUT_DIR = "ops/live-handoff/launchagent-candidates";
const RECEIPT_NAME = "live-sidecar-runtime-freshness-receipt.json";
const RUNTIME_STATE_NAME = "branches/_system/runtime_freshness.json";
const SAMPLE_LIMIT = 50;

type Args = {
  sourceRoot: string;
  targetRoot: string;
  outputDir: string;
  write: boolean;
  writeRuntimeState: boolean;
  json: boolean;
};

export type RuntimeFreshnessReceipt = {
  schemaVersion: 1;
  generatedAt: string;
  sourceRoot: string;
  targetRoot: string;
  receiptPath: string;
  runtimeStatePath: string;
  status: "fresh" | "stale" | "blocked";
  readyForLaunchAgent: boolean;
  blockedReasons: string[];
  checkedFileCount: number;
  missingCount: number;
  mismatchCount: number;
  sampleMissing: string[];
  sampleMismatched: string[];
  boundary: string[];
};

function parseArgs(argv: string[]): Args {
  const readValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    sourceRoot: path.resolve(readValue("--source-root") ?? DEFAULT_SOURCE_ROOT),
    targetRoot: path.resolve(readValue("--target-root") ?? DEFAULT_RUNTIME_BUNDLE_ROOT),
    outputDir: path.resolve(readValue("--output-dir") ?? DEFAULT_OUTPUT_DIR),
    write: argv.includes("--write"),
    writeRuntimeState: argv.includes("--write-runtime-state"),
    json: argv.includes("--json"),
  };
}

function sha256(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function listTrackedComparableFiles(sourceRoot: string): string[] {
  const result = spawnSync("git", ["-C", sourceRoot, "ls-files"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return [];
  }
  return (result.stdout || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("memory/"))
    .filter((line) => !line.startsWith("dist/"))
    .filter((line) => !line.startsWith("apps/"))
    .filter((line) => !line.startsWith("node_modules/"))
    .filter((line) => !line.startsWith("ops/live-handoff/launchagent-candidates/"))
    .toSorted();
}

export function buildRuntimeFreshnessReceipt(params: {
  sourceRoot: string;
  targetRoot: string;
  outputDir: string;
  generatedAt?: string;
}): RuntimeFreshnessReceipt {
  const sourceRoot = path.resolve(params.sourceRoot);
  const targetRoot = path.resolve(params.targetRoot);
  const outputDir = path.resolve(params.outputDir);
  const trackedFiles = listTrackedComparableFiles(sourceRoot);
  const blockedReasons: string[] = [];
  const sampleMissing: string[] = [];
  const sampleMismatched: string[] = [];
  let missingCount = 0;
  let mismatchCount = 0;

  if (sourceRoot === targetRoot) {
    blockedReasons.push("source root and target root must be different");
  }
  if (trackedFiles.length === 0) {
    blockedReasons.push("no git-tracked source files found");
  }

  if (blockedReasons.length === 0) {
    for (const relativePath of trackedFiles) {
      const sourceHash = sha256(path.join(sourceRoot, relativePath));
      const targetHash = sha256(path.join(targetRoot, relativePath));
      if (targetHash === null) {
        missingCount += 1;
        if (sampleMissing.length < SAMPLE_LIMIT) {
          sampleMissing.push(relativePath);
        }
        continue;
      }
      if (sourceHash !== targetHash) {
        mismatchCount += 1;
        if (sampleMismatched.length < SAMPLE_LIMIT) {
          sampleMismatched.push(relativePath);
        }
      }
    }
  }

  const status =
    blockedReasons.length > 0
      ? "blocked"
      : missingCount === 0 && mismatchCount === 0
        ? "fresh"
        : "stale";
  const receiptPath = path.join(outputDir, RECEIPT_NAME);
  const runtimeStatePath = path.join(targetRoot, RUNTIME_STATE_NAME);

  return {
    schemaVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    sourceRoot,
    targetRoot,
    receiptPath,
    runtimeStatePath,
    status,
    readyForLaunchAgent: status === "fresh",
    blockedReasons,
    checkedFileCount: trackedFiles.length,
    missingCount,
    mismatchCount,
    sampleMissing,
    sampleMismatched,
    boundary: [
      "Compares git-tracked source files against the non-Desktop live sidecar runtime.",
      "Excludes memory, dist, apps, node_modules, and live-handoff launchagent receipts to preserve protected memory and generated-output boundaries.",
      "Does not copy files, change LaunchAgents, send Feishu/Lark messages, or modify provider config.",
    ],
  };
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function renderText(receipt: RuntimeFreshnessReceipt): string {
  const lines = [
    `runtimeFreshness=${receipt.status}`,
    `targetRoot=${receipt.targetRoot}`,
    `checkedFileCount=${receipt.checkedFileCount}`,
    `missingCount=${receipt.missingCount}`,
    `mismatchCount=${receipt.mismatchCount}`,
    `receiptPath=${receipt.receiptPath}`,
    `runtimeStatePath=${receipt.runtimeStatePath}`,
  ];
  for (const reason of receipt.blockedReasons) {
    lines.push(`blockedReason=${reason}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const receipt = buildRuntimeFreshnessReceipt(args);
  if (args.write) {
    writeJson(receipt.receiptPath, receipt);
  }
  if (args.writeRuntimeState) {
    writeJson(receipt.runtimeStatePath, receipt);
  }
  process.stdout.write(args.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderText(receipt));
  return receipt.readyForLaunchAgent ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
