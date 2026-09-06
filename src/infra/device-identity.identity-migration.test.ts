import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityDeviceMigration,
  loadOrCreateDeviceIdentity,
  readDeviceIdentityForIdentityMigration,
  rollbackDeviceIdentityMigration,
  writeDeviceIdentityForIdentityMigration,
} from "./device-identity.js";

async function createRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-device-identity-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

describe("device identity migration writer", () => {
  it("reads legacy identity, writes canonical state, audits without secrets, and rolls back", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "identity", "device.json");
    const identity = loadOrCreateDeviceIdentity(legacyPath);
    const migration = createLcxIdentityDeviceMigration({
      migrationPlan: migrationPlan(root),
    });

    expect(migration.readIdentityPath).toBe(legacyPath);
    expect(await readDeviceIdentityForIdentityMigration(migration)).toEqual(identity);

    const receipt = await writeDeviceIdentityForIdentityMigration(migration, identity);
    const canonicalPath = path.join(root, ".lcx", "identity", "device.json");
    expect(migration.writeIdentityPath).toBe(canonicalPath);
    expect(JSON.parse(await readFile(canonicalPath, "utf8"))).toMatchObject({
      deviceId: identity.deviceId,
      publicKeyPem: identity.publicKeyPem,
      privateKeyPem: identity.privateKeyPem,
    });
    if (process.platform !== "win32") {
      expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);
    }

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"device"');
    expect(audit).not.toContain(identity.privateKeyPem);
    expect(audit).not.toContain(identity.publicKeyPem);

    const replacement = loadOrCreateDeviceIdentity(
      path.join(root, "replacement", "identity", "device.json"),
    );
    const replacementReceipt = await writeDeviceIdentityForIdentityMigration(
      migration,
      replacement,
    );
    expect(await readDeviceIdentityForIdentityMigration(migration)).toEqual(replacement);
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toMatchObject({
      privateKeyPem: identity.privateKeyPem,
      publicKeyPem: identity.publicKeyPem,
    });

    await rollbackDeviceIdentityMigration(replacementReceipt);
    expect(await readDeviceIdentityForIdentityMigration(migration)).toEqual(identity);
    expect(receipt.previous.exists).toBe(false);
  });

  it("uses an explicit state override as both read and write authority", async () => {
    const root = await createRoot();
    const overrideState = path.join(root, "operator-state");
    const migration = createLcxIdentityDeviceMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: overrideState }),
    });
    const identity = loadOrCreateDeviceIdentity(
      path.join(root, "source", "identity", "device.json"),
    );

    expect(migration.readIdentityPath).toBe(migration.writeIdentityPath);
    const receipt = await writeDeviceIdentityForIdentityMigration(migration, identity, {
      expectedReadPath: migration.readIdentityPath,
      expectedWritePath: migration.writeIdentityPath,
    });
    expect(await readDeviceIdentityForIdentityMigration(migration)).toEqual(identity);
    await rollbackDeviceIdentityMigration(receipt);
    await expect(readFile(migration.writeIdentityPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a caller that supplies a path outside the resolved contract", async () => {
    const root = await createRoot();
    const identity = loadOrCreateDeviceIdentity(
      path.join(root, ".openclaw", "identity", "device.json"),
    );
    const migration = createLcxIdentityDeviceMigration({
      migrationPlan: migrationPlan(root),
    });

    await expect(
      writeDeviceIdentityForIdentityMigration(migration, identity, {
        expectedReadPath: path.join(root, "wrong", "device.json"),
      }),
    ).rejects.toMatchObject({ code: "LCX_IDENTITY_READ_PATH_MISMATCH" });
  });

  it("rejects config-only authority because device state needs a state root", async () => {
    const root = await createRoot();

    expect(() =>
      createLcxIdentityDeviceMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
  });
});
