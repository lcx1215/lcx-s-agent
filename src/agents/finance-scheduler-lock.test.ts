import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  acquireFinanceSchedulerLock,
  FINANCE_SCHEDULER_LOCK,
  FINANCE_SCHEDULER_LOCK_ARCHIVE,
  FINANCE_SCHEDULER_RECOVERY_PREFIX,
  FINANCE_SCHEDULER_PID,
  financeSchedulerPidPresent,
  readFinanceSchedulerPid,
  readFinanceSchedulerBootId,
} from "./finance-scheduler-lock.js";

const CURRENT_BOOT = "11111111-1111-4111-8111-111111111111";
const OLD_BOOT = "22222222-2222-4222-8222-222222222222";
const DEAD_PID = 999999999;
let directory: string;

function writeOldLock(overrides: Record<string, unknown> = {}): string {
  const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({
      pid: DEAD_PID,
      startedAt: "2000-01-01T00:00:00.000Z",
      bootId: OLD_BOOT,
      ...overrides,
    }),
  );
  return lock;
}

function recoveryGuard(bootId = CURRENT_BOOT): string {
  return path.join(directory, `${FINANCE_SCHEDULER_RECOVERY_PREFIX}${bootId}`);
}
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(childProcess, "execFileSync").mockReturnValue(`${CURRENT_BOOT.toUpperCase()}\n`);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-lock-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("excludes a second writer and releases the PID and lock idempotently", () => {
  const release = acquireFinanceSchedulerLock(directory);
  expect(readFinanceSchedulerPid(directory)).toBe(process.pid);
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
  release();
  release();
  expect(readFinanceSchedulerPid(directory)).toBeNull();
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
  acquireFinanceSchedulerLock(directory)();
});

it("protects the same book addressed by a directory symlink", () => {
  const book = path.join(directory, "book");
  fs.mkdirSync(book);
  const alias = path.join(directory, "alias");
  fs.symlinkSync(book, alias, "dir");
  const release = acquireFinanceSchedulerLock(book);
  try {
    expect(() => acquireFinanceSchedulerLock(alias)).toThrow("lock exists");
  } finally {
    release();
  }
});

it("preserves a crash lock even when its owner is absent", () => {
  const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), '{"pid":999999999,"startedAt":"2000-01-01"}');
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("reconcile interrupted runs");
  expect(fs.existsSync(lock)).toBe(true);
});

it("does not overlap the legacy running scheduler or remove its PID", () => {
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("still alive");
  expect(readFinanceSchedulerPid(directory)).toBe(process.pid);
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
});

it("does not treat probe permission denial as a dead owner", () => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  expect(financeSchedulerPidPresent(123)).toBe(true);
});

it("fails closed on a malformed PID", () => {
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), "invalid");
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("invalid finance scheduler pid");
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
});

it("records a normalized reliable boot UUID and unique ownership token", () => {
  const release = acquireFinanceSchedulerLock(directory);
  const owner = JSON.parse(
    fs.readFileSync(path.join(directory, FINANCE_SCHEDULER_LOCK, "owner.json"), "utf8"),
  );
  expect(owner).toMatchObject({ pid: process.pid, bootId: CURRENT_BOOT });
  expect(owner.ownerId).toMatch(/^[a-f0-9-]{36}$/);
  expect(childProcess.execFileSync).toHaveBeenCalledWith(
    "/usr/sbin/sysctl",
    ["-n", "kern.bootsessionuuid"],
    expect.objectContaining({ timeout: 1000 }),
  );
  expect(fs.existsSync(recoveryGuard())).toBe(false);
  release();
});

it("reads the Linux boot UUID from the kernel file", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file === "/proc/sys/kernel/random/boot_id") {
      return `${CURRENT_BOOT}\n`;
    }
    return read(file, options);
  });
  expect(readFinanceSchedulerBootId()).toBe(CURRENT_BOOT);
  expect(childProcess.execFileSync).not.toHaveBeenCalled();
});

