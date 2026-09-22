import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaperExecutionAdapter, placeFinanceOrder } from "../finance-execution-adapter.js";
import { syntheticSafetyContext } from "../finance-execution-safety.test-support.js";
import type { FinancePaperRunRequest } from "../finance-paper-run.js";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../finance-paper-run.js", () => ({ runFinancePaperOrder: mocks.run }));
vi.mock("../finance-state-dir.js", () => ({
  resolveFinanceStateDir: (options: { workspaceDir: string }) => ({
    directory: options.workspaceDir,
  }),
  financeResearchSamplesPath: (directory: string) => `${directory}/research-samples.jsonl`,
  financeResearchScoredPath: (directory: string) => `${directory}/scored.jsonl`,
  financePaperPromotionsPath: (directory: string) => `${directory}/paper-promotions.jsonl`,
}));
import { FINANCE_PAPER_PROMOTION_SCHEMA_VERSION } from "../finance-paper-promotion.js";
import { createFinancePaperRankPlaceTool } from "./finance-paper-rank-place-tool.js";
let root: string;
const day = "2026-09-22";
const observation = "2026-09-22T12:00:00.000Z";
const sample = {
  asOf: `${day}T00:00:00Z`,
  instrument: "AAPL",
  direction: "buy",
  conviction: 0.8,
  lastPrice: 100,
  sources: ["fixture"],
  lastPriceAt: observation,
  lastPriceSource: "fixture://quote",
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "paper-rank-"));
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(`${day}T12:00:00Z`));
  mocks.run.mockReset();
  mocks.run.mockImplementation(async (request: FinancePaperRunRequest) => {
    const adapter = createPaperExecutionAdapter({
      id: "fixture",
      instruments: request.instruments,
    });
    const intent = {
      intentId: `fixture:${request.conclusion.instrument}`,
      instrument: request.conclusion.instrument!,
      side: "buy",
      orderType: "market",
      quantity: 1,
      referencePrice: request.market.referencePrice,
      referencePriceAt: request.market.referencePriceAt,
      runAuthorizationId: request.runAuthorizationId,
      rationale: "fixture",
    } as const;
    const result = await placeFinanceOrder({
      mode: "live_execution",
      intent,
      safetyContext: request.createSafetyContext?.({
        intent,
        budget: request.budget,
        adapterId: adapter.id,
        venue: adapter.venue,
      }),
      budget: request.budget,
      adapters: [adapter],
      executionAdapterId: adapter.id,
      ordersPlacedThisRun: request.ordersPlacedThisRun ?? 0,
      committedInstrumentNotional: request.committedInstrumentNotional ?? 0,
    });
    return result.status === "placed"
      ? { ok: true, receipt: result.receipt, notes: [] }
      : { ok: false, stage: "place", refusals: result.refusalReasons };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
async function run(rows: unknown[], place = true, maxOrdersPerRun = 3) {
  fs.writeFileSync(
    path.join(root, "research-samples.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n"),
  );
  const result = await createFinancePaperRankPlaceTool({
    equity: 100_000,
    runAuthorizationId: "synthetic",
    createSafetyContext: syntheticSafetyContext,
    budget: {
      automation: "unattended",
      allowedInstruments: ["*"],
      maxOrderNotional: 60_000,
      maxInstrumentNotional: 60_000,
      maxOrdersPerRun,
    },
  }).execute("fixture", {
    workspaceDir: root,
    day,
    mode: "explore",
    place,
    runAuthorizationId: "synthetic",
    top: 3,
    maxOrdersPerRun,
  });
  return result.details as {
    placedCount: number;
    results: { status: string; reasons?: string[] }[];
  };
}
describe("ranked internal-paper price evidence", () => {
  it.each([
    { lastPriceAt: undefined },
    { lastPriceAt: "2026-09-21" },
    { lastPriceAt: "invalid" },
    { lastPriceAt: "2026-09-21T18:42:03" },
    { lastPriceAt: "2027-01-01T00:00:00Z" },
    { lastPriceSource: undefined },
  ])("refuses missing/date-only/invalid provenance without refreshing time %j", async (change) => {
    const result = await run([{ ...sample, ...change }]);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(result.results[0].status).toBe("refused");
  });
  it("still ranks legacy samples in report-only mode", async () => {
    const result = await run([{ ...sample, lastPriceAt: undefined }], false);
    expect(result.results[0].status).toBe("not placed");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("passes exact price time unchanged and applies the existing per-run order cap", async () => {
    const result = await run([sample, { ...sample, instrument: "MSFT" }], true, 1);
    expect(mocks.run.mock.calls[0][0].market.referencePriceAt).toBe(observation);
    expect(mocks.run.mock.calls.map(([request]) => request.ordersPlacedThisRun)).toEqual([0, 1]);
    expect(result.placedCount).toBe(1);
    expect(result.results[1].status).toBe("refused");
  });
});

it("model JSON cannot authorize placement or select attended execution", async () => {
  fs.writeFileSync(path.join(root, "research-samples.jsonl"), JSON.stringify(sample));
  const result = await createFinancePaperRankPlaceTool().execute("fixture", {
    workspaceDir: root,
    day,
    mode: "explore",
    place: true,
    automation: "attended",
    runAuthorizationId: "invented",
    maxOrdersPerRun: 1000,
  });
  expect(mocks.run).not.toHaveBeenCalled();
  expect(JSON.stringify(result.details)).toContain(
    "trusted controller authorization is unavailable",
  );
});

it("keeps controller ceilings and unattended mode when model parameters try to expand authority", async () => {
  fs.writeFileSync(path.join(root, "research-samples.jsonl"), JSON.stringify(sample));
  await createFinancePaperRankPlaceTool({
    equity: 100_000,
    runAuthorizationId: "controller-plan",
    createSafetyContext: syntheticSafetyContext,
    budget: {
      automation: "unattended",
      allowedInstruments: ["AAPL"],
      maxOrderNotional: 500,
      maxInstrumentNotional: 1000,
      maxOrdersPerRun: 1,
    },
  }).execute("fixture", {
    workspaceDir: root,
    day,
    mode: "explore",
    place: true,
    automation: "attended",
    equity: 1e12,
    runAuthorizationId: "invented",
    maxOrderNotional: 1e12,
    maxInstrumentNotional: 1e12,
    maxOrdersPerRun: 1000,
  });
  expect(mocks.run.mock.calls[0][0]).toMatchObject({
    equity: 100_000,
    runAuthorizationId: "controller-plan",
    budget: {
      automation: "unattended",
      maxOrderNotional: 500,
      maxInstrumentNotional: 1000,
      maxOrdersPerRun: 1,
    },
  });
});

it("uses the promoted floor in calibrated mode", async () => {
  fs.writeFileSync(path.join(root, "research-samples.jsonl"), JSON.stringify(sample));
  fs.writeFileSync(
    path.join(root, "paper-promotions.jsonl"),
    JSON.stringify({
      schemaVersion: FINANCE_PAPER_PROMOTION_SCHEMA_VERSION,
      promotionId: "paper-floor-fixture",
      proposalId: "proposal-fixture",
      knob: "convictionFloor",
      previous: null,
      promoted: 0.75,
      sampleCount: 5,
      scoredEvidenceRef: "fixture",
      promotedAt: "2026-09-22T11:00:00.000Z",
      authority: "paper_only",
      status: "promoted",
      basis: "fixture promoted floor",
    }) + "\n",
  );

  const result = await createFinancePaperRankPlaceTool({
    equity: 100_000,
    runAuthorizationId: "controller-plan",
    createSafetyContext: syntheticSafetyContext,
    budget: {
      automation: "unattended",
      allowedInstruments: ["AAPL"],
      maxOrderNotional: 60_000,
      maxInstrumentNotional: 60_000,
      maxOrdersPerRun: 1,
    },
  }).execute("fixture", { workspaceDir: root, day, mode: "calibrated", place: true });

  expect(result.details).toMatchObject({ floor: 0.75, floorBasis: "fixture promoted floor" });
  expect(mocks.run.mock.calls[0][0].minConviction).toBe(0.75);
});
