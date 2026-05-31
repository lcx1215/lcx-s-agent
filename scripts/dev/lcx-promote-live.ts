import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RUNTIME_BUNDLE_ROOT } from "./live-sidecar-runtime-bundle.ts";

const DEFAULT_SOURCE_ROOT = process.cwd();
const DEFAULT_TARGET_ROOT = DEFAULT_RUNTIME_BUNDLE_ROOT;
const DEFAULT_RECEIPT_SUBDIR = "branches/_system/promotions";
const MANIFEST_PATH = "branches/_system/live-promotion-manifest.json";
const PROMOTION_STATE_PATH = "branches/_system/live-promotion-state.json";
const PROMOTION_LOCK_DIR = "branches/_system/live-promotion.lock";
const DEFAULT_PORT = 18789;
const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const RESTART_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const LIVE_RESTART_HEALTH_TIMEOUT_MS = 90_000;
const PROBE_COMMAND_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_REPLY_FLOW_LOG = path.join(os.homedir(), ".openclaw/logs/feishu-reply-flow.jsonl");
const CHANNEL_PROBE_UNREACHABLE_PATTERN =
  /Gateway not reachable|config-only status|abnormal closure/iu;
const LARK_POST_MIGRATION_PROBE_SCRIPT =
  "/Users/liuchengxu/.codex/skills/lark-post-migration-probe/scripts/lark-post-migration-probe.sh";

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
  skipGatewayInstall: boolean;
  skipRestart: boolean;
  skipProbe: boolean;
  json: boolean;
  status: boolean;
  statusProbe: boolean;
  autoSnapshot: boolean;
  port: number;
  acceptancePhrase: string | undefined;
  replyFlowLog: string | undefined;
};

type CommandResult = {
  command: string;
  cwd: string;
  status: StepStatus;
  code: number | null;
  stdout: string;
  stderr: string;
};

type LiveVisibleProof = {
  status:
    | "not_checked"
    | "reply_flow_missing"
    | "waiting_for_real_lark"
    | "post_migration_reply_seen"
    | "live_visible_fixed"
    | "reply_failed";
  logPath: string;
  since: string;
  acceptancePhrase: string;
  acceptanceMessage: string;
  naturalProbeMessage: string;
  postMigrationProbeCommand: string;
  replyFlowProbeCommand: string;
  freshInboundCount: number;
  freshOutboundResultCount: number;
  acceptanceMatched: boolean;
  latestInbound: ReplyFlowSummary | null;
  latestOutboundResult: ReplyFlowSummary | null;
};

type ReplyFlowSummary = {
  recordedAt: string | null;
  messageId: string | null;
  correlationId: string | null;
  chatId: string | null;
  textPreview: string | null;
  deliveryStatus: string | null;
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
  untracked: string[];
  ahead: number | null;
  behind: number | null;
};

type DevLiveDriftStatus = {
  sourceRoot: string;
  currentDevBranch: string;
  currentDevCommit: string;
  currentDevUpstream: string | null;
  currentDevAheadOfUpstream: number | null;
  currentDevBehindUpstream: number | null;
  currentDevTrackedDirtyCount: number;
  currentDevUntrackedCount: number;
  liveMatchesCurrentDev: boolean;
  liveNeedsPromotion: boolean;
  devLiveDrift:
    | "missing_state"
    | "source_git_unavailable"
    | "current_dev_dirty"
    | "current_dev_has_untracked_files"
    | "live_matches_current_dev"
    | "dev_commit_differs";
};

type OperatorStatus = {
  statusModel: "dev-ready -> live-runtime-updated -> live-user-seen";
  devReady: "not_checked_by_live_status";
  liveRuntimeCommitMatched: boolean;
  liveRuntimeRestartCommandStatus: StepStatus | "not_run";
  liveRuntimeProbePassed: boolean;
  liveRuntimeUpdated: boolean;
  liveUserSeen: boolean;
  nextHumanStep:
    | "commit_or_clean_dev_then_run_dev_tests"
    | "run_dev_tests_then_promote_dev_to_live"
    | "retry_live_restart_then_probe"
    | "send_real_lark_natural_probe"
    | "no_action_current_dev_seen_in_live";
};

