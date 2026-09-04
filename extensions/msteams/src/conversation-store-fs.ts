import fs from "node:fs";
import path from "node:path";
import {
  createLcxIdentityWriterPathContract,
  readLcxIdentityWriterRaw,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  LcxIdentityWriterContractError,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../../../src/config/identity-migration.js";
import type { LcxIdentityMigrationPlan } from "../../../src/config/paths.js";
import type {
  MSTeamsConversationStore,
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";

export type MSTeamsConversationStoreData = {
  version: 1;
  conversations: Record<string, StoredConversationReference & { lastSeenAt?: string }>;
};

const STORE_FILENAME = "msteams-conversations.json";
const MAX_CONVERSATIONS = 1000;
const CONVERSATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function pruneToLimit(
  conversations: Record<string, StoredConversationReference & { lastSeenAt?: string }>,
) {
  const entries = Object.entries(conversations);
  if (entries.length <= MAX_CONVERSATIONS) {
    return conversations;
  }

  entries.sort((a, b) => {
    const aTs = parseTimestamp(a[1].lastSeenAt) ?? 0;
    const bTs = parseTimestamp(b[1].lastSeenAt) ?? 0;
    return aTs - bTs;
  });

  const keep = entries.slice(entries.length - MAX_CONVERSATIONS);
  return Object.fromEntries(keep);
}

function pruneExpired(
  conversations: Record<string, StoredConversationReference & { lastSeenAt?: string }>,
  nowMs: number,
  ttlMs: number,
) {
  let removed = false;
  const kept: typeof conversations = {};
  for (const [conversationId, reference] of Object.entries(conversations)) {
    const lastSeenAt = parseTimestamp(reference.lastSeenAt);
    // Preserve legacy entries that have no lastSeenAt until they're seen again.
    if (lastSeenAt != null && nowMs - lastSeenAt > ttlMs) {
      removed = true;
      continue;
    }
    kept[conversationId] = reference;
  }
  return { conversations: kept, removed };
}

function normalizeConversationId(raw: string): string {
  return raw.split(";")[0] ?? raw;
}

export function createMSTeamsConversationStoreFs(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  ttlMs?: number;
  stateDir?: string;
  storePath?: string;
}): MSTeamsConversationStore {
  const ttlMs = params?.ttlMs ?? CONVERSATION_TTL_MS;
  const filePath = resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });

  const empty: MSTeamsConversationStoreData = { version: 1, conversations: {} };

  const readStore = async (): Promise<MSTeamsConversationStoreData> => {
    const { value } = await readJsonFile<MSTeamsConversationStoreData>(filePath, empty);
    if (
      value.version !== 1 ||
      !value.conversations ||
      typeof value.conversations !== "object" ||
      Array.isArray(value.conversations)
    ) {
      return empty;
    }
    const nowMs = Date.now();
    const pruned = pruneExpired(value.conversations, nowMs, ttlMs).conversations;
    return { version: 1, conversations: pruneToLimit(pruned) };
  };

  const list = async (): Promise<MSTeamsConversationStoreEntry[]> => {
    const store = await readStore();
    return Object.entries(store.conversations).map(([conversationId, reference]) => ({
      conversationId,
      reference,
    }));
  };

  const get = async (conversationId: string): Promise<StoredConversationReference | null> => {
    const store = await readStore();
    return store.conversations[normalizeConversationId(conversationId)] ?? null;
  };

  const findByUserId = async (id: string): Promise<MSTeamsConversationStoreEntry | null> => {
    const target = id.trim();
    if (!target) {
      return null;
    }
    for (const entry of await list()) {
      const { conversationId, reference } = entry;
      if (reference.user?.aadObjectId === target) {
        return { conversationId, reference };
      }
      if (reference.user?.id === target) {
        return { conversationId, reference };
      }
    }
    return null;
  };

  const upsert = async (
    conversationId: string,
    reference: StoredConversationReference,
  ): Promise<void> => {
    const normalizedId = normalizeConversationId(conversationId);
    await withFileLock(filePath, empty, async () => {
      const store = await readStore();
      store.conversations[normalizedId] = {
        ...reference,
        lastSeenAt: new Date().toISOString(),
      };
      const nowMs = Date.now();
      store.conversations = pruneExpired(store.conversations, nowMs, ttlMs).conversations;
      store.conversations = pruneToLimit(store.conversations);
      await writeJsonFile(filePath, store);
    });
  };

  const remove = async (conversationId: string): Promise<boolean> => {
    const normalizedId = normalizeConversationId(conversationId);
    return await withFileLock(filePath, empty, async () => {
      const store = await readStore();
      if (!(normalizedId in store.conversations)) {
        return false;
      }
      delete store.conversations[normalizedId];
      await writeJsonFile(filePath, store);
      return true;
    });
  };

  return { upsert, get, list, remove, findByUserId };
}

export type LcxIdentityMSTeamsConversationMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "channel-local" }>;
  readStorePath: string;
  writeStorePath: string;
}>;

function resolveMSTeamsMigrationReadRoot(
  migrationPlan: LcxIdentityMigrationPlan,
  existsSync: (candidate: string) => boolean,
): string {
  const writePath = path.join(migrationPlan.writeStateDir, STORE_FILENAME);
  if (existsSync(writePath)) {
    return migrationPlan.writeStateDir;
  }
  const legacyRoots = migrationPlan.readStateDirs.filter((root) => {
    if (path.resolve(root) === path.resolve(migrationPlan.writeStateDir)) {
      return false;
    }
    return existsSync(path.join(root, STORE_FILENAME));
  });
  if (legacyRoots.length > 1) {
    throw new LcxIdentityWriterContractError(
      `MSTeams conversation state exists in multiple legacy roots: ${legacyRoots.join(", ")}`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  return legacyRoots[0] ?? migrationPlan.readStateDir;
}

function resolveCurrentMSTeamsMigration(
  migration: LcxIdentityMSTeamsConversationMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "channel-local" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  const readRoot = resolveMSTeamsMigrationReadRoot(plan, fs.existsSync);
  return createLcxIdentityWriterPathContract({
    writer: "channel-local",
    migrationPlan: plan,
    readPath: path.join(readRoot, STORE_FILENAME),
    writePath: migration.writeStorePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export function createLcxIdentityMSTeamsConversationMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityMSTeamsConversationMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("MSTeams conversation migration requires a state-root authority");
  }
  const existsSync = params.existsSync ?? fs.existsSync;
  const readRoot = resolveMSTeamsMigrationReadRoot(params.migrationPlan, existsSync);
  const writeStorePath = path.join(params.migrationPlan.writeStateDir, STORE_FILENAME);
  const pathContract = createLcxIdentityWriterPathContract({
    writer: "channel-local",
    migrationPlan: params.migrationPlan,
    readPath: path.join(readRoot, STORE_FILENAME),
    writePath: writeStorePath,
  });
  return Object.freeze({
    pathContract,
    readStorePath: pathContract.readPath,
    writeStorePath,
  });
}

function parseMSTeamsConversationStore(raw: string | null): MSTeamsConversationStoreData {
  if (raw === null) {
    return { version: 1, conversations: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MSTeamsConversationStoreData>;
    if (
      parsed.version !== 1 ||
      !parsed.conversations ||
      typeof parsed.conversations !== "object" ||
      Array.isArray(parsed.conversations)
    ) {
      return { version: 1, conversations: {} };
    }
    return {
      version: 1,
      conversations: parsed.conversations as MSTeamsConversationStoreData["conversations"],
    };
  } catch {
    return { version: 1, conversations: {} };
  }
}

export async function readMSTeamsConversationStoreForIdentityMigration(
  migration: LcxIdentityMSTeamsConversationMigration,
): Promise<MSTeamsConversationStoreData> {
  const raw = await readLcxIdentityWriterRaw(resolveCurrentMSTeamsMigration(migration));
  return parseMSTeamsConversationStore(raw);
}

export async function writeMSTeamsConversationStoreForIdentityMigration(
  migration: LcxIdentityMSTeamsConversationMigration,
  store: MSTeamsConversationStoreData,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const normalized: MSTeamsConversationStoreData = {
    version: 1,
    conversations: store.conversations,
  };
  return await writeLcxIdentityWriterRawWithReceipt(
    resolveCurrentMSTeamsMigration(migration),
    `${JSON.stringify(normalized, null, 2)}\n`,
    options,
  );
}

export async function rollbackMSTeamsConversationIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
