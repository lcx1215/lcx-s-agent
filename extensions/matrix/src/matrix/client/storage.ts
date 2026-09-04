import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLcxIdentityWriterPathContract,
  moveLcxIdentityPathWithReceipt,
  rollbackLcxIdentityPathMove,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  LcxIdentityWriterContractError,
  type LcxIdentityPathMoveReceipt,
  type LcxIdentityWriteReceipt,
} from "../../../../../src/config/identity-migration.js";
import type { LcxIdentityMigrationPlan } from "../../../../../src/config/paths.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixStoragePaths } from "./types.js";

export const DEFAULT_ACCOUNT_KEY = "default";
const STORAGE_META_FILENAME = "storage-meta.json";

function sanitizePathSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

function resolveHomeserverKey(homeserver: string): string {
  try {
    const url = new URL(homeserver);
    if (url.host) {
      return sanitizePathSegment(url.host);
    }
  } catch {
    // fall through
  }
  return sanitizePathSegment(homeserver);
}

function hashAccessToken(accessToken: string): string {
  return crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

function resolveLegacyStoragePaths(env: NodeJS.ProcessEnv = process.env): {
  storagePath: string;
  cryptoPath: string;
} {
  const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  return {
    storagePath: path.join(stateDir, "matrix", "bot-storage.json"),
    cryptoPath: path.join(stateDir, "matrix", "crypto"),
  };
}

function resolveMatrixStoragePathsInStateDir(params: {
  stateDir: string;
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
}): MatrixStoragePaths {
  const accountKey = sanitizePathSegment(params.accountId ?? DEFAULT_ACCOUNT_KEY);
  const userKey = sanitizePathSegment(params.userId);
  const serverKey = resolveHomeserverKey(params.homeserver);
  const tokenHash = hashAccessToken(params.accessToken);
  const rootDir = path.join(
    params.stateDir,
    "matrix",
    "accounts",
    accountKey,
    `${serverKey}__${userKey}`,
    tokenHash,
  );
  return {
    rootDir,
    storagePath: path.join(rootDir, "bot-storage.json"),
    cryptoPath: path.join(rootDir, "crypto"),
    metaPath: path.join(rootDir, STORAGE_META_FILENAME),
    accountKey,
    tokenHash,
  };
}

export function resolveMatrixStoragePaths(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): MatrixStoragePaths {
  const env = params.env ?? process.env;
  const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  return resolveMatrixStoragePathsInStateDir({ ...params, stateDir });
}

export function resolveMatrixStoragePathsForIdentityMigration(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  migrationPlan: LcxIdentityMigrationPlan;
}): MatrixStoragePaths {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Matrix storage migration requires a state-root authority");
  }
  return resolveMatrixStoragePathsInStateDir({
    ...params,
    stateDir: params.migrationPlan.writeStateDir,
  });
}

export type LcxIdentityMatrixStorageMigrationReceipt = Readonly<{
  storage?: LcxIdentityPathMoveReceipt;
  crypto?: LcxIdentityPathMoveReceipt;
}>;

