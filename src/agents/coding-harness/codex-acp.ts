import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { callGateway } from "../../gateway/call.js";
import { spawnAcpDirect, type SpawnAcpContext, type SpawnAcpResult } from "../acp-spawn.js";
import { extractAssistantText, stripToolMessages } from "../tools/sessions-helpers.js";
import {
  AppendOnlyCodingTrajectory,
  summarizeTrajectoryText,
  type CodingHarnessTrajectoryProjection,
} from "./trajectory.js";

const execFileAsync = promisify(execFile);
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_RUN_TIMEOUT_MS = 30 * 60 * 1_000;
const VERIFICATION_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_OUTPUT_CHARS = 4_000;
const SAFE_VERIFICATION_COMMANDS = new Set([
  "bun",
  "cargo",
  "go",
  "make",
  "node",
  "npm",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "yarn",
]);

export type CodingHarnessVerification = {
  status: "not-requested" | "passed" | "failed" | "blocked";
  command?: string[];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
};

export type CodingHarnessWorkspaceSnapshot = {
  root: string;
  branch: string;
  defaultBranch?: string;
  headSha?: string;
  statusPorcelain: string;
  changedPaths: string[];
};

export type CodingHarnessWorkspaceScope = "confined" | "host-unconfined" | "unobserved";

export type CodingHarnessReceipt = {
  schemaVersion: 1;
  harness: "codex";
  executor: "openclaw-acp";
  status: "verified" | "completed-unverified" | "timed-out" | "failed" | "forbidden";
  runId: string;
  childRunId?: string;
  childSessionKey?: string;
  cwd: string;
  branch?: string;
  task: { sha256: string; length: number };
  actualExecutor: boolean;
  workspaceScope: CodingHarnessWorkspaceScope;
  changedPaths: string[];
  verification: CodingHarnessVerification;
  reply?: string;
  error?: string;
  cleanup?: "not-needed" | "requested" | "confirmed" | "failed";
  trajectory: {
    schemaVersion: 1;
    eventCount: number;
    replayable: true;
    projection: CodingHarnessTrajectoryProjection;
    jsonl: string;
  };
};

export type RunCodexCodingHarnessInput = {
  task: string;
  cwd: string;
  agentId?: string;
  verify?: string[];
  timeoutMs?: number;
  context?: SpawnAcpContext;
};

type GatewayCall = <T>(options: {
  method: string;
  params?: unknown;
  timeoutMs?: number;
}) => Promise<T>;

type WorkspaceInspector = (cwd: string) => Promise<CodingHarnessWorkspaceSnapshot>;

type VerificationRunner = (params: {
  cwd: string;
  command: string[];
}) => Promise<CodingHarnessVerification>;

type CodingHarnessDeps = {
  spawnAcp: typeof spawnAcpDirect;
  callGateway: GatewayCall;
  inspectWorkspace: WorkspaceInspector;
  runVerification: VerificationRunner;
  createRunId: () => string;
  now: () => string;
};

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, MAX_OUTPUT_CHARS);
}

function normalizeOutput(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : value == null
        ? ""
        : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
          ? value.toString()
          : (JSON.stringify(value) ?? "");
  return redactText(text);
}

function parseGitStatusPaths(statusPorcelain: string): string[] {
  const paths = new Set<string>();
  for (const line of statusPorcelain.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const rawPath = line.length > 3 ? line.slice(3).trim() : "";
    if (!rawPath) {
      continue;
    }
    const pathValue = rawPath.includes(" -> ")
      ? rawPath.slice(rawPath.lastIndexOf(" -> ") + 4)
      : rawPath;
    paths.add(pathValue.replace(/^"|"$/g, ""));
  }
  return [...paths].toSorted();
}

function resolveChangedPathsSince(
  before: CodingHarnessWorkspaceSnapshot,
  after: CodingHarnessWorkspaceSnapshot,
): string[] {
  const beforePaths = new Set(before.changedPaths);
  return after.changedPaths.filter((candidate) => !beforePaths.has(candidate));
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 256 * 1_024,
  });
  // Preserve porcelain's leading XY status columns; trim only line endings.
  return String(result.stdout).trimEnd();
}