type ExternalChannelStatus = {
  statusModel: "dev-ready -> external-channel-bound -> user-visible-observed";
  channel: "lark";
  role: "owner_agent_communication_medium";
  objective: "lark_receives_current_best_verified_lcx_agent_answer";
  channelCommitMatched: boolean;
  channelRestartCommandStatus: StepStatus | "not_run";
  channelProbePassed: boolean;
  externalChannelBound: boolean;
  userVisibleObserved: boolean;
  legacyLiveRuntimeUpdated: boolean;
  legacyLiveUserSeen: boolean;
  nextHumanStep: OperatorStatus["nextHumanStep"];
  boundary: "dev_external_channel_status_only";
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
  sourceSnapshot: {
    mode: "working_tree" | "auto_clean_head";
    originalSourceRoot: string | null;
    trackedDirty: string[];
  };
  visibleProof?: LiveVisibleProof;
  blockedReasons: string[];
  managedFileCount: number;
  changedFileCount: number;
  removedFileCount: number;
  fileActions: FileAction[];
  commands: {
    sourceChecks: CommandResult[];
    install: CommandResult | null;
    targetBuild: CommandResult | null;
    targetUiBuild: CommandResult | null;
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

type CommandStatusSummary = Pick<CommandResult, "command" | "cwd" | "status" | "code">;

type PromotionStateStatusSummary = Omit<
  PromotionReceipt,
  "fileActions" | "commands" | "visibleProof"
> & {
  fileActionSummary: {
    storedLimit: number;
    storedCount: number;
    copiedCount: number;
    removedCount: number;
    changedFileCount: number;
    managedFileCount: number;
  };
  commandSummary: {
    sourceChecks: CommandStatusSummary[];
    install: CommandStatusSummary | null;
    targetBuild: CommandStatusSummary | null;
    targetUiBuild: CommandStatusSummary | null;
    gatewayInstall: CommandStatusSummary | null;
    restart: CommandStatusSummary | null;
    probe: CommandStatusSummary | null;
  };
};

type PromotionReceiptOutputSummary = PromotionStateStatusSummary & {
  visibleProof?: LiveVisibleProof;
};

type PromotionLock =
  | {
      acquired: true;
      lockDir: string;
      release: () => void;
    }
  | {
      acquired: false;
      lockDir: string;
      message: string;
    };

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseArgs(argv: string[]): Args {
  const argsList = argv.filter((value) => value !== "--");
  const argsSet = new Set(argsList);
  const readValue = (name: string): string | undefined => {
    const index = argsList.indexOf(name);
    return index === -1 ? undefined : argsList[index + 1];
  };
  const portRaw = readValue("--port");
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  const targetRoot = path.resolve(readValue("--target-root") ?? DEFAULT_TARGET_ROOT);
  return {
    sourceRoot: path.resolve(readValue("--source-root") ?? DEFAULT_SOURCE_ROOT),
    targetRoot,
    receiptDir: path.resolve(
      readValue("--receipt-dir") ?? path.join(targetRoot, DEFAULT_RECEIPT_SUBDIR),
    ),
    apply: argsSet.has("--apply"),
    allowDirty: argsSet.has("--allow-dirty"),
    skipInstall: argsSet.has("--skip-install"),
    skipSourceChecks: argsSet.has("--skip-source-checks"),
    skipTargetBuild: argsSet.has("--skip-target-build"),
    skipGatewayInstall: argsSet.has("--skip-gateway-install"),
    skipRestart: argsSet.has("--skip-restart"),
    skipProbe: argsSet.has("--skip-probe"),
    json: argsSet.has("--json"),
    status: argsSet.has("--status"),
    statusProbe: argsSet.has("--with-probe"),
    autoSnapshot: !argsSet.has("--no-auto-snapshot"),
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    acceptancePhrase: readValue("--acceptance-phrase"),
    replyFlowLog: readValue("--reply-flow-log"),
  };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  extraEnv: NodeJS.ProcessEnv = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    env: { ...process.env, ...extraEnv },
  });
  const errorText = result.error
    ? `\n[spawn error] ${result.error.name}: ${result.error.message}`
    : "";
  return {
    command: [command, ...args].join(" "),
    cwd,
    status: result.status === 0 ? "passed" : "failed",
    code: result.status,
    stdout: (result.stdout || "").slice(-4000),
    stderr: `${result.stderr || ""}${errorText}`.slice(-4000),
  };
}

function normalizeChannelProbeResult(result: CommandResult): CommandResult {
  if (result.status === "passed") {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (CHANNEL_PROBE_UNREACHABLE_PATTERN.test(combined)) {
      return {
        ...result,
        status: "failed",
        code: result.code === 0 ? 1 : result.code,
        stderr: `${result.stderr}${
          result.stderr ? "\n" : ""
        }[probe validation] channels status reported gateway not reachable`,
      };
    }
  }
  return result;
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
    untracked: gitOutput(sourceRoot, ["status", "--short", "--untracked-files=all"])
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("?? ")),
    ahead,
    behind,
  };
}

