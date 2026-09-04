import path from "node:path";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import {
  readLcxIdentityWriterRaw,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../identity-migration.js";
import type { LcxIdentityMigrationPlan } from "../paths.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import type { SessionEntry } from "./types.js";

export type LcxIdentitySessionMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "sessions" }>;
  agentId: string;
  readSessionsDir: string;
  writeSessionsDir: string;
  readStorePath: string;
  writeStorePath: string;
}>;

export function createLcxIdentitySessionMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  agentId?: string;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentitySessionMigration {
  const agentId = normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID);
  const relativePath = path.join("agents", agentId, "sessions", "sessions.json");
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "sessions",
    migrationPlan: params.migrationPlan,
    relativePath,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    agentId,
    readSessionsDir: path.dirname(pathContract.readPath),
    writeSessionsDir: path.dirname(pathContract.writePath),
    readStorePath: pathContract.readPath,
    writeStorePath: pathContract.writePath,
  });
}

export async function readSessionStoreForIdentityMigration(
  migration: LcxIdentitySessionMigration,
): Promise<Record<string, SessionEntry>> {
  const raw = await readLcxIdentityWriterRaw(migration.pathContract);
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, SessionEntry>;
  } catch {
    return {};
  }
}

export async function writeSessionStoreForIdentityMigration(
  migration: LcxIdentitySessionMigration,
  store: Record<string, SessionEntry>,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const raw = JSON.stringify(store, null, 2);
  return await writeLcxIdentityWriterRawWithReceipt(migration.pathContract, raw, options);
}

export async function rollbackSessionStoreIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export function resolveIdentityMigrationTranscriptPath(
  migration: LcxIdentitySessionMigration,
  sessionId: string,
  topicId?: string | number,
): string {
  return resolveSessionTranscriptPathInDir(sessionId, migration.writeSessionsDir, topicId);
}
