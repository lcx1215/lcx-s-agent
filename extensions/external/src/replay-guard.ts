import os from "node:os";
import path from "node:path";
import { createPersistentDedupe } from "lcx-agent/plugin-sdk";

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
