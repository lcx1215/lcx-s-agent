import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as credentials from "../../src/agents/finance-credential-env.js";
import * as collections from "../../src/agents/finance-market-collection-registry.js";
import * as ledger from "../../src/agents/finance-position-ledger.js";
import * as transport from "../../src/agents/finance-write-transport.js";
vi.mock("../../src/agents/finance-credential-env.js", () => ({
  resolveFinanceCredentialEnv: () => ({
    ALPACA_API_KEY_ID: "PK_SYNTHETIC",
    ALPACA_API_SECRET_KEY: "SYNTHETIC_ONLY",
  }),
}));
import { runFinanceResearchTurn as runResearchTurn } from "../../scripts/operator/lcx-finance-research-turn.js";
import { createFinanceExecutionSafetyContext } from "../../src/agents/finance-execution-safety.js";
import {
  buildFinanceResearchMathEvidence,
  type FinanceResearchExecutionControl,
} from "../../src/agents/finance-research-execution-bridge.js";

// Existing price/transport fixtures explicitly exercise the market-structure path.
const runFinanceResearchTurn: typeof runResearchTurn = (args, deps) =>
  runResearchTurn([...args, "--research-basis", "market_structure"], deps);

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
function fixture(assetClass: "us_equity" | "crypto" = "us_equity") {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "research-bridge-"));
  directories.push(stateDirectory);
  const instrument = assetClass === "crypto" ? "BTC/USD" : "SPY";
  const at = new Date().toISOString();
  const model = {
    conclusionId: "synthetic-entry",
    instrument,
    assetClass,
    direction: "buy",
    conviction: 0.8,
    thesis: "Synthetic evidence",
    horizonDays: 30,
    invalidationPrice: 95,
    evidence: [
      { sourceId: "raw" },
      { sourceId: "computed", calculationId: "calc-1" },
      { sourceId: "independent" },
    ],
  };
  const observations = [100, 101, 102];
  const mean = observations.reduce((sum, value) => sum + value, 0) / observations.length;
  const evidence = [
    {
      sourceId: "raw",
      description: "synthetic observations",
      detail: JSON.stringify(observations),
      sourceUrlOrArtifact: "fixture://observations",
      sourceTimestamp: at,
    },
    {
      sourceId: "computed",
      description: "actual injected calculation result",
      detail: `mean=${mean}`,
      sourceUrlOrArtifact: "fixture://calculation/calc-1",
      sourceTimestamp: at,
      computation: { calculationId: "calc-1", module: "fixture.mean", inputSourceIds: ["raw"] },
    },
  ];
  evidence.push({
    sourceId: "independent",
    description: "independent synthetic filing",
    detail: "revenue=200",
    sourceUrlOrArtifact: "fixture://independent-filing",
    sourceTimestamp: at,
  });
  let terminal = "";
  const transport = vi.fn(async (request: { body: string }) => {
    const order = JSON.parse(request.body) as { qty: string };
    terminal = JSON.stringify({
      id: "synthetic-terminal",
      status: "filled",
      filled_qty: order.qty,
      filled_avg_price: "100",
      filled_at: at,
    });
    return { status: 200, body: terminal };
  });
  const read = vi.fn(async (url: string) => ({
    status: 200,
    body:
      new URL(url).pathname === "/v2/account" ? JSON.stringify({ id: stateDirectory }) : terminal,
  }));
  const control: FinanceResearchExecutionControl = {
    mode: "alpaca_paper",
    stateDirectory,
    recovery: { safetyStateDir: stateDirectory, accountId: stateDirectory, venue: "alpaca:paper" },
    riskContext: {
      drawdownFraction: 0,
      averagingDown: false,
      revengeSizing: false,
      hasSignificantAutocorrelation: true,
    },
    execution: {
      market: { referencePrice: 100, referencePriceAt: at },
      equity: 100_000,
      runAuthorizationId: "synthetic-controller-plan",
      instruments: [instrument],
      budget: {
        automation: "unattended",
        allowedInstruments: [instrument],
        maxOrderNotional: 50_000,
        maxInstrumentNotional: 50_000,
        maxOrdersPerRun: 1,
      },
      createSafetyContext: (binding) =>
        createFinanceExecutionSafetyContext({
          ...binding,
          stateDir: stateDirectory,
          accountId: stateDirectory,
          policy: {
            planId: "fixture-plan",
            revision: "1",
            riskModel: "fully_funded_unhedged_spot",
            authorizedSide: binding.intent.side,
            authorizedQuantity: binding.intent.quantity,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            maxPortfolioDrawdownFraction: 0.1,
            maxGrossExposure: 1_000_000,
            maxAccountAgeMs: 60_000,
            maxQuoteAgeMs: 60_000,
            maxInstrumentEvidenceAgeMs: 60_000,
          },
          readFacts: async () => ({
            accountId: stateDirectory,
            adapterId: binding.adapterId,
            venue: binding.venue,
            instrument,
            snapshotId: "fixture-snapshot",
            source: "fixture://account",
            observedAt: at,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            positionQuantity: 0,
            openOrderIds: [],
            unresolvedOrderIds: [],
            instrumentEvidence: {
              source: "fixture://asset",
              observedAt: at,
              assetType: assetClass === "crypto" ? "spot_crypto" : "spot_equity",
              fullyPaid: true,
              marginEnabled: false,
              hedged: false,
            },
            account: {
              status: "ACTIVE",
              tradingBlocked: false,
              equity: 100_000,
              peakEquity: 100_000,
              availableCash: 100_000,
              currency: "USD",
              grossExposure: 0,
            },
            quote: {
              source: "fixture://quote",
              price: 100,
              observedAt: at,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              currency: "USD",
            },
          }),
        }),
      transport,
      read,
    },
  };
  const gatherEvidence = vi.fn(async () => ({
    evidence,
    market: { referencePrice: 100, referencePriceAt: at },
  }));
  const invokeModel = vi.fn(async (prompt: string) => {
    expect(prompt).toContain("executionAuthority=none");
    expect(prompt).toContain("mean=101");
    return JSON.stringify(model);
  });
  return {
    instrument,
    model,
    evidence,
    transport,
    read,
    control,
    deps: {
      gatherEvidence,
      invokeModel,
      reflection: "",
      positionSummary: "synthetic known account",
      control,
    },
  };
}

