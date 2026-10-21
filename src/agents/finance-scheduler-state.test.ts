import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  commitFinanceSchedulerDatabaseState,
  FINANCE_SCHEDULER_DATABASE,
  readFinanceSchedulerDatabaseRuns,
} from "./finance-scheduler-ledger.js";
import { FINANCE_SCHEDULER_LOCK } from "./finance-scheduler-lock.js";
import {
  readFinanceSchedulerState,
  readFinanceSchedulerPolicyExpiry,
  readFinanceSchedulerPolicyAuthorization,
  inspectFinanceSchedulerProgress,
  writeFinanceSchedulerState,
  initializeFinanceSchedulerDatabase,
} from "./finance-scheduler-state.js";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-state-test-"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it("reads legacy attempt markers without inventing successful completions", () => {
  fs.writeFileSync(
    path.join(directory, "daily-cycle-scheduler.json"),
    '{"lastFired":{"day":"2026-09-21"}}',
  );
  expect(readFinanceSchedulerState(directory)).toEqual({
    lastFired: { day: "2026-09-21" },
    lastSucceeded: {},
    lastStatus: {},
  });
});

it.each([
  "{bad",
  "null",
  "[]",
  '{"lastFired":null}',
  '{"lastFired":[]}',
  '{"lastFired":{"day":42}}',
  '{"lastFired":{},"lastSucceeded":null}',
])("does not reset invalid state %s", (raw) => {
  const filename = path.join(directory, "daily-cycle-scheduler.json");
  fs.writeFileSync(filename, raw);
  expect(() => readFinanceSchedulerState(directory)).toThrow();
  expect(fs.readFileSync(filename, "utf8")).toBe(raw);
});

it("atomically replaces a valid state without leaving temporary files", () => {
  const state = {
    lastFired: { day: "2026-09-21" },
    lastSucceeded: {},
    lastStatus: {},
    lastRun: { status: "running" },
  };
  writeFinanceSchedulerState(directory, state);
  expect(readFinanceSchedulerState(directory)).toEqual(state);
  expect(fs.readdirSync(directory)).toEqual(
    expect.arrayContaining(["daily-cycle-scheduler.json", FINANCE_SCHEDULER_DATABASE]),
  );
  expect(fs.readdirSync(directory).some((file) => file.includes(".tmp-"))).toBe(false);
});

it("re-reads policy expiry and keeps missing or malformed metadata unavailable", () => {
  const filename = path.join(directory, "policy.json");
  expect(readFinanceSchedulerPolicyExpiry(filename)).toBeNull();
  for (const value of [
    "{",
    "null",
    JSON.stringify({ expiresAt: "invalid" }),
    JSON.stringify({ expiresAt: null }),
  ]) {
    fs.writeFileSync(filename, value);
    expect(readFinanceSchedulerPolicyExpiry(filename)).toBeNull();
  }
  const at = new Date("2026-09-22T12:00:00Z");
  const expiry = new Date(at.getTime() + 1000).toISOString();
  fs.writeFileSync(filename, JSON.stringify({ expiresAt: expiry }));
  const lock = path.join(directory, "daily-cycle-scheduler.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, "progress.json"),
    JSON.stringify({
      pid: 1,
      observedAt: at.toISOString(),
      phase: "idle",
      timeoutMs: 900000,
      placementEnabled: true,
      venue: "alpaca",
      executionPolicyExpiresAt: readFinanceSchedulerPolicyExpiry(filename),
      intradayControllerPolicyExpiresAt: expiry,
      intraday: {
        enabled: true,
        placementEnabled: true,
        placementRequested: true,
        placementEligibility: "paper_contract_only",
        instrumentSource: "active_rule",
        instruments: ["SPY"],
        executionInstruments: ["SPY"],
        intervalSeconds: 300,
        feed: "iex",
      },
    }),
  );
  expect(
    inspectFinanceSchedulerProgress(directory, 1, true, at.getTime()).executionPolicyStatus,
  ).toBe("current");
  expect(inspectFinanceSchedulerProgress(directory, 1, true, at.getTime() + 1000)).toMatchObject({
    status: "responsive",
    executionPolicyStatus: "expired",
    executionPolicyExpiresAt: expiry,
    intradayControllerPolicyStatus: "expired",
    intradayControllerPolicyExpiresAt: expiry,
    intraday: {
      enabled: true,
      placementEnabled: true,
      placementRequested: true,
      placementEligibility: "paper_contract_only",
      instrumentSource: "active_rule",
      instruments: ["SPY"],
      executionInstruments: ["SPY"],
      intervalSeconds: 300,
      feed: "iex",
    },
  });
  fs.writeFileSync(
    filename,
    JSON.stringify({ expiresAt: new Date(at.getTime() + 5000).toISOString() }),
  );
  expect(readFinanceSchedulerPolicyExpiry(filename)).not.toBe(expiry);
  expect(inspectFinanceSchedulerProgress(directory, 1, true, at.getTime() + 1000)).toMatchObject({
    executionPolicyExpiresAt: expiry,
    intradayControllerPolicyExpiresAt: expiry,
  });
});

