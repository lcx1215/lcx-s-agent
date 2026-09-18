import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildLaunchAgentPlist } from "../daemon/launchd-plist.js";
// Type-only: keeps this module free of a runtime cycle with `serve-cli.ts`,
// which imports the install/uninstall/status functions below.
import type { ServeBindMode } from "./serve-cli.js";

/**
 * Self-running service for the daemon-free `serve` entry.
 *
 * `serve` is a resident process, so something has to start it and keep it
 * alive. Without that, the agent only runs when a human launches it — which is
 * exactly the dependency a daemon-free deployment is supposed to remove. This
 * module installs a per-user LaunchAgent (`RunAtLoad` + `KeepAlive`) so the
 * agent starts itself at login, restarts itself after a crash, and can then
 * self-schedule through its own in-process cron.
 *
 * Reuses the generic plist builder from `src/daemon/launchd-plist.ts` and keeps
 * its own launchctl calls, so it stays independent of the Gateway daemon's
 * service code and of that daemon's assumptions.
 *
 * The service intentionally runs from source (`--import tsx src/index.ts`)
 * rather than from `dist/`: it guarantees the resident agent matches the
 * working tree, and it works on machines that cannot complete a full bundle
 * build.
 */

export const SERVE_LAUNCH_AGENT_LABEL = "ai.openclaw.serve";

const execFileAsync = promisify(execFile);

export type ServeServiceEnv = {
  home?: string;
  /** Node binary that will run the service. Defaults to the current one. */
  nodePath?: string;
  /** Repository root containing `src/index.ts`. Resolved from this module. */
  repoDir?: string;
  bind?: ServeBindMode;
  /** Explicit opt-in to persist a bearer token into the plist. */
  token?: string;
  platform?: NodeJS.Platform;
};

/**
 * Installing needs a concrete port; the other operations only need to locate
 * the plist. Keeping `port` required here means this module never has to guess
 * the CLI's default port.
 */
export type ServeServiceInstallEnv = ServeServiceEnv & { port: number };

export type ServeServicePaths = {
  label: string;
  plistPath: string;
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
};

function resolveHome(env: ServeServiceEnv): string {
  return env.home ?? os.homedir();
}

/** Walk up from this module until a `package.json` marks the repository root. */
export async function resolveServeRepoDir(fromModuleUrl: string): Promise<string> {
  let dir = path.dirname(fileURLToPath(fromModuleUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await fs.access(path.join(dir, "package.json"));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  throw new Error("could not locate the repository root (no package.json found above this module)");
}

export function resolveServeServicePaths(env: ServeServiceEnv = {}): ServeServicePaths {
  const home = resolveHome(env);
  const logDir = path.join(home, "Library", "Logs", "lcx-serve");
  return {
    label: SERVE_LAUNCH_AGENT_LABEL,
    plistPath: path.join(home, "Library", "LaunchAgents", `${SERVE_LAUNCH_AGENT_LABEL}.plist`),
    logDir,
    stdoutPath: path.join(logDir, "serve.out.log"),
    stderrPath: path.join(logDir, "serve.err.log"),
  };
}

/**
 * Source-mode invocation. `--bind`/`--port` are explicit so the service does not
 * depend on ambient environment variables being present at login time.
 */
export function buildServeServiceProgramArguments(params: {
  nodePath: string;
  repoDir: string;
  port: number;
  bind: ServeBindMode;
}): string[] {
  return [
    params.nodePath,
    "--import",
    "tsx",
    path.join(params.repoDir, "src", "index.ts"),
    "serve",
    "--bind",
    params.bind,
    "--port",
    String(params.port),
  ];
}

function resolveGuiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) {
    throw new Error("cannot resolve the launchd GUI domain: process.getuid is unavailable");
  }
  return `gui/${uid}`;
}

async function runLaunchctl(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args, { encoding: "utf8" });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}

/**
 * Refuses to install a configuration that the server itself would refuse to
 * start. `KeepAlive` would otherwise restart a fail-closed process forever.
 */
export function assertServeServiceConfigSafe(params: {
  bind: ServeBindMode;
  token?: string;
}): void {
  if (params.bind === "lan" && !params.token?.trim()) {
    throw new Error(
      "refusing to install a non-loopback service without a token; pass --token (or use --bind loopback). " +
        "A fail-closed server under KeepAlive would restart in a loop.",
    );
  }
}