function resolveIdentityLegacyStoragePaths(plan: LcxIdentityMigrationPlan): {
  storagePath: string;
  cryptoPath: string;
} | null {
  const candidates = plan.readStateDirs.map((stateDir) => ({
    storagePath: path.join(stateDir, "matrix", "bot-storage.json"),
    cryptoPath: path.join(stateDir, "matrix", "crypto"),
  }));
  const existing = candidates.filter(
    (candidate) => fs.existsSync(candidate.storagePath) || fs.existsSync(candidate.cryptoPath),
  );
  if (existing.length > 1) {
    throw new LcxIdentityWriterContractError(
      `Matrix storage migration found split legacy roots: ${existing.map((candidate) => path.dirname(candidate.storagePath)).join(" and ")}`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  return existing[0] ?? null;
}

function createMatrixStoragePathContract(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  sourcePath: string;
  destinationPath: string;
}): ReturnType<typeof createLcxIdentityWriterPathContract> {
  return createLcxIdentityWriterPathContract({
    writer: "matrix-storage",
    migrationPlan: params.migrationPlan,
    readPath: params.sourcePath,
    writePath: params.destinationPath,
    auditPath: path.join(
      params.migrationPlan.writeStateDir,
      "logs",
      "identity-migration-audit.jsonl",
    ),
  });
}

export async function migrateMatrixStorageForIdentityMigration(params: {
  storagePaths: MatrixStoragePaths;
  migrationPlan: LcxIdentityMigrationPlan;
}): Promise<LcxIdentityMatrixStorageMigrationReceipt | null> {
  const legacy = resolveIdentityLegacyStoragePaths(params.migrationPlan);
  if (!legacy) {
    return null;
  }
  const hasCanonicalStorage = fs.existsSync(params.storagePaths.storagePath);
  const hasCanonicalCrypto = fs.existsSync(params.storagePaths.cryptoPath);
  if (hasCanonicalStorage || hasCanonicalCrypto) {
    throw new LcxIdentityWriterContractError(
      "Matrix storage migration found canonical and legacy state together",
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }

  let storage: LcxIdentityPathMoveReceipt | undefined;
  let cryptoStorage: LcxIdentityPathMoveReceipt | undefined;
  try {
    if (fs.existsSync(legacy.storagePath)) {
      storage = await moveLcxIdentityPathWithReceipt(
        createMatrixStoragePathContract({
          migrationPlan: params.migrationPlan,
          sourcePath: legacy.storagePath,
          destinationPath: params.storagePaths.storagePath,
        }),
      );
    }
    if (fs.existsSync(legacy.cryptoPath)) {
      cryptoStorage = await moveLcxIdentityPathWithReceipt(
        createMatrixStoragePathContract({
          migrationPlan: params.migrationPlan,
          sourcePath: legacy.cryptoPath,
          destinationPath: params.storagePaths.cryptoPath,
        }),
      );
    }
  } catch (error) {
    if (cryptoStorage) {
      await rollbackLcxIdentityPathMove(cryptoStorage);
    }
    if (storage) {
      await rollbackLcxIdentityPathMove(storage);
    }
    throw error;
  }
  return Object.freeze({ storage, crypto: cryptoStorage });
}

export async function rollbackMatrixStorageIdentityMigration(
  receipt: LcxIdentityMatrixStorageMigrationReceipt,
): Promise<void> {
  if (receipt.crypto) {
    await rollbackLcxIdentityPathMove(receipt.crypto);
  }
  if (receipt.storage) {
    await rollbackLcxIdentityPathMove(receipt.storage);
  }
}

function buildStorageMetaPayload(params: {
  storagePaths: MatrixStoragePaths;
  homeserver: string;
  userId: string;
  accountId?: string | null;
}) {
  return {
    homeserver: params.homeserver,
    userId: params.userId,
    accountId: params.accountId ?? DEFAULT_ACCOUNT_KEY,
    accessTokenHash: params.storagePaths.tokenHash,
    createdAt: new Date().toISOString(),
  };
}

export async function writeStorageMetaForIdentityMigration(params: {
  storagePaths: MatrixStoragePaths;
  migrationPlan: LcxIdentityMigrationPlan;
  homeserver: string;
  userId: string;
  accountId?: string | null;
}): Promise<LcxIdentityWriteReceipt> {
  return await writeLcxIdentityWriterRawWithReceipt(
    createMatrixStoragePathContract({
      migrationPlan: params.migrationPlan,
      sourcePath: params.storagePaths.metaPath,
      destinationPath: params.storagePaths.metaPath,
    }),
    `${JSON.stringify(buildStorageMetaPayload(params), null, 2)}\n`,
  );
}

export async function rollbackStorageMetaIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export function maybeMigrateLegacyStorage(params: {
  storagePaths: MatrixStoragePaths;
  env?: NodeJS.ProcessEnv;
}): void {
  const legacy = resolveLegacyStoragePaths(params.env);
  const hasLegacyStorage = fs.existsSync(legacy.storagePath);
  const hasLegacyCrypto = fs.existsSync(legacy.cryptoPath);
  const hasNewStorage =
    fs.existsSync(params.storagePaths.storagePath) || fs.existsSync(params.storagePaths.cryptoPath);

  if (!hasLegacyStorage && !hasLegacyCrypto) {
    return;
  }
  if (hasNewStorage) {
    return;
  }

  fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
  if (hasLegacyStorage) {
    try {
      fs.renameSync(legacy.storagePath, params.storagePaths.storagePath);
    } catch {
      // Ignore migration failures; new store will be created.
    }
  }
  if (hasLegacyCrypto) {
    try {
      fs.renameSync(legacy.cryptoPath, params.storagePaths.cryptoPath);
    } catch {
      // Ignore migration failures; new store will be created.
    }
  }
}

export function writeStorageMeta(params: {
  storagePaths: MatrixStoragePaths;
  homeserver: string;
  userId: string;
  accountId?: string | null;
}): void {
  try {
    const payload = buildStorageMetaPayload(params);
    fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(params.storagePaths.metaPath, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // ignore meta write failures
  }
}
