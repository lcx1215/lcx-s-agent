import fs from "node:fs/promises";
import path from "node:path";
import type { CentralRunReceipt } from "./types.js";

/**
 * Persistence contract for the central agent's own evidence.
 *
 * Two independent concerns live here, both borrowed from the codex harness:
 *
 * 1. One immutable snapshot per cycle, so an overlapping run cannot overwrite
 *    another run's evidence.
 * 2. A single `latest` pointer that never moves backwards, so the newest receipt
 *    a reader sees is really the newest one.
 */

/** Filename contract for a per-cycle snapshot; writer and readers share one shape. */
export function runSnapshotPath(runsDir: string, runId: string): string {
  return path.join(runsDir, `${runId}.json`);
}

/** Atomic JSON publication: write a sibling temp file, then rename over the target. */
export async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

/**
 * One immutable snapshot per cycle, keyed by the receipt's own runId. This is the
 * fix for the real failure mode: the hourly governance owner and a manual
 * invocation both write the single `latest` file, so whichever finishes last
 * silently discards the other run's evidence. With a per-run file the pointer may
 * still race, but no cycle's receipt is ever lost.
 */
export async function writeRunSnapshot(
  runsDir: string,
  receipt: CentralRunReceipt,
): Promise<string> {
  const filePath = runSnapshotPath(runsDir, receipt.runId);
  await writeJsonAtomic(filePath, receipt);
  return filePath;
}

export type LatestPointer = Readonly<{
  superseded: boolean;
  heldReceipt: CentralRunReceipt | null;
  heldRunPath: string | null;
  heldRunId: string | null;
}>;

function asReceipt(value: unknown): CentralRunReceipt | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as CentralRunReceipt;
  return typeof candidate.runId === "string" && typeof candidate.observedAt === "string"
    ? candidate
    : undefined;
}

/**
 * Resolve which receipt the single `latest` pointer should hold.
 *
 * The run that finishes last is not necessarily the run that observed last, and a
 * pointer that jumps backwards would tell readers the newest cycle is older than
 * it is. So a candidate that observed earlier than the snapshot already on disk
 * does not take the pointer; it reports itself as superseded and keeps its own
 * receipt on disk under its runId. A run that produced no cycle at all refreshes
 * the snapshot but must not erase the last real receipt either.
 */
export function resolveLatestPointer(
  previous: Readonly<{ latestReceipt?: unknown; latestRunPath?: unknown }> | undefined,
  candidate: CentralRunReceipt | undefined,
  candidateRunPath: string | undefined,
): LatestPointer {
  const previousReceipt = asReceipt(previous?.latestReceipt);
  const previousPath = typeof previous?.latestRunPath === "string" ? previous.latestRunPath : null;
  const candidateAt = Date.parse(candidate?.observedAt ?? "");
  const previousAt = Date.parse(previousReceipt?.observedAt ?? "");
  const superseded =
    candidate !== undefined &&
    previousReceipt !== undefined &&
    Number.isFinite(candidateAt) &&
    Number.isFinite(previousAt) &&
    previousAt > candidateAt;
  if (superseded || candidate === undefined) {
    return {
      superseded,
      heldReceipt: previousReceipt ?? null,
      heldRunPath: previousPath,
      heldRunId: previousReceipt?.runId ?? null,
    };
  }
  return {
    superseded: false,
    heldReceipt: candidate,
    heldRunPath: candidateRunPath ?? null,
    heldRunId: candidate.runId,
  };
}
