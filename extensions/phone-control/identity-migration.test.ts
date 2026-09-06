import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../../src/config/paths.js";
import {
  createLcxIdentityPhoneControlMigration,
  readPhoneControlIdentityMigration,
  rollbackPhoneControlIdentityMigration,
  writePhoneControlForIdentityMigration,
} from "./identity-migration.js";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-phone-control-migration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("phone-control identity migration writer", () => {
  it("moves config and arm state together and rolls both back", async () => {
    const root = await createRoot();
    const legacyState = path.join(root, ".openclaw", "plugins", "phone-control", "armed.json");
    const legacyConfig = path.join(root, ".openclaw", "openclaw.json");
    await mkdir(path.dirname(legacyState), { recursive: true });
    await writeFile(legacyState, '{"version":2,"group":"writes","armedAtMs":1}\n', {
      mode: 0o600,
    });
    await writeFile(legacyConfig, '{"gateway":{"nodes":{"allowCommands":["sms.send"]}}}\n', {
      mode: 0o600,
    });

    const migration = createLcxIdentityPhoneControlMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      homedir: () => root,
      env: {},
    });
    const observed = await readPhoneControlIdentityMigration(migration);
    expect(observed.configExists).toBe(true);
    expect(observed.stateRaw).toContain('"group":"writes"');
    const receipt = await writePhoneControlForIdentityMigration(
      migration,
      observed.config,
      observed.stateRaw!,
    );

    const canonicalConfig = path.join(root, ".lcx", "lcx.json");
    const canonicalState = path.join(root, ".lcx", "plugins", "phone-control", "armed.json");
    expect(await readFile(canonicalConfig, "utf8")).toContain("sms.send");
    expect(await readFile(canonicalState, "utf8")).toContain('"group":"writes"');
    expect(receipt.state.rollback.strategy).toBe("remove-written-target");

    await rollbackPhoneControlIdentityMigration(migration, receipt);
    await expect(readFile(canonicalConfig)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(canonicalState)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(legacyConfig, "utf8")).toContain("sms.send");
    expect(await readFile(legacyState, "utf8")).toContain('"group":"writes"');
  });

  it("rejects a config-only authority and an orphaned arm state", async () => {
    const root = await createRoot();
    expect(() =>
      createLcxIdentityPhoneControlMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({
          env: { OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json") },
          homedir: () => root,
        }),
        env: { OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json") },
        homedir: () => root,
      }),
    ).toThrow("state-root authority");

    const statePath = path.join(root, ".openclaw", "plugins", "phone-control", "armed.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, '{"version":2,"group":"writes","armedAtMs":1}\n');
    const migration = createLcxIdentityPhoneControlMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      env: {},
      homedir: () => root,
    });
    const observed = await readPhoneControlIdentityMigration(migration);
    await expect(
      writePhoneControlForIdentityMigration(migration, observed.config, observed.stateRaw!),
    ).rejects.toMatchObject({ code: "LCX_IDENTITY_SPLIT_STATE" });
  });
});
