import fs from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  getSubagentRegistryPersistFailure,
  persistSubagentRunsToDisk,
} from "./subagent-registry-state.js";
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
    if (process.platform !== "win32") {
      expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);
    }
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
  it("rejects a stale migration snapshot instead of replacing a concurrent runtime receipt", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "state");
    const migration = createLcxIdentitySubagentRegistryMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    await mkdir(path.dirname(migration.readRegistryPath), { recursive: true });
    await writeFile(
      migration.readRegistryPath,
      JSON.stringify({ version: 2, runs: { "run-1": createRun() } }),
    );
    const stale = await readSubagentRegistryForIdentityMigration(migration);
    const latest = JSON.stringify({
      version: 2,
      runs: { "run-1": createRun(), "run-2": createRun({ runId: "run-2" }) },
    });
    await writeFile(migration.writeRegistryPath, latest);
    stale.set("run-1", createRun({ task: "stale replacement" }));
    await expect(writeSubagentRegistryForIdentityMigration(migration, stale)).rejects.toThrow(
      "conflict",
    );
    expect(await readFile(migration.writeRegistryPath, "utf8")).toBe(latest);
  });

  it("blocks unknown migration structures without turning them into an empty registry", async () => {
    const root = await createRoot();
    const migration = createLcxIdentitySubagentRegistryMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: path.join(root, "state") }),
    });
    await mkdir(path.dirname(migration.readRegistryPath), { recursive: true });
    const unknown = JSON.stringify({ version: 99, runs: { "run-1": createRun() } });
    await writeFile(migration.readRegistryPath, unknown);
    await expect(readSubagentRegistryForIdentityMigration(migration)).rejects.toThrow(
      "unknown structure",
    );
    await expect(writeSubagentRegistryForIdentityMigration(migration, new Map())).rejects.toThrow(
      "unknown structure",
    );
    expect(await readFile(migration.writeRegistryPath, "utf8")).toBe(unknown);
  });
  it("holds the migration mutex across awaits and reports same-process runtime contention", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "state");
    const migration = createLcxIdentitySubagentRegistryMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    await mkdir(path.dirname(migration.readRegistryPath), { recursive: true });
    const original = JSON.stringify({ version: 2, runs: { "run-1": createRun() } });
    await writeFile(migration.readRegistryPath, original);
    const before = await readSubagentRegistryForIdentityMigration(migration);
    const next = new Map(before);
    next.set("run-1", createRun({ task: "migration update" }));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const pending = writeSubagentRegistryForIdentityMigration(migration, next);
    expect(persistSubagentRunsToDisk(new Map([["runtime", createRun({ runId: "runtime" })]]))).toBe(
      false,
    );
    expect(getSubagentRegistryPersistFailure()).toMatchObject({
      kind: "write-error",
      detail: expect.stringContaining("lock timeout"),
    });
    // The pending async owner has not executed its filesystem write yet.
    expect(fs.readFileSync(migration.writeRegistryPath, "utf8")).toBe(original);
    await pending;
    expect(JSON.parse(await readFile(migration.writeRegistryPath, "utf8")).runs["run-1"].task).toBe(
      "migration update",
    );
  });
});