it("reports explicit until-revoked authorization separately from expiry and rejects mixed metadata", () => {
  const filename = path.join(directory, "policy.json");
  fs.writeFileSync(filename, JSON.stringify({ authorizationMode: "until_revoked" }));
  expect(readFinanceSchedulerPolicyAuthorization(filename)).toEqual({
    authorizationMode: "until_revoked",
    expiresAt: null,
  });
  expect(readFinanceSchedulerPolicyExpiry(filename)).toBeNull();
  fs.writeFileSync(
    filename,
    JSON.stringify({ authorizationMode: "until_expiry", expiresAt: "2026-09-22T12:00:00Z" }),
  );
  expect(readFinanceSchedulerPolicyAuthorization(filename)).toEqual({
    authorizationMode: "until_expiry",
    expiresAt: "2026-09-22T12:00:00Z",
  });
  fs.writeFileSync(
    filename,
    JSON.stringify({ authorizationMode: "until_revoked", expiresAt: "2026-09-22T12:00:00Z" }),
  );
  expect(readFinanceSchedulerPolicyAuthorization(filename)).toEqual({
    authorizationMode: "unknown",
    expiresAt: null,
  });
  fs.writeFileSync(filename, JSON.stringify({ authorizationMode: "other" }));
  expect(readFinanceSchedulerPolicyAuthorization(filename).authorizationMode).toBe("unknown");
});

it("distinguishes resident until-revoked policy from malformed and legacy expiry progress", () => {
  const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
  fs.mkdirSync(lock);
  const filename = path.join(lock, "progress.json");
  const at = new Date("2026-09-22T12:00:00Z");
  const progress = {
    pid: 1,
    observedAt: at.toISOString(),
    phase: "idle",
    timeoutMs: 900000,
    placementEnabled: true,
    venue: "alpaca",
    executionPolicyAuthorizationMode: "until_revoked",
    executionPolicyExpiresAt: null,
    intradayControllerPolicyAuthorizationMode: "until_revoked",
    intradayControllerPolicyExpiresAt: null,
    intraday: { enabled: true },
  };
  fs.writeFileSync(filename, JSON.stringify(progress));
  expect(inspectFinanceSchedulerProgress(directory, 1, true, at.getTime())).toMatchObject({
    executionPolicyStatus: "until_revoked",
    executionPolicyAuthorizationMode: "until_revoked",
    intradayControllerPolicyStatus: "until_revoked",
    intradayControllerPolicyAuthorizationMode: "until_revoked",
  });
  fs.writeFileSync(
    filename,
    JSON.stringify({
      ...progress,
      executionPolicyExpiresAt: "2026-09-22T13:00:00Z",
      intradayControllerPolicyExpiresAt: "2026-09-22T13:00:00Z",
    }),
  );
  expect(inspectFinanceSchedulerProgress(directory, 1, true, at.getTime())).toMatchObject({
    executionPolicyStatus: "unavailable",
    executionPolicyAuthorizationMode: "unknown",
    intradayControllerPolicyStatus: "not_loaded",
    intradayControllerPolicyAuthorizationMode: null,
  });
  fs.writeFileSync(
    filename,
    JSON.stringify({
      ...progress,
      executionPolicyAuthorizationMode: undefined,
      executionPolicyExpiresAt: "2026-09-22T13:00:00Z",
    }),
  );
  expect(inspectFinanceSchedulerProgress(directory, 1, true, at.getTime())).toMatchObject({
    executionPolicyStatus: "current",
    executionPolicyAuthorizationMode: "until_expiry",
  });
});