export async function inspectCodingWorkspace(
  cwdInput: string,
): Promise<CodingHarnessWorkspaceSnapshot> {
  if (!path.isAbsolute(cwdInput)) {
    throw new Error("Coding harness cwd must be an absolute path.");
  }
  const cwd = path.resolve(cwdInput);
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const branch = await runGit(cwd, ["branch", "--show-current"]);
  const defaultBranch = (await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))
    .replace(/^origin\//, "")
    .trim();
  const headSha = await runGit(cwd, ["rev-parse", "HEAD"]);
  const statusPorcelain = await runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    root,
    branch,
    defaultBranch,
    headSha,
    statusPorcelain,
    changedPaths: parseGitStatusPaths(statusPorcelain),
  };
}

async function runSafeVerification(params: {
  cwd: string;
  command: string[];
}): Promise<CodingHarnessVerification> {
  const command = params.command.map((part) => part.trim());
  if (command.length === 0 || !command[0]) {
    return { status: "blocked", command, error: "verification command is empty" };
  }
  const executable = path
    .basename(command[0])
    .replace(/\.(cmd|exe)$/i, "")
    .toLowerCase();
  if (!SAFE_VERIFICATION_COMMANDS.has(executable)) {
    return {
      status: "blocked",
      command,
      error: `verification command is not allowlisted: ${executable}`,
    };
  }
  try {
    const result = await execFileAsync(command[0], command.slice(1), {
      cwd: params.cwd,
      encoding: "utf8",
      timeout: VERIFICATION_TIMEOUT_MS,
      maxBuffer: 512 * 1_024,
    });
    return {
      status: "passed",
      command,
      exitCode: 0,
      stdout: normalizeOutput(result.stdout),
      stderr: normalizeOutput(result.stderr),
    };
  } catch (error) {
    const result = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    return {
      status: "failed",
      command,
      exitCode: typeof result.code === "number" ? result.code : null,
      stdout: normalizeOutput(result.stdout),
      stderr: normalizeOutput(result.stderr),
      error: normalizeOutput(result.message),
    };
  }
}

function buildCodingTask(params: RunCodexCodingHarnessInput): string {
  const verifyText = params.verify?.length
    ? `After editing, run this verification command exactly: ${JSON.stringify(params.verify)}`
    : "Do not claim that tests passed; the caller will run verification separately.";
  return [
    "You are LCX's Codex coding executor.",
    `Work only inside the provided coding workspace: ${params.cwd}`,
    "Implement the requested change with the smallest coherent diff.",
    "Do not send external messages, change provider/auth configuration, or modify protected memory.",
    verifyText,
    "In your final response, state what changed, what command was run, and any remaining uncertainty.",
    "",
    "REQUEST:",
    params.task,
  ].join("\n");
}

function buildReceipt(params: {
  trajectory: AppendOnlyCodingTrajectory;
  status: CodingHarnessReceipt["status"];
  cwd: string;
  task: string;
  spawn?: SpawnAcpResult;
  branch?: string;
  changedPaths?: string[];
  verification?: CodingHarnessVerification;
  reply?: string;
  error?: string;
  cleanup?: CodingHarnessReceipt["cleanup"];
  workspaceScope?: CodingHarnessWorkspaceScope;
}): CodingHarnessReceipt {
  const projection = params.trajectory.replay();
  return {
    schemaVersion: 1,
    harness: "codex",
    executor: "openclaw-acp",
    status: params.status,
    runId: params.trajectory.runId,
    ...(params.spawn?.runId ? { childRunId: params.spawn.runId } : {}),
    ...(params.spawn?.childSessionKey ? { childSessionKey: params.spawn.childSessionKey } : {}),
    cwd: params.cwd,
    ...(params.branch ? { branch: params.branch } : {}),
    task: summarizeTrajectoryText(params.task),
    actualExecutor: params.spawn?.status === "accepted",
    workspaceScope: params.workspaceScope ?? params.spawn?.workspaceScope ?? "unobserved",
    changedPaths: params.changedPaths ?? [],
    verification: params.verification ?? { status: "not-requested" },
    ...(params.reply ? { reply: redactText(params.reply) } : {}),
    ...(params.error ? { error: redactText(params.error) } : {}),
    ...(params.cleanup ? { cleanup: params.cleanup } : {}),
    trajectory: {
      schemaVersion: 1,
      eventCount: projection.eventCount,
      replayable: true,
      projection,
      jsonl: params.trajectory.toJSONL(),
    },
  };
}

