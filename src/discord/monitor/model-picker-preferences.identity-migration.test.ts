import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../../config/paths.js";
import {
  createLcxIdentityDiscordModelPickerPreferencesMigration,
  readDiscordModelPickerPreferencesForIdentityMigration,
  recordDiscordModelPickerRecentModelForIdentityMigration,
  rollbackDiscordModelPickerIdentityMigration,
} from "./model-picker-preferences.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-discord-model-picker-writer-"));
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

describe("Discord model picker identity migration writer", () => {
  it("reads legacy preferences, writes canonical preferences, refreshes, and rolls back", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(root, ".openclaw", "discord", "model-picker-preferences.json");
      const key = "discord:default:dm:user:123";
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify(
          { version: 1, entries: { [key]: { recent: ["openai/gpt-4o"], updatedAt: "old" } } },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const migration = createLcxIdentityDiscordModelPickerPreferencesMigration({
        migrationPlan: migrationPlan(root),
      });
      await expect(
        readDiscordModelPickerPreferencesForIdentityMigration(migration),
      ).resolves.toMatchObject({ entries: { [key]: { recent: ["openai/gpt-4o"] } } });

      await recordDiscordModelPickerRecentModelForIdentityMigration({
        migration,
        scope: { userId: "123" },
        modelRef: "openai/gpt-4.1",
      });
      const second = await recordDiscordModelPickerRecentModelForIdentityMigration({
        migration,
        scope: { userId: "123" },
        modelRef: "openai/gpt-4.5",
      });

      expect(second).not.toBeNull();
      expect(second?.pathContract.readPath).toBe(migration.writePreferencesPath);
      expect(
        JSON.parse(await fs.readFile(`${migration.writePreferencesPath}.bak`, "utf8")),
      ).toMatchObject({ entries: { [key]: { recent: ["openai/gpt-4.1", "openai/gpt-4o"] } } });
      await rollbackDiscordModelPickerIdentityMigration(second!);
      await expect(
        readDiscordModelPickerPreferencesForIdentityMigration(migration),
      ).resolves.toMatchObject({
        entries: { [key]: { recent: ["openai/gpt-4.1", "openai/gpt-4o"] } },
      });
    });
  });

  it("rejects config-only authority", async () => {
    await withTempRoot(async (root) => {
      const plan = resolveLcxIdentityMigrationPlan({
        env: {
          OPENCLAW_CONFIG_PATH: path.join(root, "operator", "openclaw.json"),
        } as NodeJS.ProcessEnv,
        homedir: () => root,
        existsSync: nodeFs.existsSync,
      });
      expect(() =>
        createLcxIdentityDiscordModelPickerPreferencesMigration({ migrationPlan: plan }),
      ).toThrow(/state-root authority/);
    });
  });
});
