import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  cacheStickerForIdentityMigration,
  createLcxIdentityTelegramStickerCacheMigration,
  readTelegramStickerCacheForIdentityMigration,
  rollbackTelegramStickerCacheIdentityMigration,
} from "./sticker-cache.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-telegram-sticker-writer-"));
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

describe("Telegram sticker cache identity migration writer", () => {
  it("reads legacy cache, writes canonical cache, refreshes, and rolls back", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(root, ".openclaw", "telegram", "sticker-cache.json");
      const sticker = {
        fileId: "file-1",
        fileUniqueId: "unique-1",
        description: "A fox",
        cachedAt: "2026-09-04T00:00:00.000Z",
      };
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 1, stickers: { "unique-1": sticker } }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const migration = createLcxIdentityTelegramStickerCacheMigration({
        migrationPlan: migrationPlan(root),
      });

      await expect(readTelegramStickerCacheForIdentityMigration(migration)).resolves.toMatchObject({
        stickers: { "unique-1": sticker },
      });
      await cacheStickerForIdentityMigration({ migration, sticker });
      const second = await cacheStickerForIdentityMigration({
        migration,
        sticker: { ...sticker, description: "A fox waving" },
      });

      expect(second.pathContract.readPath).toBe(migration.writeCachePath);
      expect(
        JSON.parse(await fs.readFile(`${migration.writeCachePath}.bak`, "utf8")),
      ).toMatchObject({
        stickers: { "unique-1": { description: "A fox" } },
      });
      await rollbackTelegramStickerCacheIdentityMigration(second);
      await expect(readTelegramStickerCacheForIdentityMigration(migration)).resolves.toMatchObject({
        stickers: { "unique-1": { description: "A fox" } },
      });
    });
  });

  it("rejects config-only authority", async () => {
    await withTempRoot(async (root) => {
      const plan = resolveLcxIdentityMigrationPlan({
        env: {
          OPENCLAW_CONFIG_PATH: path.join(root, "operator", "openclaw.json"),
        } as NodeJS.ProcessEnv,
        homedir: () => root,
        existsSync: nodeFs.existsSync,
      });
      expect(() => createLcxIdentityTelegramStickerCacheMigration({ migrationPlan: plan })).toThrow(
        /state-root authority/,
      );
    });
  });
});
