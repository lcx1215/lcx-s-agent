import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../../../src/config/paths.js";
import {
  createLcxIdentityExternalReplayMigration,
  readExternalReplayStateForIdentityMigration,
  rollbackExternalReplayIdentityMigration,
  writeExternalReplayStateForIdentityMigration,
} from "./replay-guard.js";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-external-replay-migration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external replay identity migration writer", () => {
  it("reads legacy dedupe state, writes canonical state, and rolls back", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "external", "replay-dedupe", "primary.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, '{"message-1":100,"invalid":"ignored"}\n', { mode: 0o600 });

    const migration = createLcxIdentityExternalReplayMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      namespace: "primary",
    });
    await expect(readExternalReplayStateForIdentityMigration(migration)).resolves.toEqual({
      "message-1": 100,
    });
    const first = await writeExternalReplayStateForIdentityMigration(migration, {
      "message-1": 100,
      "message-2": 200,
    });
    const second = await writeExternalReplayStateForIdentityMigration(migration, {
      "message-2": 200,
    });
    const canonicalPath = path.join(root, ".lcx", "external", "replay-dedupe", "primary.json");
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual({
      "message-1": 100,
      "message-2": 200,
    });
    await rollbackExternalReplayIdentityMigration(second);
    await expect(readExternalReplayStateForIdentityMigration(migration)).resolves.toEqual({
      "message-1": 100,
      "message-2": 200,
    });
    expect(first.previous.exists).toBe(false);
    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"channel-local"');
  });

  it("rejects multiple legacy roots and config-only authority", async () => {
    const root = await createRoot();
    for (const dirname of [".openclaw", ".clawdbot"]) {
      const statePath = path.join(root, dirname, "external", "replay-dedupe", "primary.json");
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, '{"message":1}\n');
    }
    expect(() =>
      createLcxIdentityExternalReplayMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
        namespace: "primary",
      }),
    ).toThrowError(expect.objectContaining({ code: "LCX_IDENTITY_SPLIT_STATE" }));

    expect(() =>
      createLcxIdentityExternalReplayMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({
          env: { OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json") },
          homedir: () => root,
        }),
        namespace: "primary",
      }),
    ).toThrow("state-root authority");
  });
});
