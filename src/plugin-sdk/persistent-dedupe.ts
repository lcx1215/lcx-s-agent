import fs from "node:fs/promises";
import { createDedupeCache } from "../infra/dedupe.js";
import type { FileLockOptions } from "./file-lock.js";
import { withFileLock } from "./file-lock.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-store.js";

type PersistentDedupeData = Record<string, number>;

export type PersistentDedupeOptions = {
  ttlMs: number;
  memoryMaxSize: number;
  fileMaxEntries: number;
  resolveFilePath: (namespace: string) => string;
  lockOptions?: Partial<FileLockOptions>;
  onDiskError?: (error: unknown) => void;
};

export type PersistentDedupeCheckOptions = {
  namespace?: string;
  now?: number;
  onDiskError?: (error: unknown) => void;
  /** Refuse dispatch unless the reservation is durable; existing callers retain memory fallback. */
  requirePersistence?: boolean;
};

export type PersistentDedupe = {
  checkAndRecord: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  settleClaim: (
    key: string,
    options: { namespace?: string; recordedAt: number; retryable: boolean },
  ) => Promise<boolean>;
  warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
  clearMemory: () => void;
  memorySize: () => number;
};

const DEFAULT_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 6,
    factor: 1.35,
    minTimeout: 8,
    maxTimeout: 180,
    randomize: true,
  },
  stale: 60_000,
};

function mergeLockOptions(overrides?: Partial<FileLockOptions>): FileLockOptions {
  return {
    stale: overrides?.stale ?? DEFAULT_LOCK_OPTIONS.stale,
    retries: {
      retries: overrides?.retries?.retries ?? DEFAULT_LOCK_OPTIONS.retries.retries,
      factor: overrides?.retries?.factor ?? DEFAULT_LOCK_OPTIONS.retries.factor,
      minTimeout: overrides?.retries?.minTimeout ?? DEFAULT_LOCK_OPTIONS.retries.minTimeout,
      maxTimeout: overrides?.retries?.maxTimeout ?? DEFAULT_LOCK_OPTIONS.retries.maxTimeout,
      randomize: overrides?.retries?.randomize ?? DEFAULT_LOCK_OPTIONS.retries.randomize,
    },
  };
}

function sanitizeData(value: unknown): PersistentDedupeData {
  if (!value || typeof value !== "object") {
    return Object.create(null) as PersistentDedupeData;
  }
  const out = Object.create(null) as PersistentDedupeData;
  for (const [key, ts] of Object.entries(value as Record<string, unknown>)) {
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
      out[key] = ts;
    }
  }
  return out;
}

function pruneData(
  data: PersistentDedupeData,
  now: number,
  ttlMs: number,
  maxEntries: number,
): void {
  if (ttlMs > 0) {
    for (const [key, ts] of Object.entries(data)) {
      if (now - ts >= ttlMs) {
        delete data[key];
      }
    }
  }

  const keys = Object.keys(data);
  if (keys.length <= maxEntries) {
    return;
  }

  keys
    .toSorted((a, b) => data[a] - data[b])
    .slice(0, keys.length - maxEntries)
    .forEach((key) => {
      delete data[key];
    });
}

async function readRequiredDedupeData(filePath: string): Promise<PersistentDedupeData> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((ts) => typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0)
    ) {
      throw new Error("invalid persistent dedupe state");
    }
    return sanitizeData(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.create(null) as PersistentDedupeData;
    }
    throw error;
  }
}

