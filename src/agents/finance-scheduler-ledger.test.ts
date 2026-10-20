import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  commitFinanceSchedulerDatabaseState,
  FINANCE_SCHEDULER_DATABASE,
  readFinanceSchedulerDatabaseResearchRuns,
} from "./finance-scheduler-ledger.js";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "research-run-history-"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it("reads bounded day/night history in original sequence order and exposes older runs", () => {
  const absent = path.join(directory, "absent");
  expect(readFinanceSchedulerDatabaseResearchRuns(absent)).toEqual({
    runs: [],
    olderRunsMayExist: false,
  });
  expect(fs.existsSync(absent)).toBe(false);
  expect(() => readFinanceSchedulerDatabaseResearchRuns(absent, 33)).toThrow("history limit");
  const originals = Array.from({ length: 34 }, (_, index) => ({
    runId: `run-${index}`,
    mode: index % 2 === 0 ? "day" : "night",
    // Sequence, rather than completion time or mode, determines continuation search order.
    completedAt: new Date(Date.UTC(2026, 8, 22, 12, 34 - index)).toISOString(),
  }));
  commitFinanceSchedulerDatabaseState(directory, "{}", originals);
  const page = readFinanceSchedulerDatabaseResearchRuns(directory);
  expect(page.olderRunsMayExist).toBe(true);
  expect(page.runs.map((entry) => entry.run)).toEqual(originals.toReversed().slice(0, 16));
  expect(page.runs[0].ref).toBe(
    createHash("sha256").update(JSON.stringify(originals[33])).digest("hex"),
  );
  const maximumPage = readFinanceSchedulerDatabaseResearchRuns(directory, 32);
  expect(maximumPage.runs).toHaveLength(32);
  expect(maximumPage.olderRunsMayExist).toBe(true);
});

it("verifies state, returned rows and the extra sentinel instead of hiding corrupt history", () => {
  commitFinanceSchedulerDatabaseState(directory, "{}", [
    { runId: "older", mode: "day" },
    { runId: "latest", mode: "night" },
  ]);
  expect(readFinanceSchedulerDatabaseResearchRuns(directory, 2).olderRunsMayExist).toBe(false);
  const { DatabaseSync } = requireNodeSqlite();
  const filename = path.join(directory, FINANCE_SCHEDULER_DATABASE);
  const mutate = (sql: string) => {
    const db = new DatabaseSync(filename);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  mutate("UPDATE scheduler_runs SET digest='corrupt' WHERE sequence=1");
  // The older row is only the sentinel here, but still must be verified.
  expect(() => readFinanceSchedulerDatabaseResearchRuns(directory, 1)).toThrow("corrupt");
  const olderBody = JSON.stringify({ runId: "older", mode: "day" });
  const digest = createHash("sha256").update(olderBody).digest("hex");
  const db = new DatabaseSync(filename);
  try {
    db.prepare("UPDATE scheduler_runs SET digest=? WHERE sequence=1").run(digest);
  } finally {
    db.close();
  }
  mutate("UPDATE scheduler_runs SET body='{}' WHERE sequence=2");
  expect(() => readFinanceSchedulerDatabaseResearchRuns(directory, 1)).toThrow("corrupt");
  const repair = new DatabaseSync(filename);
  try {
    repair
      .prepare("UPDATE scheduler_runs SET body=? WHERE sequence=2")
      .run(JSON.stringify({ runId: "latest", mode: "night" }));
  } finally {
    repair.close();
  }
  mutate("UPDATE scheduler_states SET digest='corrupt'");
  expect(() => readFinanceSchedulerDatabaseResearchRuns(directory, 1)).toThrow("corrupt");
});
