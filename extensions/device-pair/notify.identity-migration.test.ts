import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../../src/config/paths.js";
import {
  createLcxIdentityDevicePairNotifyMigration,
  readDevicePairNotifyStateForIdentityMigration,
  rollbackDevicePairNotifyIdentityMigration,
  writeDevicePairNotifyStateForIdentityMigration,
  type NotifyStateFile,
} from "./notify.js";

async function createRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-device-pair-notify-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

describe("device pair notify identity migration writer", () => {
  it("reads legacy notify state, writes canonical state, and rolls back with a redacted audit", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "device-pair-notify.json");
    const legacyState: NotifyStateFile = {
      subscribers: [
        {
          to: "test-recipient",
          accountId: "test-account",
          messageThreadId: 7,
          mode: "persistent",
          addedAtMs: 1,
        },
      ],
      notifiedRequestIds: { "request-1": 1 },
    };
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyState, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityDevicePairNotifyMigration({
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readStatePath).toBe(legacyPath);
    await expect(readDevicePairNotifyStateForIdentityMigration(migration)).resolves.toEqual(
      legacyState,
    );

    const first = await writeDevicePairNotifyStateForIdentityMigration(migration, legacyState);
    const canonicalPath = path.join(root, ".lcx", "device-pair-notify.json");
    expect(first.previous.exists).toBe(false);
    expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);

    const second = await writeDevicePairNotifyStateForIdentityMigration(migration, {
      ...legacyState,
      notifiedRequestIds: { "request-2": 2 },
    });
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual(legacyState);
    await rollbackDevicePairNotifyIdentityMigration(second);
    await expect(readDevicePairNotifyStateForIdentityMigration(migration)).resolves.toEqual(
      legacyState,
    );

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"device-pair-notify"');
    expect(audit).toContain('"noSplitState":"single-write-target"');
    expect(audit).not.toContain("test-recipient");
    await rm(root, { recursive: true, force: true });
  });

  it("supports an explicit state root and rejects config-only authority", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "operator-state");
    const migration = createLcxIdentityDevicePairNotifyMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    expect(migration.readStatePath).toBe(migration.writeStatePath);
    const receipt = await writeDevicePairNotifyStateForIdentityMigration(
      migration,
      { subscribers: [], notifiedRequestIds: {} },
      {
        expectedReadPath: migration.readStatePath,
        expectedWritePath: migration.writeStatePath,
      },
    );
    await rollbackDevicePairNotifyIdentityMigration(receipt);

    expect(() =>
      createLcxIdentityDevicePairNotifyMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
    await rm(root, { recursive: true, force: true });
  });
});
