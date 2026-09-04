import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { createLcxIdentitySessionMigration } from "../config/sessions/identity-migration.js";
import {
  archiveSessionTranscriptForIdentityMigration,
  rollbackSessionTranscriptIdentityArchive,
} from "./session-utils.fs.js";

const tempRoots: string[] = [];

async function createLegacyMigration() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-session-archive-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, ".openclaw", "agents", "main", "sessions"), {
    recursive: true,
  });
  const migrationPlan = resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root });
  return createLcxIdentitySessionMigration({ migrationPlan });
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("LCX session transcript archive identity migration", () => {
  it("archives a legacy transcript into canonical backup storage and rolls it back", async () => {
    const migration = await createLegacyMigration();
    const content = '{"type":"session","id":"session-1"}\n';
    await fs.writeFile(path.join(migration.readSessionsDir, "session-1.jsonl"), content, "utf8");

    const receipt = await archiveSessionTranscriptForIdentityMigration({
      migration,
      sessionId: "session-1",
      reason: "deleted",
      nowMs: Date.parse("2026-09-04T10:20:30.000Z"),
    });

    expect(receipt).not.toBeNull();
    expect(receipt?.archiveWrite.pathContract.writer).toBe("backups");
    expect(receipt?.sourceRemoval.pathContract.writer).toBe("sessions");
    const archivePath = `${path.join(
      migration.writeSessionsDir,
      "session-1.jsonl",
    )}.deleted.${formatSessionArchiveTimestamp(Date.parse("2026-09-04T10:20:30.000Z"))}`;
    await expect(fs.readFile(archivePath, "utf8")).resolves.toBe(content);
    await expect(
      fs.access(path.join(migration.readSessionsDir, "session-1.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(migration.writeSessionsDir, "session-1.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await rollbackSessionTranscriptIdentityArchive(receipt!);
    await expect(
      fs.readFile(path.join(migration.readSessionsDir, "session-1.jsonl"), "utf8"),
    ).resolves.toBe(content);
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects archive when canonical and legacy transcripts both exist", async () => {
    const migration = await createLegacyMigration();
    const legacyPath = path.join(migration.readSessionsDir, "session-2.jsonl");
    const canonicalPath = path.join(migration.writeSessionsDir, "session-2.jsonl");
    await fs.writeFile(legacyPath, "legacy\n", "utf8");
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
    await fs.writeFile(canonicalPath, "canonical\n", "utf8");

    await expect(
      archiveSessionTranscriptForIdentityMigration({
        migration,
        sessionId: "session-2",
        reason: "reset",
      }),
    ).rejects.toMatchObject({ code: "LCX_IDENTITY_SPLIT_STATE" });
  });
});
