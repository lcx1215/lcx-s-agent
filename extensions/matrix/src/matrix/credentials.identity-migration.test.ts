import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLcxIdentityMigrationPlan } from "lcx-agent/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  clearMatrixCredentialsForIdentityMigration,
  createLcxIdentityMatrixCredentialsMigration,
  readMatrixCredentialsForIdentityMigration,
  rollbackClearedMatrixCredentialsIdentityMigration,
  rollbackMatrixCredentialsIdentityMigration,
  writeMatrixCredentialsForIdentityMigration,
} from "./credentials.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-matrix-credentials-writer-"));
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

describe("Matrix credentials identity migration writer", () => {
  it("reads legacy credentials, writes canonical, backs up, and rolls back without auditing secrets", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(root, ".openclaw", "credentials", "matrix", "credentials.json");
      const legacy = {
        homeserver: "https://matrix.example.org",
        userId: "@bot:matrix.example.org",
        accessToken: "matrix-token-secret",
        deviceId: "DEVICE-1",
        createdAt: "2026-09-04T00:00:00.000Z",
      };
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      const migration = createLcxIdentityMatrixCredentialsMigration({
        migrationPlan: migrationPlan(root),
      });
      await expect(readMatrixCredentialsForIdentityMigration(migration)).resolves.toMatchObject(
        legacy,
      );
      const first = await writeMatrixCredentialsForIdentityMigration(migration, legacy);
      const second = await writeMatrixCredentialsForIdentityMigration(migration, {
        ...legacy,
        accessToken: "matrix-token-next",
      });
      const canonicalPath = migration.writeCredentialsPath;

      expect(second.pathContract.readPath).toBe(canonicalPath);
      expect((await fs.stat(canonicalPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await fs.readFile(`${canonicalPath}.bak`, "utf8"))).toMatchObject(legacy);
      expect(await fs.readFile(legacyPath, "utf8")).toContain("matrix-token-secret");
      expect(
        await fs.readFile(
          path.join(root, ".lcx", "logs", "identity-migration-audit.jsonl"),
          "utf8",
        ),
      ).not.toContain("matrix-token");

      await rollbackMatrixCredentialsIdentityMigration(second);
      await expect(readMatrixCredentialsForIdentityMigration(migration)).resolves.toMatchObject(
        legacy,
      );
      expect(first.previous.exists).toBe(false);
    });
  });

  it("uses the shared removal receipt and rejects config-only authority", async () => {
    await withTempRoot(async (root) => {
      const migration = createLcxIdentityMatrixCredentialsMigration({
        migrationPlan: migrationPlan(root),
      });
      await writeMatrixCredentialsForIdentityMigration(migration, {
        homeserver: "https://matrix.example.org",
        userId: "@bot:matrix.example.org",
        accessToken: "matrix-token",
      });
      const removal = await clearMatrixCredentialsForIdentityMigration(migration);
      await expect(fs.access(migration.writeCredentialsPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await rollbackClearedMatrixCredentialsIdentityMigration(removal);
      await expect(fs.access(migration.writeCredentialsPath)).resolves.toBeUndefined();

      const configOnlyPlan = resolveLcxIdentityMigrationPlan({
        env: {
          OPENCLAW_CONFIG_PATH: path.join(root, "operator", "openclaw.json"),
        } as NodeJS.ProcessEnv,
        homedir: () => root,
        existsSync: nodeFs.existsSync,
      });
      expect(() =>
        createLcxIdentityMatrixCredentialsMigration({ migrationPlan: configOnlyPlan }),
      ).toThrow(/state-root authority/);
    });
  });
});
