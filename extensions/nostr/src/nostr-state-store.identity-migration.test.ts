import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLcxIdentityMigrationPlan } from "lcx-agent/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  createLcxIdentityNostrBusMigration,
  createLcxIdentityNostrProfileMigration,
  readNostrBusStateForIdentityMigration,
  readNostrProfileStateForIdentityMigration,
  rollbackNostrBusIdentityMigration,
  rollbackNostrProfileIdentityMigration,
  writeNostrBusStateForIdentityMigration,
  writeNostrProfileStateForIdentityMigration,
} from "./nostr-state-store.js";

async function createRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-nostr-state-migration-"));
}

function plan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

describe("Nostr channel-local identity migration writers", () => {
  it("migrates bus state from legacy to canonical with backup, rollback, and secret-free audit", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "nostr", "bus-state-bot.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const legacyState = {
      version: 2,
      lastProcessedAt: 100,
      gatewayStartedAt: 90,
      recentEventIds: ["event-secret-marker"],
    } as const;
    await writeFile(legacyPath, `${JSON.stringify(legacyState, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityNostrBusMigration({
      migrationPlan: plan(root),
      accountId: "bot",
    });
    expect(migration.readStatePath).toBe(legacyPath);
    await expect(readNostrBusStateForIdentityMigration(migration)).resolves.toEqual(legacyState);

    const first = await writeNostrBusStateForIdentityMigration(migration, legacyState);
    const canonicalPath = path.join(root, ".lcx", "nostr", "bus-state-bot.json");
    expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);
    const second = await writeNostrBusStateForIdentityMigration(migration, {
      ...legacyState,
      lastProcessedAt: 200,
    });
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual(legacyState);
    await rollbackNostrBusIdentityMigration(second);
    await expect(readNostrBusStateForIdentityMigration(migration)).resolves.toEqual(legacyState);

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"nostr-bus"');
    expect(audit).not.toContain("event-secret-marker");
    expect(first.previous.exists).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("supports profile state and rejects config-only authority", async () => {
    const root = await createRoot();
    const migration = createLcxIdentityNostrProfileMigration({
      migrationPlan: plan(root),
      accountId: "bot",
    });
    const state = {
      lastPublishedAt: 1,
      lastPublishedEventId: "event-1",
      lastPublishResults: { relay: "ok" as const },
    };
    const receipt = await writeNostrProfileStateForIdentityMigration(migration, state, {
      expectedReadPath: migration.readStatePath,
      expectedWritePath: migration.writeStatePath,
    });
    await expect(readNostrProfileStateForIdentityMigration(migration)).resolves.toEqual({
      version: 1,
      ...state,
    });
    await rollbackNostrProfileIdentityMigration(receipt);

    expect(() =>
      createLcxIdentityNostrBusMigration({
        migrationPlan: plan(root, { OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json") }),
      }),
    ).toThrow("state-root authority");
    await rm(root, { recursive: true, force: true });
  });
});
