import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { LogicalAgentCheckpoint, LogicalAgentCheckpointStore } from "./logical-agent-pool.js";

export const LOGICAL_AGENT_CHECKPOINT_RELATIVE_DIR = path.join(
  "agents",
  "logical-agent-checkpoints",
);

/**
 * Resolve a checkpoint below the active LCX state root.
 *
 * The run id is hashed before it becomes a path component so a caller cannot
 * turn a run id into a path traversal or create an unbounded nested tree.
 */
export function resolveLogicalAgentCheckpointPath(
  runId: string,
  stateDir: string = resolveStateDir(),
): string {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    throw new Error("logical-agent checkpoint runId must not be empty");
  }
  const fileName = `${createHash("sha256").update(normalizedRunId, "utf8").digest("hex")}.json`;
  return path.join(path.resolve(stateDir), LOGICAL_AGENT_CHECKPOINT_RELATIVE_DIR, fileName);
}

export type LogicalAgentCheckpointStoreOptions = Readonly<{
  /** Test-only injection; production callers should use the active state root. */
  stateDir?: string;
}>;

/**
 * File-backed checkpoint owner for the active LCX state root.
 *
 * This is deliberately an adapter around the existing state-root resolver,
 * not a new root or a second migration authority. Writes are atomic and
 * restricted to owner-readable files so a restarted process can resume from
 * the same checkpoint without trusting an in-memory map.
 */
export function createCanonicalStateRootLogicalAgentCheckpointStore<TResult>(
  options: LogicalAgentCheckpointStoreOptions = {},
): LogicalAgentCheckpointStore<TResult> {
  const stateDir = path.resolve(options.stateDir ?? resolveStateDir());
  return {
    load: (runId) => {
      const checkpointPath = resolveLogicalAgentCheckpointPath(runId, stateDir);
      let raw: string;
      try {
        raw = fs.readFileSync(checkpointPath, "utf8");
      } catch (error: unknown) {
        if (isNodeError(error, "ENOENT")) {
          return undefined;
        }
        throw new Error(`unable to read logical-agent checkpoint: ${checkpointPath}`, {
          cause: error,
        });
      }
      try {
        return JSON.parse(raw) as LogicalAgentCheckpoint<TResult>;
      } catch (error: unknown) {
        throw new Error(`logical-agent checkpoint is not valid JSON: ${checkpointPath}`, {
          cause: error,
        });
      }
    },
    save: (checkpoint) => {
      const checkpointPath = resolveLogicalAgentCheckpointPath(checkpoint.runId, stateDir);
      const checkpointDir = path.dirname(checkpointPath);
      fs.mkdirSync(checkpointDir, { recursive: true, mode: 0o700 });
      const temporaryPath = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        try {
          fs.chmodSync(temporaryPath, 0o600);
        } catch {
          // Best effort on filesystems that do not support chmod.
        }
        fs.renameSync(temporaryPath, checkpointPath);
        try {
          fs.chmodSync(checkpointPath, 0o600);
        } catch {
          // Best effort on filesystems that do not support chmod.
        }
      } finally {
        try {
          fs.rmSync(temporaryPath, { force: true });
        } catch {
          // A successful rename already removed the temporary path.
        }
      }
    },
  };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
