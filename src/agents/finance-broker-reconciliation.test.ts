import { describe, expect, it, vi } from "vitest";
import type { BrokerHistoryRecord } from "./finance-position-ledger.js";
const syncMocks = vi.hoisted(() => ({
  append: vi.fn(),
  history: vi.fn(),
  readHistory: vi.fn(),
  latest: vi.fn(),
}));
vi.mock("./finance-alpaca-history-sync.js", () => ({
  syncAlpacaPaperHistory: syncMocks.history,
}));
vi.mock("./finance-position-ledger.js", () => ({
  appendFinanceBrokerHistory: syncMocks.append,
  readFinanceBrokerHistoryRecords: syncMocks.readHistory,
  reduceFinanceBrokerHistoryRecords: async <T>(
    directory: string,
    accountId: string,
    venue: string,
    initial: T,
    reduce: (value: T, record: BrokerHistoryRecord) => T,
  ) => {
    const history = await syncMocks.readHistory(directory, accountId, venue);
    return {
      value: history.records.reduce(reduce, initial),
      headRef: history.headRef,
      recordCount: history.records.length,
    };
  },
  readFinanceLatestBrokerReconciliations: syncMocks.latest,
}));
import {
  reconcileFinanceBrokerActivities,
  syncFinanceBrokerReconciliation,
  readFinanceBrokerReconciliation,
} from "./finance-broker-reconciliation.js";
const activities = [
  { id: "cash", activity_type: "JNLC", status: "executed", currency: "USD", net_amount: "100" },
  {
    id: "fill",
    activity_type: "FILL",
    type: "fill",
    side: "buy",
    symbol: "BTC/USD",
    qty: "0.001",
    price: "10000",
  },
  {
    id: "fee",
    activity_type: "CFEE",
    status: "executed",
    symbol: "BTCUSD",
    qty: "-0.0000025",
    net_amount: "0",
  },
];
describe("current reconciliation safety view", () => {
  const now = Date.parse("2026-10-09T00:00:00Z");
  it.each([
    [0, false, "reconciled", true, "reconciled"],
    [300_000, false, "reconciled", true, "reconciled"],
    [300_001, false, "reconciled", false, "stale"],
    [-1, false, "reconciled", false, "stale"],
    [0, true, "reconciled", false, "stale"],
    [0, false, "needs_review", false, "needs_review"],
  ] as const)(
    "preserves age %s, superseded %s and status %s",
    async (age, superseded, status, ok, reason) => {
      syncMocks.readHistory.mockClear();
      const snapshot = { observedAt: new Date(now - age).toISOString(), status };
      syncMocks.latest.mockResolvedValue({
        records: [{ snapshot, superseded }],
        omittedAccounts: 0,
      });
      expect(await readFinanceBrokerReconciliation("fixture", "account-a", now)).toEqual({
        ok,
        reason,
        snapshot,
      });
      expect(syncMocks.latest).toHaveBeenLastCalledWith("fixture", {
        scope: { accountId: "account-a", venue: "alpaca:paper" },
      });
      expect(syncMocks.readHistory).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, {}, { observedAt: "invalid", status: "reconciled" }])(
    "fails closed on missing or invalid observation %s",
    async (snapshot) => {
      syncMocks.latest.mockResolvedValue({
        records: snapshot === undefined ? [] : [{ snapshot, superseded: false }],
        omittedAccounts: 0,
      });
      const result = await readFinanceBrokerReconciliation("fixture", "account-a", now);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(snapshot && "observedAt" in snapshot ? "stale" : "missing");
    },
  );
});
describe("broker economic reconciliation", () => {
  it("reconciles crypto fees in units, cash, and duplicate pages without fake sell receipts", () => {
    const result = reconcileFinanceBrokerActivities({
      activities: [...activities, ...activities],
      positions: [{ symbol: "BTCUSD", qty: "0.0009975" }],
      cash: 90,
      completeFromInception: true,
    });
    expect(result.status).toBe("reconciled");
    expect(result.fees).toHaveLength(1);
    expect(result.cashFromActivities).toBe(90);
    expect(result.differences).toEqual([]);
  });
  it("reconciles Alpaca partial-fill activities using the executed quantity", () => {
    const result = reconcileFinanceBrokerActivities({
      activities: [
        {
          id: "partial-fill-cash",
          activity_type: "JNLC",
          status: "executed",
          currency: "USD",
          net_amount: "1000",
        },
        {
          id: "partial-fill",
          activity_type: "FILL",
          type: "partial_fill",
          order_status: "partially_filled",
          side: "buy",
          symbol: "BITO",
          qty: "54",
          cum_qty: "54",
          leaves_qty: "34",
          price: "11.26",
          transaction_time: "2026-10-01T14:33:00.883144Z",
        },
      ],
      positions: [{ symbol: "BITO", qty: "54" }],
      cash: 391.96,
      completeFromInception: true,
    });
    expect(result.status).toBe("reconciled");
    expect(result.cashFromActivities).toBeCloseTo(391.96, 8);
    expect(result.cashDifference).toBeCloseTo(0, 8);
    expect(result.quantities).toEqual([{ instrument: "BITO", quantity: 54 }]);
    expect(result.differences).toEqual([]);
  });
  it("does not invent crypto fees from a matching quantity gap", () => {
    const result = reconcileFinanceBrokerActivities({
      activities: activities.slice(0, 2),
      positions: [{ symbol: "BTCUSD", qty: "0.0009975" }],
      cash: 90,
      completeFromInception: true,
    });
    expect(result.status).toBe("unresolved");
    expect(result.fees).toEqual([]);
    expect(result.differences[0].unexplainedQuantity).toBeCloseTo(-0.0000025, 12);
  });
  it("keeps cash fees separate from asset fees", () => {
    const result = reconcileFinanceBrokerActivities({
      activities: [
        ...activities,
        {
          id: "usd-fee",
          activity_type: "FEE",
          status: "executed",
          currency: "USD",
          net_amount: "-0.02",
        },
      ],
      positions: [{ symbol: "BTCUSD", qty: "0.0009975" }],
      cash: 89.98,
      completeFromInception: true,
    });
    expect(result.status).toBe("reconciled");
    expect(result.fees).toHaveLength(2);
  });
  it("refuses partial history, conflicting identities and unhandled corporate actions", () => {
    const result = reconcileFinanceBrokerActivities({
      activities: [
        ...activities,
        { ...activities[1], qty: "2" },
        { id: "split", activity_type: "SPLIT" },
      ],
      positions: [],
      cash: 0,
      completeFromInception: false,
    });
    expect(result.status).toBe("unresolved");
    expect(result.issues).toContain("conflicting_activity:fill");
    expect(result.issues).toContain("unsupported_activity:split");
    expect(result.issues).toContain("history_not_complete_from_inception");
  });
});

