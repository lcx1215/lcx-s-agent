import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityNodeHostMigration,
  readNodeHostConfigForIdentityMigration,
  rollbackNodeHostIdentityMigration,
  writeNodeHostConfigForIdentityMigration,
  type NodeHostConfig,
} from "./config.js";

async function createRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-node-host-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

describe("node host identity migration writer", () => {
  it("reads legacy config, writes canonical config, and rolls back with an audit receipt", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "node.json");
    const legacyConfig: NodeHostConfig = {
      version: 1,
      nodeId: "node-legacy",
      displayName: "legacy-node",
      gateway: { host: "127.0.0.1", port: 18789 },
    };
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityNodeHostMigration({
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readNodeHostConfigPath).toBe(legacyPath);
    await expect(readNodeHostConfigForIdentityMigration(migration)).resolves.toEqual(legacyConfig);

    const first = await writeNodeHostConfigForIdentityMigration(migration, legacyConfig);
    const canonicalPath = path.join(root, ".lcx", "node.json");
    expect(first.previous.exists).toBe(false);
    if (process.platform !== "win32") {
      expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);
    }

    const replacement = { ...legacyConfig, displayName: "canonical-node" };
    const second = await writeNodeHostConfigForIdentityMigration(migration, replacement);
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual(legacyConfig);
    await rollbackNodeHostIdentityMigration(second);
    await expect(readNodeHostConfigForIdentityMigration(migration)).resolves.toEqual(legacyConfig);

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"node-host"');
    expect(audit).toContain('"noSplitState":"single-write-target"');
    expect(audit).not.toContain("canonical-node");
    await rm(root, { recursive: true, force: true });
  });

  it("supports an explicit state root and rejects config-only authority", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "operator-state");
    const migration = createLcxIdentityNodeHostMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    expect(migration.readNodeHostConfigPath).toBe(migration.writeNodeHostConfigPath);
    const receipt = await writeNodeHostConfigForIdentityMigration(
      migration,
      { version: 1, nodeId: "node-override" },
      {
        expectedReadPath: migration.readNodeHostConfigPath,
        expectedWritePath: migration.writeNodeHostConfigPath,
      },
    );
    await rollbackNodeHostIdentityMigration(receipt);

    expect(() =>
      createLcxIdentityNodeHostMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
    await rm(root, { recursive: true, force: true });
  });
});
