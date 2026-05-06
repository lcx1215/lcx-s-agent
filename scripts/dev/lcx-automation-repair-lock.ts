import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type Mode = "status" | "acquire" | "release";

type CliOptions = {
  mode: Mode;
  lane: string;
  token?: string;
  lockPath: string;
  worktreeDir: string;
  ttlMinutes: number;
  allowDirty: boolean;
  json: boolean;
};

type RepairLock = {
  token: string;
  lane: string;
  pid: number;
  cwd: string;
  startedAt: string;
  expiresAt: string;
  command: string;
};

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME ?? os.homedir();
const DEFAULT_LOCK = path.join(HOME, ".openclaw", "workspace", "run", "lcx-automation-repair.lock");
const DEFAULT_TTL_MINUTES = 90;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-automation-repair-lock.ts --mode acquire --lane NAME [--json]",
      "",
      "Modes:",
      "  --mode status    print current repair lock state",
      "  --mode acquire   acquire the automation repair write lock",
      "  --mode release   release the lock, requires --token TOKEN",
      "",
      "Options:",
      "  --lane NAME          automation lane name",
      "  --token TOKEN        token printed by acquire",
      "  --lock PATH          lock file path",
      "  --worktree DIR       git worktree to guard, default current directory",
      "  --ttl-minutes N      lock expiry, default 90",
      "  --allow-dirty        allow acquiring while git worktree is dirty",
      "  --json               print JSON, default true",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function readPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    usage();
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mode: "status",
    lane: "unknown",
    lockPath: DEFAULT_LOCK,
    worktreeDir: process.cwd(),
    ttlMinutes: DEFAULT_TTL_MINUTES,
    allowDirty: false,
    json: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode") {
      const value = readValue(args, index);
      if (value !== "status" && value !== "acquire" && value !== "release") {
        usage();
      }
      options.mode = value;
      index += 1;
    } else if (arg === "--lane") {
      options.lane = readValue(args, index);
      index += 1;
    } else if (arg === "--token") {
      options.token = readValue(args, index);
      index += 1;
    } else if (arg === "--lock") {
      options.lockPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--worktree") {
      options.worktreeDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--ttl-minutes") {
      options.ttlMinutes = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--allow-dirty") {
      options.allowDirty = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (options.mode !== "status" && !options.lane.trim()) {
    usage();
  }
  return options;
}

async function gitStatusPorcelain(cwd: string): Promise<string[]> {
  try {
    const result = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readLock(lockPath: string): Promise<RepairLock | undefined> {
  const raw = await fs.readFile(lockPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return undefined;
  }
  return JSON.parse(raw) as RepairLock;
}

function isExpired(lock: RepairLock): boolean {
  return Date.parse(lock.expiresAt) <= Date.now();
}

function publicLock(lock: RepairLock | undefined): Record<string, unknown> | undefined {
  if (!lock) {
    return undefined;
  }
  return {
    lane: lock.lane,
    pid: lock.pid,
    cwd: lock.cwd,
    startedAt: lock.startedAt,
    expiresAt: lock.expiresAt,
    expired: isExpired(lock),
    command: lock.command,
  };
}

function printJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function writeLock(options: CliOptions): Promise<RepairLock> {
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + options.ttlMinutes * 60_000);
  const lock: RepairLock = {
    token: crypto.randomUUID(),
    lane: options.lane,
    pid: process.pid,
    cwd: options.worktreeDir,
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    command: process.argv.join(" "),
  };
  await fs.mkdir(path.dirname(options.lockPath), { recursive: true });
  const handle = await fs.open(options.lockPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  return lock;
}

async function acquire(options: CliOptions): Promise<Record<string, unknown>> {
  const dirtyFiles = options.allowDirty ? [] : await gitStatusPorcelain(options.worktreeDir);
  if (dirtyFiles.length > 0) {
    return {
      ok: true,
      acquired: false,
      status: "dirty_worktree",
      boundary: "dev_automation_coordination_only",
      reason:
        "worktree has uncommitted changes; automation repair must not stack new edits on existing WIP",
      dirtyFiles,
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      liveTouched: false,
      providerConfigTouched: false,
    };
  }

  const existing = await readLock(options.lockPath);
  if (existing && !isExpired(existing)) {
    return {
      ok: true,
      acquired: false,
      status: "locked",
      boundary: "dev_automation_coordination_only",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      lock: publicLock(existing),
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
  if (existing && isExpired(existing)) {
    await fs.rm(options.lockPath, { force: true });
  }

  try {
    const lock = await writeLock(options);
    return {
      ok: true,
      acquired: true,
      status: "acquired",
      boundary: "dev_automation_coordination_only",
      token: lock.token,
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      lock: publicLock(lock),
      liveTouched: false,
      providerConfigTouched: false,
    };
  } catch {
    const racedLock = await readLock(options.lockPath);
    return {
      ok: true,
      acquired: false,
      status: "locked",
      boundary: "dev_automation_coordination_only",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      lock: publicLock(racedLock),
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
}

async function release(options: CliOptions): Promise<Record<string, unknown>> {
  const existing = await readLock(options.lockPath);
  if (!existing) {
    return {
      ok: true,
      released: false,
      status: "missing",
      boundary: "dev_automation_coordination_only",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
  if (!options.token || options.token !== existing.token) {
    return {
      ok: false,
      released: false,
      status: "token_mismatch",
      boundary: "dev_automation_coordination_only",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      lock: publicLock(existing),
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
  await fs.rm(options.lockPath, { force: true });
  return {
    ok: true,
    released: true,
    status: "released",
    boundary: "dev_automation_coordination_only",
    lockPath: options.lockPath,
    worktreeDir: options.worktreeDir,
    liveTouched: false,
    providerConfigTouched: false,
  };
}

async function status(options: CliOptions): Promise<Record<string, unknown>> {
  const existing = await readLock(options.lockPath);
  return {
    ok: true,
    status: existing ? (isExpired(existing) ? "expired" : "locked") : "unlocked",
    boundary: "dev_automation_coordination_only",
    lockPath: options.lockPath,
    worktreeDir: options.worktreeDir,
    lock: publicLock(existing),
    liveTouched: false,
    providerConfigTouched: false,
  };
}

const options = parseArgs(process.argv.slice(2));
const payload =
  options.mode === "acquire"
    ? await acquire(options)
    : options.mode === "release"
      ? await release(options)
      : await status(options);
printJson(payload);
if (payload.ok === false) {
  process.exitCode = 1;
}
