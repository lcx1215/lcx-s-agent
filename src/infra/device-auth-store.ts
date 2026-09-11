import fs from "node:fs";
import path from "node:path";
import {
  readLcxIdentityWriterRaw,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../config/identity-migration.js";
import { resolveStateDir } from "../config/paths.js";
import type { LcxIdentityMigrationPlan } from "../config/paths.js";
import {
  clearDeviceAuthTokenFromStore,
  type DeviceAuthEntry,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../shared/device-auth-store.js";
import {
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
  type DeviceAuthStore,
} from "../shared/device-auth.js";

const DEVICE_AUTH_FILE = "device-auth.json";
const DEVICE_AUTH_RELATIVE_PATH = path.join("identity", DEVICE_AUTH_FILE);

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}

function readStore(filePath: string): DeviceAuthStore | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStore(filePath: string, store: DeviceAuthStore): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

export type LcxIdentityDeviceAuthMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "device-auth" }>;
  readAuthStorePath: string;
  writeAuthStorePath: string;
}>;

export function createLcxIdentityDeviceAuthMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityDeviceAuthMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Device auth migration requires a state-root authority");
  }
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "device-auth",
    migrationPlan: params.migrationPlan,
    relativePath: DEVICE_AUTH_RELATIVE_PATH,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    readAuthStorePath: pathContract.readPath,
    writeAuthStorePath: pathContract.writePath,
  });
}

function resolveCurrentDeviceAuthPathContract(
  migration: LcxIdentityDeviceAuthMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "device-auth" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "device-auth",
    migrationPlan: plan,
    relativePath: DEVICE_AUTH_RELATIVE_PATH,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

function parseDeviceAuthStore(raw: string): DeviceAuthStore | null {
  try {
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (
      parsed?.version !== 1 ||
      typeof parsed.deviceId !== "string" ||
      !parsed.tokens ||
      typeof parsed.tokens !== "object" ||
      Array.isArray(parsed.tokens)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readDeviceAuthStoreForIdentityMigration(
  migration: LcxIdentityDeviceAuthMigration,
): Promise<DeviceAuthStore | null> {
  const pathContract = resolveCurrentDeviceAuthPathContract(migration);
  const raw = await readLcxIdentityWriterRaw(pathContract);
  return raw === null ? null : parseDeviceAuthStore(raw);
}

export async function loadDeviceAuthTokenForIdentityMigration(params: {
  migration: LcxIdentityDeviceAuthMigration;
  deviceId: string;
  role: string;
}): Promise<DeviceAuthEntry | null> {
  const store = await readDeviceAuthStoreForIdentityMigration(params.migration);
  return loadDeviceAuthTokenFromStore({
    adapter: { readStore: () => store, writeStore: () => undefined },
    deviceId: params.deviceId,
    role: params.role,
  });
}

export async function writeDeviceAuthStoreForIdentityMigration(
  migration: LcxIdentityDeviceAuthMigration,
  store: DeviceAuthStore,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const pathContract = resolveCurrentDeviceAuthPathContract(migration);
  return await writeLcxIdentityWriterRawWithReceipt(
    pathContract,
    `${JSON.stringify(store, null, 2)}\n`,
    options,
  );
}

export async function storeDeviceAuthTokenForIdentityMigration(params: {
  migration: LcxIdentityDeviceAuthMigration;
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  expectedReadPath?: string;
  expectedWritePath?: string;
}): Promise<{ entry: DeviceAuthEntry; receipt: LcxIdentityWriteReceipt }> {
  const existing = await readDeviceAuthStoreForIdentityMigration(params.migration);
  const role = normalizeDeviceAuthRole(params.role);
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens: existing?.deviceId === params.deviceId && existing.tokens ? { ...existing.tokens } : {},
  };
  const entry: DeviceAuthEntry = {
    token: params.token,
    role,
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  next.tokens[role] = entry;
  const receipt = await writeDeviceAuthStoreForIdentityMigration(params.migration, next, {
    expectedReadPath: params.expectedReadPath,
    expectedWritePath: params.expectedWritePath,
  });
  return { entry, receipt };
}

export async function clearDeviceAuthTokenForIdentityMigration(params: {
  migration: LcxIdentityDeviceAuthMigration;
  deviceId: string;
  role: string;
  expectedReadPath?: string;
  expectedWritePath?: string;
}): Promise<LcxIdentityWriteReceipt | null> {
  const existing = await readDeviceAuthStoreForIdentityMigration(params.migration);
  if (!existing || existing.deviceId !== params.deviceId) {
    return null;
  }
  const role = normalizeDeviceAuthRole(params.role);
  if (!existing.tokens[role]) {
    return null;
  }
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: existing.deviceId,
    tokens: { ...existing.tokens },
  };
  delete next.tokens[role];
  return await writeDeviceAuthStoreForIdentityMigration(params.migration, next, {
    expectedReadPath: params.expectedReadPath,
    expectedWritePath: params.expectedWritePath,
  });
}

export async function rollbackDeviceAuthIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  const filePath = resolveDeviceAuthPath(params.env);
  return loadDeviceAuthTokenFromStore({
    adapter: { readStore: () => readStore(filePath), writeStore: (_store) => {} },
    deviceId: params.deviceId,
    role: params.role,
  });
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry {
  const filePath = resolveDeviceAuthPath(params.env);
  return storeDeviceAuthTokenInStore({
    adapter: {
      readStore: () => readStore(filePath),
      writeStore: (store) => writeStore(filePath, store),
    },
    deviceId: params.deviceId,
    role: params.role,
    token: params.token,
    scopes: params.scopes,
  });
}

export function clearDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const filePath = resolveDeviceAuthPath(params.env);
  clearDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => readStore(filePath),
      writeStore: (store) => writeStore(filePath, store),
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}
