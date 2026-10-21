import crypto from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLcxIdentityCronStoreMigration,
  readCronStoreForIdentityMigration,
  writeCronStoreForIdentityMigration,
} from "../cron/identity-migration.js";
import {
  createLcxIdentityMigrationTarget,
  createLcxIdentityWriterPathContract,
  LCX_IDENTITY_WRITER_NAMES,
  moveLcxIdentityPathWithReceipt,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityMigrationCompletionMarker as publishCompletion,
  type LcxIdentityMigrationQuiescence,
  writeLcxIdentityWriterRawWithReceipt,
} from "./identity-migration.js";
import { createLcxIdentityMigrationConfigIO } from "./io.js";
import {
  isLcxIdentityMigrationComplete,
  resolveLcxIdentityMigrationPlan,
  resolveStateDir,
} from "./paths.js";
import {
  appendSessionTranscriptForIdentityMigration,
  createLcxIdentitySessionMigration,
  readSessionStoreForIdentityMigration,
  rollbackSessionStoreIdentityMigration,
  writeSessionStoreForIdentityMigration,
} from "./sessions/identity-migration.js";
import { saveSessionStore } from "./sessions/store.js";

// This scope contains only temp fixture roots and no external writer/process.
const offlineQuiescence: LcxIdentityMigrationQuiescence = async (_scope, publish) => {
  let held = true;
  try {
    return await publish({
      owner: "offline-fixture",
      assertHeld: () => {
        if (!held) {
          throw new Error("fixture lease lost");
        }
      },
    });
  } finally {
    held = false;
  }
};
function writeLcxIdentityMigrationCompletionMarker(
  params: Parameters<typeof publishCompletion>[0],
) {
  return publishCompletion({ withLegacyWritesQuiesced: offlineQuiescence, ...params });
}

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

function sourceReceipt(pathContract: { readPath: string }, raw: string | null) {
  return {
    path: pathContract.readPath,
    exists: raw !== null,
    hash: raw === null ? null : crypto.createHash("sha256").update(raw).digest("hex"),
    bytes: raw === null ? null : Buffer.byteLength(raw, "utf8"),
  };
}

function migrationPlan(root: string) {
  return resolveLcxIdentityMigrationPlan({
    env: {} as NodeJS.ProcessEnv,
    homedir: () => root,
    existsSync: nodeFs.existsSync,
  });
}

async function rawMigrationFixture(root: string) {
  const plan = migrationPlan(root);
  const receipts = await Promise.all(
    LCX_IDENTITY_WRITER_NAMES.map(async (writer) => {
      const contract = createLcxIdentityWriterPathContract({
        writer,
        migrationPlan: plan,
        readPath: path.join(root, ".openclaw", `${writer}.state`),
        writePath: path.join(root, ".lcx", `${writer}.state`),
      });
      await writeRaw(contract.readPath, `${writer}: source`);
      return writeLcxIdentityWriterRawWithReceipt(contract, `${writer}: source`);
    }),
  );
  return {
    plan,
    receipts,
    requiredTargets: receipts.map(({ pathContract }) =>
      createLcxIdentityMigrationTarget(pathContract),
    ),
  };
}

