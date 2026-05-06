import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RUNTIME_BUNDLE_ROOT } from "./live-sidecar-runtime-bundle.ts";

const DEFAULT_SOURCE_ROOT = process.cwd();
const DEFAULT_TARGET_ROOT = DEFAULT_RUNTIME_BUNDLE_ROOT;
const DEFAULT_RECEIPT_DIR = "ops/live-handoff/promotions";
const MANIFEST_PATH = "branches/_system/live-promotion-manifest.json";
const PROMOTION_STATE_PATH = "branches/_system/live-promotion-state.json";
const DEFAULT_PORT = 18789;

type StepStatus = "skipped" | "passed" | "failed";

type Args = {
  sourceRoot: string;
  targetRoot: string;
  receiptDir: string;
  apply: boolean;
  allowDirty: boolean;
  skipInstall: boolean;
  skipSourceChecks: boolean;
  skipTargetBuild: boolean;
  skipRestart: boolean;
  skipProbe: boolean;
  json: boolean;
  port: number;
  acceptancePhrase: string | undefined;
};

type CommandResult = {
  command: string;
  cwd: string;
  status: StepStatus;
  code: number | null;
  stdout: string;
  stderr: string;
};

type FileAction = {
  relativePath: string;
  sourceSha256: string | null;
  targetSha256Before: string | null;
  targetSha256After: string | null;
  copied: boolean;
  removed: boolean;
};

type GitState = {
  branch: string;
  commit: string;
  upstream: string | null;
  trackedDirty: string[];
  ahead: number | null;
  behind: number | null;
};

type PromotionReceipt = {
  schemaVersion: 1;
  generatedAt: string;
  sourceRoot: string;
  targetRoot: string;
  receiptPath: string;
  manifestPath: string;
  statePath: string;
  mode: "dry_run" | "apply";
  status: "ready" | "promoted" | "blocked" | "failed";
  liveStatus:
    | "not_attempted"
    | "live_promoted"
    | "probe_ok"
    | "probe_failed"
    | "waiting_for_real_lark";
  git: GitState;
  blockedReasons: string[];
  managedFileCount: number;
  changedFileCount: number;
  removedFileCount: number;
  fileActions: FileAction[];
  commands: {
    sourceChecks: CommandResult[];
    install: CommandResult | null;
    targetBuild: CommandResult | null;
    gatewayInstall: CommandResult | null;
    restart: CommandResult | null;
    probe: CommandResult | null;
  };
  acceptancePhrase: string;
  nextLiveProof: string[];
  boundary: string[];
};

type PromotionManifest = {
  schemaVersion: 1;
  generatedAt: string;
  sourceRoot: string;
  targetRoot: string;
  sourceCommit: string;
  managedFiles: string[];
};

function parseArgs(argv: string[]): Args {
  const readValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const portRaw = readValue("--port");
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  return {
    sourceRoot: path.resolve(readValue("--source-root") ?? DEFAULT_SOURCE_ROOT),
    targetRoot: path.resolve(readValue("--target-root") ?? DEFAULT_TARGET_ROOT),
    receiptDir: path.resolve(readValue("--receipt-dir") ?? DEFAULT_RECEIPT_DIR),
    apply: argv.includes("--apply"),
    allowDirty: argv.includes("--allow-dirty"),
    skipInstall: argv.includes("--skip-install"),
    skipSourceChecks: argv.includes("--skip-source-checks"),
    skipTargetBuild: argv.includes("--skip-target-build"),
    skipRestart: argv.includes("--skip-restart"),
    skipProbe: argv.includes("--skip-probe"),
    json: argv.includes("--json"),
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    acceptancePhrase: readValue("--acceptance-phrase"),
  };
}

function runCommand(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command: [command, ...args].join(" "),
    cwd,
    status: result.status === 0 ? "passed" : "failed",
    code: result.status,
    stdout: (result.stdout || "").slice(-4000),
    stderr: (result.stderr || "").slice(-4000),
  };
}

function skippedCommand(command: string, cwd: string): CommandResult {
  return {
    command,
    cwd,
    status: "skipped",
    code: null,
    stdout: "",
    stderr: "",
  };
}

function gitOutput(sourceRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", sourceRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? (result.stdout || "").trim() : "";
}