async function cleanupAcceptedChildSession(params: {
  deps: CodingHarnessDeps;
  spawn: SpawnAcpResult;
  trajectory: AppendOnlyCodingTrajectory;
  now: () => string;
  phase: "timeout-cleanup" | "wait-cleanup";
}): Promise<"confirmed" | "failed"> {
  try {
    await params.deps.callGateway({
      method: "sessions.delete",
      params: {
        key: params.spawn.childSessionKey,
        deleteTranscript: false,
        emitLifecycleHooks: false,
      },
      timeoutMs: 20_000,
    });
    return "confirmed";
  } catch (error) {
    params.trajectory.append(
      "run/failed",
      { phase: params.phase, error: String(error) },
      params.now(),
    );
    return "failed";
  }
}

async function resolveChangedPathsSinceRun(
  before: CodingHarnessWorkspaceSnapshot,
  after: CodingHarnessWorkspaceSnapshot,
): Promise<string[]> {
  const paths = new Set(resolveChangedPathsSince(before, after));
  if (before.headSha && after.headSha && before.headSha !== after.headSha) {
    throw new Error(
      "post-run HEAD changed; refusing committed-path attribution without an exclusive executor ownership proof",
    );
  }
  return [...paths].toSorted();
}

async function observeAcceptedRunExitWorkspace(params: {
  deps: CodingHarnessDeps;
  cwd: string;
  before: CodingHarnessWorkspaceSnapshot;
  trajectory: AppendOnlyCodingTrajectory;
  now: () => string;
  phase: "wait-failure-postflight" | "timeout-postflight" | "verification-postflight";
}): Promise<{ changedPaths: string[]; error?: string }> {
  let after: CodingHarnessWorkspaceSnapshot;
  try {
    after = await params.deps.inspectWorkspace(params.cwd);
  } catch (error) {
    const message = `workspace ${params.phase} failed: ${String(error)}`;
    params.trajectory.append(
      "run/failed",
      { phase: params.phase, reason: "workspace-observation-failed", error: String(error) },
      params.now(),
    );
    return { changedPaths: [], error: message };
  }
  if (
    after.root !== params.before.root ||
    after.branch !== params.before.branch ||
    (params.before.defaultBranch && after.defaultBranch !== params.before.defaultBranch)
  ) {
    const message = "coding harness detected that the worktree identity changed during the run";
    params.trajectory.append(
      "run/failed",
      {
        phase: params.phase,
        reason: "workspace-identity-changed",
        beforeRoot: params.before.root,
        afterRoot: after.root,
        beforeBranch: params.before.branch,
        afterBranch: after.branch,
      },
      params.now(),
    );
    return { changedPaths: [], error: message };
  }
  try {
    const changedPaths = await resolveChangedPathsSinceRun(params.before, after);
    params.trajectory.append(
      "workspace/observed",
      {
        phase: params.phase,
        branch: after.branch,
        changedPaths,
        statusClean: after.statusPorcelain.trim() === "",
      },
      params.now(),
    );
    return { changedPaths };
  } catch (error) {
    const message = String(error);
    params.trajectory.append(
      "run/failed",
      { phase: params.phase, reason: "unsafe-commit-attribution", error: message },
      params.now(),
    );
    return { changedPaths: [], error: message };
  }
}