it.each(["unreadable", "malformed", "unsupported"])(
  "fails closed on %s current boot evidence",
  (kind) => {
    if (kind === "unreadable") {
      vi.mocked(childProcess.execFileSync).mockImplementation(() => {
        throw new Error("unavailable");
      });
    } else if (kind === "malformed") {
      vi.mocked(childProcess.execFileSync).mockReturnValue("not-a-boot-uuid");
    } else {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    }
    expect(readFinanceSchedulerBootId()).toBeNull();
    const release = acquireFinanceSchedulerLock(directory);
    const ownerPath = path.join(directory, FINANCE_SCHEDULER_LOCK, "owner.json");
    expect(JSON.parse(fs.readFileSync(ownerPath, "utf8"))).not.toHaveProperty("bootId");
    release();
    const old = writeOldLock();
    const bytes = fs.readFileSync(path.join(old, "owner.json"));
    expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
    expect(fs.readFileSync(path.join(old, "owner.json"))).toEqual(bytes);
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK_ARCHIVE))).toBe(false);
  },
);

it("preserves a same-boot dead owner for operator inspection", () => {
  const lock = writeOldLock({ bootId: CURRENT_BOOT });
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
  expect(fs.existsSync(lock)).toBe(true);
  expect(fs.existsSync(recoveryGuard())).toBe(false);
});

it("archives a dead previous-boot lock with all original bytes and creates the new owner", () => {
  const lock = writeOldLock();
  const ownerBytes = fs.readFileSync(path.join(lock, "owner.json"));
  const progressBytes = Buffer.from([0, 255, 10, 66]);
  fs.mkdirSync(path.join(lock, "progress"));
  fs.writeFileSync(path.join(lock, "progress", "checkpoint.bin"), progressBytes);
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), `${DEAD_PID}\n`);
  // The ownership handoff must not alter execution or research state.
  fs.writeFileSync(path.join(directory, "execution-journal.jsonl"), "uncertain\n");
  fs.writeFileSync(path.join(directory, "daily-cycle-scheduler.json"), "running-attempt-1\n");
  const release = acquireFinanceSchedulerLock(directory);
  const archiveRoot = path.join(directory, FINANCE_SCHEDULER_LOCK_ARCHIVE);
  const entries = fs.readdirSync(archiveRoot);
  expect(entries).toHaveLength(1);
  const archive = path.join(archiveRoot, entries[0]);
  expect(fs.readFileSync(path.join(archive, "owner.json"))).toEqual(ownerBytes);
  expect(fs.readFileSync(path.join(archive, "progress", "checkpoint.bin"))).toEqual(progressBytes);
  expect(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"))).toMatchObject({
    pid: process.pid,
    bootId: CURRENT_BOOT,
  });
  expect(fs.readFileSync(path.join(directory, "execution-journal.jsonl"), "utf8")).toBe(
    "uncertain\n",
  );
  expect(fs.readFileSync(path.join(directory, "daily-cycle-scheduler.json"), "utf8")).toBe(
    "running-attempt-1\n",
  );
  expect(fs.existsSync(recoveryGuard())).toBe(false);
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
  expect(fs.readdirSync(archiveRoot)).toHaveLength(1);
  release();
  expect(fs.readFileSync(path.join(archive, "owner.json"))).toEqual(ownerBytes);
});

it.each(["owner", "legacy"])(
  "does not recover a previous-boot lock when the %s PID is alive",
  (kind) => {
    const lock = writeOldLock(kind === "owner" ? { pid: process.pid } : {});
    if (kind === "legacy") {
      fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
    }
    expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK_ARCHIVE))).toBe(false);
    expect(fs.existsSync(recoveryGuard())).toBe(false);
  },
);

it.each(["EPERM", "EIO"])("does not recover when an owner probe returns %s", (code) => {
  const lock = writeOldLock();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(code), { code });
  });
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
  expect(fs.existsSync(lock)).toBe(true);
  expect(fs.existsSync(recoveryGuard())).toBe(false);
});