function readGitState(sourceRoot: string): GitState {
  const upstream = gitOutput(sourceRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const counts = gitOutput(sourceRoot, [
      "rev-list",
      "--left-right",
      "--count",
      `${upstream}...HEAD`,
    ])
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10));
    behind = Number.isFinite(counts[0]) ? (counts[0] ?? 0) : null;
    ahead = Number.isFinite(counts[1]) ? (counts[1] ?? 0) : null;
  }
  return {
    branch: gitOutput(sourceRoot, ["branch", "--show-current"]) || "unknown",
    commit: gitOutput(sourceRoot, ["rev-parse", "HEAD"]) || "unknown",
    upstream: upstream || null,
    trackedDirty: gitOutput(sourceRoot, ["status", "--short", "--untracked-files=no"])
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
    ahead,
    behind,
  };
}

function listPromotableFiles(sourceRoot: string): string[] {
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
    .filter((line) => !line.startsWith("ops/live-handoff/"))
    .toSorted();
}

function sha256IfExists(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function readJsonIfExists<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function assertInsideTarget(targetRoot: string, candidatePath: string): boolean {
  const relative = path.relative(targetRoot, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function copyPromotedFile(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const sourcePath = path.join(sourceRoot, relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const sourceStat = fs.lstatSync(sourcePath);
  try {
    fs.rmSync(targetPath, { force: true, recursive: true });
  } catch {
    // Best-effort cleanup before replacing a previous symlink or file.
  }
  if (sourceStat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, sourceStat.mode);
}

function planFileActions(params: {
  sourceRoot: string;
  targetRoot: string;
  files: string[];
  previousManifest: PromotionManifest | null;
}): FileAction[] {
  const actions = params.files.map((relativePath) => {
    const sourcePath = path.join(params.sourceRoot, relativePath);
    const targetPath = path.join(params.targetRoot, relativePath);
    const sourceSha256 = sha256IfExists(sourcePath);
    const targetSha256Before = sha256IfExists(targetPath);
    return {
      relativePath,
      sourceSha256,
      targetSha256Before,
      targetSha256After: targetSha256Before,
      copied: false,
      removed: false,
    };
  });
  const current = new Set(params.files);
  for (const previousPath of params.previousManifest?.managedFiles ?? []) {
    if (!current.has(previousPath)) {
      actions.push({
        relativePath: previousPath,
        sourceSha256: null,
        targetSha256Before: sha256IfExists(path.join(params.targetRoot, previousPath)),
        targetSha256After: null,
        copied: false,
        removed: false,
      });
    }
  }
  return actions;
}

function applyFileActions(params: {
  sourceRoot: string;
  targetRoot: string;
  files: string[];
  actions: FileAction[];
}): void {
  const current = new Set(params.files);
  for (const action of params.actions) {
    const targetPath = path.join(params.targetRoot, action.relativePath);
    if (!assertInsideTarget(params.targetRoot, targetPath)) {
      throw new Error(`refusing to write outside target root: ${action.relativePath}`);
    }
    if (current.has(action.relativePath)) {
      copyPromotedFile(params.sourceRoot, params.targetRoot, action.relativePath);
      action.targetSha256After = sha256IfExists(targetPath);
      action.copied =
        action.sourceSha256 !== null && action.sourceSha256 === action.targetSha256After;
      continue;
    }
    if (action.targetSha256Before !== null) {
      fs.rmSync(targetPath, { force: true, recursive: true });
      action.removed = !fs.existsSync(targetPath);
    }
  }
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function makeAcceptancePhrase(commit: string): string {
  const shortSha = commit.slice(0, 10);
  return `lark-live-fixed-${shortSha}`;
}

function buildReceipt(params: {
  args: Args;
  generatedAt: string;
  receiptPath: string;
  git: GitState;
  files: string[];
  fileActions: FileAction[];
  blockedReasons: string[];
  commands: PromotionReceipt["commands"];
  applyFailed: boolean;
}): PromotionReceipt {
  const changedFileCount = params.fileActions.filter(
    (action) => action.sourceSha256 !== null && action.sourceSha256 !== action.targetSha256Before,
  ).length;
  const removedFileCount = params.fileActions.filter(
    (action) => action.sourceSha256 === null && action.targetSha256Before !== null,
  ).length;
  const probe = params.commands.probe;
  const restart = params.commands.restart;
  const liveStatus =
    !params.args.apply || params.args.skipRestart
      ? "not_attempted"
      : probe?.status === "passed"
        ? "probe_ok"
        : probe?.status === "failed"
          ? "probe_failed"
          : restart?.status === "passed"
            ? "live_promoted"
            : "not_attempted";
  const status =
    params.blockedReasons.length > 0
      ? "blocked"
      : params.applyFailed
        ? "failed"
        : params.args.apply
          ? "promoted"
          : "ready";
  const acceptancePhrase = params.args.acceptancePhrase ?? makeAcceptancePhrase(params.git.commit);
  return {
    schemaVersion: 1,
    generatedAt: params.generatedAt,
    sourceRoot: params.args.sourceRoot,
    targetRoot: params.args.targetRoot,
    receiptPath: params.receiptPath,
    manifestPath: path.join(params.args.targetRoot, MANIFEST_PATH),
    statePath: path.join(params.args.targetRoot, PROMOTION_STATE_PATH),
    mode: params.args.apply ? "apply" : "dry_run",
    status,
    liveStatus: liveStatus === "probe_ok" ? "waiting_for_real_lark" : liveStatus,
    git: params.git,
    blockedReasons: params.blockedReasons,
    managedFileCount: params.files.length,
    changedFileCount,
    removedFileCount,
    fileActions: params.fileActions.slice(0, 200),
    commands: params.commands,
    acceptancePhrase,
    nextLiveProof: [
      `Send a real Lark/Feishu message after this promotion: live验收：请只回复 ${acceptancePhrase}，并说明这是重启后的真实链路。`,
      "Then inspect ~/.openclaw/logs/feishu-reply-flow.jsonl for a fresh inbound plus outbound_result after generatedAt.",
      "Only mark live-visible-fixed after the visible reply matches the acceptance phrase or the requested semantic acceptance condition.",
    ],
    boundary: [
      "Promotes a git-tracked source snapshot into the live sidecar runtime.",
      "Excludes protected memory, dist, apps, node_modules, and live-handoff receipts from source copying.",
      "Does not modify provider config, live sender credentials, protected memory, or trading/execution authority.",
      "Probe-ok is not live-visible-fixed; a fresh real Lark/Feishu inbound and reply are still required.",
    ],
  };
}

function renderText(receipt: PromotionReceipt): string {
  const lines = [
    `promoteLive=${receipt.status}`,
    `mode=${receipt.mode}`,
    `sourceCommit=${receipt.git.commit}`,
    `targetRoot=${receipt.targetRoot}`,
    `liveStatus=${receipt.liveStatus}`,
    `changedFileCount=${receipt.changedFileCount}`,
    `removedFileCount=${receipt.removedFileCount}`,
    `receiptPath=${receipt.receiptPath}`,
    `acceptancePhrase=${receipt.acceptancePhrase}`,
  ];
  for (const reason of receipt.blockedReasons) {
    lines.push(`blockedReason=${reason}`);
  }
  for (const command of [
    ...receipt.commands.sourceChecks,
    receipt.commands.install,
    receipt.commands.targetBuild,
    receipt.commands.gatewayInstall,
    receipt.commands.restart,
    receipt.commands.probe,
  ]) {
    if (command) {
      lines.push(`${command.command}.status=${command.status}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const generatedAt = new Date().toISOString();
  const git = readGitState(args.sourceRoot);
  const files = listPromotableFiles(args.sourceRoot);
  const receiptPath = path.join(
    args.receiptDir,
    `${generatedAt.replace(/[:.]/gu, "-")}-live-promotion.json`,
  );
  const manifestPath = path.join(args.targetRoot, MANIFEST_PATH);
  const previousManifest = readJsonIfExists<PromotionManifest>(manifestPath);
  const fileActions = planFileActions({
    sourceRoot: args.sourceRoot,
    targetRoot: args.targetRoot,
    files,
    previousManifest,
  });
  const blockedReasons: string[] = [];

  if (args.sourceRoot === args.targetRoot) {
    blockedReasons.push("source root and target root must be different");
  }
  if (files.length === 0) {
    blockedReasons.push("no git-tracked promotable files found");
  }
  if (git.trackedDirty.length > 0 && !args.allowDirty) {
    blockedReasons.push(
      `tracked source tree is dirty; commit first or rerun with --allow-dirty: ${git.trackedDirty.join("; ")}`,
    );
  }

  const commands: PromotionReceipt["commands"] = {
    sourceChecks: [],
    install: null,
    targetBuild: null,
    gatewayInstall: null,
    restart: null,
    probe: null,
  };
  let applyFailed = false;

  if (blockedReasons.length === 0 && !args.skipSourceChecks) {
    commands.sourceChecks.push(runCommand("pnpm", ["tsgo"], args.sourceRoot));
    commands.sourceChecks.push(runCommand("pnpm", ["build"], args.sourceRoot));
    for (const command of commands.sourceChecks) {
      if (command.status === "failed") {
        blockedReasons.push(`source check failed: ${command.command}`);
      }
    }
  } else if (args.skipSourceChecks) {
    commands.sourceChecks.push(skippedCommand("pnpm tsgo", args.sourceRoot));
    commands.sourceChecks.push(skippedCommand("pnpm build", args.sourceRoot));
  }

  if (blockedReasons.length === 0 && args.apply) {
    try {
      applyFileActions({
        sourceRoot: args.sourceRoot,
        targetRoot: args.targetRoot,
        files,
        actions: fileActions,
      });
      const manifest: PromotionManifest = {
        schemaVersion: 1,
        generatedAt,
        sourceRoot: args.sourceRoot,
        targetRoot: args.targetRoot,
        sourceCommit: git.commit,
        managedFiles: files,
      };
      writeJson(manifestPath, manifest);
    } catch (error) {
      applyFailed = true;
      blockedReasons.push(`copy failed: ${String(error)}`);
    }
  }

  if (blockedReasons.length === 0 && args.apply) {
    commands.install = args.skipInstall
      ? skippedCommand("pnpm install --frozen-lockfile", args.targetRoot)
      : runCommand("pnpm", ["install", "--frozen-lockfile"], args.targetRoot);
    if (commands.install.status === "failed") {
      applyFailed = true;
      blockedReasons.push("target install failed");
    }
  }

  if (blockedReasons.length === 0 && args.apply) {
    commands.targetBuild = args.skipTargetBuild
      ? skippedCommand("pnpm build", args.targetRoot)
      : runCommand("pnpm", ["build"], args.targetRoot);
    if (commands.targetBuild.status === "failed") {
      applyFailed = true;
      blockedReasons.push("target build failed");
    }
  }

  if (blockedReasons.length === 0 && args.apply) {
    commands.gatewayInstall = runCommand(
      "pnpm",
      [
        "--silent",
        "openclaw",
        "gateway",
        "install",
        "--force",
        "--runtime",
        "node",
        "--port",
        String(args.port),
      ],
      args.targetRoot,
    );
    if (commands.gatewayInstall.status === "failed") {
      applyFailed = true;
      blockedReasons.push("gateway install failed");
    }
  }

  if (blockedReasons.length === 0 && args.apply) {
    commands.restart = args.skipRestart
      ? skippedCommand("pnpm --silent openclaw daemon restart", args.targetRoot)
      : runCommand("pnpm", ["--silent", "openclaw", "daemon", "restart"], args.targetRoot);
    if (commands.restart.status === "failed") {
      applyFailed = true;
      blockedReasons.push("daemon restart failed");
    }
  }

  if (blockedReasons.length === 0 && args.apply) {
    commands.probe = args.skipProbe
      ? skippedCommand("pnpm --silent openclaw channels status --probe", args.targetRoot)
      : runCommand(
          "pnpm",
          ["--silent", "openclaw", "channels", "status", "--probe"],
          args.targetRoot,
        );
    if (commands.probe.status === "failed") {
      applyFailed = true;
      blockedReasons.push("channel probe failed");
    }
  }

  const receipt = buildReceipt({
    args,
    generatedAt,
    receiptPath,
    git,
    files,
    fileActions,
    blockedReasons,
    commands,
    applyFailed,
  });
  writeJson(receipt.receiptPath, receipt);
  if (args.apply && blockedReasons.length === 0) {
    writeJson(receipt.statePath, receipt);
  }
  process.stdout.write(args.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderText(receipt));
  return receipt.status === "blocked" || receipt.status === "failed" ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
