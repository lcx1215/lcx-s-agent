import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../paths.js";
import { createLcxIdentitySessionMigration } from "./identity-migration.js";
import {
  rollbackSessionFileIdentityRotation,
  rotateSessionFileForIdentityMigration,
} from "./store.js";

const tempRoots: string[] = [];

async function createLegacyMigration() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-session-maintenance-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, ".openclaw", "agents", "main", "sessions"), {
    recursive: true,
  });
  const migrationPlan = resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root });
  return {
    root,
    migration: createLcxIdentitySessionMigration({ migrationPlan }),
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("LCX session maintenance identity migration", () => {
  it("rotates a legacy store into canonical backup storage with rollback receipts", async () => {
    const { root, migration } = await createLegacyMigration();
    const legacyStorePath = migration.readStorePath;
    const canonicalDir = path.dirname(migration.writeStorePath);
    const content = "x".repeat(200);
    await fs.writeFile(legacyStorePath, content, "utf8");
    await fs.mkdir(canonicalDir, { recursive: true });
    for (const timestamp of [1000, 2000, 3000, 4000]) {
      await fs.writeFile(
        path.join(canonicalDir, `sessions.json.bak.${timestamp}`),
        `old-${timestamp}`,
        "utf8",
      );
    }

    const receipt = await rotateSessionFileForIdentityMigration({
      migration,
      overrideBytes: 100,
      nowMs: 5000,
    });

    expect(receipt).not.toBeNull();
    expect(receipt?.archiveWrite.pathContract.writer).toBe("backups");
    expect(receipt?.sourceRemoval.pathContract.writer).toBe("sessions");
    await expect(
      fs.readFile(path.join(canonicalDir, "sessions.json.bak.5000"), "utf8"),
    ).resolves.toBe(content);
    await expect(fs.access(legacyStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(migration.writeStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(canonicalDir, "sessions.json.bak.1000")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.access(path.join(canonicalDir, "sessions.json.bak.2000")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rollbackSessionFileIdentityRotation(receipt!);
    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toBe(content);
    await expect(fs.access(migration.writeStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(canonicalDir, "sessions.json.bak.5000")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(path.join(canonicalDir, "sessions.json.bak.1000"), "utf8"),
    ).resolves.toBe("old-1000");
    expect(root).toContain("lcx-session-maintenance-");
  });

  it("rejects a legacy rotation when the canonical store already exists", async () => {
    const { migration } = await createLegacyMigration();
    await fs.writeFile(migration.readStorePath, "x".repeat(200), "utf8");
    await fs.mkdir(path.dirname(migration.writeStorePath), { recursive: true });
    await fs.writeFile(migration.writeStorePath, "canonical", "utf8");

    await expect(
      rotateSessionFileForIdentityMigration({ migration, overrideBytes: 100, nowMs: 6000 }),
    ).rejects.toMatchObject({ code: "LCX_IDENTITY_SPLIT_STATE" });
  });
});
