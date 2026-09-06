import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  resolveLcxIdentityMigrationCompletionPath,
  type LcxIdentityMigrationPlan,
} from "./paths.js";

export const LCX_IDENTITY_MIGRATION_INVENTORY = "lcx-identity-writer-inventory-v1" as const;

export type LcxIdentityMigrationCompletionMarker = Readonly<{
  schemaVersion: 1;
  canonicalStateDir: string;
  completedAt: string;
  inventory: typeof LCX_IDENTITY_MIGRATION_INVENTORY;
  targetKeys: readonly string[];
}>;

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
  | "node-host"
  | "device-pairing"
  | "device-pair-notify"
  | "node-pairing"
  | "exec-approvals"
  | "restart-sentinel"
  | "subagents"
  | "workspace"
  | "nostr-bus"
  | "nostr-profile"
  | "discord-bindings"
  | "discord-model-picker"
  | "telegram-offset"
  | "telegram-sticker-cache"
  | "update-check"
  | "voicewake"
  | "matrix-storage"
  | "channel-local"
  | "channel-pairing"
  | "phone-control";

export const LCX_IDENTITY_WRITER_NAMES: readonly LcxIdentityWriterName[] = [
  "config",
  "sessions",
  "credentials",
  "queues",
  "backups",
  "audit",
  "cron",
  "device",
  "device-auth",
  "node-host",
  "device-pairing",
  "device-pair-notify",
  "node-pairing",
  "exec-approvals",
  "restart-sentinel",
  "subagents",
  "workspace",
  "nostr-bus",
  "nostr-profile",
  "discord-bindings",
  "discord-model-picker",
  "telegram-offset",
  "telegram-sticker-cache",
  "update-check",
  "voicewake",
  "matrix-storage",
  "channel-local",
  "channel-pairing",
  "phone-control",
];

export type LcxIdentityWriterPathContract = Readonly<{
  writer: LcxIdentityWriterName;
  targetKey: string;
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

export type LcxIdentityMigrationTarget = Readonly<{
  targetKey: string;
  writer: LcxIdentityWriterName;
  writePath: string;
}>;

export type LcxIdentityAuditResult = Readonly<{
  status: "written" | "failed";
  error?: string;
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
  audit: LcxIdentityAuditResult;
}>;

export type LcxIdentityMigrationWriterReceipt = LcxIdentityWriteReceipt;

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
  audit: LcxIdentityAuditResult;
}>;

export type LcxIdentityPathMoveReceipt = Readonly<{
  pathContract: LcxIdentityWriterPathContract;
  previous: Readonly<{
    exists: true;
    kind: "file" | "directory";
    bytes: number | null;
    contentHash: string | null;
    dev: number;
    ino: number;
  }>;
  rollback: Readonly<{
    path: string;
    strategy: "move-written-target-back";
  }>;
  audit: LcxIdentityAuditResult;
}>;

export class LcxIdentityWriterContractError extends Error {
  readonly code: string;

  constructor(message: string, code = "LCX_IDENTITY_WRITER_CONTRACT_VIOLATION") {
    super(message);
    this.name = "LcxIdentityWriterContractError";
    this.code = code;
  }
}

