import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readFinanceSchedulerState,
  readFinanceSchedulerPolicyExpiry,
  inspectFinanceSchedulerProgress,
  writeFinanceSchedulerState,
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
  expect(fs.readdirSync(directory)).toEqual(["daily-cycle-scheduler.json"]);
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