describe("bounded historical quantity isolation", () => {
  function fixture() {
    const reconciliation = reconcileFinanceBrokerActivities({
      activities: activities.slice(0, 2),
      positions: [{ symbol: "BTCUSD", qty: "0.000999" }],
      cash: 90,
      completeFromInception: true,
    });
    return {
      reconciliation,
      positions: [{ instrument: "BTC/USD", quantity: 0.000999, marketValue: 9.99 }],
      isolation: { instruments: ["BTC/USD"], maxUnexplainedNotional: 1 },
    };
  }
  it("retains unresolved history while limiting execution scope under an explicit policy", async () => {
    const { assessFinanceBrokerExecutionReadiness: assess } =
      await import("./finance-broker-reconciliation.js");
    const f = fixture();
    expect(assess({ ...f, isolation: undefined }).status).toBe("blocked");
    const result = assess(f);
    expect(result).toMatchObject({
      status: "restricted",
      historyStatus: "unresolved",
      quarantinedInstruments: ["BTC/USD"],
    });
    expect(result.uncertaintyReserve).toBeGreaterThanOrEqual(0.01);
    expect(f.reconciliation.status).toBe("unresolved");
    expect(f.reconciliation.fees).toEqual([]);
  });
  it.each([
    "cash_difference",
    "history_not_complete_from_inception",
    "unsupported_activity:fee",
    "conflicting_activity:fill",
  ])("does not isolate the account-wide problem %s", async (issue) => {
    const { assessFinanceBrokerExecutionReadiness: assess } =
      await import("./finance-broker-reconciliation.js");
    const f = fixture();
    f.reconciliation.issues.push(issue);
    expect(assess(f).status).toBe("blocked");
  });
  it("blocks excess uncertainty, missing prices, unlisted symbols and unexplained credits", async () => {
    const { assessFinanceBrokerExecutionReadiness: assess } =
      await import("./finance-broker-reconciliation.js");
    const f = fixture();
    expect(
      assess({ ...f, isolation: { ...f.isolation, maxUnexplainedNotional: 0.001 } }).status,
    ).toBe("blocked");
    expect(assess({ ...f, positions: [] }).status).toBe("blocked");
    expect(assess({ ...f, positions: [{ ...f.positions[0], marketValue: 0 }] }).status).toBe(
      "blocked",
    );
    expect(assess({ ...f, isolation: { ...f.isolation, instruments: ["SPY"] } }).status).toBe(
      "blocked",
    );
    f.reconciliation.differences[0].unexplainedQuantity = 0.000001;
    expect(assess(f).status).toBe("blocked");
  });
  it("never interprets blank cash or fees as zero", () => {
    const result = reconcileFinanceBrokerActivities({
      activities: [{ ...activities[0], net_amount: " " }],
      positions: [],
      cash: 0,
      completeFromInception: true,
    });
    expect(result.status).toBe("unresolved");
    expect(result.issues).toContain("unsupported_activity:cash");
  });
});

