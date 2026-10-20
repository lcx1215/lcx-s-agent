import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDedupeCache } from "../infra/dedupe.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
import type { FileLockOptions } from "./file-lock.js";
import { withFileLock } from "./file-lock.js";
import { writeJsonFileAtomically } from "./json-store.js";

export const PERSISTENT_DEDUPE_SCHEMA_VERSION = "lcx_persistent_dedupe_v2" as const;
type ClaimEntry = {
  recordedAt: number;
  claimId: string;
  status: "processing" | "completed" | "delivery_unknown";
};
export type PersistentDedupeState =
  | Record<string, number>
  | {
      schemaVersion: typeof PERSISTENT_DEDUPE_SCHEMA_VERSION;
      entries: Record<string, ClaimEntry>;
    };
type DedupeEntry = number | ClaimEntry;
type DedupeEntries = Record<string, DedupeEntry>;
class ProtectedDedupeStateError extends Error {}

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
    options: {
      namespace?: string;
      recordedAt: number;
      retryable: boolean;
      outcome?: "completed" | "delivery_unknown";
    },
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

function isVersioned(
  state: PersistentDedupeState,
): state is Extract<PersistentDedupeState, { entries: unknown }> {
  return state.schemaVersion === PERSISTENT_DEDUPE_SCHEMA_VERSION;
}

/** v1 numeric maps remain readable. v2 may never be downgraded to a numeric map. */
export function parsePersistentDedupeState(
  value: unknown,
  strictLegacy = false,
): PersistentDedupeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strictLegacy) {
      throw new Error("invalid persistent dedupe state");
    }
    return Object.create(null) as Record<string, number>;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.schemaVersion === "string") {
    if (
      raw.schemaVersion !== PERSISTENT_DEDUPE_SCHEMA_VERSION ||
      !raw.entries ||
      typeof raw.entries !== "object" ||
      Array.isArray(raw.entries)
    ) {
      throw new ProtectedDedupeStateError(
        "unsupported or invalid versioned persistent dedupe state",
      );
    }
    const entries = Object.create(null) as Record<string, ClaimEntry>;
    for (const [key, value] of Object.entries(raw.entries)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ProtectedDedupeStateError("invalid persistent dedupe claim");
      }
      const entry = value as Record<string, unknown>;
      if (
        typeof entry.recordedAt !== "number" ||
        !Number.isFinite(entry.recordedAt) ||
        entry.recordedAt <= 0 ||
        typeof entry.claimId !== "string" ||
        !entry.claimId ||
        (entry.status !== "processing" &&
          entry.status !== "completed" &&
          entry.status !== "delivery_unknown")
      ) {
        throw new ProtectedDedupeStateError("invalid persistent dedupe claim");
      }
      entries[key] = { recordedAt: entry.recordedAt, claimId: entry.claimId, status: entry.status };
    }
    return { schemaVersion: PERSISTENT_DEDUPE_SCHEMA_VERSION, entries };
  }
  const entries = Object.create(null) as Record<string, number>;
  for (const [key, ts] of Object.entries(raw)) {
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
      entries[key] = ts;
    } else if (strictLegacy) {
      throw new Error("invalid persistent dedupe state");
    }
  }
  return entries;
}

/** Identity migration may copy records, but cannot silently remove unresolved deliveries. */
export function assertPersistentDedupeStatePreserved(
  previous: PersistentDedupeState,
  next: PersistentDedupeState,
): void {
  if (!isVersioned(previous)) {
    const nextEntries = entriesOf(next);
    for (const [key, timestamp] of Object.entries(previous)) {
      const entry = nextEntries[key];
      if (
        entry === undefined ||
        (typeof entry === "number"
          ? entry !== timestamp
          : entry.recordedAt !== timestamp || entry.status !== "delivery_unknown")
      ) {
        throw new ProtectedDedupeStateError("legacy persistent dedupe claim removal refused");
      }
    }
    return;
  }
  if (!isVersioned(next)) {
    throw new ProtectedDedupeStateError("persistent dedupe version downgrade refused");
  }
  for (const [key, entry] of Object.entries(previous.entries)) {
    if (unresolved(entry) && JSON.stringify(next.entries[key]) !== JSON.stringify(entry)) {
      throw new ProtectedDedupeStateError("unresolved persistent dedupe claim removal refused");
    }
  }
}

