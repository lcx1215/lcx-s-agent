import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type Mode = "status" | "acquire" | "release";

export type TrainingRepairPlanContext = {
  schemaVersion: "lcx_training_repair_context_v1";
  decisionId: string;
  worktree: string;
  codexRepairEligible: boolean;
};

type PlanningInput = { context: TrainingRepairPlanContext; contentSha256: string };

function readPlanContext(value: unknown): TrainingRepairPlanContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    record.schemaVersion !== "lcx_training_repair_context_v1" ||
    typeof record.decisionId !== "string" ||
    !/^[a-z][a-z0-9_]{0,127}$/u.test(record.decisionId) ||
    typeof record.worktree !== "string" ||
    !path.isAbsolute(record.worktree) ||
    typeof record.codexRepairEligible !== "boolean"
  ) {
    return undefined;
  }
  return record as TrainingRepairPlanContext;
}

type CliOptions = {
  mode: Mode;
  lane: string;
  token?: string;
  lockPath: string;
  worktreeDir: string;
  ttlMinutes: number;
  allowDirty: boolean;
  json: boolean;
  planContextJson?: string;
  planningInput?: PlanningInput;
};

type RepairLock = {
  token: string;
  lane: string;
  pid: number;
  cwd: string;
  startedAt: string;
  expiresAt: string;
  command: string;
  planningInput?: PlanningInput;
};

type ParsedLock = RepairLock | undefined;
type ParsedLockState = {
  lock: ParsedLock;
  malformed: boolean;
  unreadable?: true;
};

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME ?? os.homedir();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_LOCK = path.join(HOME, ".openclaw", "workspace", "run", "lcx-automation-repair.lock");
const DEFAULT_TTL_MINUTES = 90;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-automation-repair-lock.ts --mode acquire --lane NAME [--json]",
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
      "  --worktree DIR       git worktree to guard, default script directory repo root",
      "  --ttl-minutes N      lock expiry, default 90",
      "  --allow-dirty        allow acquiring while git worktree is dirty",
      "  --plan-context-json JSON  selected training repair decision; no execution authority",
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
    worktreeDir: REPO_ROOT,
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
    } else if (arg === "--plan-context-json") {
      options.planContextJson = readValue(args, index);
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
  if (options.planContextJson !== undefined && options.mode !== "acquire") {
    usage();
  }
  if (options.mode !== "status" && !options.lane.trim()) {
    usage();
  }
  return options;
}

