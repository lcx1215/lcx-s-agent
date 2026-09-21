import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFinanceLinkHealth, type FinanceLinkHealthCheck } from "./finance-link-health.js";

/**
 * These tests exist because this check was wrong in the direction that is hardest to notice.
 * It called a recorded call with no result a broken loop, when a call inside its horizon has no
 * result because it has not come due. That is the normal state of every call for a month after
 * it is recorded, so the check said the settlement loop was broken every single day — and kept
 * saying it long enough that a report of an actual break would have arrived in a stream of
 * reports that never meant anything.
 */

const AS_OF = "2026-09-21";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-link-health-"));
});

afterEach(async () => {
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

async function checkFor(id: string): Promise<FinanceLinkHealthCheck> {
  const health = await readFinanceLinkHealth({ directory: dir, asOf: AS_OF });
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
