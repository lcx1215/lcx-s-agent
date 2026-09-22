import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FINANCE_SCHEDULER_LOCK } from "./finance-scheduler-lock.js";

export const FINANCE_SCHEDULER_TICK_MS = 60_000;

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

/** A responsive process and completed trading work are separate health signals. */
export function inspectFinanceSchedulerProgress(
  directory: string,
  pid: number | null,
  present: boolean,
  now: number,
) {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(directory, FINANCE_SCHEDULER_LOCK, "progress.json"), "utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "invalid" };
    }
    const progress = value as Record<string, unknown>;
    const age =
      typeof progress.observedAt === "string" ? now - Date.parse(progress.observedAt) : NaN;
    if (
      progress.pid !== pid ||
      !Number.isFinite(age) ||
      age < 0 ||
      !["idle", "cycle"].includes(String(progress.phase)) ||
      typeof progress.timeoutMs !== "number" ||
      !Number.isSafeInteger(progress.timeoutMs) ||
      progress.timeoutMs <= 0 ||
      progress.timeoutMs > 2_147_483_647 ||
      typeof progress.placementEnabled !== "boolean"
    ) {
      return { status: "invalid" };
    }
    const venue =
      progress.venue === "paper" || progress.venue === "alpaca" ? progress.venue : "unknown";
    const expires =
      typeof progress.executionPolicyExpiresAt === "string"
        ? Date.parse(progress.executionPolicyExpiresAt)
        : NaN;
    const executionPolicyStatus =
      venue === "paper"
        ? "not_required"
        : venue !== "alpaca"
          ? "unknown"
          : !Number.isFinite(expires)
            ? "unavailable"
            : expires <= now
              ? "expired"
              : "current";
    const deadline =
      2 * FINANCE_SCHEDULER_TICK_MS + (progress.phase === "cycle" ? progress.timeoutMs : 0);
    return {
      status: !present ? "owner_missing" : age > deadline ? "stalled" : "responsive",
      observedAt: progress.observedAt,
      phase: progress.phase,
      ageMs: age,
      deadlineMs: deadline,
      placementEnabled: progress.placementEnabled,
      venue,
      executionPolicyStatus,
      executionPolicyExpiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
    };
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "unreadable",
    };
  }
}

/** Diagnostic metadata only. The account controller still validates the complete policy. */
export function readFinanceSchedulerPolicyExpiry(filename: string | undefined): string | null {
  if (!filename) {
    return null;
  }
  try {
    const policy: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    return isObject(policy) &&
      typeof policy.expiresAt === "string" &&
      Number.isFinite(Date.parse(policy.expiresAt))
      ? policy.expiresAt
      : null;
  } catch {
    return null;
  }
}
