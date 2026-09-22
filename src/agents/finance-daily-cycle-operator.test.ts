import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ account: vi.fn(), cycle: vi.fn(), reconcile: vi.fn() }));
vi.mock("./finance-alpaca-history-sync.js", () => ({
  syncConfiguredAlpacaPaperHistory: vi.fn(() => {
    throw new Error("unexpected history provider");
  }),
}));
vi.mock("./finance-alpaca-run.js", () => ({ fetchAlpacaAccountSnapshot: mocks.account }));
vi.mock("./finance-alpaca-history-reconciliation.js", () => ({
  reconcileFinanceBrokerHistory: mocks.reconcile,
}));
vi.mock("./finance-daily-cycle.js", () => ({ runFinanceDailyCycle: mocks.cycle }));
vi.mock("./finance-link-health.js", () => ({ readFinanceLinkHealth: vi.fn() }));
vi.mock("./finance-outcome-backfill.js", () => ({ backfillOutcomes: vi.fn() }));
vi.mock("./finance-reflection.js", () => ({ buildReflection: vi.fn() }));
vi.mock("./finance-scoped-override.js", () => ({
  resolveScopedOverride: vi.fn(async () => ({ value: 8 })),
}));
vi.mock("./finance-state-dir.js", () => ({
  FINANCE_RESEARCH_SAMPLES_FILENAME: "samples.jsonl",
  FINANCE_RESEARCH_SCORED_FILENAME: "scored.jsonl",
  resolveFinanceStateDir: () => {
    throw new Error("unexpected global root");
  },
}));
vi.mock("./finance-strategy-rule-ledger.js", () => ({
  readFinanceStrategyRuleLedger: vi.fn(async () => ({
    ledger: {
      rules: [
        {
          state: "active",
          instruments: ["AAPL"],
          ruleId: "fixture",
          form: "cross_asset_trend",
          formVersion: "1",
          emits: "target_weights",
          schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
          body: { frozenRule: { lookbackMonths: 12 } },
        },
      ],
    },
  })),
}));
import { runFinanceDailyCycleOperator } from "../../scripts/operator/lcx-finance-daily-cycle.js";
const args = [
  "--json",
  "--dir",
  "/synthetic/finance",
  "--place",
  "--venue",
  "alpaca",
  "--execution-quote-feed",
  "iex",
  "--execution-max-age-ms",
  "1000",
];
const account = { equity: 2000, status: "ACTIVE", tradingBlocked: false };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cycle.mockResolvedValue({ ok: true });
  mocks.reconcile.mockResolvedValue({ historyStatus: "reconciled" });
});
describe("account gate before unattended placement", () => {
  it.each([{ extra: [] }, { extra: ["--equity-from-venue"] }, { extra: ["--equity", "500000"] }])(
    "blocks failed verification with %j",
    async ({ extra }) => {
      mocks.account.mockResolvedValue({ ok: false, reason: "synthetic unavailable" });
      const result = await runFinanceDailyCycleOperator([...args, ...extra]);
      expect(result.ok).toBe(false);
      expect(result.equitySource).toBe("venue-failed");
      expect(mocks.cycle).not.toHaveBeenCalled();
    },
  );
  it.each([{ tradingBlocked: true }, { status: "UNKNOWN" }, { equity: 0 }, { equity: Number.NaN }])(
    "blocks unusable account %j",
    async (change) => {
      mocks.account.mockResolvedValue({ ok: true, account: { ...account, ...change } });
      expect((await runFinanceDailyCycleOperator(args)).ok).toBe(false);
      expect(mocks.cycle).not.toHaveBeenCalled();
    },
  );
  it("uses verified venue equity when requested", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    await runFinanceDailyCycleOperator([...args, "--equity-from-venue"]);
    expect(mocks.cycle).toHaveBeenCalledWith(
      expect.objectContaining({ equity: 2000, place: true }),
    );
  });
  it("sizes an undeclared allocation from the verified small account", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    await runFinanceDailyCycleOperator(args);
    expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({ equity: 2000 }));
  });
  it("rejects a declared allocation larger than account equity", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    const result = await runFinanceDailyCycleOperator([...args, "--equity", "3000"]);
    expect(result.ok).toBe(false);
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
  it("preserves a smaller explicit strategy allocation", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    await runFinanceDailyCycleOperator([...args, "--equity", "500"]);
    expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({ equity: 500 }));
  });
  it("blocks missing quote authorization before account or factory access", async () => {
    const factory = vi.fn();
    const result = await runFinanceDailyCycleOperator(
      ["--json", "--dir", "/synthetic/finance", "--place", "--venue", "alpaca"],
      { createExecutionQuoteProvider: factory },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--execution-quote-feed");
    expect(factory).not.toHaveBeenCalled();
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it("injects the explicitly authorized quote factory", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    const provider = vi.fn();
    const factory = vi.fn(() => provider);
    await runFinanceDailyCycleOperator(args, { createExecutionQuoteProvider: factory });
    expect(factory).toHaveBeenCalledWith({ feed: "iex", maxAgeMs: 1000 });
    expect(mocks.cycle).toHaveBeenCalledWith(
      expect.objectContaining({ executionQuoteProvider: provider }),
    );
  });
  it("keeps research runs independent of account access", async () => {
    await runFinanceDailyCycleOperator(args.filter((arg) => arg !== "--place"));
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({ place: false }));
  });
});

describe("explicit history sync before daily business", () => {
  const history = {
    accountId: "synthetic",
    venue: "alpaca:paper",
    after: "2025-01-01T00:00:00Z",
    until: "2025-02-01T00:00:00Z",
    status: "raw_history_synced",
    streams: [],
    positionsReconciled: false,
    executionReceiptsCreated: 0,
  } as const;
  it.each(["day", "night"])("blocks %s on incomplete sync before business", async (mode) => {
    const syncHistory = vi.fn(async () => ({
      ...history,
      streams: [],
      status: "incomplete" as const,
    }));
    const result = await runFinanceDailyCycleOperator(
      ["--json", "--dir", "/synthetic/finance", "--mode", mode, "--sync-alpaca-history"],
      { syncHistory },
    );
    expect(result.ok).toBe(false);
    expect(result.historySync).toEqual(expect.objectContaining({ status: "incomplete" }));
    expect(mocks.cycle).not.toHaveBeenCalled();
    expect(syncHistory).toHaveBeenCalledWith({ directory: "/synthetic/finance" });
  });
  it("does not sync by default and never enables placement", async () => {
    const syncHistory = vi.fn(async () => ({ ...history, streams: [] }));
    await runFinanceDailyCycleOperator(["--json", "--dir", "/synthetic/finance"], { syncHistory });
    expect(syncHistory).not.toHaveBeenCalled();
    const result = await runFinanceDailyCycleOperator(
      ["--json", "--dir", "/synthetic/finance", "--sync-alpaca-history"],
      { syncHistory },
    );
    expect(result.historySync).toEqual(history);
    expect(mocks.cycle).toHaveBeenLastCalledWith(expect.objectContaining({ place: false }));
  });
});
