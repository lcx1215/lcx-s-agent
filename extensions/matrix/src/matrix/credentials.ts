import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readLcxIdentityWriterRaw,
  removeLcxIdentityWriterWithReceipt,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityRemoval,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityRemovalReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
  type LcxIdentityMigrationPlan,
} from "lcx-agent/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "lcx-agent/plugin-sdk/account-id";
import { getMatrixRuntime } from "../runtime.js";

export type MatrixStoredCredentials = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  createdAt: string;
  lastUsedAt?: string;
};

function credentialsFilename(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  if (normalized === DEFAULT_ACCOUNT_ID) {
    return "credentials.json";
  }
  // normalizeAccountId produces lowercase [a-z0-9-] strings, already filesystem-safe.
  // Different raw IDs that normalize to the same value are the same logical account.
  return `credentials-${normalized}.json`;
}

function parseMatrixCredentials(raw: string): MatrixStoredCredentials | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MatrixStoredCredentials>;
    if (
      typeof parsed.homeserver !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.accessToken !== "string"
    ) {
      return null;
    }
    return parsed as MatrixStoredCredentials;
  } catch {
    return null;
  }
}

export function resolveMatrixCredentialsDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir?: string,
): string {
  const resolvedStateDir = stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(resolvedStateDir, "credentials", "matrix");
}

export function resolveMatrixCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): string {
  const dir = resolveMatrixCredentialsDir(env);
  return path.join(dir, credentialsFilename(accountId));
}

export function loadMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  try {
    if (!fs.existsSync(credPath)) {
      return null;
    }
    const raw = fs.readFileSync(credPath, "utf-8");
    return parseMatrixCredentials(raw);
  } catch {
    return null;
  }
}

export type LcxIdentityMatrixCredentialsMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "credentials" }>;
  relativePath: string;
  accountId: string;
  readCredentialsPath: string;
  writeCredentialsPath: string;
}>;

export function createLcxIdentityMatrixCredentialsMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  accountId?: string | null;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityMatrixCredentialsMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Matrix credentials migration requires a state-root authority");
  }
  const accountId = normalizeAccountId(params.accountId);
  const relativePath = path.join("credentials", "matrix", credentialsFilename(accountId));
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "credentials",
    migrationPlan: params.migrationPlan,
    relativePath,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    relativePath,
    accountId,
    readCredentialsPath: pathContract.readPath,
    writeCredentialsPath: pathContract.writePath,
  });
}

function resolveCurrentMatrixCredentialsPathContract(
  migration: LcxIdentityMatrixCredentialsMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "credentials" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "credentials",
    migrationPlan: plan,
    relativePath: migration.relativePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export async function readMatrixCredentialsForIdentityMigration(
  migration: LcxIdentityMatrixCredentialsMigration,
): Promise<MatrixStoredCredentials | null> {
  const raw = await readLcxIdentityWriterRaw(
    resolveCurrentMatrixCredentialsPathContract(migration),
  );
  return raw === null ? null : parseMatrixCredentials(raw);
}

export async function writeMatrixCredentialsForIdentityMigration(
  migration: LcxIdentityMatrixCredentialsMigration,
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const existing = await readMatrixCredentialsForIdentityMigration(migration);
  const now = new Date().toISOString();
  const next: MatrixStoredCredentials = {
    ...credentials,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  };
  return await writeLcxIdentityWriterRawWithReceipt(
    resolveCurrentMatrixCredentialsPathContract(migration),
    `${JSON.stringify(next, null, 2)}\n`,
    options,
  );
}

export async function rollbackMatrixCredentialsIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export async function clearMatrixCredentialsForIdentityMigration(
  migration: LcxIdentityMatrixCredentialsMigration,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityRemovalReceipt> {
  return await removeLcxIdentityWriterWithReceipt(
    resolveCurrentMatrixCredentialsPathContract(migration),
    options,
  );
}

export async function rollbackClearedMatrixCredentialsIdentityMigration(
  receipt: LcxIdentityRemovalReceipt,
): Promise<void> {
  await rollbackLcxIdentityRemoval(receipt);
}

export function saveMatrixCredentials(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const dir = resolveMatrixCredentialsDir(env);
  fs.mkdirSync(dir, { recursive: true });

  const credPath = resolveMatrixCredentialsPath(env, accountId);

  const existing = loadMatrixCredentials(env, accountId);
  const now = new Date().toISOString();

  const toSave: MatrixStoredCredentials = {
    ...credentials,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  };

  fs.writeFileSync(credPath, JSON.stringify(toSave, null, 2), "utf-8");
}

export function touchMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const existing = loadMatrixCredentials(env, accountId);
  if (!existing) {
    return;
  }

  existing.lastUsedAt = new Date().toISOString();
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  fs.writeFileSync(credPath, JSON.stringify(existing, null, 2), "utf-8");
}

export function clearMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  try {
    if (fs.existsSync(credPath)) {
      fs.unlinkSync(credPath);
    }
  } catch {
    // ignore
  }
}

export function credentialsMatchConfig(
  stored: MatrixStoredCredentials,
  config: { homeserver: string; userId: string },
): boolean {
  // If userId is empty (token-based auth), only match homeserver
  if (!config.userId) {
    return stored.homeserver === config.homeserver;
  }
  return stored.homeserver === config.homeserver && stored.userId === config.userId;
}