it("keeps fresh status reads read-only", () => {
  expect(readFinanceSchedulerState(directory).lastFired).toEqual({});
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("migrates legacy history once and reads the database despite a stale compatibility file", () => {
  const old = {
    lastFired: { day: "2026-09-21" },
    lastStatus: { day: "running" },
    lastSucceeded: {},
  };
  fs.writeFileSync(path.join(directory, "daily-cycle-scheduler.json"), JSON.stringify(old));
  const run = {
    runId: "old-night",
    mode: "night",
    status: "succeeded",
    stdout: "x".repeat(300000),
  };
  fs.writeFileSync(path.join(directory, "daily-cycle-runs.jsonl"), JSON.stringify(run) + "\n");
  initializeFinanceSchedulerDatabase(directory);
  initializeFinanceSchedulerDatabase(directory);
  fs.writeFileSync(path.join(directory, "daily-cycle-scheduler.json"), "{}");
  fs.writeFileSync(path.join(directory, "daily-cycle-runs.jsonl"), "corrupt legacy mirror");
  expect(readFinanceSchedulerState(directory)).toEqual(old);
  expect(readFinanceSchedulerDatabaseRuns(directory)?.night).toEqual(run);
});

it("atomically preserves the old claim when a conflicting terminal result cannot be stored", () => {
  const old = {
    lastFired: { day: "2026-09-21" },
    lastStatus: { day: "failed" },
    lastSucceeded: {},
    lastRun: {
      runId: "one",
      mode: "day",
      status: "failed",
      researchPlanRefresh: { processResult: { stdout: "source failure" } },
    },
  };
  writeFinanceSchedulerState(directory, old);
  writeFinanceSchedulerState(directory, old);
  expect(() =>
    writeFinanceSchedulerState(directory, {
      ...old,
      lastSucceeded: { day: "2026-09-21" },
      lastRun: { runId: "one", mode: "day", status: "succeeded" },
    }),
  ).toThrow("identity conflict");
  expect(readFinanceSchedulerState(directory)).toEqual(old);
  expect(readFinanceSchedulerDatabaseRuns(directory)?.day).toEqual(old.lastRun);
});

it("fails closed on corrupt database state rather than falling back to an empty file", () => {
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-21" },
    lastStatus: { day: "running" },
    lastSucceeded: {},
  });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(directory, FINANCE_SCHEDULER_DATABASE));
  db.exec("UPDATE scheduler_states SET body='{}'");
  db.close();
  fs.writeFileSync(path.join(directory, "daily-cycle-scheduler.json"), '{"lastFired":{}}');
  expect(() => readFinanceSchedulerState(directory)).toThrow("corrupt");
});

it("does not replay a stale compatibility snapshot after the migrated database disappears", () => {
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-21" },
    lastStatus: { day: "running" },
    lastSucceeded: {},
  });
  fs.unlinkSync(path.join(directory, FINANCE_SCHEDULER_DATABASE));
  expect(() => readFinanceSchedulerState(directory)).toThrow("missing after migration");
});

