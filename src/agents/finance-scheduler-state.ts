import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "daily-cycle-scheduler.json";

export type SchedulerState = {
  lastFired: Record<string, string>;
  lastSucceeded: Record<string, string>;
  lastStatus: Record<string, string>;
  lastRun?: Record<string, unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readFinanceSchedulerState(directory: string): SchedulerState {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(directory, STATE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lastFired: {}, lastSucceeded: {}, lastStatus: {} };
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  const dates = (value: unknown): value is Record<string, string> =>
    isObject(value) &&
    Object.entries(value).every(
      ([key, date]) =>
        (key === "day" || key === "night") &&
        typeof date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Number.isFinite(Date.parse(date)) &&
        new Date(date).toISOString().slice(0, 10) === date,
    );
  const statuses = (value: unknown): value is Record<string, string> =>
    isObject(value) &&
    Object.entries(value).every(
      ([mode, status]) =>
        (mode === "day" || mode === "night") &&
        typeof status === "string" &&
        ["running", "succeeded", "failed", "timed_out", "cancelled", "spawn_error"].includes(
          status,
        ),
    );
  if (
    !isObject(parsed) ||
    !dates(parsed.lastFired) ||
    (parsed.lastSucceeded !== undefined && !dates(parsed.lastSucceeded)) ||
    (parsed.lastStatus !== undefined && !statuses(parsed.lastStatus)) ||
    (parsed.lastRun !== undefined && !isObject(parsed.lastRun))
  ) {
    throw new Error("invalid finance scheduler state; refusing to replay unknown attempts");
  }
  return {
    lastFired: parsed.lastFired,
    lastSucceeded: parsed.lastSucceeded ?? {},
    lastStatus: parsed.lastStatus ?? {},
    lastRun: parsed.lastRun,
  };
}

export function writeFinanceSchedulerState(directory: string, state: SchedulerState): void {
  const filename = path.join(directory, STATE_FILE);
  const tmp = `${filename}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, filename);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
