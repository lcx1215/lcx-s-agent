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

export const FINANCE_SCHEDULER_INTRADAY_MONITOR_STATUSES = [
  "blocked_active_strategy_missing_or_ambiguous",
  "blocked_incompatible_active_strategy",
  "blocked_invalid_market_calendar",
  "blocked_invalid_monitor_scope",
  "blocked_invalid_system_universe_snapshot",
  "blocked_market_calendar_unavailable",
  "blocked_missing_market_calendar",
  "blocked_missing_strategy_binding",
  "blocked_outside_strategy_universe",
  "blocked_position_without_strategy_state",
  "blocked_short_position",
  "blocked_stale_or_incompatible_strategy_contract",
  "buy_refused_waiting_for_new_bar",
  "buy_already_terminal",
  "decision_pending_execution",
  "decision_recorded",
  "decision_replayed",
  "entry_cutoff_reached",
  "exit_only_no_exit_signal",
  "exit_only_no_owned_position",
  "market_closed",
  "no_closed_session_bar",
  "no_intraday_head",
  "no_signal",
  "outside_cash_session",
  "research_only",
  "sell_already_terminal",
  "sell_refused_waiting_for_new_bar",
  "session_exit_bar_missing",
  "session_exit_bar_pending",
  "tick_failed",
  "invalid_result",
] as const;

export type FinanceSchedulerIntradayMonitorStatus =
  (typeof FINANCE_SCHEDULER_INTRADAY_MONITOR_STATUSES)[number];

export type FinanceSchedulerIntradayLastTick = Readonly<{
  instrument: string;
  observedAt: string;
  monitorStatus: FinanceSchedulerIntradayMonitorStatus;
  action?: "buy" | "sell" | "hold";
  reason?:
    | "opening_range_breakout"
    | "opening_range_stop"
    | "reward_target"
    | "pre_close"
    | "no_trigger"
    | "monitor_tick_failed"
    | "monitor_result_invalid";
  referenceTime?: string;
  outcomeStatus?: "placed" | "refused" | "uncertain";
  executionStatus?:
    | "already_terminal"
    | "placed"
    | "recovered_placed"
    | "refused"
    | "uncertain"
    | "failed";
}>;

function isFinanceSchedulerIntradayMonitorStatus(
  value: unknown,
): value is FinanceSchedulerIntradayMonitorStatus {
  return FINANCE_SCHEDULER_INTRADAY_MONITOR_STATUSES.some((status) => status === value);
}

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

const FINANCE_SCHEDULER_INTRADAY_EXECUTION_STATUSES = new Set([
  "already_terminal",
  "placed",
  "recovered_placed",
  "refused",
  "uncertain",
  "failed",
]);
const FINANCE_SCHEDULER_INTRADAY_OUTCOME_STATUSES = new Set(["placed", "refused", "uncertain"]);
const FINANCE_SCHEDULER_INTRADAY_OUTCOME_MONITOR_STATUSES = new Set([
  "buy_already_terminal",
  "sell_already_terminal",
  "buy_refused_waiting_for_new_bar",
  "sell_refused_waiting_for_new_bar",
]);
const FINANCE_SCHEDULER_INTRADAY_ACTIONS = new Set(["buy", "sell", "hold"]);
const FINANCE_SCHEDULER_INTRADAY_REASONS = new Set([
  "opening_range_breakout",
  "opening_range_stop",
  "reward_target",
  "pre_close",
  "no_trigger",
  "monitor_tick_failed",
  "monitor_result_invalid",
]);

/**
 * Read a bounded last-tick observation from scheduler progress. Unknown, old, future,
 * mismatched-symbol, or semantically inconsistent fields remain unreported.
 */
