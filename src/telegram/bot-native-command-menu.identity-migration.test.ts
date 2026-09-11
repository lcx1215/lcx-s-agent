import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityTelegramCommandHashMigration,
  readTelegramCommandHashForIdentityMigration,
  rollbackTelegramCommandHashIdentityMigration,
  writeTelegramCommandHashForIdentityMigration,
} from "./bot-native-command-menu.js";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-telegram-menu-migration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Telegram command hash identity migration writer", () => {
  it("reads legacy cache, writes canonical cache, backs up, and rolls back", async () => {
    const root = await createRoot();
    const relativePath = path.join("telegram", "command-hash-default-9d74932bdb6f21dc.txt");
    const legacyPath = path.join(root, ".openclaw", relativePath);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "legacy-hash\n", { mode: 0o600 });
    const migration = createLcxIdentityTelegramCommandHashMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      botIdentity: "bot",
    });
    await expect(readTelegramCommandHashForIdentityMigration(migration)).resolves.toBe(
      "legacy-hash\n",
    );
    const first = await writeTelegramCommandHashForIdentityMigration(migration, "next-hash");
    const second = await writeTelegramCommandHashForIdentityMigration(migration, "new-hash");
    const canonicalPath = path.join(
      root,
      ".lcx",
      "telegram",
      "command-hash-default-9d74932bdb6f21dc.txt",
    );
    expect(await readFile(`${canonicalPath}.bak`, "utf8")).toBe("next-hash\n");
    await rollbackTelegramCommandHashIdentityMigration(second);
    expect(await readFile(canonicalPath, "utf8")).toBe("next-hash\n");
    expect(first.previous.exists).toBe(false);
    expect(await readFile(migration.pathContract.auditPath, "utf8")).toContain(
      '"writer":"channel-local"',
    );
  });

  it("rejects multiple legacy roots", async () => {
    const root = await createRoot();
    const relativePath = path.join("telegram", "command-hash-default-no-bot.txt");
    for (const dirname of [".openclaw", ".clawdbot"]) {
      const filePath = path.join(root, dirname, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "hash\n");
    }
    expect(() =>
      createLcxIdentityTelegramCommandHashMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      }),
    ).toThrowError(expect.objectContaining({ code: "LCX_IDENTITY_SPLIT_STATE" }));
  });
});
