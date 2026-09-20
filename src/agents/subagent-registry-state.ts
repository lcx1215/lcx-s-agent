import {
  describeSubagentRegistryLoadStatus,
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/**
 * Why the last write did not happen. "blocked" means the registry on disk could not be read, so
 * writes are held back on purpose; "write-error" means we tried and the write itself failed.
 * Either way the runs only exist in memory, which is exactly what the caller must not assume away.
 */
export type SubagentRegistryPersistFailure = Readonly<{
  at: number;
  kind: "blocked" | "write-error";
  detail: string;
}>;

let lastPersistFailure: SubagentRegistryPersistFailure | null = null;

export function getSubagentRegistryPersistFailure(): SubagentRegistryPersistFailure | null {
  return lastPersistFailure;
}

export function resetSubagentRegistryStateForTests(): void {
  lastPersistFailure = null;
}

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>): boolean {
  try {
    const written = saveSubagentRegistryToDisk(runs);
    if (!written) {
      lastPersistFailure = {
        at: Date.now(),
        kind: "blocked",
        detail: describeSubagentRegistryLoadStatus(),
      };
      return false;
    }
  } catch (err) {
    lastPersistFailure = {
      at: Date.now(),
      kind: "write-error",
      detail: err instanceof Error ? err.message : "unknown",
    };
    return false;
  }
  lastPersistFailure = null;
  return true;
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromDisk();
  if (restored.size === 0) {
    return 0;
  }
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    added += 1;
  }
  return added;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk = !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadDisk) {
    try {
      // Persisted state lets other worker processes observe active runs.
      for (const [runId, entry] of loadSubagentRegistryFromDisk().entries()) {
        merged.set(runId, entry);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns.entries()) {
    merged.set(runId, entry);
  }
  return merged;
}
