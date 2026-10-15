import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinanceAlpacaRunRequest } from "./finance-alpaca-run.js";
import { runFinanceDailyCycle } from "./finance-daily-cycle.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { syntheticSafetyContext } from "./finance-execution-safety.test-support.js";
import type { FinancePortfolioPlan } from "./finance-portfolio-composition.js";
import { readFinancePositionLedger } from "./finance-position-ledger.js";
import { buildFinanceResearchPortfolioPlan } from "./finance-research-portfolio-plan.js";
const mocks = vi.hoisted(() => ({ collect: vi.fn(), placeAlpaca: vi.fn() }));
vi.mock("./finance-free-market-collection-adapters.js", () => ({
  createChinaReachableUsEodHistoryCollectionAdapter: () => ({ collect: mocks.collect }),
}));
vi.mock("./finance-alpaca-run.js", () => ({
  fetchAlpacaVenueState: vi.fn().mockResolvedValue({
    ok: true,
    state: { openOrders: new Map(), positions: new Map(), recentOrders: new Map() },
  }),
  runFinanceAlpacaOrder: mocks.placeAlpaca,
}));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function bars() {
  const start = Date.parse("2025-01-11T00:00:00Z");
  return Array.from({ length: 620 }, (_, i) => {
    const close = i < 420 ? 100 + i / 4 : 205 - (i - 420) * 0.15;
    const date = new Date(start + i * 86400_000).toISOString().slice(0, 10);
    return {
      data: { date, close, open: close, high: close + 1, low: close - 1, volume: 100 },
      sourceTimestamp: `${date}T20:00:00Z`,
      providerName: "fixture",
      sourceUrlOrArtifact: "fixture://bars",
    };
  });
}
async function runCycle(
  directory: string,
  policy: FinancePortfolioPlan["conflictPolicy"],
  options: {
    place?: boolean;
    withProvenance?: boolean;
    planAccountId?: string;
    withholdFast?: boolean;
  } = {},
) {
  mocks.collect.mockResolvedValue(bars());
  const asOf = "2026-09-22T20:00:30.000Z";
  const allocations = [
    { strategyId: "slow", budgetFraction: 0.4 },
    { strategyId: "fast", budgetFraction: options.withholdFast ? 0 : 0.4 },
  ];
  const portfolioPlan: FinancePortfolioPlan = options.withProvenance
    ? buildFinanceResearchPortfolioPlan({
        asOf,
        context: {
          accountId: options.planAccountId ?? "fixture",
          venue: options.place ? "alpaca" : "paper",
          validityMinutes: 240,
          conflictPolicy: policy,
          activeStrategyIds: ["slow", "fast"],
          requiredInstruments: ["ACME"],
        },
        proposal: {
          allocations: allocations.map((allocation) => ({
            ...allocation,
            evidenceIds: [`source:${allocation.strategyId}`],
          })),
        },
        supportedEvidenceIds: new Set(["source:slow", "source:fast"]),
        researchReceiptId: "quality:research-run-1",
      })
    : {
        asOf,
        validUntil: "2026-09-23T00:00:00Z",
        accountId: options.planAccountId ?? "fixture",
        venue: options.place ? "alpaca" : "paper",
        conflictPolicy: policy,
        allocations,
        candidates: [],
      };
  return runFinanceDailyCycle({
    directory,
    instruments: ["ACME"],
    asOf,
    equity: 100_000,
    caps: { maxOrderNotional: 10_000, maxInstrumentNotional: 20_000, maxOrdersPerRun: 2 },
    runAuthorizationId: "fixture",
    portfolioPlan,
    trendStrategies: [
      { ruleId: "slow", lookbackMonths: 12, instruments: ["ACME"] },
      { ruleId: "fast", lookbackMonths: 6, instruments: ["ACME"] },
    ],
    place: options.place ?? false,
    ...(options.place
      ? {
          venue: "alpaca" as const,
          accountId: "fixture",
          accountBookProvider: async () => ({
            accountId: "fixture",
            venue: "alpaca:paper" as const,
            observedAt: asOf,
            expiresAt: "2026-09-22T20:01:30.000Z",
            equity: 100_000,
            positions: [],
          }),
          executionQuotes: new Map([
            [
              "ACME",
              {
                referencePrice: 200,
                referencePriceAt: "2026-09-22T20:00:00.000Z",
                sourceUrlOrArtifact: "fixture://alpaca-quote",
                maxAgeMs: 60_000,
              },
            ],
          ]),
          executionNow: () => Date.parse(asOf),
          createSafetyContext: syntheticSafetyContext,
        }
      : {}),
  });
}

