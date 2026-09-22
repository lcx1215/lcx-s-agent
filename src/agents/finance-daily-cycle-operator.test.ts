import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ account: vi.fn(), cycle: vi.fn(), backfill: vi.fn() }));
vi.mock("./finance-alpaca-history-sync.js", () => ({
  syncConfiguredAlpacaPaperHistory: vi.fn(() => {
    throw new Error("unexpected history provider");
  }),
}));
vi.mock("./finance-alpaca-run.js", () => ({ fetchAlpacaAccountSnapshot: mocks.account }));
vi.mock("./finance-daily-cycle.js", () => ({ runFinanceDailyCycle: mocks.cycle }));
vi.mock("./finance-link-health.js", () => ({ readFinanceLinkHealth: vi.fn() }));
vi.mock("./finance-outcome-backfill.js", () => ({ backfillOutcomes: mocks.backfill }));
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
  const accountReconciliation = {
    status: "reconciled" as const,
    quantities: [],
    fees: [],
    cashFromActivities: 0,
    brokerCash: 0,
    cashDifference: 0,
    differences: [],
    issues: [],
    feesInterpreted: true,
    protection: { protective: [], unresolved: [] },
    observedAt: "2025-02-01T00:00:00Z",
    positions: [],
    openOrders: [],
    historyHeadRef: null,
  };
  const history = {
    accountReconciliation,
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
  it("settles at night despite unresolved economics when placement flags were inherited", async () => {
    mocks.backfill.mockResolvedValueOnce({ scored: [], issues: [] });
    const syncHistory = vi.fn(async () => ({
      ...history,
      streams: [],
      accountReconciliation: {
        ...accountReconciliation,
        status: "unresolved" as const,
      },
    }));
    const result = await runFinanceDailyCycleOperator(
      [
        "--json",
        "--dir",
        "/synthetic/finance",
        "--mode",
        "night",
        "--venue",
        "alpaca",
        "--place",
        "--sync-alpaca-history",
      ],
      { syncHistory },
    );
    expect(result.ok).toBe(true);
    expect(mocks.backfill).toHaveBeenCalledOnce();
    expect(mocks.cycle).not.toHaveBeenCalled();
    expect(mocks.account).not.toHaveBeenCalled();
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

it("installs the account controller from the explicit execution policy at the daily seam", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daily-policy-"));
  try {
    const filename = path.join(directory, "policy.json");
    await fs.writeFile(filename, JSON.stringify({ synthetic: true }));
    const accountBookProvider = vi.fn();
    const executionQuoteProvider = vi.fn();
    const createSafetyContext = vi.fn();
    const createController = vi.fn(() => ({
      accountId: "bound-account",
      inspectReconciliation: vi.fn(),
      accountBookProvider,
      executionQuoteProvider,
      createSafetyContext,
    }));
    const result = await runFinanceDailyCycleOperator([...args, "--execution-policy", filename], {
      createController,
    });
    expect(result.ok).toBe(true);
    expect(createController).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: "/synthetic/finance",
        instruments: ["AAPL"],
        policy: { synthetic: true },
      }),
    );
    expect(mocks.cycle).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "bound-account",
        accountBookProvider,
        executionQuoteProvider,
        createSafetyContext,
      }),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("checks reconciliation without collecting quotes or entering the trading cycle", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daily-inspection-"));
  try {
    const filename = path.join(directory, "policy.json");
    await fs.writeFile(filename, "{}");
    const inspectReconciliation = vi.fn(async () => ({
      observedAt: new Date().toISOString(),
      readiness: {
        status: "restricted" as const,
        historyStatus: "unresolved" as const,
        quarantinedInstruments: ["BTC/USD"],
        uncertaintyReserve: 0.1,
        reasons: [],
      },
    }));
    const executionQuoteProvider = vi.fn();
    const createController = vi.fn(() => ({
      accountId: "synthetic",
      inspectReconciliation,
      executionQuoteProvider,
      accountBookProvider: vi.fn(),
      createSafetyContext: vi.fn(),
    }));
    const result = await runFinanceDailyCycleOperator(
      [
        ...args.filter((arg) => arg !== "--place"),
        "--check-execution",
        "--execution-policy",
        filename,
      ],
      { createController },
    );
    expect(result).toMatchObject({
      ok: true,
      boundary: "broker_reconciliation_readiness_only",
      quotesVerified: false,
      executionVerified: false,
      ordersSubmitted: 0,
    });
    expect(inspectReconciliation).toHaveBeenCalledOnce();
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(mocks.cycle).not.toHaveBeenCalled();
    await expect(
      runFinanceDailyCycleOperator([...args, "--check-execution", "--execution-policy", filename], {
        createController,
      }),
    ).rejects.toThrow("without --place");
    expect(inspectReconciliation).toHaveBeenCalledOnce();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
