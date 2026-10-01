import { describe, expect, it, vi } from "vitest";
const syncMocks = vi.hoisted(() => ({ append: vi.fn(), history: vi.fn(), readHistory: vi.fn() }));
vi.mock("./finance-alpaca-history-sync.js", () => ({
  syncAlpacaPaperHistory: syncMocks.history,
}));
vi.mock("./finance-position-ledger.js", () => ({
  appendFinanceBrokerHistory: syncMocks.append,
  readFinanceBrokerHistoryRecords: syncMocks.readHistory,
}));
import {
  reconcileFinanceBrokerActivities,
  syncFinanceBrokerReconciliation,
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
  async function reconcile(extra: Record<string, unknown> = {}) {
    syncMocks.append.mockReset();
    syncMocks.history.mockResolvedValue({ status: "raw_history_synced" });
    syncMocks.readHistory.mockResolvedValue({ records: [], headRef: "history-head" });
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
    });
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
      source: "https://paper-api.alpaca.markets/v2/account",
    });
    expect(Number.isFinite(Date.parse(snapshot.accountObservation?.observedAt ?? ""))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("never-copy");
    expect(snapshot.brokerCash).toBe(0);
    expect(syncMocks.append.mock.calls.at(-1)?.[1].payload[0].accountObservation).toEqual(
      snapshot.accountObservation,
    );
  });
  it.each([undefined, null, "", " ", "NaN", "Infinity", "0x10", "1,000", false, {}])(
    "keeps missing or invalid optional values unknown: %j",
    async (value) => {
      const { snapshot } = await reconcile({
        equity: value,
        buying_power: value,
        portfolio_value: value,
      });
      expect(snapshot.accountObservation).toMatchObject({
        equity: null,
        buyingPower: null,
        portfolioValue: null,
        unknownValueMeaning: "missing_or_invalid",
      });
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
