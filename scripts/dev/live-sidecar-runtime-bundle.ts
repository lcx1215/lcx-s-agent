import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SOURCE_ROOT = process.cwd();
export const DEFAULT_RUNTIME_BUNDLE_ROOT =
  "/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw";
const DEFAULT_OUTPUT_DIR = "ops/live-handoff/launchagent-candidates";
const RECEIPT_NAME = "live-sidecar-runtime-bundle-receipt.json";

type Args = {
  sourceRoot: string;
  targetRoot: string;
  outputDir: string;
  write: boolean;
  fullWorkspace: boolean;
  json: boolean;
};

type BundleFile = {
  source: string;
  target: string;
  executable: boolean;
};

export type RuntimeBundleReceipt = {
  schemaVersion: 1;
  generatedAt: string;
  sourceRoot: string;
  targetRoot: string;
  receiptPath: string;
  writeMode: boolean;
  readyForLaunchAgent: boolean;
  blockedReasons: string[];
  files: Array<{
    relativePath: string;
    sourceSha256: string | null;
    targetSha256: string | null;
    copied: boolean;
    executable: boolean;
  }>;
  fileCount: number;
  omittedFileCount: number;
  compileCheck: {
    command: string;
    code: number | null;
    stderr: string;
  } | null;
  boundary: string[];
};

const REQUIRED_FILES: Array<{ relativePath: string; executable: boolean }> = [
  { relativePath: "daily_learning_runner.py", executable: true },
  { relativePath: "lobster_orchestrator.py", executable: true },
  { relativePath: "scripts/lobster_paths.py", executable: false },
  { relativePath: "scripts/branch_freshness.py", executable: false },
  { relativePath: "scripts/lobster_host_watchdog.py", executable: true },
];

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
    fullWorkspace: argv.includes("--full-workspace"),
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

function isDesktopPath(filePath: string): boolean {
  return path.resolve(filePath).split(path.sep).includes("Desktop");
}

function buildFileList(sourceRoot: string, targetRoot: string): BundleFile[] {
  return REQUIRED_FILES.map((file) => ({
    source: path.join(sourceRoot, file.relativePath),
    target: path.join(targetRoot, file.relativePath),
    executable: file.executable,
  }));
}

function listGitTrackedFiles(sourceRoot: string): string[] {
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
    .filter((line) => !line.startsWith("node_modules/"));
}

function buildWorkspaceFileList(sourceRoot: string, targetRoot: string): BundleFile[] {
  const tracked = listGitTrackedFiles(sourceRoot);
  const required = new Set(REQUIRED_FILES.map((file) => file.relativePath));
  const merged = new Set([...tracked, ...required]);
  return Array.from(merged)
    .toSorted()
    .map((relativePath) => {
      const requiredFile = REQUIRED_FILES.find((file) => file.relativePath === relativePath);
      return {
        source: path.join(sourceRoot, relativePath),
        target: path.join(targetRoot, relativePath),
        executable: requiredFile?.executable ?? false,
      };
    });
}

function copyFile(file: BundleFile): void {
  fs.mkdirSync(path.dirname(file.target), { recursive: true });
  fs.copyFileSync(file.source, file.target);
  if (file.executable) {
    fs.chmodSync(file.target, 0o755);
  }
}

