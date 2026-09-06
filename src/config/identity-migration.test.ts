import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLcxIdentityWriterPathContract,
  LCX_IDENTITY_WRITER_NAMES,
  assertLcxIdentityWriterPathContract,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityMigrationCompletionMarker,
  writeLcxIdentityWriterRawWithReceipt,
} from "./identity-migration.js";
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
  it("writes a canonical completion marker atomically", async () => {
    await withTempRoot(async (root) => {
      const plan = migrationPlan(root);
      const marker = await writeLcxIdentityMigrationCompletionMarker({
        migrationPlan: plan,
        writerReceipts: LCX_IDENTITY_WRITER_NAMES.map((writer) => {
          const pathContract = createLcxIdentityWriterPathContract({
            writer,
            migrationPlan: plan,
            readPath: path.join(root, ".openclaw", `${writer}.state`),
            writePath: path.join(root, ".lcx", `${writer}.state`),
          });
          return {
            pathContract,
            previous: { exists: false, hash: null, bytes: null },
            next: { hash: "a".repeat(64), bytes: 1 },
            rollback: {
              path: pathContract.rollbackPath,
              strategy: "remove-written-target" as const,
            },
            audit: { status: "written" as const },
          };
        }),
        now: () => "2026-09-06T00:00:00.000Z",
      });

      expect(marker).toEqual({
        schemaVersion: 1,
        canonicalStateDir: path.join(root, ".lcx"),
        completedAt: "2026-09-06T00:00:00.000Z",
      });
      expect(
        JSON.parse(
          await fs.readFile(path.join(root, ".lcx", "identity-migration.complete.json"), "utf8"),
        ),
      ).toEqual(marker);
    });
  });

  it("refuses to activate the canonical root without every durable writer receipt", async () => {
    await withTempRoot(async (root) => {
      await expect(
        writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: migrationPlan(root),
          writerReceipts: [],
        }),
      ).rejects.toMatchObject({ code: "LCX_IDENTITY_COMPLETION_WRITERS_INCOMPLETE" });
      await expect(
        fs.access(path.join(root, ".lcx", "identity-migration.complete.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("returns a rollback receipt when audit persistence fails", async () => {
    await withTempRoot(async (root) => {
      const failingAuditPath = path.join(root, "audit-directory");
      await fs.mkdir(failingAuditPath);
      const contract = createLcxIdentityWriterPathContract({
        writer: "audit",
        migrationPlan: migrationPlan(root),
        readPath: path.join(root, ".openclaw", "audit.json"),
        writePath: path.join(root, ".lcx", "audit.json"),
        auditPath: failingAuditPath,
      });

      const receipt = await writeLcxIdentityWriterRawWithReceipt(contract, '{"ok":true}\n');
      expect(receipt.audit.status).toBe("failed");
      expect(await fs.readFile(contract.writePath, "utf8")).toBe('{"ok":true}\n');

      await rollbackLcxIdentityWriter(receipt);
      await expect(fs.access(contract.writePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

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

  it("keeps the active legacy writer read when a stale canonical target exists", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(
        root,
        ".openclaw",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const canonicalPath = path.join(root, ".lcx", "agents", "main", "sessions", "sessions.json");
      await writeRaw(legacyPath, '{"source":"legacy"}\n');
      const plan = migrationPlan(root);
      await writeRaw(canonicalPath, '{"source":"stale-canonical"}\n');
      const contract = resolveLcxIdentityStateWriterPathContract({
        writer: "sessions",
        migrationPlan: plan,
        relativePath: path.join("agents", "main", "sessions", "sessions.json"),
      });

      expect(contract.readPath).toBe(legacyPath);
      expect(contract.writePath).toBe(canonicalPath);
      expect(() => assertLcxIdentityWriterPathContract(contract)).toThrow(/split state/i);
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

  it("refuses a second legacy write while the canonical target is already populated", async () => {
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
      await expect(
        saveSessionStore(
          legacyStorePath,
          { "agent:main": { sessionId: "s-4", updatedAt: 2 } },
          { skipMaintenance: true, identityMigration: migration },
        ),
      ).rejects.toMatchObject({ code: "LCX_IDENTITY_SPLIT_STATE" });
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
      const receipt = await writeSessionStoreForIdentityMigration(migration, {});
      await writeRaw(canonicalStorePath, "external\n");
      await expect(rollbackSessionStoreIdentityMigration(receipt)).rejects.toMatchObject({
        code: "LCX_IDENTITY_ROLLBACK_TARGET_MISMATCH",
      });
    });
  });
});