describe("canonical account observation", () => {
  async function reconcile(
    extra: Record<string, unknown> = {},
    latency?: { historyMs: number; appendMs: number },
  ) {
    syncMocks.append.mockReset();
    syncMocks.history.mockResolvedValue({ status: "raw_history_synced" });
    syncMocks.readHistory.mockResolvedValue({ records: [], headRef: "history-head" });
    if (latency) {
      syncMocks.readHistory.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + latency.historyMs);
        return { records: [], headRef: "history-head" };
      });
      syncMocks.append.mockImplementation(async (_directory, body) => {
        if (body.query.startsWith("reconciliation:")) {
          vi.setSystemTime(Date.now() + latency.appendMs);
        }
      });
    }
    let accountReads = 0;
    const read = vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/v2/account") {
        accountReads++;
      }
      const account = {
        id: "account",
        currency: "USD",
        created_at: "2000-01-01T00:00:00Z",
        cash: "0",
        equity: "1",
        buying_power: "2",
        portfolio_value: "3",
        secret_extra: "never-copy",
        ...(accountReads === 2 ? extra : {}),
      };
      return { status: 200, body: JSON.stringify(pathname === "/v2/account" ? account : []) };
    });
    const snapshot = await syncFinanceBrokerReconciliation({
      directory: "fixture",
      accountId: "account",
      after: "1999-01-01T00:00:00Z",
      until: "2020-01-01T00:00:00Z",
      credentials: { keyId: "fixture", secretKey: "fixture" },
      read,
    });
    return { snapshot, read };
  }
  it("persists only validated final-account values with no additional GET", async () => {
    const { snapshot, read } = await reconcile({
      equity: "123.45",
      buying_power: "999",
      portfolio_value: 123.45,
      balance_asof: "2026-10-07",
      accrued_fees: "0",
      pending_reg_taf_fees: "1.29",
      intraday_adjustments: "-0.25",
    });
    for (const [url] of read.mock.calls.filter(([url]) => /activities\/(?:CFEE|FEE)/u.test(url))) {
      const query = new URL(url).searchParams;
      expect(query.has("after")).toBe(false);
      expect(query.has("until")).toBe(false);
      expect(query.get("direction")).toBe("asc");
      expect(query.get("page_size")).toBe("100");
    }
    expect(
      syncMocks.append.mock.calls
        .slice(0, 2)
        .every(([, body]) => /:observed_fee:/u.test(body.query)),
    ).toBe(true);
    expect(read.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v2/account",
      "/v2/account/activities/CFEE",
      "/v2/account/activities/FEE",
      "/v2/positions",
      "/v2/orders",
      "/v2/account",
    ]);
    expect(snapshot.accountObservation).toMatchObject({
      accountId: "account",
      currency: "USD",
      equity: 123.45,
      buyingPower: 999,
      cash: 0,
      portfolioValue: 123.45,
      balanceAsOf: "2026-10-07",
      accruedFees: 0,
      pendingRegTafFees: 1.29,
      intradayAdjustments: -0.25,
      source: "https://paper-api.alpaca.markets/v2/account",
    });
    expect(Number.isFinite(Date.parse(snapshot.accountObservation?.observedAt ?? ""))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("never-copy");
    expect(snapshot.brokerCash).toBe(0);
    expect(snapshot.cashDifference).toBe(0);
    expect(snapshot.status).toBe("reconciled");
    expect(syncMocks.append.mock.calls.at(-1)?.[1].payload[0].accountObservation).toEqual(
      snapshot.accountObservation,
    );
  });
  it("validates history before final broker reads and never refreshes capture time after a slow append", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-03T04:00:00Z");
    vi.setSystemTime(start);
    try {
      const { snapshot, read } = await reconcile({}, { historyMs: 60000, appendMs: 45000 });
      const paths = read.mock.calls.map(([url]) => new URL(url).pathname);
      const finalPositions = paths.indexOf("/v2/positions");
      const feeRead = paths.indexOf("/v2/account/activities/FEE");
      const historyOrder = syncMocks.readHistory.mock.invocationCallOrder.at(-1)!;
      expect(historyOrder).toBeGreaterThan(read.mock.invocationCallOrder[feeRead]);
      expect(historyOrder).toBeLessThan(read.mock.invocationCallOrder[finalPositions]);
      expect(snapshot.accountObservation.observedAt).toBe(new Date(start + 60000).toISOString());
      expect(snapshot.observedAt).toBe(snapshot.accountObservation.observedAt);
      expect(Date.now() - Date.parse(snapshot.observedAt)).toBe(45000);
      expect(syncMocks.append.mock.calls.at(-1)?.[1].payload[0].observedAt).toBe(
        snapshot.observedAt,
      );
      expect(snapshot.status).toBe("reconciled");
      expect(snapshot.historyHeadRef).toBe("history-head");
      expect(snapshot.protection.coverage).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, null, "", " ", "NaN", "Infinity", "0x10", "1,000", false, {}])(
    "keeps missing or invalid optional values unknown: %j",
    async (value) => {
      const { snapshot } = await reconcile({
        equity: value,
        buying_power: value,
        portfolio_value: value,
        accrued_fees: value,
        pending_reg_taf_fees: value,
        intraday_adjustments: value,
      });
      expect(snapshot.accountObservation).toMatchObject({
        equity: null,
        buyingPower: null,
        portfolioValue: null,
        accruedFees: null,
        pendingRegTafFees: null,
        intradayAdjustments: null,
        unknownValueMeaning: "missing_or_invalid",
      });
    },
  );
  it.each([undefined, null, "", "2026-02-30", "2026-10-07T00:00:00Z", 20261007])(
    "keeps missing or invalid vendor balance dates unknown: %j",
    async (value) => {
      const { snapshot } = await reconcile({ balance_asof: value });
      expect(snapshot.accountObservation.balanceAsOf).toBeNull();
      expect(snapshot.accountObservation.observedAt).toEqual(expect.any(String));
    },
  );
  it("retains finite signed account observations without treating them as buying authority", async () => {
    const { snapshot } = await reconcile({
      cash: "-12.5",
      equity: "-2",
      buying_power: "-1",
      portfolio_value: "-2",
    });
    expect(snapshot.accountObservation).toMatchObject({
      cash: -12.5,
      equity: -2,
      buyingPower: -1,
      portfolioValue: -2,
      boundary: "observed_account_values_not_execution_authority; buying_power_is_not_cash",
    });
  });
  it.each([{ id: "other" }, { currency: "EUR" }])(
    "retains account identity refusal",
    async (extra) => {
      await expect(reconcile(extra)).rejects.toThrow("invalid broker snapshot");
    },
  );
});