function fixtureVenueReceipt(request: FinanceAlpacaRunRequest): FinanceExecutionReceipt {
  const recordedAt = "2026-09-22T20:00:30.000Z";
  const quantity = 1;
  const instrument = request.conclusion.instrument;
  const direction = request.conclusion.direction;
  if (!instrument || (direction !== "buy" && direction !== "sell")) {
    throw new Error("fixture venue receipt needs an executable instrument and side");
  }
  return {
    schemaVersion: "lcx_finance_execution_receipt_v1",
    receiptId: "fixture:daily-cycle-fill",
    accountId: "fixture",
    intentId: "fixture:daily-cycle-intent",
    ...(request.conclusion.decisionRef === undefined
      ? {}
      : { decisionRef: request.conclusion.decisionRef }),
    ...(request.researchLineage === undefined ? {} : { researchLineage: request.researchLineage }),
    ...(request.targetWeightAuthorization === undefined
      ? {}
      : { targetWeightAuthorization: request.targetWeightAuthorization }),
    runAuthorizationId: request.runAuthorizationId,
    adapterId: "fixture-alpaca-paper",
    adapterKind: "venue",
    venue: "alpaca:paper",
    instrument,
    side: direction,
    orderType: "market",
    quantity,
    referencePrice: request.market.referencePrice,
    referencePriceAt: request.market.referencePriceAt,
    notional: quantity * request.market.referencePrice,
    fill: {
      filledQuantity: quantity,
      fillPrice: request.market.referencePrice,
      filledAt: recordedAt,
      venueRef: "fixture:venue",
      terminalOrderIdentity: { orderId: "fixture:terminal-order", terminal: true },
    },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt,
  };
}

