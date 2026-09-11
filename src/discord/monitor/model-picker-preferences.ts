import os from "node:os";
import path from "node:path";
import { normalizeProviderId } from "../../agents/model-selection.js";
import {
  readLcxIdentityWriterRaw,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../../config/identity-migration.js";
import { resolveStateDir, type LcxIdentityMigrationPlan } from "../../config/paths.js";
import { withFileLock } from "../../infra/file-lock.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";
import { normalizeAccountId as normalizeSharedAccountId } from "../../routing/account-id.js";

const MODEL_PICKER_PREFERENCES_LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 5_000,
    randomize: true,
  },
  stale: 15_000,
} as const;

const DEFAULT_RECENT_LIMIT = 5;

type ModelPickerPreferencesEntry = {
  recent: string[];
  updatedAt: string;
};

export type DiscordModelPickerPreferencesStore = {
  version: 1;
  entries: Record<string, ModelPickerPreferencesEntry>;
};

export type LcxIdentityDiscordModelPickerPreferencesMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "discord-model-picker" }>;
  relativePath: string;
  readPreferencesPath: string;
  writePreferencesPath: string;
}>;

export type DiscordModelPickerPreferenceScope = {
  accountId?: string;
  guildId?: string;
  userId: string;
};

function resolvePreferencesStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return path.join(stateDir, "discord", "model-picker-preferences.json");
}

export function createLcxIdentityDiscordModelPickerPreferencesMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityDiscordModelPickerPreferencesMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Discord model picker migration requires a state-root authority");
  }
  const relativePath = path.join("discord", "model-picker-preferences.json");
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "discord-model-picker",
    migrationPlan: params.migrationPlan,
    relativePath,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    relativePath,
    readPreferencesPath: pathContract.readPath,
    writePreferencesPath: pathContract.writePath,
  });
}

function resolveCurrentDiscordModelPickerPathContract(
  migration: LcxIdentityDiscordModelPickerPreferencesMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "discord-model-picker" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "discord-model-picker",
    migrationPlan: plan,
    relativePath: migration.relativePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

function normalizeId(value?: string): string {
  return value?.trim() ?? "";
}

export function buildDiscordModelPickerPreferenceKey(
  scope: DiscordModelPickerPreferenceScope,
): string | null {
  const userId = normalizeId(scope.userId);
  if (!userId) {
    return null;
  }
  const accountId = normalizeSharedAccountId(scope.accountId);
  const guildId = normalizeId(scope.guildId);
  if (guildId) {
    return `discord:${accountId}:guild:${guildId}:user:${userId}`;
  }
  return `discord:${accountId}:dm:user:${userId}`;
}

function normalizeModelRef(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= value.length - 1) {
    return null;
  }
  const provider = normalizeProviderId(value.slice(0, slashIndex));
  const model = value.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return `${provider}/${model}`;
}

function sanitizeRecentModels(models: string[] | undefined, limit: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of models ?? []) {
    const normalized = normalizeModelRef(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped;
}

async function readPreferencesStore(filePath: string): Promise<DiscordModelPickerPreferencesStore> {
  const { value } = await readJsonFileWithFallback<DiscordModelPickerPreferencesStore>(filePath, {
    version: 1,
    entries: {},
  });
  if (!value || typeof value !== "object" || value.version !== 1) {
    return { version: 1, entries: {} };
  }
  return {
    version: 1,
    entries: value.entries && typeof value.entries === "object" ? value.entries : {},
  };
}

export async function readDiscordModelPickerPreferencesForIdentityMigration(
  migration: LcxIdentityDiscordModelPickerPreferencesMigration,
): Promise<DiscordModelPickerPreferencesStore> {
  const raw = await readLcxIdentityWriterRaw(
    resolveCurrentDiscordModelPickerPathContract(migration),
  );
  if (raw === null) {
    return { version: 1, entries: {} };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { version: 1, entries: {} };
    }
    const store = parsed as Partial<DiscordModelPickerPreferencesStore>;
    return {
      version: 1,
      entries: store.entries && typeof store.entries === "object" ? store.entries : {},
    };
  } catch {
    return { version: 1, entries: {} };
  }
}

export async function writeDiscordModelPickerPreferencesForIdentityMigration(
  migration: LcxIdentityDiscordModelPickerPreferencesMigration,
  store: DiscordModelPickerPreferencesStore,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  return await writeLcxIdentityWriterRawWithReceipt(
    resolveCurrentDiscordModelPickerPathContract(migration),
    `${JSON.stringify(store, null, 2)}\n`,
    options,
  );
}

export async function recordDiscordModelPickerRecentModelForIdentityMigration(params: {
  migration: LcxIdentityDiscordModelPickerPreferencesMigration;
  scope: DiscordModelPickerPreferenceScope;
  modelRef: string;
  limit?: number;
}): Promise<LcxIdentityWriteReceipt | null> {
  const key = buildDiscordModelPickerPreferenceKey(params.scope);
  const normalizedModelRef = normalizeModelRef(params.modelRef);
  if (!key || !normalizedModelRef) {
    return null;
  }
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
  const store = await readDiscordModelPickerPreferencesForIdentityMigration(params.migration);
  const existing = sanitizeRecentModels(store.entries[key]?.recent, limit);
  store.entries[key] = {
    recent: [normalizedModelRef, ...existing.filter((entry) => entry !== normalizedModelRef)].slice(
      0,
      limit,
    ),
    updatedAt: new Date().toISOString(),
  };
  return await writeDiscordModelPickerPreferencesForIdentityMigration(params.migration, store);
}

export async function rollbackDiscordModelPickerIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export async function readDiscordModelPickerRecentModels(params: {
  scope: DiscordModelPickerPreferenceScope;
  limit?: number;
  allowedModelRefs?: Set<string>;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const key = buildDiscordModelPickerPreferenceKey(params.scope);
  if (!key) {
    return [];
  }
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
  const filePath = resolvePreferencesStorePath(params.env);
  const store = await readPreferencesStore(filePath);
  const entry = store.entries[key];
  const recent = sanitizeRecentModels(entry?.recent, limit);
  if (!params.allowedModelRefs || params.allowedModelRefs.size === 0) {
    return recent;
  }
  return recent.filter((modelRef) => params.allowedModelRefs?.has(modelRef));
}

export async function recordDiscordModelPickerRecentModel(params: {
  scope: DiscordModelPickerPreferenceScope;
  modelRef: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const key = buildDiscordModelPickerPreferenceKey(params.scope);
  const normalizedModelRef = normalizeModelRef(params.modelRef);
  if (!key || !normalizedModelRef) {
    return;
  }

  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
  const filePath = resolvePreferencesStorePath(params.env);

  await withFileLock(filePath, MODEL_PICKER_PREFERENCES_LOCK_OPTIONS, async () => {
    const store = await readPreferencesStore(filePath);
    const existing = sanitizeRecentModels(store.entries[key]?.recent, limit);
    const next = [
      normalizedModelRef,
      ...existing.filter((entry) => entry !== normalizedModelRef),
    ].slice(0, limit);

    store.entries[key] = {
      recent: next,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomically(filePath, store);
  });
}
