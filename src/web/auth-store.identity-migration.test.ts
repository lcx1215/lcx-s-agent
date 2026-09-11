import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityWebAuthMigration,
  migrateWebAuthForIdentityMigration,
  readWebAuthForIdentityMigration,
  rollbackWebAuthIdentityMigration,
} from "./auth-store.js";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-web-auth-migration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WhatsApp Web auth identity migration writer", () => {
  it("moves the legacy auth directory as one credential unit and rolls it back", async () => {
    const root = await createRoot();
    const legacyDir = path.join(root, ".openclaw", "credentials", "whatsapp", "default");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "creds.json"), '{"me":{"id":"user@s.whatsapp.net"}}\n', {
      mode: 0o600,
    });
    await writeFile(path.join(legacyDir, "app-state-sync-key-1.json"), "opaque-session-state\n", {
      mode: 0o600,
    });

    const migration = createLcxIdentityWebAuthMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
    });
    await expect(readWebAuthForIdentityMigration(migration)).resolves.toMatchObject({
      exists: true,
      authDir: legacyDir,
      files: ["app-state-sync-key-1.json", "creds.json"],
    });

    const result = await migrateWebAuthForIdentityMigration(migration);
    expect(result.status).toBe("migrated");
    const canonicalDir = path.join(root, ".lcx", "credentials", "whatsapp", "default");
    expect(await readdir(canonicalDir)).toEqual(["app-state-sync-key-1.json", "creds.json"]);
    await expect(readFile(path.join(legacyDir, "creds.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(canonicalDir, "creds.json"), "utf8")).toContain("user@");

    await rollbackWebAuthIdentityMigration(result.receipt!);
    expect(await readdir(legacyDir)).toEqual(["app-state-sync-key-1.json", "creds.json"]);
    await expect(readdir(canonicalDir)).rejects.toMatchObject({ code: "ENOENT" });
    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"credentials"');
    expect(audit).not.toContain("user@s.whatsapp.net");
  });

  it("rejects multiple legacy roots and config-only authority", async () => {
    const root = await createRoot();
    for (const dirname of [".openclaw", ".clawdbot"]) {
      const credPath = path.join(root, dirname, "credentials", "whatsapp", "default", "creds.json");
      await mkdir(path.dirname(credPath), { recursive: true });
      await writeFile(credPath, "{}\n");
    }
    expect(() =>
      createLcxIdentityWebAuthMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      }),
    ).toThrowError(expect.objectContaining({ code: "LCX_IDENTITY_SPLIT_STATE" }));

    expect(() =>
      createLcxIdentityWebAuthMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({
          env: { OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json") },
          homedir: () => root,
        }),
      }),
    ).toThrow("state-root authority");
  });
});