it("exposes only fresh, schema-valid intraday monitor results from progress", () => {
  const observedAt = "2026-09-22T12:00:00.000Z";
  const referenceTime = "2026-09-22T11:55:00.000Z";
  const now = Date.parse(observedAt);
  const filename = path.join(directory, FINANCE_SCHEDULER_LOCK, "progress.json");
  fs.mkdirSync(path.dirname(filename));
  const base = {
    pid: 1,
    observedAt,
    phase: "idle",
    timeoutMs: 900000,
    placementEnabled: false,
    intraday: {
      enabled: true,
      placementEnabled: false,
      placementRequested: false,
      placementEligibility: "not_requested",
      instrumentSource: "active_rule",
      instruments: ["SPY"],
      executionInstruments: [],
      intervalSeconds: 300,
      feed: "iex",
    },
  };
  const inspect = (lastTick?: Record<string, unknown>, at = now) => {
    fs.writeFileSync(
      filename,
      JSON.stringify({ ...base, intraday: { ...base.intraday, lastTick } }),
    );
    return inspectFinanceSchedulerProgress(directory, 1, true, at);
  };

  expect(inspect(undefined).intraday?.lastTick).toBeNull();
  expect(
    inspect({
      instrument: "SPY",
      observedAt,
      monitorStatus: "no_signal",
      action: "hold",
      reason: "no_trigger",
      referenceTime,
    }).intraday?.lastTick,
  ).toMatchObject({ monitorStatus: "no_signal", action: "hold", reason: "no_trigger" });
  expect(
    inspect({ instrument: "SPY", observedAt, monitorStatus: "outside_cash_session" }).intraday
      ?.lastTick,
  ).toMatchObject({ monitorStatus: "outside_cash_session" });
  expect(
    inspect({ instrument: "SPY", observedAt, monitorStatus: "blocked_market_calendar_unavailable" })
      .intraday?.lastTick,
  ).toMatchObject({ monitorStatus: "blocked_market_calendar_unavailable" });
  expect(
    inspect({
      instrument: "SPY",
      observedAt,
      monitorStatus: "decision_recorded",
      action: "buy",
      reason: "opening_range_breakout",
      referenceTime,
      executionStatus: "refused",
    }).intraday?.lastTick,
  ).toMatchObject({ monitorStatus: "decision_recorded", executionStatus: "refused" });
  expect(
    inspect({
      instrument: "SPY",
      observedAt,
      monitorStatus: "buy_already_terminal",
      action: "buy",
      reason: "opening_range_breakout",
      referenceTime: "2026-09-22T08:00:00.000Z",
    }).intraday?.lastTick,
  ).toMatchObject({
    monitorStatus: "buy_already_terminal",
    referenceTime: "2026-09-22T08:00:00.000Z",
  });
  for (const outcomeStatus of ["placed", "refused"] as const) {
    expect(
      inspect({
        instrument: "SPY",
        observedAt,
        monitorStatus: "sell_already_terminal",
        outcomeStatus,
      }).intraday?.lastTick,
    ).toMatchObject({ monitorStatus: "sell_already_terminal", outcomeStatus });
  }

  const invalid = [
    { instrument: "SPY", observedAt: "2026-09-22T12:01:00Z", monitorStatus: "no_signal" },
    { instrument: "SPY", observedAt: "2026-09-22T11:57:00Z", monitorStatus: "no_signal" },
    {
      instrument: "SPY",
      observedAt,
      monitorStatus: "decision_recorded",
      action: "buy",
      reason: "opening_range_breakout",
      referenceTime: "2026-09-22T08:00:00.000Z",
    },
    { instrument: "WRONG", observedAt, monitorStatus: "outside_cash_session" },
    { instrument: "SPY", observedAt, monitorStatus: "future_status" },
    {
      instrument: "SPY",
      observedAt,
      monitorStatus: "no_signal",
      action: "buy",
      reason: "no_trigger",
      referenceTime,
    },
    {
      instrument: "SPY",
      observedAt,
      monitorStatus: "no_signal",
      action: "hold",
      reason: "no_trigger",
      referenceTime: "2026-09-22T12:00:01Z",
      executionStatus: "placed",
    },
    {
      instrument: "SPY",
      observedAt,
      monitorStatus: "no_signal",
      action: "hold",
      reason: "no_trigger",
      referenceTime,
      outcomeStatus: "placed",
    },
    {
      instrument: "SPY",
      observedAt,
      monitorStatus: "buy_already_terminal",
      outcomeStatus: "pending",
    },
  ];
  for (const tick of invalid) {
    expect(inspect(tick).intraday?.lastTick).toBeNull();
  }
});

