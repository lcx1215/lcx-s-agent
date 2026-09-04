import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../../config/paths.js";
import {
  createLcxIdentityAuthProfileMigration,
  readAuthProfileStoreForIdentityMigration,
  rollbackAuthProfileIdentityMigration,
  writeAuthProfileStoreForIdentityMigration,
} from "./identity-migration.js";
import type { AuthProfileStore } from "./types.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-credentials-writer-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function migrationPlan(root: string) {
  return resolveLcxIdentityMigrationPlan({
    env: {} as NodeJS.ProcessEnv,
    homedir: () => root,
    existsSync: nodeFs.existsSync,
  });
}

async function writeJson(filePath: string, value: unknown): Promise<string> {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw, "utf8");
  return raw;
}

describe("LCX identity migration credentials writer", () => {
  it("reads legacy auth profiles and writes only the canonical agent store", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(
        root,
        ".openclaw",
        "agents",
        "main",
        "agent",
        "auth-profiles.json",
      );
      const legacyStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "secret" },
        },
      };
      const legacyRaw = await writeJson(legacyPath, legacyStore);
      const migration = createLcxIdentityAuthProfileMigration({
        migrationPlan: migrationPlan(root),
      });

      expect(migration.readAuthStorePath).toBe(legacyPath);
      expect(await readAuthProfileStoreForIdentityMigration(migration)).toMatchObject(legacyStore);
      const receipt = await writeAuthProfileStoreForIdentityMigration(migration, legacyStore);

      expect(receipt.pathContract).toMatchObject({
        writer: "credentials",
        readPath: legacyPath,
        writePath: path.join(root, ".lcx", "agents", "main", "agent", "auth-profiles.json"),
        noSplitState: "single-write-target",
      });
      expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyRaw);
      expect(JSON.parse(await fs.readFile(migration.writeAuthStorePath, "utf8"))).toMatchObject(
        legacyStore,
      );
      expect(
        await fs.readFile(
          path.join(root, ".lcx", "logs", "identity-migration-audit.jsonl"),
          "utf8",
        ),
      ).not.toContain("secret");

      await rollbackAuthProfileIdentityMigration(receipt);
      await expect(fs.access(migration.writeAuthStorePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyRaw);
    });
  });

  it("rejects a config-only override because it cannot identify a state writer root", async () => {
    await withTempRoot(async (root) => {
      const plan = resolveLcxIdentityMigrationPlan({
        env: {
          OPENCLAW_CONFIG_PATH: path.join(root, "operator", "openclaw.json"),
        } as NodeJS.ProcessEnv,
        homedir: () => root,
        existsSync: nodeFs.existsSync,
      });
      expect(() => createLcxIdentityAuthProfileMigration({ migrationPlan: plan })).toThrow(
        /state-root authority/,
      );
    });
  });
});
