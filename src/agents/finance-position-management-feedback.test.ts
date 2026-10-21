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
it("propagates observation cancellation instead of reporting unavailable evidence", async () => {
  const controller = new AbortController();
  const reason = new Error("feedback read cancelled");
  await expect(
    readFinancePositionManagementFeedback({
      directory,
      observedAt: at,
      rules: [],
      signal: controller.signal,
      reconciliationObservation: {
        directory,
        asOf: at,
        read: async () => {
          controller.abort(reason);
          return { records: [], omittedAccounts: 0 };
        },
      },
    }),
  ).rejects.toBe(reason);
});

it.each([0, 180])(
  "pages every retained holding without skipping byte-trimmed rows (padding=%s)",
  async (padding) => {
    const instruments = Array.from(
      { length: 9 },
      (_, index) => `FIX${index}${"X".repeat(padding)}`,
    );
    const record = await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId: "page-account",
      venue: "alpaca:paper",
      query: `reconciliation:${at}`,
      cursor: "",
      payload: [
        {
          observedAt: at,
          positions: instruments.map((symbol) => ({ symbol, qty: "1" })),
          openOrders: [],
        },
      ],
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 12; pageIndex++) {
      const result = await readFinancePositionManagementFeedback({
        directory,
        observedAt: at,
        rules: [],
        scope: { accountId: "page-account", venue: "alpaca:paper" },
        holdingsPage: { cursor },
      });
      expect(result.status).toBe("present");
      expect(Buffer.byteLength(JSON.stringify(result.accounts))).toBeLessThanOrEqual(1600);
      const account = result.accounts![0];
      expect(account.positionCount).toBe(9);
      expect(account.snapshotRef).toBe(record.record.ref);
      expect(account.holdings.length).toBeGreaterThan(0);
      seen.push(...account.holdings.map((holding) => holding.instrument));
      const page = account.holdingsPage!;
      expect(page.returnedHoldings).toBe(account.holdings.length);
      if (page.complete) {
        break;
      }
      expect(page.nextCursor).toBeTypeOf("string");
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor!;
    }
    expect(seen).toEqual(instruments);
  },
);

it.each(["invalid", "account", "snapshot", "classification", "offset"])(
  "rejects a changed holdings cursor (%s)",
  async (change) => {
    const snapshot = {
      observedAt: at,
      positions: Array.from({ length: 9 }, (_, index) => ({ symbol: `FIX${index}`, qty: "1" })),
      openOrders: [],
    };
    let appendIndex = 0;
    const append = () =>
      appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId: "page-account",
        venue: "alpaca:paper",
        query: `reconciliation:${at}`,
        cursor: String(appendIndex++),
        payload: [snapshot],
      });
    await append();
    const request = {
      directory,
      observedAt: at,
      rules: [],
      scope: { accountId: "page-account", venue: "alpaca:paper" },
      holdingsPage: {},
    };
    const first = await readFinancePositionManagementFeedback(request);
    let cursor = first.accounts![0].holdingsPage!.nextCursor!;
    if (change === "invalid") {
      cursor = "not-json";
    }
    if (change === "snapshot") {
      await append();
    }
    if (change === "offset") {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      cursor = Buffer.from(JSON.stringify({ ...value, offset: 999 })).toString("base64url");
    }
    const result = await readFinancePositionManagementFeedback({
      ...request,
      ...(change === "account"
        ? { scope: { accountId: "other-account", venue: "alpaca:paper" } }
        : {}),
      ...(change === "classification"
        ? { rules: [{ ruleId: "new-rule", state: "active", instruments: ["FIX0"] }] }
        : {}),
      holdingsPage: { cursor },
    });
    expect(result.status).toBe(change === "invalid" ? "invalid_cursor" : "stale_cursor");
    expect(result.accounts).toBeUndefined();
  },
);

it("reports a holdings item that cannot fit rather than returning a looping cursor", async () => {
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId: "page-account",
    venue: "alpaca:paper",
    query: `reconciliation:${at}`,
    cursor: "",
    payload: [
      { observedAt: at, positions: [{ symbol: "X".repeat(2200), qty: "1" }], openOrders: [] },
    ],
  });
  const result = await readFinancePositionManagementFeedback({
    directory,
    observedAt: at,
    rules: [],
    scope: { accountId: "page-account", venue: "alpaca:paper" },
    holdingsPage: {},
  });
  expect(result.accounts![0]).toMatchObject({
    positionCount: 1,
    omittedHoldings: 1,
    holdings: [],
    holdingsPage: {
      status: "item_exceeds_page_budget",
      returnedHoldings: 0,
      remainingHoldings: 1,
      complete: false,
      nextCursor: null,
    },
  });
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
it("keeps uncovered holdings ahead of covered out-of-rule positions within the detail budget", async () => {
  const symbols = ["AAA", "BBB", "CCC", "DDD", "TLT", "ZZZ"];
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId: "synthetic",
    venue: "alpaca:paper",
    query: `reconciliation:${at}`,
    cursor: "",
    payload: [
      {
        observedAt: at,
        positions: symbols.map((symbol) => ({ symbol, qty: "1" })),
        openOrders: symbols.slice(0, 4).map((symbol) => ({ ...stop, id: symbol, symbol })),
      },
    ],
  });
  const result = await readFinancePositionManagementFeedback({
    directory,
    observedAt: at,
    rules: [{ ruleId: "tlt", state: "active", instruments: ["TLT"] }],
  });
  expect(result).toMatchObject({
    needsInspection: true,
    accounts: [
      {
        uncoveredCount: 2,
        outsideActiveRuleCount: 5,
        holdings: [
          { instrument: "TLT", status: "no_recognized_stop" },
          { instrument: "ZZZ", status: "no_recognized_stop" },
          { instrument: "AAA", status: "covered" },
          { instrument: "BBB", status: "covered" },
        ],
        omittedHoldings: 2,
      },
    ],
  });
  expect(
    "accounts" in result && Buffer.byteLength(JSON.stringify(result.accounts)),
  ).toBeLessThanOrEqual(1600);
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
