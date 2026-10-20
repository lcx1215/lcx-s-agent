import { isDeepStrictEqual } from "node:util";
import {
  describeSubagentRegistryLoadStatus,
  getSubagentRegistryLoadStatus,
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
let writeBaselines = new WeakMap<Map<string, SubagentRunRecord>, Map<string, SubagentRunRecord>>();

function copyRuns(runs: Map<string, SubagentRunRecord>): Map<string, SubagentRunRecord> {
  return new Map([...runs].map(([id, entry]) => [id, structuredClone(entry)]));
}

export function getSubagentRegistryPersistFailure(): SubagentRegistryPersistFailure | null {
  return lastPersistFailure;
}

export function resetSubagentRegistryStateForTests(): void {
  lastPersistFailure = null;
  writeBaselines = new WeakMap();
}

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>): boolean {
  try {
    const written = saveSubagentRegistryToDisk(runs, writeBaselines.get(runs) ?? new Map());
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
  writeBaselines.set(runs, copyRuns(runs));
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
  const baseline = writeBaselines.get(params.runs) ?? new Map<string, SubagentRunRecord>();
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    baseline.set(runId, structuredClone(entry));
    added += 1;
  }
  writeBaselines.set(params.runs, baseline);
  return added;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk = !(process.env.VITEST || process.env.NODE_ENV === "test");
  let readableSnapshot = false;
  if (shouldReadDisk) {
    try {
      // Persisted state lets other worker processes observe active runs.
      for (const [runId, entry] of loadSubagentRegistryFromDisk().entries()) {
        merged.set(runId, entry);
      }
      readableSnapshot = getSubagentRegistryLoadStatus().state === "ok";
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  const baseline = writeBaselines.get(inMemoryRuns);
  for (const [runId, entry] of inMemoryRuns.entries()) {
    // A read must not resurrect a peer's completed/deleted run from unchanged
    // memory. Keep unsaved local changes and fall back to memory on read failure.
    // Do not advance the write baseline: concurrent write conflicts still matter.
    if (readableSnapshot && baseline?.has(runId) && isDeepStrictEqual(entry, baseline.get(runId))) {
      continue;
    }
    merged.set(runId, entry);
  }
  return merged;
}