describe("research operator calls the existing execution bridge", () => {
  it("runs supplied evidence and model output through the stock paper controller", async () => {
    const f = fixture();
    const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
    expect(result).toMatchObject({
      status: "placed",
      receipt: {
        evidence: [
          { sourceId: "raw" },
          { sourceId: "computed", computation: { calculationId: "calc-1" } },
          { sourceId: "independent" },
        ],
      },
    });
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("defaults to shadow and never treats model authority fields as a controller", async () => {
    const f = fixture();
    Object.assign(f.model, {
      mode: "alpaca_paper",
      runAuthorizationId: "invented",
      riskContext: f.control.riskContext,
    });
    const result = await runFinanceResearchTurn(
      ["--instrument", f.instrument, "--run-authorization", "invented"],
      {
        ...f.deps,
        control: { stateDirectory: f.control.stateDirectory, riskContext: f.control.riskContext },
      },
    );
    expect(result).toMatchObject({ status: "shadow" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("refuses execution with absent real risk context instead of assuming zero", async () => {
    const f = fixture();
    const result = await runFinanceResearchTurn(["--instrument", f.instrument], {
      ...f.deps,
      control: { ...f.control, riskContext: undefined },
    });
    expect(result).toMatchObject({ status: "refused", decision: { stage: "risk_context" } });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("rejects a claimed calculation ID not present in collected evidence", async () => {
    const f = fixture();
    f.model.evidence[1].calculationId = "invented";
    const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
    expect(result).toMatchObject({ status: "refused" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("routes crypto evidence to the same seam but refuses unsupported protective orders", async () => {
    const f = fixture("crypto");
    const result = await runFinanceResearchTurn(
      ["--instrument", f.instrument, "--asset-class", "crypto"],
      f.deps,
    );
    expect(result).toMatchObject({ status: "unknown" });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it("blocks crypto before stock gathering when no crypto provider is installed", async () => {
    expect(
      await runFinanceResearchTurn(["--asset-class", "crypto", "--instrument", "BTC/USD"]),
    ).toMatchObject({ status: "blocked" });
  });
});

it("does not count bars and their calculation as independent corroboration", async () => {
  const f = fixture();
  f.model.evidence = f.model.evidence.filter((ref) => ref.sourceId !== "independent");
  const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
  expect(result).toMatchObject({
    status: "refused",
    refusals: [expect.stringContaining("independent evidence roots")],
  });
  expect(f.transport).not.toHaveBeenCalled();
});
it("accepts an evidence-backed hold as research consumption without any trade", async () => {
  const f = fixture();
  f.model.direction = "hold";
  const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
  expect(result).toMatchObject({ status: "shadow", disposition: "no_trade" });
  expect(f.transport).not.toHaveBeenCalled();
});

it("reads the same durable receipt history before the next model decision", async () => {
  const f = fixture();
  expect(await runFinanceResearchTurn(["--instrument", f.instrument], f.deps)).toMatchObject({
    status: "placed",
  });
  const book = await ledger.readFinancePositionLedger(f.control.stateDirectory!);
  expect(book.receiptRecordCount).toBe(1);
  const invokeModel = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('"receiptCount":1');
    expect(prompt).toContain("recorded history only");
    return JSON.stringify(f.model);
  });
  await runFinanceResearchTurn(["--instrument", f.instrument], {
    ...f.deps,
    invokeModel,
    control: { ...f.control, mode: "shadow" },
  });
  expect(invokeModel).toHaveBeenCalledOnce();
  expect(f.transport).toHaveBeenCalledOnce();
});
it("blocks execution on unreadable stored history before model or transport", async () => {
  const f = fixture();
  vi.spyOn(ledger, "readFinanceAccountPositionLedger").mockRejectedValueOnce(
    new Error("synthetic corrupt database"),
  );
  expect(await runFinanceResearchTurn(["--instrument", f.instrument], f.deps)).toMatchObject({
    status: "blocked",
  });
  expect(f.deps.invokeModel).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();
});
it("keeps an executed receipt recoverable when ledger persistence fails, without re-dispatch", async () => {
  const f = fixture();
  vi.spyOn(ledger, "appendFinanceExecutionReceipt").mockRejectedValueOnce(
    new Error("synthetic disk failure"),
  );
  const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
  expect(result).toMatchObject({
    status: "executed_persistence_pending",
    placement: { ok: true, receipt: { receiptId: expect.any(String) } },
    recovery: { action: "append existing receipt only; do not redispatch" },
  });
  expect(f.transport).toHaveBeenCalledOnce();
});

it("actually computes quantitative evidence before the ordinary research prompt", async () => {
  const f = fixture();
  const rows = Array.from({ length: 25 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    close: 100 + index + Math.sin(index),
  }));
  const invokeModel = vi.fn(async (prompt: string) => {
    expect(prompt).toContain("quant_math.calculateReturnsFromLevels");
    expect(prompt).toContain("latestReturn");
    expect(prompt).toContain("annualizedVolatility");
    expect(prompt).toContain("maxDrawdown");
    return JSON.stringify({ ...f.model, direction: "hold", evidence: [{ sourceId: "math-bars" }] });
  });
  const result = await runFinanceResearchTurn(["--instrument", f.instrument], {
    ...f.deps,
    invokeModel,
    control: { ...f.control, mode: "shadow" },
    gatherEvidence: async () => ({
      evidence: [],
      dailyBars: {
        sourceId: "math-bars",
        sourceUrlOrArtifact: "fixture://dated-bars",
        rows,
        periodsPerYear: 252,
      },
      market: { referencePrice: rows.at(-1)!.close, referencePriceAt: "" },
    }),
  });
  expect(result).toMatchObject({ status: "shadow", disposition: "no_trade" });
  expect(JSON.stringify(result)).toContain('"sourceTimestamp":"2026-01-25"');
  expect(JSON.stringify(result)).toContain('"inputSourceIds":["math-bars"]');
  expect(f.transport).not.toHaveBeenCalled();
});

it("does not invent math from insufficient or invalid bars", () => {
  const base = { sourceId: "bars", sourceUrlOrArtifact: "fixture://bars", periodsPerYear: 252 };
  expect(
    buildFinanceResearchMathEvidence({ ...base, rows: [{ date: "2026-01-01", close: 100 }] }),
  ).toEqual([]);
  expect(
    buildFinanceResearchMathEvidence({
      ...base,
      rows: Array.from({ length: 21 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
        close: i === 3 ? Number.NaN : 100,
      })),
    }),
  ).toEqual([]);
});

it("recovers a confirmed receipt on the next research turn without replaying the order", async () => {
  const f = fixture();
  vi.spyOn(ledger, "appendFinanceExecutionReceipt").mockRejectedValueOnce(
    new Error("synthetic disk failure"),
  );
  expect(await runFinanceResearchTurn(["--instrument", f.instrument], f.deps)).toMatchObject({
    status: "executed_persistence_pending",
  });
  const invokeModel = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('"receiptCount":1');
    return JSON.stringify({ ...f.model, direction: "hold" });
  });
  expect(
    await runFinanceResearchTurn(["--instrument", f.instrument], { ...f.deps, invokeModel }),
  ).toMatchObject({ status: "shadow", disposition: "no_trade" });
  const history = await ledger.readFinanceAccountPositionLedger(f.control.stateDirectory!, {
    accountId: f.control.recovery!.accountId,
    venue: "alpaca:paper",
  });
  expect(history.receipts).toHaveLength(1);
  expect(f.transport).toHaveBeenCalledOnce();
});
it("blocks a subsequent research execution when the previous claim is unresolved", async () => {
  const f = fixture("crypto");
  const args = ["--asset-class", "crypto", "--instrument", f.instrument];
  expect(await runFinanceResearchTurn(args, f.deps)).toMatchObject({ status: "unknown" });
  f.deps.invokeModel.mockClear();
  expect(await runFinanceResearchTurn(args, f.deps)).toMatchObject({ status: "blocked" });
  expect(f.deps.invokeModel).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();
});

it("lets the actual operator consume one valid source and return hold", async () => {
  const f = fixture();
  const invokeModel = vi.fn(async (prompt: string) => {
    expect(prompt).toContain("A single independent source supports only hold or avoid");
    return JSON.stringify({ ...f.model, direction: "hold", evidence: [{ sourceId: "raw" }] });
  });
  const result = await runFinanceResearchTurn(["--instrument", f.instrument], {
    ...f.deps,
    invokeModel,
    control: { ...f.control, mode: "shadow" },
    gatherEvidence: async () => ({
      evidence: [f.evidence[0]],
      market: { referencePrice: 100, referencePriceAt: "" },
    }),
  });
  expect(invokeModel).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ status: "shadow", disposition: "no_trade" });
  expect(f.transport).not.toHaveBeenCalled();
});

it("uses the controller book credentials and does not disable Finnhub when Alpha Vantage is absent", async () => {
  const f = fixture();
  const resolveCredentials = vi
    .spyOn(credentials, "resolveFinanceCredentialEnv")
    .mockReturnValue({ FINNHUB_API_KEY: "fixture-finnhub" });
  const registry = vi
    .spyOn(collections, "createFinanceMarketCollectionRegistry")
    .mockReturnValue([]);
  vi.spyOn(collections, "runFinanceMarketCollectionRefresh").mockRejectedValue(
    new Error("fixture unavailable"),
  );
  vi.spyOn(transport, "createFinanceUncachedFetch").mockReturnValue(async () => ({
    status: 200,
    body: "{}",
  }));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const beforeRoot = process.env.LCX_FINANCE_STATE_DIR;
  await runFinanceResearchTurn(["--instrument", "SPY"], {
    control: { ...f.control, mode: "shadow" },
    invokeModel: f.deps.invokeModel,
  });
  expect(resolveCredentials).toHaveBeenCalledWith(
    expect.objectContaining({ LCX_FINANCE_STATE_DIR: f.control.stateDirectory }),
  );
  expect(registry).toHaveBeenCalledWith(
    expect.objectContaining({ finnhubApiKey: "fixture-finnhub" }),
  );
  expect(process.env.LCX_FINANCE_STATE_DIR).toBe(beforeRoot);
  expect(f.deps.invokeModel).not.toHaveBeenCalled();
});

it("reads persisted broker history into the next research decision without creating a second fill", async () => {
  const f = fixture();
  await ledger.appendFinanceBrokerHistory(f.control.stateDirectory!, {
    kind: "broker_history",
    accountId: f.control.recovery!.accountId,
    venue: "alpaca:paper",
    query: "activities:fixture-window",
    cursor: "",
    payload: [
      {
        id: "historical-btc-fill",
        activity_type: "FILL",
        symbol: "BTCUSD",
        qty: "0.0002",
        price: "80519.30",
      },
    ],
  });
  const invokeModel = vi.fn(async (prompt: string) => {
    expect(prompt).toContain("historical-btc-fill");
    expect(prompt).toContain("raw_observations_only");
    expect(prompt).toContain('"positionsReconciled":false');
    return JSON.stringify({ ...f.model, direction: "hold" });
  });
  await runFinanceResearchTurn(["--instrument", "SPY"], {
    ...f.deps,
    control: { ...f.control, mode: "shadow" },
    invokeModel,
  });
  expect(invokeModel).toHaveBeenCalledOnce();
  expect(
    (await ledger.readFinancePositionRecords(f.control.stateDirectory!)).receipts,
  ).toHaveLength(0);
  expect(f.transport).not.toHaveBeenCalled();
});

it("refuses the research execution before POST when credentials belong to a different account", async () => {
  const f = fixture();
  f.read.mockResolvedValueOnce({ status: 200, body: JSON.stringify({ id: "another-account" }) });
  const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
  expect(result).toMatchObject({ status: "unknown" });
  expect(f.transport).not.toHaveBeenCalled();
});
