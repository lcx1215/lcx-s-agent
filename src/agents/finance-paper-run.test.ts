import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), append: vi.fn(), mark: vi.fn() }));
vi.mock("./finance-order-day-guard.js", () => ({
  assertNotPlacedToday: mocks.guard,
  markPlaced: mocks.mark,
}));
vi.mock("./finance-position-ledger.js", () => ({ appendFinanceExecutionReceipt: mocks.append }));
import { runFinancePaperOrder } from "./finance-paper-run.js";

describe("internal paper controller boundary", () => {
  it("refuses model-declared labels and attended budget without touching state", async () => {
    const result = await runFinancePaperOrder({
      conclusion: {
        conclusionId: "synthetic",
        instrument: "AAPL",
        direction: "buy",
        conviction: 1,
        thesis: "fixture",
        assetClass: "us_equity",
        invalidationPrice: 90,
      },
      market: { referencePrice: 100, referencePriceAt: new Date().toISOString() },
      equity: 100_000,
      runAuthorizationId: "model-invented",
      budget: { automation: "attended", allowedInstruments: ["AAPL"] },
      instruments: ["AAPL"],
    });
    expect(result).toMatchObject({ ok: false, stage: "place" });
    expect(JSON.stringify(result)).toContain("execution_safety_context_required");
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
  });
});
