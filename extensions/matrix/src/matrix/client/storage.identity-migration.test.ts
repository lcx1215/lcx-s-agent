import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLcxIdentityMigrationPlan } from "lcx-agent/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateMatrixStorageForIdentityMigration,
  resolveMatrixStoragePathsForIdentityMigration,
  rollbackMatrixStorageIdentityMigration,
  rollbackStorageMetaIdentityMigration,
  writeStorageMetaForIdentityMigration,
} from "./storage.js";

const tempRoots: string[] = [];

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-matrix-storage-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, ".openclaw", "matrix"), { recursive: true });
  const migrationPlan = resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root });
  const storagePaths = resolveMatrixStoragePathsForIdentityMigration({
    homeserver: "https://matrix.example.test",
    userId: "@bot:example.test",
    accessToken: "access-token",
    migrationPlan,
  });
  return { root, migrationPlan, storagePaths };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("LCX Matrix storage identity migration", () => {
  it("moves legacy storage and crypto as one receipt-backed transaction", async () => {
    const { root, migrationPlan, storagePaths } = await createFixture();
    const legacyStoragePath = path.join(root, ".openclaw", "matrix", "bot-storage.json");
    const legacyCryptoPath = path.join(root, ".openclaw", "matrix", "crypto");
    await fs.writeFile(legacyStoragePath, '{"rooms":{}}\n', "utf8");
    await fs.mkdir(legacyCryptoPath, { recursive: true });
    await fs.writeFile(path.join(legacyCryptoPath, "crypto.db"), "encrypted-state", "utf8");

    const receipt = await migrateMatrixStorageForIdentityMigration({
      storagePaths,
      migrationPlan,
    });

    expect(receipt?.storage?.pathContract.writer).toBe("matrix-storage");
    expect(receipt?.crypto?.previous.kind).toBe("directory");
    await expect(fs.readFile(storagePaths.storagePath, "utf8")).resolves.toBe('{"rooms":{}}\n');
    await expect(
      fs.readFile(path.join(storagePaths.cryptoPath, "crypto.db"), "utf8"),
    ).resolves.toBe("encrypted-state");
    await expect(fs.access(legacyStoragePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(legacyCryptoPath)).rejects.toMatchObject({ code: "ENOENT" });

    const metaReceipt = await writeStorageMetaForIdentityMigration({
      storagePaths,
      migrationPlan,
      homeserver: "https://matrix.example.test",
      userId: "@bot:example.test",
    });
    await expect(fs.readFile(storagePaths.metaPath, "utf8")).resolves.toContain("example.test");
    await rollbackStorageMetaIdentityMigration(metaReceipt);
    await rollbackMatrixStorageIdentityMigration(receipt!);
    await expect(fs.access(storagePaths.storagePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(storagePaths.cryptoPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(legacyStoragePath, "utf8")).resolves.toBe('{"rooms":{}}\n');
    await expect(fs.readFile(path.join(legacyCryptoPath, "crypto.db"), "utf8")).resolves.toBe(
      "encrypted-state",
    );
  });

  it("refuses a partial canonical and legacy Matrix storage state", async () => {
    const { root, migrationPlan, storagePaths } = await createFixture();
    await fs.writeFile(
      path.join(root, ".openclaw", "matrix", "bot-storage.json"),
      "legacy",
      "utf8",
    );
    await fs.mkdir(path.dirname(storagePaths.storagePath), { recursive: true });
    await fs.writeFile(storagePaths.storagePath, "canonical", "utf8");

    await expect(
      migrateMatrixStorageForIdentityMigration({ storagePaths, migrationPlan }),
    ).rejects.toMatchObject({ code: "LCX_IDENTITY_SPLIT_STATE" });
  });

  it("refuses rollback after a moved file is changed", async () => {
    const { root, migrationPlan, storagePaths } = await createFixture();
    const legacyStoragePath = path.join(root, ".openclaw", "matrix", "bot-storage.json");
    await fs.writeFile(legacyStoragePath, "legacy", "utf8");

    const receipt = await migrateMatrixStorageForIdentityMigration({
      storagePaths,
      migrationPlan,
    });
    await fs.writeFile(storagePaths.storagePath, "changed", "utf8");

    await expect(rollbackMatrixStorageIdentityMigration(receipt!)).rejects.toMatchObject({
      code: "LCX_IDENTITY_ROLLBACK_TARGET_MISMATCH",
    });
  });
});