function runCompileCheck(targetRoot: string): RuntimeBundleReceipt["compileCheck"] {
  const command = [
    "python3",
    "-m",
    "py_compile",
    "daily_learning_runner.py",
    "lobster_orchestrator.py",
    "scripts/lobster_paths.py",
    "scripts/branch_freshness.py",
    "scripts/lobster_host_watchdog.py",
  ];
  const result = spawnSync(command[0] ?? "", command.slice(1), {
    cwd: targetRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command: command.join(" "),
    code: result.status,
    stderr: (result.stderr || result.stdout || "").slice(0, 2000),
  };
}

export function buildRuntimeBundleReceipt(params: {
  sourceRoot: string;
  targetRoot: string;
  outputDir: string;
  write?: boolean;
  fullWorkspace?: boolean;
  generatedAt?: string;
  compileCheck?: RuntimeBundleReceipt["compileCheck"];
}): RuntimeBundleReceipt {
  const sourceRoot = path.resolve(params.sourceRoot);
  const targetRoot = path.resolve(params.targetRoot);
  const outputDir = path.resolve(params.outputDir);
  const files = params.fullWorkspace
    ? buildWorkspaceFileList(sourceRoot, targetRoot)
    : buildFileList(sourceRoot, targetRoot);
  const blockedReasons: string[] = [];

  if (isDesktopPath(targetRoot)) {
    blockedReasons.push("target root must not be under Desktop for LaunchAgent execution");
  }
  if (sourceRoot === targetRoot) {
    blockedReasons.push("source root and target root must be different");
  }
  for (const file of files) {
    if (!fs.existsSync(file.source)) {
      blockedReasons.push(`missing source file: ${path.relative(sourceRoot, file.source)}`);
    }
  }

  const canWrite = Boolean(params.write) && blockedReasons.length === 0;
  if (canWrite) {
    for (const file of files) {
      copyFile(file);
    }
  }

  const compileCheck =
    params.compileCheck ??
    (canWrite && fs.existsSync(targetRoot) ? runCompileCheck(targetRoot) : null);
  if (compileCheck && compileCheck.code !== 0) {
    blockedReasons.push(`py_compile failed: ${compileCheck.stderr || "unknown error"}`);
  }

  const allReceiptFiles = files.map((file) => {
    const sourceSha256 = sha256IfExists(file.source);
    const targetSha256 = sha256IfExists(file.target);
    return {
      relativePath: path.relative(sourceRoot, file.source),
      sourceSha256,
      targetSha256,
      copied: canWrite && sourceSha256 !== null && sourceSha256 === targetSha256,
      executable: file.executable,
    };
  });
  const receiptFiles = params.fullWorkspace ? allReceiptFiles.slice(0, 200) : allReceiptFiles;

  return {
    schemaVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    sourceRoot,
    targetRoot,
    receiptPath: path.join(outputDir, RECEIPT_NAME),
    writeMode: Boolean(params.write),
    readyForLaunchAgent:
      blockedReasons.length === 0 &&
      Boolean(params.write) &&
      allReceiptFiles.every((file) => file.copied) &&
      (!compileCheck || compileCheck.code === 0),
    blockedReasons,
    files: receiptFiles,
    fileCount: allReceiptFiles.length,
    omittedFileCount: Math.max(allReceiptFiles.length - receiptFiles.length, 0),
    compileCheck,
    boundary: [
      params.fullWorkspace
        ? "Copies the tracked workspace source needed by the agent-system loop."
        : "Copies only the scheduler and host-watchdog compatibility sidecar files.",
      params.fullWorkspace
        ? "Full-workspace mode also copies tracked source needed by the agent-system loop, excluding memory, dist, apps, and node_modules."
        : "Minimal mode copies only the Python sidecar compatibility runtime.",
      "Does not copy Feishu/Lark proxy code.",
      "Does not copy secrets or .env.lobster.",
      "Does not modify LaunchAgents.",
      "Does not enable production scheduler cycles.",
    ],
  };
}

function writeReceipt(receipt: RuntimeBundleReceipt): void {
  fs.mkdirSync(path.dirname(receipt.receiptPath), { recursive: true });
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function renderText(receipt: RuntimeBundleReceipt): string {
  const lines = [
    `runtimeBundle=${receipt.readyForLaunchAgent ? "ready" : "blocked"}`,
    `targetRoot=${receipt.targetRoot}`,
    `writeMode=${receipt.writeMode}`,
    `receiptPath=${receipt.receiptPath}`,
  ];
  for (const reason of receipt.blockedReasons) {
    lines.push(`blockedReason=${reason}`);
  }
  for (const file of receipt.files) {
    lines.push(`${file.relativePath}.copied=${file.copied}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const receipt = buildRuntimeBundleReceipt(args);
  if (args.write) {
    writeReceipt(receipt);
  }
  process.stdout.write(args.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderText(receipt));
  return receipt.readyForLaunchAgent ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
