import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createConfigIO,
  createLcxIdentityMigrationConfigIO,
  type ConfigWriteReceipt,
} from "./io.js";
import { resolveLcxIdentityMigrationPlan } from "./paths.js";

const silentLogger = {
  warn: () => {},
  error: () => {},
};

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-config-migration-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<string> {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw, "utf8");
  return raw;
}

function migrationIo(root: string, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) {
  return createLcxIdentityMigrationConfigIO({
    env,
    homedir: () => root,
    logger: silentLogger,
  });
}

async function readAuditLines(receipt: ConfigWriteReceipt): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(receipt.pathContract.auditPath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("LCX identity migration config I/O", () => {
  it("keeps canonical read/write paths, backup, audit, and rollback coherent", async () => {
    await withTempRoot(async (root) => {
      const canonicalPath = path.join(root, ".lcx", "lcx.json");
      const originalRaw = await writeJson(canonicalPath, { gateway: { mode: "local" } });
      const io = migrationIo(root);

      expect(io.configPath).toBe(canonicalPath);
      expect(io.writeConfigPath).toBe(canonicalPath);
      expect(io.pathContract).toMatchObject({
        readPath: canonicalPath,
        writePath: canonicalPath,
        backupPath: `${canonicalPath}.bak`,
        auditPath: path.join(root, ".lcx", "logs", "config-audit.jsonl"),
        expectedReadPath: canonicalPath,
        expectedWritePath: canonicalPath,
        rollbackPath: `${canonicalPath}.bak`,
        noSplitState: "single-write-target",
      });

      const receipt = await io.writeConfigFileWithReceipt({
        gateway: { mode: "local", bind: "loopback" },
      });

      expect(receipt.previous.exists).toBe(true);
      expect(receipt.rollback.strategy).toBe("restore-backup");
      expect(await fs.readFile(`${canonicalPath}.bak`, "utf8")).toBe(originalRaw);
      const writeAudit = (await readAuditLines(receipt)).at(-1);
      expect(writeAudit).toMatchObject({
        event: "config.write",
        readConfigPath: canonicalPath,
        writeConfigPath: canonicalPath,
        backupPath: `${canonicalPath}.bak`,
        auditPath: receipt.pathContract.auditPath,
        rollbackPath: `${canonicalPath}.bak`,
        noSplitState: "single-write-target",
      });

      await io.rollbackConfigFileWrite(receipt);

      expect(await fs.readFile(canonicalPath, "utf8")).toBe(originalRaw);
      const rollbackAudit = (await readAuditLines(receipt)).at(-1);
      expect(rollbackAudit).toMatchObject({
        event: "config.rollback",
        result: "restored",
        expectedNextHash: receipt.next.hash,
        restoredHash: receipt.previous.hash,
      });
    });
  });

  it("reads legacy config, writes only the canonical target, and removes that target on rollback", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(root, ".openclaw", "openclaw.json");
      const canonicalPath = path.join(root, ".lcx", "lcx.json");
      const legacyRaw = await writeJson(legacyPath, { gateway: { mode: "local" } });
      const io = migrationIo(root);
      const context = await io.readConfigFileSnapshotForWrite();

      expect(context.snapshot.path).toBe(legacyPath);
      expect(context.snapshot.config.gateway?.mode).toBe("local");
      expect(context.writeOptions.expectedReadPath).toBe(legacyPath);
      expect(context.writeOptions.expectedWritePath).toBe(canonicalPath);
      expect(io.pathContract.readPath).toBe(legacyPath);
      expect(io.pathContract.writePath).toBe(canonicalPath);

      const receipt = await io.writeConfigFileWithReceipt(
        { gateway: { mode: "local", bind: "loopback" } },
        context.writeOptions,
      );

      expect(receipt.previous.exists).toBe(false);
      expect(receipt.rollback.strategy).toBe("remove-written-target");
      expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyRaw);
      expect(JSON.parse(await fs.readFile(canonicalPath, "utf8"))).toMatchObject({
        gateway: { mode: "local", bind: "loopback" },
      });
      expect(io.configPath).toBe(canonicalPath);
      expect(receipt.pathContract.auditPath).toBe(
        path.join(root, ".lcx", "logs", "config-audit.jsonl"),
      );
      expect((await readAuditLines(receipt)).at(-1)).toMatchObject({
        event: "config.write",
        readConfigPath: legacyPath,
        writeConfigPath: canonicalPath,
        existsBefore: false,
      });

      await io.rollbackConfigFileWrite(receipt);

      await expect(fs.access(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyRaw);
      expect((await readAuditLines(receipt)).at(-1)).toMatchObject({
        event: "config.rollback",
        result: "removed",
      });
    });
  });

  it("keeps explicit state and config overrides as the sole read/write authority", async () => {
    await withTempRoot(async (root) => {
      const overrideDir = path.join(root, "operator-state");
      const overridePath = path.join(overrideDir, "openclaw.json");
      const env = {
        OPENCLAW_STATE_DIR: overrideDir,
        OPENCLAW_CONFIG_PATH: overridePath,
      } as NodeJS.ProcessEnv;
      const io = migrationIo(root, env);

      expect(io.pathContract.migrationPlan?.mode).toBe("explicit-config-override");
      expect(io.configPath).toBe(overridePath);
      expect(io.writeConfigPath).toBe(overridePath);

      await io.writeConfigFileWithReceipt({ gateway: { mode: "local" } });

      expect(JSON.parse(await fs.readFile(overridePath, "utf8"))).toMatchObject({
        gateway: { mode: "local" },
      });
      expect(io.pathContract.auditPath).toBe(path.join(overrideDir, "logs", "config-audit.jsonl"));
      await expect(fs.access(path.join(root, ".lcx"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("fails closed when a stale migration plan would write into split state", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(root, ".openclaw", "openclaw.json");
      const canonicalPath = path.join(root, ".lcx", "lcx.json");
      await writeJson(legacyPath, { gateway: { mode: "local" } });
      const plan = resolveLcxIdentityMigrationPlan({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
        existsSync: nodeFs.existsSync,
      });
      await writeJson(canonicalPath, { gateway: { mode: "local", bind: "loopback" } });
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
        lcxIdentityMigrationPlan: plan,
        logger: silentLogger,
      });

      await expect(
        io.writeConfigFileWithReceipt({ gateway: { mode: "local" } }),
      ).rejects.toMatchObject({ code: "CONFIG_SPLIT_STATE" });
      expect(JSON.parse(await fs.readFile(canonicalPath, "utf8"))).toMatchObject({
        gateway: { bind: "loopback" },
      });
    });
  });

  it("enforces expected read/write paths and refuses rollback after an external change", async () => {
    await withTempRoot(async (root) => {
      const legacyPath = path.join(root, ".openclaw", "openclaw.json");
      const canonicalPath = path.join(root, ".lcx", "lcx.json");
      await writeJson(legacyPath, { gateway: { mode: "local" } });
      const io = migrationIo(root);
      const context = await io.readConfigFileSnapshotForWrite();

      await expect(
        io.writeConfigFileWithReceipt(
          { gateway: { mode: "local" } },
          { ...context.writeOptions, expectedReadPath: path.join(root, "wrong-read.json") },
        ),
      ).rejects.toMatchObject({ code: "CONFIG_READ_PATH_MISMATCH" });
      await expect(
        io.writeConfigFileWithReceipt(
          { gateway: { mode: "local" } },
          { ...context.writeOptions, expectedWritePath: path.join(root, "wrong-write.json") },
        ),
      ).rejects.toMatchObject({ code: "CONFIG_WRITE_PATH_MISMATCH" });
      await expect(fs.access(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });

      const receipt = await io.writeConfigFileWithReceipt(
        { gateway: { mode: "local", bind: "loopback" } },
        context.writeOptions,
      );
      await fs.writeFile(canonicalPath, '{"gateway":{"mode":"remote"}}\n', "utf8");
      await expect(io.rollbackConfigFileWrite(receipt)).rejects.toMatchObject({
        code: "CONFIG_ROLLBACK_TARGET_MISMATCH",
      });
    });
  });
});
