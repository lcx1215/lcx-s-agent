import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  consumeRestartSentinelForIdentityMigration,
  createLcxIdentityRestartSentinelMigration,
  readRestartSentinelForIdentityMigration,
  rollbackConsumedRestartSentinelMigration,
  rollbackRestartSentinelIdentityMigration,
  writeRestartSentinelForIdentityMigration,
} from "./restart-sentinel.js";

async function createRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-restart-sentinel-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

const payload = {
  kind: "update" as const,
  status: "ok" as const,
  ts: 1,
  message: "migration-complete",
};

describe("restart sentinel identity migration writer", () => {
  it("reads legacy state, writes canonical state, and rolls back without payload audit data", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "restart-sentinel.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify({ version: 1, payload }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityRestartSentinelMigration({
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readSentinelPath).toBe(legacyPath);
    await expect(readRestartSentinelForIdentityMigration(migration)).resolves.toMatchObject({
      exists: true,
      sentinel: { payload },
    });

    const first = await writeRestartSentinelForIdentityMigration(migration, payload);
    if (process.platform !== "win32") {
      expect((await stat(migration.writeSentinelPath)).mode & 0o777).toBe(0o600);
    }
    const replacement = { ...payload, ts: 2, message: "replacement" };
    const second = await writeRestartSentinelForIdentityMigration(migration, replacement);
    expect(JSON.parse(await readFile(`${migration.writeSentinelPath}.bak`, "utf8"))).toMatchObject({
      payload,
    });
    await rollbackRestartSentinelIdentityMigration(second);
    await expect(readRestartSentinelForIdentityMigration(migration)).resolves.toMatchObject({
      sentinel: { payload },
    });

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"restart-sentinel"');
    expect(audit).not.toContain("migration-complete");
    expect(audit).not.toContain("replacement");
    expect(first.previous.exists).toBe(false);
  });

  it("supports explicit state consumption with a reversible remove receipt", async () => {
    const root = await createRoot();
    const migration = createLcxIdentityRestartSentinelMigration({
      migrationPlan: migrationPlan(root, {
        OPENCLAW_STATE_DIR: path.join(root, "operator-state"),
      }),
    });
    const writeReceipt = await writeRestartSentinelForIdentityMigration(migration, payload, {
      expectedReadPath: migration.readSentinelPath,
      expectedWritePath: migration.writeSentinelPath,
    });
    const consumed = await consumeRestartSentinelForIdentityMigration(migration);
    expect(consumed?.sentinel.payload).toEqual(payload);
    expect(consumed?.receipt.previous.exists).toBe(true);
    expect(await readFile(migration.writeSentinelPath).catch(() => null)).toBeNull();
    if (!consumed) {
      throw new Error("expected sentinel to be consumed");
    }
    await rollbackConsumedRestartSentinelMigration(consumed.receipt);
    await expect(readRestartSentinelForIdentityMigration(migration)).resolves.toMatchObject({
      sentinel: { payload },
    });
    await rollbackRestartSentinelIdentityMigration(writeReceipt).catch(() => undefined);

    expect(() =>
      createLcxIdentityRestartSentinelMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
  });
});