export function createPersistentDedupe(options: PersistentDedupeOptions): PersistentDedupe {
  const ttlMs = Math.max(0, Math.floor(options.ttlMs));
  const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
  const fileMaxEntries = Math.max(1, Math.floor(options.fileMaxEntries));
  const lockOptions = mergeLockOptions(options.lockOptions);
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  const inflight = new Map<string, Promise<boolean>>();
  const releasableClaims = new Map<string, number>();
  let lastClaimAt = 0;

  async function checkAndRecordInner(
    key: string,
    namespace: string,
    scopedKey: string,
    now: number,
    onDiskError?: (error: unknown) => void,
    requirePersistence = false,
  ): Promise<boolean> {
    // Recoverable claims consult durable state: another owner may have safely released it.
    if (!requirePersistence && memory.check(scopedKey, now)) {
      return false;
    }

    const path = options.resolveFilePath(namespace);
    try {
      const duplicate = await withFileLock(path, lockOptions, async () => {
        const data = requirePersistence
          ? await readRequiredDedupeData(path)
          : sanitizeData((await readJsonFileWithFallback<PersistentDedupeData>(path, {})).value);
        const seenAt = data[key];
        const isRecent = seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs);
        if (isRecent) {
          return true;
        }
        data[key] = now;
        pruneData(data, now, ttlMs, fileMaxEntries);
        await writeJsonFileAtomically(path, data);
        return false;
      });
      return !duplicate;
    } catch (error) {
      onDiskError?.(error);
      if (requirePersistence) {
        memory.delete(scopedKey);
        throw error;
      }
      memory.check(scopedKey, now);
      return true;
    }
  }

  async function warmup(namespace = "global", onError?: (error: unknown) => void): Promise<number> {
    const filePath = options.resolveFilePath(namespace);
    const now = Date.now();
    try {
      const { value } = await readJsonFileWithFallback<PersistentDedupeData>(filePath, {});
      const data = sanitizeData(value);
      let loaded = 0;
      for (const [key, ts] of Object.entries(data)) {
        if (ttlMs > 0 && now - ts >= ttlMs) {
          continue;
        }
        const scopedKey = `${namespace}:${key}`;
        memory.check(scopedKey, ts);
        loaded++;
      }
      return loaded;
    } catch (error) {
      onError?.(error);
      return 0;
    }
  }

  async function checkAndRecord(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return true;
    }
    const namespace = dedupeOptions?.namespace?.trim() || "global";
    const scopedKey = `${namespace}:${trimmed}`;
    if (inflight.has(scopedKey)) {
      return false;
    }

    const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
    const now = dedupeOptions?.now ?? Date.now();
    if (dedupeOptions?.requirePersistence) {
      if (now <= lastClaimAt) {
        throw new Error("persistent dedupe claim timestamp must be unique");
      }
      lastClaimAt = now;
    }
    const work = checkAndRecordInner(
      trimmed,
      namespace,
      scopedKey,
      now,
      onDiskError,
      dedupeOptions?.requirePersistence,
    );
    inflight.set(scopedKey, work);
    try {
      const accepted = await work;
      if (accepted && dedupeOptions?.requirePersistence) {
        releasableClaims.set(scopedKey, now);
      }
      return accepted;
    } finally {
      inflight.delete(scopedKey);
    }
  }

  return {
    checkAndRecord,
    settleClaim: async (key, releaseOptions) => {
      const trimmed = key.trim();
      const namespace = releaseOptions.namespace?.trim() || "global";
      const scopedKey = `${namespace}:${trimmed}`;
      if (
        !trimmed ||
        inflight.has(scopedKey) ||
        releasableClaims.get(scopedKey) !== releaseOptions.recordedAt
      ) {
        return false;
      }
      // Consume the release handle once, including on uncertain disk failures.
      releasableClaims.delete(scopedKey);
      const filePath = options.resolveFilePath(namespace);
      return await withFileLock(filePath, lockOptions, async () => {
        const data = await readRequiredDedupeData(filePath);
        if (data[trimmed] !== releaseOptions.recordedAt) {
          return false;
        }
        if (releaseOptions.retryable) {
          delete data[trimmed];
        } else {
          data[trimmed] = Math.max(releaseOptions.recordedAt, Date.now());
        }
        await writeJsonFileAtomically(filePath, data);
        memory.delete(scopedKey);
        return true;
      });
    },
    warmup,
    clearMemory: () => memory.clear(),
    memorySize: () => memory.size(),
  };
}
