import { expect, it } from "vitest";
import { boundPerception, runCentralHarnessCycle } from "./harness-loop.js";
import { buildCentralBrainPrompt } from "./model-brain.js";
it("preserves current account attribution and fee gaps through original budget projection and brain input", async () => {
  const asOf = "2026-10-15T07:00:00.000Z";
  const economics = {
    accountId: "paper",
    venue: "alpaca:paper",
    asOf,
    status: "observed",
    sourceRef: "a".repeat(64),
    openingRef: "b".repeat(64),
    closingRef: "c".repeat(64),
    from: "2026-10-15T05:18:54.810Z",
    through: asOf,
    accountEquityChange: 61.25,
    inheritedGrossPnl: 61.25,
    newDecisionGrossPnl: 0,
    unlinkedGrossPnl: 0,
    unallocatedPnl: 0,
    historicalCashFees: 4.05,
    historicalAssetFeeValue: 0.08052845,
    periodConfirmedCashFees: 0,
    pendingFees: "unknown",
    modelBill: null,
  };
  const bounded = boundPerception({
    observedAt: asOf,
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: {
      financeAutomaticLifecycle: {
        status: "present",
        observedAt: asOf,
        scheduler: {
          runtime: { phase: "idle", reconciliation: { status: "ready", observedAt: asOf } },
        },
        economicFeedback: {
          status: "present",
          accounts: [
            {
              accountId: "paper",
              netMatchedPnl: null,
              accountEconomics: economics,
              largeOldDetails: "omitted historical detail ".repeat(3000),
            },
          ],
        },
      },
    },
  });
  expect(bounded.report.overBudget).toBe(false);
  const check = (prompt: string) => {
    expect(prompt).toContain('"inheritedGrossPnl":61.25');
    expect(prompt).toContain('"newDecisionGrossPnl":0');
    expect(prompt).toContain('"historicalCashFees":4.05');
    expect(prompt).toContain('"historicalAssetFeeValue":0.08052845');
    expect(prompt).toContain('"pendingFees":"unknown"');
    expect(prompt).toContain('"modelBill":null');
    expect(prompt).toContain("c".repeat(64));
    expect(prompt).toContain("inherited gains to new code");
    expect(prompt).not.toContain("omitted historical detail");
  };
  check(buildCentralBrainPrompt(bounded.perception));
  let observed = false;
  await runCentralHarnessCycle({
    perception: bounded.perception,
    registry: new Map(),
    planOnly: true,
    brain: {
      propose: async (p) => {
        observed = true;
        check(buildCentralBrainPrompt(p));
        return {
          kind: "proposed",
          provider: "offline-scripted",
          modelId: "fixture",
          plan: { note: "retain pending natural judgment", actions: [] },
        };
      },
    },
  });
  expect(observed).toBe(true);
});
