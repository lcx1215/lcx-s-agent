import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityTelegramUpdateOffsetMigration,
  deleteTelegramUpdateOffsetForIdentityMigration,
  readTelegramUpdateOffsetForIdentityMigration,
  rollbackDeletedTelegramUpdateOffsetIdentityMigration,
  rollbackTelegramUpdateOffsetIdentityMigration,
  writeTelegramUpdateOffsetForIdentityMigration,
} from "./update-offset-store.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-telegram-offset-writer-"));
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

describe("Telegram update offset identity migration writer", () => {
  it("reads legacy state, writes canonical state, refreshes, and rolls back", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(root, ".openclaw", "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 2, lastUpdateId: 100, botId: "123" }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const migration = createLcxIdentityTelegramUpdateOffsetMigration({
        migrationPlan: migrationPlan(root),
      });

      await expect(
        readTelegramUpdateOffsetForIdentityMigration({ migration, botToken: "123:secret" }),
      ).resolves.toBe(100);
      const first = await writeTelegramUpdateOffsetForIdentityMigration({
        migration,
        updateId: 200,
        botToken: "123:secret",
      });
      const second = await writeTelegramUpdateOffsetForIdentityMigration({
        migration,
        updateId: 300,
        botToken: "123:secret",
      });

      expect(second.pathContract.readPath).toBe(migration.writeOffsetPath);
      expect(
        await readTelegramUpdateOffsetForIdentityMigration({ migration, botToken: "123:secret" }),
      ).toBe(300);
      expect(
        JSON.parse(await fs.readFile(`${migration.writeOffsetPath}.bak`, "utf8")),
      ).toMatchObject({ lastUpdateId: 200 });
      expect(
        await fs.readFile(
          path.join(root, ".lcx", "logs", "identity-migration-audit.jsonl"),
          "utf8",
        ),
      ).not.toContain("secret");

      await rollbackTelegramUpdateOffsetIdentityMigration(second);
      await expect(
        readTelegramUpdateOffsetForIdentityMigration({ migration, botToken: "123:secret" }),
      ).resolves.toBe(200);
      expect(first.previous.exists).toBe(false);
    });
  });

  it("uses shared removal rollback and rejects config-only authority", async () => {
    await withTempRoot(async (root) => {
      const migration = createLcxIdentityTelegramUpdateOffsetMigration({
        migrationPlan: migrationPlan(root),
      });
      await writeTelegramUpdateOffsetForIdentityMigration({ migration, updateId: 1 });
      const removal = await deleteTelegramUpdateOffsetForIdentityMigration(migration);
      await expect(fs.access(migration.writeOffsetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await rollbackDeletedTelegramUpdateOffsetIdentityMigration(removal);
      await expect(fs.access(migration.writeOffsetPath)).resolves.toBeUndefined();

      const configOnlyPlan = resolveLcxIdentityMigrationPlan({
        env: {
          OPENCLAW_CONFIG_PATH: path.join(root, "operator", "openclaw.json"),
        } as NodeJS.ProcessEnv,
        homedir: () => root,
        existsSync: nodeFs.existsSync,
      });
      expect(() =>
        createLcxIdentityTelegramUpdateOffsetMigration({ migrationPlan: configOnlyPlan }),
      ).toThrow(/state-root authority/);
    });
  });
});
