import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FINANCE_SCHEDULER_PID = "daily-cycle-scheduler.pid";
export const FINANCE_SCHEDULER_LOCK = "daily-cycle-scheduler.lock";
export const FINANCE_SCHEDULER_LOCK_ARCHIVE = "daily-cycle-scheduler.lock-archive";
export const FINANCE_SCHEDULER_RECOVERY_PREFIX = "daily-cycle-scheduler.lock-recovery-";

const BOOT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A timestamp or uptime estimate cannot establish a different host boot. */
export function readFinanceSchedulerBootId(): string | null {
  try {
    let value: string;
    if (process.platform === "darwin") {
      value = childProcess.execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } else if (process.platform === "linux") {
      value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
    } else {
      return null;
    }
    const bootId = value.trim();
    return BOOT_UUID.test(bootId) ? bootId.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function financeSchedulerPidPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors and unknown probe failures must not authorize a second writer.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function readFinanceSchedulerPid(directory: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(directory, FINANCE_SCHEDULER_PID), "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("invalid finance scheduler pid file; inspect before recovery");
    }
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

type LockSnapshot = {
  stat: fs.Stats;
  bytes: Buffer;
  pid: number;
  bootId: string | null;
};

function sameDirectory(lockPath: string, expected: fs.Stats): boolean {
  try {
    const current = fs.lstatSync(lockPath);
    return current.isDirectory() && current.dev === expected.dev && current.ino === expected.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function lockBlocked(lockPath: string, cause?: unknown): Error {
  return new Error(
    `finance scheduler lock exists at ${lockPath}; inspect owner and reconcile interrupted runs before recovery`,
    { cause },
  );
}

function readLockSnapshot(lockPath: string): LockSnapshot | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    if (!stat.isDirectory()) {
      throw new Error("scheduler lock is not a directory");
    }
    const bytes = fs.readFileSync(path.join(lockPath, "owner.json"));
    const owner: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof owner !== "object" ||
      owner === null ||
      !("pid" in owner) ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !("startedAt" in owner) ||
      typeof owner.startedAt !== "string" ||
      !Number.isFinite(Date.parse(owner.startedAt))
    ) {
      throw new Error("invalid scheduler lock owner");
    }
    let bootId: string | null = null;
    if ("bootId" in owner) {
      if (typeof owner.bootId !== "string" || !BOOT_UUID.test(owner.bootId)) {
        throw new Error("invalid scheduler lock boot UUID");
      }
      bootId = owner.bootId.toLowerCase();
    }
    if (!sameDirectory(lockPath, stat)) {
      throw new Error("scheduler lock changed while reading owner");
    }
    return { stat, bytes, pid: owner.pid, bootId };
  } catch (error) {
    throw lockBlocked(lockPath, error);
  }
}

function recoverPreviousBootLock(
  directory: string,
  lockPath: string,
  bootId: string,
  expected: LockSnapshot | null,
): void {
  // Called only while holding this boot's acquisition/recovery guard.
  const current = readLockSnapshot(lockPath);
  if (
    !expected ||
    !current ||
    !current.bootId ||
    current.bootId === bootId ||
    current.stat.dev !== expected.stat.dev ||
    current.stat.ino !== expected.stat.ino ||
    !current.bytes.equals(expected.bytes)
  ) {
    throw lockBlocked(lockPath);
  }
  const legacyPid = readFinanceSchedulerPid(directory);
  if (
    financeSchedulerPidPresent(current.pid) ||
    (legacyPid !== null && financeSchedulerPidPresent(legacyPid))
  ) {
    throw lockBlocked(lockPath);
  }
  // Preserve the complete old process lock. Order journals and cycle state are untouched.
  const archivePath = path.join(directory, FINANCE_SCHEDULER_LOCK_ARCHIVE);
  fs.mkdirSync(archivePath, { recursive: true });
  fs.renameSync(lockPath, path.join(archivePath, `${current.bootId}-${randomUUID()}`));
}

/**
 * One writer per book, including manual runs. Same-boot crashes and legacy locks
 * require inspection; a proven previous boot can hand off process ownership only.
 */
export function acquireFinanceSchedulerLock(directory: string): () => void {
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, FINANCE_SCHEDULER_LOCK);
  const bootId = readFinanceSchedulerBootId();
  const expected = readLockSnapshot(lockPath);
  let guardPath: string | null = null;
  let guardStat: fs.Stats | null = null;
  if (bootId) {
    guardPath = path.join(directory, `${FINANCE_SCHEDULER_RECOVERY_PREFIX}${bootId}`);
    try {
      // Fresh acquisitions share the guard too, closing the archive -> mkdir window.
      fs.mkdirSync(guardPath);
      guardStat = fs.lstatSync(guardPath);
    } catch (error) {
      throw lockBlocked(lockPath, error);
    }
  } else if (expected) {
    throw lockBlocked(lockPath);
  }
  let ownedStat: fs.Stats | null = null;
  let ownerBytes: Buffer | null = null;
  try {
    try {
      fs.mkdirSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !bootId) {
        throw lockBlocked(lockPath, error);
      }
      recoverPreviousBootLock(directory, lockPath, bootId, expected);
      fs.mkdirSync(lockPath);
    }
    ownedStat = fs.lstatSync(lockPath);
    // A marker-less starter must not enter another process's recovery window.
    if (
      !bootId &&
      fs.readdirSync(directory).some((entry) => entry.startsWith(FINANCE_SCHEDULER_RECOVERY_PREFIX))
    ) {
      throw lockBlocked(lockPath);
    }
    // Compatibility: do not overlap a scheduler started before the lock existed.
    const legacyPid = readFinanceSchedulerPid(directory);
    if (legacyPid !== null && financeSchedulerPidPresent(legacyPid)) {
      throw new Error(`finance scheduler pid ${legacyPid} is still alive`);
    }
    const bytes = Buffer.from(
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        ownerId: randomUUID(),
        ...(bootId ? { bootId } : {}),
      }),
    );
    fs.writeFileSync(path.join(lockPath, "owner.json"), bytes);
    ownerBytes = bytes;
    fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), `${process.pid}\n`);
  } catch (error) {
    if (ownedStat && sameDirectory(lockPath, ownedStat)) {
      if (!ownerBytes || fs.readFileSync(path.join(lockPath, "owner.json")).equals(ownerBytes)) {
        fs.rmSync(lockPath, { recursive: true });
      }
    }
    throw error;
  } finally {
    if (guardPath && guardStat && sameDirectory(guardPath, guardStat)) {
      fs.rmdirSync(guardPath);
    }
  }
  const acquiredStat = ownedStat;
  const acquiredOwner = ownerBytes;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    // An old release must not remove a replacement owner, even with a reused PID.
    if (!acquiredStat || !acquiredOwner || !sameDirectory(lockPath, acquiredStat)) {
      return;
    }
    const current = readLockSnapshot(lockPath);
    if (!current || current.pid !== process.pid || !current.bytes.equals(acquiredOwner)) {
      return;
    }
    if (readFinanceSchedulerPid(directory) === process.pid) {
      fs.rmSync(path.join(directory, FINANCE_SCHEDULER_PID), { force: true });
    }
    fs.rmSync(lockPath, { recursive: true });
  };
}