export async function installServeService(env: ServeServiceInstallEnv): Promise<{
  paths: ServeServicePaths;
  programArguments: string[];
}> {
  if ((env.platform ?? process.platform) !== "darwin") {
    throw new Error(
      `serve service install supports macOS launchd only (platform: ${process.platform})`,
    );
  }

  const port = env.port;
  const bind: ServeBindMode = env.bind ?? "loopback";
  assertServeServiceConfigSafe({ bind, token: env.token });

  const repoDir = env.repoDir ?? (await resolveServeRepoDir(import.meta.url));
  const nodePath = env.nodePath ?? process.execPath;
  const paths = resolveServeServicePaths(env);
  const programArguments = buildServeServiceProgramArguments({ nodePath, repoDir, port, bind });

  await fs.mkdir(paths.logDir, { recursive: true });
  await fs.mkdir(path.dirname(paths.plistPath), { recursive: true });

  const plist = buildLaunchAgentPlist({
    label: paths.label,
    comment: `LCX Agent daemon-free HTTP service (source mode, ${bind}:${port})`,
    programArguments,
    workingDirectory: repoDir,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    environment: {
      ...(env.token?.trim() ? { LCX_SERVE_TOKEN: env.token.trim() } : {}),
      ...(env.nodePath ? { PATH: `${path.dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin` } : {}),
    },
  });
  // The plist may carry a bearer token; keep it owner-only.
  await fs.writeFile(paths.plistPath, plist, { encoding: "utf8", mode: 0o600 });

  const domain = resolveGuiDomain();
  await runLaunchctl(["bootout", domain, paths.plistPath]);
  await runLaunchctl(["enable", `${domain}/${paths.label}`]);
  const boot = await runLaunchctl(["bootstrap", domain, paths.plistPath]);
  if (boot.code !== 0) {
    const detail = (boot.stderr || boot.stdout).trim();
    throw new Error(
      `launchctl bootstrap failed: ${detail}\n` +
        `Installing a LaunchAgent requires a logged-in macOS GUI session for this user (${domain}).`,
    );
  }
  await runLaunchctl(["kickstart", "-k", `${domain}/${paths.label}`]);

  return { paths, programArguments };
}

export async function uninstallServeService(env: ServeServiceEnv = {}): Promise<{
  plistPath: string;
  existed: boolean;
  bootoutCode: number;
}> {
  const paths = resolveServeServicePaths(env);
  let existed = true;
  try {
    await fs.access(paths.plistPath);
  } catch {
    existed = false;
  }

  const domain = resolveGuiDomain();
  const bootout = await runLaunchctl(["bootout", domain, paths.plistPath]);
  await runLaunchctl(["bootout", `${domain}/${paths.label}`]);
  if (existed) {
    await fs.unlink(paths.plistPath);
  }
  return { plistPath: paths.plistPath, existed, bootoutCode: bootout.code };
}

export type ServeServiceStatus = {
  label: string;
  plistPath: string;
  installed: boolean;
  /** `undefined` when launchctl state cannot be read (e.g. sandboxed). */
  running: boolean | undefined;
  pid?: number;
  lastExitCode?: number;
  detail?: string;
};

export async function readServeServiceStatus(
  env: ServeServiceEnv = {},
): Promise<ServeServiceStatus> {
  const paths = resolveServeServicePaths(env);
  let installed = true;
  try {
    await fs.access(paths.plistPath);
  } catch {
    installed = false;
  }

  const domain = resolveGuiDomain();
  const printed = await runLaunchctl(["print", `${domain}/${paths.label}`]);
  if (printed.code !== 0) {
    return {
      label: paths.label,
      plistPath: paths.plistPath,
      installed,
      running: installed ? undefined : false,
      detail:
        (printed.stderr || printed.stdout).trim().slice(0, 200) || "launchctl print unavailable",
    };
  }

  const pidMatch = printed.stdout.match(/^\s*pid\s*=\s*(\d+)/m);
  const stateMatch = printed.stdout.match(/^\s*state\s*=\s*(\S+)/m);
  const exitMatch = printed.stdout.match(/^\s*last exit code\s*=\s*(-?\d+)/m);
  return {
    label: paths.label,
    plistPath: paths.plistPath,
    installed,
    running: stateMatch ? stateMatch[1] === "running" : undefined,
    ...(pidMatch ? { pid: Number(pidMatch[1]) } : {}),
    ...(exitMatch ? { lastExitCode: Number(exitMatch[1]) } : {}),
  };
}
