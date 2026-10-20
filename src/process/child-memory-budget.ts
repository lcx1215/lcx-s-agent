import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAMPLE_INTERVAL_MS = 100;

export type ChildMemoryObservation = Readonly<{
  mode: "sampled_process_tree_rss";
  budgetBytes: number;
  peakBytes: number;
  samples: number;
  sampleIntervalMs: number;
}>;

export class ChildMemoryBudgetError extends Error {
  constructor(readonly code: "memory_budget_exceeded" | "memory_observation_unavailable") {
    super(code);
    this.name = "ChildMemoryBudgetError";
  }
}

/** Only numeric process metadata is collected; command lines and environment are never read. */
export function processTreeRssBytes(
  output: string,
  rootPid: number,
  includeProcessGroup = false,
): number | undefined {
  if (!output.trim()) {
    return undefined;
  }
  const rows = output
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
      if (!match) {
        throw new ChildMemoryBudgetError("memory_observation_unavailable");
      }
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        bytes: Number(match[4]) * 1024,
      };
    });
  const owned = new Set(
    rows
      .filter((row) => row.pid === rootPid || (includeProcessGroup && row.group === rootPid))
      .map((row) => row.pid),
  );
  if (owned.size === 0) {
    return undefined;
  }
  let previousSize = 0;
  while (owned.size !== previousSize) {
    previousSize = owned.size;
    for (const row of rows) {
      if (owned.has(row.parent)) {
        owned.add(row.pid);
      }
    }
  }
  return rows.reduce((sum, row) => sum + (owned.has(row.pid) ? row.bytes : 0), 0);
}

async function readProcessTreeRss(
  pid: number,
  includeProcessGroup: boolean,
): Promise<number | undefined> {
  if (process.platform === "win32") {
    throw new ChildMemoryBudgetError("memory_observation_unavailable");
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,rss="], {
    timeout: 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return processTreeRssBytes(stdout, pid, includeProcessGroup);
}

/** Called after the existing kill owner signals an owned detached group. */
export async function waitForChildMemoryRelease(child: ChildProcess): Promise<void> {
  if (!child.pid || process.platform === "win32") {
    return;
  }
  const deadline = Date.now() + 2500;
  while (true) {
    const bytes = await readProcessTreeRss(child.pid, true);
    // A reaped process, or a zero-RSS zombie awaiting its OS parent, owns no model memory.
    if (bytes === undefined || bytes === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("local_model_process_cleanup_failed");
    }
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
  }
}

/** A sampled RSS guard, not an OS allocation limit. It runs only during an owned invocation. */
export function guardChildMemory(
  child: ChildProcess,
  options: {
    budgetMb: number;
    /** Set only for the invocation owner's detached spawn, whose PGID equals its PID. */
    includeProcessGroup?: boolean;
    onError: (error: ChildMemoryBudgetError) => void;
    /** Read-only seam for an unavailable OS observation in focused tests. */
    readBytes?: (pid: number) => Promise<number | undefined>;
  },
) {
  const budgetBytes = options.budgetMb * 1024 * 1024;
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    throw new Error("local model memory budget must be positive");
  }
  let peakBytes = 0;
  let samples = 0;
  let stopped = false;
  let closed = false;
  let failure: ChildMemoryBudgetError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void>;
  let stopping: Promise<ChildMemoryObservation> | undefined;
  const stopScheduling = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
  const sample = async () => {
    try {
      const bytes = child.pid
        ? await (
            options.readBytes ??
            ((pid) => readProcessTreeRss(pid, options.includeProcessGroup === true))
          )(child.pid)
        : undefined;
      if (bytes === undefined) {
        // A completed child may disappear while its final in-flight sample is read.
        if (samples > 0 && (child.exitCode !== null || child.signalCode !== null)) {
          return;
        }
        throw new ChildMemoryBudgetError("memory_observation_unavailable");
      }
      if (!Number.isFinite(bytes) || bytes < 0) {
        throw new ChildMemoryBudgetError("memory_observation_unavailable");
      }
      samples++;
      peakBytes = Math.max(peakBytes, bytes);
      if (bytes > budgetBytes) {
        throw new ChildMemoryBudgetError("memory_budget_exceeded");
      }
      if (!stopped) {
        timer = setTimeout(() => {
          inFlight = sample();
        }, SAMPLE_INTERVAL_MS);
        timer.unref();
      }
    } catch (error) {
      failure =
        error instanceof ChildMemoryBudgetError
          ? error
          : new ChildMemoryBudgetError("memory_observation_unavailable");
      stopScheduling();
      options.onError(failure);
    }
  };
  const onClose = () => {
    closed = true;
    stopScheduling();
  };
  // An exited group leader can leave a child holding stdout and model memory.
  child.once("close", onClose);
  inFlight = Promise.resolve().then(sample);
  return {
    ready: inFlight.then(() => {
      if (failure) {
        throw failure;
      }
    }),
    stop: (): Promise<ChildMemoryObservation> => {
      stopping ??= (async () => {
        stopScheduling();
        await inFlight;
        // A quick resident reply can arrive between periodic samples; include its loaded baseline.
        if (!closed && !failure) {
          await sample();
        }
        child.removeListener("close", onClose);
        if (failure || samples === 0) {
          throw failure ?? new ChildMemoryBudgetError("memory_observation_unavailable");
        }
        return {
          mode: "sampled_process_tree_rss",
          budgetBytes,
          peakBytes,
          samples,
          sampleIntervalMs: SAMPLE_INTERVAL_MS,
        };
      })();
      return stopping;
    },
  };
}