it("distinguishes actual busy account work from the legacy main-cycle idle phase", () => {
  const observedAt = "2026-09-22T12:00:00.000Z",
    now = Date.parse(observedAt);
  const filename = path.join(directory, FINANCE_SCHEDULER_LOCK, "progress.json");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const base = {
    pid: 1,
    observedAt,
    phase: "idle",
    timeoutMs: 900000,
    placementEnabled: true,
    venue: "alpaca",
  };
  const inspect = (accountWork?: Record<string, unknown>) => {
    fs.writeFileSync(filename, JSON.stringify({ ...base, accountWork }));
    return inspectFinanceSchedulerProgress(directory, 1, true, now);
  };
  expect(inspect().accountWork?.status).toBe("unavailable");
  const work = {
    schemaVersion: "lcx_finance_account_work_v1",
    observedAt,
    activeWork: "trading",
    queuedWork: 0,
    reconciliationPending: false,
  };
  expect(inspect(work)).toMatchObject({
    status: "responsive",
    phase: "idle",
    accountWork: { status: "busy", activeWork: "trading" },
  });
  expect(inspect({ ...work, activeWork: null, queuedWork: 1 }).accountWork?.status).toBe("busy");
  expect(
    inspect({ ...work, activeWork: null, reconciliationPending: true }).accountWork?.status,
  ).toBe("busy");
  expect(inspect({ ...work, activeWork: null }).accountWork?.status).toBe("idle");
  expect(inspect({ ...work, queuedWork: -1 }).accountWork?.status).toBe("invalid");
  expect(inspect({ ...work, observedAt: "2026-09-22T11:55:00.000Z" }).accountWork?.status).toBe(
    "stale",
  );
});

it("reads day and night feedback from one committed scheduler snapshot", () => {
  const oldDay = { runId: "old-day", mode: "day", status: "failed" };
  const oldNight = { runId: "old-night", mode: "night", status: "succeeded" };
  const nextDay = { runId: "next-day", mode: "day", status: "succeeded" };
  const nextNight = { runId: "next-night", mode: "night", status: "failed" };
  const body = JSON.stringify({ lastFired: {}, lastSucceeded: {}, lastStatus: {} });
  commitFinanceSchedulerDatabaseState(directory, body, [oldDay, oldNight]);
  const { DatabaseSync } = requireNodeSqlite();
  // oxlint-disable-next-line typescript/unbound-method -- invoked with the native receiver via call below.
  const original = DatabaseSync.prototype.prepare;
  let runReads = 0;
  const spy = vi
    .spyOn(DatabaseSync.prototype, "prepare")
    .mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
      if (sql.includes("FROM scheduler_runs WHERE mode=?") && ++runReads === 2) {
        commitFinanceSchedulerDatabaseState(directory, body, [nextDay, nextNight]);
      }
      return original.call(this, sql);
    });
  try {
    expect(readFinanceSchedulerDatabaseRuns(directory)).toEqual({ day: oldDay, night: oldNight });
  } finally {
    spy.mockRestore();
  }
  expect(readFinanceSchedulerDatabaseRuns(directory)).toEqual({ day: nextDay, night: nextNight });
});