async function gitStatusPorcelain(cwd: string): Promise<string[] | undefined> {
  try {
    const result = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
      maxBuffer: 1024 * 1024,
      // A stalled Git check cannot establish clean ownership or hold this gate forever.
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

async function readLock(lockPath: string): Promise<ParsedLockState> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lock: undefined, malformed: false };
    }
    return { lock: undefined, malformed: false, unreadable: true };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { lock: undefined, malformed: true };
    }
    const record = value as Record<string, unknown>;
    const texts = ["token", "lane", "cwd", "command"] as const;
    const startedAt = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : NaN;
    const expiresAt = typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : NaN;
    if (
      texts.some((key) => typeof record[key] !== "string" || !String(record[key]).trim()) ||
      !Number.isSafeInteger(record.pid) ||
      Number(record.pid) < 1 ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= startedAt
    ) {
      return { lock: undefined, malformed: true };
    }
    let planningInput: PlanningInput | undefined;
    if (record.planningInput !== undefined) {
      const input = record.planningInput;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { lock: undefined, malformed: true };
      }
      const metadata = input as Record<string, unknown>;
      const context = readPlanContext(metadata.context);
      if (
        !context ||
        context.worktree !== record.cwd ||
        typeof metadata.contentSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(metadata.contentSha256)
      ) {
        return { lock: undefined, malformed: true };
      }
      planningInput = { context, contentSha256: metadata.contentSha256 };
    }
    return {
      lock: {
        token: String(record.token),
        lane: String(record.lane),
        pid: Number(record.pid),
        cwd: String(record.cwd),
        command: String(record.command),
        startedAt: String(record.startedAt),
        expiresAt: String(record.expiresAt),
        ...(planningInput ? { planningInput } : {}),
      },
      malformed: false,
    };
  } catch {
    return { lock: undefined, malformed: true };
  }
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
    ...(lock.planningInput ? { planningInput: lock.planningInput } : {}),
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
    ...(options.planningInput ? { planningInput: options.planningInput } : {}),
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
  if (options.lane.trim() === "unknown") {
    return {
      ok: true,
      acquired: false,
      status: "blocked_lock_identity_unconfirmed",
      boundary: "local_automation_coordination_only",
      reason:
        "Acquire requires a declared known repair lane; unknown ownership cannot be released safely",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
  if (options.planContextJson !== undefined) {
    let context: TrainingRepairPlanContext | undefined;
    try {
      if (Buffer.byteLength(options.planContextJson, "utf8") <= 1024) {
        context = readPlanContext(JSON.parse(options.planContextJson));
      }
    } catch {
      /* A malformed declared input cannot grant a lease. */
    }
    const reason = !context
      ? "training_plan_context_invalid"
      : context.worktree !== options.worktreeDir
        ? "training_plan_worktree_conflict"
        : !context.codexRepairEligible
          ? "training_plan_repair_not_eligible"
          : undefined;
    if (reason) {
      return {
        ok: true,
        acquired: false,
        status: `blocked_${reason}`,
        boundary: "local_automation_coordination_only",
        reason,
        ...(reason === "training_plan_repair_not_eligible" && context
          ? {
              rejectedPlanningInput: {
                context,
                contentSha256: crypto
                  .createHash("sha256")
                  .update(options.planContextJson)
                  .digest("hex"),
                status: "not_eligible",
              },
            }
          : {}),
        lockPath: options.lockPath,
        worktreeDir: options.worktreeDir,
        liveTouched: false,
        providerConfigTouched: false,
      };
    }
    options.planningInput = {
      context: context!,
      contentSha256: crypto.createHash("sha256").update(options.planContextJson).digest("hex"),
    };
  }
  const dirtyFiles = await gitStatusPorcelain(options.worktreeDir);
  if (!dirtyFiles) {
    return {
      ok: true,
      acquired: false,
      status: "blocked_worktree_status_unavailable",
      boundary: "local_automation_coordination_only",
      reason:
        "Git status is unavailable; verify the requested worktree before acquiring repair ownership",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
  if (!options.allowDirty && dirtyFiles.length > 0) {
    return {
      ok: true,
      acquired: false,
      status: "dirty_worktree",
      boundary: "local_automation_coordination_only",
      reason:
        "worktree has uncommitted changes; automation repair must not stack new edits on existing WIP",
      dirtyFiles,
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      liveTouched: false,
      providerConfigTouched: false,
    };
  }

  const existingState = await readLock(options.lockPath);
  if (existingState.malformed || existingState.unreadable) {
    return {
      ok: true,
      acquired: false,
      status: existingState.unreadable ? "blocked_lock_status_unavailable" : "locked",
      boundary: "local_automation_coordination_only",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      lock: undefined,
      malformedLock: existingState.malformed,
      unreadableLock: existingState.unreadable === true,
      reason: existingState.unreadable
        ? "Lock state is unreadable; ownership is unconfirmed"
        : "Existing lock is malformed; do not overwrite unconfirmed ownership",
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
  const existing = existingState.lock;
  if (existing && !isExpired(existing)) {
    return {
      ok: true,
      acquired: false,
      status: "locked",
      boundary: "local_automation_coordination_only",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      lock: publicLock(existing),
      malformedLock: false,
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
      boundary: "local_automation_coordination_only",
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
      status: racedLock.unreadable ? "blocked_lock_status_unavailable" : "locked",
      boundary: "local_automation_coordination_only",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      lock: publicLock(racedLock.lock),
      malformedLock: racedLock.malformed,
      unreadableLock: racedLock.unreadable === true,
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
}

async function release(options: CliOptions): Promise<Record<string, unknown>> {
  const existingState = await readLock(options.lockPath);
  const existing = existingState.lock;
  if (!existing) {
    return {
      ok: true,
      released: false,
      status: existingState.unreadable
        ? "blocked_lock_status_unavailable"
        : existingState.malformed
          ? "locked"
          : "missing",
      boundary: "local_automation_coordination_only",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      malformedLock: existingState.malformed,
      unreadableLock: existingState.unreadable === true,
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
  if (!options.token || options.token !== existing.token) {
    return {
      ok: false,
      released: false,
      status: "token_mismatch",
      boundary: "local_automation_coordination_only",
      lockPath: options.lockPath,
      worktreeDir: options.worktreeDir,
      lock: publicLock(existing),
      malformedLock: existingState.malformed,
      liveTouched: false,
      providerConfigTouched: false,
    };
  }
  const identityStatus =
    !path.isAbsolute(existing.cwd) ||
    existing.lane.trim() === "unknown" ||
    options.lane.trim() === "unknown"
      ? "blocked_lock_identity_unconfirmed"
      : path.resolve(existing.cwd) !== path.resolve(options.worktreeDir)
        ? "worktree_mismatch"
        : existing.lane !== options.lane
          ? "lane_mismatch"
          : undefined;
  if (identityStatus) {
    return {
      ok: false,
      released: false,
      status: identityStatus,
      boundary: "local_automation_coordination_only",
      reason: "Release requires the original known worktree, lane and token",
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
    boundary: "local_automation_coordination_only",
    lockPath: options.lockPath,
    worktreeDir: options.worktreeDir,
    liveTouched: false,
    providerConfigTouched: false,
  };
}

async function status(options: CliOptions): Promise<Record<string, unknown>> {
  const existingState = await readLock(options.lockPath);
  const existing = existingState.lock;
  return {
    ok: true,
    status: existingState.unreadable
      ? "blocked_lock_status_unavailable"
      : existingState.malformed
        ? "locked"
        : existing
          ? isExpired(existing)
            ? "expired"
            : "locked"
          : "unlocked",
    boundary: "local_automation_coordination_only",
    lockPath: options.lockPath,
    worktreeDir: options.worktreeDir,
    lock: publicLock(existing),
    malformedLock: existingState.malformed,
    unreadableLock: existingState.unreadable === true,
    ...(existingState.unreadable
      ? { reason: "Lock state is unreadable; ownership is unconfirmed" }
      : {}),
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
// A validated plan remains part of the outcome even when a later ownership gate refuses it.
const receipt = options.planningInput
  ? { ...payload, planningInput: options.planningInput }
  : payload;
printJson(receipt);
if (payload.ok === false) {
  process.exitCode = 1;
}
