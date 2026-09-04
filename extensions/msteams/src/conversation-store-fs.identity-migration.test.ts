import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../../../src/config/paths.js";
import {
  createLcxIdentityMSTeamsConversationMigration,
  readMSTeamsConversationStoreForIdentityMigration,
  rollbackMSTeamsConversationIdentityMigration,
  writeMSTeamsConversationStoreForIdentityMigration,
  type MSTeamsConversationStoreData,
} from "./conversation-store-fs.js";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-msteams-migration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MSTeams conversation identity migration writer", () => {
  it("reads legacy state, writes canonical state, backs up, and rolls back", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "msteams-conversations.json");
    const legacy: MSTeamsConversationStoreData = {
      version: 1,
      conversations: {
        "conversation-1": {
          conversation: { id: "conversation-1" },
          channelId: "msteams",
          serviceUrl: "https://service.example.com",
          user: { id: "user-1" },
        },
      },
    };
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const migration = createLcxIdentityMSTeamsConversationMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
    });
    await expect(readMSTeamsConversationStoreForIdentityMigration(migration)).resolves.toEqual(
      legacy,
    );

    const first = await writeMSTeamsConversationStoreForIdentityMigration(migration, legacy);
    const canonicalPath = path.join(root, ".lcx", "msteams-conversations.json");
    const replacement: MSTeamsConversationStoreData = {
      version: 1,
      conversations: {
        "conversation-2": {
          conversation: { id: "conversation-2" },
          channelId: "msteams",
          serviceUrl: "https://service.example.com",
          user: { id: "user-2" },
        },
      },
    };
    const second = await writeMSTeamsConversationStoreForIdentityMigration(migration, replacement);
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual(legacy);
    await rollbackMSTeamsConversationIdentityMigration(second);
    await expect(readMSTeamsConversationStoreForIdentityMigration(migration)).resolves.toEqual(
      legacy,
    );
    expect(first.previous.exists).toBe(false);
    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"channel-local"');
  });

  it("rejects multiple legacy roots and config-only authority", async () => {
    const root = await createRoot();
    const value = JSON.stringify({ version: 1, conversations: {} });
    for (const dirname of [".openclaw", ".clawdbot"]) {
      const filePath = path.join(root, dirname, "msteams-conversations.json");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${value}\n`);
    }
    expect(() =>
      createLcxIdentityMSTeamsConversationMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      }),
    ).toThrowError(expect.objectContaining({ code: "LCX_IDENTITY_SPLIT_STATE" }));

    expect(() =>
      createLcxIdentityMSTeamsConversationMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({
          env: { OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json") },
          homedir: () => root,
        }),
      }),
    ).toThrow("state-root authority");
  });
});
