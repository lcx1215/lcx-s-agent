import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../../../src/config/paths.js";
import {
  createLcxIdentityMSTeamsPollMigration,
  readMSTeamsPollStoreForIdentityMigration,
  rollbackMSTeamsPollIdentityMigration,
  writeMSTeamsPollStoreForIdentityMigration,
} from "./polls.js";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-msteams-polls-migration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MSTeams poll identity migration writer", () => {
  it("reads legacy polls, writes canonical state, backs up, and rolls back", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "msteams-polls.json");
    const legacy = {
      version: 1 as const,
      polls: {
        poll1: {
          id: "poll1",
          question: "Question",
          options: ["A", "B"],
          maxSelections: 1,
          createdAt: "now",
          votes: {},
        },
      },
    };
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const migration = createLcxIdentityMSTeamsPollMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
    });
    await expect(readMSTeamsPollStoreForIdentityMigration(migration)).resolves.toEqual(legacy);
    const first = await writeMSTeamsPollStoreForIdentityMigration(migration, legacy);
    const second = await writeMSTeamsPollStoreForIdentityMigration(migration, {
      version: 1,
      polls: {},
    });
    const canonicalPath = path.join(root, ".lcx", "msteams-polls.json");
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toEqual(legacy);
    await rollbackMSTeamsPollIdentityMigration(second);
    await expect(readMSTeamsPollStoreForIdentityMigration(migration)).resolves.toEqual(legacy);
    expect(first.previous.exists).toBe(false);
    expect(await readFile(migration.pathContract.auditPath, "utf8")).toContain(
      '"writer":"channel-local"',
    );
  });

  it("rejects multiple legacy roots", async () => {
    const root = await createRoot();
    for (const dirname of [".openclaw", ".clawdbot"]) {
      const filePath = path.join(root, dirname, "msteams-polls.json");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, '{"version":1,"polls":{}}\n');
    }
    expect(() =>
      createLcxIdentityMSTeamsPollMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      }),
    ).toThrowError(expect.objectContaining({ code: "LCX_IDENTITY_SPLIT_STATE" }));
  });
});