function prepareSourceSnapshot(args: Args): {
  args: Args;
  cleanup: () => void;
  sourceSnapshot: PromotionReceipt["sourceSnapshot"];
  snapshotError: string | null;
} {
  const initialGit = readGitState(args.sourceRoot);
  const sourceSnapshot: PromotionReceipt["sourceSnapshot"] = {
    mode: "working_tree",
    originalSourceRoot: null,
    trackedDirty: initialGit.trackedDirty,
  };
  if (
    !args.apply ||
    args.allowDirty ||
    !args.autoSnapshot ||
    initialGit.trackedDirty.length === 0
  ) {
    return { args, cleanup: () => {}, sourceSnapshot, snapshotError: null };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-promote-live-"));
  const result = spawnSync(
    "git",
    ["-C", args.sourceRoot, "worktree", "add", "--detach", tempRoot, "HEAD"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  );
  if (result.status !== 0) {
    fs.rmSync(tempRoot, { force: true, recursive: true });
    return {
      args,
      cleanup: () => {},
      sourceSnapshot,
      snapshotError: `auto clean HEAD snapshot failed: ${result.stderr || result.stdout || "unknown error"}`,
    };
  }

  return {
    args: {
      ...args,
      sourceRoot: tempRoot,
      skipSourceChecks: true,
    },
    cleanup: () => {
      spawnSync("git", ["-C", args.sourceRoot, "worktree", "remove", "--force", tempRoot], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PROBE_COMMAND_TIMEOUT_MS,
      });
    },
    sourceSnapshot: {
      mode: "auto_clean_head",
      originalSourceRoot: args.sourceRoot,
      trackedDirty: initialGit.trackedDirty,
    },
    snapshotError: null,
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

function readLockPid(lockDir: string): number | null {
  const owner = readJsonIfExists<{ pid?: unknown }>(path.join(lockDir, "owner.json"));
  return typeof owner?.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0
    ? owner.pid
    : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function acquirePromotionLock(targetRoot: string): PromotionLock {
  const lockDir = path.join(targetRoot, PROMOTION_LOCK_DIR);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const tryAcquire = (): PromotionLock | null => {
    try {
      fs.mkdirSync(lockDir);
      writeJson(path.join(lockDir, "owner.json"), {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      return {
        acquired: true,
        lockDir,
        release: () => {
          try {
            if (readLockPid(lockDir) === process.pid) {
              fs.rmSync(lockDir, { force: true, recursive: true });
            }
          } catch {
            // Best-effort cleanup only; stale locks are handled by the next run.
          }
        },
      };
    } catch (error) {
      if (isErrnoException(error) && error.code === "EEXIST") {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        acquired: false,
        lockDir,
        message: `live promotion lock failed: ${message}`,
      };
    }
  };

  const acquired = tryAcquire();
  if (acquired) {
    return acquired;
  }

  const ownerPid = readLockPid(lockDir);
  if (ownerPid && processIsAlive(ownerPid)) {
    return {
      acquired: false,
      lockDir,
      message: `live promotion already running: pid=${ownerPid} lock=${lockDir}`,
    };
  }

  fs.rmSync(lockDir, { force: true, recursive: true });
  return (
    tryAcquire() ?? {
      acquired: false,
      lockDir,
      message: `live promotion lock could not be acquired after stale cleanup: lock=${lockDir}`,
    }
  );
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
  return `lark-live-visible-fixed-${shortSha}`;
}

function makeAcceptanceMessage(acceptancePhrase: string): string {
  return `可选收据锚点：请回复 ${acceptancePhrase}，用于精确匹配这次通道验收。`;
}

function makeNaturalProbeMessage(): string {
  return "现在状态怎么样？";
}

function makePostMigrationProbeCommand(since: string): string {
  return `${LARK_POST_MIGRATION_PROBE_SCRIPT} --since ${since}`;
}

function makeReplyFlowProbeCommand(): string {
  return "node --import tsx scripts/dev/lcx-promote-live.ts --status --with-probe";
}

function summarizeReplyFlowRecord(record: Record<string, unknown>): ReplyFlowSummary {
  return {
    recordedAt: typeof record.recordedAt === "string" ? record.recordedAt : null,
    messageId: typeof record.messageId === "string" ? record.messageId : null,
    correlationId: typeof record.correlationId === "string" ? record.correlationId : null,
    chatId: typeof record.chatId === "string" ? record.chatId : null,
    textPreview: typeof record.textPreview === "string" ? record.textPreview : null,
    deliveryStatus: typeof record.deliveryStatus === "string" ? record.deliveryStatus : null,
  };
}

function readLiveVisibleProof(params: {
  since: string;
  acceptancePhrase: string;
  logPath?: string;
}): LiveVisibleProof {
  const logPath = params.logPath ?? DEFAULT_REPLY_FLOW_LOG;
  const sinceMs = Date.parse(params.since);
  const acceptanceMessage = makeAcceptanceMessage(params.acceptancePhrase);
  const naturalProbeMessage = makeNaturalProbeMessage();
  const postMigrationProbeCommand = makePostMigrationProbeCommand(params.since);
  const replyFlowProbeCommand = makeReplyFlowProbeCommand();
  if (!fs.existsSync(logPath)) {
    return {
      status: "reply_flow_missing",
      logPath,
      since: params.since,
      acceptancePhrase: params.acceptancePhrase,
      acceptanceMessage,
      naturalProbeMessage,
      postMigrationProbeCommand,
      replyFlowProbeCommand,
      freshInboundCount: 0,
      freshOutboundResultCount: 0,
      acceptanceMatched: false,
      latestInbound: null,
      latestOutboundResult: null,
    };
  }
  const records = fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(-5000)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const recordedAtMs =
          typeof parsed.recordedAtMs === "number"
            ? parsed.recordedAtMs
            : typeof parsed.recordedAt === "string"
              ? Date.parse(parsed.recordedAt)
              : Number.NaN;
        return Number.isFinite(recordedAtMs) && recordedAtMs >= sinceMs
          ? [{ ...parsed, recordedAtMs }]
          : [];
      } catch {
        return [];
      }
    });
  const inbound = records.filter((record) => record.stage === "inbound");
  const outboundResult = records.filter((record) => record.stage === "outbound_result");
  const failedOutbound = outboundResult.filter((record) => record.deliveryStatus !== "success");
  const acceptanceInboundKeys = new Set(
    inbound
      .filter(
        (record) =>
          typeof record.textPreview === "string" &&
          record.textPreview.includes(params.acceptancePhrase),
      )
      .flatMap((record) =>
        [record.correlationId, record.messageId].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        ),
      ),
  );
  const acceptanceMatched = outboundResult.some((record) => {
    if (record.deliveryStatus !== "success") {
      return false;
    }
    const textPreview = typeof record.textPreview === "string" ? record.textPreview : "";
    if (textPreview.includes(params.acceptancePhrase)) {
      return true;
    }
    return [record.correlationId, record.messageId].some(
      (value) => typeof value === "string" && acceptanceInboundKeys.has(value),
    );
  });
  const latestInbound = inbound.at(-1);
  const latestOutboundResult = outboundResult.at(-1);
  const status =
    acceptanceMatched && latestInbound
      ? "live_visible_fixed"
      : failedOutbound.length > 0 && outboundResult.length > 0
        ? "reply_failed"
        : latestInbound && latestOutboundResult
          ? "post_migration_reply_seen"
          : "waiting_for_real_lark";
  return {
    status,
    logPath,
    since: params.since,
    acceptancePhrase: params.acceptancePhrase,
    acceptanceMessage,
    naturalProbeMessage,
    postMigrationProbeCommand,
    replyFlowProbeCommand,
    freshInboundCount: inbound.length,
    freshOutboundResultCount: outboundResult.length,
    acceptanceMatched,
    latestInbound: latestInbound ? summarizeReplyFlowRecord(latestInbound) : null,
    latestOutboundResult: latestOutboundResult
      ? summarizeReplyFlowRecord(latestOutboundResult)
      : null,
  };
}

function buildReceipt(params: {
  args: Args;
  generatedAt: string;
  receiptPath: string;
  git: GitState;
  sourceSnapshot: PromotionReceipt["sourceSnapshot"];
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
    sourceSnapshot: params.sourceSnapshot,
    visibleProof: params.args.apply
      ? readLiveVisibleProof({
          since: params.generatedAt,
          acceptancePhrase,
        })
      : {
          status: "not_checked",
          logPath: DEFAULT_REPLY_FLOW_LOG,
          since: params.generatedAt,
          acceptancePhrase,
          acceptanceMessage: makeAcceptanceMessage(acceptancePhrase),
          naturalProbeMessage: makeNaturalProbeMessage(),
          postMigrationProbeCommand: makePostMigrationProbeCommand(params.generatedAt),
          replyFlowProbeCommand: makeReplyFlowProbeCommand(),
          freshInboundCount: 0,
          freshOutboundResultCount: 0,
          acceptanceMatched: false,
          latestInbound: null,
          latestOutboundResult: null,
        },
    blockedReasons: params.blockedReasons,
    managedFileCount: params.files.length,
    changedFileCount,
    removedFileCount,
    fileActions: params.fileActions.slice(0, 200),
    commands: params.commands,
    acceptancePhrase,
    nextLiveProof: [
      `First send a plain real Lark/Feishu user probe: ${makeNaturalProbeMessage()}`,
      "Then inspect feishu-reply-flow inbound, answer_audit, and outbound_result by messageId/correlationId to find the internal route.",
      `Optional exact receipt anchor only if a deterministic match is needed: ${makeAcceptanceMessage(
        acceptancePhrase,
      )}`,
      `Then run: ${makePostMigrationProbeCommand(params.generatedAt)}`,
      `Status/probe command: ${makeReplyFlowProbeCommand()}`,
      "Only mark user-visible-observed after fresh real Lark/Feishu inbound and outbound evidence; the exact anchor is optional and legacy live-visible-fixed wording is compatibility only.",
    ],
    boundary: [
      "Copies a git-tracked dev snapshot into the Lark transport connector sidecar so it can route to LCX Agent.",
      "If the source working tree is dirty, defaults to a temporary clean HEAD snapshot instead of copying dirty WIP.",
      "Excludes protected memory, dist, apps, node_modules, and live-handoff receipts from source copying.",
      "Does not modify provider config, external-channel sender credentials, protected memory, or trading/execution authority.",
      "Probe-ok is only external-channel-bound; fresh real Lark/Feishu inbound and reply are still required for user-visible-observed.",
    ],
  };
}

function renderText(receipt: PromotionReceipt): string {
  const lines = [
    `promoteLive=${receipt.status}`,
    `mode=${receipt.mode}`,
    `sourceCommit=${receipt.git.commit}`,
    `sourceSnapshot=${receipt.sourceSnapshot.mode}`,
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
    receipt.commands.targetUiBuild,
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

function renderStatus(params: {
  args: Args;
  state: PromotionReceipt | null;
  devLiveDrift: DevLiveDriftStatus;
  operatorStatus: OperatorStatus;
  externalChannelStatus: ExternalChannelStatus;
  probe: CommandResult | null;
  visibleProof: LiveVisibleProof | null;
}): string {
  const externalChannelLines = [
    `externalChannelStatusModel=${params.externalChannelStatus.statusModel}`,
    `externalChannel=${params.externalChannelStatus.channel}`,
    `externalChannelRole=${params.externalChannelStatus.role}`,
    `externalChannelObjective=${params.externalChannelStatus.objective}`,
    `externalChannelCommitMatched=${params.externalChannelStatus.channelCommitMatched}`,
    `externalChannelRestartCommandStatus=${params.externalChannelStatus.channelRestartCommandStatus}`,
    `externalChannelProbePassed=${params.externalChannelStatus.channelProbePassed}`,
    `externalChannelBound=${params.externalChannelStatus.externalChannelBound}`,
    `userVisibleObserved=${params.externalChannelStatus.userVisibleObserved}`,
    `legacyLiveRuntimeUpdated=${params.externalChannelStatus.legacyLiveRuntimeUpdated}`,
    `legacyLiveUserSeen=${params.externalChannelStatus.legacyLiveUserSeen}`,
  ];
  const operatorLines = [
    `statusModel=${params.operatorStatus.statusModel}`,
    `devReady=${params.operatorStatus.devReady}`,
    `liveRuntimeCommitMatched=${params.operatorStatus.liveRuntimeCommitMatched}`,
    `liveRuntimeRestartCommandStatus=${params.operatorStatus.liveRuntimeRestartCommandStatus}`,
    `liveRuntimeProbePassed=${params.operatorStatus.liveRuntimeProbePassed}`,
    `liveRuntimeUpdated=${params.operatorStatus.liveRuntimeUpdated}`,
    `liveUserSeen=${params.operatorStatus.liveUserSeen}`,
    `nextHumanStep=${params.operatorStatus.nextHumanStep}`,
  ];
  const driftLines = [
    `currentDevBranch=${params.devLiveDrift.currentDevBranch}`,
    `currentDevCommit=${params.devLiveDrift.currentDevCommit}`,
    `currentDevUpstream=${params.devLiveDrift.currentDevUpstream ?? "none"}`,
    `currentDevAheadOfUpstream=${params.devLiveDrift.currentDevAheadOfUpstream ?? "unknown"}`,
    `currentDevBehindUpstream=${params.devLiveDrift.currentDevBehindUpstream ?? "unknown"}`,
    `currentDevTrackedDirtyCount=${params.devLiveDrift.currentDevTrackedDirtyCount}`,
    `currentDevUntrackedCount=${params.devLiveDrift.currentDevUntrackedCount}`,
    `liveMatchesCurrentDev=${params.devLiveDrift.liveMatchesCurrentDev}`,
    `liveNeedsPromotion=${params.devLiveDrift.liveNeedsPromotion}`,
    `devLiveDrift=${params.devLiveDrift.devLiveDrift}`,
  ];
  if (!params.state) {
    return `${[
      "livePromotionStatus=missing",
      `targetRoot=${params.args.targetRoot}`,
      `statePath=${path.join(params.args.targetRoot, PROMOTION_STATE_PATH)}`,
      ...externalChannelLines,
      ...operatorLines,
      ...driftLines,
    ].join("\n")}\n`;
  }
  const lines = [
    `livePromotionStatus=${params.state.status}`,
    `liveStatus=${params.state.liveStatus}`,
    ...externalChannelLines,
    ...operatorLines,
    `sourceCommit=${params.state.git.commit}`,
    `sourceSnapshot=${params.state.sourceSnapshot?.mode ?? "unknown"}`,
    `generatedAt=${params.state.generatedAt}`,
    `acceptancePhrase=${params.state.acceptancePhrase}`,
    `receiptPath=${params.state.receiptPath}`,
    ...driftLines,
  ];
  if (params.probe) {
    lines.push(`${params.probe.command}.status=${params.probe.status}`);
  }
  if (params.visibleProof) {
    lines.push(`liveVisibleStatus=${params.visibleProof.status}`);
    lines.push(`naturalProbeMessage=${params.visibleProof.naturalProbeMessage}`);
    lines.push(`acceptanceMessage=${params.visibleProof.acceptanceMessage}`);
    lines.push(`postMigrationProbeCommand=${params.visibleProof.postMigrationProbeCommand}`);
    lines.push(`replyFlowProbeCommand=${params.visibleProof.replyFlowProbeCommand}`);
    lines.push(`freshInboundCount=${params.visibleProof.freshInboundCount}`);
    lines.push(`freshOutboundResultCount=${params.visibleProof.freshOutboundResultCount}`);
    lines.push(`acceptanceMatched=${params.visibleProof.acceptanceMatched}`);
    if (params.visibleProof.latestInbound?.recordedAt) {
      lines.push(`latestInboundAt=${params.visibleProof.latestInbound.recordedAt}`);
    }
    if (params.visibleProof.latestOutboundResult?.recordedAt) {
      lines.push(`latestOutboundResultAt=${params.visibleProof.latestOutboundResult.recordedAt}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function summarizeCommandStatus(command: CommandResult | null): CommandStatusSummary | null {
  return command
    ? {
        command: command.command,
        cwd: command.cwd,
        status: command.status,
        code: command.code,
      }
    : null;
}

function summarizePromotionStateForStatus(
  state: PromotionReceipt | null,
): PromotionStateStatusSummary | null {
  if (!state) {
    return null;
  }
  const { fileActions, commands, visibleProof: _visibleProof, ...rest } = state;
  return {
    ...rest,
    fileActionSummary: {
      storedLimit: 200,
      storedCount: fileActions.length,
      copiedCount: fileActions.filter((action) => action.copied).length,
      removedCount: fileActions.filter((action) => action.removed).length,
      changedFileCount: state.changedFileCount,
      managedFileCount: state.managedFileCount,
    },
    commandSummary: {
      sourceChecks: commands.sourceChecks.map((command) => summarizeCommandStatus(command)!),
      install: summarizeCommandStatus(commands.install),
      targetBuild: summarizeCommandStatus(commands.targetBuild),
      targetUiBuild: summarizeCommandStatus(commands.targetUiBuild),
      gatewayInstall: summarizeCommandStatus(commands.gatewayInstall),
      restart: summarizeCommandStatus(commands.restart),
      probe: summarizeCommandStatus(commands.probe),
    },
  };
}

function summarizePromotionReceiptForOutput(
  receipt: PromotionReceipt,
): PromotionReceiptOutputSummary {
  return {
    ...summarizePromotionStateForStatus(receipt)!,
    visibleProof: receipt.visibleProof,
  };
}

export function resolveOperatorStatus(params: {
  state: PromotionReceipt | null;
  devLiveDrift: DevLiveDriftStatus;
  probe: CommandResult | null;
  visibleProof: LiveVisibleProof | null;
}): OperatorStatus {
  const devHasLocalChanges =
    params.devLiveDrift.devLiveDrift === "current_dev_dirty" ||
    params.devLiveDrift.devLiveDrift === "current_dev_has_untracked_files";
  const liveRuntimeCommitMatched = params.devLiveDrift.liveMatchesCurrentDev;
  const liveRuntimeRestartCommandStatus = params.state?.commands.restart?.status ?? "not_run";
  const liveRuntimeProbePassed =
    params.probe?.status === "passed" || params.state?.commands.probe?.status === "passed";
  const liveRuntimeResponsive = liveRuntimeProbePassed;
  const liveRuntimeUpdated = liveRuntimeCommitMatched && liveRuntimeResponsive;
  const liveUserSeen =
    liveRuntimeUpdated &&
    (params.visibleProof?.status === "live_visible_fixed" ||
      params.visibleProof?.status === "post_migration_reply_seen");
  const nextHumanStep: OperatorStatus["nextHumanStep"] = devHasLocalChanges
    ? "commit_or_clean_dev_then_run_dev_tests"
    : !liveRuntimeCommitMatched
      ? "run_dev_tests_then_promote_dev_to_live"
      : !liveRuntimeResponsive
        ? "retry_live_restart_then_probe"
        : !liveUserSeen
          ? "send_real_lark_natural_probe"
          : "no_action_current_dev_seen_in_live";
  return {
    statusModel: "dev-ready -> live-runtime-updated -> live-user-seen",
    devReady: "not_checked_by_live_status",
    liveRuntimeCommitMatched,
    liveRuntimeRestartCommandStatus,
    liveRuntimeProbePassed,
    liveRuntimeUpdated,
    liveUserSeen,
    nextHumanStep,
  };
}

export function resolveExternalChannelStatus(
  operatorStatus: OperatorStatus,
): ExternalChannelStatus {
  return {
    statusModel: "dev-ready -> external-channel-bound -> user-visible-observed",
    channel: "lark",
    role: "owner_agent_communication_medium",
    objective: "lark_receives_current_best_verified_lcx_agent_answer",
    channelCommitMatched: operatorStatus.liveRuntimeCommitMatched,
    channelRestartCommandStatus: operatorStatus.liveRuntimeRestartCommandStatus,
    channelProbePassed: operatorStatus.liveRuntimeProbePassed,
    externalChannelBound: operatorStatus.liveRuntimeUpdated,
    userVisibleObserved: operatorStatus.liveUserSeen,
    legacyLiveRuntimeUpdated: operatorStatus.liveRuntimeUpdated,
    legacyLiveUserSeen: operatorStatus.liveUserSeen,
    nextHumanStep: operatorStatus.nextHumanStep,
    boundary: "dev_external_channel_status_only",
  };
}

export function readDevLiveDrift(params: {
  sourceRoot: string;
  state: PromotionReceipt | null;
}): DevLiveDriftStatus {
  const current = readGitState(params.sourceRoot);
  const sourceGitUnavailable = current.commit === "unknown";
  const currentDevTrackedDirtyCount = current.trackedDirty.length;
  const currentDevUntrackedCount = current.untracked.length;
  const liveMatchesCurrentDev =
    Boolean(params.state) &&
    !sourceGitUnavailable &&
    currentDevTrackedDirtyCount === 0 &&
    currentDevUntrackedCount === 0 &&
    params.state?.git.commit === current.commit;
  const devLiveDrift: DevLiveDriftStatus["devLiveDrift"] = !params.state
    ? "missing_state"
    : sourceGitUnavailable
      ? "source_git_unavailable"
      : currentDevTrackedDirtyCount > 0
        ? "current_dev_dirty"
        : currentDevUntrackedCount > 0
          ? "current_dev_has_untracked_files"
          : liveMatchesCurrentDev
            ? "live_matches_current_dev"
            : "dev_commit_differs";
  return {
    sourceRoot: params.sourceRoot,
    currentDevBranch: current.branch,
    currentDevCommit: current.commit,
    currentDevUpstream: current.upstream,
    currentDevAheadOfUpstream: current.ahead,
    currentDevBehindUpstream: current.behind,
    currentDevTrackedDirtyCount,
    currentDevUntrackedCount,
    liveMatchesCurrentDev,
    liveNeedsPromotion: !liveMatchesCurrentDev,
    devLiveDrift,
  };
}

export function main(argv = process.argv.slice(2)): number {
  const initialArgs = parseArgs(argv);
  if (initialArgs.status) {
    const state = readJsonIfExists<PromotionReceipt>(
      path.join(initialArgs.targetRoot, PROMOTION_STATE_PATH),
    );
    const devLiveDrift = readDevLiveDrift({
      sourceRoot: initialArgs.sourceRoot,
      state,
    });
    const probe =
      !initialArgs.statusProbe || initialArgs.skipProbe || !state
        ? null
        : normalizeChannelProbeResult(
            runCommand(
              "pnpm",
              ["--silent", "openclaw", "channels", "status", "--probe"],
              initialArgs.targetRoot,
              PROBE_COMMAND_TIMEOUT_MS,
            ),
          );
    const visibleProof = state
      ? readLiveVisibleProof({
          since: state.generatedAt,
          acceptancePhrase: state.acceptancePhrase,
          logPath: initialArgs.replyFlowLog,
        })
      : null;
    const operatorStatus = resolveOperatorStatus({
      state,
      devLiveDrift,
      probe,
      visibleProof,
    });
    const externalChannelStatus = resolveExternalChannelStatus(operatorStatus);
    process.stdout.write(
      initialArgs.json
        ? `${JSON.stringify(
            {
              state: summarizePromotionStateForStatus(state),
              operatorStatus,
              externalChannelStatus,
              devLiveDrift,
              probe: summarizeCommandStatus(probe),
              visibleProof,
            },
            null,
            2,
          )}\n`
        : renderStatus({
            args: initialArgs,
            state,
            devLiveDrift,
            operatorStatus,
            externalChannelStatus,
            probe,
            visibleProof,
          }),
    );
    return probe?.status === "failed" ? 1 : 0;
  }

  const promotionLock = initialArgs.apply ? acquirePromotionLock(initialArgs.targetRoot) : null;
  if (promotionLock && !promotionLock.acquired) {
    process.stderr.write(`${promotionLock.message}\n`);
    return 1;
  }
  const releasePromotionLock = promotionLock?.release ?? null;
  try {
    return runPromotion(initialArgs);
  } finally {
    releasePromotionLock?.();
  }
}

function runPromotion(initialArgs: Args): number {
  const prepared = prepareSourceSnapshot(initialArgs);
  const args = prepared.args;
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
  if (prepared.snapshotError) {
    blockedReasons.push(prepared.snapshotError);
  }

  const commands: PromotionReceipt["commands"] = {
    sourceChecks: [],
    install: null,
    targetBuild: null,
    targetUiBuild: null,
    gatewayInstall: null,
    restart: null,
    probe: null,
  };
  let applyFailed = false;
  let restartFailed = false;

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
    commands.targetUiBuild = args.skipTargetBuild
      ? skippedCommand("pnpm ui:build", args.targetRoot)
      : runCommand("pnpm", ["ui:build"], args.targetRoot);
    if (commands.targetUiBuild.status === "failed") {
      applyFailed = true;
      blockedReasons.push("target ui build failed");
    }
  }

  if (blockedReasons.length === 0 && args.apply) {
    commands.gatewayInstall = args.skipGatewayInstall
      ? skippedCommand(
          "pnpm --silent openclaw gateway install --force --runtime node",
          args.targetRoot,
        )
      : runCommand(
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
      : runCommand(
          "pnpm",
          ["--silent", "openclaw", "daemon", "restart"],
          args.targetRoot,
          RESTART_COMMAND_TIMEOUT_MS,
          {
            OPENCLAW_DAEMON_RESTART_HEALTH_TIMEOUT_MS: String(LIVE_RESTART_HEALTH_TIMEOUT_MS),
          },
        );
    if (commands.restart.status === "failed") {
      restartFailed = true;
    }
  }

  if (blockedReasons.length === 0 && args.apply) {
    commands.probe = args.skipProbe
      ? skippedCommand("pnpm --silent openclaw channels status --probe", args.targetRoot)
      : normalizeChannelProbeResult(
          runCommand(
            "pnpm",
            ["--silent", "openclaw", "channels", "status", "--probe"],
            args.targetRoot,
            PROBE_COMMAND_TIMEOUT_MS,
          ),
        );
    if (commands.probe.status === "failed") {
      applyFailed = true;
      blockedReasons.push(
        restartFailed ? "daemon restart failed and channel probe failed" : "channel probe failed",
      );
    } else if (commands.probe.status === "skipped" && restartFailed) {
      applyFailed = true;
      blockedReasons.push("daemon restart failed and channel probe was skipped");
    } else if (restartFailed) {
      applyFailed = false;
    }
  }

  const receipt = buildReceipt({
    args,
    generatedAt,
    receiptPath,
    git,
    sourceSnapshot: prepared.sourceSnapshot,
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
  prepared.cleanup();
  process.stdout.write(
    args.json
      ? `${JSON.stringify(summarizePromotionReceiptForOutput(receipt), null, 2)}\n`
      : renderText(receipt),
  );
  return receipt.status === "blocked" || receipt.status === "failed" ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
