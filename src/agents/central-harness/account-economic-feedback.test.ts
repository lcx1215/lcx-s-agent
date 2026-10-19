import { expect, it } from "vitest";
import { boundPerception, runCentralHarnessCycle } from "./harness-loop.js";
import { buildCentralBrainPrompt } from "./model-brain.js";
it.each([1, 2, 3])(
  "preserves account attribution and honest omissions for %s accounts through budget projection",
  async (accountCount) => {
    const asOf = "2026-10-15T07:00:00.000Z";
    const economics = {
      reconciliationRef: "d".repeat(64),
      reconciliationAt: "2026-10-15T07:00:00.000Z",
      reconciliationStatus: "unresolved" as const,
      latestCashDifference: 0.2402438201897894,
      latestFeeCash: -4.29,
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
      inheritedExitDecisionGrossPnl: 40,
      newDecisionGrossPnl: 0,
      unlinkedGrossPnl: 0,
      unallocatedPnl: 0,
      historicalCashFees: 4.05,
      historicalAssetFeeValue: 0.08052845,
      periodConfirmedCashFees: 0,
      periodFeeTimingUnknownCount: 3,
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
            omittedAccounts: 4,
            accounts: Array.from({ length: accountCount }, (_, index) => ({
              accountId: index === 0 ? "paper" : `paper-${index + 1}`,
              netMatchedPnl: null,
              accountEconomics:
                accountCount === 1
                  ? economics
                  : {
                      ...economics,
                      accountId: undefined,
                      venue: undefined,
                      asOf: undefined,
                      openingRef: undefined,
                      closingRef: undefined,
                    },
              largeOldDetails: "omitted historical detail ".repeat(3000),
            })),
          },
        },
      },
    });
    expect(bounded.report.overBudget).toBe(false);
    const check = (prompt: string) => {
      expect(prompt).toContain('"inheritedGrossPnl":61.25');
      expect(prompt).toContain('"inheritedExitDecisionGrossPnl":40');
      expect(prompt).toContain("nonadditive subset");
      expect(prompt).toContain('"newDecisionGrossPnl":0');
      expect(prompt).toContain('"historicalCashFees":4.05');
      expect(prompt).toContain('"historicalAssetFeeValue":0.08052845');
      expect(prompt).toContain('"periodFeeTimingUnknownCount":3');
      expect(prompt).toContain('"pendingFees":"unknown"');
      expect(prompt).toContain('"modelBill":null');
      expect(prompt).toContain('"latestFeeCash":-4.29');
      expect(prompt).toContain('"reconciliationStatus":"unresolved"');
      expect(prompt).toContain('"latestCashDifference":0.2402438201897894');
      expect(prompt).toContain("d".repeat(64));
      if (accountCount === 1) {
        expect(prompt).toContain("c".repeat(64));
      }
      expect(prompt).toContain("inherited gains to new code");
      expect(prompt).not.toContain("omitted historical detail");
      if (accountCount > 1) {
        expect(prompt).toContain('"accountId":"paper-2"');
      }
      expect(prompt).toContain(`"omittedAccounts":${4 + Math.max(0, accountCount - 2)}`);
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
  },
);