describe("cash-flow diagnostic decomposition", () => {
  const fill = {
    id: "sale",
    activity_type: "FILL",
    type: "fill",
    side: "sell",
    symbol: "TEST",
    qty: "1",
    price: "10",
  };
  const transfer = {
    id: "transfer",
    activity_type: "JNLC",
    status: "executed",
    currency: "USD",
    net_amount: "100",
  };
  const fee = {
    id: "cash-fee",
    activity_type: "FEE",
    status: "executed",
    currency: "USD",
    net_amount: "-0.1",
  };
  it("counts only recognized unique cash flows, preserving conflicts and unsupported activity gates", () => {
    const result = reconcileFinanceBrokerActivities({
      activities: [
        transfer,
        fill,
        fee,
        fill,
        fee,
        { ...fill, price: "11" },
        { id: "unsupported", activity_type: "OTHER", net_amount: "999" },
        { ...fee, id: "invalid-fee", currency: "EUR", net_amount: "-9" },
      ],
      positions: [{ symbol: "TEST", qty: "-1" }],
      cash: 109.9,
      completeFromInception: true,
    });
    expect(result.cashComponents).toEqual({ fillCash: 10, feeCash: -0.1, otherCash: 100 });
    expect(result.cashFromActivities).toBe(109.9);
    expect(result.status).toBe("unresolved");
    expect(result.feesInterpreted).toBe(false);
    expect(result.issues).toContain("conflicting_activity:sale");
    expect(result.issues).toContain("unsupported_activity:unsupported");
    expect(result.issues).toContain("unsupported_activity:invalid-fee");
  });
  it("keeps an unexplained cash debit blocked until the actual executed fee is present", () => {
    const input = {
      activities: [transfer, fill],
      positions: [{ symbol: "TEST", qty: "-1" }],
      cash: 109.9,
      completeFromInception: true,
    };
    const missing = reconcileFinanceBrokerActivities(input);
    expect(missing.cashComponents).toEqual({ fillCash: 10, feeCash: 0, otherCash: 100 });
    expect(missing.issues).toContain("cash_difference");
    expect(missing.status).toBe("unresolved");
    expect(missing.feesInterpreted).toBe(false);
    const complete = reconcileFinanceBrokerActivities({
      ...input,
      activities: [...input.activities, fee],
    });
    expect(complete.cashComponents.feeCash).toBe(-0.1);
    expect(complete.status).toBe("reconciled");
    expect(complete.feesInterpreted).toBe(true);
  });
});

