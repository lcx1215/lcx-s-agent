import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  clearDeviceAuthTokenForIdentityMigration,
  createLcxIdentityDeviceAuthMigration,
  readDeviceAuthStoreForIdentityMigration,
  rollbackDeviceAuthIdentityMigration,
  storeDeviceAuthTokenForIdentityMigration,
} from "./device-auth-store.js";

async function createRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-device-auth-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

describe("device auth store migration writer", () => {
  it("reads legacy tokens, writes canonical state, and rolls back without auditing secrets", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "identity", "device-auth.json");
    const legacyStore = {
      version: 1 as const,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "legacy-token",
          role: "operator",
          scopes: ["operator.read"],
          updatedAtMs: 1,
        },
      },
    };
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyStore, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityDeviceAuthMigration({
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readAuthStorePath).toBe(legacyPath);
    await expect(readDeviceAuthStoreForIdentityMigration(migration)).resolves.toEqual(legacyStore);

    const first = await storeDeviceAuthTokenForIdentityMigration({
      migration,
      deviceId: "device-1",
      role: " operator ",
      token: "new-token",
      scopes: ["operator.write", "operator.read", "operator.read"],
    });
    const canonicalPath = path.join(root, ".lcx", "identity", "device-auth.json");
    expect(first.entry).toMatchObject({
      token: "new-token",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    });
    if (process.platform !== "win32") {
      expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);
    }

    const second = await storeDeviceAuthTokenForIdentityMigration({
      migration,
      deviceId: "device-1",
      role: "operator",
      token: "rotated-token",
      scopes: ["operator.read"],
    });
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toMatchObject({
      tokens: { operator: { token: "new-token" } },
    });
    await rollbackDeviceAuthIdentityMigration(second.receipt);
    await expect(readDeviceAuthStoreForIdentityMigration(migration)).resolves.toMatchObject({
      tokens: { operator: { token: "new-token" } },
    });

    const cleared = await clearDeviceAuthTokenForIdentityMigration({
      migration,
      deviceId: "device-1",
      role: "operator",
    });
    expect(cleared).not.toBeNull();
    await expect(readDeviceAuthStoreForIdentityMigration(migration)).resolves.toMatchObject({
      tokens: {},
    });
    if (!cleared) {
      throw new Error("expected clear to write a receipt");
    }
    await rollbackDeviceAuthIdentityMigration(cleared);

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"device-auth"');
    expect(audit).not.toContain("legacy-token");
    expect(audit).not.toContain("new-token");
    expect(audit).not.toContain("rotated-token");
  });

  it("uses an explicit state override and rejects config-only authority", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "operator-state");
    const migration = createLcxIdentityDeviceAuthMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    expect(migration.readAuthStorePath).toBe(migration.writeAuthStorePath);

    const result = await storeDeviceAuthTokenForIdentityMigration({
      migration,
      deviceId: "device-override",
      role: "operator",
      token: "override-token",
      expectedReadPath: migration.readAuthStorePath,
      expectedWritePath: migration.writeAuthStorePath,
    });
    await expect(readDeviceAuthStoreForIdentityMigration(migration)).resolves.toMatchObject({
      deviceId: "device-override",
    });
    await rollbackDeviceAuthIdentityMigration(result.receipt);

    expect(() =>
      createLcxIdentityDeviceAuthMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
  });
});
