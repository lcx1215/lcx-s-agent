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
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

export type VoiceWakeConfig = {
  triggers: string[];
  updatedAtMs: number;
};

const DEFAULT_TRIGGERS = ["openclaw", "claude", "computer"];

function resolvePath(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, "settings", "voicewake.json");
}

function sanitizeTriggers(triggers: string[] | undefined | null): string[] {
  const cleaned = (triggers ?? [])
    .map((w) => (typeof w === "string" ? w.trim() : ""))
    .filter((w) => w.length > 0);
  return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}

const withLock = createAsyncLock();

const VOICE_WAKE_RELATIVE_PATH = path.join("settings", "voicewake.json");

export type LcxIdentityVoiceWakeMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "voicewake" }>;
  readStatePath: string;
  writeStatePath: string;
}>;

export function createLcxIdentityVoiceWakeMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityVoiceWakeMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Voice wake migration requires a state-root authority");
  }
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "voicewake",
    migrationPlan: params.migrationPlan,
    relativePath: VOICE_WAKE_RELATIVE_PATH,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    readStatePath: pathContract.readPath,
    writeStatePath: pathContract.writePath,
  });
}

function resolveCurrentVoiceWakePathContract(
  migration: LcxIdentityVoiceWakeMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "voicewake" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "voicewake",
    migrationPlan: plan,
    relativePath: VOICE_WAKE_RELATIVE_PATH,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export async function readVoiceWakeConfigForIdentityMigration(
  migration: LcxIdentityVoiceWakeMigration,
): Promise<VoiceWakeConfig> {
  const raw = await readLcxIdentityWriterRaw(resolveCurrentVoiceWakePathContract(migration));
  if (raw === null) {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as VoiceWakeConfig;
    return {
      triggers: sanitizeTriggers(parsed.triggers),
      updatedAtMs:
        typeof parsed.updatedAtMs === "number" && parsed.updatedAtMs > 0 ? parsed.updatedAtMs : 0,
    };
  } catch {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
}

export async function writeVoiceWakeConfigForIdentityMigration(
  migration: LcxIdentityVoiceWakeMigration,
  config: VoiceWakeConfig,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const normalized: VoiceWakeConfig = {
    triggers: sanitizeTriggers(config.triggers),
    updatedAtMs:
      typeof config.updatedAtMs === "number" && config.updatedAtMs > 0 ? config.updatedAtMs : 0,
  };
  return await writeLcxIdentityWriterRawWithReceipt(
    resolveCurrentVoiceWakePathContract(migration),
    `${JSON.stringify(normalized, null, 2)}\n`,
    options,
  );
}

export async function rollbackVoiceWakeIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export function defaultVoiceWakeTriggers() {
  return [...DEFAULT_TRIGGERS];
}

export async function loadVoiceWakeConfig(baseDir?: string): Promise<VoiceWakeConfig> {
  const filePath = resolvePath(baseDir);
  const existing = await readJsonFile<VoiceWakeConfig>(filePath);
  if (!existing) {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
  return {
    triggers: sanitizeTriggers(existing.triggers),
    updatedAtMs:
      typeof existing.updatedAtMs === "number" && existing.updatedAtMs > 0
        ? existing.updatedAtMs
        : 0,
  };
}

export async function setVoiceWakeTriggers(
  triggers: string[],
  baseDir?: string,
): Promise<VoiceWakeConfig> {
  const sanitized = sanitizeTriggers(triggers);
  const filePath = resolvePath(baseDir);
  return await withLock(async () => {
    const next: VoiceWakeConfig = {
      triggers: sanitized,
      updatedAtMs: Date.now(),
    };
    await writeJsonAtomic(filePath, next);
    return next;
  });
}
