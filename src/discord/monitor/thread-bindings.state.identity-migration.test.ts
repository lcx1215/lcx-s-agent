import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../../config/paths.js";
import {
  BINDINGS_BY_THREAD_ID,
  createLcxIdentityDiscordThreadBindingsMigration,
  readThreadBindingsForIdentityMigration,
  rollbackDiscordThreadBindingsIdentityMigration,
  saveBindingsToDiskForIdentityMigration,
} from "./thread-bindings.state.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-discord-bindings-writer-"));
  try {
    await run(root);
  } finally {
    BINDINGS_BY_THREAD_ID.clear();
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

describe("Discord thread bindings identity migration writer", () => {
  it("reads legacy bindings, writes canonical bindings, and refreshes the read target", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(root, ".openclaw", "discord", "thread-bindings.json");
      const binding = {
        accountId: "default",
        channelId: "channel-1",
        threadId: "thread-1",
        targetKind: "acp" as const,
        targetSessionKey: "agent:main:discord:channel:channel-1",
        agentId: "main",
        boundBy: "system",
        boundAt: 1,
        lastActivityAt: 2,
        webhookToken: "discord-webhook-secret",
      };
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 1, bindings: { "default:thread-1": binding } }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const migration = createLcxIdentityDiscordThreadBindingsMigration({
        migrationPlan: migrationPlan(root),
      });
      await expect(readThreadBindingsForIdentityMigration(migration)).resolves.toMatchObject({
        bindings: { "default:thread-1": binding },
      });

      BINDINGS_BY_THREAD_ID.set("default:thread-1", binding);
      const first = await saveBindingsToDiskForIdentityMigration(migration);
      BINDINGS_BY_THREAD_ID.set("default:thread-1", { ...binding, lastActivityAt: 3 });
      const second = await saveBindingsToDiskForIdentityMigration(migration);

      expect(second.pathContract.readPath).toBe(migration.writeBindingsPath);
      expect(
        JSON.parse(await fs.readFile(`${migration.writeBindingsPath}.bak`, "utf8")),
      ).toMatchObject({ bindings: { "default:thread-1": { lastActivityAt: 2 } } });
      expect(
        await fs.readFile(
          path.join(root, ".lcx", "logs", "identity-migration-audit.jsonl"),
          "utf8",
        ),
      ).not.toContain("discord-webhook-secret");
      await rollbackDiscordThreadBindingsIdentityMigration(second);
      await expect(readThreadBindingsForIdentityMigration(migration)).resolves.toMatchObject({
        bindings: { "default:thread-1": { lastActivityAt: 2 } },
      });
      expect(first.previous.exists).toBe(false);
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
        createLcxIdentityDiscordThreadBindingsMigration({ migrationPlan: plan }),
      ).toThrow(/state-root authority/);
    });
  });
});