export async function runCodexCodingHarness(
  input: RunCodexCodingHarnessInput,
  overrides: Partial<CodingHarnessDeps> = {},
): Promise<CodingHarnessReceipt> {
  const deps: CodingHarnessDeps = {
    spawnAcp: spawnAcpDirect,
    callGateway: callGateway as GatewayCall,
    inspectWorkspace: inspectCodingWorkspace,
    runVerification: runSafeVerification,
    createRunId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    ...overrides,
  };
  const runId = deps.createRunId();
  const cwd = path.isAbsolute(input.cwd) ? path.resolve(input.cwd) : input.cwd;
  const trajectory = new AppendOnlyCodingTrajectory(runId);
  trajectory.append(
    "run/requested",
    {
      harness: "codex",
      executor: "openclaw-acp",
      cwd,
      task: summarizeTrajectoryText(input.task),
    },
    deps.now(),
  );
  if (!path.isAbsolute(input.cwd)) {
    const error = "coding harness cwd must be an absolute path";
    trajectory.append(
      "run/failed",
      { phase: "workspace-preflight", reason: "relative-cwd" },
      deps.now(),
    );
    return buildReceipt({ trajectory, status: "forbidden", cwd, task: input.task, error });
  }

  let workspace: CodingHarnessWorkspaceSnapshot;
  try {
    workspace = await deps.inspectWorkspace(cwd);
  } catch (error) {
    trajectory.append(
      "run/failed",
      { phase: "workspace-preflight", error: String(error) },
      deps.now(),
    );
    return buildReceipt({
      trajectory,
      status: "forbidden",
      cwd,
      task: input.task,
      error: `workspace preflight failed: ${String(error)}`,
    });
  }
  if (
    !workspace.branch ||
    !workspace.defaultBranch ||
    workspace.branch === workspace.defaultBranch
  ) {
    trajectory.append(
      "run/failed",
      {
        phase: "workspace-preflight",
        reason: "protected-branch",
        branch: workspace.branch || "detached",
        defaultBranch: workspace.defaultBranch,
      },
      deps.now(),
    );
    return buildReceipt({
      trajectory,
      status: "forbidden",
      cwd,
      task: input.task,
      branch: workspace.branch,
      error: "coding harness requires a named branch different from the repository default branch",
    });
  }
  if (workspace.statusPorcelain.trim()) {
    trajectory.append(
      "run/failed",
      {
        phase: "workspace-preflight",
        reason: "dirty-worktree",
        changedPaths: workspace.changedPaths,
      },
      deps.now(),
    );
    return buildReceipt({
      trajectory,
      status: "forbidden",
      cwd,
      task: input.task,
      branch: workspace.branch,
      changedPaths: workspace.changedPaths,
      error:
        "coding harness requires a clean worktree so unrelated changes cannot be attributed to the run",
    });
  }

  const timeoutMs = Math.min(
    MAX_RUN_TIMEOUT_MS,
    Math.max(1_000, Math.floor(input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)),
  );
  let spawn: SpawnAcpResult;
  try {
    spawn = await deps.spawnAcp(
      {
        task: buildCodingTask({ ...input, cwd }),
        label: "codex-coding-harness",
        agentId: input.agentId?.trim() || "codex",
        cwd,
        mode: "run",
        thread: false,
        // ACP sessions run on the host and do not support sandbox="require".
        // The clean named-worktree preflight and postflight attribution remain
        // the harness boundary; use the supported inherited ACP mode here.
        sandbox: "inherit",
      },
      input.context ?? {},
    );
  } catch (error) {
    trajectory.append("run/failed", { phase: "spawn", error: String(error) }, deps.now());
    return buildReceipt({
      trajectory,
      status: "failed",
      cwd,
      task: input.task,
      branch: workspace.branch,
      error: `Codex ACP spawn failed: ${String(error)}`,
    });
  }
  if (spawn.status !== "accepted" || !spawn.runId || !spawn.childSessionKey) {
    trajectory.append(
      "run/failed",
      {
        phase: "spawn",
        status: spawn.status,
        error: spawn.error,
      },
      deps.now(),
    );
    return buildReceipt({
      trajectory,
      status: spawn.status === "forbidden" ? "forbidden" : "failed",
      cwd,
      task: input.task,
      branch: workspace.branch,
      spawn,
      error: spawn.error ?? "Codex ACP executor was not accepted",
    });
  }
  trajectory.append(
    "run/accepted",
    {
      childRunId: spawn.runId,
      childSessionKey: spawn.childSessionKey,
      backend: "openclaw-acp",
    },
    deps.now(),
  );

  let wait: { status?: string; error?: string };
  try {
    wait = await deps.callGateway<{ status?: string; error?: string }>({
      method: "agent.wait",
      params: { runId: spawn.runId, timeoutMs },
      timeoutMs: timeoutMs + 2_000,
    });
  } catch (error) {
    trajectory.append("run/failed", { phase: "wait", error: String(error) }, deps.now());
    const cleanup = await cleanupAcceptedChildSession({
      deps,
      spawn,
      trajectory,
      now: deps.now,
      phase: "wait-cleanup",
    });
    const observation = await observeAcceptedRunExitWorkspace({
      deps,
      cwd,
      before: workspace,
      trajectory,
      now: deps.now,
      phase: "wait-failure-postflight",
    });
    return buildReceipt({
      trajectory,
      status: "failed",
      cwd,
      task: input.task,
      branch: workspace.branch,
      spawn,
      cleanup,
      changedPaths: observation.changedPaths,
      error: [`Codex ACP wait failed: ${String(error)}`, observation.error]
        .filter(Boolean)
        .join("; "),
    });
  }
  trajectory.append(
    "run/waited",
    {
      status: wait.status,
      error: wait.error,
    },
    deps.now(),
  );
  if (wait.status === "timeout") {
    const cleanup = await cleanupAcceptedChildSession({
      deps,
      spawn,
      trajectory,
      now: deps.now,
      phase: "timeout-cleanup",
    });
    const observation = await observeAcceptedRunExitWorkspace({
      deps,
      cwd,
      before: workspace,
      trajectory,
      now: deps.now,
      phase: "timeout-postflight",
    });
    trajectory.append("run/timed-out", { timeoutMs, cleanup }, deps.now());
    return buildReceipt({
      trajectory,
      status: "timed-out",
      cwd,
      task: input.task,
      branch: workspace.branch,
      spawn,
      changedPaths: observation.changedPaths,
      cleanup,
      error: [wait.error ?? `Codex ACP run exceeded ${timeoutMs}ms`, observation.error]
        .filter(Boolean)
        .join("; "),
    });
  }
  if (wait.status !== "ok") {
    trajectory.append(
      "run/failed",
      { phase: "wait", status: wait.status, error: wait.error },
      deps.now(),
    );
    const cleanup = await cleanupAcceptedChildSession({
      deps,
      spawn,
      trajectory,
      now: deps.now,
      phase: "wait-cleanup",
    });
    const observation = await observeAcceptedRunExitWorkspace({
      deps,
      cwd,
      before: workspace,
      trajectory,
      now: deps.now,
      phase: "wait-failure-postflight",
    });
    return buildReceipt({
      trajectory,
      status: "failed",
      cwd,
      task: input.task,
      branch: workspace.branch,
      spawn,
      changedPaths: observation.changedPaths,
      cleanup,
      error: [
        wait.error ?? `Codex ACP run ended with status ${wait.status ?? "unknown"}`,
        observation.error,
      ]
        .filter(Boolean)
        .join("; "),
    });
  }

  let reply: string | undefined;
  try {
    const history = await deps.callGateway<{ messages?: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: spawn.childSessionKey, limit: 50 },
      timeoutMs: 20_000,
    });
    const messages = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (
        candidate &&
        typeof candidate === "object" &&
        (candidate as { role?: unknown }).role === "assistant"
      ) {
        reply = extractAssistantText(candidate);
        if (reply?.trim()) {
          break;
        }
      }
    }
    trajectory.append(
      "run/history-observed",
      {
        observed: messages.length > 0,
        assistantReply: reply ? summarizeTrajectoryText(reply) : undefined,
      },
      deps.now(),
    );
  } catch (error) {
    trajectory.append("run/failed", { phase: "history", error: String(error) }, deps.now());
    const cleanup = await cleanupAcceptedChildSession({
      deps,
      spawn,
      trajectory,
      now: deps.now,
      phase: "wait-cleanup",
    });
    const observation = await observeAcceptedRunExitWorkspace({
      deps,
      cwd,
      before: workspace,
      trajectory,
      now: deps.now,
      phase: "wait-failure-postflight",
    });
    return buildReceipt({
      trajectory,
      status: "failed",
      cwd,
      task: input.task,
      branch: workspace.branch,
      spawn,
      changedPaths: observation.changedPaths,
      cleanup,
      error: [`Codex ACP history could not be observed: ${String(error)}`, observation.error]
        .filter(Boolean)
        .join("; "),
    });
  }

  let afterWorkspace: CodingHarnessWorkspaceSnapshot;
  try {
    afterWorkspace = await deps.inspectWorkspace(cwd);
  } catch (error) {
    trajectory.append(
      "run/failed",
      { phase: "workspace-postflight", error: String(error) },
      deps.now(),
    );
    return buildReceipt({
      trajectory,
      status: "failed",
      cwd,
      task: input.task,
      branch: workspace.branch,
      spawn,
      reply,
      error: `workspace postflight failed: ${String(error)}`,
    });
  }
  if (
    afterWorkspace.root !== workspace.root ||
    afterWorkspace.branch !== workspace.branch ||
    afterWorkspace.defaultBranch !== workspace.defaultBranch
  ) {
    trajectory.append(
      "run/failed",
      {
        phase: "workspace-postflight",
        reason: "workspace-identity-changed",
        beforeRoot: workspace.root,
        afterRoot: afterWorkspace.root,
        beforeBranch: workspace.branch,
        afterBranch: afterWorkspace.branch,
        beforeDefaultBranch: workspace.defaultBranch,
        afterDefaultBranch: afterWorkspace.defaultBranch,
      },
      deps.now(),
    );
    return buildReceipt({
      trajectory,
      status: "failed",
      cwd,
      task: input.task,
      branch: afterWorkspace.branch,
      spawn,
      changedPaths: [],
      reply,
      error: "coding harness detected that the worktree identity changed during the run",
    });
  }
  let changedPaths: string[];
  try {
    changedPaths = await resolveChangedPathsSinceRun(workspace, afterWorkspace);
  } catch (error) {
    const message = String(error);
    trajectory.append(
      "run/failed",
      { phase: "workspace-postflight", reason: "unsafe-commit-attribution", error: message },
      deps.now(),
    );
    return buildReceipt({
      trajectory,
      status: "failed",
      cwd,
      task: input.task,
      branch: afterWorkspace.branch,
      spawn,
      changedPaths: [],
      reply,
      error: message,
    });
  }
  trajectory.append(
    "workspace/observed",
    {
      branch: afterWorkspace.branch,
      changedPaths,
      statusClean: afterWorkspace.statusPorcelain.trim() === "",
    },
    deps.now(),
  );

  const verification = input.verify?.length
    ? await deps.runVerification({ cwd, command: input.verify })
    : ({ status: "not-requested" } satisfies CodingHarnessVerification);
  trajectory.append("verification/observed", verification, deps.now());

  if (input.verify?.length) {
    const verificationPostflight = await observeAcceptedRunExitWorkspace({
      deps,
      cwd,
      before: workspace,
      trajectory,
      now: deps.now,
      phase: "verification-postflight",
    });
    changedPaths = verificationPostflight.changedPaths;
    if (verificationPostflight.error) {
      return buildReceipt({
        trajectory,
        status: "failed",
        cwd,
        task: input.task,
        branch: afterWorkspace.branch,
        spawn,
        changedPaths,
        verification,
        reply,
        error: verificationPostflight.error,
        cleanup: "not-needed",
      });
    }
  }
  if (verification.status === "failed" || verification.status === "blocked") {
    trajectory.append(
      "run/failed",
      {
        phase: "verification",
        status: verification.status,
        error: verification.error,
      },
      deps.now(),
    );
    return buildReceipt({
      trajectory,
      status: "failed",
      cwd,
      task: input.task,
      branch: afterWorkspace.branch,
      spawn,
      changedPaths,
      verification,
      reply,
      error: verification.error ?? "coding verification did not pass",
      cleanup: "not-needed",
    });
  }

  const workspaceScope = spawn.workspaceScope ?? "unobserved";
  const workspaceScopeProven = workspaceScope === "confined";
  if (!workspaceScopeProven) {
    trajectory.append(
      "run/failed",
      {
        phase: "workspace-scope",
        reason: "executor-workspace-scope-unproven",
        workspaceScope,
      },
      deps.now(),
    );
  }
  const verified =
    workspaceScopeProven && changedPaths.length > 0 && verification.status === "passed";
  trajectory.append(
    "run/completed",
    {
      verified,
      changedPaths,
      verification: verification.status,
    },
    deps.now(),
  );
  return buildReceipt({
    trajectory,
    status: verified ? "verified" : "completed-unverified",
    cwd,
    task: input.task,
    branch: afterWorkspace.branch,
    spawn,
    changedPaths,
    verification,
    reply,
    workspaceScope,
    ...(workspaceScopeProven
      ? {}
      : {
          error:
            "accepted ACP executor did not provide a confined workspace proof; result is not certifiable",
        }),
    cleanup: "not-needed",
  });
}

export const __testing = {
  parseGitStatusPaths,
  resolveChangedPathsSince,
  runSafeVerification,
};