describe("fee occurrence cutoff instead of settlement date", () => {
  it("accepts an executed fee with future settlement only when its actual occurrence is proven", () => {
    const fee = {
      id: "actual-fee",
      activity_type: "CFEE",
      status: "executed",
      currency: "USD",
      net_amount: "-0.1",
      date: "2026-10-05",
      created_at: "2026-10-03T05:59:33.962109Z",
    };
    const input = {
      activities: [fee],
      positions: [],
      cash: -0.1,
      completeFromInception: true,
      asOf: "2026-10-04T00:00:00Z",
    };
    expect(reconcileFinanceBrokerActivities(input).status).toBe("reconciled");
    for (const changed of [
      { created_at: "2026-10-05T00:00:00Z" },
      { created_at: "invalid" },
      { transaction_time: "2026-10-05T00:00:00Z" },
      { transaction_time: "2026-02-30T00:00:00Z" },
      { transaction_time: "2026-02-30T00:00:00+08:00" },
      { created_at: "2026-10-03T05:59:33" },
      { created_at: undefined, date: "2026-02-30" },
      { created_at: undefined },
    ]) {
      const result = reconcileFinanceBrokerActivities({
        ...input,
        activities: [{ ...fee, ...changed }],
      });
      expect(result.status).toBe("unresolved");
      expect(result.issues).toContain("unsupported_activity:actual-fee");
      expect(result.cashComponents.feeCash).toBe(0);
    }
    expect(
      reconcileFinanceBrokerActivities({
        ...input,
        activities: [{ ...fee, created_at: undefined, transaction_time: fee.created_at }],
      }).status,
    ).toBe("reconciled");
  });
});

it("rejects a timezone-ambiguous fee cutoff", () => {
  const result = reconcileFinanceBrokerActivities({
    activities: [
      {
        id: "fee-cutoff",
        activity_type: "FEE",
        status: "executed",
        net_amount: "-0.1",
        date: "2026-10-03",
      },
    ],
    positions: [],
    cash: -0.1,
    completeFromInception: true,
    asOf: "2026-10-04T00:00:00",
  });
  expect(result.issues).toContain("unsupported_activity:fee-cutoff");
});

it("validates the local calendar date without rejecting a valid offset crossing a UTC day", () => {
  const input = {
    activities: [
      {
        id: "offset-fee",
        activity_type: "FEE",
        status: "executed",
        net_amount: "-0.1",
        transaction_time: "2026-03-01T00:15:00.123456+08:00",
      },
    ],
    positions: [],
    cash: -0.1,
    completeFromInception: true,
    asOf: "2026-03-01T00:30:00+08:00",
  };
  expect(reconcileFinanceBrokerActivities(input).status).toBe("reconciled");
  expect(
    reconcileFinanceBrokerActivities({ ...input, asOf: "2026-02-30T00:30:00Z" }).issues,
  ).toContain("unsupported_activity:offset-fee");
});
