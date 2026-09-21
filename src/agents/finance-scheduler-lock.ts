import fs from "node:fs";
import path from "node:path";

export const FINANCE_SCHEDULER_PID = "daily-cycle-scheduler.pid";
export const FINANCE_SCHEDULER_LOCK = "daily-cycle-scheduler.lock";

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

/**
 * One writer per book, including manual runs. Never auto-steal a crash lock:
 * the scheduler may be dead while its cycle or venue request remains in flight.
 */
export function acquireFinanceSchedulerLock(directory: string): () => void {
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, FINANCE_SCHEDULER_LOCK);
  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `finance scheduler lock exists at ${lockPath}; inspect owner and reconcile interrupted runs before recovery`,
        { cause: error },
      );
    }
    throw error;
  }
  let pidWritten = false;
  try {
    // Compatibility: do not overlap a scheduler started before the lock existed.
    const legacyPid = readFinanceSchedulerPid(directory);
    if (legacyPid !== null && financeSchedulerPidPresent(legacyPid)) {
      throw new Error(`finance scheduler pid ${legacyPid} is still alive`);
    }
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), `${process.pid}\n`);
    pidWritten = true;
  } catch (error) {
    fs.rmSync(lockPath, { recursive: true });
    throw error;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (pidWritten && readFinanceSchedulerPid(directory) === process.pid) {
      fs.rmSync(path.join(directory, FINANCE_SCHEDULER_PID), { force: true });
    }
    fs.rmSync(lockPath, { recursive: true });
  };
}
