import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityWorkspaceDirectoryMigration,
  migrateWorkspaceDirectoryForIdentityMigration,
  readWorkspaceDirectoryForIdentityMigration,
  rollbackWorkspaceDirectoryIdentityMigration,
} from "./workspace.js";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-workspace-directory-migration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace directory identity migration writer", () => {
  it("moves the whole default workspace, including user files, and rolls it back", async () => {
    const root = await createRoot();
    const legacyDir = path.join(root, ".openclaw", "workspace");
    await mkdir(path.join(legacyDir, ".openclaw", "extensions"), { recursive: true });
    await writeFile(path.join(legacyDir, "AGENTS.md"), "user-owned instructions\n");
    await writeFile(path.join(legacyDir, "memory.md"), "user-owned memory\n");
    await writeFile(
      path.join(legacyDir, ".openclaw", "extensions", "plugin.js"),
      "workspace plugin\n",
    );

    const migration = createLcxIdentityWorkspaceDirectoryMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
    });
    await expect(readWorkspaceDirectoryForIdentityMigration(migration)).resolves.toMatchObject({
      exists: true,
      workspaceDir: legacyDir,
    });
    const result = await migrateWorkspaceDirectoryForIdentityMigration(migration);
    expect(result.status).toBe("migrated");
    const canonicalDir = path.join(root, ".lcx", "workspace");
    expect(await readFile(path.join(canonicalDir, "AGENTS.md"), "utf8")).toContain("user-owned");
    expect(
      await readFile(path.join(canonicalDir, ".openclaw", "extensions", "plugin.js"), "utf8"),
    ).toContain("workspace plugin");
    await expect(readdir(legacyDir)).rejects.toMatchObject({ code: "ENOENT" });

    await rollbackWorkspaceDirectoryIdentityMigration(result.receipt!);
    expect(await readdir(legacyDir)).toContain("AGENTS.md");
    await expect(readdir(canonicalDir)).rejects.toMatchObject({ code: "ENOENT" });
    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"workspace"');
  });

  it("supports profile directories and rejects multiple legacy roots", async () => {
    const root = await createRoot();
    const profile = createLcxIdentityWorkspaceDirectoryMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      profile: "work",
    });
    expect(profile.writeWorkspaceDir).toBe(path.join(root, ".lcx", "workspace-work"));

    for (const dirname of [".openclaw", ".clawdbot"]) {
      await mkdir(path.join(root, dirname, "workspace"), { recursive: true });
    }
    expect(() =>
      createLcxIdentityWorkspaceDirectoryMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      }),
    ).toThrowError(expect.objectContaining({ code: "LCX_IDENTITY_SPLIT_STATE" }));
  });
});