function recordedAt(entry: DedupeEntry): number {
  return typeof entry === "number" ? entry : entry.recordedAt;
}
function unresolved(entry: DedupeEntry): boolean {
  return typeof entry !== "number" && entry.status !== "completed";
}
function entriesOf(state: PersistentDedupeState): DedupeEntries {
  return isVersioned(state) ? state.entries : state;
}

/** Explicit v1 -> v2 migration: old admission timestamps do not prove delivery completion. */
function upgradeClaims(
  state: PersistentDedupeState,
): Extract<PersistentDedupeState, { entries: unknown }> {
  if (isVersioned(state)) {
    return state;
  }
  const entries = Object.create(null) as Record<string, ClaimEntry>;
  for (const [key, ts] of Object.entries(state)) {
    entries[key] = { recordedAt: ts, claimId: randomUUID(), status: "delivery_unknown" };
  }
  return { schemaVersion: PERSISTENT_DEDUPE_SCHEMA_VERSION, entries };
}

function pruneData(data: DedupeEntries, now: number, ttlMs: number, maxEntries: number): void {
  for (const [key, entry] of Object.entries(data)) {
    if (!unresolved(entry) && ttlMs > 0 && now - recordedAt(entry) >= ttlMs) {
      delete data[key];
    }
  }
  const removable = Object.keys(data).filter((key) => !unresolved(data[key]));
  removable
    .toSorted((a, b) => recordedAt(data[a]) - recordedAt(data[b]))
    .slice(0, Math.max(0, Object.keys(data).length - maxEntries))
    .forEach((key) => {
      delete data[key];
    });
}

async function readDedupeState(filePath: string, strict: boolean): Promise<PersistentDedupeState> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ProtectedDedupeStateError("invalid existing persistent dedupe state");
    }
    return parsePersistentDedupeState(value, strict);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.create(null) as Record<string, number>;
    }
    // A failed read cannot prove that existing state was an unprotected legacy map.
    // Preserve its bytes and refuse compatibility admission as well as strict claims.
    throw new ProtectedDedupeStateError("persistent dedupe state could not be safely read", {
      cause: error,
    });
  }
}

const fileQueues = resolveProcessScopedMap<Promise<void>>(
  Symbol.for("lcx.persistentDedupeFileQueues"),
);
/** Same-process serialization precedes the existing cross-process lock, which is reentrant. */
export async function withPersistentDedupeStateLock<T>(
  filePath: string,
  operation: (canonicalPath: string) => Promise<T>,
  lockOptions: FileLockOptions = DEFAULT_LOCK_OPTIONS,
): Promise<T> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const canonical = await fs.realpath(resolved).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved));
  });
  const previous = fileQueues.get(canonical) ?? Promise.resolve();
  const work = previous.then(() =>
    withFileLock(canonical, lockOptions, () => operation(canonical)),
  );
  const tail = work.then(
    () => {},
    () => {},
  );
  fileQueues.set(canonical, tail);
  try {
    return await work;
  } finally {
    if (fileQueues.get(canonical) === tail) {
      fileQueues.delete(canonical);
    }
  }
}

