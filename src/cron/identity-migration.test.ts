import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  appendCronRunLogForIdentityMigration,
  createLcxIdentityCronRunLogMigration,
  createLcxIdentityCronStoreMigration,
  readCronStoreForIdentityMigration,
  rollbackCronRunLogIdentityMigration,
  rollbackCronStoreIdentityMigration,
  writeCronStoreForIdentityMigration,
} from "./identity-migration.js";
import { saveCronStore } from "./store.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cron-writer-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function migrationPlan(root: string) {
  return resolveLcxIdentityMigrationPlan({
    env: {} as NodeJS.ProcessEnv,
    homedir: () => root,
    existsSync: nodeFs.existsSync,
  });
}

describe("LCX identity migration cron and audit writers", () => {
  it("routes cron jobs from legacy to canonical with backup and rollback", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(root, ".openclaw", "cron", "jobs.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(legacyPath, '{"version":1,"jobs":[]}\n', "utf8");
      const migration = createLcxIdentityCronStoreMigration({ migrationPlan: migrationPlan(root) });

      expect(await readCronStoreForIdentityMigration(migration)).toEqual({ version: 1, jobs: [] });
      const receipt = await writeCronStoreForIdentityMigration(migration, { version: 1, jobs: [] });
      expect(receipt.pathContract).toMatchObject({
        writer: "cron",
        readPath: legacyPath,
        writePath: path.join(root, ".lcx", "cron", "jobs.json"),
        noSplitState: "single-write-target",
      });
      await rollbackCronStoreIdentityMigration(receipt);
      await expect(fs.access(migration.writeStorePath)).rejects.toMatchObject({ code: "ENOENT" });

      await saveCronStore(
        migration.readStorePath,
        { version: 1, jobs: [] },
        { identityMigration: migration },
      );
      expect(await fs.access(migration.writeStorePath)).toBeUndefined();
    });
  });

  it("appends cron run audit data through the same contract", async () => {
    await withTempRoot(async (root) => {
      const migration = createLcxIdentityCronRunLogMigration({
        migrationPlan: migrationPlan(root),
        jobId: "job-1",
      });
      const firstReceipt = await appendCronRunLogForIdentityMigration(migration, {
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "ok",
      });
      expect(firstReceipt.pathContract).toMatchObject({
        writer: "audit",
        noSplitState: "single-write-target",
      });
      expect(await fs.readFile(migration.writeLogPath, "utf8")).toContain('"jobId":"job-1"');
      const secondReceipt = await appendCronRunLogForIdentityMigration(migration, {
        ts: 2,
        jobId: "job-1",
        action: "finished",
        status: "error",
      });
      expect(secondReceipt.pathContract.readPath).toBe(migration.writeLogPath);
      expect((await fs.readFile(migration.writeLogPath, "utf8")).trim().split("\n")).toHaveLength(
        2,
      );
      await rollbackCronRunLogIdentityMigration(secondReceipt);
      expect((await fs.readFile(migration.writeLogPath, "utf8")).trim().split("\n")).toHaveLength(
        1,
      );
    });
  });

  it("rejects a config-only override for the cron state writer", async () => {
    await withTempRoot(async (root) => {
      const plan = resolveLcxIdentityMigrationPlan({
        env: {
          OPENCLAW_CONFIG_PATH: path.join(root, "operator", "openclaw.json"),
        } as NodeJS.ProcessEnv,
        homedir: () => root,
        existsSync: nodeFs.existsSync,
      });
      expect(() => createLcxIdentityCronStoreMigration({ migrationPlan: plan })).toThrow(
        /state-root authority/,
      );
    });
  });
});
