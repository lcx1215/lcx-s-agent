import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "./paths.js";
import {
  appendSessionTranscriptForIdentityMigration,
  createLcxIdentitySessionMigration,
  readSessionStoreForIdentityMigration,
  rollbackSessionStoreIdentityMigration,
  writeSessionStoreForIdentityMigration,
} from "./sessions/identity-migration.js";
import { saveSessionStore } from "./sessions/store.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-state-writer-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeRaw(filePath: string, raw: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw, "utf8");
}

function migrationPlan(root: string) {
  return resolveLcxIdentityMigrationPlan({
    env: {} as NodeJS.ProcessEnv,
    homedir: () => root,
    existsSync: nodeFs.existsSync,
  });
}

describe("LCX identity migration writer contract", () => {
  it("selects an existing legacy session store for read and the canonical store for write", async () => {
    await withTempRoot(async (root) => {
      const legacyStorePath = path.join(
        root,
        ".openclaw",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      await writeRaw(legacyStorePath, JSON.stringify({ "agent:main": { sessionId: "s-1" } }));

      const migration = createLcxIdentitySessionMigration({ migrationPlan: migrationPlan(root) });
      expect(migration.readStorePath).toBe(legacyStorePath);
      expect(migration.writeStorePath).toBe(
        path.join(root, ".lcx", "agents", "main", "sessions", "sessions.json"),
      );
      expect(await readSessionStoreForIdentityMigration(migration)).toMatchObject({
        "agent:main": { sessionId: "s-1" },
      });

      const receipt = await writeSessionStoreForIdentityMigration(migration, {
        "agent:main": { sessionId: "s-1", updatedAt: 1 },
      });
      expect(receipt.pathContract).toMatchObject({
        writer: "sessions",
        readPath: legacyStorePath,
        writePath: migration.writeStorePath,
        backupPath: `${migration.writeStorePath}.bak`,
        auditPath: path.join(root, ".lcx", "logs", "identity-migration-audit.jsonl"),
        rollbackPath: `${migration.writeStorePath}.bak`,
        noSplitState: "single-write-target",
      });
      expect(JSON.parse(await fs.readFile(migration.writeStorePath, "utf8"))).toMatchObject({
        "agent:main": { sessionId: "s-1", updatedAt: 1 },
      });
      expect(await fs.readFile(legacyStorePath, "utf8")).toContain('"sessionId":"s-1"');

      await rollbackSessionStoreIdentityMigration(receipt);
      await expect(fs.access(migration.writeStorePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(legacyStorePath, "utf8")).toContain('"sessionId":"s-1"');
    });
  });

  it("backs up and restores an existing canonical session store", async () => {
    await withTempRoot(async (root) => {
      const canonicalStorePath = path.join(
        root,
        ".lcx",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const originalRaw = '{"agent:main":{"sessionId":"canonical"}}\n';
      await writeRaw(canonicalStorePath, originalRaw);

      const migration = createLcxIdentitySessionMigration({ migrationPlan: migrationPlan(root) });
      const receipt = await writeSessionStoreForIdentityMigration(migration, {
        "agent:main": { sessionId: "next", updatedAt: 2 },
      });
      expect(receipt.rollback.strategy).toBe("restore-backup");
      expect(await fs.readFile(`${canonicalStorePath}.bak`, "utf8")).toBe(originalRaw);

      await rollbackSessionStoreIdentityMigration(receipt);
      expect(await fs.readFile(canonicalStorePath, "utf8")).toBe(originalRaw);
    });
  });

  it("routes the session store writer through the adapter without changing defaults", async () => {
    await withTempRoot(async (root) => {
      const legacyStorePath = path.join(
        root,
        ".openclaw",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      await writeRaw(legacyStorePath, "{}\n");
      const migration = createLcxIdentitySessionMigration({ migrationPlan: migrationPlan(root) });

      await saveSessionStore(
        migration.readStorePath,
        { "agent:main": { sessionId: "s-2", updatedAt: 2 } },
        { skipMaintenance: true, identityMigration: migration },
      );

      expect(await fs.readFile(legacyStorePath, "utf8")).toBe("{}\n");
      expect(JSON.parse(await fs.readFile(migration.writeStorePath, "utf8"))).toMatchObject({
        "agent:main": { sessionId: "s-2" },
      });
      expect(
        (
          await fs.readFile(
            path.join(root, ".lcx", "logs", "identity-migration-audit.jsonl"),
            "utf8",
          )
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ writer: "sessions", event: "identity.write" }),
        ]),
      );
    });
  });

  it("refreshes the session path contract after the first canonical write", async () => {
    await withTempRoot(async (root) => {
      const legacyStorePath = path.join(
        root,
        ".openclaw",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      await writeRaw(legacyStorePath, "{}\n");
      const migration = createLcxIdentitySessionMigration({ migrationPlan: migrationPlan(root) });

      await saveSessionStore(
        legacyStorePath,
        { "agent:main": { sessionId: "s-4", updatedAt: 1 } },
        { skipMaintenance: true, identityMigration: migration },
      );
      await saveSessionStore(
        legacyStorePath,
        { "agent:main": { sessionId: "s-4", updatedAt: 2 } },
        { skipMaintenance: true, identityMigration: migration },
      );

      expect(
        JSON.parse(
          await fs.readFile(
            path.join(root, ".lcx", "agents", "main", "sessions", "sessions.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ "agent:main": { updatedAt: 2 } });
      expect(await fs.readFile(legacyStorePath, "utf8")).toBe("{}\n");
    });
  });

  it("appends a transcript through SessionManager before committing the canonical raw file", async () => {
    await withTempRoot(async (root) => {
      const legacyTranscriptPath = path.join(
        root,
        ".openclaw",
        "agents",
        "main",
        "sessions",
        "s-3.jsonl",
      );
      const legacyRaw =
        '{"type":"session","version":1,"id":"s-3","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/tmp"}\n';
      await writeRaw(legacyTranscriptPath, legacyRaw);
      const migration = createLcxIdentitySessionMigration({ migrationPlan: migrationPlan(root) });

      const result = await appendSessionTranscriptForIdentityMigration({
        migration,
        sessionId: "s-3",
        text: "canonical transcript message",
      });
      expect(result.sessionFile).toBe(
        path.join(root, ".lcx", "agents", "main", "sessions", "s-3.jsonl"),
      );
      const nextLines = (await fs.readFile(result.sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(nextLines.at(-1)).toMatchObject({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "canonical transcript message" }],
        },
      });
      expect(nextLines.at(-1)?.parentId).toBeDefined();
      expect(await fs.readFile(legacyTranscriptPath, "utf8")).toBe(legacyRaw);

      await rollbackSessionStoreIdentityMigration(result.receipt);
      await expect(fs.access(result.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refreshes the active target and fails closed on external rollback changes", async () => {
    await withTempRoot(async (root) => {
      const legacyStorePath = path.join(
        root,
        ".openclaw",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const canonicalStorePath = path.join(
        root,
        ".lcx",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      await writeRaw(legacyStorePath, "{}\n");
      const migration = createLcxIdentitySessionMigration({ migrationPlan: migrationPlan(root) });
      await writeRaw(canonicalStorePath, "{}\n");
      await expect(writeSessionStoreForIdentityMigration(migration, {})).resolves.toBeDefined();

      await fs.rm(canonicalStorePath);
      const receipt = await writeSessionStoreForIdentityMigration(migration, {});
      await writeRaw(canonicalStorePath, "external\n");
      await expect(rollbackSessionStoreIdentityMigration(receipt)).rejects.toMatchObject({
        code: "LCX_IDENTITY_ROLLBACK_TARGET_MISMATCH",
      });
    });
  });
});
