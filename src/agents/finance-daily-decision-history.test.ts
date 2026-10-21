import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { readFinanceDailyDecisionHistory } from "./finance-daily-decision-history.js";
import {
  commitFinanceSchedulerDatabaseState,
  FINANCE_SCHEDULER_DATABASE,
} from "./finance-scheduler-ledger.js";
import { initializeFinanceSchedulerDatabase } from "./finance-scheduler-state.js";
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "daily-history-"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const asOf = "2026-09-21T19:30:00.000Z";
const cutoff = "2026-09-22T19:30:00.000Z";
function run(runId: string, accountId = "account", completedAt = "2026-09-21T19:31:00.000Z") {
  return {
    runId,
    mode: "day",
    firedAt: asOf,
    completedAt,
    outputTruncated: false,
    execution: { placementEnabled: true, venue: "alpaca" },
    stdout: JSON.stringify({
      mode: "day",
      asOf,
      positionBook: { source: "controller_account", accountId },
      ruleIds: ["daily-trend"],
      tradeDecisionReview: {
        status: "completed",
        candidateInputs: [
          {
            candidateId: "candidate",
            instrument: "SPY",
            side: "buy",
            targetWeight: 0.4,
            currentWeight: 0.1,
            notional: 1000,
          },
        ],
        decisions: [
          {
            candidateId: "candidate",
            decision: "approve",
            rationale: "Previous evidence supported the candidate.",
          },
        ],
      },
      placed: [{ instrument: "SPY", quantity: 2, notional: 500 }],
      refusals: ["SPY: remainder unfilled", "QQQ: unrelated"],
    }),
  };
}
function read() {
  return readFinanceDailyDecisionHistory({
    directory,
    accountId: "account",
    asOf: cutoff,
    instruments: ["SPY"],
  });
}
it("retains scoped prior intent and reported partial placement, excludes foreign/future/truncated runs", () => {
  commitFinanceSchedulerDatabaseState(directory, "{}", [
    run("accepted"),
    run("foreign", "other"),
    run("future", "account", cutoff),
    { ...run("truncated"), outputTruncated: true },
  ]);
  expect(read()).toMatchObject({
    status: "observed",
    excludedRuns: 0,
    entries: [
      {
        runId: "accepted",
        decision: "approve",
        proposedNotional: 1000,
        reportedPlacement: { quantity: 2, notional: 500 },
        refusals: ["SPY: remainder unfilled"],
      },
    ],
  });
  expect(read().entries[0].sourceRef).toMatch(/^[a-f0-9]{64}$/);
});
it("bounds recent journal reads and output while exposing incomplete coverage", () => {
  commitFinanceSchedulerDatabaseState(
    directory,
    "{}",
    Array.from({ length: 30 }, (_, i) => run(`run-${i}`)),
  );
  expect(read()).toMatchObject({
    status: "observed",
    scannedRuns: 24,
    earlierHistoryMayBeOmitted: true,
    omittedCandidates: 16,
  });
  expect(read().entries).toHaveLength(8);
  expect(read().entries[0].runId).toBe("run-29");
});
it("returns unavailable on corruption, never partial trustworthy history", () => {
  commitFinanceSchedulerDatabaseState(directory, "{}", [run("accepted")]);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(directory, FINANCE_SCHEDULER_DATABASE));
  db.exec("UPDATE scheduler_runs SET body='{}'");
  db.close();
  expect(read()).toMatchObject({
    status: "unavailable",
    reason: "scheduler_history_unverified",
    entries: [],
  });
});

it("reserves history for each current instrument before repeating a frequent instrument", () => {
  const rare = run("older-qqq");
  rare.stdout = rare.stdout.replaceAll("SPY", "QQQ");
  commitFinanceSchedulerDatabaseState(directory, "{}", [
    rare,
    ...Array.from({ length: 10 }, (_, i) => run(`frequent-spy-${i}`)),
  ]);
  const history = readFinanceDailyDecisionHistory({
    directory,
    accountId: "account",
    asOf: cutoff,
    instruments: ["SPY", "QQQ"],
  });
  expect(history.entries).toHaveLength(8);
  expect(history.entries.slice(0, 2).map((entry) => entry.instrument)).toEqual(["SPY", "QQQ"]);
  expect(history.entries[0].runId).toBe("frequent-spy-9");
  expect(history.entries[1].runId).toBe("older-qqq");
  expect(history).toMatchObject({ omittedCandidates: 3 });
});

