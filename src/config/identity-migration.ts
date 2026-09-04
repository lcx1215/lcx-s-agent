import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LcxIdentityMigrationPlan } from "./paths.js";

export type LcxIdentityWriterName =
  | "config"
  | "sessions"
  | "credentials"
  | "queues"
  | "backups"
  | "audit"
  | "cron"
  | "device"
  | "device-auth"
  | "device-pairing"
  | "node-pairing"
  | "exec-approvals"
  | "restart-sentinel"
  | "subagents"
  | "workspace";

export type LcxIdentityWriterPathContract = Readonly<{
  writer: LcxIdentityWriterName;
  migrationPlan: LcxIdentityMigrationPlan | null;
  readPath: string;
  writePath: string;
  backupPath: string;
  auditPath: string;
  expectedReadPath: string;
  expectedWritePath: string;
  rollbackPath: string;
  noSplitState: "single-write-target";
}>;

export type LcxIdentityWriteReceipt = Readonly<{
  pathContract: LcxIdentityWriterPathContract;
  previous: Readonly<{
    exists: boolean;
    hash: string | null;
    bytes: number | null;
  }>;
  next: Readonly<{
    hash: string;
    bytes: number;
  }>;
  rollback: Readonly<{
    path: string;
    strategy: "restore-backup" | "remove-written-target";
  }>;
}>;

export type LcxIdentityRemovalReceipt = Readonly<{
  pathContract: LcxIdentityWriterPathContract;
  previous: Readonly<{
    exists: true;
    hash: string;
    bytes: number;
  }>;
  rollback: Readonly<{
    path: string;
    strategy: "restore-removed-target";
  }>;
}>;

export class LcxIdentityWriterContractError extends Error {
  readonly code: string;

  constructor(message: string, code = "LCX_IDENTITY_WRITER_CONTRACT_VIOLATION") {
    super(message);
    this.name = "LcxIdentityWriterContractError";
    this.code = code;
  }
}

function resolveRelativeStatePath(root: string, relativePath: string): string {
  const normalized = path.normalize(relativePath.trim());
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new LcxIdentityWriterContractError(
      `Identity migration writer path must be relative to its state root: ${relativePath}`,
      "LCX_IDENTITY_WRITER_RELATIVE_PATH",
    );
  }
  return path.resolve(root, normalized);
}

export function createLcxIdentityWriterPathContract<T extends LcxIdentityWriterName>(params: {
  writer: T;
  migrationPlan?: LcxIdentityMigrationPlan | null;
  readPath: string;
  writePath: string;
  backupPath?: string;
  auditPath?: string;
}): LcxIdentityWriterPathContract & Readonly<{ writer: T }> {
  const migrationPlan = params.migrationPlan ?? null;
  const readPath = path.resolve(params.readPath);
  const writePath = path.resolve(params.writePath);
  const auditPath =
    params.auditPath ??
    path.join(
      migrationPlan?.writeStateDir ?? path.dirname(writePath),
      "logs",
      "identity-migration-audit.jsonl",
    );
  return Object.freeze({
    writer: params.writer,
    migrationPlan,
    readPath,
    writePath,
    backupPath: params.backupPath ?? `${writePath}.bak`,
    auditPath: path.resolve(auditPath),
    expectedReadPath: readPath,
    expectedWritePath: writePath,
    rollbackPath: params.backupPath ?? `${writePath}.bak`,
    noSplitState: "single-write-target" as const,
  });
}