it.each(["bad-json", "invalid-pid", "invalid-boot", "invalid-start"])(
  "preserves %s owner evidence",
  (kind) => {
    const lock = writeOldLock(
      kind === "invalid-pid"
        ? { pid: "123" }
        : kind === "invalid-boot"
          ? { bootId: "bad" }
          : kind === "invalid-start"
            ? { startedAt: "bad" }
            : {},
    );
    if (kind === "bad-json") {
      fs.writeFileSync(path.join(lock, "owner.json"), "{bad}");
    }
    const bytes = fs.readFileSync(path.join(lock, "owner.json"));
    expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
    expect(fs.readFileSync(path.join(lock, "owner.json"))).toEqual(bytes);
  },
);

it("preserves a previous-boot owner when the legacy PID file is malformed", () => {
  const lock = writeOldLock();
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), "bad");
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("invalid finance scheduler pid");
  expect(fs.existsSync(lock)).toBe(true);
  expect(fs.existsSync(recoveryGuard())).toBe(false);
});

it.each([false, true])(
  "blocks a guard contender without removing the guard (old lock: %s)",
  (oldLock) => {
    if (oldLock) {
      writeOldLock();
    }
    fs.mkdirSync(recoveryGuard());
    expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
    expect(fs.existsSync(recoveryGuard())).toBe(true);
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK_ARCHIVE))).toBe(false);
  },
);

it("ignores a prior-boot guard while preserving it", () => {
  writeOldLock();
  fs.mkdirSync(recoveryGuard(OLD_BOOT));
  const release = acquireFinanceSchedulerLock(directory);
  expect(fs.existsSync(recoveryGuard(OLD_BOOT))).toBe(true);
  expect(fs.existsSync(recoveryGuard())).toBe(false);
  release();
});

it("refuses a marker-less starter during a guarded recovery handoff", () => {
  vi.mocked(childProcess.execFileSync).mockReturnValue("bad");
  fs.mkdirSync(recoveryGuard());
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
  expect(fs.existsSync(recoveryGuard())).toBe(true);
});

it.each(["bytes", "inode"])("rechecks old owner %s after taking the guard", (change) => {
  const lock = writeOldLock();
  const mkdir = fs.mkdirSync;
  vi.spyOn(fs, "mkdirSync").mockImplementation((file, options) => {
    const result = mkdir(file, options);
    if (file === recoveryGuard()) {
      if (change === "inode") {
        fs.renameSync(lock, path.join(directory, "preserved-old"));
        mkdir(lock);
      }
      fs.writeFileSync(
        path.join(lock, "owner.json"),
        JSON.stringify({ pid: DEAD_PID, startedAt: "2000-01-01", bootId: OLD_BOOT, revision: 2 }),
      );
    }
    return result;
  });
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
  expect(fs.existsSync(lock)).toBe(true);
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK_ARCHIVE))).toBe(false);
  expect(fs.existsSync(recoveryGuard())).toBe(false);
});

it("releases the guard and preserves the original lock after an archive failure", () => {
  const lock = writeOldLock();
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("archive failed");
  });
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("archive failed");
  expect(fs.existsSync(lock)).toBe(true);
  expect(fs.existsSync(recoveryGuard())).toBe(false);
});

it.each(["owner", "directory"])(
  "an old release preserves a replacement %s even with the same PID",
  (change) => {
    const release = acquireFinanceSchedulerLock(directory);
    const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
    if (change === "directory") {
      fs.renameSync(lock, path.join(directory, "preserved-original"));
      fs.mkdirSync(lock);
    }
    const bytes = JSON.stringify({
      pid: process.pid,
      startedAt: "2000-01-01",
      bootId: CURRENT_BOOT,
      ownerId: "replacement",
    });
    fs.writeFileSync(path.join(lock, "owner.json"), bytes);
    release();
    expect(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).toBe(bytes);
    expect(readFinanceSchedulerPid(directory)).toBe(process.pid);
  },
);