describe("LCX identity migration writer contract", () => {
  it("activates the canonical root after genuine receipts cover the registered inventory", async () => {
    await withTempRoot(async (root) => {
      const legacyStateDir = path.join(root, ".openclaw");
      await writeRaw(path.join(legacyStateDir, "openclaw.json"), "{}\n");
      const plan = migrationPlan(root);
      const writerReceipts = await Promise.all(
        LCX_IDENTITY_WRITER_NAMES.map(async (writer) => {
          const readName = writer === "config" ? "openclaw.json" : `${writer}.state`;
          const writeName = writer === "config" ? "lcx.json" : `${writer}.state`;
          const readPath = path.join(legacyStateDir, readName);
          const raw = writer === "config" ? "{}\n" : `${writer}: legacy state\n`;
          await writeRaw(readPath, raw);
          return writeLcxIdentityWriterRawWithReceipt(
            createLcxIdentityWriterPathContract({
              writer,
              migrationPlan: plan,
              readPath,
              writePath: path.join(plan.canonicalStateDir, writeName),
            }),
            raw,
          );
        }),
      );
      expect(resolveStateDir({}, () => root)).toBe(legacyStateDir);
      // A complete family list must not hide another concrete object in that family.
      const extraSource = path.join(legacyStateDir, "agents", "second", "sessions", "keep.jsonl");
      await writeRaw(extraSource, "second agent history\n");
      await expect(
        writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: plan,
          requiredTargets: writerReceipts.map(({ pathContract }) =>
            createLcxIdentityMigrationTarget(pathContract),
          ),
          writerReceipts,
        }),
      ).rejects.toMatchObject({ code: "LCX_IDENTITY_COMPLETION_SOURCE_UNCOVERED" });
      expect(isLcxIdentityMigrationComplete({ env: {}, homedir: () => root })).toBe(false);
      expect(resolveStateDir({}, () => root)).toBe(legacyStateDir);
      writerReceipts.push(
        await writeLcxIdentityWriterRawWithReceipt(
          createLcxIdentityWriterPathContract({
            writer: "sessions",
            migrationPlan: plan,
            readPath: extraSource,
            writePath: path.join(
              plan.canonicalStateDir,
              "agents",
              "second",
              "sessions",
              "keep.jsonl",
            ),
          }),
          "second agent history\n",
        ),
      );
      const marker = await writeLcxIdentityMigrationCompletionMarker({
        migrationPlan: plan,
        requiredTargets: writerReceipts.map(({ pathContract }) =>
          createLcxIdentityMigrationTarget(pathContract),
        ),
        writerReceipts,
      });
      expect(marker.targetKeys).toHaveLength(LCX_IDENTITY_WRITER_NAMES.length + 1);
      const covered = marker.sourceInventory.sources.find(
        (entry) => entry.readPath === extraSource,
      );
      expect(covered).toMatchObject({
        readPath: extraSource,
        targetKey: "agents/second/sessions/keep.jsonl",
        contentHash: crypto.createHash("sha256").update("second agent history\n").digest("hex"),
        bytes: Buffer.byteLength("second agent history\n"),
      });
      expect(covered?.identity).toMatch(new RegExp(`:${covered?.contentHash}$`));
      const persisted = JSON.parse(
        await fs.readFile(
          path.join(plan.canonicalStateDir, "identity-migration.complete.json"),
          "utf8",
        ),
      ) as typeof marker;
      expect(persisted.sourceInventory.sources).toContainEqual(covered);
      expect(isLcxIdentityMigrationComplete({ env: {}, homedir: () => root })).toBe(true);
      expect(resolveStateDir({}, () => root)).toBe(plan.canonicalStateDir);
    });
  });

  it.each([
    {
      name: "cron entries preserved before an appended job",
      writer: "cron",
      source: "{version:1,jobs:[{id:'keep',schedule:{kind:'cron',expr:'0 9 * * 1-5'}}]}",
      next: '{"version":1,"jobs":[{"id":"keep","schedule":{"kind":"cron","expr":"0 9 * * 1-5"}},{"id":"new"}]}',
      accepted: true,
    },
    {
      name: "an appended job cannot replace the original cron entry",
      writer: "cron",
      source: "{version:1,jobs:[{id:'keep'}]}",
      next: '{"version":1,"jobs":[{"id":"changed"},{"id":"new"}]}',
      accepted: false,
    },
    {
      name: "unrelated raw replacement",
      writer: "config",
      source: "legacy-source\n",
      next: "x",
      accepted: false,
    },
    {
      name: "config normalization and version stamp",
      writer: "config",
      source: "{gateway: {mode: 'local'}, meta: {custom: 'keep'}}",
      next: JSON.stringify({
        meta: {
          custom: "keep",
          lastTouchedAt: "2026-10-20T00:00:00.000Z",
          lastTouchedVersion: "1.0",
        },
        gateway: { mode: "local" },
      }),
      accepted: true,
    },
    {
      name: "preserved session entries with a new entry",
      writer: "sessions",
      source: '{"old":{"sessionId":"keep","updatedAt":1}}',
      next: '{"new":{"sessionId":"new"},"old":{"updatedAt":1,"sessionId":"keep"}}',
      accepted: true,
    },
    {
      name: "discarded session entry",
      writer: "sessions",
      source: '{"old":{"sessionId":"keep","updatedAt":1}}',
      next: '{"new":{"sessionId":"new"}}',
      accepted: false,
    },
    {
      name: "session transcript append",
      writer: "sessions",
      source: '{"type":"session","version":3,"id":"keep"}\n{"type":"message","id":"old"}\n',
      next: '{"type":"session","version":3,"id":"keep"}\n{"type":"message","id":"old"}\n{"type":"message","id":"new"}\n',
      accepted: true,
    },
  ] as const)(
    "binds completion to source preservation: $name",
    async ({ writer: testedWriter, source, next, accepted }) => {
      await withTempRoot(async (root) => {
        const plan = migrationPlan(root);
        const receipts = await Promise.all(
          LCX_IDENTITY_WRITER_NAMES.map(async (writer) => {
            const contract = createLcxIdentityWriterPathContract({
              writer,
              migrationPlan: plan,
              readPath: path.join(root, ".openclaw", `${writer}.state`),
              writePath: path.join(root, ".lcx", `${writer}.state`),
            });
            const oldRaw = writer === testedWriter ? source : `${writer}: legacy\n`;
            await writeRaw(contract.readPath, oldRaw);
            return await writeLcxIdentityWriterRawWithReceipt(
              contract,
              writer === testedWriter ? next : oldRaw,
            );
          }),
        );
        const complete = () =>
          writeLcxIdentityMigrationCompletionMarker({
            migrationPlan: plan,
            requiredTargets: receipts.map(({ pathContract }) =>
              createLcxIdentityMigrationTarget(pathContract),
            ),
            writerReceipts: receipts,
          });
        if (accepted) {
          await expect(complete()).resolves.toMatchObject({ schemaVersion: 2 });
        } else {
          await expect(complete()).rejects.toMatchObject({
            code: "LCX_IDENTITY_COMPLETION_SOURCE_UNPRESERVED",
          });
          await expect(
            fs.access(path.join(root, ".lcx", "identity-migration.complete.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const receipt = receipts.find((entry) => entry.pathContract.writer === testedWriter)!;
          expect(await fs.readFile(receipt.pathContract.writePath, "utf8")).toBe(next);
          await rollbackLcxIdentityWriter(receipt);
          expect(await fs.readFile(receipt.pathContract.readPath, "utf8")).toBe(source);
        }
      });
    },
  );

  it("writes a canonical completion marker atomically", async () => {
    await withTempRoot(async (root) => {
      const plan = migrationPlan(root);
      const raw = "x";
      const nextHash = crypto.createHash("sha256").update(raw).digest("hex");
      const writerReceipts = await Promise.all(
        LCX_IDENTITY_WRITER_NAMES.map(async (writer) => {
          const pathContract = createLcxIdentityWriterPathContract({
            writer,
            migrationPlan: plan,
            readPath: path.join(root, ".openclaw", `${writer}.state`),
            writePath: path.join(root, ".lcx", `${writer}.state`),
          });
          if (writer === "config") {
            await writeRaw(pathContract.readPath, raw);
          }
          await writeRaw(pathContract.writePath, raw);
          return {
            pathContract,
            source: sourceReceipt(pathContract, writer === "config" ? raw : null),
            previous: { exists: false, hash: null, bytes: null },
            next: { hash: nextHash, bytes: Buffer.byteLength(raw, "utf8") },
            rollback: {
              path: pathContract.rollbackPath,
              strategy: "remove-written-target" as const,
            },
            audit: { status: "written" as const },
          };
        }),
      );
      const marker = await writeLcxIdentityMigrationCompletionMarker({
        migrationPlan: plan,
        requiredTargets: writerReceipts.map(({ pathContract }) =>
          createLcxIdentityMigrationTarget(pathContract),
        ),
        writerReceipts,
        now: () => "2026-09-06T00:00:00.000Z",
      });

      expect(marker).toMatchObject({
        schemaVersion: 2,
        canonicalStateDir: path.join(root, ".lcx"),
        completedAt: "2026-09-06T00:00:00.000Z",
        inventory: "lcx-identity-writer-inventory-v2",
      });
      expect(marker.targetKeys).toHaveLength(LCX_IDENTITY_WRITER_NAMES.length);
      expect(
        JSON.parse(
          await fs.readFile(path.join(root, ".lcx", "identity-migration.complete.json"), "utf8"),
        ),
      ).toEqual(marker);
    });
  });

  it("accepts config adapter and path-move receipts in the complete manifest", async () => {
    await withTempRoot(async (root) => {
      // Session path containment resolves the macOS temporary-directory symlink.
      root = await fs.realpath(root);
      const plan = migrationPlan(root);
      const raw = "adapter-receipt\n";
      const receipts = [];
      for (const writer of LCX_IDENTITY_WRITER_NAMES) {
        const pathContract = createLcxIdentityWriterPathContract({
          writer,
          migrationPlan: plan,
          readPath: path.join(root, ".openclaw", `${writer}.state`),
          writePath: path.join(root, ".lcx", `${writer}.state`),
        });
        if (writer === "workspace") {
          await writeRaw(path.join(pathContract.readPath, "original.txt"), raw);
          receipts.push(await moveLcxIdentityPathWithReceipt(pathContract));
          continue;
        }
        if (writer === "config") {
          await writeRaw(
            path.join(root, ".openclaw", "openclaw.json"),
            "{gateway: {mode: 'local'}}",
          );
          const io = createLcxIdentityMigrationConfigIO({
            env: {},
            homedir: () => root,
            logger: { warn: () => {}, error: () => {} },
          });
          receipts.push(
            await io.writeConfigFileWithReceipt({ gateway: { mode: "local", bind: "loopback" } }),
          );
          continue;
        }
        if (writer === "sessions") {
          const migration = createLcxIdentitySessionMigration({ migrationPlan: plan });
          await writeRaw(
            path.join(migration.readSessionsDir, "upgrade.jsonl"),
            '{"type":"session","version":1,"id":"upgrade","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/tmp"}\n' +
              '{"type":"message","message":{"role":"hookMessage","content":"keep"},"timestamp":"2026-09-04T00:00:01.000Z"}\n',
          );
          const { receipt } = await appendSessionTranscriptForIdentityMigration({
            migration,
            sessionId: "upgrade",
            text: "new message",
          });
          receipts.push(receipt);
          continue;
        }
        if (writer === "cron") {
          await writeRaw(
            path.join(root, ".openclaw", "cron", "jobs.json"),
            "{version: 1, jobs: [{id: 'keep-scheduled-job'},], // original cron JSON5\n}",
          );
          const migration = createLcxIdentityCronStoreMigration({ migrationPlan: plan });
          expect(migration.readStorePath).not.toBe(migration.writeStorePath);
          const store = await readCronStoreForIdentityMigration(migration);
          receipts.push(await writeCronStoreForIdentityMigration(migration, store));
          continue;
        }
        receipts.push(await writeLcxIdentityWriterRawWithReceipt(pathContract, raw));
      }

      const movedSource = receipts.find((receipt) => receipt.pathContract.writer === "workspace")!
        .pathContract.readPath;
      await writeRaw(path.join(movedSource, "new.txt"), "not covered by the old move\n");
      await expect(
        writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: plan,
          requiredTargets: receipts.map(({ pathContract }) =>
            createLcxIdentityMigrationTarget(pathContract),
          ),
          writerReceipts: receipts,
        }),
      ).rejects.toMatchObject({ code: "LCX_IDENTITY_COMPLETION_SOURCE_UNCOVERED" });
      await fs.rm(movedSource, { recursive: true });
      await expect(
        writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: plan,
          requiredTargets: receipts.map(({ pathContract }) =>
            createLcxIdentityMigrationTarget(pathContract),
          ),
          writerReceipts: receipts,
        }),
      ).resolves.toMatchObject({ schemaVersion: 2 });
    });
  });

  it.each([
    "deleted",
    "replaced",
    "modified",
    "extra-file",
    "extra-directory",
    "missing-inventory",
  ] as const)(
    "rejects %s moved-directory contents even after the legacy source disappears",
    async (mutation) => {
      await withTempRoot(async (root) => {
        const plan = migrationPlan(root);
        const receipts = await Promise.all(
          LCX_IDENTITY_WRITER_NAMES.map(async (writer) => {
            const contract = createLcxIdentityWriterPathContract({
              writer,
              migrationPlan: plan,
              readPath: path.join(root, ".openclaw", `${writer}.state`),
              writePath: path.join(root, ".lcx", `${writer}.state`),
            });
            if (writer === "workspace") {
              await writeRaw(
                path.join(contract.readPath, "nested", "original.bin"),
                "original contents",
              );
              await fs.mkdir(path.join(contract.readPath, "empty"));
              return moveLcxIdentityPathWithReceipt(contract);
            }
            return writeLcxIdentityWriterRawWithReceipt(contract, `${writer} state`);
          }),
        );
        const moved = receipts.find((receipt) => receipt.pathContract.writer === "workspace")!;
        const target = path.join(moved.pathContract.writePath, "nested", "original.bin");
        const auditRecords = (await fs.readFile(moved.pathContract.auditPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(
          auditRecords.find((record) => record.event === "identity.move")?.contentInventory,
        ).toEqual("contentInventory" in moved ? moved.contentInventory : undefined);
        await expect(fs.access(moved.pathContract.readPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect("contentInventory" in moved && moved.contentInventory?.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              relativePath: "nested/original.bin",
              kind: "file",
              contentHash: crypto.createHash("sha256").update("original contents").digest("hex"),
            }),
            expect.objectContaining({ relativePath: "empty", kind: "directory" }),
          ]),
        );
        if (mutation === "deleted") {
          await fs.unlink(target);
        } else if (mutation === "replaced") {
          // Allocate a different inode while the original still exists, retaining identical bytes.
          await writeRaw(`${target}.replacement`, "original contents");
          await fs.rename(`${target}.replacement`, target);
        } else if (mutation === "modified") {
          await fs.writeFile(target, "modified contents");
        } else if (mutation === "extra-file") {
          await writeRaw(path.join(moved.pathContract.writePath, "extra.txt"), "unverified");
        } else if (mutation === "extra-directory") {
          await fs.mkdir(path.join(moved.pathContract.writePath, "extra-empty"));
        }
        // Exercise the durable JSON receipt shape rather than process-local identity.
        const durable = JSON.parse(JSON.stringify(receipts)) as typeof receipts;
        if (mutation === "missing-inventory") {
          const old = durable.find((receipt) => "contentInventory" in receipt)!;
          delete (old as { contentInventory?: unknown }).contentInventory;
        }
        await expect(
          writeLcxIdentityMigrationCompletionMarker({
            migrationPlan: plan,
            requiredTargets: durable.map(({ pathContract }) =>
              createLcxIdentityMigrationTarget(pathContract),
            ),
            writerReceipts: durable,
          }),
        ).rejects.toMatchObject({
          code: mutation.startsWith("extra-")
            ? "LCX_IDENTITY_COMPLETION_SOURCE_UNCOVERED"
            : mutation === "missing-inventory"
              ? "LCX_IDENTITY_COMPLETION_RECEIPT_MALFORMED"
              : "LCX_IDENTITY_COMPLETION_RECEIPT_STALE",
        });
        await expect(
          fs.access(path.join(plan.canonicalStateDir, "identity-migration.complete.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("allows only separately receipted preservation additions to an unchanged moved tree", async () => {
    await withTempRoot(async (root) => {
      const plan = migrationPlan(root);
      const receipts = await Promise.all(
        LCX_IDENTITY_WRITER_NAMES.map(async (writer) => {
          const contract = createLcxIdentityWriterPathContract({
            writer,
            migrationPlan: plan,
            readPath: path.join(root, ".openclaw", `${writer}.state`),
            writePath: path.join(root, ".lcx", `${writer}.state`),
          });
          if (writer === "workspace") {
            await writeRaw(path.join(contract.readPath, "original.txt"), "keep");
            return moveLcxIdentityPathWithReceipt(contract);
          }
          return writeLcxIdentityWriterRawWithReceipt(contract, `${writer} state`);
        }),
      );
      const move = receipts.find((receipt) => receipt.pathContract.writer === "workspace")!;
      const addition = createLcxIdentityWriterPathContract({
        writer: "workspace",
        migrationPlan: plan,
        readPath: path.join(root, ".openclaw", "preserved-addition.json"),
        writePath: path.join(move.pathContract.writePath, "new-dir", "preserved-addition.json"),
      });
      await writeRaw(addition.readPath, '{"preserved":true}');
      receipts.push(
        await writeLcxIdentityWriterRawWithReceipt(addition, '{"preserved":true,"added":1}'),
      );
      await expect(
        writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: plan,
          requiredTargets: receipts.map(({ pathContract }) =>
            createLcxIdentityMigrationTarget(pathContract),
          ),
          writerReceipts: receipts,
        }),
      ).resolves.toMatchObject({ schemaVersion: 2 });
      expect(
        await fs.readFile(path.join(move.pathContract.writePath, "original.txt"), "utf8"),
      ).toBe("keep");
    });
  });

  it("rejects a symlink inside a move before renaming any source", async () => {
    await withTempRoot(async (root) => {
      const contract = createLcxIdentityWriterPathContract({
        writer: "workspace",
        migrationPlan: migrationPlan(root),
        readPath: path.join(root, ".openclaw", "workspace"),
        writePath: path.join(root, ".lcx", "workspace"),
      });
      await writeRaw(path.join(contract.readPath, "original.txt"), "keep");
      await fs.mkdir(path.join(contract.readPath, "original-dir"));
      await fs.symlink(
        path.join(contract.readPath, "original-dir"),
        path.join(contract.readPath, "link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(moveLcxIdentityPathWithReceipt(contract)).rejects.toMatchObject({
        code: "LCX_IDENTITY_MOVE_INVENTORY_UNSUPPORTED",
      });
      expect(await fs.readFile(path.join(contract.readPath, "original.txt"), "utf8")).toBe("keep");
      await expect(fs.access(contract.writePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["canonical-mirrors", "outside-root", "nested-link", "dangling-root"] as const)(
    "validates legacy links: %s",
    async (kind) => {
      await withTempRoot(async (root) => {
        const { plan, receipts, requiredTargets } = await rawMigrationFixture(root);
        const linkType = process.platform === "win32" ? "junction" : "dir";
        if (kind === "canonical-mirrors") {
          for (const legacy of [".clawdbot", ".moltbot"]) {
            await fs.symlink(plan.canonicalStateDir, path.join(root, legacy), linkType);
          }
        } else if (kind === "outside-root") {
          const outside = path.join(root, "outside");
          await fs.mkdir(outside);
          await fs.symlink(outside, path.join(root, ".moltbot"), linkType);
        } else {
          await fs.symlink(
            plan.canonicalStateDir,
            path.join(root, ".openclaw", "nested-link"),
            linkType,
          );
        }
        const completion = writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: plan,
          requiredTargets,
          writerReceipts: receipts,
        });
        if (kind === "canonical-mirrors") {
          await expect(completion).resolves.toMatchObject({ schemaVersion: 2 });
        } else {
          await expect(completion).rejects.toMatchObject({
            code: "LCX_IDENTITY_COMPLETION_SOURCE_UNSUPPORTED",
          });
        }
      });
    },
  );

  it("fails closed without a maintenance quiescence owner", async () => {
    await withTempRoot(async (root) => {
      const { plan, receipts, requiredTargets } = await rawMigrationFixture(root);
      await expect(
        publishCompletion({ migrationPlan: plan, requiredTargets, writerReceipts: receipts }),
      ).rejects.toMatchObject({ code: "LCX_IDENTITY_COMPLETION_QUIESCENCE_REQUIRED" });
      await expect(
        fs.access(path.join(plan.canonicalStateDir, "identity-migration.complete.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses publication if the held lease is revoked while the temporary marker is written", async () => {
    await withTempRoot(async (root) => {
      const { plan, receipts, requiredTargets } = await rawMigrationFixture(root);
      let held = true;
      const writeFile = fs.writeFile.bind(fs);
      const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await writeFile(...args);
        if (typeof args[0] === "string" && args[0].includes("identity-migration.complete.json.")) {
          held = false;
        }
      });
      try {
        await expect(
          publishCompletion({
            migrationPlan: plan,
            requiredTargets,
            writerReceipts: receipts,
            withLegacyWritesQuiesced: async (scope, publish) => {
              expect(scope.canonicalStateDir).toBe(plan.canonicalStateDir);
              expect(scope.legacyStateDirs).toContain(path.join(root, ".openclaw"));
              return publish({
                owner: "offline-fixture",
                assertHeld: () => {
                  if (!held) {
                    throw new Error("lease revoked");
                  }
                },
              });
            },
          }),
        ).rejects.toThrow("lease revoked");
        await expect(
          fs.access(path.join(plan.canonicalStateDir, "identity-migration.complete.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("rejects an async lease check rather than publishing before its result", async () => {
    await withTempRoot(async (root) => {
      const { plan, receipts, requiredTargets } = await rawMigrationFixture(root);
      await expect(
        publishCompletion({
          migrationPlan: plan,
          requiredTargets,
          writerReceipts: receipts,
          withLegacyWritesQuiesced: async (_scope, publish) =>
            publish({
              owner: "offline-fixture",
              assertHeld: (() => Promise.resolve()) as () => void,
            }),
        }),
      ).rejects.toMatchObject({ code: "LCX_IDENTITY_COMPLETION_QUIESCENCE_REQUIRED" });
      await expect(
        fs.access(path.join(plan.canonicalStateDir, "identity-migration.complete.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("holds this owner's cooperating writes until the marker is published", async () => {
    await withTempRoot(async (root) => {
      const { plan, receipts, requiredTargets } = await rawMigrationFixture(root);
      const markerPath = path.join(plan.canonicalStateDir, "identity-migration.complete.json");
      const latePath = path.join(plan.canonicalStateDir, "late-cooperating-write");
      const contract = createLcxIdentityWriterPathContract({
        writer: "sessions",
        migrationPlan: plan,
        readPath: latePath,
        writePath: latePath,
      });
      let late: ReturnType<typeof writeLcxIdentityWriterRawWithReceipt> | undefined;
      let markerVisible = false;
      const writeFile = fs.writeFile.bind(fs);
      const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && args[0].includes("identity-migration.complete.json.")) {
          late = writeLcxIdentityWriterRawWithReceipt(contract, "new canonical write");
          await expect(fs.access(latePath)).rejects.toMatchObject({ code: "ENOENT" });
        } else if (typeof args[0] === "string" && args[0].includes(".late-cooperating-write.")) {
          await fs.access(markerPath);
          markerVisible = true;
        }
        await writeFile(...args);
      });
      try {
        await writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: plan,
          requiredTargets,
          writerReceipts: receipts,
        });
        expect(late).toBeDefined();
        await late;
        expect(markerVisible).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("refuses to activate the canonical root without every durable writer receipt", async () => {
    await withTempRoot(async (root) => {
      await expect(
        writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: migrationPlan(root),
          requiredTargets: [
            createLcxIdentityWriterPathContract({
              writer: "config",
              migrationPlan: migrationPlan(root),
              readPath: path.join(root, ".openclaw", "openclaw.json"),
              writePath: path.join(root, ".lcx", "lcx.json"),
            }),
          ].map(createLcxIdentityMigrationTarget),
          writerReceipts: [],
        }),
      ).rejects.toMatchObject({ code: "LCX_IDENTITY_COMPLETION_TARGETS_INCOMPLETE" });
      await expect(
        fs.access(path.join(root, ".lcx", "identity-migration.complete.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses canonical targets when the compatibility source is missing", async () => {
    await withTempRoot(async (root) => {
      const plan = migrationPlan(root);
      const raw = "canonical-only\n";
      const receipts = await Promise.all(
        LCX_IDENTITY_WRITER_NAMES.map(async (writer) => {
          const pathContract = createLcxIdentityWriterPathContract({
            writer,
            migrationPlan: plan,
            readPath: path.join(root, ".openclaw", `${writer}.state`),
            writePath: path.join(root, ".lcx", `${writer}.state`),
          });
          await writeRaw(pathContract.writePath, raw);
          return {
            pathContract,
            source: sourceReceipt(pathContract, null),
            previous: { exists: false, hash: null, bytes: null },
            next: {
              hash: crypto.createHash("sha256").update(raw).digest("hex"),
              bytes: Buffer.byteLength(raw, "utf8"),
            },
            rollback: {
              path: pathContract.rollbackPath,
              strategy: "remove-written-target" as const,
            },
            audit: { status: "written" as const },
          };
        }),
      );

      await expect(
        writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: plan,
          requiredTargets: receipts.map(({ pathContract }) =>
            createLcxIdentityMigrationTarget(pathContract),
          ),
          writerReceipts: receipts,
        }),
      ).rejects.toMatchObject({ code: "LCX_IDENTITY_COMPLETION_MIGRATION_UNPROVEN" });
    });
  });

  it("rejects a receipt whose declared compatibility source is unrelated to the live source", async () => {
    await withTempRoot(async (root) => {
      const plan = migrationPlan(root);
      const raw = "canonical-only\n";
      const receipts = await Promise.all(
        LCX_IDENTITY_WRITER_NAMES.map(async (writer) => {
          const pathContract = createLcxIdentityWriterPathContract({
            writer,
            migrationPlan: plan,
            readPath: path.join(root, ".openclaw", `${writer}.state`),
            writePath: path.join(root, ".lcx", `${writer}.state`),
          });
          await writeRaw(pathContract.writePath, raw);
          const source =
            writer === "config"
              ? {
                  path: pathContract.readPath,
                  exists: true,
                  hash: crypto.createHash("sha256").update(raw).digest("hex"),
                  bytes: Buffer.byteLength(raw, "utf8"),
                }
              : sourceReceipt(pathContract, null);
          if (writer === "config") {
            await writeRaw(pathContract.readPath, "unrelated-legacy-state\n");
          }
          return {
            pathContract,
            source,
            previous: { exists: false, hash: null, bytes: null },
            next: {
              hash: crypto.createHash("sha256").update(raw).digest("hex"),
              bytes: Buffer.byteLength(raw, "utf8"),
            },
            rollback: {
              path: pathContract.rollbackPath,
              strategy: "remove-written-target" as const,
            },
            audit: { status: "written" as const },
          };
        }),
      );

      await expect(
        writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: plan,
          requiredTargets: receipts.map(({ pathContract }) =>
            createLcxIdentityMigrationTarget(pathContract),
          ),
          writerReceipts: receipts,
        }),
      ).rejects.toMatchObject({ code: "LCX_IDENTITY_COMPLETION_SOURCE_STALE" });
    });
  });

  it("tracks distinct targets even when adapters share a writer family", async () => {
    await withTempRoot(async (root) => {
      const plan = migrationPlan(root);
      const raw = "credentials\n";
      const contracts = [
        ...LCX_IDENTITY_WRITER_NAMES.filter((writer) => writer !== "credentials").map((writer) =>
          createLcxIdentityWriterPathContract({
            writer,
            migrationPlan: plan,
            readPath: path.join(root, ".openclaw", `${writer}.state`),
            writePath: path.join(root, ".lcx", `${writer}.state`),
          }),
        ),
        ...["auth-profiles.json", "github-copilot.token.json"].map((filename) =>
          createLcxIdentityWriterPathContract({
            writer: "credentials",
            migrationPlan: plan,
            readPath: path.join(root, ".openclaw", "credentials", filename),
            writePath: path.join(root, ".lcx", "credentials", filename),
          }),
        ),
      ];
      const receipts = await Promise.all(
        contracts.map(async (pathContract) => {
          if (pathContract.writer === "config") {
            await writeRaw(pathContract.readPath, raw);
          }
          await writeRaw(pathContract.writePath, raw);
          return {
            pathContract,
            source: sourceReceipt(pathContract, pathContract.writer === "config" ? raw : null),
            previous: { exists: false, hash: null, bytes: null },
            next: {
              hash: crypto.createHash("sha256").update(raw).digest("hex"),
              bytes: Buffer.byteLength(raw, "utf8"),
            },
            rollback: {
              path: pathContract.rollbackPath,
              strategy: "remove-written-target" as const,
            },
            audit: { status: "written" as const },
          };
        }),
      );

      await expect(
        writeLcxIdentityMigrationCompletionMarker({
          migrationPlan: plan,
          requiredTargets: contracts.map(createLcxIdentityMigrationTarget),
          writerReceipts: receipts,
        }),
      ).resolves.toMatchObject({ schemaVersion: 2 });
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
      expect(() =>
        resolveLcxIdentityStateWriterPathContract({
          writer: "sessions",
          migrationPlan: plan,
          relativePath: path.join("agents", "main", "sessions", "sessions.json"),
        }),
      ).toThrow(/split state/i);
    });
  });

  it("rejects duplicate state across compatibility roots", async () => {
    await withTempRoot(async (root) => {
      const relativePath = path.join("agents", "main", "sessions", "sessions.json");
      await writeRaw(path.join(root, ".openclaw", relativePath), '{"source":"openclaw"}\n');
      await writeRaw(path.join(root, ".clawdbot", relativePath), '{"source":"clawdbot"}\n');
      const plan = migrationPlan(root);

      expect(() =>
        resolveLcxIdentityStateWriterPathContract({
          writer: "sessions",
          migrationPlan: plan,
          relativePath,
        }),
      ).toThrow(/multiple compatibility roots/i);
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

  it("keeps rollback snapshots immutable across follow-up writes", async () => {
    await withTempRoot(async (root) => {
      const canonicalStorePath = path.join(
        root,
        ".lcx",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const originalRaw = '{"agent:main":{"sessionId":"original"}}\n';
      await writeRaw(canonicalStorePath, originalRaw);

      const migration = createLcxIdentitySessionMigration({ migrationPlan: migrationPlan(root) });
      const first = await writeSessionStoreForIdentityMigration(migration, {
        "agent:main": { sessionId: "first", updatedAt: 1 },
      });
      const second = await writeSessionStoreForIdentityMigration(migration, {
        "agent:main": { sessionId: "second", updatedAt: 2 },
      });

      expect(second.rollback.path).not.toBe(first.rollback.path);
      await rollbackSessionStoreIdentityMigration(second);
      await rollbackSessionStoreIdentityMigration(first);
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

  it("refuses a legacy write after an external canonical replacement", async () => {
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
      await writeRaw(migration.writeStorePath, '{"source":"external"}\n');
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

  it("keeps the original legacy transcript directory after the store switches canonical", async () => {
    await withTempRoot(async (root) => {
      const legacyStorePath = path.join(
        root,
        ".openclaw",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const legacyTranscriptPath = path.join(
        root,
        ".openclaw",
        "agents",
        "main",
        "sessions",
        "s-legacy.jsonl",
      );
      const legacyRaw =
        '{"type":"session","version":1,"id":"s-legacy","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/legacy-original"}\n';
      await writeRaw(legacyStorePath, "{}\n");
      await writeRaw(legacyTranscriptPath, legacyRaw);
      const migration = createLcxIdentitySessionMigration({ migrationPlan: migrationPlan(root) });

      await writeSessionStoreForIdentityMigration(migration, {});
      const result = await appendSessionTranscriptForIdentityMigration({
        migration,
        sessionId: "s-legacy",
        text: "preserve the legacy transcript",
      });

      const canonicalRaw = await fs.readFile(result.sessionFile, "utf8");
      expect(canonicalRaw).toContain("/legacy-original");
      expect(canonicalRaw).toContain("preserve the legacy transcript");
      expect(await fs.readFile(legacyTranscriptPath, "utf8")).toBe(legacyRaw);
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