async function run(policy: FinancePortfolioPlan["conflictPolicy"]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-cycle-"));
  dirs.push(directory);
  return runCycle(directory, policy);
}
describe("portfolio targets reach the existing cycle drift consumer", () => {
  it("runs only the funded strategy and keeps its approved budget unchanged", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-withheld-"));
    dirs.push(directory);
    const result = await runCycle(directory, "block", { withProvenance: true, withholdFast: true });
    expect(result.portfolio?.withheldStrategies).toEqual([
      { strategyId: "fast", budgetFraction: 0, evidenceIds: ["source:fast"] },
    ]);
    expect(
      result.portfolio?.targets.every((target) =>
        target.contributions.every(
          (contribution) =>
            contribution.strategyId === "slow" && contribution.budgetFraction === 0.4,
        ),
      ),
    ).toBe(true);
    expect(result.portfolio?.targets.every((target) => !target.conflict)).toBe(true);
    expect(result.portfolio?.unallocatedCashWeight).toBeGreaterThanOrEqual(0.6);
    expect(result.drift[0]).toMatchObject({ instrument: "ACME", action: "buy", target: 0.4 });
  });
  it("holds a conflicting symbol without turning a blocked candidate into a sell", async () => {
    const result = await run("block");
    expect(result.portfolio?.targets[0]).toMatchObject({
      instrument: "ACME",
      conflict: true,
      blocked: true,
    });
    expect(result.portfolio?.targets[0]?.weight).toBeCloseTo(0.4);
    expect(result.drift[0]).toMatchObject({ action: "none", notional: 0 });
    expect(result.placed).toEqual([]);
  });
  it("uses declared budget weighting only when explicitly chosen and retains cash", async () => {
    const result = await run("budget_weighted");
    expect(result.targets[0].weight).toBeCloseTo(0.4);
    expect(result.portfolio?.unallocatedCashWeight).toBeCloseTo(0.6);
    expect(result.drift[0]).toMatchObject({ action: "buy", notional: 10_000 });
    expect(result.portfolio?.targets[0].contributions.map((c) => c.strategyId)).toEqual([
      "slow",
      "fast",
    ]);
    expect(mocks.collect).toHaveBeenCalledOnce();
  });

  it("refuses Alpaca placement when the portfolio plan belongs to another account", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-cycle-account-mismatch-"));
    dirs.push(directory);

    await expect(
      runCycle(directory, "budget_weighted", { place: true, planAccountId: "other-account" }),
    ).rejects.toThrow("portfolio plan account does not match Alpaca execution account");
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.placeAlpaca).not.toHaveBeenCalled();
  });

  it("carries research lineage into the durable venue fill", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-cycle-lineage-"));
    dirs.push(directory);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T20:00:30.000Z"));
    mocks.placeAlpaca.mockImplementation(async (request: FinanceAlpacaRunRequest) => ({
      ok: true,
      receipt: fixtureVenueReceipt(request),
      notes: [],
    }));

    const result = await runCycle(directory, "budget_weighted", {
      place: true,
      withProvenance: true,
    });

    expect(
      result.placed,
      JSON.stringify({
        refusals: result.refusals,
        dataIssues: result.dataIssues,
        drift: result.drift,
      }),
    ).toHaveLength(1);
    expect(mocks.placeAlpaca).toHaveBeenCalledOnce();
    const placementRequest = mocks.placeAlpaca.mock.calls[0]?.[0] as FinanceAlpacaRunRequest;
    expect(placementRequest.targetWeightAuthorization).toMatchObject({
      targetWeight: 0.4,
      driftBandFraction: 0.05,
    });
    expect(placementRequest.targetWeightAuthorization?.maxOrderNotional).toBeGreaterThan(0);
    const stored = await readFinancePositionLedger(directory);
    expect(stored.receipts).toHaveLength(1);
    expect(stored.receipts[0]?.adapterKind).toBe("venue");
    expect(stored.receipts[0]?.targetWeightAuthorization).toMatchObject({
      targetWeight: 0.4,
      driftBandFraction: 0.05,
    });
    expect(stored.receipts[0]?.researchLineage).toMatchObject({
      portfolioPlan: {
        asOf: "2026-09-22T20:00:30.000Z",
        validUntil: "2026-09-23T00:00:30.000Z",
        accountId: "fixture",
        venue: "alpaca",
        provenance: {
          kind: "finance_research_allocation",
          receiptId: "quality:research-run-1",
          evidenceIds: ["source:slow", "source:fast"],
        },
      },
      targetWeight: 0.4,
      contributions: expect.arrayContaining([
        expect.objectContaining({
          strategyId: "slow",
          evidenceReceiptId: expect.stringContaining("trend:slow:"),
          accountWeight: 0.4,
          evidenceIds: ["source:slow"],
        }),
      ]),
    });
  });

  it("preserves structured Alpaca safety failures alongside compatible refusals", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-cycle-safety-failure-"));
    dirs.push(directory);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T20:00:30.000Z"));
    mocks.placeAlpaca.mockResolvedValue({
      ok: false,
      stage: "place",
      refusals: ["execution_safety_state_unavailable"],
      safetyFailure: {
        stage: "facts",
        category: "account_snapshot_unavailable",
        operation: "read_account_safety_facts",
      },
    });

    const result = await runCycle(directory, "budget_weighted", { place: true });

    expect(result.refusals).toContain("ACME: execution_safety_state_unavailable");
    expect(result.executionFailures).toEqual([
      {
        instrument: "ACME",
        orderStage: "place",
        refusalReasons: ["execution_safety_state_unavailable"],
        safetyFailure: {
          stage: "facts",
          category: "account_snapshot_unavailable",
          operation: "read_account_safety_facts",
        },
      },
    ]);
    expect(result.placed).toEqual([]);
  });

  it("records the stage and reasons for refusals without a structured safety failure", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-cycle-refusal-stage-"));
    dirs.push(directory);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T20:00:30.000Z"));
    mocks.placeAlpaca.mockResolvedValue({
      ok: false,
      stage: "compile",
      refusals: ["execution_quote_unavailable"],
    });

    const result = await runCycle(directory, "budget_weighted", { place: true });

    expect(result.executionFailures).toEqual([
      {
        instrument: "ACME",
        orderStage: "compile",
        refusalReasons: ["execution_quote_unavailable"],
      },
    ]);
    expect(result.placed).toEqual([]);
  });
});
