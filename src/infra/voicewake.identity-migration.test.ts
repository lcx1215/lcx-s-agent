import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityVoiceWakeMigration,
  readVoiceWakeConfigForIdentityMigration,
  rollbackVoiceWakeIdentityMigration,
  writeVoiceWakeConfigForIdentityMigration,
} from "./voicewake.js";

async function createRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-voicewake-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

describe("voice wake identity migration writer", () => {
  it("reads legacy settings, writes canonical settings, and rolls back with an audit receipt", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "settings", "voicewake.json");
    const legacyConfig = { triggers: ["hey-lcx"], updatedAtMs: 1 };
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityVoiceWakeMigration({
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readStatePath).toBe(legacyPath);
    await expect(readVoiceWakeConfigForIdentityMigration(migration)).resolves.toEqual(legacyConfig);

    const first = await writeVoiceWakeConfigForIdentityMigration(migration, legacyConfig);
    const canonicalPath = path.join(root, ".lcx", "settings", "voicewake.json");
    expect(first.previous.exists).toBe(false);
    expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);

    const second = await writeVoiceWakeConfigForIdentityMigration(migration, {
      triggers: ["new-trigger"],
      updatedAtMs: 2,
    });
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual(legacyConfig);
    await rollbackVoiceWakeIdentityMigration(second);
    await expect(readVoiceWakeConfigForIdentityMigration(migration)).resolves.toEqual(legacyConfig);

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"voicewake"');
    expect(audit).toContain('"noSplitState":"single-write-target"');
    expect(audit).not.toContain("hey-lcx");
    await rm(root, { recursive: true, force: true });
  });

  it("supports an explicit state root and rejects config-only authority", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "operator-state");
    const migration = createLcxIdentityVoiceWakeMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    expect(migration.readStatePath).toBe(migration.writeStatePath);
    const receipt = await writeVoiceWakeConfigForIdentityMigration(
      migration,
      { triggers: ["override"], updatedAtMs: 1 },
      {
        expectedReadPath: migration.readStatePath,
        expectedWritePath: migration.writeStatePath,
      },
    );
    await rollbackVoiceWakeIdentityMigration(receipt);

    expect(() =>
      createLcxIdentityVoiceWakeMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
    await rm(root, { recursive: true, force: true });
  });
});
