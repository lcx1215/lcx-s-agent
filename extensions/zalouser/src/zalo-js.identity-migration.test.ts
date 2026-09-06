import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLcxIdentityMigrationPlan } from "lcx-agent/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  clearZaloCredentialsForIdentityMigration,
  createLcxIdentityZaloCredentialsMigration,
  readZaloCredentialsForIdentityMigration,
  rollbackZaloCredentialsRemoval,
  rollbackZaloCredentialsWrite,
  writeZaloCredentialsForIdentityMigration,
  type StoredZaloCredentials,
} from "./zalo-js.js";

async function createRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-zalo-credentials-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

const legacyCredentials: StoredZaloCredentials = {
  imei: "imei-legacy",
  cookie: {},
  userAgent: "test-agent",
  language: "zh-CN",
  createdAt: "2026-09-04T10:00:00.000Z",
  lastUsedAt: "2026-09-04T10:01:00.000Z",
};

describe("Zalo credentials identity migration writer", () => {
  it("reads legacy credentials, writes canonical credentials, and rolls back without auditing values", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "credentials", "zalouser", "credentials.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyCredentials, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityZaloCredentialsMigration({
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readCredentialsPath).toBe(legacyPath);
    await expect(readZaloCredentialsForIdentityMigration(migration)).resolves.toEqual(
      legacyCredentials,
    );

    const first = await writeZaloCredentialsForIdentityMigration(migration, legacyCredentials);
    const canonicalPath = path.join(root, ".lcx", "credentials", "zalouser", "credentials.json");
    expect(first.previous.exists).toBe(false);
    expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);

    const replacement = { ...legacyCredentials, imei: "imei-canonical" };
    const second = await writeZaloCredentialsForIdentityMigration(migration, replacement);
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual(legacyCredentials);
    await rollbackZaloCredentialsWrite(second);
    await expect(readZaloCredentialsForIdentityMigration(migration)).resolves.toEqual(
      legacyCredentials,
    );

    const removal = await clearZaloCredentialsForIdentityMigration(migration);
    expect(removal).not.toBeNull();
    if (!removal) {
      throw new Error("expected credentials removal receipt");
    }
    await rollbackZaloCredentialsRemoval(removal);
    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"credentials"');
    expect(audit).toContain('"noSplitState":"single-write-target"');
    expect(audit).not.toContain("imei-legacy");
    expect(audit).not.toContain("imei-canonical");
    await rm(root, { recursive: true, force: true });
  });

  it("supports an explicit state root and rejects config-only authority", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "operator-state");
    const migration = createLcxIdentityZaloCredentialsMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
      profile: "work",
    });
    expect(migration.readCredentialsPath).toBe(migration.writeCredentialsPath);
    const receipt = await writeZaloCredentialsForIdentityMigration(migration, legacyCredentials, {
      expectedReadPath: migration.readCredentialsPath,
      expectedWritePath: migration.writeCredentialsPath,
    });
    await rollbackZaloCredentialsWrite(receipt);

    expect(() =>
      createLcxIdentityZaloCredentialsMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
    await rm(root, { recursive: true, force: true });
  });
});