export function normalizeFinanceSchedulerIntradayLastTick(
  value: unknown,
  params: { instruments: readonly string[]; nowMs: number; intervalSeconds: number },
): FinanceSchedulerIntradayLastTick | null {
  if (![60, 300, 900].includes(params.intervalSeconds)) {
    return null;
  }
  if (!isObject(value)) {
    return null;
  }
  const instrument = value.instrument;
  const observedAt = value.observedAt;
  const monitorStatus = value.monitorStatus;
  if (
    typeof instrument !== "string" ||
    !/^[A-Z0-9][A-Z0-9./:_-]{0,31}$/.test(instrument) ||
    !params.instruments.includes(instrument) ||
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt)) ||
    Date.parse(observedAt) > params.nowMs ||
    params.nowMs - Date.parse(observedAt) > 2 * FINANCE_SCHEDULER_TICK_MS ||
    !isFinanceSchedulerIntradayMonitorStatus(monitorStatus)
  ) {
    return null;
  }

  const action = value.action;
  const reason = value.reason;
  const referenceTime = value.referenceTime;
  const outcomeStatus = value.outcomeStatus;
  const executionStatus = value.executionStatus;
  if (
    (action !== undefined &&
      (typeof action !== "string" || !FINANCE_SCHEDULER_INTRADAY_ACTIONS.has(action))) ||
    (reason !== undefined &&
      (typeof reason !== "string" || !FINANCE_SCHEDULER_INTRADAY_REASONS.has(reason))) ||
    (outcomeStatus !== undefined &&
      (typeof outcomeStatus !== "string" ||
        !FINANCE_SCHEDULER_INTRADAY_OUTCOME_STATUSES.has(outcomeStatus))) ||
    (executionStatus !== undefined &&
      (typeof executionStatus !== "string" ||
        !FINANCE_SCHEDULER_INTRADAY_EXECUTION_STATUSES.has(executionStatus)))
  ) {
    return null;
  }

  const observedAtMs = Date.parse(observedAt);
  if (referenceTime !== undefined) {
    if (
      typeof referenceTime !== "string" ||
      !Number.isFinite(Date.parse(referenceTime)) ||
      Date.parse(referenceTime) > observedAtMs ||
      ((monitorStatus === "decision_recorded" ||
        monitorStatus === "decision_replayed" ||
        executionStatus !== undefined) &&
        observedAtMs - Date.parse(referenceTime) > params.intervalSeconds * 3_000)
    ) {
      return null;
    }
  }
  if (
    (monitorStatus === "no_signal" &&
      (action !== "hold" || reason !== "no_trigger" || referenceTime === undefined)) ||
    ((monitorStatus === "decision_recorded" || monitorStatus === "decision_replayed") &&
      ((action !== "buy" && action !== "sell") ||
        referenceTime === undefined ||
        (reason !== "opening_range_breakout" &&
          reason !== "opening_range_stop" &&
          reason !== "reward_target" &&
          reason !== "pre_close"))) ||
    (executionStatus !== undefined &&
      monitorStatus !== "decision_recorded" &&
      monitorStatus !== "decision_pending_execution") ||
    (outcomeStatus !== undefined &&
      executionStatus === undefined &&
      !FINANCE_SCHEDULER_INTRADAY_OUTCOME_MONITOR_STATUSES.has(monitorStatus)) ||
    ((monitorStatus === "tick_failed" || monitorStatus === "invalid_result") &&
      (action !== undefined || executionStatus !== undefined))
  ) {
    return null;
  }

  return {
    instrument,
    observedAt,
    monitorStatus,
    ...(action !== undefined
      ? { action: action as FinanceSchedulerIntradayLastTick["action"] }
      : {}),
    ...(reason !== undefined
      ? { reason: reason as FinanceSchedulerIntradayLastTick["reason"] }
      : {}),
    ...(referenceTime !== undefined ? { referenceTime } : {}),
    ...(outcomeStatus !== undefined
      ? { outcomeStatus: outcomeStatus as FinanceSchedulerIntradayLastTick["outcomeStatus"] }
      : {}),
    ...(executionStatus !== undefined
      ? { executionStatus: executionStatus as FinanceSchedulerIntradayLastTick["executionStatus"] }
      : {}),
  };
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
    const executionPolicyAuthorizationMode = resolveProgressAuthorizationMode(
      progress.executionPolicyAuthorizationMode,
      progress.executionPolicyExpiresAt,
    );
    const expires =
      typeof progress.executionPolicyExpiresAt === "string"
        ? Date.parse(progress.executionPolicyExpiresAt)
        : NaN;
    const executionPolicyStatus =
      venue === "paper"
        ? "not_required"
        : venue !== "alpaca"
          ? "unknown"
          : executionPolicyAuthorizationMode === "until_revoked"
            ? "until_revoked"
            : executionPolicyAuthorizationMode !== "until_expiry" || !Number.isFinite(expires)
              ? "unavailable"
              : expires <= now
                ? "expired"
                : "current";
    const intradayControllerPolicyAuthorizationMode = resolveProgressAuthorizationMode(
      progress.intradayControllerPolicyAuthorizationMode,
      progress.intradayControllerPolicyExpiresAt,
    );
    const intradayControllerPolicyExpiry =
      typeof progress.intradayControllerPolicyExpiresAt === "string"
        ? Date.parse(progress.intradayControllerPolicyExpiresAt)
        : NaN;
    const intradayControllerPolicyStatus =
      venue !== "alpaca" || !isObject(progress.intraday) || progress.intraday.enabled !== true
        ? "not_applicable"
        : intradayControllerPolicyAuthorizationMode === "until_revoked"
          ? "until_revoked"
          : intradayControllerPolicyAuthorizationMode !== "until_expiry" ||
              !Number.isFinite(intradayControllerPolicyExpiry)
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
            lastTick: normalizeFinanceSchedulerIntradayLastTick(intradayConfig.lastTick, {
              instruments: symbolList(intradayConfig.instruments) ? intradayConfig.instruments : [],
              nowMs: now,
              intervalSeconds:
                intradayConfig.intervalSeconds === 60 ||
                intradayConfig.intervalSeconds === 300 ||
                intradayConfig.intervalSeconds === 900
                  ? intradayConfig.intervalSeconds
                  : 0,
            }),
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
      executionPolicyAuthorizationMode: venue === "paper" ? null : executionPolicyAuthorizationMode,
      executionPolicyExpiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
      intradayControllerPolicyStatus,
      intradayControllerPolicyAuthorizationMode:
        intradayControllerPolicyAuthorizationMode === "unknown"
          ? null
          : intradayControllerPolicyAuthorizationMode,
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
  const authorization = readFinanceSchedulerPolicyAuthorization(filename);
  return authorization.authorizationMode === "until_expiry" ? authorization.expiresAt : null;
}

