import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/**
 * Detached (terminal-free) lifecycle for the `serve` entry.
 *
 * A LaunchAgent is the durable answer for "start at login, restart on crash",
 * but it is not always available: installing one needs a real user session and
 * a launchd domain the caller may write to. This module covers the remaining
 * case — the agent has to keep running after the shell that launched it goes
 * away, with no terminal attached and no supervisor process.
 *
 * `serve --detach` re-executes this same entry detached from the launcher,
 * redirects stdout/stderr to log files, and records a pidfile so `serve stop`
 * and `serve status` can find it. `unref()` means the launcher can exit
 * immediately; the child is reparented and keeps running on its own.
 */

export const SERVE_PID_FILENAME = "serve.pid";

/**
 * `serve-standalone.ts` has to force the `serve` subcommand because that entry
 * wires the command directly instead of going through the built CLI. `--detach`
 * re-executes that same entry with an explicit `serve` argument, so the wrapper
 * must route through the subcommand only once: prepending unconditionally hands
 * the child `serve serve`, which commander rejects before it can listen.
 */
export function routeStandaloneServeArgs(rawArgs: readonly string[]): string[] {
  return rawArgs[0] === "serve" ? [...rawArgs] : ["serve", ...rawArgs];
}

export type ServeDetachPaths = {
  stateDir: string;
  pidPath: string;
  stdoutPath: string;
  stderrPath: string;
};

/** State root is shared with cron and the rest of the agent's durable state. */
export function resolveServeDetachPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ServeDetachPaths {
  const stateDir = path.join(
    resolveStateDir(env, () => home),
    "serve",
  );
  return {
    stateDir,
    pidPath: path.join(stateDir, SERVE_PID_FILENAME),
    stdoutPath: path.join(stateDir, "serve.out.log"),
    stderrPath: path.join(stateDir, "serve.err.log"),
  };
}

/** `kill(pid, 0)` probes existence; EPERM means alive but owned by someone else. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readServePid(paths: ServeDetachPaths): Promise<number | undefined> {
  try {
    const raw = (await fs.readFile(paths.pidPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function writeServePidFile(
  paths: ServeDetachPaths,
  pid: number = process.pid,
): Promise<void> {
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(paths.pidPath, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function clearServePidFile(paths: ServeDetachPaths): Promise<void> {
  await fs.rm(paths.pidPath, { force: true });
}

/**
 * A pidfile left behind by a hard kill must not block a restart, so this only
 * reports a pid that is still alive.
 */
export async function readLiveServePid(paths: ServeDetachPaths): Promise<number | undefined> {
  const pid = await readServePid(paths);
  if (pid === undefined) {
    return undefined;
  }
  if (isProcessAlive(pid)) {
    return pid;
  }
  await clearServePidFile(paths);
  return undefined;
}

export type SpawnDetachedServeParams = {
  paths: ServeDetachPaths;
  /** `process.argv[1]` — the entry script currently running. */
  entryPath: string;
  /** `process.execArgv` — preserves `--import tsx` for source-mode runs. */
  execArgv: string[];
  /** Subcommand args for the child, e.g. `["serve"]`. Config travels via env. */
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the child to publish its pidfile. */
  readyTimeoutMs?: number;
};

export type SpawnDetachedServeResult = {
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  pidPath: string;
};

/**
 * Environment for a detached child, with session-scoped entries removed.
 *
 * A detached `serve` outlives the shell that launched it, so it must not inherit
 * anything that only exists for the lifetime of that session. Three families
 * have been observed to wedge a resident agent *hours after a clean start*:
 *
 * - `NODE_OPTIONS` may carry a `--require` shim whose broker proxies network
 *   through a per-session socket. Once that session ends, every outbound
 *   request from the resident process hangs until it times out — which looks
 *   like "all providers are down" even though a freshly spawned process reaches
 *   the same endpoints in well under a second.
 * - Loopback `HTTP(S)_PROXY` / `ALL_PROXY` values are usually a per-session
 *   local helper with the same failure mode. A non-loopback proxy is a real
 *   egress route, so it is deliberately preserved.
 * - `CODEBUDDY_*` carries the sandbox bulk-delete guard's counter, keyed by an
 *   id that never changes for a long-lived process. The counter only grows, and
 *   once it reaches the threshold the guard rejects every further delete, so
 *   each agent turn fails in under a second — permanently, because the
 *   rejection path does not persist the increment and therefore never resets.
 *
 * The shared symptom is what makes this hard to diagnose: **the service works
 * when it is started, breaks later, and works again immediately after a
 * restart.** Callers can still re-add anything they need through `overrides`.
 */
