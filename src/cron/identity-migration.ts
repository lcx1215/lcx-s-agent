import path from "node:path";
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
  readStorePath: string;
  writeStorePath: string;
}>;

export function createLcxIdentityCronStoreMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityCronStoreMigration {
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "cron",
    migrationPlan: params.migrationPlan,
    relativePath: path.join("cron", "jobs.json"),
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    readStorePath: pathContract.readPath,
    writeStorePath: pathContract.writePath,
  });
}

export async function readCronStoreForIdentityMigration(
  migration: LcxIdentityCronStoreMigration,
): Promise<CronStoreFile> {
  const raw = await readLcxIdentityWriterRaw(migration.pathContract);
  if (raw === null) {
    return { version: 1, jobs: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { version: 1, jobs: [] };
    }
    const record = parsed as Record<string, unknown>;
    return {
      version: 1,
      jobs: Array.isArray(record.jobs) ? (record.jobs as CronStoreFile["jobs"]) : [],
    };
  } catch {
    return { version: 1, jobs: [] };
  }
}

export async function writeCronStoreForIdentityMigration(
  migration: LcxIdentityCronStoreMigration,
  store: CronStoreFile,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  return await writeLcxIdentityWriterRawWithReceipt(
    migration.pathContract,
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
  readLogPath: string;
  writeLogPath: string;
}>;

export function createLcxIdentityCronRunLogMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  jobId: string;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityCronRunLogMigration {
  const safeJobId = params.jobId.trim();
  if (
    !safeJobId ||
    safeJobId.includes("/") ||
    safeJobId.includes("\\") ||
    safeJobId.includes("\0")
  ) {
    throw new Error("invalid cron run log job id");
  }
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "audit",
    migrationPlan: params.migrationPlan,
    relativePath: path.join("cron", "runs", `${safeJobId}.jsonl`),
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    readLogPath: pathContract.readPath,
    writeLogPath: pathContract.writePath,
  });
}

export async function appendCronRunLogForIdentityMigration(
  migration: LcxIdentityCronRunLogMigration,
  entry: CronRunLogEntry,
): Promise<LcxIdentityWriteReceipt> {
  const previousRaw = await readLcxIdentityWriterRaw(migration.pathContract);
  const raw = `${previousRaw ?? ""}${JSON.stringify(entry)}\n`;
  return await writeLcxIdentityWriterRawWithReceipt(migration.pathContract, raw);
}

export async function rollbackCronRunLogIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