// Keep ownership local to this process so a writer may perform a follow-up
// update after its first migration write, while a fresh process still fails
// closed when it encounters a pre-existing canonical target beside legacy
// state. The content hash lets us reject an intervening external change.
const ownedWriteTargetHashes = new Map<string, string>();

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
  const targetRoot = migrationPlan?.canonicalStateDir ?? path.dirname(writePath);
  const relativeTarget = path.relative(path.resolve(targetRoot), writePath);
  const targetKey = relativeTarget
    ? relativeTarget.split(path.sep).join("/")
    : path.basename(writePath);
  return Object.freeze({
    writer: params.writer,
    targetKey,
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

export function createLcxIdentityMigrationTarget(
  contract: LcxIdentityWriterPathContract,
): LcxIdentityMigrationTarget {
  return Object.freeze({
    targetKey: contract.targetKey,
    writer: contract.writer,
    writePath: contract.writePath,
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
  const activeReadRoot = path.resolve(params.migrationPlan.readStateDir);
  const writeRoot = path.resolve(params.migrationPlan.writeStateDir);
  const orderedReadRoots = [
    params.migrationPlan.readStateDir,
    ...params.migrationPlan.readStateDirs.filter(
      (candidate) =>
        path.resolve(candidate) !== activeReadRoot && path.resolve(candidate) !== writeRoot,
    ),
  ];
  const existingReadRoot = orderedReadRoots.find((candidate) =>
    existsSync(resolveRelativeStatePath(candidate, params.relativePath)),
  );
  const canonicalTarget = resolveRelativeStatePath(writeRoot, params.relativePath);
  const readRoot =
    isOwnedWriteTarget(params.writer, canonicalTarget, existsSync) ||
    (!existingReadRoot && existsSync(canonicalTarget))
      ? writeRoot
      : (existingReadRoot ?? params.migrationPlan.readStateDir);
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
    if (isOwnedWriteTarget(contract.writer, contract.writePath, existsSync)) {
      return;
    }
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

function isOwnedWriteTarget(
  writer: LcxIdentityWriterName,
  writePath: string,
  existsSync: (candidate: string) => boolean,
): boolean {
  const ownedHash = ownedWriteTargetHashes.get(`${writer}:${writePath}`);
  if (!ownedHash || !existsSync(writePath)) {
    return false;
  }
  try {
    return hashRaw(fs.readFileSync(writePath, "utf8")) === ownedHash;
  } catch {
    return false;
  }
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

export async function writeLcxIdentityMigrationCompletionMarker(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  requiredTargets: readonly LcxIdentityMigrationTarget[];
  writerReceipts: readonly LcxIdentityMigrationWriterReceipt[];
  now?: () => string;
}): Promise<LcxIdentityMigrationCompletionMarker> {
  const { migrationPlan } = params;
  if (
    migrationPlan.mode !== "canonical-default" ||
    path.resolve(migrationPlan.writeStateDir) !== path.resolve(migrationPlan.canonicalStateDir)
  ) {
    throw new LcxIdentityWriterContractError(
      "Identity migration completion requires the canonical default write target",
      "LCX_IDENTITY_COMPLETION_TARGET",
    );
  }
  if (params.requiredTargets.length === 0) {
    throw new LcxIdentityWriterContractError(
      "Identity migration completion requires a concrete target manifest",
      "LCX_IDENTITY_COMPLETION_TARGETS_INCOMPLETE",
    );
  }
  const requiredTargetsByKey = new Map<string, LcxIdentityMigrationTarget>();
  for (const target of params.requiredTargets) {
    const targetKey = target.targetKey.trim();
    const writePath = path.resolve(target.writePath);
    if (!targetKey || requiredTargetsByKey.has(targetKey)) {
      throw new LcxIdentityWriterContractError(
        `Identity migration completion has duplicate or empty target key: ${targetKey || "<empty>"}`,
        "LCX_IDENTITY_COMPLETION_DUPLICATE_TARGET",
      );
    }
    if (
      !writePath.startsWith(`${path.resolve(migrationPlan.canonicalStateDir)}${path.sep}`) ||
      path
        .relative(path.resolve(migrationPlan.canonicalStateDir), writePath)
        .split(path.sep)
        .join("/") !== targetKey
    ) {
      throw new LcxIdentityWriterContractError(
        `Identity migration target ${targetKey} does not resolve inside the canonical state root`,
        "LCX_IDENTITY_COMPLETION_TARGET",
      );
    }
    requiredTargetsByKey.set(targetKey, Object.freeze({ ...target, targetKey, writePath }));
  }

  const missingWriterFamilies = LCX_IDENTITY_WRITER_NAMES.filter(
    (writer) => ![...requiredTargetsByKey.values()].some((target) => target.writer === writer),
  );
  if (missingWriterFamilies.length > 0) {
    throw new LcxIdentityWriterContractError(
      `Identity migration target manifest is incomplete; missing writer families: ${missingWriterFamilies.join(", ")}`,
      "LCX_IDENTITY_COMPLETION_TARGETS_INCOMPLETE",
    );
  }

  const receiptsByTarget = new Map<string, LcxIdentityMigrationWriterReceipt>();
  for (const receipt of params.writerReceipts) {
    const targetKey = receipt.pathContract.targetKey.trim();
    if (receiptsByTarget.has(targetKey)) {
      throw new LcxIdentityWriterContractError(
        `Identity migration completion has duplicate receipt for target ${targetKey}`,
        "LCX_IDENTITY_COMPLETION_DUPLICATE_TARGET",
      );
    }
    if (receipt.audit.status !== "written") {
      throw new LcxIdentityWriterContractError(
        `Identity migration completion requires a durable receipt for ${receipt.pathContract.writer}`,
        "LCX_IDENTITY_COMPLETION_RECEIPT_NOT_DURABLE",
      );
    }
    if (
      !/^[a-f0-9]{64}$/i.test(receipt.next.hash) ||
      !Number.isInteger(receipt.next.bytes) ||
      receipt.next.bytes < 0 ||
      !receipt.rollback.path
    ) {
      throw new LcxIdentityWriterContractError(
        `Identity migration receipt for ${receipt.pathContract.writer} is malformed`,
        "LCX_IDENTITY_COMPLETION_RECEIPT_MALFORMED",
      );
    }
    const requiredTarget = requiredTargetsByKey.get(targetKey);
    if (
      !requiredTarget ||
      path.resolve(receipt.pathContract.writePath) !== requiredTarget.writePath ||
      receipt.pathContract.writer !== requiredTarget.writer
    ) {
      throw new LcxIdentityWriterContractError(
        `Identity migration receipt for ${receipt.pathContract.writer} does not match a concrete migration target`,
        "LCX_IDENTITY_COMPLETION_RECEIPT_TARGET",
      );
    }
    const currentRaw = await readOptionalRaw(receipt.pathContract.writePath);
    if (
      currentRaw === null ||
      hashRaw(currentRaw) !== receipt.next.hash ||
      Buffer.byteLength(currentRaw, "utf8") !== receipt.next.bytes
    ) {
      throw new LcxIdentityWriterContractError(
        `Identity migration receipt for ${receipt.pathContract.writer} no longer matches its canonical target`,
        "LCX_IDENTITY_COMPLETION_RECEIPT_STALE",
      );
    }
    receiptsByTarget.set(targetKey, receipt);
  }
  const missingTargets = [...requiredTargetsByKey.keys()].filter(
    (targetKey) => !receiptsByTarget.has(targetKey),
  );
  if (missingTargets.length > 0) {
    throw new LcxIdentityWriterContractError(
      `Identity migration completion requires receipts for every concrete target; missing: ${missingTargets.join(", ")}`,
      "LCX_IDENTITY_COMPLETION_TARGETS_INCOMPLETE",
    );
  }
  const marker = Object.freeze({
    schemaVersion: 1 as const,
    canonicalStateDir: path.resolve(migrationPlan.canonicalStateDir),
    completedAt: (params.now ?? (() => new Date().toISOString()))(),
    inventory: LCX_IDENTITY_MIGRATION_INVENTORY,
    targetKeys: Object.freeze([...requiredTargetsByKey.keys()]),
  });
  await writeRawAtomically(
    resolveLcxIdentityMigrationCompletionPath(migrationPlan.canonicalStateDir),
    `${JSON.stringify(marker)}\n`,
  );
  return marker;
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

async function appendIdentityAuditBestEffort(
  contract: LcxIdentityWriterPathContract,
  record: Record<string, unknown>,
): Promise<LcxIdentityAuditResult> {
  try {
    await appendIdentityAudit(contract, record);
    return { status: "written" };
  } catch (error) {
    return { status: "failed", error: String(error) };
  }
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
  ownedWriteTargetHashes.set(`${contract.writer}:${contract.writePath}`, nextHash);

  const receipt = Object.freeze({
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

  const audit = await appendIdentityAuditBestEffort(contract, {
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
  return Object.freeze({ ...receipt, audit });
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
    ownedWriteTargetHashes.set(
      `${pathContract.writer}:${pathContract.writePath}`,
      receipt.previous.hash ?? hashRaw(backupRaw),
    );
  } else {
    await fs.promises.unlink(pathContract.writePath);
    ownedWriteTargetHashes.delete(`${pathContract.writer}:${pathContract.writePath}`);
  }

  await appendIdentityAuditBestEffort(pathContract, {
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
  const receipt = Object.freeze({
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
  const audit = await appendIdentityAuditBestEffort(contract, {
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
  return Object.freeze({ ...receipt, audit });
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
  ownedWriteTargetHashes.set(
    `${pathContract.writer}:${pathContract.writePath}`,
    receipt.previous.hash,
  );
  await appendIdentityAuditBestEffort(pathContract, {
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

export async function moveLcxIdentityPathWithReceipt(
  contract: LcxIdentityWriterPathContract,
): Promise<LcxIdentityPathMoveReceipt> {
  assertLcxIdentityWriterPathContract(contract);
  if (contract.readPath === contract.writePath) {
    throw new LcxIdentityWriterContractError(
      `${contract.writer} path move requires distinct read and write paths`,
      "LCX_IDENTITY_MOVE_SAME_PATH",
    );
  }
  const sourceStat = await fs.promises.lstat(contract.readPath).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!sourceStat) {
    throw new LcxIdentityWriterContractError(
      `${contract.writer} move source is missing at ${contract.readPath}`,
      "LCX_IDENTITY_MOVE_SOURCE_MISSING",
    );
  }
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    throw new LcxIdentityWriterContractError(
      `${contract.writer} move source must be a file or directory at ${contract.readPath}`,
      "LCX_IDENTITY_MOVE_UNSUPPORTED_SOURCE",
    );
  }
  const destinationStat = await fs.promises.lstat(contract.writePath).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (destinationStat) {
    throw new LcxIdentityWriterContractError(
      `${contract.writer} move destination already exists at ${contract.writePath}`,
      "LCX_IDENTITY_MOVE_DESTINATION_EXISTS",
    );
  }
  const sourceRaw = sourceStat.isFile()
    ? await fs.promises.readFile(contract.readPath, "utf8")
    : null;
  await fs.promises.mkdir(path.dirname(contract.writePath), { recursive: true, mode: 0o700 });
  await fs.promises.rename(contract.readPath, contract.writePath);
  const receipt = Object.freeze({
    pathContract: contract,
    previous: Object.freeze({
      exists: true as const,
      kind: sourceStat.isDirectory() ? "directory" : "file",
      bytes: sourceStat.isFile() ? sourceStat.size : null,
      contentHash: sourceRaw === null ? null : hashRaw(sourceRaw),
      dev: sourceStat.dev,
      ino: sourceStat.ino,
    }),
    rollback: Object.freeze({
      path: contract.rollbackPath,
      strategy: "move-written-target-back" as const,
    }),
  });
  const audit = await appendIdentityAuditBestEffort(contract, {
    ts: new Date().toISOString(),
    source: "lcx-identity-migration",
    event: "identity.move",
    writer: contract.writer,
    readPath: contract.readPath,
    writePath: contract.writePath,
    backupPath: contract.backupPath,
    auditPath: contract.auditPath,
    rollbackPath: contract.rollbackPath,
    noSplitState: contract.noSplitState,
    previousKind: receipt.previous.kind,
    previousBytes: receipt.previous.bytes,
  });
  return Object.freeze({ ...receipt, audit });
}

export async function rollbackLcxIdentityPathMove(
  receipt: LcxIdentityPathMoveReceipt,
): Promise<void> {
  const { pathContract } = receipt;
  const sourceStat = await fs.promises.lstat(pathContract.readPath).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  const destinationStat = await fs.promises.lstat(pathContract.writePath).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  const destinationRaw = destinationStat?.isFile()
    ? await fs.promises.readFile(pathContract.writePath, "utf8")
    : null;
  if (
    sourceStat ||
    !destinationStat ||
    (receipt.previous.kind === "directory" && !destinationStat.isDirectory()) ||
    (receipt.previous.kind === "file" && !destinationStat.isFile()) ||
    destinationStat.dev !== receipt.previous.dev ||
    destinationStat.ino !== receipt.previous.ino ||
    (receipt.previous.contentHash !== null &&
      (destinationRaw === null || hashRaw(destinationRaw) !== receipt.previous.contentHash))
  ) {
    throw new LcxIdentityWriterContractError(
      `${pathContract.writer} move rollback refused because the moved target changed`,
      "LCX_IDENTITY_ROLLBACK_TARGET_MISMATCH",
    );
  }
  await fs.promises.mkdir(path.dirname(pathContract.readPath), { recursive: true, mode: 0o700 });
  await fs.promises.rename(pathContract.writePath, pathContract.readPath);
  await appendIdentityAuditBestEffort(pathContract, {
    ts: new Date().toISOString(),
    source: "lcx-identity-migration",
    event: "identity.move.rollback",
    writer: pathContract.writer,
    readPath: pathContract.readPath,
    writePath: pathContract.writePath,
    backupPath: pathContract.backupPath,
    auditPath: pathContract.auditPath,
    rollbackPath: pathContract.rollbackPath,
    noSplitState: pathContract.noSplitState,
    result: "restored",
    restoredKind: receipt.previous.kind,
  });
}