it("uses current candidate priority when more instruments compete than the packet can hold", () => {
  const instruments = Array.from({ length: 10 }, (_, i) => `SYMBOL${i}`);
  commitFinanceSchedulerDatabaseState(
    directory,
    "{}",
    instruments.map((instrument) => {
      const record = run(instrument);
      record.stdout = record.stdout.replaceAll("SPY", instrument);
      return record;
    }),
  );
  const history = readFinanceDailyDecisionHistory({
    directory,
    accountId: "account",
    asOf: cutoff,
    instruments,
  });
  expect(history.entries.map((entry) => entry.instrument)).toEqual(instruments.slice(0, 8));
  expect(history).toMatchObject({ omittedCandidates: 2 });
});

// Relevant history must not depend on unrelated accounts' activity.
it("keeps prior account decisions visible behind unrelated recent runs", () => {
  commitFinanceSchedulerDatabaseState(directory, "{}", [
    run("relevant-prior-decision"),
    ...Array.from({ length: 24 }, (_, i) => run(`other-account-${i}`, "other")),
  ]);
  const history = read();
  expect(history.status).toBe("observed");
  expect(history.entries.map((entry) => entry.runId)).toContain("relevant-prior-decision");
});

it("resumes bounded legacy backfill and refuses incomplete history", () => {
  commitFinanceSchedulerDatabaseState(
    directory,
    "{}",
    Array.from({ length: 130 }, (_, i) => run(`legacy-${i}`)),
  );
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(directory, FINANCE_SCHEDULER_DATABASE));
  db.exec(
    "DROP TABLE scheduler_decision_index; DROP TABLE scheduler_decision_index_progress; DELETE FROM finance_scheduler_migrations WHERE version>=2",
  );
  expect(read()).toMatchObject({ status: "unavailable" });
  initializeFinanceSchedulerDatabase(directory);
  expect(
    db.prepare("SELECT through_sequence FROM scheduler_decision_index_progress").get()
      ?.through_sequence,
  ).toBe(64);
  expect(read()).toMatchObject({ status: "unavailable" });
  initializeFinanceSchedulerDatabase(directory);
  expect(read()).toMatchObject({ status: "unavailable" });
  initializeFinanceSchedulerDatabase(directory);
  expect(read().entries[0]?.runId).toBe("legacy-129");
  const version = db.prepare("PRAGMA data_version").get();
  initializeFinanceSchedulerDatabase(directory);
  expect(db.prepare("PRAGMA data_version").get()).toEqual(version);
  expect(db.prepare("SELECT count(*) AS n FROM scheduler_decision_index").get()?.n).toBe(130);
  expect(
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT run_sequence FROM scheduler_decision_index WHERE account_id=? AND instrument=? AND completed_at<? ORDER BY completed_at DESC, run_sequence DESC LIMIT 24",
      )
      .all("account", "SPY", Date.parse(cutoff))
      .map((row) => row.detail)
      .join(" "),
  ).toContain("scheduler_decision_scope");
  db.close();
});

it.each(["source_digest='wrong'", "completed_at=completed_at-1"])(
  "rejects selected index drift: %s",
  (change) => {
    commitFinanceSchedulerDatabaseState(directory, "{}", [run("accepted")]);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(directory, FINANCE_SCHEDULER_DATABASE));
    db.exec(`UPDATE scheduler_decision_index SET ${change}`);
    db.close();
    expect(read()).toMatchObject({ status: "unavailable", entries: [] });
  },
);

it("finds rare instrument history beyond frequent same-account runs", () => {
  const rare = run("old-qqq");
  rare.stdout = rare.stdout.replaceAll("SPY", "QQQ");
  commitFinanceSchedulerDatabaseState(directory, "{}", [
    rare,
    ...Array.from({ length: 30 }, (_, i) => run(`spy-${i}`)),
  ]);
  const history = readFinanceDailyDecisionHistory({
    directory,
    accountId: "account",
    asOf: cutoff,
    instruments: ["SPY", "QQQ"],
  });
  expect(history.entries.slice(0, 2).map((entry) => entry.instrument)).toEqual(["SPY", "QQQ"]);
  expect(history).toMatchObject({ scannedRuns: 24 });
});

