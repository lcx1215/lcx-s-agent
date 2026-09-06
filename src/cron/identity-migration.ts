import path from "node:path";
import JSON5 from "json5";
import {
  readLcxIdentityWriterRaw,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../config/identity-migration.js";
import type { LcxIdentityMigrationPlan } from "../config/paths.js";
import type { CronRunLogEntry } from "./run-log.js";
import type { CronStoreFile } from "./types.js";

export type LcxIdentityCronStoreMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "cron" }>;
  relativePath: string;
  readStorePath: string;
  writeStorePath: string;
}>;

export function createLcxIdentityCronStoreMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityCronStoreMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Cron identity migration requires a state-root authority");
  }
  const relativePath = path.join("cron", "jobs.json");
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "cron",
    migrationPlan: params.migrationPlan,
    relativePath,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    relativePath,
    readStorePath: pathContract.readPath,
    writeStorePath: pathContract.writePath,
  });
}

export function resolveCurrentCronStoreIdentityPathContract(
  migration: LcxIdentityCronStoreMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "cron" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "cron",
    migrationPlan: plan,
    relativePath: migration.relativePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export async function readCronStoreForIdentityMigration(
  migration: LcxIdentityCronStoreMigration,
): Promise<CronStoreFile> {
  const raw = await readLcxIdentityWriterRaw(
    resolveCurrentCronStoreIdentityPathContract(migration),
  );
  if (raw === null) {
    return { version: 1, jobs: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse migrated cron store at ${migration.readStorePath}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { version: 1, jobs: [] };
  }
  const record = parsed as Record<string, unknown>;
  return {
    version: 1,
    jobs: Array.isArray(record.jobs) ? (record.jobs as CronStoreFile["jobs"]) : [],
  };
}

export async function writeCronStoreForIdentityMigration(
  migration: LcxIdentityCronStoreMigration,
  store: CronStoreFile,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const pathContract = resolveCurrentCronStoreIdentityPathContract(migration);
  return await writeLcxIdentityWriterRawWithReceipt(
    pathContract,
    `${JSON.stringify(store, null, 2)}\n`,
    options,
  );
}

export async function rollbackCronStoreIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export type LcxIdentityCronRunLogMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "audit" }>;
  relativePath: string;
  readLogPath: string;
  writeLogPath: string;
}>;

export function createLcxIdentityCronRunLogMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  jobId: string;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityCronRunLogMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Cron run-log migration requires a state-root authority");
  }
  const safeJobId = params.jobId.trim();
  if (
    !safeJobId ||
    safeJobId.includes("/") ||
    safeJobId.includes("\\") ||
    safeJobId.includes("\0")
  ) {
    throw new Error("invalid cron run log job id");
  }
  const relativePath = path.join("cron", "runs", `${safeJobId}.jsonl`);
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "audit",
    migrationPlan: params.migrationPlan,
    relativePath,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    relativePath,
    readLogPath: pathContract.readPath,
    writeLogPath: pathContract.writePath,
  });
}

export function resolveCurrentCronRunLogIdentityPathContract(
  migration: LcxIdentityCronRunLogMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "audit" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "audit",
    migrationPlan: plan,
    relativePath: migration.relativePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export async function appendCronRunLogForIdentityMigration(
  migration: LcxIdentityCronRunLogMigration,
  entry: CronRunLogEntry,
): Promise<LcxIdentityWriteReceipt> {
  const pathContract = resolveCurrentCronRunLogIdentityPathContract(migration);
  const previousRaw = await readLcxIdentityWriterRaw(pathContract);
  const raw = `${previousRaw ?? ""}${JSON.stringify(entry)}\n`;
  return await writeLcxIdentityWriterRawWithReceipt(pathContract, raw);
}

export async function rollbackCronRunLogIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