it("does not remove a PID file belonging to another process on release", () => {
  const release = acquireFinanceSchedulerLock(directory);
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(DEAD_PID));
  release();
  expect(readFinanceSchedulerPid(directory)).toBe(DEAD_PID);
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
});

it("keeps the recovery guard across the archive-to-new-lock window", () => {
  writeOldLock();
  const rename = fs.renameSync;
  let contenderBlocked = false;
  vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    rename(source, destination);
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
    expect(fs.existsSync(recoveryGuard())).toBe(true);
    expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
    contenderBlocked = true;
  });
  const release = acquireFinanceSchedulerLock(directory);
  expect(contenderBlocked).toBe(true);
  expect(fs.existsSync(recoveryGuard())).toBe(false);
  release();
});

it("preserves archived evidence and releases the guard when writing the new owner fails", () => {
  const lock = writeOldLock();
  const oldBytes = fs.readFileSync(path.join(lock, "owner.json"));
  const write = fs.writeFileSync;
  vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (file === path.join(lock, "owner.json")) {
      throw new Error("owner write failed");
    }
    return write(file, data, options);
  });
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("owner write failed");
  const archiveRoot = path.join(directory, FINANCE_SCHEDULER_LOCK_ARCHIVE);
  const archive = path.join(archiveRoot, fs.readdirSync(archiveRoot)[0]);
  expect(fs.readFileSync(path.join(archive, "owner.json"))).toEqual(oldBytes);
  expect(fs.existsSync(lock)).toBe(false);
  expect(fs.existsSync(recoveryGuard())).toBe(false);
});

it("allows exactly one of two real processes to recover a previous-boot lock", async () => {
  vi.restoreAllMocks();
  const actualBoot = readFinanceSchedulerBootId();
  expect(actualBoot).not.toBeNull();
  writeOldLock({ bootId: actualBoot === OLD_BOOT ? CURRENT_BOOT : OLD_BOOT });
  const moduleUrl = new URL("./finance-scheduler-lock.ts", import.meta.url).href;
  const script = `
    import { acquireFinanceSchedulerLock } from ${JSON.stringify(moduleUrl)};
    let release;
    process.on("message", (message) => {
      if (message === "go") {
        try {
          release = acquireFinanceSchedulerLock(${JSON.stringify(directory)});
          process.send({ status: "acquired" });
        } catch (error) {
          process.send({ status: "blocked", error: String(error) });
        }
      } else if (message === "release") {
        release?.();
        process.disconnect();
      }
    });
    process.send({ status: "ready" });
  `;
  const children = Array.from({ length: 2 }, () =>
    childProcess.spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  );
  const waitForStatus = (child: childProcess.ChildProcess, ready: boolean) =>
    new Promise<{ status: string; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child status timeout")), 10000);
      child.once("error", reject);
      const listener = (message: { status: string; error?: string }) => {
        if ((message.status === "ready") === ready) {
          clearTimeout(timer);
          child.off("message", listener);
          resolve(message);
        }
      };
      child.on("message", listener);
    });
  try {
    await Promise.all(children.map((child) => waitForStatus(child, true)));
    const outcomes = children.map((child) => waitForStatus(child, false));
    for (const child of children) {
      child.send("go");
    }
    const results = await Promise.all(outcomes);
    expect(results.map((result) => result.status).toSorted()).toEqual(["acquired", "blocked"]);
    expect(results.find((result) => result.status === "blocked")?.error).toContain("lock exists");
    const archiveRoot = path.join(directory, FINANCE_SCHEDULER_LOCK_ARCHIVE);
    expect(fs.readdirSync(archiveRoot)).toHaveLength(1);
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(true);
    expect(
      fs.existsSync(path.join(directory, `${FINANCE_SCHEDULER_RECOVERY_PREFIX}${actualBoot}`)),
    ).toBe(false);
  } finally {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) {
              resolve();
              return;
            }
            const timer = setTimeout(() => child.kill(), 1000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            if (child.connected) {
              child.send("release");
            } else {
              child.kill();
            }
          }),
      ),
    );
  }
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
}, 20000);
