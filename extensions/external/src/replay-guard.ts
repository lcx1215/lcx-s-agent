import fs from "node:fs";
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
  resolveLcxIdentityMigrationPlan,
} from "lcx-agent/plugin-sdk";

const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_SIZE = 1_000;
const DEFAULT_FILE_MAX_ENTRIES = 10_000;

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/[^a-zA-Z0-9_-]/g, "_") : "default";
}

function resolveDefaultStateDir(): string {
  return resolveLcxIdentityMigrationPlan().readStateDir;
}

export type ExternalReplayGuardOptions = {
  stateDir?: string;
  ttlMs?: number;
  memoryMaxSize?: number;
  fileMaxEntries?: number;
  onDiskError?: (error: unknown) => void;
};

export type ExternalReplayOutcome = "completed" | "retryable_before_dispatch" | "delivery_unknown";
export type ExternalReplayClaim = { settle: (outcome: ExternalReplayOutcome) => Promise<void> };
export type ExternalReplayGuard = {
  /** Legacy terminal admission; callers with a processing lifecycle use claimMessage. */
  shouldProcessMessage: (params: { accountId: string; messageId: string }) => Promise<boolean>;
  claimMessage: (params: {
    accountId: string;
    messageId: string;
  }) => Promise<ExternalReplayClaim | undefined>;
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

  const processing = new Map<string, number>();
  let lastClaimAt = 0;
  const claimKey = (accountId: string, messageId: string) => JSON.stringify([accountId, messageId]);
  const claimMessage: ExternalReplayGuard["claimMessage"] = async ({ accountId, messageId }) => {
    const trimmedMessageId = messageId.trim();
    if (!trimmedMessageId) {
      return { settle: async () => {} };
    }
    const key = claimKey(accountId, trimmedMessageId);
    if (processing.has(key)) {
      return undefined;
    }
    const recordedAt = Math.max(Date.now(), lastClaimAt + 1);
    lastClaimAt = recordedAt;
    processing.set(key, recordedAt);
    try {
      const accepted = await persistentDedupe.checkAndRecord(trimmedMessageId, {
        namespace: accountId,
        now: recordedAt,
        requirePersistence: true,
      });
      if (!accepted) {
        processing.delete(key);
        return undefined;
      }
    } catch (error) {
      processing.delete(key);
      throw error;
    }
    let consumed = false;
    return {
      settle: async (outcome) => {
        if (consumed) {
          return;
        }
        consumed = true;
        if (processing.get(key) !== recordedAt) {
          throw new Error("external replay claim ownership changed");
        }
        const settled = await persistentDedupe.settleClaim(trimmedMessageId, {
          namespace: accountId,
          recordedAt,
          retryable: outcome === "retryable_before_dispatch",
        });
        if (!settled) {
          throw new Error("external replay reservation changed; recovery remains blocked");
        }
        // Completed and uncertain dispatches retain the durable reservation across restarts.
        processing.delete(key);
      },
    };
  };
  return {
    claimMessage,
    shouldProcessMessage: async (params) => {
      const claim = await claimMessage(params);
      if (!claim) {
        return false;
      }
      await claim.settle("completed");
      return true;
    },
  };
}
