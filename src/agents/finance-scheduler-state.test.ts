import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readFinanceSchedulerState,
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
