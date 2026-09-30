import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  commitFinanceSchedulerDatabaseState,
  FINANCE_SCHEDULER_DATABASE,
  readFinanceSchedulerDatabaseState,
} from "./finance-scheduler-ledger.js";
import { FINANCE_SCHEDULER_LOCK } from "./finance-scheduler-lock.js";
import { FINANCE_DAILY_CYCLE_RUNS_FILENAME } from "./finance-state-dir.js";

export const FINANCE_SCHEDULER_TICK_MS = 60_000;
export const FINANCE_SCHEDULER_CYCLE_STAGES = [
  "research_preflight",
  "execution",
  "universe_selection",
  "night_review",
] as const;
export type FinanceSchedulerCycleStage = (typeof FINANCE_SCHEDULER_CYCLE_STAGES)[number];

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
  const databaseState = readFinanceSchedulerDatabaseState(directory);
  if (databaseState !== undefined) {
    return parseSchedulerState(databaseState);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(directory, STATE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lastFired: {}, lastSucceeded: {}, lastStatus: {} };
    }
    throw error;
  }
  const legacy: unknown = JSON.parse(raw);
  if (isObject(legacy) && legacy.storageAuthority === FINANCE_SCHEDULER_DATABASE) {
    throw new Error("scheduler database missing after migration; refusing stale file fallback");
  }
  return parseSchedulerState(raw);
}

function parseSchedulerState(raw: string): SchedulerState {
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

/** Migration runs after acquiring the scheduler lock; status reads never create a database. */
export function initializeFinanceSchedulerDatabase(directory: string): void {
  if (readFinanceSchedulerDatabaseState(directory) !== undefined) {
    return;
  }
  const state = readFinanceSchedulerState(directory);
  let legacyRuns: Record<string, unknown>[] = [];
  try {
    legacyRuns = fs
      .readFileSync(path.join(directory, FINANCE_DAILY_CYCLE_RUNS_FILENAME), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const record: unknown = JSON.parse(line);
        if (!isObject(record)) {
          throw new Error("invalid legacy scheduler run");
        }
        return record;
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (legacyRuns.length > 0 && !fs.existsSync(path.join(directory, STATE_FILE))) {
    throw new Error("scheduler history exists without recovery state; reconciliation required");
  }
  commitFinanceSchedulerDatabaseState(directory, JSON.stringify(state), legacyRuns);
  writeCompatibilityState(directory, state);
}

export function writeFinanceSchedulerState(directory: string, state: SchedulerState): void {
  const body = JSON.stringify(parseSchedulerState(JSON.stringify(state)));
  initializeFinanceSchedulerDatabase(directory);
  const terminal =
    state.lastRun &&
    ["succeeded", "failed", "timed_out", "cancelled", "spawn_error"].includes(
      String(state.lastRun.status),
    ) &&
    (state.lastRun.mode === "day" || state.lastRun.mode === "night")
      ? [state.lastRun]
      : [];
  commitFinanceSchedulerDatabaseState(directory, body, terminal);
  writeCompatibilityState(directory, state);
}

function writeCompatibilityState(directory: string, state: SchedulerState): void {
  const filename = path.join(directory, STATE_FILE);
  const tmp = `${filename}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ ...state, storageAuthority: FINANCE_SCHEDULER_DATABASE }, null, 2)}\n`,
      { mode: 0o600 },
    );
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
    const intradayControllerPolicyExpiry =
      typeof progress.intradayControllerPolicyExpiresAt === "string"
        ? Date.parse(progress.intradayControllerPolicyExpiresAt)
        : NaN;
    const intradayControllerPolicyStatus =
      venue !== "alpaca" || !isObject(progress.intraday) || progress.intraday.enabled !== true
        ? "not_applicable"
        : !Number.isFinite(intradayControllerPolicyExpiry)
          ? "not_loaded"
          : intradayControllerPolicyExpiry <= now
            ? "expired"
            : "current";
    const deadline =
      2 * FINANCE_SCHEDULER_TICK_MS + (progress.phase === "cycle" ? progress.timeoutMs : 0);
    const intradayConfig = isObject(progress.intraday) ? progress.intraday : undefined;
    const symbolList = (value: unknown): value is string[] =>
      Array.isArray(value) &&
      value.every(
        (symbol) =>
          typeof symbol === "string" &&
          symbol.length > 0 &&
          symbol.length <= 32 &&
          symbol === symbol.toUpperCase() &&
          /^[A-Z0-9./:_-]+$/.test(symbol),
      );
    const intraday =
      intradayConfig && typeof intradayConfig.enabled === "boolean"
        ? {
            enabled: intradayConfig.enabled,
            placementEnabled:
              typeof intradayConfig.placementEnabled === "boolean"
                ? intradayConfig.placementEnabled
                : null,
            placementRequested:
              typeof intradayConfig.placementRequested === "boolean"
                ? intradayConfig.placementRequested
                : null,
            placementEligibility:
              typeof intradayConfig.placementEligibility === "string" &&
              /^[a-z0-9_]{1,64}$/.test(intradayConfig.placementEligibility)
                ? intradayConfig.placementEligibility
                : null,
            instrumentSource:
              intradayConfig.instrumentSource === "active_rule" ||
              intradayConfig.instrumentSource === "explicit" ||
              intradayConfig.instrumentSource === "system_universe"
                ? intradayConfig.instrumentSource
                : "unknown",
            instruments: symbolList(intradayConfig.instruments) ? intradayConfig.instruments : [],
            executionInstruments: symbolList(intradayConfig.executionInstruments)
              ? intradayConfig.executionInstruments
              : [],
            intervalSeconds:
              intradayConfig.intervalSeconds === 60 ||
              intradayConfig.intervalSeconds === 300 ||
              intradayConfig.intervalSeconds === 900
                ? intradayConfig.intervalSeconds
                : null,
            feed:
              intradayConfig.feed === "iex" || intradayConfig.feed === "sip"
                ? intradayConfig.feed
                : null,
          }
        : null;
    return {
      status: !present ? "owner_missing" : age > deadline ? "stalled" : "responsive",
      observedAt: progress.observedAt,
      phase: progress.phase,
      cycleStage:
        progress.phase === "cycle" &&
        typeof progress.cycleStage === "string" &&
        FINANCE_SCHEDULER_CYCLE_STAGES.some((stage) => stage === progress.cycleStage)
          ? progress.cycleStage
          : undefined,
      ageMs: age,
      deadlineMs: deadline,
      placementEnabled: progress.placementEnabled,
      venue,
      executionPolicyStatus,
      executionPolicyExpiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
      intradayControllerPolicyStatus,
      intradayControllerPolicyExpiresAt: Number.isFinite(intradayControllerPolicyExpiry)
        ? new Date(intradayControllerPolicyExpiry).toISOString()
        : null,
      intraday,
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
