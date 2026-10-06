import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildFinanceAutomaticLifecycleFeedback } from "./finance-automatic-lifecycle-feedback.js";
import {
  appendFinanceBrokerHistory,
  readFinanceLatestBrokerReconciliations,
} from "./finance-position-ledger.js";
import { readFinancePositionManagementFeedback } from "./finance-position-management-feedback.js";
let directory: string;
const at = "2026-09-27T10:00:00.000Z";
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "position-feedback-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
const stop = {
  id: "stop",
  symbol: "SPY",
  qty: "1",
  filled_qty: "0",
  stop_price: "90",
  type: "stop",
  side: "sell",
  status: "new",
  time_in_force: "gtc",
};
async function snapshot(
  positions = [
    { symbol: "BTCUSD", qty: "0.000399" },
    { symbol: "SPY", qty: "1" },
  ],
  accountId = "synthetic",
) {
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId,
    venue: "alpaca:paper",
    query: `reconciliation:${at}`,
    cursor: "",
    payload: [{ observedAt: at, positions, openOrders: [stop] }],
  });
}
const rules = [
  { ruleId: "spy", state: "active", instruments: ["SPY"] },
  { ruleId: "old-btc", state: "retired", instruments: ["BTC/USD"] },
];

it("uses only a same-book exact-clock shared read and keeps standalone semantics", async () => {
  await snapshot();
  const baseline = await readFinancePositionManagementFeedback({
    directory,
    observedAt: at,
    rules,
  });
  const read = vi.fn(() => readFinanceLatestBrokerReconciliations(directory));
  expect(
    await readFinancePositionManagementFeedback({
      directory,
      observedAt: at,
      rules,
      reconciliationObservation: { directory, asOf: at, read },
    }),
  ).toEqual(baseline);
  expect(read).toHaveBeenCalledTimes(1);
  for (const scope of [
    { directory: `${directory}-other`, asOf: at },
    { directory, asOf: "2026-09-27T09:59:00Z" },
  ]) {
    const wrongRead = vi.fn(async () => {
      throw new Error("wrong observation must not be used");
    });
    expect(
      await readFinancePositionManagementFeedback({
        directory,
        observedAt: at,
        rules,
        reconciliationObservation: { ...scope, read: wrongRead },
      }),
    ).toEqual(baseline);
    expect(wrongRead).not.toHaveBeenCalled();
  }
});
it("brings uncovered and out-of-scope holdings into Harness feedback without granting ownership", async () => {
  await snapshot();
  const result = await readFinancePositionManagementFeedback({ directory, observedAt: at, rules });
  expect(result).toMatchObject({
    status: "present",
    needsInspection: true,
    accounts: [
      {
        accountId: "synthetic",
        venue: "alpaca:paper",
        uncoveredCount: 1,
        outsideActiveRuleCount: 1,
        holdings: [
          { instrument: "BTC/USD", status: "no_recognized_stop", activeRuleIds: [] },
          { instrument: "SPY", status: "covered", activeRuleIds: ["spy"] },
        ],
      },
    ],
  });
  expect(await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt: at })).toMatchObject(
    {
      status: "present",
      nextTask: "inspect_finance_position_management",
      positionManagement: {
        needsInspection: true,
        accounts: [{ accountId: "synthetic", venue: "alpaca:paper" }],
      },
    },
  );
});
it("keeps the exact account scope when two accounts hold the same instrument", async () => {
  await snapshot([{ symbol: "SPY", qty: "1" }], "account-a");
  await snapshot([{ symbol: "SPY", qty: "2" }], "account-b");
  const result = await readFinancePositionManagementFeedback({ directory, observedAt: at, rules });
  if (!("accounts" in result) || !result.accounts) {
    throw new Error("missing accounts");
  }
  expect(result.accounts).toHaveLength(2);
  for (const [accountId, positionQuantity] of [
    ["account-a", 1],
    ["account-b", 2],
  ] as const) {
    expect(result.accounts.find((account) => account.accountId === accountId)).toMatchObject({
      accountId,
      venue: "alpaca:paper",
      holdings: [{ instrument: "SPY", positionQuantity }],
    });
  }
});
it("keeps stale and future observations visible without treating them as current action evidence", async () => {
  await snapshot();
  for (const observedAt of ["2026-09-27T10:06:00.000Z", "2026-09-27T09:59:00.000Z"]) {
    expect(
      await readFinancePositionManagementFeedback({ directory, observedAt, rules }),
    ).toMatchObject({
      status: "present",
      needsInspection: false,
      accounts: [{ freshness: "stale", positionCount: 2 }],
    });
  }
});
it("does not use a snapshot superseded by a later broker observation", async () => {
  await snapshot();
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId: "synthetic",
    venue: "alpaca:paper",
    query: "activities:FILL",
    cursor: "",
    payload: [],
  });
  expect(
    await readFinancePositionManagementFeedback({ directory, observedAt: at, rules }),
  ).toMatchObject({ needsInspection: false, accounts: [{ freshness: "stale" }] });
});
it("uses the latest snapshot and bounds account projections explicitly", async () => {
  await snapshot();
  await snapshot([{ symbol: "SPY", qty: "1" }]);
  expect(
    await readFinancePositionManagementFeedback({ directory, observedAt: at, rules }),
  ).toMatchObject({
    needsInspection: false,
    accounts: [{ positionCount: 1, outsideActiveRuleCount: 0, uncoveredCount: 0 }],
  });
  for (const account of ["b", "c", "d"]) {
    await snapshot(undefined, account);
  }
  const result = await readFinancePositionManagementFeedback({ directory, observedAt: at, rules });
  expect(result).toMatchObject({ omittedAccounts: 1 });
  expect("accounts" in result && result.accounts?.length).toBe(3);
});
it("reads a missing ledger without creating it and rejects malformed quantities", async () => {
  expect(
    await readFinancePositionManagementFeedback({ directory, observedAt: at, rules }),
  ).toMatchObject({ status: "absent" });
  expect(await fs.readdir(directory)).toEqual([]);
  await snapshot([{ symbol: "SPY", qty: "garbage" }]);
  expect(
    await readFinancePositionManagementFeedback({ directory, observedAt: at, rules }),
  ).toMatchObject({ status: "unavailable", needsInspection: false });
});

it("bounds detail while preserving counts of uncovered holdings", async () => {
  await snapshot(Array.from({ length: 12 }, (_, index) => ({ symbol: `ASSET${index}`, qty: "1" })));
  const result = await readFinancePositionManagementFeedback({ directory, observedAt: at, rules });
  expect(result).toMatchObject({
    needsInspection: true,
    accounts: [{ positionCount: 12, uncoveredCount: 12, outsideActiveRuleCount: 12 }],
  });
  if (!("accounts" in result) || !result.accounts) {
    throw new Error("missing accounts");
  }
  expect(Buffer.byteLength(JSON.stringify(result.accounts), "utf8")).toBeLessThanOrEqual(1600);
  expect(result.accounts[0].holdings.length + result.accounts[0].omittedHoldings).toBe(12);
});