export function resolveLcxIdentityStateWriterPathContract<T extends LcxIdentityWriterName>(params: {
  writer: T;
  migrationPlan: LcxIdentityMigrationPlan;
  relativePath: string;
  backupPath?: string;
  auditPath?: string;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityWriterPathContract & Readonly<{ writer: T }> {
  const existsSync = params.existsSync ?? fs.existsSync;
  const existingReadRoot = params.migrationPlan.readStateDirs.find((candidate) =>
    existsSync(resolveRelativeStatePath(candidate, params.relativePath)),
  );
  const readRoot = existingReadRoot ?? params.migrationPlan.readStateDir;
  return createLcxIdentityWriterPathContract({
    writer: params.writer,
    migrationPlan: params.migrationPlan,
    readPath: resolveRelativeStatePath(readRoot, params.relativePath),
    writePath: resolveRelativeStatePath(params.migrationPlan.writeStateDir, params.relativePath),
    backupPath: params.backupPath,
    auditPath: params.auditPath,
  });
}

export function assertLcxIdentityWriterPathContract(
  contract: LcxIdentityWriterPathContract,
  options?: {
    expectedReadPath?: string;
    expectedWritePath?: string;
    existsSync?: (candidate: string) => boolean;
  },
): void {
  const expectedReadPath = options?.expectedReadPath;
  const expectedWritePath = options?.expectedWritePath;
  if (expectedReadPath !== undefined && path.resolve(expectedReadPath) !== contract.readPath) {
    throw new LcxIdentityWriterContractError(
      `${contract.writer} read path does not match the active path contract: ${expectedReadPath} !== ${contract.readPath}`,
      "LCX_IDENTITY_READ_PATH_MISMATCH",
    );
  }
  if (expectedWritePath !== undefined && path.resolve(expectedWritePath) !== contract.writePath) {
    throw new LcxIdentityWriterContractError(
      `${contract.writer} write path does not match the active path contract: ${expectedWritePath} !== ${contract.writePath}`,
      "LCX_IDENTITY_WRITE_PATH_MISMATCH",
    );
  }
  const existsSync = options?.existsSync ?? fs.existsSync;
  if (contract.readPath !== contract.writePath && existsSync(contract.writePath)) {
    throw new LcxIdentityWriterContractError(
      `${contract.writer} migration would create split state: read ${contract.readPath}, write target already exists at ${contract.writePath}`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
}

function hashRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

async function readOptionalRaw(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function writeRawAtomically(filePath: string, raw: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.promises.writeFile(tempPath, raw, { encoding: "utf8", mode: 0o600 });
    try {
      await fs.promises.rename(tempPath, filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EEXIST") {
        throw err;
      }
      await fs.promises.copyFile(tempPath, filePath);
      await fs.promises.unlink(tempPath).catch(() => undefined);
    }
    await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => undefined);
  }
}

async function appendIdentityAudit(
  contract: LcxIdentityWriterPathContract,
  record: Record<string, unknown>,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(contract.auditPath), { recursive: true, mode: 0o700 });
  await fs.promises.appendFile(contract.auditPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readLcxIdentityWriterRaw(
  contract: LcxIdentityWriterPathContract,
): Promise<string | null> {
  return await readOptionalRaw(contract.readPath);
}

export async function writeLcxIdentityWriterRawWithReceipt(
  contract: LcxIdentityWriterPathContract,
  raw: string,
  options?: {
    expectedReadPath?: string;
    expectedWritePath?: string;
  },
): Promise<LcxIdentityWriteReceipt> {
  assertLcxIdentityWriterPathContract(contract, options);
  const previousRaw = await readOptionalRaw(contract.writePath);
  const previousExists = previousRaw !== null;
  const previousHash = previousExists ? hashRaw(previousRaw) : null;
  const nextHash = hashRaw(raw);

  if (previousExists) {
    await writeRawAtomically(contract.backupPath, previousRaw);
  }
  await writeRawAtomically(contract.writePath, raw);

  const receipt: LcxIdentityWriteReceipt = Object.freeze({
    pathContract: contract,
    previous: Object.freeze({
      exists: previousExists,
      hash: previousHash,
      bytes: previousExists ? Buffer.byteLength(previousRaw, "utf8") : null,
    }),
    next: Object.freeze({ hash: nextHash, bytes: Buffer.byteLength(raw, "utf8") }),
    rollback: Object.freeze({
      path: contract.rollbackPath,
      strategy: previousExists ? "restore-backup" : "remove-written-target",
    }),
  });

  await appendIdentityAudit(contract, {
    ts: new Date().toISOString(),
    source: "lcx-identity-migration",
    event: "identity.write",
    writer: contract.writer,
    readPath: contract.readPath,
    writePath: contract.writePath,
    backupPath: contract.backupPath,
    auditPath: contract.auditPath,
    rollbackPath: contract.rollbackPath,
    noSplitState: contract.noSplitState,
    previousExists,
    previousHash,
    nextHash,
    previousBytes: receipt.previous.bytes,
    nextBytes: receipt.next.bytes,
  });
  return receipt;
}

export async function rollbackLcxIdentityWriter(receipt: LcxIdentityWriteReceipt): Promise<void> {
  const { pathContract } = receipt;
  const currentRaw = await readOptionalRaw(pathContract.writePath);
  if (currentRaw === null || hashRaw(currentRaw) !== receipt.next.hash) {
    throw new LcxIdentityWriterContractError(
      `${pathContract.writer} rollback refused because the write target changed`,
      "LCX_IDENTITY_ROLLBACK_TARGET_MISMATCH",
    );
  }

  if (receipt.rollback.strategy === "restore-backup") {
    const backupRaw = await readOptionalRaw(receipt.rollback.path);
    if (backupRaw === null || hashRaw(backupRaw) !== receipt.previous.hash) {
      throw new LcxIdentityWriterContractError(
        `${pathContract.writer} rollback backup is missing or changed at ${receipt.rollback.path}`,
        "LCX_IDENTITY_ROLLBACK_BACKUP_MISMATCH",
      );
    }
    await writeRawAtomically(pathContract.writePath, backupRaw);
  } else {
    await fs.promises.unlink(pathContract.writePath);
  }

  await appendIdentityAudit(pathContract, {
    ts: new Date().toISOString(),
    source: "lcx-identity-migration",
    event: "identity.rollback",
    writer: pathContract.writer,
    readPath: pathContract.readPath,
    writePath: pathContract.writePath,
    backupPath: pathContract.backupPath,
    auditPath: pathContract.auditPath,
    rollbackPath: pathContract.rollbackPath,
    noSplitState: pathContract.noSplitState,
    result: receipt.rollback.strategy === "restore-backup" ? "restored" : "removed",
    expectedNextHash: receipt.next.hash,
    restoredHash: receipt.previous.hash,
  });
}

export async function removeLcxIdentityWriterWithReceipt(
  contract: LcxIdentityWriterPathContract,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityRemovalReceipt> {
  assertLcxIdentityWriterPathContract(contract, options);
  const previousRaw = await readOptionalRaw(contract.writePath);
  if (previousRaw === null) {
    throw new LcxIdentityWriterContractError(
      `${contract.writer} remove target is missing at ${contract.writePath}`,
      "LCX_IDENTITY_REMOVE_TARGET_MISSING",
    );
  }
  const previousHash = hashRaw(previousRaw);
  await writeRawAtomically(contract.backupPath, previousRaw);
  await fs.promises.unlink(contract.writePath);
  const receipt: LcxIdentityRemovalReceipt = Object.freeze({
    pathContract: contract,
    previous: Object.freeze({
      exists: true as const,
      hash: previousHash,
      bytes: Buffer.byteLength(previousRaw, "utf8"),
    }),
    rollback: Object.freeze({
      path: contract.rollbackPath,
      strategy: "restore-removed-target" as const,
    }),
  });
  await appendIdentityAudit(contract, {
    ts: new Date().toISOString(),
    source: "lcx-identity-migration",
    event: "identity.remove",
    writer: contract.writer,
    readPath: contract.readPath,
    writePath: contract.writePath,
    backupPath: contract.backupPath,
    auditPath: contract.auditPath,
    rollbackPath: contract.rollbackPath,
    noSplitState: contract.noSplitState,
    previousHash,
    previousBytes: receipt.previous.bytes,
  });
  return receipt;
}

export async function rollbackLcxIdentityRemoval(
  receipt: LcxIdentityRemovalReceipt,
): Promise<void> {
  const { pathContract } = receipt;
  const currentRaw = await readOptionalRaw(pathContract.writePath);
  if (currentRaw !== null) {
    throw new LcxIdentityWriterContractError(
      `${pathContract.writer} removal rollback refused because the target changed`,
      "LCX_IDENTITY_ROLLBACK_TARGET_MISMATCH",
    );
  }
  const backupRaw = await readOptionalRaw(receipt.rollback.path);
  if (backupRaw === null || hashRaw(backupRaw) !== receipt.previous.hash) {
    throw new LcxIdentityWriterContractError(
      `${pathContract.writer} removal rollback backup is missing or changed at ${receipt.rollback.path}`,
      "LCX_IDENTITY_ROLLBACK_BACKUP_MISMATCH",
    );
  }
  await writeRawAtomically(pathContract.writePath, backupRaw);
  await appendIdentityAudit(pathContract, {
    ts: new Date().toISOString(),
    source: "lcx-identity-migration",
    event: "identity.rollback",
    writer: pathContract.writer,
    readPath: pathContract.readPath,
    writePath: pathContract.writePath,
    backupPath: pathContract.backupPath,
    auditPath: pathContract.auditPath,
    rollbackPath: pathContract.rollbackPath,
    noSplitState: pathContract.noSplitState,
    result: "restored-after-remove",
    removedHash: receipt.previous.hash,
    restoredHash: receipt.previous.hash,
  });
}
