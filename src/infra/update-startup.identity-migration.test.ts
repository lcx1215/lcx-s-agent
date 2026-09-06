import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityUpdateCheckMigration,
  readUpdateCheckStateForIdentityMigration,
  rollbackUpdateCheckIdentityMigration,
  writeUpdateCheckStateForIdentityMigration,
} from "./update-startup.js";

async function createRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-update-check-migration-"));
}

function plan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

describe("update-check identity migration writer", () => {
  it("reads legacy state, writes canonical state, and rolls back with a secret-free audit", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "update-check.json");
    const legacyState = {
      lastCheckedAt: "2026-09-04T10:00:00.000Z",
      lastAvailableVersion: "2026.9.1",
      lastAvailableTag: "beta",
    };
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyState, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityUpdateCheckMigration({ migrationPlan: plan(root) });
    expect(migration.readStatePath).toBe(legacyPath);
    await expect(readUpdateCheckStateForIdentityMigration(migration)).resolves.toEqual(legacyState);

    const first = await writeUpdateCheckStateForIdentityMigration(migration, legacyState);
    const canonicalPath = path.join(root, ".lcx", "update-check.json");
    if (process.platform !== "win32") {
      expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);
    }
    const second = await writeUpdateCheckStateForIdentityMigration(migration, {
      ...legacyState,
      lastCheckedAt: "2026-09-04T11:00:00.000Z",
    });
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual(legacyState);
    await rollbackUpdateCheckIdentityMigration(second);
    await expect(readUpdateCheckStateForIdentityMigration(migration)).resolves.toEqual(legacyState);

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"update-check"');
    expect(audit).not.toContain("2026-09-04T10:00:00.000Z");
    expect(first.previous.exists).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("supports explicit state roots and rejects config-only authority", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "operator-state");
    const migration = createLcxIdentityUpdateCheckMigration({
      migrationPlan: plan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    const receipt = await writeUpdateCheckStateForIdentityMigration(
      migration,
      { lastCheckedAt: "2026-09-04T12:00:00.000Z" },
      {
        expectedReadPath: migration.readStatePath,
        expectedWritePath: migration.writeStatePath,
      },
    );
    await rollbackUpdateCheckIdentityMigration(receipt);
    expect(() =>
      createLcxIdentityUpdateCheckMigration({
        migrationPlan: plan(root, { OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json") }),
      }),
    ).toThrow("state-root authority");
    await rm(root, { recursive: true, force: true });
  });
});
