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
import { logWarn } from "../logger.js";
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
import { saveJsonFile } from "./json-file.js";
import { describeReadFailure } from "./unreadable-source.js";

const DEVICE_AUTH_FILE = "device-auth.json";
const DEVICE_AUTH_RELATIVE_PATH = path.join("identity", DEVICE_AUTH_FILE);

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}

type DeviceAuthStoreRead =
  | { status: "ok"; store: DeviceAuthStore }
  | { status: "absent" }
  | { status: "unreadable"; detail: string };

/**
 * "No store yet" and "a store that could not be read or parsed" are different answers. They used
 * to collapse into `null`, and every caller that then wrote a store built around the one token it
 * was handed replaced the file — dropping the tokens for every other device and role in it.
 */
function readStoreDetailed(filePath: string): DeviceAuthStoreRead {
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) {
      return { status: "absent" };
    }
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const failure = describeReadFailure(err);
    return { status: "unreadable", detail: `${failure.status}/${failure.code}` };
  }
  let parsed: DeviceAuthStore;
  try {
    parsed = JSON.parse(raw) as DeviceAuthStore;
  } catch {
    return { status: "unreadable", detail: "parse-failed" };
  }
  if (parsed?.version !== 1) {
    // A format we do not understand may still hold tokens we would be destroying.
    return { status: "unreadable", detail: "unrecognised-version" };
  }
  if (typeof parsed.deviceId !== "string" || !parsed.tokens || typeof parsed.tokens !== "object") {
    // Recognised format, and nothing in it we would lose — same as starting fresh.
    return { status: "absent" };
  }
  return { status: "ok", store: parsed };
}

/** Read-only path: no write follows, so "cannot see it" may be answered as "no token". */
function readStore(filePath: string): DeviceAuthStore | null {
  const result = readStoreDetailed(filePath);
  if (result.status === "unreadable") {
    logWarn(
      `[device-auth] cannot read ${filePath} (${result.detail}); answering as no stored token`,
    );
    return null;
  }
  return result.status === "ok" ? result.store : null;
}

/** Write path: refuse to replace a store we were never able to look inside. */
function readStoreForWrite(filePath: string): DeviceAuthStore | null {
  const result = readStoreDetailed(filePath);
  if (result.status === "unreadable") {
    throw new Error(
      `cannot read device auth store at ${filePath} (${result.detail}); refusing to replace tokens that could not be read`,
    );
  }
  return result.status === "ok" ? result.store : null;
}

function writeStore(filePath: string, store: DeviceAuthStore): void {
  saveJsonFile(filePath, store);
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
      readStore: () => readStoreForWrite(filePath),
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
      readStore: () => readStoreForWrite(filePath),
      writeStore: (store) => writeStore(filePath, store),
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}
