import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentitySubagentRegistryMigration,
  readSubagentRegistryForIdentityMigration,
  rollbackSubagentRegistryIdentityMigration,
  writeSubagentRegistryForIdentityMigration,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

async function createRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-subagent-registry-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:one",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "migrate this task",
    cleanup: "keep",
    createdAt: 1,
    ...overrides,
  };
}

describe("subagent registry identity migration writer", () => {
  it("reads legacy v1 state, writes canonical v2 state, and rolls back without task data in audit", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "subagents", "runs.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      `${JSON.stringify(
        {
          version: 1,
          runs: {
            "run-1": {
              ...createRun(),
              announceCompletedAt: 9,
              requesterChannel: "telegram",
            },
          },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const migration = createLcxIdentitySubagentRegistryMigration({
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readRegistryPath).toBe(legacyPath);
    const legacyRuns = await readSubagentRegistryForIdentityMigration(migration);
    expect(legacyRuns.get("run-1")).toMatchObject({
      cleanupCompletedAt: 9,
      requesterOrigin: { channel: "telegram" },
    });

    const first = await writeSubagentRegistryForIdentityMigration(migration, legacyRuns);
    const canonicalPath = path.join(root, ".lcx", "subagents", "runs.json");
    expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(canonicalPath, "utf8"))).toMatchObject({ version: 2 });

    const replacementRuns = new Map(legacyRuns);
    replacementRuns.set("run-1", createRun({ task: "replacement task" }));
    const second = await writeSubagentRegistryForIdentityMigration(migration, replacementRuns);
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toMatchObject({
      runs: { "run-1": { task: "migrate this task" } },
    });
    await rollbackSubagentRegistryIdentityMigration(second);
    await expect(readSubagentRegistryForIdentityMigration(migration)).resolves.toMatchObject(
      new Map([["run-1", expect.objectContaining({ task: "migrate this task" })]]),
    );
    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"subagents"');
    expect(audit).not.toContain("migrate this task");
    expect(audit).not.toContain("replacement task");
    expect(first.previous.exists).toBe(false);
  });

  it("uses an explicit state override and rejects config-only authority", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "operator-state");
    const migration = createLcxIdentitySubagentRegistryMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    const receipt = await writeSubagentRegistryForIdentityMigration(
      migration,
      new Map([["run-1", createRun()]]),
      {
        expectedReadPath: migration.readRegistryPath,
        expectedWritePath: migration.writeRegistryPath,
      },
    );
    expect(migration.readRegistryPath).toBe(migration.writeRegistryPath);
    await rollbackSubagentRegistryIdentityMigration(receipt);

    expect(() =>
      createLcxIdentitySubagentRegistryMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
  });
});
