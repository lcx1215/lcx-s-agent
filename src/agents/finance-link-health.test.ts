import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFinanceExecutionReceipt,
  createPaperExecutionAdapter,
} from "./finance-execution-adapter.js";
/**
 * These tests exist because this check was wrong in the direction that is hardest to notice.
 * It called a recorded call with no result a broken loop, when a call inside its horizon has no
 * result because it has not come due. That is the normal state of every call for a month after
 * it is recorded, so the check said the settlement loop was broken every single day — and kept
 * saying it long enough that a report of an actual break would have arrived in a stream of
 * reports that never meant anything.
 */
import { readFinanceLinkHealth, type FinanceLinkHealthCheck } from "./finance-link-health.js";
import {
  appendFinanceBrokerHistory,
  appendFinanceExecutionReceipt,
} from "./finance-position-ledger.js";
import { financeCredentialsPath } from "./finance-state-dir.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

const AS_OF = "2026-09-21";

let dir: string;

beforeEach(async () => {
  vi.stubEnv("ALPACA_API_KEY_ID", "");
  vi.stubEnv("ALPACA_API_SECRET_KEY", "");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-link-health-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeSamples(rows: readonly Record<string, unknown>[]): Promise<void> {
  await fs.writeFile(
    path.join(dir, "research-samples.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

async function writeScored(rows: readonly Record<string, unknown>[]): Promise<void> {
  await fs.writeFile(
    path.join(dir, "research-scored.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

const bet = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  asOf: "2026-08-01T14:00:00.000Z",
  instrument: "SPY",
  direction: "buy",
  conviction: 0.6,
  lastPrice: 600,
  horizonDays: 30,
  ...overrides,
});

async function checkFor(
  id: string,
  schedulerAt = new Date("2026-09-21T22:00:00.000Z"),
): Promise<FinanceLinkHealthCheck> {
  const health = await readFinanceLinkHealth({ directory: dir, asOf: AS_OF, schedulerAt });
  const found = health.checks.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no check with id ${id}`);
  }
  return found;
}

describe("readFinanceLinkHealth settlement supply", () => {
  it("does not call a call that is still inside its horizon unsettled", async () => {
    await writeSamples([bet({ asOf: "2026-09-20T14:00:00.000Z", horizonDays: 30 })]);
    const check = await checkFor("settlement_supply");
    expect(check.ok).toBe(true);
    expect(check.severity).toBe("info");
    // Saying it has no history here is the claim that was wrong: it has no history because
    // nothing is due, not because nothing will be.
    expect(check.summary).toContain("nothing due yet");
    expect(check.summary).toContain("2026-10-20");
  });

  it("reports a call that is past its horizon and still has no result", async () => {
    await writeSamples([bet()]);
    await writeScored([]);
    const check = await checkFor("settlement_supply");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("warn");
    expect(check.summary).toContain("past their horizon");
  });

  it("stops reporting once the matured call has been settled", async () => {
    await writeSamples([bet()]);
    await writeScored([{ instrument: "SPY", conviction: 0.6, outcome: 1 }]);
    const check = await checkFor("settlement_supply");
    expect(check.ok).toBe(true);
    expect(check.severity).toBe("info");
  });

  it("never counts a refused call as an unsettled one", async () => {
    // A direction of "none" is the gate declining to bet. Settlement reports it and never scores
    // it, so counting it as overdue would report a refusal as a break — the confusion the
    // settlement itself refuses to make.
    await writeSamples([bet({ direction: "none", conviction: 0 })]);
    const check = await checkFor("settlement_supply");
    expect(check.ok).toBe(true);
    expect(check.summary).toContain("declined rather than bet");
  });

  it("counts what is waiting, not the raw number of lines recorded", async () => {
    await writeSamples([
      bet({ instrument: "SPY", asOf: "2026-09-20T14:00:00.000Z", horizonDays: 30 }),
      bet({ instrument: "QQQ", direction: "none", asOf: "2026-09-20T14:00:00.000Z" }),
    ]);
    const check = await checkFor("settlement_supply");
    expect(check.ok).toBe(true);
    expect(check.summary).toContain("1 inside their horizon");
    expect(check.summary).toContain("1 declined rather than bet");
  });
});

describe("readFinanceLinkHealth sample universe overlap", () => {
  it("has nothing to compare against when no rule is active", async () => {
    // Every call is outside an empty universe, which would be true of every call and mean
    // nothing. An empty rule book is rule_universe's finding; this one compares.
    await writeSamples([bet({ instrument: "SPY" })]);
    const check = await checkFor("sample_universe_overlap");
    expect(check.ok).toBe(true);
    expect(check.summary).toContain("no active rule universe");
  });
});

describe("scheduler success evidence", () => {
  it("does not require future slots before their market time", async () => {
    const check = await checkFor("scheduler_slots", new Date("2026-09-21T13:00:00.000Z"));
    expect(check.ok).toBe(true);
    expect(check.summary).toContain("no finance cycle slot is due yet");
    expect(check.detail).toMatchObject({ dueSlots: [], unresolvedDueSlots: [] });
  });

  it("does not report a missing night attempt as ever fired", async () => {
    const check = await checkFor("scheduler_slots");
    expect(check.ok).toBe(false);
    expect(check.detail).toMatchObject({ nightEverFired: false });
  });

  it("does not promote legacy attempt markers to successful completion", async () => {
    await fs.writeFile(
      path.join(dir, "daily-cycle-scheduler.json"),
      JSON.stringify({ lastFired: { day: AS_OF, night: AS_OF } }),
    );
    const check = await checkFor("scheduler_slots");
    expect(check.ok).toBe(false);
    expect(check.summary).toContain("success unverified");
  });

  it.each(["failed", "timed_out", "cancelled", "running"])(
    "reports the latest %s attempt even after an earlier same-day success",
    async (status) => {
      await fs.writeFile(
        path.join(dir, "daily-cycle-scheduler.json"),
        JSON.stringify({
          lastFired: { day: AS_OF, night: AS_OF },
          lastSucceeded: { day: AS_OF, night: AS_OF },
          lastStatus: { day: "succeeded", night: "succeeded" },
          lastRun: { status },
        }),
      );
      expect((await checkFor("scheduler_slots")).ok).toBe(false);
    },
  );

  it("recognizes both successfully completed slots without claiming freshness", async () => {
    await fs.writeFile(
      path.join(dir, "daily-cycle-scheduler.json"),
      JSON.stringify({
        lastFired: { day: AS_OF, night: AS_OF },
        lastSucceeded: { day: AS_OF, night: AS_OF },
        lastStatus: { day: "succeeded", night: "succeeded" },
        lastRun: { status: "succeeded" },
      }),
    );
    const check = await checkFor("scheduler_slots");
    expect(check.ok).toBe(true);
    expect(check.summary).toContain("not a freshness check");
  });
});

it("does not hide a failed day rerun behind an earlier same-day success and a successful night", async () => {
  await fs.writeFile(
    path.join(dir, "daily-cycle-scheduler.json"),
    JSON.stringify({
      lastFired: { day: AS_OF, night: AS_OF },
      lastSucceeded: { day: AS_OF, night: AS_OF },
      lastStatus: { day: "failed", night: "succeeded" },
      lastRun: { status: "succeeded", mode: "night" },
    }),
  );
  expect((await checkFor("scheduler_slots")).ok).toBe(false);
});

function venueRead(positions: unknown = []) {
  return vi.fn<FinanceUncachedFetch>(async (url) => ({
    status: 200,
    body: JSON.stringify(url.endsWith("/account") ? { id: "account-a" } : positions),
  }));
}
const fakeEnv = { ALPACA_API_KEY_ID: "FAKE", ALPACA_API_SECRET_KEY: "FAKE" };
async function storeReceipt(accountId?: string, venue = "paper") {
  const at = "2026-09-20T00:00:00Z";
  const receipt = buildFinanceExecutionReceipt({
    intent: {
      intentId: "test",
      runAuthorizationId: "run",
      instrument: "SPY",
      side: "buy",
      orderType: "market",
      quantity: 1,
      referencePrice: 100,
      referencePriceAt: at,
      rationale: "fixture",
    },
    adapter: { ...createPaperExecutionAdapter({ instruments: ["SPY"] }), venue },
    fill: { filledQuantity: 1, fillPrice: 100, filledAt: at, venueRef: "fixture" },
    recordedAt: at,
    accountId,
  });
  await appendFinanceExecutionReceipt(dir, receipt);
}
it("binds credential file lookup to the explicit ledger root without mutating environment", async () => {
  await fs.writeFile(
    financeCredentialsPath(dir),
    "ALPACA_API_KEY_ID=ROOT_FAKE\nALPACA_API_SECRET_KEY=ROOT_SECRET\n",
  );
  const read = venueRead();
  await readFinanceLinkHealth({ directory: dir, env: {}, read });
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0][1].headers["APCA-API-KEY-ID"]).toBe("ROOT_FAKE");
  expect(process.env.ALPACA_API_KEY_ID).toBe("");
});
it("missing credentials is unavailable and cannot report successful parity", async () => {
  const read = venueRead();
  const report = await readFinanceLinkHealth({ directory: dir, read, env: {} });
  expect(report.checks.find((c) => c.id === "venue_ledger_parity")).toMatchObject({
    ok: false,
    severity: "error",
    detail: { checked: false },
  });
  expect(report.ok).toBe(false);
  expect(read).not.toHaveBeenCalled();
});
it("does not compare internal paper or unknown-account fills against broker holdings", async () => {
  await storeReceipt();
  const report = await readFinanceLinkHealth({
    directory: dir,
    env: fakeEnv,
    read: venueRead([{ symbol: "SPY", qty: "1" }]),
  });
  expect(report.checks.find((c) => c.id === "venue_ledger_parity")).toMatchObject({
    ok: false,
    detail: {
      ledgerCount: 0,
      onlyVenue: ["SPY"],
      unassignedReceiptCount: 1,
      historyStatus: "missing",
    },
  });
});
it("compares only matching account and venue execution history", async () => {
  await storeReceipt("account-a", "alpaca:paper");
  await storeReceipt("account-b", "alpaca:paper");
  await storeReceipt("account-a", "paper");
  const report = await readFinanceLinkHealth({
    directory: dir,
    env: fakeEnv,
    read: venueRead([{ symbol: "SPY", qty: "1" }]),
  });
  expect(report.checks.find((c) => c.id === "venue_ledger_parity")).toMatchObject({
    ok: true,
    detail: { ledgerCount: 1, excludedReceiptCount: 2 },
  });
});

it("uses a reconciled broker-history baseline while keeping receipt coverage explicit", async () => {
  await storeReceipt("account-a", "alpaca:paper");
  await appendFinanceBrokerHistory(dir, {
    kind: "broker_history",
    accountId: "account-a",
    venue: "alpaca:paper",
    query: "orders:window",
    cursor: "",
    payload: [{ id: "order-spy", status: "filled", filled_qty: "1" }],
  });
  await appendFinanceBrokerHistory(dir, {
    kind: "broker_history",
    accountId: "account-a",
    venue: "alpaca:paper",
    query: "activities:window",
    cursor: "",
    payload: [
      {
        id: "fill-spy",
        activity_type: "FILL",
        order_id: "order-spy",
        symbol: "SPY",
        side: "buy",
        qty: "1",
        price: "100",
        transaction_time: "2026-09-20T00:00:00Z",
      },
    ],
  });
  await appendFinanceBrokerHistory(dir, {
    kind: "broker_history",
    accountId: "account-a",
    venue: "alpaca:paper",
    query: "sync_receipt:window",
    cursor: "",
    payload: [{ status: "raw_history_synced" }],
  });
  const report = await readFinanceLinkHealth({
    directory: dir,
    env: fakeEnv,
    read: venueRead([{ symbol: "SPY", qty: "1" }]),
  });
  expect(report.checks.find((c) => c.id === "venue_ledger_parity")).toMatchObject({
    ok: true,
    detail: { baselineSource: "broker_history", executionLedgerCount: 1, brokerBaselineCount: 1 },
  });
  expect(report.checks.find((c) => c.id === "execution_receipt_coverage")).toMatchObject({
    ok: false,
    severity: "warn",
  });
});
it.each([
  null,
  [{ symbol: "SPY", qty: null }],
  [{ symbol: "SPY", qty: "" }],
  [
    { symbol: "SPY", qty: "1" },
    { symbol: "SPY", qty: "2" },
  ],
])("rejects malformed venue positions %j", async (positions) => {
  const report = await readFinanceLinkHealth({
    directory: dir,
    env: fakeEnv,
    read: venueRead(positions),
  });
  expect(report.checks.find((c) => c.id === "venue_ledger_parity")).toMatchObject({
    ok: false,
    severity: "error",
    detail: { checked: false },
  });
});
