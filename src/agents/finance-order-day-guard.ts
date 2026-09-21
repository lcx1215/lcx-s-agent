/**
 * One order per instrument per day, enforced outside any single code path.
 *
 * Two schedulers running the same day is not a hypothetical here: this repo had
 * two daily cycles under construction at once, and if both had been scheduled
 * the same instrument would have been bought twice through two different routes
 * that each believed it was the only one. Neither would have seen the other's
 * order, and each would have reported success.
 *
 * So the guard lives outside both. It records what has been placed for an
 * instrument on a given UTC day, and refuses a second one. Any placement path
 * can call it; none is trusted to remember on its own.
 *
 * It is a guard, not a gate on correctness: it does not decide whether a trade
 * is wise, only whether this instrument has already been acted on today. And it
 * is deliberately dumb - append and read - so that a failure to record is
 * visible as a missing line rather than as a silent success.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

const PLACED_REL = "state/finance/placed-orders.jsonl";

export type PlacedRecord = Readonly<{
  instrument: string;
  day: string;
  receiptId: string;
  venue: string;
  placedAt: string;
  route: string;
}>;

async function placedFile(workspaceDir?: string): Promise<string> {
  const root = resolveWorkspaceRoot(workspaceDir);
  return path.isAbsolute(PLACED_REL) ? PLACED_REL : path.join(root, PLACED_REL);
}

export async function readPlaced(workspaceDir?: string): Promise<PlacedRecord[]> {
  try {
    const raw = await fs.readFile(await placedFile(workspaceDir), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const row = JSON.parse(line) as PlacedRecord;
          return typeof row?.instrument === "string" ? [row] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function placedToday(
  instrument: string,
  day: string,
  workspaceDir?: string,
): Promise<PlacedRecord | null> {
  const symbol = instrument.trim().toUpperCase();
  const all = await readPlaced(workspaceDir);
  return all.find((row) => row.instrument === symbol && row.day === day) ?? null;
}

/**
 * Refuse a second order for the same instrument on the same day.
 *
 * Returns ok:false with the existing record so the caller can say what it found
 * rather than just declining - "already placed by another route" is actionable,
 * "no" is not.
 */
export async function assertNotPlacedToday(params: {
  instrument: string;
  day: string;
  workspaceDir?: string;
}): Promise<{ ok: true } | { ok: false; existing: PlacedRecord }> {
  const existing = await placedToday(params.instrument, params.day, params.workspaceDir);
  return existing ? { ok: false, existing } : { ok: true };
}

export async function markPlaced(params: {
  instrument: string;
  day: string;
  receiptId: string;
  venue: string;
  route: string;
  workspaceDir?: string;
}): Promise<PlacedRecord> {
  const record: PlacedRecord = {
    instrument: params.instrument.trim().toUpperCase(),
    day: params.day,
    receiptId: params.receiptId,
    venue: params.venue,
    route: params.route,
    placedAt: new Date().toISOString(),
  };
  const file = await placedFile(params.workspaceDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(record) + "\n");
  return record;
}