it("rolls back backfill and state together on a corrupt legacy record", () => {
  commitFinanceSchedulerDatabaseState(directory, "{}", [run("first"), run("second")]);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(directory, FINANCE_SCHEDULER_DATABASE));
  db.exec(
    "DELETE FROM scheduler_decision_index; DELETE FROM scheduler_decision_index_progress; UPDATE scheduler_runs SET digest='corrupt' WHERE sequence=2",
  );
  expect(() => commitFinanceSchedulerDatabaseState(directory, '{"new":true}', [])).toThrow(
    /corrupt/,
  );
  expect(db.prepare("SELECT count(*) AS n FROM scheduler_decision_index").get()?.n).toBe(0);
  expect(
    db.prepare("SELECT body FROM scheduler_states ORDER BY sequence DESC LIMIT 1").get()?.body,
  ).toBe("{}");
  db.close();
});

it("orders recovered decisions by completion time rather than import order", () => {
  commitFinanceSchedulerDatabaseState(directory, "{}", [
    run("latest", "account", "2026-09-21T20:00:00.000Z"),
  ]);
  commitFinanceSchedulerDatabaseState(
    directory,
    "{}",
    Array.from({ length: 10 }, (_, i) => run(`late-import-${i}`)),
  );
  const history = read();
  expect(history.entries[0]?.runId).toBe("latest");
  expect(history.entries).toHaveLength(8);
  expect(
    readFinanceDailyDecisionHistory({ directory, accountId: "account", asOf: cutoff }).entries[0]
      ?.runId,
  ).toBe("latest");
});

it("reads bounded whole-account history without a current symbol list and retains distinct runs", () => {
  const wide = run("wide");
  const report = JSON.parse(wide.stdout);
  report.tradeDecisionReview.candidateInputs = Array.from({ length: 30 }, (_, i) => ({
    ...report.tradeDecisionReview.candidateInputs[0],
    candidateId: `candidate-${i}`,
    instrument: `SYMBOL${i}`,
  }));
  wide.stdout = JSON.stringify(report);
  commitFinanceSchedulerDatabaseState(directory, "{}", [
    ...Array.from({ length: 30 }, (_, i) => run(`older-${i}`)),
    wide,
    run("foreign", "other"),
    run("future", "account", cutoff),
  ]);
  const history = readFinanceDailyDecisionHistory({
    directory,
    accountId: "account",
    asOf: cutoff,
  });
  expect(history).toMatchObject({
    status: "observed",
    scannedRuns: 24,
    earlierHistoryMayBeOmitted: true,
  });
  expect(history.entries).toHaveLength(8);
  expect(history.entries[0]).toMatchObject({ instrument: "SYMBOL0", runId: "wide" });
  expect(
    history.entries.every((entry) => entry.runId !== "foreign" && entry.runId !== "future"),
  ).toBe(true);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(directory, FINANCE_SCHEDULER_DATABASE));
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT run_sequence,source_digest,completed_at,instrument FROM scheduler_decision_index INDEXED BY scheduler_decision_account_time WHERE account_id=? AND completed_at<? ORDER BY completed_at DESC,run_sequence DESC",
    )
    .all("account", Date.parse(cutoff))
    .map((row) => row.detail)
    .join(" ");
  expect(plan).toContain("scheduler_decision_account_time");
  expect(plan).not.toContain("TEMP B-TREE");
  db.close();
});

it("keeps account history unavailable until its original index migration is ready", () => {
  commitFinanceSchedulerDatabaseState(directory, "{}", [run("accepted")]);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(directory, FINANCE_SCHEDULER_DATABASE));
  db.exec(
    "DROP INDEX scheduler_decision_account_time; DELETE FROM finance_scheduler_migrations WHERE version=3",
  );
  const before = db.prepare("PRAGMA data_version").get();
  expect(
    readFinanceDailyDecisionHistory({ directory, accountId: "account", asOf: cutoff }),
  ).toMatchObject({ status: "unavailable", entries: [] });
  expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
  initializeFinanceSchedulerDatabase(directory);
  expect(
    readFinanceDailyDecisionHistory({ directory, accountId: "account", asOf: cutoff }).entries[0]
      ?.runId,
  ).toBe("accepted");
  db.exec("UPDATE scheduler_decision_index SET source_digest='wrong'");
  expect(
    readFinanceDailyDecisionHistory({ directory, accountId: "account", asOf: cutoff }),
  ).toMatchObject({ status: "unavailable", entries: [] });
  db.close();
});
