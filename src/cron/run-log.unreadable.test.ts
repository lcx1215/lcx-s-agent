import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../logger.js";
import {
  appendCronRunLog,
  readCronRunLogEntriesPage,
  readCronRunLogEntriesPageAll,
  resolveCronRunLogPath,
} from "./run-log.js";

vi.mock("../logger.js", () => ({ logWarn: vi.fn() }));

/**
 * The failure this covers: a cron run log that could not be read used to come back as "no runs".
 * For an unattended job those two are opposite claims — one says the job did nothing, the other
 * says nobody can tell what it did — and only the second one needs a human.
 */
describe("cron run log reports what it could not read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function withStore(run: (storePath: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-unreadable-"));
    try {
      await run(path.join(dir, "jobs.json"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: simulated`), { code });
  }

  function runLine(jobId: string, ts: number): string {
    return `${JSON.stringify({ ts, jobId, action: "finished", status: "ok" })}\n`;
  }

  it("says the log was unreadable instead of saying the job never ran", async () => {
    await withStore(async (storePath) => {
      const logPath = resolveCronRunLogPath({ storePath, jobId: "job-1" });
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, runLine("job-1", 1_000));
      vi.spyOn(fs, "readFile").mockRejectedValue(errno("EACCES"));

      const page = await readCronRunLogEntriesPage(logPath, { jobId: "job-1" });
      expect(page.entries).toEqual([]);
      expect(page.unreadable).toEqual([{ path: logPath, status: "unreadable", code: "EACCES" }]);
    });
  });

  it("does not cry unreadable when the log genuinely is not there", async () => {
    await withStore(async (storePath) => {
      const logPath = resolveCronRunLogPath({ storePath, jobId: "never-ran" });
      const page = await readCronRunLogEntriesPage(logPath, { jobId: "never-ran" });
      expect(page.entries).toEqual([]);
      expect(page.unreadable).toBeUndefined();
    });
  });

  it("reports an unreadable runs directory rather than an empty schedule", async () => {
    await withStore(async (storePath) => {
      vi.spyOn(fs, "readdir").mockRejectedValue(errno("EACCES"));
      const page = await readCronRunLogEntriesPageAll({ storePath });
      expect(page.total).toBe(0);
      expect(page.unreadable?.[0]?.status).toBe("unreadable");
      expect(page.unreadable?.[0]?.code).toBe("EACCES");
    });
  });

  it("does not report an absent runs directory as unreadable", async () => {
    await withStore(async (storePath) => {
      const page = await readCronRunLogEntriesPageAll({ storePath });
      expect(page.total).toBe(0);
      expect(page.unreadable).toBeUndefined();
    });
  });

  it("keeps the jobs it could read and names the one it could not", async () => {
    await withStore(async (storePath) => {
      const runsDir = path.join(path.dirname(storePath), "runs");
      await fs.mkdir(runsDir, { recursive: true });
      await fs.writeFile(path.join(runsDir, "job-1.jsonl"), runLine("job-1", 1_000));
      const blocked = path.join(runsDir, "job-2.jsonl");
      await fs.writeFile(blocked, runLine("job-2", 2_000));
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
        const targetPath =
          typeof target === "string" ? target : target instanceof URL ? target.pathname : "";
        if (path.resolve(targetPath) === blocked) {
          throw errno("EPERM");
        }
        return readFile(target, options);
      });

      const page = await readCronRunLogEntriesPageAll({ storePath });
      expect(page.entries.map((entry) => entry.jobId)).toEqual(["job-1"]);
      expect(page.unreadable).toEqual([{ path: blocked, status: "unreadable", code: "EPERM" }]);
    });
  });

  it("counts the lines it had to drop instead of dropping them quietly", async () => {
    await withStore(async (storePath) => {
      const logPath = resolveCronRunLogPath({ storePath, jobId: "job-1" });
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, `${runLine("job-1", 1_000)}{"action":"finished"\n`);

      const page = await readCronRunLogEntriesPage(logPath, { jobId: "job-1" });
      expect(page.total).toBe(1);
      expect(page.skippedLines).toBe(1);
    });
  });

  it("says nothing about skipped lines when every line parsed", async () => {
    await withStore(async (storePath) => {
      const logPath = resolveCronRunLogPath({ storePath, jobId: "job-1" });
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, runLine("job-1", 1_000));

      const page = await readCronRunLogEntriesPage(logPath, { jobId: "job-1" });
      expect(page.total).toBe(1);
      expect(page.skippedLines).toBeUndefined();
    });
  });

  it("leaves the log intact when pruning cannot read it", async () => {
    await withStore(async (storePath) => {
      const logPath = resolveCronRunLogPath({ storePath, jobId: "job-1" });
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, runLine("job-1", 1_000));
      vi.spyOn(fs, "readFile").mockRejectedValue(errno("EACCES"));

      await appendCronRunLog(
        logPath,
        { ts: 2_000, jobId: "job-1", action: "finished", status: "ok" },
        { maxBytes: 1, keepLines: 5 },
      );
      vi.restoreAllMocks();

      // A failed prune read must not be rewritten as an empty log: every run recorded before it
      // would disappear, which is the one outcome nobody can recover from.
      const after = await fs.readFile(logPath, "utf-8");
      expect(after).toContain('"ts":1000');
      expect(after).toContain('"ts":2000');
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("skipped pruning"));
    });
  });

  it("aggregates dropped lines across every job in the all-jobs page", async () => {
    await withStore(async (storePath) => {
      const runsDir = path.join(path.dirname(storePath), "runs");
      await fs.mkdir(runsDir, { recursive: true });
      await fs.writeFile(path.join(runsDir, "job-1.jsonl"), `${runLine("job-1", 1_000)}not-json\n`);
      await fs.writeFile(
        path.join(runsDir, "job-2.jsonl"),
        `${runLine("job-2", 2_000)}also-not-json\n`,
      );

      const page = await readCronRunLogEntriesPageAll({ storePath });
      expect(page.total).toBe(2);
      expect(page.skippedLines).toBe(2);
    });
  });
});