export type FinanceSchedulerPolicyAuthorizationMode = "until_expiry" | "until_revoked" | "unknown";

export function readFinanceSchedulerPolicyAuthorization(filename: string | undefined): {
  authorizationMode: FinanceSchedulerPolicyAuthorizationMode;
  expiresAt: string | null;
} {
  if (!filename) {
    return { authorizationMode: "unknown", expiresAt: null };
  }
  try {
    const policy: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!isObject(policy)) {
      return { authorizationMode: "unknown", expiresAt: null };
    }
    if (policy.authorizationMode === "until_revoked" && !("expiresAt" in policy)) {
      return { authorizationMode: "until_revoked", expiresAt: null };
    }
    if (
      (policy.authorizationMode === undefined || policy.authorizationMode === "until_expiry") &&
      typeof policy.expiresAt === "string" &&
      Number.isFinite(Date.parse(policy.expiresAt))
    ) {
      return { authorizationMode: "until_expiry", expiresAt: policy.expiresAt };
    }
    return { authorizationMode: "unknown", expiresAt: null };
  } catch {
    return { authorizationMode: "unknown", expiresAt: null };
  }
}

function resolveProgressAuthorizationMode(
  mode: unknown,
  expiresAt: unknown,
): FinanceSchedulerPolicyAuthorizationMode {
  if (mode === "until_revoked" && expiresAt === null) {
    return "until_revoked";
  }
  if (
    (mode === "until_expiry" || mode === undefined) &&
    typeof expiresAt === "string" &&
    Number.isFinite(Date.parse(expiresAt))
  ) {
    return "until_expiry";
  }
  return "unknown";
}