export function createPersistentDedupe(options: PersistentDedupeOptions): PersistentDedupe {
  const ttlMs = Math.max(0, Math.floor(options.ttlMs));
  const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
  const fileMaxEntries = Math.max(1, Math.floor(options.fileMaxEntries));
  const lockOptions = mergeLockOptions(options.lockOptions);
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  const inflight = new Map<string, Promise<boolean>>();
  const releasableClaims = new Map<string, { recordedAt: number; claimId: string }>();
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

    const filePath = options.resolveFilePath(namespace);
    let protectedState = false;
    let legacyFallbackConfirmed = false;
    try {
      const duplicate = await withPersistentDedupeStateLock(
        filePath,
        async (canonical) => {
          let state = await readDedupeState(canonical, requirePersistence);
          const migrated = requirePersistence && !isVersioned(state);
          if (requirePersistence) {
            state = upgradeClaims(state);
          }
          protectedState = isVersioned(state);
          legacyFallbackConfirmed = !protectedState;
          if (migrated) {
            await writeJsonFileAtomically(canonical, state);
          }
          const data = entriesOf(state);
          const seen = data[key];
          if (
            seen !== undefined &&
            (unresolved(seen) || ttlMs <= 0 || now - recordedAt(seen) < ttlMs)
          ) {
            return true;
          }
          if (Object.values(data).filter(unresolved).length >= fileMaxEntries) {
            throw new ProtectedDedupeStateError(
              "persistent dedupe unresolved capacity exhausted; new claim blocked",
            );
          }
          if (isVersioned(state)) {
            const claimId = randomUUID();
            state.entries[key] = {
              recordedAt: now,
              claimId,
              status: requirePersistence ? "processing" : "completed",
            };
            if (requirePersistence) {
              releasableClaims.set(scopedKey, { recordedAt: now, claimId });
            }
          } else {
            state[key] = now;
          }
          pruneData(data, now, ttlMs, fileMaxEntries);
          await writeJsonFileAtomically(canonical, state);
          return false;
        },
        lockOptions,
      );
      return !duplicate;
    } catch (error) {
      onDiskError?.(error);
      if (requirePersistence || protectedState || error instanceof ProtectedDedupeStateError) {
        memory.delete(scopedKey);
        releasableClaims.delete(scopedKey);
        throw error;
      }
      if (!legacyFallbackConfirmed) {
        try {
          await fs.stat(filePath);
        } catch (stateError) {
          const code = (stateError as NodeJS.ErrnoException).code;
          legacyFallbackConfirmed = code === "ENOENT" || code === "ENOTDIR";
        }
        if (!legacyFallbackConfirmed) {
          memory.delete(scopedKey);
          releasableClaims.delete(scopedKey);
          throw new ProtectedDedupeStateError(
            "persistent dedupe fallback refused without verified legacy or absent state",
            { cause: error },
          );
        }
      }
      memory.check(scopedKey, now);
      return true;
    }
  }

  async function warmup(namespace = "global", onError?: (error: unknown) => void): Promise<number> {
    const filePath = options.resolveFilePath(namespace);
    const now = Date.now();
    try {
      return await withPersistentDedupeStateLock(
        filePath,
        async (canonical) => {
          const data = entriesOf(await readDedupeState(canonical, false));
          let loaded = 0;
          for (const [key, entry] of Object.entries(data)) {
            if (!unresolved(entry) && ttlMs > 0 && now - recordedAt(entry) >= ttlMs) {
              continue;
            }
            memory.check(`${namespace}:${key}`, unresolved(entry) ? now : recordedAt(entry));
            loaded++;
          }
          return loaded;
        },
        lockOptions,
      );
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
        releasableClaims.get(scopedKey)?.recordedAt !== releaseOptions.recordedAt
      ) {
        return false;
      }
      const claim = releasableClaims.get(scopedKey)!;
      // Consume the release handle once, including on uncertain disk failures.
      releasableClaims.delete(scopedKey);
      const filePath = options.resolveFilePath(namespace);
      return await withPersistentDedupeStateLock(
        filePath,
        async (canonical) => {
          const state = await readDedupeState(canonical, true);
          if (!isVersioned(state)) {
            return false;
          }
          const entry = state.entries[trimmed];
          if (
            !entry ||
            entry.recordedAt !== claim.recordedAt ||
            entry.claimId !== claim.claimId ||
            entry.status !== "processing"
          ) {
            return false;
          }
          if (releaseOptions.retryable) {
            delete state.entries[trimmed];
          } else {
            state.entries[trimmed] = {
              ...entry,
              recordedAt: Math.max(entry.recordedAt, Date.now()),
              status: releaseOptions.outcome ?? "completed",
            };
          }
          await writeJsonFileAtomically(canonical, state);
          memory.delete(scopedKey);
          return true;
        },
        lockOptions,
      );
    },
    warmup,
    clearMemory: () => memory.clear(),
    memorySize: () => memory.size(),
  };
}
