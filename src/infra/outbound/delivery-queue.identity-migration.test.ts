import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../../config/paths.js";
import {
  createLcxIdentityDeliveryQueueMigration,
  enqueueDeliveryForIdentityMigration,
  readPendingDeliveriesForIdentityMigration,
  rollbackDeliveryQueueIdentityMigration,
} from "./delivery-queue.identity-migration.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-queue-writer-"));
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

describe("LCX identity migration delivery queue writer", () => {
  it("reads legacy entries and writes new entries under one canonical queue root", async () => {
    await withTempRoot(async (root) => {
      const legacyQueueDir = path.join(root, ".openclaw", "delivery-queue");
      await fs.mkdir(legacyQueueDir, { recursive: true });
      await fs.writeFile(
        path.join(legacyQueueDir, "legacy-entry.json"),
        JSON.stringify({
          id: "legacy-entry",
          retryCount: 0,
          channel: "telegram",
          to: "1",
          payloads: [],
        }),
        "utf8",
      );

      const migration = createLcxIdentityDeliveryQueueMigration({
        migrationPlan: migrationPlan(root),
      });
      expect(migration.readQueueDir).toBe(legacyQueueDir);
      expect(migration.writeQueueDir).toBe(path.join(root, ".lcx", "delivery-queue"));
      await expect(readPendingDeliveriesForIdentityMigration(migration)).resolves.toHaveLength(1);

      const { id, receipt } = await enqueueDeliveryForIdentityMigration({
        migration,
        channel: "telegram",
        to: "2",
        payloads: [{ text: "queued" }],
      });
      expect(id).toMatch(/^[a-f0-9-]+$/);
      expect(receipt.pathContract).toMatchObject({
        writer: "queues",
        auditPath: path.join(root, ".lcx", "logs", "identity-migration-audit.jsonl"),
        noSplitState: "single-write-target",
      });
      expect(
        JSON.parse(await fs.readFile(path.join(migration.writeQueueDir, `${id}.json`), "utf8")),
      ).toMatchObject({ id, channel: "telegram", to: "2" });
      expect(await fs.readdir(legacyQueueDir)).toEqual(["legacy-entry.json"]);
      await expect(readPendingDeliveriesForIdentityMigration(migration)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "legacy-entry", to: "1" }),
          expect.objectContaining({ id, to: "2" }),
        ]),
      );

      await rollbackDeliveryQueueIdentityMigration(receipt);
      await expect(
        fs.access(path.join(migration.writeQueueDir, `${id}.json`)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("rejects a config-only override because the queue needs a state root", async () => {
    await withTempRoot(async (root) => {
      const plan = resolveLcxIdentityMigrationPlan({
        env: {
          OPENCLAW_CONFIG_PATH: path.join(root, "operator", "openclaw.json"),
        } as NodeJS.ProcessEnv,
        homedir: () => root,
        existsSync: nodeFs.existsSync,
      });
      expect(() => createLcxIdentityDeliveryQueueMigration({ migrationPlan: plan })).toThrow(
        /state-root authority/,
      );
    });
  });
});
