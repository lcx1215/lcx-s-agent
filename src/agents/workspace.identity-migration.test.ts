import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityWorkspaceMigration,
  readWorkspaceOnboardingStateForIdentityMigration,
  rollbackWorkspaceOnboardingStateIdentityMigration,
  writeWorkspaceOnboardingStateForIdentityMigration,
} from "./workspace.js";

async function createRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-workspace-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

describe("workspace onboarding state identity migration writer", () => {
  it("reads legacy state, writes canonical state, and rolls back without state values in audit", async () => {
    const root = await createRoot();
    const legacyPath = path.join(
      root,
      ".openclaw",
      "workspace",
      ".openclaw",
      "workspace-state.json",
    );
    const legacyState = {
      version: 1,
      bootstrapSeededAt: "2026-09-04T10:00:00.000Z",
      onboardingCompletedAt: "2026-09-04T10:01:00.000Z",
    } as const;
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyState, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityWorkspaceMigration({
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readWorkspaceStatePath).toBe(legacyPath);
    await expect(readWorkspaceOnboardingStateForIdentityMigration(migration)).resolves.toEqual(
      legacyState,
    );

    const first = await writeWorkspaceOnboardingStateForIdentityMigration(migration, legacyState);
    const canonicalPath = path.join(root, ".lcx", "workspace", ".openclaw", "workspace-state.json");
    expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);

    const replacementState = {
      version: 1 as const,
      bootstrapSeededAt: "2026-09-04T11:00:00.000Z",
    };
    const second = await writeWorkspaceOnboardingStateForIdentityMigration(
      migration,
      replacementState,
    );
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual(legacyState);
    await rollbackWorkspaceOnboardingStateIdentityMigration(second);
    await expect(readWorkspaceOnboardingStateForIdentityMigration(migration)).resolves.toEqual(
      legacyState,
    );

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"workspace"');
    expect(audit).not.toContain(legacyState.bootstrapSeededAt);
    expect(audit).not.toContain(replacementState.bootstrapSeededAt);
    expect(first.previous.exists).toBe(false);
  });

  it("supports profile and explicit state roots, while rejecting config-only authority", async () => {
    const root = await createRoot();
    const profileMigration = createLcxIdentityWorkspaceMigration({
      migrationPlan: migrationPlan(root),
      profile: "work",
    });
    expect(profileMigration.writeWorkspaceStatePath).toBe(
      path.join(root, ".lcx", "workspace-work", ".openclaw", "workspace-state.json"),
    );

    const stateDir = path.join(root, "operator-state");
    const overrideMigration = createLcxIdentityWorkspaceMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    const receipt = await writeWorkspaceOnboardingStateForIdentityMigration(
      overrideMigration,
      { version: 1, onboardingCompletedAt: "2026-09-04T12:00:00.000Z" },
      {
        expectedReadPath: overrideMigration.readWorkspaceStatePath,
        expectedWritePath: overrideMigration.writeWorkspaceStatePath,
      },
    );
    expect(overrideMigration.readWorkspaceStatePath).toBe(
      path.join(stateDir, "workspace", ".openclaw", "workspace-state.json"),
    );
    await rollbackWorkspaceOnboardingStateIdentityMigration(receipt);

    expect(() =>
      createLcxIdentityWorkspaceMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
  });
});
