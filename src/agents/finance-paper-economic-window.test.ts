import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeUsEquityLocalTimeInstant } from "./finance-cycle-schedule.js";
import {
  captureFinancePaperEconomicWindow,
  evaluateFinancePaperEconomicWindow,
  FINANCE_PAPER_ECONOMIC_PROTOCOL,
  readFinancePaperEconomicWindow,
} from "./finance-paper-economic-window.js";
import { appendFinanceBrokerHistory } from "./finance-position-ledger.js";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function directory() {
  const p = await mkdtemp(path.join(os.tmpdir(), "account-economics-"));
  directories.push(p);
  return p;
}
function fixture() {
  const dates = ["2026-09-08", "2026-09-09", "2026-10-15"];
  return {
    protocolRef: caseflowFingerprint(FINANCE_PAPER_ECONOMIC_PROTOCOL),
    accountId: "account-a",
    venue: "alpaca:paper",
    observedAt: "2026-10-16T00:00:00.000Z",
    calendar: dates.map((date) => ({ date, open: "09:30", close: "16:00" })),
    histories: [
      {
        timestamp: dates.map((d) => Date.parse(financeUsEquityLocalTimeInstant(d, 960)!) / 1000),
        equity: [200000, 99000, 98000],
        cashflow: { JNLC: [100000, 0, 0], FEE: [0, -1, -2] },
      },
    ],
    initialFunding: { day: dates[0], amount: 100000, ref: "funding-proof" },
    repairAnchor: { at: "2026-10-15T05:18:54.810Z", equity: 98446.29, ref: "repair-proof" },
    auctions: {
      auctions: Object.fromEntries(
        ["SPY", "QQQ"].map((symbol) => [
          symbol,
          dates.map((d, i) => ({
            d,
            c: [
              {
                c: "M",
                p: 100 + i,
                x: symbol === "SPY" ? "P" : "Q",
                t: financeUsEquityLocalTimeInstant(d, 960)!,
              },
            ],
          })),
        ]),
      ),
      next_page_token: null,
    },
    rawBars: {
      bars: Object.fromEntries(
        ["SPY", "QQQ"].map((s) => [s, dates.map((d, i) => ({ t: `${d}T04:00:00Z`, c: 100 + i }))]),
      ),
      next_page_token: null,
    },
    adjustedBars: {
      bars: Object.fromEntries(
        ["SPY", "QQQ"].map((s) => [
          s,
          dates.map((d, i) => ({ t: `${d}T04:00:00Z`, c: (100 + i) * (i === 0 ? 0.99 : 1) })),
        ]),
      ),
      next_page_token: null,
    },
  };
}
describe("whole-account close economics on original owners", () => {
  it("keeps initial conflict unknown, uses verified funding anchor, and never subtracts posted fees twice", () => {
    const r = evaluateFinancePaperEconomicWindow(fixture());
    expect(r.history).toMatchObject({
      initialClose: null,
      accountEquityReturn: -0.020000000000000018,
      latestClose: 98000,
    });
    expect(r.costs.modelBill).toBeNull();
    expect(r.costs.pendingFees).toBe("unknown");
    expect(r.benchmarks[0].totalReturnProxy).toBeCloseTo(102 / 99 - 1);
    expect(r.postRepair.accountEquityReturn).toBeCloseTo(98000 / 98446.29 - 1);
    expect(r.postRepair.attribution.status).toContain("not_yet_attributed");
    expect(r.nextDecision).toContain("never a waiting period");
  });
  it("never reports the conflicted opening-day double balance as a hundred percent return", () => {
    const f = fixture();
    f.calendar = f.calendar.slice(0, 1);
    f.histories = [
      {
        timestamp: f.histories[0].timestamp.slice(0, 1),
        equity: [200000],
        cashflow: { JNLC: [100000], FEE: [0] },
      },
    ];
    expect(evaluateFinancePaperEconomicWindow(f).history.accountEquityReturn).toBeNull();
  });
  it("does not treat an external deposit as profit without flow-time valuations", () => {
    const f = fixture();
    Object.assign(f.histories[0].cashflow, { CSD: [0, 500, 0] });
    const r = evaluateFinancePaperEconomicWindow(f);
    expect(r.history.accountEquityReturn).toBeNull();
    expect(r.postRepair.accountEquityReturn).toBeNull();
    expect(r.gaps).toContain("external_flow_requires_before_after_valuation; return_unknown");
  });
  it("requires exact calendar close including early close, not a nearby mark", () => {
    const f = fixture();
    f.calendar[1].close = "13:00";
    expect(evaluateFinancePaperEconomicWindow(f).gaps).toContain("close_missing:2026-09-09");
    f.histories[0].timestamp[1] =
      Date.parse(financeUsEquityLocalTimeInstant("2026-09-09", 780)!) / 1000;
    expect(evaluateFinancePaperEconomicWindow(f).history.accountEquityReturn).toBeCloseTo(-0.02);
  });
  it("does not replace missing/ambiguous primary auction or dividend data with an unrelated price", () => {
    const f = fixture();
    f.auctions.auctions.QQQ[2].c.push({ c: "M", p: 999, x: "Q", t: "2026-10-15T20:00:00Z" });
    expect(evaluateFinancePaperEconomicWindow(f).benchmarks[1].totalReturnProxy).toBeNull();
    f.adjustedBars.bars.SPY.pop();
    expect(evaluateFinancePaperEconomicWindow(f).benchmarks[0].missingDates).toContain(
      "2026-10-15",
    );
  });
  it("rejects duplicate close conflicts, future observations, mismatched columns and pagination", () => {
    const f = fixture();
    f.histories.push({ ...f.histories[0], equity: [200001, 99000, 98000] });
    expect(() => evaluateFinancePaperEconomicWindow(f)).toThrow("conflicting");
    const future = fixture();
    future.observedAt = "2026-10-15T19:59:00.000Z";
    expect(() => evaluateFinancePaperEconomicWindow(future)).toThrow("future equity");
    const columns = fixture();
    columns.histories[0].equity.pop();
    expect(() => evaluateFinancePaperEconomicWindow(columns)).toThrow("columns");
    const paged = fixture();
    Object.assign(paged.auctions, { next_page_token: "more" });
    expect(() => evaluateFinancePaperEconomicWindow(paged)).toThrow();
  });
  it("reads only original sealed same-account observations at the receiving cutoff", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T02:00:00.000Z"));
    const dir = await directory(),
      f = fixture();
    await appendFinanceBrokerHistory(dir, {
      kind: "broker_history",
      accountId: "account-a",
      venue: "alpaca:paper",
      query: "account_economics:2026-10-15",
      cursor: "",
      payload: [f],
    });
    const { DatabaseSync } = requireNodeSqlite();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const r = await readFinancePaperEconomicWindow(dir, "account-a", "2026-10-16T01:00:00.000Z");
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("typeof(body)"))).toHaveLength(1);
    prepare.mockRestore();
    expect(r).toHaveProperty("history.accountEquityReturn", -0.020000000000000018);
    expect(
      await readFinancePaperEconomicWindow(dir, "other", "2026-10-16T01:00:00.000Z"),
    ).toHaveProperty("status", "unavailable");
    expect(
      await readFinancePaperEconomicWindow(dir, "account-a", "2026-10-15T22:00:00.000Z"),
    ).toHaveProperty("status", "unavailable");
  });
  it("captures through the original producer then reads the exact funding and repair references", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T02:00:00.000Z"));
    const dir = await directory(),
      f = fixture();
    await appendFinanceBrokerHistory(dir, {
      kind: "broker_history",
      accountId: "account-a",
      venue: "alpaca:paper",
      query: "activities:original",
      cursor: "",
      payload: [
        { id: "funding", activity_type: "JNLC", date: "2026-09-08", net_amount: "100000" },
        { activity_type: "FILL", transaction_time: "2026-09-20T05:10:34.291345Z" },
      ],
    });
    const repair = await appendFinanceBrokerHistory(dir, {
      kind: "broker_history",
      accountId: "account-a",
      venue: "alpaca:paper",
      query: "reconciliation:original",
      cursor: "",
      payload: [
        {
          status: "reconciled",
          observedAt: f.repairAnchor.at,
          accountObservation: { accountId: "account-a", equity: f.repairAnchor.equity },
        },
      ],
    });
    const read = vi.fn(async (url: string) => {
      const u = new URL(url);
      const data =
        u.pathname === "/v2/account"
          ? { id: "account-a", currency: "USD" }
          : u.pathname.endsWith("/calendar")
            ? f.calendar
            : u.pathname.endsWith("/history")
              ? f.histories[0]
              : u.pathname.endsWith("/auctions")
                ? f.auctions
                : u.searchParams.get("adjustment") === "all"
                  ? f.adjustedBars
                  : f.rawBars;
      return { status: 200, body: JSON.stringify(data) };
    });
    const result = await captureFinancePaperEconomicWindow({
      directory: dir,
      accountId: "account-a",
      sessionDate: "2026-10-15",
      signal: new AbortController().signal,
      credentials: { keyId: "local", secretKey: "local" },
      read,
      now: () => new Date("2026-10-16T00:00:00.000Z"),
    });
    expect(result.status).toBe("captured");
    const observed = await readFinancePaperEconomicWindow(
      dir,
      "account-a",
      "2026-10-16T01:00:00.000Z",
    );
    expect(observed).toHaveProperty("postRepair.anchor.ref", repair.record.ref);
    expect(observed).toHaveProperty("history.firstFillAt", "2026-09-20T05:10:34.291345Z");
    expect(observed).toHaveProperty("history.accountEquityReturn", -0.020000000000000018);
    expect(read).toHaveBeenCalledTimes(6);
  });
  it("account mismatch and cancellation stop subsequent reads and persistence", async () => {
    const dir = await directory(),
      abort = new AbortController();
    const wrong = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ id: "other", currency: "USD" }),
    }));
    expect(
      await captureFinancePaperEconomicWindow({
        directory: dir,
        accountId: "account-a",
        sessionDate: "2026-10-15",
        signal: abort.signal,
        credentials: { keyId: "local", secretKey: "local" },
        read: wrong,
      }),
    ).toHaveProperty("status", "unavailable");
    expect(wrong).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn(async () => {
      abort.abort();
      return { status: 200, body: JSON.stringify({ id: "account-a", currency: "USD" }) };
    });
    expect(
      await captureFinancePaperEconomicWindow({
        directory: dir,
        accountId: "account-a",
        sessionDate: "2026-10-15",
        signal: abort.signal,
        credentials: { keyId: "local", secretKey: "local" },
        read: cancelled,
      }),
    ).toHaveProperty("reason", "cancelled_or_timeout");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