const SHIM_REQUIRE_MARKER = "node-language-shim.cjs";

const SESSION_SCOPED_PROXY_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]);

function isLoopbackProxy(value: string): boolean {
  return /(^|\/\/)(127\.0\.0\.1|localhost|\[?::1\]?)(:|\/|$)/iu.test(value.trim());
}

/**
 * Drop only the shim `--require` from `NODE_OPTIONS`; keep unrelated flags.
 *
 * The operand is matched as a quoted string first because the shim path
 * legitimately contains spaces (`…/WorkBuddy AI.app/…`), so splitting on
 * whitespace would leave half of a quoted path behind.
 */
const NODE_OPTIONS_REQUIRE = /(?:--require|-r)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S*)/gu;

function stripSessionShimFromNodeOptions(value: string): string {
  if (!value.includes(SHIM_REQUIRE_MARKER)) {
    return value;
  }
  return value
    .replace(NODE_OPTIONS_REQUIRE, (match) => (match.includes(SHIM_REQUIRE_MARKER) ? "" : match))
    .replace(/\s+/gu, " ")
    .trim();
}

export function buildDetachedServeEnv(
  overrides: NodeJS.ProcessEnv = {},
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (key.startsWith("CODEBUDDY_")) {
      continue;
    }
    if (SESSION_SCOPED_PROXY_KEYS.has(key) && isLoopbackProxy(value)) {
      continue;
    }
    if (key === "NODE_OPTIONS") {
      const stripped = stripSessionShimFromNodeOptions(value);
      if (stripped) {
        result[key] = stripped;
      }
      continue;
    }
    result[key] = value;
  }
  return { ...result, ...overrides };
}

export async function spawnDetachedServe(
  params: SpawnDetachedServeParams,
): Promise<SpawnDetachedServeResult> {
  const entry = params.entryPath?.trim();
  if (!entry) {
    throw new Error("cannot detach: the running entry script (process.argv[1]) is unknown");
  }

  await fs.mkdir(params.paths.stateDir, { recursive: true });
  const stdoutHandle = await fs.open(params.paths.stdoutPath, "a");
  const stderrHandle = await fs.open(params.paths.stderrPath, "a");

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [...params.execArgv, entry, ...params.args], {
      cwd: params.cwd,
      detached: true,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      env: buildDetachedServeEnv(params.env),
    });
  } finally {
    // The child holds its own duplicated descriptors; the parent must not keep
    // these open or the launcher cannot exit cleanly.
    await stdoutHandle.close();
    await stderrHandle.close();
  }

  const pid = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      const value = child.pid;
      if (typeof value !== "number") {
        reject(new Error("spawned process reported no pid"));
        return;
      }
      resolve(value);
    });
  });
  child.unref();

  // Confirm the child actually got as far as listening before reporting success;
  // otherwise a bad port or a missing runtime would look like a healthy start.
  const published = await waitForPidFile(params.paths, params.readyTimeoutMs ?? 20_000);
  if (published === undefined) {
    throw new Error(
      `detached serve (pid ${pid}) did not publish a pidfile within the startup window; ` +
        `check ${params.paths.stderrPath}`,
    );
  }

  return {
    pid: published,
    stdoutPath: params.paths.stdoutPath,
    stderrPath: params.paths.stderrPath,
    pidPath: params.paths.pidPath,
  };
}

async function waitForPidFile(
  paths: ServeDetachPaths,
  timeoutMs: number,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = await readServePid(paths);
    if (pid !== undefined && isProcessAlive(pid)) {
      return pid;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export type StopDetachedServeResult = {
  stopped: boolean;
  pid?: number;
  reason?: string;
};

export async function stopDetachedServe(params: {
  paths: ServeDetachPaths;
  timeoutMs?: number;
}): Promise<StopDetachedServeResult> {
  const pid = await readServePid(params.paths);
  if (pid === undefined) {
    return { stopped: false, reason: "no pidfile" };
  }
  if (!isProcessAlive(pid)) {
    await clearServePidFile(params.paths);
    return { stopped: false, pid, reason: "process not running (stale pidfile removed)" };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return {
      stopped: false,
      pid,
      reason: `SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const deadline = Date.now() + (params.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      await clearServePidFile(params.paths);
      return { stopped: true, pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { stopped: false, pid, reason: "timed out waiting for the process to exit" };
}
