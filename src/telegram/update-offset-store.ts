import fs from "node:fs/promises";
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
} from "../config/identity-migration.js";
import { resolveStateDir } from "../config/paths.js";
import type { LcxIdentityMigrationPlan } from "../config/paths.js";
import { writeJsonAtomic } from "../infra/json-files.js";

const STORE_VERSION = 2;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
};

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function resolveTelegramUpdateOffsetPath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "telegram", `update-offset-${normalized}.json`);
}

export type LcxIdentityTelegramUpdateOffsetMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "telegram-offset" }>;
  relativePath: string;
  accountId: string;
  readOffsetPath: string;
  writeOffsetPath: string;
}>;

export function createLcxIdentityTelegramUpdateOffsetMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  accountId?: string;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityTelegramUpdateOffsetMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Telegram update offset migration requires a state-root authority");
  }
  const accountId = normalizeAccountId(params.accountId);
  const relativePath = path.join("telegram", `update-offset-${accountId}.json`);
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "telegram-offset",
    migrationPlan: params.migrationPlan,
    relativePath,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    relativePath,
    accountId,
    readOffsetPath: pathContract.readPath,
    writeOffsetPath: pathContract.writePath,
  });
}

function resolveCurrentTelegramUpdateOffsetPathContract(
  migration: LcxIdentityTelegramUpdateOffsetMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "telegram-offset" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "telegram-offset",
    migrationPlan: plan,
    relativePath: migration.relativePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

function extractBotIdFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  const [rawBotId] = trimmed.split(":", 1);
  if (!rawBotId || !/^\d+$/.test(rawBotId)) {
    return null;
  }
  return rawBotId;
}

function safeParseState(raw: string): TelegramUpdateOffsetState | null {
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      lastUpdateId?: number | null;
      botId?: string | null;
    };
    if (parsed?.version !== STORE_VERSION && parsed?.version !== 1) {
      return null;
    }
    if (parsed.lastUpdateId !== null && typeof parsed.lastUpdateId !== "number") {
      return null;
    }
    if (
      parsed.version === STORE_VERSION &&
      parsed.botId !== null &&
      typeof parsed.botId !== "string"
    ) {
      return null;
    }
    return {
      version: STORE_VERSION,
      lastUpdateId: parsed.lastUpdateId ?? null,
      botId: parsed.version === STORE_VERSION ? (parsed.botId ?? null) : null,
    };
  } catch {
    return null;
  }
}

function readParsedOffset(raw: string | null, botToken?: string): number | null {
  if (raw === null) {
    return null;
  }
  const parsed = safeParseState(raw);
  const expectedBotId = extractBotIdFromToken(botToken);
  if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) {
    return null;
  }
  if (expectedBotId && parsed?.botId === null) {
    return null;
  }
  return parsed?.lastUpdateId ?? null;
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number | null> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return readParsedOffset(raw, params.botToken);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function readTelegramUpdateOffsetForIdentityMigration(params: {
  migration: LcxIdentityTelegramUpdateOffsetMigration;
  botToken?: string;
}): Promise<number | null> {
  const raw = await readLcxIdentityWriterRaw(
    resolveCurrentTelegramUpdateOffsetPathContract(params.migration),
  );
  return readParsedOffset(raw, params.botToken);
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    botId: extractBotIdFromToken(params.botToken),
  };
  await writeJsonAtomic(filePath, payload, {
    mode: 0o600,
    trailingNewline: true,
    ensureDirMode: 0o700,
  });
}

export async function writeTelegramUpdateOffsetForIdentityMigration(params: {
  migration: LcxIdentityTelegramUpdateOffsetMigration;
  updateId: number;
  botToken?: string;
  options?: { expectedReadPath?: string; expectedWritePath?: string };
}): Promise<LcxIdentityWriteReceipt> {
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    botId: extractBotIdFromToken(params.botToken),
  };
  return await writeLcxIdentityWriterRawWithReceipt(
    resolveCurrentTelegramUpdateOffsetPathContract(params.migration),
    `${JSON.stringify(payload, null, 2)}\n`,
    params.options,
  );
}

export async function rollbackTelegramUpdateOffsetIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}

export async function deleteTelegramUpdateOffsetForIdentityMigration(
  migration: LcxIdentityTelegramUpdateOffsetMigration,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityRemovalReceipt> {
  return await removeLcxIdentityWriterWithReceipt(
    resolveCurrentTelegramUpdateOffsetPathContract(migration),
    options,
  );
}

export async function rollbackDeletedTelegramUpdateOffsetIdentityMigration(
  receipt: LcxIdentityRemovalReceipt,
): Promise<void> {
  await rollbackLcxIdentityRemoval(receipt);
}
