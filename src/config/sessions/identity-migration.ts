import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import {
  createLcxIdentityWriterPathContract,
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
  relativePath: string;
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
    relativePath,
    agentId,
    readSessionsDir: path.dirname(pathContract.readPath),
    writeSessionsDir: path.dirname(pathContract.writePath),
    readStorePath: pathContract.readPath,
    writeStorePath: pathContract.writePath,
  });
}

export function resolveCurrentSessionIdentityPathContract(
  migration: LcxIdentitySessionMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "sessions" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "sessions",
    migrationPlan: plan,
    relativePath: migration.relativePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export async function readSessionStoreForIdentityMigration(
  migration: LcxIdentitySessionMigration,
): Promise<Record<string, SessionEntry>> {
  const raw = await readLcxIdentityWriterRaw(resolveCurrentSessionIdentityPathContract(migration));
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
  const pathContract = resolveCurrentSessionIdentityPathContract(migration);
  const raw = JSON.stringify(store, null, 2);
  return await writeLcxIdentityWriterRawWithReceipt(pathContract, raw, options);
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
  const pathContract = resolveCurrentSessionIdentityPathContract(migration);
  return resolveSessionTranscriptPathInDir(
    sessionId,
    path.dirname(pathContract.writePath),
    topicId,
  );
}

export async function appendSessionTranscriptForIdentityMigration(params: {
  migration: LcxIdentitySessionMigration;
  sessionId: string;
  text: string;
  topicId?: string | number;
}): Promise<{ sessionFile: string; receipt: LcxIdentityWriteReceipt }> {
  const sessionFile = resolveIdentityMigrationTranscriptPath(
    params.migration,
    params.sessionId,
    params.topicId,
  );
  const pathContract = resolveCurrentSessionIdentityPathContract(params.migration);
  const legacySessionFile = resolveSessionTranscriptPathInDir(
    params.sessionId,
    path.dirname(pathContract.readPath),
    params.topicId,
  );
  const writeExists = await fs
    .access(sessionFile)
    .then(() => true)
    .catch(() => false);
  const readPath = writeExists ? sessionFile : legacySessionFile;
  const transcriptContract = createLcxIdentityWriterPathContract({
    writer: "sessions",
    migrationPlan: pathContract.migrationPlan,
    readPath,
    writePath: sessionFile,
    auditPath: params.migration.pathContract.auditPath,
  });
  const previousRaw = await readLcxIdentityWriterRaw(transcriptContract);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-session-transcript-writer-"));
  const tempFile = path.join(tempDir, "session.jsonl");
  try {
    const initialRaw =
      previousRaw ??
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      })}\n`;
    await fs.writeFile(tempFile, initialRaw, { encoding: "utf8", mode: 0o600 });
    const sessionManager = SessionManager.open(tempFile);
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: params.text }],
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const nextRaw = await fs.readFile(tempFile, "utf8");
    const receipt = await writeLcxIdentityWriterRawWithReceipt(transcriptContract, nextRaw);
    return { sessionFile, receipt };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
