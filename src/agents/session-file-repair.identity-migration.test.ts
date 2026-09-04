import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentitySessionMigration,
  resolveCurrentSessionIdentityPathContract,
} from "../config/sessions/identity-migration.js";
import {
  repairSessionFileForIdentityMigration,
  rollbackSessionFileIdentityMigration,
} from "./session-file-repair.js";

const tempRoots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-session-repair-migration-"));
  tempRoots.push(root);
  return root;
}

function plan(root: string) {
  return resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session file repair identity migration writer", () => {
  it("repairs a legacy transcript into canonical state and rolls it back without legacy mutation", async () => {
    const root = await createRoot();
    const legacySessionsDir = path.join(root, ".openclaw", "agents", "main", "sessions");
    const legacyStorePath = path.join(legacySessionsDir, "sessions.json");
    const legacyTranscriptPath = path.join(legacySessionsDir, "s-1.jsonl");
    await mkdir(legacySessionsDir, { recursive: true });
    await writeFile(legacyStorePath, "{}\n", { encoding: "utf8", mode: 0o600 });
    const legacyRaw =
      `${JSON.stringify({ type: "session", id: "s-1", version: 7 })}\n` +
      `${JSON.stringify({ type: "message", message: { role: "user", content: "kept" } })}\n` +
      "not-json secret-transcript-content\n";
    await writeFile(legacyTranscriptPath, legacyRaw, { encoding: "utf8", mode: 0o600 });

    const migration = createLcxIdentitySessionMigration({ migrationPlan: plan(root) });
    const result = await repairSessionFileForIdentityMigration({
      migration,
      sessionFile: legacyTranscriptPath,
    });
    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);
    expect(result.receipt?.rollback.strategy).toBe("remove-written-target");

    const canonicalPath = path.join(root, ".lcx", "agents", "main", "sessions", "s-1.jsonl");
    expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(legacyTranscriptPath, "utf8")).toBe(legacyRaw);
    expect(await readFile(canonicalPath, "utf8")).not.toContain("secret-transcript-content");
    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"sessions"');
    expect(audit).not.toContain("secret-transcript-content");

    if (!result.receipt) {
      throw new Error("expected a migration receipt");
    }
    await rollbackSessionFileIdentityMigration(result.receipt);
    await expect(readFile(canonicalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(legacyTranscriptPath, "utf8")).toBe(legacyRaw);
  });

  it("backs up an existing canonical transcript and rejects config-only authority", async () => {
    const root = await createRoot();
    const canonicalSessionsDir = path.join(root, ".lcx", "agents", "main", "sessions");
    const canonicalStorePath = path.join(canonicalSessionsDir, "sessions.json");
    const canonicalTranscriptPath = path.join(canonicalSessionsDir, "s-2.jsonl");
    await mkdir(canonicalSessionsDir, { recursive: true });
    await writeFile(canonicalStorePath, "{}\n", { encoding: "utf8", mode: 0o600 });
    const originalRaw = `${JSON.stringify({ type: "session", id: "s-2" })}\ninvalid\n`;
    await writeFile(canonicalTranscriptPath, originalRaw, { encoding: "utf8", mode: 0o600 });

    const migration = createLcxIdentitySessionMigration({ migrationPlan: plan(root) });
    expect(resolveCurrentSessionIdentityPathContract(migration).readPath).toBe(canonicalStorePath);
    const result = await repairSessionFileForIdentityMigration({
      migration,
      sessionFile: canonicalTranscriptPath,
    });
    expect(result.repaired).toBe(true);
    expect(result.backupPath).toBe(`${canonicalTranscriptPath}.bak`);
    expect(await readFile(result.backupPath!, "utf8")).toBe(originalRaw);
    await rollbackSessionFileIdentityMigration(result.receipt!);
    expect(await readFile(canonicalTranscriptPath, "utf8")).toBe(originalRaw);

    expect(() =>
      createLcxIdentitySessionMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({
          env: { OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json") },
          homedir: () => root,
        }),
      }),
    ).toThrow("state-root authority");
  });
});
