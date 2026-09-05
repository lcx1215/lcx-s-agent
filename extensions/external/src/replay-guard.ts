import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistentDedupe } from "lcx-agent/plugin-sdk";
import {
  createLcxIdentityWriterPathContract,
  readLcxIdentityWriterRaw,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  LcxIdentityWriterContractError,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
  type LcxIdentityMigrationPlan,
} from "lcx-agent/plugin-sdk";

const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_SIZE = 1_000;
const DEFAULT_FILE_MAX_ENTRIES = 10_000;

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/[^a-zA-Z0-9_-]/g, "_") : "default";
}

function resolveDefaultStateDir(): string {
  const configured =
    process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (configured) {
    return path.resolve(configured.replace(/^~(?=$|\/)/u, os.homedir()));
  }
  return path.join(os.homedir(), ".openclaw");
}

export type ExternalReplayGuardOptions = {
  stateDir?: string;
  ttlMs?: number;
  memoryMaxSize?: number;
  fileMaxEntries?: number;
  onDiskError?: (error: unknown) => void;
};

export type ExternalReplayGuard = {
  shouldProcessMessage: (params: { accountId: string; messageId: string }) => Promise<boolean>;
};

export type LcxIdentityExternalReplayMigration = Readonly<{
  namespace: string;
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "channel-local" }>;
  readStatePath: string;
  writeStatePath: string;
}>;

function resolveExternalReplayReadRoot(
  migrationPlan: LcxIdentityMigrationPlan,
  namespace: string,
  existsSync: (candidate: string) => boolean,
): string {
  const relativePath = path.join("external", "replay-dedupe", `${sanitizeSegment(namespace)}.json`);
  const writePath = path.join(migrationPlan.writeStateDir, relativePath);
  if (existsSync(writePath)) {
    return migrationPlan.writeStateDir;
  }
  const legacyRoots = migrationPlan.readStateDirs.filter((root) => {
    if (path.resolve(root) === path.resolve(migrationPlan.writeStateDir)) {
      return false;
    }
    return existsSync(path.join(root, relativePath));
  });
  if (legacyRoots.length > 1) {
    throw new LcxIdentityWriterContractError(
      `External replay state exists in multiple legacy roots: ${legacyRoots.join(", ")}`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  return legacyRoots[0] ?? migrationPlan.readStateDir;
}

function resolveCurrentExternalReplayMigration(
  migration: LcxIdentityExternalReplayMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "channel-local" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  const relativePath = path.relative(plan.writeStateDir, migration.writeStatePath);
  const readRoot = resolveExternalReplayReadRoot(plan, migration.namespace, fs.existsSync);
  return createLcxIdentityWriterPathContract({
    writer: "channel-local",
    migrationPlan: plan,
    readPath: path.join(readRoot, relativePath),
    writePath: migration.writeStatePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export function createLcxIdentityExternalReplayMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  namespace: string;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityExternalReplayMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("External replay migration requires a state-root authority");
  }
  const namespace = params.namespace.trim() || "global";
  const relativePath = path.join("external", "replay-dedupe", `${sanitizeSegment(namespace)}.json`);
  const readRoot = resolveExternalReplayReadRoot(
    params.migrationPlan,
    namespace,
    params.existsSync ?? fs.existsSync,
  );
  const writeStatePath = path.join(params.migrationPlan.writeStateDir, relativePath);
  const pathContract = createLcxIdentityWriterPathContract({
    writer: "channel-local",
    migrationPlan: params.migrationPlan,
    readPath: path.join(readRoot, relativePath),
    writePath: writeStatePath,
  });
  return Object.freeze({
    namespace,
    pathContract,
    readStatePath: pathContract.readPath,
    writeStatePath,
  });
}

function parseReplayState(raw: string | null): Record<string, number> {
  if (raw === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0,
      ),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function readExternalReplayStateForIdentityMigration(
  migration: LcxIdentityExternalReplayMigration,
): Promise<Record<string, number>> {
  return parseReplayState(
    await readLcxIdentityWriterRaw(resolveCurrentExternalReplayMigration(migration)),
  );
}

export async function writeExternalReplayStateForIdentityMigration(
  migration: LcxIdentityExternalReplayMigration,
  state: Record<string, number>,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const normalized = Object.fromEntries(
    Object.entries(state).filter(
      ([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0,
    ),
  );
  return await writeLcxIdentityWriterRawWithReceipt(
    resolveCurrentExternalReplayMigration(migration),
    `${JSON.stringify(normalized, null, 2)}\n`,
    options,
  );
}

export async function rollbackExternalReplayIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export function createExternalReplayGuard(
  options: ExternalReplayGuardOptions = {},
): ExternalReplayGuard {
  const stateDir = path.resolve(options.stateDir?.trim() || resolveDefaultStateDir());
  const persistentDedupe = createPersistentDedupe({
    ttlMs: options.ttlMs ?? DEFAULT_REPLAY_TTL_MS,
    memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
    fileMaxEntries: options.fileMaxEntries ?? DEFAULT_FILE_MAX_ENTRIES,
    resolveFilePath: (namespace) =>
      path.join(stateDir, "external", "replay-dedupe", `${sanitizeSegment(namespace)}.json`),
    onDiskError: options.onDiskError,
  });

  return {
    shouldProcessMessage: async ({ accountId, messageId }) => {
      const trimmedMessageId = messageId.trim();
      if (!trimmedMessageId) {
        return true;
      }
      return await persistentDedupe.checkAndRecord(trimmedMessageId, {
        namespace: accountId,
      });
    },
  };
}
