import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  FINANCE_SCHEDULER_DATABASE,
  readFinanceSchedulerDatabaseRuns,
} from "./finance-scheduler-ledger.js";
import {
  readFinanceSchedulerState,
  readFinanceSchedulerPolicyExpiry,
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
    }),
  );
  expect(
    inspectFinanceSchedulerProgress(directory, 1, true, at.getTime()).executionPolicyStatus,
  ).toBe("current");
  expect(inspectFinanceSchedulerProgress(directory, 1, true, at.getTime() + 1000)).toMatchObject({
    status: "responsive",
    executionPolicyStatus: "expired",
  });
  fs.writeFileSync(
    filename,
    JSON.stringify({ expiresAt: new Date(at.getTime() + 5000).toISOString() }),
  );
  expect(readFinanceSchedulerPolicyExpiry(filename)).not.toBe(expiry);
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
